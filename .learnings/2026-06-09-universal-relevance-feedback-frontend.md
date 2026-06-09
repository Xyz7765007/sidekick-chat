# 2026-06-09 — Universal relevance feedback (frontend)

## What
Kunal's "feedback on anything, less is more, highlight and figure it out": every
data point on a card can now drive a STRUCTURED relevance rule (hard-suppress,
retroactive, reversible — enforced backend). Frontend = capture + clean UX +
visible feed refresh. 3-dep rule intact (native fetch/DOM, react-dom portal).

## Changes
- NEW `app/api/relevance/route.js` — GET (list, forwards `limit`) + POST (create
  `{kind,value,targetScore?,note?}` OR deactivate `{ruleId,active:false}`) →
  `/api/sidekick/relevance`, injecting baseId + Bearer. Copied feedback/preferences
  proxy pattern (force-dynamic/no-store, same env vars).
- `components/SideKick.jsx`:
  - NEW `RelevanceMenu` — quiet "⋯" dot per field; click → portaled (to body)
    popover with the ONE structured action. `mode="score"` renders a 0-100 input.
  - Card affordances: TITLE → title_irrelevant(lead_title); COMPANY →
    company_irrelevant(company; sends REAL name even on Exited, not "Ex-");
    SCORE chip → role_fit(lead_title,targetScore); SIGNAL/movement →
    signal_irrelevant(movement_type||task_type); SUMMARY on the regular card now
    wrapped in FeedbackCapture (freeform highlight→note, was LI-only before).
  - Universal "Not needed" button (Card + LinkedInCommentCard) → existing
    /api/action skip with notes:"not needed", advances the stack like skip.
  - `createRelevanceRule`/`deactivateRule`/suppress*/adjustScore/markNotNeeded
    handlers. After every create → `fetchFeed()` (suppressed leads vanish) + toast.
  - Toast upgraded to `{msg, undo}`; suppress toasts carry an Undo that calls
    deactivate with the create's returned `id`, then refetches.
- `app/globals.css`: rel-dot/rel-pop/rel-pop-score, card-rel-*, quiet Not-needed
  btn, toast-msg/toast-undo.

## Gotchas
- Popover is `position:fixed` → MUST `createPortal(…, document.body)` + its own
  popRef excluded from outside-click dismiss; card stack has transformed ancestors
  (swipe/card-stack/li-comment-card) that re-base fixed coords (2026-06-08 portal).
- Score affordance gates on `typeof card.score === "number"`; signal-mute lives on
  the movement-badge row, else inside the signal block (covers top_x/engagement).

## Build
`rm -rf .next && npx next build` → exit 0, ✓ Compiled, new /api/relevance listed,
22 routes. 3-dep rule unchanged.
