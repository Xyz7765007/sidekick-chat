// ═══════════════════════════════════════════════════════════════════
// POST /api/post-chat   (Kunal Jun16 — per-post context chatbot)
// Body: { message, post, author?, history? }
//   - message : the exec's question ("simplify this for me", "who is this")
//   - post    : the raw LinkedIn post text (the ONLY context the bot has)
//   - author  : optional "Name — Title — Company" identity string
//   - history : optional [{ role:'user'|'assistant', text }] (capped here)
//
// Returns { ok, reply }. A tiny, single-post helper — NOT the full chat
// orchestrator (/api/chat). It can ONLY talk about the post it's handed,
// so it never touches SignalScope, leads, or tools. Cheap path: Haiku.
//
// Why a separate route: keeps the focused card self-contained and the
// blast radius zero — no lead data, no actions, no tool loop.
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 20;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Sonnet 4.6 (Samarth Jun16): richer "who is this / why does this matter"
// reasoning than Haiku for the per-post helper. Override via POST_CHAT_MODEL.
const POST_CHAT_MODEL = process.env.POST_CHAT_MODEL || "claude-sonnet-4-6";

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

const SYSTEM_PROMPT = `You are Side Kick — an outbound co-pilot helping a busy B2B sales operator decide how to engage with ONE specific LinkedIn post (their current task) and act on it.

WHO THE OPERATOR IS (their GTM context — use this to judge fit and suggest moves):
- They run outbound for Veloka, a B2B outbound-infrastructure motion. The play: spot a real buying/engagement signal (like this LinkedIn post), then engage the author authentically — comment, connect, then DM — to open a conversation. No spray-and-pray.
- Their ideal customer (ICP): companies with an established sales motion, a real marketing org, and meaningful deal size (high ACV). A senior, relevant author at an in-ICP company is a strong engage signal.
- The goal of engaging a post is to earn a warm reply that leads to a connection and a conversation, not to pitch in the comments.

WHAT YOU CAN HELP WITH (this post + author + the operator's GTM context):
- Simplify / explain the post in plain English; strip jargon.
- Who is this and why does this matter — using the author identity + post content given.
- Whether this post is a fit for the operator's GTM/ICP and WHY (is the author senior and relevant, is the topic a buying signal, is now a good moment to engage), and the smartest next move (comment, connect, DM, or skip).
- Draft a comment, a connection note, or a short DM opener tied to THIS post when asked — sound human and specific to the post, never salesy or templated, no "great post!" filler.

GUARDRAILS:
- Stay grounded in THIS post + author + the GTM context above. Do NOT invent facts about the person or company beyond what's given; if you don't know, say so plainly.
- You do NOT have the operator's wider lead feed, scores, or tools here — if they ask about other leads or the queue, say this chat is scoped to this post.
- Be brief and plain. Default to 1-4 short sentences. No preamble, no "great question", no bullet dumps unless asked.
- No em dashes.

FEEDBACK DETECTION (important):
- Sometimes the operator is not asking a question — they are giving FEEDBACK about this task/post/feed: e.g. "this isn't relevant", "too junior", "wrong audience", "stop showing me product marketing roles", "this post is off-topic", "this person already replied", "don't surface 6-day-old posts". That is feedback, not a question.
- A request to simplify/explain/assess/draft, or any genuine question, is NOT feedback — it's help. Be conservative: only flag clear feedback.
- When the message IS feedback: set is_feedback true and put a clean one-line summary of it in feedback_text (in the operator's intent, e.g. "Product marketing titles are not relevant"). Still give a short, warm reply acknowledging you noted it.
- When it is NOT feedback: set is_feedback false and feedback_text "".

RESPONSE FORMAT — output VALID JSON ONLY, no markdown fences, no prose around it:
{"reply": "your short reply", "is_feedback": false, "feedback_text": ""}`;

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

  const { message, post, author, history } = body || {};
  if (!message || !String(message).trim()) {
    return Response.json({ ok: false, error: "message required" }, { status: 400 });
  }
  if (!post || !String(post).trim()) {
    return Response.json({ ok: false, error: "post text required" }, { status: 400 });
  }

  // The post + author identity are pinned into the system prompt so they
  // can't be argued away by the conversation. Cap the post so a huge paste
  // can't blow the token budget.
  const postBlock = [
    author ? `Post author: ${String(author).trim()}` : null,
    "",
    "The LinkedIn post (the only thing you may discuss):",
    "\"\"\"",
    String(post).slice(0, 6000).trim(),
    "\"\"\"",
  ].filter(Boolean).join("\n");

  // Carry a short rolling history (last 6 turns) so follow-ups work, but
  // keep it bounded — this is a quick helper, not a long thread.
  const priorTurns = Array.isArray(history)
    ? history
        .filter(m => m && (m.role === "user" || m.role === "assistant") && m.text)
        .slice(-6)
        .map(m => ({ role: m.role, content: String(m.text).slice(0, 2000) }))
    : [];

  const messages = [...priorTurns, { role: "user", content: String(message).slice(0, 2000) }];

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
        system: `${SYSTEM_PROMPT}\n\n${postBlock}`,
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

    // The model is asked to return {reply, is_feedback, feedback_text}. Parse it;
    // if parsing fails (model slipped into plain prose), treat the whole thing as
    // the reply with no feedback — the chat never breaks on a format miss.
    const parsed = extractJSON(raw);
    const reply = parsed && typeof parsed.reply === "string" && parsed.reply.trim()
      ? parsed.reply.trim()
      : raw;
    const isFeedback = !!(parsed && parsed.is_feedback === true);
    const feedbackText = isFeedback && typeof parsed.feedback_text === "string"
      ? parsed.feedback_text.trim()
      : "";

    // feedback (when present) tells the client to durably capture it via the
    // /api/feedback proxy. We don't auto-enforce a feed suppression rule here —
    // capture-and-acknowledge keeps a wrong read from silently nuking tasks.
    return Response.json({
      ok: true,
      reply,
      feedback: isFeedback && feedbackText ? { text: feedbackText } : null,
    });
  } catch (e) {
    console.error("[POST-CHAT] Exception:", e.message);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
