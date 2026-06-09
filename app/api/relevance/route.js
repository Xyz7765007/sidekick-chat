// PROXY: /api/relevance → SignalScope /api/sidekick/relevance
// Universal relevance feedback rules (hard-suppress, retroactive, reversible).
// GET  → list active rules (forwards `limit`).
// POST → create a rule { kind, value, targetScore?, note? } OR deactivate one
//        { ruleId, active:false } (reversibility). baseId + Bearer injected
//        server-side. Mirrors the /api/feedback + /api/preferences pattern.
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
  const limit = url.searchParams.get("limit") || "50";
  try {
    const upstream =
      `${SIGNALSCOPE_URL.replace(/\/$/, "")}/api/sidekick/relevance` +
      `?baseId=${encodeURIComponent(BASE_ID)}` +
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

export async function POST(request) {
  if (!SIGNALSCOPE_URL || !SIDEKICK_KEY || !BASE_ID) {
    return Response.json({ ok: false, error: "Server env vars not set" }, { status: 500 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const upstream = `${SIGNALSCOPE_URL.replace(/\/$/, "")}/api/sidekick/relevance`;
    const r = await fetch(upstream, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SIDEKICK_KEY}`,
      },
      cache: "no-store",
      body: JSON.stringify({ ...body, baseId: BASE_ID }),
    });
    const data = await r.json();
    return Response.json(data, { status: r.status });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 502 });
  }
}
