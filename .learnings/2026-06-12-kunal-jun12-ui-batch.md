# 2026-06-12 — Kunal Jun12 standup UI batch (items 1/3/4/5/6/7/8)

## What
7 UI fixes from Kunal's Jun12 standup. All in `components/SideKick.jsx` +
`app/globals.css`. No deps added (3-dep rule intact). Build exit 0, 26 routes.

## Items + fix
- **1 Batch confirm** — the header "↻ Batch" (regenerate) button wiped the
  existing batch on a misclick. Wrapped its onClick in
  `window.confirm("Are you sure you want to reload it?")` (native confirm, no dep).
- **3 Logo removed** — the "top-corner logo" was the `.avatar` orange-dot box
  in `hdr-l`. Deleted the element only (kept the brand text). Not replaced.
- **4 Full-bleed white header** — `.hdr` was `margin: 0 -24px` which only reached
  the `.app` 640px box edge, leaving paper bg on wide screens. Switched to
  viewport breakout: `width:100vw; margin-left:calc(50% - 50vw)` so the white
  reaches the SCREEN edge. Mobile rule updated to drop its `-14px` margin too.
- **5 3-slot header** — `.hdr` changed from `flex justify-between` (2 slots) to
  `grid-template-columns:1fr auto 1fr`. Added a `hdr-c` center cell holding
  `HeaderQueue`; brand stays `hdr-l` (justify-self:start), action buttons stay
  `hdr-r` (justify-self:end).
- **6 Recurring daily review pop-up OFF** — the daily LinkedIn batch
  auto-generated on first mount each day (the on-mount `useEffect` calling
  `handleGenerateBatch(false)`), surfacing the DailyBatchCard as a queue step.
  "Later" only deferred WITHIN the session (`deferStep`), so it returned next
  day. Gated the whole effect behind `const AUTO_GENERATE_BATCH = false;` —
  the trigger is removed, not snoozed. Manual "Batch" button still works. Flip
  the flag to true to restore.
- **7 Score display removed** — numeric relevance score rendered in 3 places:
  `Card` header chip (+ its inline score-adjust RelevanceMenu), the
  `LinkedInCommentCard` header chip, and `BatchLeadCard`'s "Score N". Gated the
  first two with `false &&` (reversible) and dropped the "Score N" span in the
  batch lead (kept the 🔥 Movement category badge). Score DATA untouched —
  `card.score` still drives sorting; payloads/backend unchanged.
- **8 Preload** — see sibling learning `2026-06-12-kunal-jun12-preload.md`.

## Prevention
- Header is now a 3-col grid; new header elements must land in one of
  hdr-l/hdr-c/hdr-r or they'll collapse the grid track.
- `false &&` guards are the surgical "display-only removal" pattern when the
  surrounding logic (RelevanceMenu adjust) should stay reachable later.
