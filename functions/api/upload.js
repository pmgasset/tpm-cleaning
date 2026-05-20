/**
 * POST /api/upload
 * Accepts multipart/form-data with:
 *   res_id      — reservation ID string
 *   res_label   — human-readable reservation label
 *   area        — area of property
 *   severity    — minor | moderate | major
 *   note        — text description
 *   photos[]    — one or more image files (max 8, 10 MB each)
 *
 * Stores photos in R2 under reservations/{res_id}/{timestamp}-{n}.{ext}
 * Writes a report row to D1.
 */

const MAX_PHOTOS = 8;
const MAX_BYTES  = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic"]);

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors("*") });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get("Origin") || "*";

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return json({ error: "Invalid form data" }, 400, origin);
  }

  const res_id    = (formData.get("res_id")    || "").trim();
  const res_label = (formData.get("res_label") || "").trim();
  const area      = (formData.get("area")      || "other").trim();
  const severity  = (formData.get("severity")  || "minor").trim();
  const note      = (formData.get("note")      || "").trim();

  if (!res_id) return json({ error: "res_id is required" }, 400, origin);
  if (!["minor", "moderate", "major"].includes(severity))
    return json({ error: "Invalid severity" }, 400, origin);

  const files = formData.getAll("photos[]");
  if (files.length > MAX_PHOTOS)
    return json({ error: `Maximum ${MAX_PHOTOS} photos allowed` }, 400, origin);

  const photoKeys = [];
  const ts = Date.now();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!(file instanceof File)) continue;

    if (!ALLOWED_TYPES.has(file.type))
      return json({ error: `Unsupported file type: ${file.type}` }, 400, origin);

    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > MAX_BYTES)
      return json({ error: `Photo ${i + 1} exceeds 10 MB limit` }, 400, origin);

    const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
    const key = `reservations/${res_id}/${ts}-${i + 1}.${ext}`;

    await env.PHOTOS.put(key, bytes, {
      httpMetadata: { contentType: file.type },
      customMetadata: { res_id, uploaded_at: new Date().toISOString() },
    });

    photoKeys.push(key);
  }

  // Insert report into D1
  const stmt = env.DB.prepare(
    `INSERT INTO reports (res_id, res_label, area, severity, note, photo_keys)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const result = await stmt.bind(
    res_id,
    res_label,
    area,
    severity,
    note,
    JSON.stringify(photoKeys)
  ).run();

  return json({
    ok: true,
    report_id: result.meta.last_row_id,
    photo_count: photoKeys.length,
  }, 201, origin);
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}
