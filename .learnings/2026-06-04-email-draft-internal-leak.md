# 2026-06-04 — Email draft V1 leaked internal scoring to the lead

## What broke
The pt4 email draft modal seeded the email body with the card's SDR summary /
signal. Live test produced a body that opened "Executive Chairman at Kashier,
69/100 fit. High ACV potential + 11-30 person sales team…" — i.e. internal
scoring text in an email addressed TO the lead.

## Root cause
`handleDraftEmail` used `summaries[card.id]` (the internal SDR summary) and
`card.signal` as the opening line. Those fields are internal-facing — same
class of data the auto-batch prompt explicitly bans from outbound copy
(generate/route.js INTERNAL-LEAK rules). The draft path had no such guard.

## Fix
Removed summary/signal from the draft body. Now uses only lead-safe context:
a neutral role line ("I came across your work as <title> at <company>") for
non-exited leads, the moved-on acknowledgment for exited leads, and a generic
Side Kick value sentence. No score, no rule names, no signal.

## Prevention
- NEVER seed lead-facing copy (emails, DMs, connection notes) from `summary`,
  `signal`, or `score_reason` — those are internal. Mirror the backend's
  PUBLIC FACTS / INTERNAL CONTEXT split.
- Caught only because I opened the modal in the live browser (rule A4). A
  successful build would not have caught it — always open the actual UI.
