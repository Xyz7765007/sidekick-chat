// PROXY: /api/auto-batch/generate → SignalScope
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 300;

const SIGNALSCOPE_URL = process.env.SIGNALSCOPE_API_URL;
const SIDEKICK_KEY = process.env.SIDEKICK_API_KEY;
const BASE_ID = process.env.VELOKA_BASE_ID;
const ACCOUNT_ID = process.env.VELOKA_ACCOUNT_ID || ""; // optional

export async function POST(request) {
  if (!SIGNALSCOPE_URL || !SIDEKICK_KEY || !BASE_ID) {
    return Response.json({ ok: false, error: "Env vars missing" }, { status: 500 });
  }
  let body = {};
  try { body = await request.json(); } catch {}
  const { size = 5, force = false, campaignContext = "Veloka — B2B outbound infrastructure" } = body;

  try {
    const upstream = `${SIGNALSCOPE_URL.replace(/\/$/, "")}/api/sidekick/auto-batch/generate`;
    const r = await fetch(upstream, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SIDEKICK_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        baseId: BASE_ID,
        size,
        force,
        accountId: ACCOUNT_ID,
        campaignContext,
      }),
      cache: "no-store",
    });
    const data = await r.json();
    return Response.json(data, { status: r.status });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 502 });
  }
}
