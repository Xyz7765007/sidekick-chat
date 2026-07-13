# News tiles showed but filtered to a false "All clear"

## What broke
The new "Lead news" / "Market news" switcher tiles rendered, but tapping either
showed "All done" even though /api/feed served 10 news cards (Samarth, Jul 13).

## Root cause
Three separate gates decide what renders, and they don't share a card-type list:
1. `queueEligibleCards` (eligibility) — news was added ✓
2. `tileMatch` / `SWITCHER_FAMILIES` (tile + filter) — news was added ✓
3. `orderedQueue`'s `sortedStack` (final assembly) — **enumerates families
   explicitly**; task_type "news" wasn't listed, so news cards fell into the
   dropped `other` bucket in the stripped (otherCards off) branch. Tiles derive
   from gate 1+2 only, so they appeared while the queue stayed empty.

## Fix
`6f29cfb` — `newsCards` group added to `orderedQueue`: counted in
`accountedFor`, stacked after LinkedIn comments in BOTH branches
(`...newsCards.sort(byScore)`).

## Prevention
When adding a NEW task_type to the queue, there are FOUR touch points, not two:
`queueEligibleCards`, `SWITCHER_FAMILIES`/`tileMatch`, `countQS`, AND the
`sortedStack` family enumeration in `orderedQueue`. Grep for `liComments` to
find the assembly. A tile that renders proves only eligibility, not stacking —
always click the new tile against live data before calling it shipped.
