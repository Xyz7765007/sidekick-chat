// ─── Side Kick feature flags ─────────────────────────────────────────
// Kunal Jun12 (post-call): roll the app back to the bare essentials —
// each card shows ONLY the original LinkedIn post + a "Comment on LinkedIn"
// CTA. Everything else is hidden, NOT deleted: flip a flag back to `true`
// to bring a feature straight back (no porting from another repo).
//
// This is the single source of truth for what's on/off. Gate UI in
// components/SideKick.jsx with `FEATURES.<flag>`; the backing handlers,
// API routes, and components stay wired so re-enabling is a one-line flip.
export const FEATURES = {
  // Floating chat launcher (bottom-right) + slide-up chat panel (/api/chat).
  chat: false,

  // Daily LinkedIn *connection* batch (DailyBatchCard) + header "Batch"
  // button + auto-generate-on-mount. The whole connection flow.
  connectionFlow: false,

  // AI comment assistance inside the LinkedIn card: angle chips,
  // generate-comment, "write my own", and highlight-to-feedback capture.
  commentAssist: false,

  // AI-generated post summary + bullet points on cards. When off, the
  // card shows the raw original post text instead.
  summary: false,

  // Non-LinkedIn task cards: lead movement, top-leads-to-call, GA
  // engagement. When off, the queue shows ONLY linkedin_engagement cards.
  otherCards: false,
};
