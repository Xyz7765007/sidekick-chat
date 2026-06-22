// ═══════════════════════════════════════════════════════════════════
// POST /api/post-chat   (per-TASK context chatbot)
// Body: { message, post?, author?, history?, leadContext? }
//   - message : the exec's question ("simplify this", "who is this", "is this a fit")
//   - post    : the raw LinkedIn post text (when the task is a post). Optional —
//               non-post tasks (connection accepted, DM reply, etc.) have none.
//   - author  : "Name — Title — Company" identity string
//   - history : optional [{ role:'user'|'assistant', text }] (capped here)
//   - leadContext : optional { score, signal, task_rule, task_type } — the card's
//               INTERNAL context (why it surfaced, fit score, the signal event).
//               Used for the bot's REASONING only; never leaked into drafted copy.
//
// Returns { ok, reply, feedback? }. Scoped to ONE task (this post/lead) + the
// operator's Veloka GTM context. It does NOT have the wider feed or tools.
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

  const { message, post, author, history, leadContext } = body || {};
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
  // Three parts: who (author), the post (if any), and the INTERNAL context
  // (score/rule/signal) the bot may reason with but must not leak into copy.
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
        system: `${SYSTEM_PROMPT}\n\n${contextBlock}`,
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
