# 2026-07-01 — Task-switcher tiles must honor the same FEATURES strip the queue uses

## What broke
`deriveTiles(cards, …)` derived the switcher tile set from the RAW unfiltered
`/api/feed` response. Under the live Veloka config (`FEATURES.otherCards:false`,
`lib/features.js:28`) the queue (`orderedQueue`/`sortedStack`, ~L1498) renders ONLY
the feature-stripped set: `unipile_*` signals + `linkedin_engagement`. The raw feed
can still carry `lead_movement`/`top_x`/`engagement`/news-ish cards, so the switcher
rendered Movement / Top leads / Site visits / News tiles. Tapping one set `queueFilter`,
the stripped queue collapsed to empty, and the operator hit a FALSE "All clear".

## Root cause
Two different source sets: tiles came from raw `cards`, the queue from the
feature-stripped subset. A control could offer a family the queue can't render —
a dead-end (Nielsen #5 error-prevention / #1 system-status violation).

## Fix
`components/SideKick.jsx` — added `queueEligibleCards(cards)` that reproduces the
same feature strip the queue applies: when `!FEATURES.otherCards` it keeps only
`linkedin_engagement` + `task_type` starting `unipile_`; when on, it returns all
cards. `deriveTiles` now derives families from `queueEligibleCards(cards)` (the
unfiltered-but-feature-stripped "All" set), NOT raw `cards`. A family tile appears
iff ≥1 renderable card of that family exists in that set. So Movement/Top/Site-visits/
News can NEVER produce a tile while `otherCards` is off. "All" first + "Create post"
(when `postCreate`) unchanged; the row still hides when no family tiles qualify.
Also dropped the inert `flex-shrink:0` on `.switchwrap` in `globals.css:455`
(parent is a block, not a flex column).

## Prevention
Tiles and the queue must share ONE eligibility source. Derive the tile list from the
same feature-stripped, unfiltered set that produces `sortedStack` when
`queueFilter === null` — never from the raw feed, and never from the currently
*filtered* view (that would drop the other tiles once a filter is active). Any control
that can filter the queue must not be able to filter it to empty.
