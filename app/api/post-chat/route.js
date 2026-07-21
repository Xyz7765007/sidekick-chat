// ═══════════════════════════════════════════════════════════════════
// POST /api/post-chat   (per-TASK context chatbot)
// Body: { message, post?, author?, history?, leadContext?, commentContext? }
//   - message : the exec's question ("simplify this", "who is this", "is this a fit")
//   - post    : the raw LinkedIn post text (when the task is a post). Optional —
//               non-post tasks (connection accepted, DM reply, etc.) have none.
//   - author  : "Name — Title — Company" identity string
//   - history : optional [{ role:'user'|'assistant', text }] (capped here)
//   - leadContext : optional { score, signal, task_rule, task_type } — the card's
//               INTERNAL context (why it surfaced, fit score, the signal event).
//               Used for the bot's REASONING only; never leaked into drafted copy.
//   - commentContext : optional { angle, draft, canPost } — the comment the
//               operator is drafting on the card, so the chat can revise it or
//               post it on command.
//
// Returns { ok, reply, feedback?, revised_comment?, post_comment? }. Scoped to
// ONE task (this post/lead) + the operator's Veloka GTM context.
// ═══════════════════════════════════════════════════════════════════

import { deEmDash } from "../../../lib/text-style.js";
import { OPERATOR_VOICE_SHORT } from "../../../lib/comment-voice.js";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 20;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Sonnet 4.6 (Samarth Jun16): richer "who is this / why does this matter"
// reasoning than Haiku for the per-post helper. Override via POST_CHAT_MODEL.
const POST_CHAT_MODEL = process.env.POST_CHAT_MODEL || "claude-sonnet-4-6";

// ── Standing operator feedback (QA 2026-07-20) ──────────────────────────
// task_feedback rows (ask-box detected feedback + "Skip reason: …" notes)
// were being STORED in the Sidekick Feedback table but consumed by nothing:
// the backend preferences endpoint whitelists only comment/connection_note/dm.
// Close the loop: read the recent rows via SignalScope's public /api/airtable
// list action and inject them into every per-task chat as standing context, so
// what the operator said last week actually shapes what the bot advises this
// week. 60s in-memory cache — one upstream read per lambda per minute, and a
// fetch failure just falls back to the last good list (never blocks the chat).
const SIGNALSCOPE_URL = process.env.SIGNALSCOPE_API_URL;
const BASE_ID = process.env.VELOKA_BASE_ID;
let fbCache = { at: 0, lines: [] };
async function standingFeedback() {
  if (!SIGNALSCOPE_URL || !BASE_ID) return [];
  if (Date.now() - fbCache.at < 60000) return fbCache.lines;
  try {
    const r = await fetch(`${SIGNALSCOPE_URL.replace(/\/$/, "")}/api/airtable`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "list",
        baseId: BASE_ID,
        table: "Sidekick Feedback",
        params: {
          filterByFormula: `{Item Type} = "task_feedback"`,
          sort: [{ field: "Created At", direction: "desc" }],
          maxRecords: 12,
          fields: ["Feedback Text", "Lead Name", "Lead Company"],
        },
      }),
      cache: "no-store",
    });
    const d = await r.json();
    const lines = Array.isArray(d?.records)
      ? d.records
          .map((rec) => {
            const f = rec.fields || {};
            if (!f["Feedback Text"]) return null;
            const who = [f["Lead Name"], f["Lead Company"]].filter(Boolean).join(" at ");
            return `- ${String(f["Feedback Text"]).slice(0, 200)}${who ? ` (given on: ${who})` : ""}`;
          })
          .filter(Boolean)
      : [];
    fbCache = { at: Date.now(), lines };
    return lines;
  } catch {
    return fbCache.lines || [];
  }
}

// Pull a JSON object out of the model reply, tolerating stray fences/prose.
function extractJSON(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); }
  catch { return null; }
}

const SYSTEM_PROMPT = `You are Side Kick — an outbound co-pilot helping a busy B2B sales operator decide how to act on ONE specific task (the lead/post below) and execute it.

WHO THE OPERATOR IS (their GTM context — use this to judge fit and suggest moves):
- They run outbound for Veloka, a B2B outbound-infrastructure motion. The play: spot a real buying/engagement signal (a post, a connection accepted, a DM reply, etc.), then engage the person authentically — comment, connect, then DM — to open a conversation. No spray-and-pray.
- Their ideal customer (ICP): companies with an established sales motion, a real marketing org, and meaningful deal size (high ACV). A senior, relevant person at an in-ICP company is a strong engage signal.
- The goal is to earn a warm reply that leads to a connection and a conversation, not to pitch.

THE TASK MAY NOT BE A POST. It can be a LinkedIn post, OR an outreach-sequence event:
- "Connection accepted" → the invite was accepted; a warm intro window is open — the move is usually a first DM that references why you connected.
- "DM reply" → the lead replied; this is the hottest signal — help craft a reply that moves toward a call.
- "Reacted/commented/viewed" → lighter engagement; suggest the proportionate next touch.
Read the task type and signal below to know which it is, and advise accordingly.

WHAT YOU CAN HELP WITH (this task + person + the operator's GTM context):
- Simplify / explain the post or the event in plain English; strip jargon.
- Who is this and why does this matter — using the identity + content + signal given.
- Whether this is a fit for the operator's GTM/ICP and WHY, and the smartest next move (comment, connect, DM, reply, or skip).
- Draft a comment, connection note, DM, or reply tied to THIS task when asked — human and specific, never salesy or templated, no "great post!" filler.

USING THE INTERNAL CONTEXT (when provided below):
- You may be given the card's INTERNAL context: a fit score (e.g. "70/100"), the matched rules, and the raw signal. Use these to REASON and advise the operator (e.g. "strong fit because…", "this is why it surfaced").
- NEVER put the score, the fit percentage, or internal rule names into any comment, DM, connection note, or reply you draft. Drafted copy is lead-facing — it must read like a human wrote it, with zero internal scoring language.

GUARDRAILS:
- Stay grounded in THIS task + person + the GTM/internal context below. Do NOT invent facts beyond what's given; if you don't know, say so plainly.
- You do NOT have the operator's WIDER lead feed or tools here — if they ask about OTHER leads or the queue, say this chat is scoped to this task.
- Be brief and plain. Default to 1-4 short sentences. No preamble, no "great question", no bullet dumps unless asked.
- No em dashes.

FEEDBACK DETECTION (important):
- Sometimes the operator is not asking a question — they are giving FEEDBACK about this task/post/feed: e.g. "this isn't relevant", "too junior", "wrong audience", "stop showing me product marketing roles", "this post is off-topic", "this person already replied", "don't surface 6-day-old posts". That is feedback, not a question.
- A request to simplify/explain/assess/draft, or any genuine question, is NOT feedback — it's help. Be conservative: only flag clear feedback.
- When the message IS feedback: set is_feedback true and put a clean one-line summary of it in feedback_text (in the operator's intent, e.g. "Product marketing titles are not relevant"). Still give a short, warm reply acknowledging you noted it.
- When it is NOT feedback: set is_feedback false and feedback_text "".

THE COMMENT THE OPERATOR IS DRAFTING (when a COMMENT WORKSPACE block appears below):
- You can see the ANGLE they picked and their CURRENT DRAFT comment. Treat that draft as the live working copy — they are looking at it on screen right now.
- If they ask you to CHANGE the comment ("make it shorter", "punchier", "add a stat", "less salesy", "cut the last line", "rewrite it as a question"), return the FULL revised comment in "revised_comment". It replaces their draft in the box, so return the whole comment, not a diff or a fragment, and keep it in their voice.
- Honor the chosen angle when revising unless they ask to move off it. Same rules as any comment: specific, no empty praise, no internal scoring language, no em dashes.
- If they are only ASKING about the comment or the angle ("why this angle", "is this too long", "does this sound salesy"), answer in "reply" and leave "revised_comment" empty. Do not rewrite unless they asked for a change.
- When there is no draft yet, help them think about the angle; do not invent a draft unless asked.

POSTING THE COMMENT (only when a COMMENT WORKSPACE block is present AND it says posting is available):
- The operator can tell you to POST the comment to LinkedIn: "comment this", "comment it", "post it", "post this", "ok comment that", "go ahead and comment", "yes post it". When they do, put the EXACT text to post in "post_comment".
- Which text to post: if they just said "comment it" / "post it", use the CURRENT DRAFT. If they asked you to change it and then post ("shorten it and comment"), first revise, put the revised text in BOTH "revised_comment" and "post_comment". If they pasted their own comment in the message and said "comment this: <text>", use their pasted text. If they liked a comment you just proposed in the previous turn and said "comment that", use that proposed comment verbatim.
- "post_comment" must be the finished, ready-to-post comment in the operator's voice, obeying the same rules (lowercase, no em dashes, no praise, no pitch). Do NOT post_comment unless they clearly asked to post. A question or an edit request is not a post request.
- When you set post_comment, keep "reply" to a short confirmation like "posting that now." Never fabricate that it is already posted.
- If there is no draft and nothing to post, leave post_comment empty and ask them what to comment.

${OPERATOR_VOICE_SHORT}

RESPONSE FORMAT — output VALID JSON ONLY, no markdown fences, no prose around it:
{"reply": "your short reply", "is_feedback": false, "feedback_text": "", "revised_comment": "", "post_comment": ""}`;

export async function POST(request) {
  if (!ANTHROPIC_API_KEY) {
    return Response.json({ ok: false, error: "Server missing ANTHROPIC_API_KEY" }, { status: 500 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const { message, post, author, history, leadContext, commentContext } = body || {};
  if (!message || !String(message).trim()) {
    return Response.json({ ok: false, error: "message required" }, { status: 400 });
  }
  const postText = post ? String(post).trim() : "";
  const lc = (leadContext && typeof leadContext === "object") ? leadContext : {};
  const signalText = lc.signal ? String(lc.signal).trim() : "";
  // Need SOMETHING to talk about: a post, or the lead's signal/context.
  if (!postText && !signalText && !author) {
    return Response.json({ ok: false, error: "post or leadContext required" }, { status: 400 });
  }

  // Pin the task's context into the system prompt so it can't be argued away.
  const taskTypeLabel = lc.task_rule ? String(lc.task_rule).trim()
    : (lc.task_type ? String(lc.task_type).trim() : "");
  const contextBlock = [
    author ? `Person: ${String(author).trim()}` : null,
    taskTypeLabel ? `Task type: ${taskTypeLabel}` : null,
    postText ? "" : null,
    postText ? "The LinkedIn post:" : null,
    postText ? "\"\"\"" : null,
    postText ? postText.slice(0, 6000) : null,
    postText ? "\"\"\"" : null,
    (signalText || (lc.score !== undefined && lc.score !== null)) ? "" : null,
    (signalText || (lc.score !== undefined && lc.score !== null))
      ? "INTERNAL CONTEXT (for your reasoning ONLY — never quote scores or rule names in drafted copy):"
      : null,
    (lc.score !== undefined && lc.score !== null) ? `- Fit score: ${lc.score}/100` : null,
    signalText ? `- Signal / why this surfaced:\n${signalText.slice(0, 3000)}` : null,
  ].filter(v => v !== null && v !== undefined).join("\n");

  // The comment the operator is actively drafting on the card (angle + draft).
  const cc = (commentContext && typeof commentContext === "object") ? commentContext : null;
  const ccAngle = cc && cc.angle && typeof cc.angle === "object" ? cc.angle : null;
  const ccDraft = cc && typeof cc.draft === "string" ? cc.draft.trim() : "";
  const commentBlock = cc
    ? [
        "",
        "COMMENT WORKSPACE (what the operator has on screen right now):",
        ccAngle && ccAngle.label ? `- Chosen angle: ${String(ccAngle.label).slice(0, 120)}` : null,
        ccAngle && ccAngle.hint ? `- Angle direction: ${String(ccAngle.hint).slice(0, 400)}` : null,
        ccDraft ? "- Current draft comment:" : "- No draft written yet.",
        ccDraft ? `"""\n${ccDraft.slice(0, 3000)}\n"""` : null,
        cc.canPost ? "- Posting to LinkedIn IS available. If the operator tells you to comment/post it, return post_comment." : "- Posting is not available for this task (no post link).",
      ].filter(v => v !== null).join("\n")
    : "";

  // Carry a short rolling history (last 6 turns) so follow-ups work, but
  // keep it bounded — this is a quick helper, not a long thread.
  const priorTurns = Array.isArray(history)
    ? history
        .filter(m => m && (m.role === "user" || m.role === "assistant") && m.text)
        .slice(-6)
        .map(m => ({ role: m.role, content: String(m.text).slice(0, 2000) }))
    : [];

  const messages = [...priorTurns, { role: "user", content: String(message).slice(0, 2000) }];

  // Standing operator feedback shapes every new interaction. Best-effort.
  const fbLines = await standingFeedback();
  const feedbackBlock = fbLines.length
    ? `\n\nSTANDING OPERATOR FEEDBACK (notes this operator gave on earlier tasks, most recent first — honor these when judging fit, advising, or drafting; do not repeat what they flagged):\n${fbLines.join("\n")}`
    : "";

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: POST_CHAT_MODEL,
        max_tokens: 500,
        system: `${SYSTEM_PROMPT}\n\n${contextBlock}${commentBlock}${feedbackBlock}`,
        messages,
      }),
    });

    if (!r.ok) {
      const errTxt = await r.text();
      console.error("[POST-CHAT] Anthropic error:", r.status, errTxt.slice(0, 200));
      return Response.json({ ok: false, error: "Reply failed", status: r.status }, { status: 500 });
    }

    const data = await r.json();
    const raw = (data?.content?.[0]?.text || "").trim();
    if (!raw) {
      return Response.json({ ok: false, error: "Empty reply returned" }, { status: 500 });
    }

    const parsed = extractJSON(raw);
    // Raw-fallback ONLY when parsing genuinely failed (model slipped into prose).
    const parsedReply = parsed && typeof parsed.reply === "string" ? parsed.reply.trim() : "";
    const hasRevision = !!(parsed && typeof parsed.revised_comment === "string" && parsed.revised_comment.trim());
    const reply = parsedReply
      ? parsedReply
      : parsed
        ? (hasRevision ? "Updated the comment above." : "Done.")
        : raw;
    const isFeedback = !!(parsed && parsed.is_feedback === true);
    const feedbackText = isFeedback && typeof parsed.feedback_text === "string"
      ? parsed.feedback_text.trim()
      : "";

    const revisedRaw = parsed && typeof parsed.revised_comment === "string"
      ? parsed.revised_comment.trim()
      : "";
    const revised = cc && revisedRaw && revisedRaw !== ccDraft
      ? deEmDash(revisedRaw).slice(0, 3000)
      : "";

    // Post-comment intent: only honored when a workspace is open AND posting is
    // available. Cleaned through the same house-style pass as any drafted copy.
    const postRaw = parsed && typeof parsed.post_comment === "string" ? parsed.post_comment.trim() : "";
    const toPost = cc && cc.canPost && postRaw ? deEmDash(postRaw).slice(0, 1250) : "";

    return Response.json({
      ok: true,
      reply,
      feedback: isFeedback && feedbackText ? { text: feedbackText } : null,
      revised_comment: revised || null,
      post_comment: toPost || null,
    });
  } catch (e) {
    console.error("[POST-CHAT] Exception:", e.message);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
