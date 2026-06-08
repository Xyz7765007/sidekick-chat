// PROXY: /api/preferences → SignalScope /api/sidekick/preferences
// Serves the most recent operator-feedback notes for an item_type so the
// generators can apply learned preferences. baseId + Bearer added server-side.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const SIGNALSCOPE_URL = process.env.SIGNALSCOPE_API_URL;
const SIDEKICK_KEY = process.env.SIDEKICK_API_KEY;
const BASE_ID = process.env.VELOKA_BASE_ID;

export async function GET(request) {
  if (!SIGNALSCOPE_URL || !SIDEKICK_KEY || !BASE_ID) {
    return Response.json({ ok: false, error: "Server env vars not set" }, { status: 500 });
  }
  const url = new URL(request.url);
  const itemType = url.searchParams.get("item_type") || "";
  const limit = url.searchParams.get("limit") || "15";
  try {
    const upstream =
      `${SIGNALSCOPE_URL.replace(/\/$/, "")}/api/sidekick/preferences` +
      `?baseId=${encodeURIComponent(BASE_ID)}` +
      `&item_type=${encodeURIComponent(itemType)}` +
      `&limit=${encodeURIComponent(limit)}`;
    const r = await fetch(upstream, {
      headers: { Authorization: `Bearer ${SIDEKICK_KEY}` },
      cache: "no-store",
    });
    const data = await r.json();
    return Response.json(data, { status: r.status });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 502 });
  }
}
