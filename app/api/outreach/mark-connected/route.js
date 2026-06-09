// PROXY: /api/outreach/mark-connected → SignalScope /api/outreach
// action: mark_connected. Marks a connection request as accepted on LinkedIn
// and schedules DM1 (Next Action Date = now+2d) server-side.
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
      body: JSON.stringify({ ...body, action: "mark_connected", baseId: BASE_ID }),
      cache: "no-store",
    });
    const data = await r.json();
    return Response.json(data, { status: r.status });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 502 });
  }
}
