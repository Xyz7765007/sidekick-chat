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

const SYSTEM_PROMPT = `You help a busy senior executive quickly understand ONE specific LinkedIn post so they can decide whether to engage with it.

You can ONLY discuss the post (and its author) provided below. If asked about anything else, say you can only help with this post.

Rules:
- Be brief and plain. Default to 1-3 short sentences. No preamble, no "great question", no bullet dumps unless explicitly asked.
- "Simplify this" / "what does this mean" → restate the post's core point in plain English a non-technical reader gets instantly. Strip jargon.
- "Who is this" / "why does this matter" → use only the author identity + post content given; if you don't have enough to know, say so plainly. Do NOT invent facts about the person or company.
- If the post is a rant, name what they're frustrated about in one line.
- Never write a comment or outreach message unless explicitly asked.
- No em dashes.`;

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
        max_tokens: 350,
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
    const reply = (data?.content?.[0]?.text || "").trim();
    if (!reply) {
      return Response.json({ ok: false, error: "Empty reply returned" }, { status: 500 });
    }

    return Response.json({ ok: true, reply });
  } catch (e) {
    console.error("[POST-CHAT] Exception:", e.message);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
