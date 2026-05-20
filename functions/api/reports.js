/**
 * GET /api/reports
 * Returns all reports with temporary signed photo URLs.
 * Intended for the owner dashboard — protect this route with Cloudflare Access
 * using a separate policy from the cleaner route.
 *
 * Query params:
 *   res_id    — filter by reservation ID (optional)
 *   reviewed  — "0" or "1" to filter by review status (optional)
 *   limit     — max results, default 50
 *   offset    — pagination offset, default 0
 *
 * PATCH /api/reports?id=N&reviewed=1
 * Marks a report as reviewed.
 */

const PHOTO_EXPIRY_SECONDS = 3600; // signed URLs valid for 1 hour

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors("*") });
}

export async function onRequestGet({ request, env }) {
  const origin = request.headers.get("Origin") || "*";
  const url    = new URL(request.url);

  const res_id   = url.searchParams.get("res_id");
  const reviewed = url.searchParams.get("reviewed");
  const limit    = parseInt(url.searchParams.get("limit")  || "50", 10);
  const offset   = parseInt(url.searchParams.get("offset") || "0",  10);

  let sql    = "SELECT * FROM reports WHERE 1=1";
  const args = [];

  if (res_id)   { sql += " AND res_id = ?";   args.push(res_id); }
  if (reviewed !== null && reviewed !== undefined && reviewed !== "") {
    sql += " AND reviewed = ?";
    args.push(reviewed === "1" ? "1" : "0");
  }

  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  args.push(String(limit), String(offset));

  const { results } = await env.DB.prepare(sql).bind(...args).all();

  // Attach signed photo URLs
  const reports = await Promise.all(
    results.map(async (row) => {
      let keys = [];
      try { keys = JSON.parse(row.photo_keys || "[]"); } catch {}

      const photoUrls = await Promise.all(
        keys.map(async (key) => {
          // R2 presigned URL via createPresignedUrl
          try {
            const url = await env.PHOTOS.createPresignedUrl(key, {
              expiresIn: PHOTO_EXPIRY_SECONDS,
            });
            return { key, url };
          } catch {
            // Fallback: return key only if presigning fails
            return { key, url: null };
          }
        })
      );

      return { ...row, photos: photoUrls };
    })
  );

  // Count total for pagination
  let countSql  = "SELECT COUNT(*) as total FROM reports WHERE 1=1";
  const countArgs = [];
  if (res_id)   { countSql += " AND res_id = ?";   countArgs.push(res_id); }
  if (reviewed !== null && reviewed !== undefined && reviewed !== "") {
    countSql += " AND reviewed = ?";
    countArgs.push(reviewed === "1" ? "1" : "0");
  }
  const { results: countRows } = await env.DB.prepare(countSql).bind(...countArgs).all();
  const total = countRows[0]?.total || 0;

  return new Response(JSON.stringify({ reports, total, limit, offset }), {
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

export async function onRequestPatch({ request, env }) {
  const origin = request.headers.get("Origin") || "*";
  const url    = new URL(request.url);
  const id     = url.searchParams.get("id");
  const rev    = url.searchParams.get("reviewed");

  if (!id) return json({ error: "id param required" }, 400, origin);

  await env.DB.prepare("UPDATE reports SET reviewed = ? WHERE id = ?")
    .bind(rev === "1" ? 1 : 0, id)
    .run();

  return json({ ok: true }, 200, origin);
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}
