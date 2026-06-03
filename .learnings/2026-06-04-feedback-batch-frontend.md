# 2026-06-04 — Feedback batch (frontend: pt3, pt4-V1, pt6, pt7)

## What was addressed
Operator feedback (came in ~last week). Frontend share of a 7-point batch.

## Changes (components/SideKick.jsx + app/api/chat/route.js + globals.css)
- **pt3 (Exited shows old company as current):** `getMeta()` now labels an
  Exited movement's company as `Ex-<company>` and suppresses the stale stored
  title (the new role lives in the signal). Root cause was upstream: for an
  Exited task SignalScope sets the card `Company` = the account the lead LEFT
  (movement-detection.js `companyForTask = storedAccount`), so the header read
  it as current. Display-side relabel; backend role-deprioritization handled
  separately in SignalScope.
- **pt7 (chat focus context):** new `focusLead` state + 🎯/💬 card button +
  focus chip above the chat input + clear (✕). When set, the trimmed card is
  POSTed to `/api/chat` as `focusLead`; the orchestrator injects a new
  `{{FOCUS}}` block so Claude answers about THAT lead. Clearing returns to
  general chat. This is the structural fix for the old "chat is contextless"
  weakness (see 2026-06-03 learnings).
- **pt6 (why high-value / why call now):** resolved via pt7 — the focus block
  carries score, signal, score_reason, movement_type so the model gives a
  concrete "why now" instead of "I only see the count."
- **pt4 V1 (email new company):** ✉ card button opens `EmailDraftModal` —
  edit To/Subject/Body, Copy body / Copy all / Open in mail client (mailto).
  NO send. Send-from-app is V2 (needs verified domain + provider) — separate
  Kanban card on SignalScope board.

## Verification
- `npx next build` clean (17 routes, no new errors).
- 3-dependency rule respected: no new deps (vanilla clipboard + mailto only).
- Chat contract extended additively: `{message, history, currentCount, focusLead?}`.
  Backwards compatible — focusLead omitted = general chat (existing behavior).
- Live E2E (model responses) deferred to post-deploy: prod ANTHROPIC/SIDEKICK
  keys only exist on Vercel.

## Prevention
- Exited cards: the `company` field is the LEFT company by backend design.
  Any new UI reading `company` on a movement card must branch on movement_type.
- Keep focusLead POST payload trimmed (signal capped server-side at 600 chars).
