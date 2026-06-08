# 2026-06-08 — Kunal June-5 core UX batch (5 frontend items)

## What was addressed
Kunal's feedback batch on the operator UX. All frontend-only (+2 own-work AI
routes that call Anthropic directly — no SignalScope/proxy contract touched).

## Changes per file
- **app/api/comment-angles/route.js (NEW):** POST → `{ok, summary, bullets[],
  angles:[{id,label,hint}]}` (exactly 3 distinct angles, Haiku). Strips internal
  scoring jargon; post text capped 2000 chars.
- **app/api/generate-comment/route.js (NEW):** POST `{...post ctx, angle, persona?}`
  → `{ok, comment}`. Real POV, no parroting, internal-leak guarded.
- **components/SideKick.jsx:**
  - item 1: new `LinkedInCommentCard` for `task_type==="linkedin_engagement"`
    (title/summary/bullets/View-full-post → 3 angle chips → editable comment +
    Regenerate → "Comment on LinkedIn" opens URL + copies). `commentData` cache
    + lazy fetch on top-card mount. Summarize effect now skips LI cards (no
    double spend). Extracted module-level `copyToClipboard` (modal reuses it).
  - item 2: visible ✎ edit affordance on each BatchLeadCard message field.
  - item 3: DailyBatchCard primaries = Send all / Skip today; "Review one-by-one"
    demoted to a quiet underline toggle. Card primary row unchanged (Done/Skip).
  - item 4: 💬 feedback affordance on batch messages + generated comment →
    `handleItemFeedback` focuses chat + prefills `Feedback on the <item> for <lead>: `.
  - item 5: DailyBatchCard collapses to a compact single-line row by default
    (`batchCollapsed`), expands on click. Stack stays the focal point.
- **app/globals.css:** added batch-compact / collapse / review-toggle /
  batch-msg-affordance / li-* (post block, angle chips, comment box) styles,
  matching existing class conventions.

## Verification
`npx next build` clean — both new routes compile, 21 routes total. 3-dependency
rule intact (next/react/react-dom only; vanilla clipboard + window.open + native
fetch). NOT verified live (prod ANTHROPIC/SIDEKICK keys only on Vercel).

## Prevention
- Comment routes treat `signal` as post content ONLY — never echo score/rule
  names (same internal-vs-public rule that bit the email draft on 2026-06-04).
- LI cards bypass /api/summarize to avoid paying twice for the same top card.
