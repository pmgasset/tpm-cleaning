/**
 * GET /api/reservations
 * Proxies to WordPress REST API and returns upcoming reservations.
 * Expects env.WP_API_URL and env.WP_API_KEY to be set as secrets.
 */
export async function onRequestGet({ env, request }) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  try {
    const wpUrl = `${env.WP_API_URL}/reservations`;
    const wpRes = await fetch(wpUrl, {
      headers: {
        "X-Cleaner-API-Key": env.WP_API_KEY,
        "Accept": "application/json",
      },
    });

    if (!wpRes.ok) {
      return new Response(
        JSON.stringify({ error: "Failed to fetch reservations from WordPress", status: wpRes.status }),
        { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const data = await wpRes.json();

    // Normalise: expect WP to return array of reservation objects.
    // Shape we return: { id, label, checkout_date, checkin_date, guests, pets, notes, window_hours }
    const reservations = Array.isArray(data) ? data : (data.reservations || []);

    return new Response(JSON.stringify({ reservations }), {
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Internal error", detail: err.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
