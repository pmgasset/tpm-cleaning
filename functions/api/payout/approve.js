/**
 * POST /api/payout/approve
 * Owner approves or rejects a pending payout.
 * On approval, executes a PayPal Payout to the cleaner's PayPal email.
 *
 * PROTECTED: Cloudflare Access should restrict this route to owner email only.
 * The CF-Access-Authenticated-User-Email header is set automatically by Access.
 *
 * Body (JSON):
 *   payout_id  — ID from the payouts table
 *   action     — "approve" | "reject"
 *
 * Env secrets required:
 *   PAYPAL_CLIENT_ID      — from PayPal Developer dashboard
 *   PAYPAL_CLIENT_SECRET  — from PayPal Developer dashboard
 *   PAYPAL_MODE           — "sandbox" | "live"
 *   CLEANER_PAYPAL_EMAIL  — your cleaner's PayPal email address
 *   OWNER_EMAIL           — your email (used to gate this endpoint)
 *   CLEANER_NAME          — cleaner's display name (e.g. "Maria")
 */

const PAYPAL_BASE = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live:    'https://api-m.paypal.com',
};

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors('*') });
}

// GET — owner dashboard fetches pending payouts list
export async function onRequestGet({ request, env }) {
  const origin = request.headers.get('Origin') || '*';

  // Verify owner via Cloudflare Access header
  const callerEmail = request.headers.get('Cf-Access-Authenticated-User-Email') || '';
  if (env.OWNER_EMAIL && callerEmail.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) {
    return json({ error: 'Forbidden' }, 403, origin);
  }

  const url    = new URL(request.url);
  const status = url.searchParams.get('status') || 'pending';

  const { results } = await env.DB.prepare(
    `SELECT p.*, r.note as report_note, r.area, r.photo_keys, r.severity
       FROM payouts p
       LEFT JOIN reports r ON r.id = p.report_id
      WHERE p.status = ?
      ORDER BY p.submitted_at DESC
      LIMIT 50`
  ).bind(status).all();

  // Generate presigned photo URLs so the owner page can display images
  const payouts = await Promise.all(
    (results || []).map(async (payout) => {
      let photo_urls = [];
      if (payout.photo_keys) {
        let keys = [];
        try { keys = JSON.parse(payout.photo_keys); } catch {}
        photo_urls = await Promise.all(
          keys.map(async (key) => {
            try {
              const url = await env.PHOTOS.createPresignedUrl(key, { expiresIn: 3600 });
              return { key, url };
            } catch {
              return { key, url: null };
            }
          })
        );
      }
      return { ...payout, photo_urls };
    })
  );

  return json({ payouts }, 200, origin);
}

// POST — approve or reject
export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin') || '*';

  // Verify owner via Cloudflare Access header
  const callerEmail = request.headers.get('Cf-Access-Authenticated-User-Email') || '';
  if (env.OWNER_EMAIL && callerEmail.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) {
    return json({ error: 'Forbidden — owner access only' }, 403, origin);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, origin); }

  const { payout_id, action } = body;
  if (!payout_id || !['approve', 'reject'].includes(action)) {
    return json({ error: 'payout_id and action (approve|reject) required' }, 400, origin);
  }

  // Fetch the payout record
  const { results } = await env.DB.prepare(
    'SELECT * FROM payouts WHERE id = ? AND status = ?'
  ).bind(payout_id, 'pending').all();

  if (!results?.length) {
    return json({ error: 'Payout not found or already processed' }, 404, origin);
  }

  const payout = results[0];

  if (action === 'reject') {
    await env.DB.prepare(
      "UPDATE payouts SET status = 'rejected', reviewed_at = datetime('now') WHERE id = ?"
    ).bind(payout_id).run();
    return json({ ok: true, status: 'rejected' }, 200, origin);
  }

  // ── APPROVE: execute PayPal Payout ────────────────────────────────────────
  try {
    const accessToken = await getPayPalToken(env);
    const batchId     = `jv-payout-${payout_id}-${Date.now()}`;
    const cleanerName = env.CLEANER_NAME || 'Cleaner';

    const paypalRes = await fetch(
      `${PAYPAL_BASE[env.PAYPAL_MODE || 'live']}/v1/payments/payouts`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'PayPal-Request-Id': batchId,
        },
        body: JSON.stringify({
          sender_batch_header: {
            sender_batch_id: batchId,
            recipient_type: 'EMAIL',
            email_subject: `Cleaning payment — ${payout.res_label || payout.res_id}`,
            email_message: `Hi ${cleanerName}, your cleaning payment of $${payout.amount_usd} for ${payout.res_label || payout.res_id} has been approved. Thanks!`,
          },
          items: [{
            recipient_type: 'EMAIL',
            receiver:       env.CLEANER_PAYPAL_EMAIL,
            amount: {
              value:    payout.amount_usd,
              currency: 'USD',
            },
            note:         payout.cleaner_note || `Cleaning — ${payout.res_label || payout.res_id}`,
            sender_item_id: `jv-${payout_id}`,
          }],
        }),
      }
    );

    const ppData = await paypalRes.json();

    if (!paypalRes.ok) {
      console.error('PayPal error:', JSON.stringify(ppData));
      return json({
        error:   'PayPal API error',
        detail:  ppData.message || ppData.error_description || 'Unknown PayPal error',
        paypal:  ppData,
      }, 502, origin);
    }

    const batchStatus  = ppData.batch_header?.payout_batch_id;
    const paypalStatus = ppData.batch_header?.batch_status;

    // Mark as paid in D1
    await env.DB.prepare(
      `UPDATE payouts
          SET status = 'paid',
              reviewed_at = datetime('now'),
              paid_at = datetime('now'),
              paypal_batch_id = ?,
              paypal_payout_id = ?
        WHERE id = ?`
    ).bind(batchStatus || '', paypalStatus || '', payout_id).run();

    return json({
      ok: true,
      status: 'paid',
      paypal_batch_id: batchStatus,
      amount_usd: payout.amount_usd,
    }, 200, origin);

  } catch (err) {
    return json({ error: 'Payment execution failed', detail: err.message }, 500, origin);
  }
}

// ── PayPal OAuth helper ────────────────────────────────────────────────────
async function getPayPalToken(env) {
  const base = PAYPAL_BASE[env.PAYPAL_MODE || 'live'];
  const creds = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`);

  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`PayPal token error: ${err}`);
  }

  const data = await res.json();
  return data.access_token;
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}
