// ─── House style enforcement for operator-facing copy ────────────────────
// Standing rule (Samarth): content drafted on the operator's behalf — LinkedIn
// comments, posts, DMs — carries NO em dashes. They are the strongest "an AI
// wrote this" tell in a public comment.
//
// The prompts already say "no em dashes" and the models still emit them
// (verified 2026-07-20: a generated comment and an AI-revised comment both
// came back with one). Prompt instructions are guidance; this is the
// deterministic gate that actually holds the rule.
//
// Rewrites rather than deletes, so the sentence still reads:
//   "X — it creates false confidence"  → "X, it creates false confidence"
//   "X — and it breaks"                → "X and it breaks"   (conjunction)
//   "cost—benefit"                     → "cost, benefit"
export function deEmDash(raw) {
  if (!raw || typeof raw !== "string") return raw || "";
  let s = raw;
  // A dash immediately before a conjunction just becomes a space.
  s = s.replace(/\s*[—–]\s*(?=(?:and|but|so|or|yet|then|because|which)\b)/gi, " ");
  // Everything else becomes a comma, which preserves the pause.
  s = s.replace(/\s*[—–]\s*/g, ", ");
  // Tidy the seams: no doubled or orphaned punctuation.
  s = s
    .replace(/,\s*,+/g, ",")
    .replace(/\s+,/g, ",")
    .replace(/,\s*([.!?;:])/g, "$1")
    .replace(/([.!?])\s*,/g, "$1")
    .replace(/[ \t]{2,}/g, " ");
  return s.trim();
}
