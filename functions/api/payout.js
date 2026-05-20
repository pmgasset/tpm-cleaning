/**
 * POST /api/payout  — cleaner submits cleaning completion + invoice amount
 * GET  /api/payout  — cleaner fetches their payout history
 *
 * On POST: saves a pending payout to D1, then texts the owner via voip.ms
 * with a 240jv.link short URL to the approval page.
 *
 * Env secrets required:
 *   VOIPMS_USER          voip.ms account email  (same as gms_voipms_user in WP)
 *   VOIPMS_PASS          voip.ms API password   (same as gms_voipms_pass in WP)
 *   VOIPMS_DID           sending DID, digits only  e.g. 7802223333
 *   OWNER_PHONE          your mobile, digits only  e.g. 7801234567
 *   SHORTLINK_TOKEN      Bearer token for 240jv.link  (same as gms_shortener_api_token in WP)
 *   CLEANER_NAME         e.g. Maria
 *   PORTAL_URL           https://cleaning.240jordanview.com
 *   PAYPAL_* / OWNER_EMAIL  (used by /api/payout/approve — not needed here)
 */

const VOIPMS_API   = 'https://voip.ms/api/v1/rest.php';
const SHORTLINK_API = 'https://240jv.link/shorten';
const MAX_SMS       = 160;

function cors(o) {
  return {
    'Access-Control-Allow-Origin':  o || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors('*') });
}

// ── GET: cleaner's payout history ────────────────────────────────────────────
export async function onRequestGet({ request, env }) {
  const origin = request.headers.get('Origin') || '*';
  const url    = new URL(request.url);
  const limit  = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);

  const { results } = await env.DB.prepare(
    'SELECT * FROM payouts ORDER BY submitted_at DESC LIMIT ?'
  ).bind(limit).all();

  return new Response(JSON.stringify({ payouts: results || [] }), {
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

// ── POST: submit payout request ──────────────────────────────────────────────
export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin') || '*';

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400, origin); }

  const { res_id, res_label, amount_usd, note, report_id } = body;

  if (!res_id)     return json({ error: 'res_id is required' }, 400, origin);
  if (!amount_usd) return json({ error: 'amount_usd is required' }, 400, origin);

  const amount = parseFloat(amount_usd);
  if (isNaN(amount) || amount <= 0 || amount > 5000)
    return json({ error: 'Invalid amount ($0.01 – $5,000.00)' }, 400, origin);

  // Save to D1
  const result = await env.DB.prepare(
    `INSERT INTO payouts (res_id, res_label, amount_usd, cleaner_note, report_id)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(
    res_id,
    res_label || '',
    amount.toFixed(2),
    note || '',
    report_id ? parseInt(report_id) : null
  ).run();

  const payout_id = result.meta.last_row_id;

  // Build approve URL, shorten it, then SMS the owner — all fire-and-forget
  void notifyOwner(env, payout_id, res_label || res_id, amount, note || '');

  return json({ ok: true, payout_id, status: 'pending' }, 201, origin);
}

// ── Notification pipeline ────────────────────────────────────────────────────
async function notifyOwner(env, payoutId, resLabel, amount, note) {
  const portalUrl  = (env.PORTAL_URL || 'https://cleaning.240jordanview.com').replace(/\/$/, '');
  const approveUrl = `${portalUrl}/owner?payout=${payoutId}`;

  // Shorten the approve URL via 240jv.link
  const shortUrl = await shortenUrl(approveUrl, env.SHORTLINK_TOKEN);

  await sendOwnerSms(env, payoutId, resLabel, amount, note, shortUrl);
}

// ── 240jv.link shortener ─────────────────────────────────────────────────────
async function shortenUrl(url, token) {
  if (!token) {
    console.warn('SHORTLINK_TOKEN not set — using full URL in SMS');
    return url;
  }

  try {
    const res = await fetch(SHORTLINK_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ url }),
    });

    if (!res.ok) {
      console.error(`Shortlink API returned ${res.status}`);
      return url;
    }

    const data = await res.json();

    if (typeof data?.short_url === 'string' && data.short_url !== '') {
      console.log(`Shortened ${url} → ${data.short_url}`);
      return data.short_url;
    }

    console.error('Shortlink response missing short_url:', JSON.stringify(data));
    return url;
  } catch (err) {
    console.error('Shortlink fetch error:', err.message);
    return url;  // fall back to full URL so SMS still sends
  }
}

// ── voip.ms SMS ──────────────────────────────────────────────────────────────
async function sendOwnerSms(env, payoutId, resLabel, amount, note, approveUrl) {
  if (!env.VOIPMS_USER || !env.VOIPMS_PASS || !env.VOIPMS_DID || !env.OWNER_PHONE) {
    console.warn('voip.ms not fully configured — skipping SMS');
    return;
  }

  const cleanerName = env.CLEANER_NAME || 'Your cleaner';
  const noteSnippet = note ? ` "${note.slice(0, 28)}${note.length > 28 ? '…' : ''}"` : '';

  // With a short URL (~26 chars), we have plenty of room.
  // e.g. "Maria requests $150.00 for May 24 → May 27. "cracked tile" Approve: https://240jv.link/ab3xk9f"
  // that's ~99 chars — well within 160.
  let msg = `${cleanerName} requests $${amount.toFixed(2)} for ${resLabel}${noteSnippet}. Approve: ${approveUrl}`;

  // Safety trim (should rarely fire given short URL)
  if (msg.length > MAX_SMS) {
    msg = `${cleanerName} requests $${amount.toFixed(2)} for ${resLabel}. Approve: ${approveUrl}`;
  }
  if (msg.length > MAX_SMS) {
    msg = msg.slice(0, MAX_SMS - 1) + '…';
  }

  const params = new URLSearchParams({
    api_username: env.VOIPMS_USER,
    api_password: env.VOIPMS_PASS,
    method:       'sendSMS',
    did:          env.VOIPMS_DID,
    dst:          env.OWNER_PHONE,
    message:      msg,
  });

  try {
    const res  = await fetch(`${VOIPMS_API}?${params.toString()}`);
    const data = await res.json();

    if (data?.status === 'success') {
      console.log(`SMS sent to owner for payout #${payoutId}: "${msg}"`);
    } else {
      console.error('voip.ms error:', JSON.stringify(data));
    }
  } catch (err) {
    console.error('voip.ms fetch error:', err.message);
  }
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}
