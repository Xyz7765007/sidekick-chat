# 2026-07-20 — Post formatting restore + clickable identity (port from sidekick-posts)

## What broke
Provider (fresh-linkedin-scraper-api) strips post line breaks since ~Jul 8-12:
tasks ≤Jul-07 store real newlines, later scans store flat walls. Kunal flagged
it on the clone; Samarth ordered the port here.

## Fix
1. Two-layer display restore on LinkedInCommentCard: /api/restore-format
   (Haiku re-inserts breaks under a HARD same-characters-after-whitespace-strip
   guarantee, else null) + deterministic fallback (emoji list markers and
   hashtag tail get own lines, one sentence per paragraph). Stored text with
   real newlines passes through untouched. Session cache per card id.
2. Name → lead_linkedin (fallback LinkedIn people-search); company → LinkedIn
   company-search (connections-card grammar). Resting visuals identical,
   hover underline only.

## Root fix still open
Scan-time restore in news-material + re-fetch of flat batches — pending
Samarth's go. When it ships, /api/restore-format simply stops firing.

## Known latent sibling bug (NOT fixed here — not in scope of Samarth's ask)
Skip-reason feedback posts item_type "skip_reason" which the backend enum
400s silently (.catch hides it) — reasons are lost while the UI says "tunes
your feed". Fixed in sidekick-posts by sending task_feedback with a
"Skip reason:" prefix; port when approved.
