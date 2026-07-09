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

  // ─── Kunal Jun16 (OKR syncup) — ON by default ──────────────────────
  // Per-post context chatbot: a small "Ask about this post" box below
  // each LinkedIn post, scoped ONLY to that post's text + author. Lets
  // the exec ask "simplify this for me" without leaving the card. Backed
  // by /api/post-chat. Flip to false to hide it.
  postContextChat: true,

  // Skip-feedback prompt: when the exec skips a post, ask "why did you
  // skip?" (one-tap reasons + optional note) and log it to /api/feedback
  // so the feed tunes itself. Flip to false to skip straight through.
  skipReason: true,

  // ─── Kunal Jun30 (feedback standup) — the post-creation "hooks engine" ─
  // The second paid value prop: create an ORIGINAL LinkedIn post. Header
  // "✎ Create post" button opens a one-card flow — pick 1 of 3 AI hooks
  // (Trending / ICP / Competitor), record (voice) or type, generate the
  // post in your voice, edit + Copy + Open LinkedIn, and refine it via the
  // "Talk to your agent about this task" chat. Standard fixed footer
  // (Mark as done / Skip / Regenerate hooks). Backed by /api/post-create.
  // Off by default — flip to true to turn the feature on for the operator.
  // Turned ON 2026-06-30 (Samarth) — live for Kunal.
  postCreate: true,

  // ─── Kunal Jul01 (scope-down) — DM + connection signals ───────────
  // The Unipile DM + connection family: DM reply, connection accepted,
  // DM/post reactions, and profile views (task_types unipile_message_reply,
  // unipile_connection_accepted, unipile_message_reaction,
  // unipile_post_reaction_on_yours, unipile_profile_view). When OFF these are
  // hidden from BOTH the queue AND the task-switcher, so the exec sees only
  // comments + Create post. NOTE: unipile_post_comment_on_yours is a COMMENT
  // (comments family), NOT a DM/connection signal — it is NOT gated here and
  // stays visible. Off for now (Samarth 2026-07-01) — flip to true to bring
  // the DM/connection surface straight back. Nothing deleted.
  dmsConnections: false,

  // ─── Kunal (2026-07-07) — "connection requests sent" review card ──────
  // A single digest card surfaced in the queue when >=5 connection requests
  // (Campaign "Veloka Connect", Status connection_sent on the Veloka Outreach
  // table) have gone out in the PAST 24 HOURS. Headline "N connection requests
  // have gone out" (N = everything sent since the last "Mark as done", which
  // resets N); an inner-scroll list of the 10 most-recent leads + "+M more";
  // one orange "Mark as done" CTA; a feedback box that flags a wrong lead
  // (-> Outreach Status="excluded" on Leads, dropped by the Top X rule). Backed
  // by /api/connections-sent (proxy) -> /api/sidekick/connections-sent. Flip to
  // false to hide the card entirely (data + card both gated). Nothing deleted.
  connectionsSent: true,

  // ─── "DMs sent" review card (2026-07-09) ──────────────────────────────
  // Sibling of connectionsSent: a digest card surfaced in the queue when DMs
  // have gone out (Campaign "Veloka Connect", any row with a Last DM Sent At)
  // in the recent 72h window. Headline "N DMs have gone out"; inner-scroll list
  // of the 10 most-recent leads with their DM step (DM1/2/3); one "Mark as done"
  // CTA (resets the count); feedback box to flag a wrong lead (→ Outreach
  // Status="excluded" on Leads). Backed by /api/dms-sent (proxy) →
  // /api/sidekick/dms-sent. Flip to false to hide entirely. Nothing deleted.
  dmsSent: true,
};
