// ═══════════════════════════════════════════════════════════════════
// POST /api/whatsapp/push — kick a batch of 3 comment tasks TO a number
//
// The inbound webhook is pull ("tasks" → here's your batch). This is the push
// side: you (or a cron) fire it and Side Kick opens the conversation.
//
// Auth: Authorization: Bearer <WHATSAPP_PUSH_SECRET>  (or ?key=<secret>)
// Body: { to?: "919999999999" }   — defaults to the first WHATSAPP_ALLOWED_NUMBERS entry
//
// THE 24-HOUR RULE (WhatsApp platform, not ours): a business can only send
// free-form messages within 24h of the user's last message. Outside it, Meta
// requires a pre-approved template. So during this test, push works only if
// Kunal has messaged the number in the last 24h. We return 409
// outside_24h_window (not a generic 500) so that's unambiguous when it happens.
// A "you have N tasks" utility template is the fix for a real daily cron.
// ═══════════════════════════════════════════════════════════════════

import { allowedNumbers, isAllowed, waConfigured, normalizeNumber } from "../../../../lib/whatsapp.js";
import { startBatch } from "../../../../lib/wa-flow.js";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

const PUSH_SECRET = process.env.WHATSAPP_PUSH_SECRET;

function authOk(request) {
  if (!PUSH_SECRET) return false; // fail closed
  const h = request.headers.get("authorization") || "";
  if (h === `Bearer ${PUSH_SECRET}`) return true;
  return new URL(request.url).searchParams.get("key") === PUSH_SECRET;
}

export async function POST(request) {
  if (!authOk(request)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!waConfigured()) {
    return Response.json({ ok: false, error: "WhatsApp env not set" }, { status: 500 });
  }

  const body = await request.json().catch(() => ({}));
  const to = normalizeNumber(body?.to || allowedNumbers()[0] || "");
  if (!to) {
    return Response.json({ ok: false, error: "No recipient (set WHATSAPP_ALLOWED_NUMBERS or pass `to`)" }, { status: 400 });
  }
  // The allowlist is the same gate as inbound — a push can't reach a number the
  // webhook wouldn't talk to.
  if (!isAllowed(to)) {
    return Response.json({ ok: false, error: `${to} is not in WHATSAPP_ALLOWED_NUMBERS` }, { status: 403 });
  }

  try {
    const state = await startBatch(new URL(request.url).origin, to, {});
    return Response.json({ ok: true, to, sent: state?.batch?.length || 0 });
  } catch (e) {
    if (e.code === "outside_24h_window") {
      return Response.json({
        ok: false,
        error: "outside_24h_window",
        detail: `${to} hasn't messaged the number in 24h. WhatsApp only allows approved templates outside that window — have them send any message first.`,
      }, { status: 409 });
    }
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
