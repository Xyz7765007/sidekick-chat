// PROXY: /api/outreach/record-dm-sent → SignalScope /api/outreach
// action: record_manual_dm_sent (MANUAL-WITH-ASSIST — no Unipile send).
// Records that the exec sent DM {step} by hand on LinkedIn + schedules next step.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const SIGNALSCOPE_URL = process.env.SIGNALSCOPE_API_URL;
const SIDEKICK_KEY = process.env.SIDEKICK_API_KEY;
const BASE_ID = process.env.VELOKA_BASE_ID;

export async function POST(request) {
  if (!SIGNALSCOPE_URL || !SIDEKICK_KEY || !BASE_ID) {
    return Response.json({ ok: false, error: "Env vars missing" }, { status: 500 });
  }
  let body = {};
  try { body = await request.json(); } catch {}

  try {
    const upstream = `${SIGNALSCOPE_URL.replace(/\/$/, "")}/api/outreach`;
    const r = await fetch(upstream, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SIDEKICK_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...body, action: "record_manual_dm_sent", baseId: BASE_ID }),
      cache: "no-store",
    });
    const data = await r.json();
    return Response.json(data, { status: r.status });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 502 });
  }
}
