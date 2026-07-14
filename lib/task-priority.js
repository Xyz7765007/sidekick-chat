// ═══════════════════════════════════════════════════════════════════
// Task prioritization (Kunal 2026-06-19) — a fresh post should outrank a
// stale one, but seniority/ICP fit (the score) still leads. So priority =
// score + a freshness boost that decays with the post's age. This brings
// today's posts up without letting a low-fit fresh post leapfrog a strong
// senior lead. Uses the post's publish date when known, else the task's
// created date. Pure functions of the card — no side effects.
//
// Lives in lib/ (not in a component) because BOTH surfaces rank with it now:
// the web queue and the WhatsApp batch. Kunal's standing rule is that priority
// is never static and never hardcoded — so the two front-ends must not be
// allowed to drift into two different ideas of "what's next".
// ═══════════════════════════════════════════════════════════════════

export function postAgeDays(card) {
  const d = card?.post_date || card?.created_at;
  if (!d) return null;
  const t = new Date(d).getTime();
  if (isNaN(t)) return null;
  return Math.max(0, (Date.now() - t) / 86400000);
}

export function freshnessBoost(card) {
  const age = postAgeDays(card);
  if (age === null) return 0;       // unknown age → no boost (don't guess)
  if (age <= 1) return 15;
  if (age <= 2) return 11;
  if (age <= 3) return 7;
  if (age <= 4) return 4;
  if (age <= 5) return 2;
  return 0;                         // 6-7 days: about to age out, no boost
}

export function taskPriority(card) {
  return (card?.score || 0) + freshnessBoost(card);
}

// The comparator the LinkedIn queue sorts by: priority, then raw score, then
// recency. Same order the web card stack uses.
export function byPriority(a, b) {
  const d = taskPriority(b) - taskPriority(a);
  if (d !== 0) return d;
  const ds = (b.score || 0) - (a.score || 0);
  if (ds !== 0) return ds;
  const ta = new Date(a?.post_date || a?.created_at || 0).getTime();
  const tb = new Date(b?.post_date || b?.created_at || 0).getTime();
  return (isNaN(tb) ? 0 : tb) - (isNaN(ta) ? 0 : ta);
}
