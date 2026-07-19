// ═══════════════════════════════════════════════════════════════════
// POST /api/restore-format   (ported from sidekick-posts clone, Samarth Jul-20)
//
// The LinkedIn scan provider started returning post text with its line
// breaks stripped (~Jul 8-12 2026), so post_text stores a flat wall of
// text. A regex heuristic can't know where the author's real breaks
// were — it guessed wrong on real posts (glued 👉 list lines, merged
// standalone sentences). This route asks a small model to re-insert the
// line breaks a LinkedIn author would have used, under a HARD guarantee:
// the output must contain exactly the same non-whitespace characters as
// the input, or we return formatted:null and the client keeps its
// deterministic fallback. The model can only move whitespace — it can
// never rewrite Kunal's leads' words.
//
//   { text } → { ok: true, formatted: string | null }
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const RESTORE_MODEL = process.env.RESTORE_FORMAT_MODEL || "claude-haiku-4-5-20251001";
const TEXT_CAP = 6000;

const SYSTEM = `You restore the line breaks of LinkedIn posts whose formatting was stripped by a scraper.

You receive the post as one flat block of text. Return the SAME text with newlines re-inserted the way the original LinkedIn author most plausibly formatted it:
- LinkedIn posts use short paragraphs (usually 1-2 sentences) separated by blank lines.
- A hook or punchy standalone sentence gets its own paragraph.
- List items marked with emojis (👉 ✅ ➡️ 🔹 •) or keycap numbers (1️⃣ 2️⃣ ...) each go on their OWN line, consecutive items on consecutive lines.
- A trailing run of #hashtags (and any company @mentions beside them) goes on its own final line.

ABSOLUTE RULE: you may ONLY insert newlines and remove the spaces they replace. Never add, delete, reorder, or change any other character — no fixing typos, no smart quotes, no punctuation changes. Output ONLY the reformatted post text, nothing else.`;

// Same-characters check: strip ALL whitespace from both sides — they must be
// byte-identical. This is what lets us trust a model with someone else's words.
function stripWs(s) {
  return (s || "").replace(/\s+/g, "");
}

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
  const text = typeof body.text === "string" ? body.text.trim().slice(0, TEXT_CAP) : "";
  // Nothing to do for empty or already-formatted text.
  if (!text || text.includes("\n")) {
    return Response.json({ ok: true, formatted: null });
  }
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: RESTORE_MODEL,
        max_tokens: 3000,
        system: SYSTEM,
        messages: [{ role: "user", content: text }],
      }),
    });
    const data = await r.json();
    const out =
      data && Array.isArray(data.content)
        ? data.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim()
        : "";
    // The guarantee: identical characters or we don't use it.
    if (out && stripWs(out) === stripWs(text)) {
      return Response.json({ ok: true, formatted: out });
    }
    return Response.json({ ok: true, formatted: null });
  } catch (e) {
    return Response.json({ ok: false, error: String(e && e.message ? e.message : e) }, { status: 502 });
  }
}
