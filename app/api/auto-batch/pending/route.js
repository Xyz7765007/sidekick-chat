// PROXY: /api/auto-batch/pending → SignalScope
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const SIGNALSCOPE_URL = process.env.SIGNALSCOPE_API_URL;
const SIDEKICK_KEY = process.env.SIDEKICK_API_KEY;
const BASE_ID = process.env.VELOKA_BASE_ID;

export async function GET() {
  if (!SIGNALSCOPE_URL || !SIDEKICK_KEY || !BASE_ID) {
    return Response.json({ ok: false, error: "Env vars missing" }, { status: 500 });
  }
  try {
    const upstream = `${SIGNALSCOPE_URL.replace(/\/$/, "")}/api/sidekick/auto-batch/pending?baseId=${encodeURIComponent(BASE_ID)}`;
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
