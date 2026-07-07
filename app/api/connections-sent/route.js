// ═══════════════════════════════════════════════════════════════════
// PROXY ROUTE: /api/connections-sent
// Browser hits this. Reads SIDEKICK_API_KEY + VELOKA_BASE_ID server-side,
// forwards to SignalScope's /api/sidekick/connections-sent with Bearer auth.
// The browser never sees the key or calls the backend directly.
//
// GET  → connection-requests-sent card data ({count, past24h, leads, ...}).
// POST → { action:"mark_done" | "exclude_lead", ... } (mutations).
// Mirrors the /api/action + /api/feed proxy shape exactly.
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const SIGNALSCOPE_URL = process.env.SIGNALSCOPE_API_URL;
const SIDEKICK_KEY = process.env.SIDEKICK_API_KEY;
const BASE_ID = process.env.VELOKA_BASE_ID;

export async function GET() {
  if (!SIGNALSCOPE_URL || !SIDEKICK_KEY || !BASE_ID) {
    return Response.json(
      { ok: false, error: "Server env vars not set (SIGNALSCOPE_API_URL, SIDEKICK_API_KEY, VELOKA_BASE_ID)" },
      { status: 500 }
    );
  }
  try {
    const upstream = `${SIGNALSCOPE_URL.replace(/\/$/, "")}/api/sidekick/connections-sent?baseId=${encodeURIComponent(BASE_ID)}`;
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

export async function POST(request) {
  if (!SIGNALSCOPE_URL || !SIDEKICK_KEY || !BASE_ID) {
    return Response.json({ ok: false, error: "Server env vars not set" }, { status: 500 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const upstream = `${SIGNALSCOPE_URL.replace(/\/$/, "")}/api/sidekick/connections-sent`;
    const r = await fetch(upstream, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SIDEKICK_KEY}`,
        "Content-Type": "application/json",
      },
      // Attach baseId server-side (browser never provides it). Backend defaults
      // the master campaignId; the browser only sends { action, leadName?,
      // linkedin?, at? }.
      body: JSON.stringify({ ...body, baseId: BASE_ID }),
      cache: "no-store",
    });
    const data = await r.json();
    return Response.json(data, { status: r.status });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 502 });
  }
}
