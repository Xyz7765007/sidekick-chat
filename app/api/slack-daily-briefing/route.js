// ═══════════════════════════════════════════════════════════════════
// SLACK DAILY BRIEFING — Veloka (static reminder)
//
// GET  /api/slack-daily-briefing      ← GitHub Actions cron uses GET
// POST /api/slack-daily-briefing      ← manual trigger from UI / curl
//
// Auth: ?key=<BRIEFING_CRON_SECRET>  OR  Authorization: Bearer <secret>
//
// Posts a static reminder to Slack with a single CTA button that opens
// the chatbot. No Airtable fetching, no SignalScope hops, no risk of
// the briefing showing items that aren't on the chatbot.
//
// Why static: the chatbot is the source of truth for what's pending.
// If we fetched independently for Slack we'd risk drift between the
// two surfaces (briefing lists Olivier but chatbot doesn't, or vice
// versa). Reminder approach sidesteps that entirely — Slack tells you
// to look, chatbot tells you what's there.
//
// Env vars:
//   SLACK_BRIEFING_WEBHOOK_URL  — incoming webhook for #veloka-daily-test
//   BRIEFING_CRON_SECRET        — auth shared with GitHub Actions
//   CHATBOT_URL                 — full URL of the chatbot for the CTA
//                                  (defaults to https://sidekick-chat-beige.vercel.app/)
//
// Failure mode: if posting fails, returns the error in the response
// so GitHub Actions logs surface it. We don't try to "report failure
// to Slack via Slack" because if Slack is the failure point that's
// recursive.
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const SLACK_WEBHOOK = process.env.SLACK_BRIEFING_WEBHOOK_URL;
const CRON_SECRET = process.env.BRIEFING_CRON_SECRET;
const CHATBOT_URL = process.env.CHATBOT_URL || "https://sidekick-chat-beige.vercel.app/";

function authOk(request) {
  if (!CRON_SECRET) return false;
  const url = new URL(request.url);
  const queryKey = url.searchParams.get("key");
  if (queryKey === CRON_SECRET) return true;
  const auth = request.headers.get("authorization") || "";
  return auth === `Bearer ${CRON_SECRET}`;
}

function buildBriefing() {
  // Date formatted in IST (the operator's timezone). Looks like
  // "Monday, May 26" — same conventions as the original briefing draft.
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Kolkata",
  });

  return {
    text: `Veloka daily reminder — ${today}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `🌅 Veloka daily reminder`, emoji: true },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${today}*\n\nYour Side Kick chat has pending callables, drafts, and signals to action today.`,
        },
      },
      { type: "divider" },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open Side Kick chat →", emoji: true },
            url: CHATBOT_URL,
            style: "primary",
          },
        ],
      },
    ],
  };
}

async function runBriefing(request) {
  if (!authOk(request)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!SLACK_WEBHOOK) {
    return Response.json(
      { ok: false, error: "SLACK_BRIEFING_WEBHOOK_URL not set" },
      { status: 500 }
    );
  }

  try {
    const payload = buildBriefing();
    const r = await fetch(SLACK_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return Response.json(
        { ok: false, error: `Slack webhook ${r.status}: ${text.slice(0, 200)}` },
        { status: 502 }
      );
    }
    return Response.json({
      ok: true,
      sentAt: new Date().toISOString(),
    });
  } catch (e) {
    return Response.json(
      { ok: false, error: e.message || "Unknown error" },
      { status: 500 }
    );
  }
}

export async function GET(request) {
  return runBriefing(request);
}
export async function POST(request) {
  return runBriefing(request);
}
