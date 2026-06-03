# 2026-06-03 — Chat orchestrator context fix

## What broke
Chat assistant (`app/api/chat/route.js`) couldn't answer the two most common user questions: "what does Veloka sell / who's the ICP" and "why is lead X good / who should I call." Live replies: "I don't have details on Veloka's product or ICP" and "I only see the task count, not the cards." Headline feature was effectively blind.

## Root cause
The `SYSTEM_PROMPT` had no Veloka business context, and the request only injected the pending `{{COUNT}}` into the prompt — never the actual lead cards. The orchestrator had no path to per-lead data even though `/api/sidekick/feed` already returns it. Line ~64 even instructed the model "You see the count, not individual tasks."

## Fix (frontend-only, no new dependency, no backend change)
- Added a "WHO VELOKA IS" business-context block to `SYSTEM_PROMPT` (product, ICP, scoring model).
- Added `fetchLeadsSnapshot()` helper: GETs `/api/sidekick/feed` server-side (existing Bearer auth), sorts by score, takes top 15, caps each signal to 240 chars, formats a compact `CURRENT LEADS` block injected via a new `{{LEADS}}` placeholder. Returns null on any failure → prompt falls back to count-only (chat never breaks).
- Rewrote the stale line-64 instruction to reflect that the model now sees the top leads + scores + signals, and to say so honestly when a named lead isn't in the list (no inventing).

## Verification
- `npx next build` clean (all 16 routes).
- `fetchLeadsSnapshot` formatting verified against the real production feed (16 cards → top 15, ~4.9K chars, prompt assembles to ~8.8K chars).
- Live model Q&A test deferred to post-deploy: production ANTHROPIC_API_KEY + SIDEKICK_API_KEY exist only on Vercel, so the actual model response cannot be exercised locally.

## Prevention
- Chat contract is `{message, history, currentCount}` (CLAUDE.md §10 wrongly says `{messages:[]}` — still stale, flag separately).
- Local env has no real Anthropic/Sidekick keys; full chat E2E must run against the deployed URL. Don't claim model-behavior verification pre-deploy.
- Keep the snapshot token-bounded (top-N + signal cap) — mirrors backend's "summarized brief" discipline so chat cost stays bounded.
