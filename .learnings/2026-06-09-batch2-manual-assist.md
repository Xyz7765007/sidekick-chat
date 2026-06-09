# 2026-06-09 — Batch-2 manual-with-assist LinkedIn outreach (frontend)

## What
Kunal #18/#19: a manual-assist outreach surface. The exec sends the connection
request / DMs by HAND on LinkedIn; the chatbot hands them the copy, opens the
profile, and records state. NO automation, NO new deps.

## Root / context
Backend (news-material) added `record_manual_connection_sent`,
`record_manual_dm_sent`, extended `mark_connected`, and added an additive
`outreach_queue[]` (in-flight leads + computed `nextAction`) to
`/api/sidekick/auto-batch/pending`.

## Fix
- NEW 1:1 proxy routes (canonical proxy template, Bearer added server-side,
  baseId=VELOKA_BASE_ID injected, forward to news-material `/api/outreach`):
  `app/api/outreach/record-connection-sent`, `.../record-dm-sent`,
  `.../mark-connected`. The `outreach_queue` arrives via the EXISTING
  `/api/auto-batch/pending` proxy (pass-through) — no new GET route needed.
- `components/SideKick.jsx`:
  - `outreachQueue` state; `fetchAutoBatches` now also `setOutreachQueue(data.
    outreach_queue||[])` (same 30s poll as batches).
  - `recordConnectionSent` / `markConnectionAccepted` / `recordDmSent` POST the
    proxies then `fetchAutoBatches()` + toast.
  - NEW `ManualAssistCard` renders by `nextAction.type`: connection (copy note &
    open LinkedIn = copyToClipboard + window.open + toast / mark sent), accept
    (mark accepted → mark_connected, schedules DM1+2d), dm step N (copy DM & open
    / mark DMN sent), waiting (muted "DMn scheduled — due {date}", no action).
  - Wired as `.ma-queue` block between DailyBatchCard and the unified task stack.
- `app/globals.css`: `.ma-queue*`, `.ma-card*`, `.ma-copybox`, `.ma-ctas` matching
  existing batch-card neumorphic styling.

## Prevention
- 3-dep rule intact (next/react/react-dom): native fetch + navigator.clipboard
  (existing copyToClipboard) + window.open only.
- Copy comes ONLY from backend `messageToCopy` (Generated note/DM) — never the
  internal signal/summary. `npx next build` → exit 0, 3 new routes listed.

## Update (later 2026-06-09) — AUTO vs MANUAL send toggle
- `DailyBatchCard` now has a per-batch send-mode toggle (`useState`, **default
  "manual"** — execs send by hand). Two pills: "✋ Manual (I'll send)" /
  "🤖 Auto (send for me)" + a one-line explainer of the selected mode.
- `onSendAll(sendMode)` / `onSendOne(recordId, sendMode)` now carry the mode;
  parent passes `sendMode` in the `handleBatchAction` params → POST body to
  `/api/auto-batch/action`. The proxy already spreads the whole body
  (`{ ...body, baseId }`), so `sendMode` forwards with no proxy change.
- Backend maps `sendMode` → `Mode:"manual"` (cron skips) or `"auto_batch"`
  (cron auto-sends). New CSS: `.batch-sendmode*` matches the card styling.
  `npx next build` → exit 0.
