export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const SIGNALSCOPE_URL = process.env.SIGNALSCOPE_API_URL;
const SIDEKICK_KEY = process.env.SIDEKICK_API_KEY;
const BASE_ID = process.env.VELOKA_BASE_ID;

export async function GET(request) {
  if (!SIGNALSCOPE_URL || !SIDEKICK_KEY || !BASE_ID) {
    return Response.json({ ok: false, error: "Server env vars not set" }, { status: 500 });
  }
  try {
    // Pass through an optional taskType scope so the badge can count only the
    // task types the queue actually renders (whitelisted server-side).
    const taskType = new URL(request.url).searchParams.get("taskType") || "";
    const typeQS = taskType ? `&taskType=${encodeURIComponent(taskType)}` : "";
    const upstream = `${SIGNALSCOPE_URL.replace(/\/$/, "")}/api/sidekick/count?baseId=${encodeURIComponent(BASE_ID)}${typeQS}`;
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
