# 2026-06-12 — Kunal Jun12 (post-call): strip app to bare LI post + CTA

## What changed
Kunal wants the app rolled back: each card shows ONLY the original LinkedIn
post + a "Comment on LinkedIn" CTA. Done behind feature flags, NOT a fork —
nothing deleted, re-add = flip a flag.

New `lib/features.js` with 5 flags, all `false`:
- `chat` — floating chat fab + slide-up panel (/api/chat)
- `connectionFlow` — daily connection batch (DailyBatchCard) + header "Batch" btn
- `commentAssist` — angle chips + generate-comment + write-my-own + feedback
- `summary` — AI post summary/bullets (off → card shows raw `card.post_text`)
- `otherCards` — movement / top-leads / GA cards (off → queue is LI-only)

Gates in `components/SideKick.jsx`: import flags; `orderedQueue` filters to
`linkedin_engagement` only + drops the batch step; header batch button + count
term gated; chat fab/panel gated; prefetch skips summary/angles fetch;
`LinkedInCommentCard` shows raw post inline (no summary/toggle/angles/comment),
adds the `↗ Comment on LinkedIn` CTA (opens post URL), keeps Mark Done/Skip,
hides focus-chat + Not-needed.

## Why flags not a separate repo
Samarth floated cloning to a new repo. Flags serve "re-add fast later" better:
one repo, same live URL, no divergence, re-enable = one-line flip. Separate repo
would drift + need a second Vercel deploy.

## Gotchas
- `status` (commentData) stays "loading" forever when the angles fetch is
  skipped — so the stripped post path must NOT key off `status`; it renders
  `fullPostText` directly. All summary-`status` branches gated behind `showSummary`.
- Card / DailyBatchCard components stay defined + referenced but never mount
  (otherCards/connectionFlow off). Harmless; keeps re-enable trivial.
- `historyLoaded` only feeds the (now-hidden) chat panel + the dormant
  auto-batch effect, so leaving loadHistory firing is safe.

## Status
DEPLOYED to main → live. Build clean (exit 0). Live QA via Chromium against
the deployed URL confirmed: no chat fab/panel, no Batch btn, no angles/comment
block, no summary; card = post + "Comment on LinkedIn" CTA + Done/Skip.

## QA catch (fixed same session)
First deploy fell back to `card.signal` for legacy cards with no stored
`post_text`, surfacing the internal brief (Suggested comment / Evidence / Why
it matters) as if it were the post — breaks rule #6. Fixed: stripped card uses
ONLY `rawPostText`; no post_text → clean "open it on LinkedIn" note + CTA. The
signal fallback now lives only in summary mode. Most post-2026-06-11 cards have
post_text and render the real post inline.
