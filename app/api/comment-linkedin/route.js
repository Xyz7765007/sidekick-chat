// ═══════════════════════════════════════════════════════════════════
// PROXY: /api/comment-linkedin → SignalScope /api/sidekick/comment
// Posts a LinkedIn comment via Unipile (Kunal Jul-20 auto-comment).
// Reads SIDEKICK_API_KEY server-side; the browser never sees it. baseId is
// injected server-side too, so the client only sends { postUrl, text, dryRun? }.
// This is a REAL side effect on the LIVE call — the frontend gates it behind
// an explicit confirm; dryRun validates the whole chain without posting.
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

const SIGNALSCOPE_URL = process.env.SIGNALSCOPE_API_URL;
const SIDEKICK_KEY = process.env.SIDEKICK_API_KEY;
const BASE_ID = process.env.VELOKA_BASE_ID;

export async function POST(request) {
  if (!SIGNALSCOPE_URL || !SIDEKICK_KEY || !BASE_ID) {
    return Response.json({ ok: false, error: "Server env vars not set" }, { status: 500 });
  }
  let body;
  try { body = await request.json(); }
  catch { return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }

  try {
    const r = await fetch(`${SIGNALSCOPE_URL.replace(/\/$/, "")}/api/sidekick/comment`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SIDEKICK_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        baseId: BASE_ID,
        postUrl: body.postUrl || "",
        text: body.text || "",
        dryRun: !!body.dryRun,
      }),
      cache: "no-store",
    });
    const data = await r.json();
    return Response.json(data, { status: r.status });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 502 });
  }
}
