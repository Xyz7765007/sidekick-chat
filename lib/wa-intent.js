// ═══════════════════════════════════════════════════════════════════
// What did he just mean?
//
// On the web card there are two SEPARATE surfaces: the comment box (where you
// reshape the draft) and "Talk to your agent about this task" (where you ask
// about the post, or tell it the lead is irrelevant). WhatsApp has one input
// box for both, so the split has to be inferred instead of clicked — asking him
// to tap a mode first would be exactly the extra chrome Kunal keeps deleting.
//
//   "make it shorter"      → edit  : redraft the comment
//   "who is this guy"      → chat  : /api/post-chat answers it
//   "this isn't relevant"  → chat  : post-chat detects it as feedback and logs it
//
// Haiku, one word out. A router is precisely the job a cheap model is for — the
// drafting itself still runs on COMMENT_MODEL (Sonnet), which is the thing
// Kunal actually judges.
//
// Bias is deliberate: when unsure, CHAT. A wrong "chat" costs him one reply he
// didn't want. A wrong "edit" silently destroys a draft he was happy with.
// ═══════════════════════════════════════════════════════════════════

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const INTENT_MODEL = process.env.INTENT_MODEL || "claude-haiku-4-5-20251001";

const SYSTEM = `You are a router. The operator is looking at a piece of AI-drafted copy (a LinkedIn comment, or a LinkedIn post they are writing) and has sent a message.

Decide which of two things they want:

"edit" — they are instructing you to CHANGE THE DRAFT. Examples: "make it shorter", "less salesy", "mention that we work with fintechs", "cut the last line", "punchier", "rewrite it", "add a question at the end", "too formal".

"chat" — ANYTHING else. A question about the post, the person, or the company ("who is this", "why did this surface", "is this a fit", "simplify this for me", "what's the angle here"), a request to explain or assess, or FEEDBACK about the task itself ("this isn't relevant", "too junior", "wrong audience", "stop showing me these", "he already replied").

If you are not sure, answer "chat".

Output exactly one word: edit or chat. Nothing else.`;

// Returns "edit" | "chat". Never throws — on any failure we fall back to "chat"
// for the reason in the header.
export async function classifyTaskMessage(message, draft = "") {
  if (!ANTHROPIC_API_KEY) return "chat";
  const text = String(message || "").trim();
  if (!text) return "chat";

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: INTENT_MODEL,
        max_tokens: 5,
        temperature: 0,
        system: SYSTEM,
        messages: [{
          role: "user",
          content: [
            draft ? `The current draft:\n"""\n${String(draft).slice(0, 1200)}\n"""\n` : "",
            `Their message:\n"""\n${text.slice(0, 600)}\n"""`,
          ].filter(Boolean).join("\n"),
        }],
      }),
    });
    if (!r.ok) return "chat";
    const data = await r.json();
    const out = String(data?.content?.[0]?.text || "").trim().toLowerCase();
    return out.startsWith("edit") ? "edit" : "chat";
  } catch {
    return "chat";
  }
}
