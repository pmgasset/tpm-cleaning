/**
 * GET /api/payout
 * Returns the cleaner's own payout history (no owner-gating needed here —
 * Cloudflare Access already gates the whole domain to the cleaner's email).
 */

function cors(o){return{'Access-Control-Allow-Origin':o||'*','Access-Control-Allow-Methods':'GET, OPTIONS','Access-Control-Allow-Headers':'Content-Type'}}
export async function onRequestOptions(){return new Response(null,{headers:cors('*')})}

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
