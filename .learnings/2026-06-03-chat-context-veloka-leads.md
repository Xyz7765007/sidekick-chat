# Chat assistant lacked Veloka context + live lead data

## What broke
Chat orchestrator (`app/api/chat/route.js`) couldn't answer "what does Veloka sell"
(replied "I don't have details") or per-lead questions like "why is X a good lead?"
(replied "I only see the count, not the cards").

## Root cause
The system prompt had no Veloka product/ICP context, and only `{{COUNT}}` (the pending
total) was injected — never the actual lead cards. Claude literally had no per-lead data.

## Fix (frontend-only, no new dependency)
- Added a "WHO VELOKA IS" business-context block to `SYSTEM_PROMPT`.
- Added a `{{LEADS}}` placeholder + new `fetchLeadsSnapshot()` helper that pulls the live
  feed from SignalScope (`/api/sidekick/feed?baseId=...&limit=20`, Bearer auth, server-side),
  sorts by score, takes top 15, trims fields, caps signal text, and formats one line per lead.
- Substituted both `{{COUNT}}` and `{{LEADS}}` in the POST handler. On any feed failure the
  snapshot is null and the prompt falls back to count-only context (non-fatal).

## Prevention
- Any helper that calls a SignalScope per-campaign endpoint MUST pass `baseId` — the proven
  `/api/feed` proxy contract includes it (CLAUDE.md §145). First pass omitted it; fixed to
  mirror the proxy exactly.
- Field names must match the feed shape used by `SideKick.jsx`: `cards[]` with
  `lead_name`, `company`, `lead_title`, `score`, `signal`.
