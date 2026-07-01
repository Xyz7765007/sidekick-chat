# Dynamic task-switcher tile row (Kunal Jun30 approved switcher → live app)

## What shipped
Ported the Samarth-approved task-switcher from `sidekick-ui-mockups-demo/index.html`
into the live app as a filter nav row below the header, above the queue.
- `app/globals.css`: `.switchwrap`/`.switchrow`/`.tile`/`.tile.on` + 560px media
  query, copied 1:1 from the mock (tokens are identical — white `--card` surface,
  `#E8E3DA` `--border` hairline, `--r-sm`, inactive `--text-2` ink, active
  `--accent-bg` + `--accent` border + `--accent-dark` ink). No solid CTA orange.
- `components/SideKick.jsx`:
  - `SWITCHER_FAMILIES` (task_type → family predicate), `TILE_ALL`, `TILE_CREATE`,
    `deriveTiles(cards, includeCreate)`, `tileMatch(card, key)` — module-level,
    next to `getConnector` (shares its taxonomy).
  - `queueFilter` state (null = All).
  - `orderedQueue` memo filters source `cards` by the active family FIRST, reusing
    the whole existing sort/priority/batch engine unchanged; `queueFilter` added
    to its dep array.
  - Tile row rendered after `</header>`, before `<ScanBanner>`. Inline SVG icons
    (3-dep rule) via `dangerouslySetInnerHTML` on `<svg>`.

## The DYNAMIC requirement (the key ask)
Tiles are NOT hardcoded. `deriveTiles` includes a family tile ONLY if ≥1 card in
the live feed matches it (`fam.match(c.task_type, c)`). "All" always first;
"Create post" always last (capability, gated on `FEATURES.postCreate`). For the
current feed (comment tasks only) this yields exactly **All · LinkedIn comments ·
Create post**. When movement/top/visits/dms/news cards appear, their tiles show
up automatically. Row hides entirely if there are no family tiles (nothing to
switch). `linkedin_engagement` → "LinkedIn comments" (Kunal: a post you comment
on == a comment).

## Create-post header-vs-tile redundancy
KEPT both: the new tile (primary nav home for the capability, per the approved
mock) AND the header `✎ Create post` button (it also renders the "Close" state
when open, which the tile doesn't). Not silently removed (rule #8). Both drive
the same `postCreateOpen`. Flagged to Samarth to decide if the header ✎ should
retire now that the tile carries it.

## Skills used
refactoring-ui (spacing rhythm, constrained 540px width, hierarchy via accent-
tint not weight, hairline→existing border language) + ios-hig-design (horizontal
tab/segmented control, deference to the focused card, scroll-when-narrow, ~44pt
targets). taste-skill ruled out — this is a surgical add to an already-approved
design language (the mock is the source of truth), not a from-scratch surface.

## Build
`node node_modules/next/dist/bin/next build` → ✓ Compiled successfully, no
warnings. (npx pulls Next 16 and fails — use the local bin.) Not yet verified
live (no push — Samarth reviews the diff, deployer ships).
