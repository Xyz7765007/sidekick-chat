# 2026-06-09 — Remove "Top leads to call" surface

## What
Removed the Top-to-Call (`top_callable`) surface from the chatbot entirely.
Kunal asked twice on the 2026-06-09 OKR call to drop it — it cluttered the
unified task stack and stole focus from the lead chat. Card stack, chat,
auto-batch, and movement scan all left intact.

## Why
`top_callable` leads were folded into the unified stack as a pseudo task type
(server-curated cold-call queue). Removing it de-clutters the one-card flow.

## Files touched
- **components/SideKick.jsx:** dropped `topCallable`/`setTopCallable` state,
  `dismissedCallableIds` state, `fetchTopCallable` + its two poll calls + dep
  array, the `isTopCallable` session-dismiss branch in `handleAction`, the
  `top_callable` card-shape conversion / dedup / priority / breakdown in the
  render IIFE and the summary lazy-fetch effect, the `top_callable` typeChip
  entry, the QueueIndicator `callable` chip, and the dead `TopCallableCard`
  component (defined but never rendered as JSX). Empty-feed ref-clear effects
  now key on `cards` only.
- **app/globals.css:** removed the `.callable-reasons`/`.callable-reason` block
  (only the dead card used it) and `.card-type-callable`.

## Intentionally left
- `app/api/top-leads-to-call/route.js` — proxy kept in place (harmless), now
  has ZERO client references so nothing calls it.
- Shared helpers KEPT (generic `Card` uses them): `handleEnrichPhone`,
  `enriching`, `/api/enrich-phone`, `buildScoreTooltip`, phone fields,
  `formatSignalText` (its `🔗` marker logic is generic; only a stale comment
  naming TopCallableCard was trimmed). `top_x` "Top lead" is a SEPARATE surface
  and was left untouched.

## Build
`rm -rf .next && npx next build` → exit 0, all 21 routes (incl the now-orphan
`/api/top-leads-to-call` proxy). 3-dependency rule intact (no deps changed).
