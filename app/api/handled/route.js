// ═══════════════════════════════════════════════════════════════════
// PROXY ROUTE: /api/handled
// Recently handled (done/skip) tasks for the Handled panel — operator
// can reopen any of them via POST /api/action {action:"reopen"}.
// Browser hits this. Reads SIDEKICK_API_KEY server-side, forwards to
// SignalScope with Bearer auth. The browser never sees the key.
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const SIGNALSCOPE_URL = process.env.SIGNALSCOPE_API_URL;
const SIDEKICK_KEY = process.env.SIDEKICK_API_KEY;
const BASE_ID = process.env.VELOKA_BASE_ID;

export async function GET(request) {
  if (!SIGNALSCOPE_URL || !SIDEKICK_KEY || !BASE_ID) {
    return Response.json(
      { ok: false, error: "Server env vars not set (SIGNALSCOPE_API_URL, SIDEKICK_API_KEY, VELOKA_BASE_ID)" },
      { status: 500 }
    );
  }
  const url = new URL(request.url);
  const limit = url.searchParams.get("limit") || "20";

  try {
    const upstream = `${SIGNALSCOPE_URL.replace(/\/$/, "")}/api/sidekick/handled?baseId=${encodeURIComponent(BASE_ID)}&limit=${encodeURIComponent(limit)}`;
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
