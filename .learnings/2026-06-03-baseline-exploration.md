# 2026-06-03 — Baseline exploration of live Side Kick Chat

## What was checked
Live app `https://sidekick-chat-beige.vercel.app/` + all proxy/own-work routes against prod SignalScope. Read-only only (no outreach triggered, per AGENTS.md D3).

## Live state (healthy)
- **Header:** "Side Kick · VELOKA · TASKS", banner "Email engine in development · LinkedIn DMs + tasks live", 16 pending.
- **Daily LinkedIn batch:** 5 ready (connection note + 3-DM sequences, avg ~232 chars). CTAs: Send all 5 / Review one-by-one / Skip today.
- **Card stack:** top lead cards render with score badge + expandable "View full breakdown" (deterministic rule scoring). e.g. Khaled Raslan (Kashier) 69/100; feed top = Luke Fuszard (Benepass) 84.
- **Chat panel + 30s feed polling** working.
- **Routes verified ok:true:** /api/count (16), /api/feed, /api/movement-scan-status (last run cancelled, 392 processed, $3.92), /api/auto-batch/pending (5 leads, batch 2026-06-03), /api/chat-history (12 msgs), /api/messages-feed (20).

## Key findings (frontend-fixable)
1. **CLAUDE.md §10 is STALE on the chat contract.** Documented payload is `{messages:[...], leadId?}`. Actual route (`app/api/chat/route.js:110`) expects `{ message, history, currentCount }`. Wrong shape returns `{ok:false,error:"message required"}`.
2. **Chat orchestrator has NO Veloka product/ICP context and NO per-lead data in chat.** Confirmed: asking "what does Veloka sell / ideal customer" → "I don't have details on Veloka's product or ICP in my context." Asking "why is X a good lead" → "I only see the task count, not the cards." This is the #1 recurring end-user complaint (visible in live chat-history). System prompt + tool definitions in chat/route.js are the fix surface — no backend change needed for product/ICP context; per-lead-in-chat may need a fetch_lead_details tool wired to an existing SignalScope endpoint.

## Prevention
- Always verify route request shape from code, not CLAUDE.md (doc drifts).
- Before claiming a chat-quality fix, reproduce against `/api/chat` with the real `{message,history,currentCount}` shape.
