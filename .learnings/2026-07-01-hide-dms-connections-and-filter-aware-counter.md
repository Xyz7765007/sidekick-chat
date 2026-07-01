# 2026-07-01 — Hide DMs & connections (reversible flag) + filter-aware "N left" counter

## What broke / asked
1. For Kunal now, only COMMENTS + Create post should show — the whole DM/connection
   family (5 unipile types) had to be hidden from BOTH the queue and the switcher,
   reversibly (feature-flag philosophy: hide, never delete).
2. The header "N left" badge showed the GLOBAL /api/count total under EVERY switcher
   section — so a filtered section (e.g. 2 comments) still read "10 left". Nielsen #1
   (visibility of system status) violation: the badge disagreed with the view.

## Root cause
1. The stripped queue fetched `?taskType=linkedin_engagement,unipile_` (every unipile_*
   type) and the switcher's "DMs & connections" family (SWITCHER_FAMILIES) rendered a
   tile whenever any of those 5 types were present. No flag scoped them out.
2. `HeaderQueue pending` was hardwired to `count` (the global server total) regardless
   of `queueFilter`.

## Fix
- `lib/features.js`: added `dmsConnections: false` (documented, off for now — flip to
  true to restore). Covers unipile_message_reply / _connection_accepted /
  _message_reaction / _post_reaction_on_yours / _profile_view. NOT
  unipile_post_comment_on_yours (that's a COMMENT, stays).
- `components/SideKick.jsx`:
  - Added `DM_CONNECTION_TASK_TYPES` set + `isDmConnectionCard()` — the single
    predicate the queue and switcher share.
  - `queueEligibleCards()` now also strips DM/connection cards when the flag is off
    (in BOTH otherCards modes). This is the ONE eligibility source `deriveTiles` uses,
    so the "DMs & connections" tile gets zero eligible cards → no tile (surface 3).
  - `orderedQueue` now filters its source `cards` through `queueEligibleCards` before
    the family-filter, so a slipped-through DM/connection card (e.g. optimistic
    reopen) never renders (surface 2).
  - Feed/count fetch: when the flag is off, `countQS` fetches only
    `linkedin_engagement,unipile_post_comment_on_yours` — DM/connection types never
    enter the feed or the count (surface 1). `forcedExtra` scope check reuses
    `queueEligibleCards`.
  - Counter: `HeaderQueue pending` = `orderedQueue.length` when a filter is active
    (exactly what's on screen), else the global `count` (+batch step) for "All".

## Result with current data
Switcher = **All · LinkedIn comments · Create post**; queue = comment tasks + Create
post only; zero DM/connection cards or tiles; per-section "N left" matches the view.
Build: `node node_modules/next/dist/bin/next build` → ✓ Compiled successfully. Deps
still exactly next/react/react-dom. Not pushed (Samarth reviews, deployer ships).

## Prevention
Any card family hidden by a flag must be gated at ALL THREE surfaces — feed/count
fetch, rendered queue, and switcher tiles — via ONE shared eligibility predicate
(`queueEligibleCards`), never three drifting checks. Any queue-filtering control must
keep the status badge derived from the SAME filtered set it renders.
