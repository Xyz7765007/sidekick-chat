# 2026-06-12 — Item 8: one-eager + one-ahead post prefetch

## What broke
Advancing the one-at-a-time queue showed a spinner on the NEXT post every
time — its summary (`/api/summarize`) / comment brief (`/api/comment-angles`)
only started fetching once the card became the focused top card. Kunal: the
preload "isn't working." Wanted exactly the first post eager, the next
prefetched in the background on advance.

## Root cause
The summary lazy-fetch effect resolved ONLY the sticky top card and fetched
that one — no look-ahead. Comment angles fetched only from the LI card's own
mount effect (`onRequestAngles`), which also only fires for the focused card.
So nothing was ever warmed ahead; every advance paid the full latency.

## Fix (components/SideKick.jsx)
- Extracted the summarize fetch into `fetchSummaryFor(target)` (useCallback) —
  idempotent via the existing `summaries` cache + `pendingSummariesRef` guards.
- New effect resolves the sticky top's INDEX in the queue, derives the next
  step, then: eager-fetches `target`, prefetches exactly `next` (one ahead,
  never two). If `next` is a `linkedin_engagement` card it also warms its
  comment brief via `fetchCommentAngles(next)`.
- ORDERING GOTCHA: the prefetch effect references `fetchCommentAngles` in its
  dep array. `const` callbacks aren't hoisted, so the effect MUST be declared
  AFTER `fetchCommentAngles` or its dep array hits the temporal dead zone at
  render time (ReferenceError). Moved the effect below that definition.

## Correction (2026-06-12, reviewer should-fix)
- First cut had the prefetch effect run its OWN standalone `priorityOf` flat
  sort over `cards` only. That did NOT match the render's real queue, which
  (a) prepends a virtual `batch` step and (b) sinks `deferred` steps to the
  back via an `ordered` array — and even the base sort differed (render groups
  movements→top→comments→ga→other then score-sorts each group; the effect's
  flat `priorityOf` ranked them differently). So `merged[topIdx+1]` was NOT
  the step the operator actually advances to whenever a batch step or a
  deferred card was in play — the one-ahead prefetch warmed the WRONG card and
  item 8 silently failed in exactly those states.
- Fix: extracted the queue construction (group+score sort → virtual batch step
  → deferred sinking) into a single `orderedQueue` `useMemo`
  (deps: `cards`, `autoBatches`, `deferred`). BOTH the render IIFE and the
  prefetch effect now consume `orderedQueue` as the single source of truth, so
  prefetch can never drift from what's rendered. The render's inline steps 1-4
  were deleted and replaced with `const ordered = orderedQueue;`. The effect
  resolves the sticky top over `orderedQueue`, reads `.card` off the top + next
  steps (the `batch` step has no `.card`; `fetchSummaryFor` is a no-op on
  undefined). Required adding `useMemo` to the React import. 3-dep rule intact
  (no package added). `npx next build` → Compiled successfully.

## Prevention
- One-ahead only: prefetch `topIdx + 1`, nothing further — keeps token spend
  bounded (the original design goal of the lazy fetch).
- When a feature needs "the next thing the user sees," it MUST read the same
  derived queue the render uses — never reconstruct an approximation. The real
  order here includes the batch step + deferred sinking; a parallel sort will
  diverge the moment either is in play. One memo, two consumers.
- When an effect's dep array names a `useCallback`/`useMemo`, that callback
  must be defined earlier in the component body. Order matters for hooks that
  reference each other.
- `npx next build` → exit 0, 26 routes, 3-dep rule intact.
- NOT verified: live latency improvement (no SignalScope keys locally) —
  confirm on the deployed URL that advancing shows no spinner, including from
  the batch step and after deferring a card.
