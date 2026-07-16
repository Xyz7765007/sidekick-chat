# 📎 post-link marker + connection-aware plays (Kunal Jul-14 fix-now batch)

## What changed
- `parseNewsSignal` (SideKick.jsx): new `📎 <url>` marker → `postUrl`, placed
  after `🔗 <article-url>` (before 📝). Lookaheads extended (📰/📝/💡 stop at 📎).
- NewsCard: `postUrl` renders a second `.news-source` anchor "Open post ↗"
  directly after "Read the article ↗". No new CSS (locked design, pre-approved).
- layout.jsx: `<link rel="icon" href="/icon.svg">` added (app had NO favicon —
  only manifest + apple-touch-icon). Kunal F3 "fab icon" read as favicon.
- Airtable (Veloka Tasks, live): 4 Signals rewritten for the connection-state
  hard gate — Sunnyraj (connection-request-first + on-accept DM), Aman/Samir/Ana
  (explicit if-connected/if-not branches). Gaurav untouched (connected pattern).
  Only `Signal` touched; before/after snapshots verified byte-level.

## Backfill outcome
1 backfilled, 5 skipped — search run by coordinator with activity-ID date
decoding: Vendelux/Alex Reynolds Series B post VERIFIED (author + topic + Jul-8
date) → 📎 inserted into that task's Signal. Skipped: Nick Ferdon + Matt Dunn
(no announcement post found), QIZ + Agave (only wrong-author posts — co-founder
/ Y Combinator — would prescribe the wrong action), Rahul Sasi (unindexed).
Unverified post URLs are never guessed. Marker grammar documented in the
run-kit README + write-tasks.py for the next authored run.

## Gotchas
- `.news-source` is inline-block and JSX strips inter-element whitespace: two
  adjacent anchors render FLUSH (zero gap). Fixed with an approved `{" "}`
  inside the postUrl block (space renders only when both links exist) — no CSS.
  Remember JSX whitespace-stripping whenever adding sibling inline elements.
- 4 of 5 lead-news Jul-13 tasks had `Handled At` stamped Jul-14 12:06-12:19 UTC
  (Kunal actioned them on the call) — they are correctly absent from the feed;
  a "task missing from feed" report may just mean handled, check that first.

## Prevention
Play authoring rules live in the run-kit README hard gate: never prescribe a DM
to a non-1st-degree connection; unknown state → write the branch explicitly.
