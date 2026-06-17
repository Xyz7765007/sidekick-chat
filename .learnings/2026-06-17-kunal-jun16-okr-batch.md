# 2026-06-17 — Kunal Jun16 OKR syncup batch (live walkthrough feedback)

Source: Fireflies "Weekly OKR Syncup - Samarth" (Jun 16). Kunal walked the
stripped Sidekick chat app as a user and gave a burst of feedback. Samarth
said "do all changes" + explicitly added "remove the box at the bottom too".

## What shipped (all in the LinkedIn card path — the only card type live)
1. **Author-context header** — `li-author` block under the name: headline
   (`lead_title`) · company (Ex-`company` for Exited). Public fields only,
   never the internal signal (rule #6). Falls back to the old `meta` line if
   neither is set. Solves his #1: "doesn't give me enough context on who he is."
2. **Skip-feedback prompt** — clicking Skip swaps the action row for a tiny
   `SkipReason` prompt: 4 one-tap chips (Not relevant / Too complex / Wrong
   audience / Already engaged) + optional typed note. Any choice logs to
   `/api/feedback` as `item_type:"skip_reason"` then fires the skip. Best-effort
   log — never blocks the skip. Gated by `FEATURES.skipReason` (true).
3. **Bottom box removed** — the `card-kbd-hint` ("↵ done · S skip · U undo")
   box at the card bottom is gated off with `{false && (...)}`. Reversible.
4. **Chat circle** — already gone (`FEATURES.chat` false since Jun12); the
   focus-chat 💬 button stays gated behind it. No new change needed.
5. **Per-post context chatbot** — `PostChat` component: collapsed to one quiet
   "💬 Ask about this post" line (single-focus card stays clean); expands to a
   tiny inline chat scoped ONLY to this post. Two suggestion chips ("Simplify
   this", "Who is this?"). Backed by new `/api/post-chat` route. Gated by
   `FEATURES.postContextChat` (true).

## New route — /api/post-chat
Mirrors `/api/summarize` (Anthropic via fetch, maxDuration 20). Model = Sonnet
4.6 (`claude-sonnet-4-6`, Samarth's call Jun16 for richer "who is this / why
matters" reasoning; started on Haiku, switched same day). Override via
`POST_CHAT_MODEL`. System
prompt pins the post text + author identity and forbids discussing anything
else — no leads, no tools, no SignalScope. Body `{ message, post, author,
history }`, returns `{ ok, reply }`. Post capped at 6000 chars, history at 6
turns. Uses existing `ANTHROPIC_API_KEY` (already set for chat/summarize).

## Not built (per Kunal on the call)
- Inline likes/comments count → INVESTIGATE first (LinkedIn API? cost?). Not built.
- Lead-profile summary card + engagement summary → he said "not right now".

## Gotchas / prevention
- New FEATURES flags (`postContextChat`, `skipReason`) are ON — the repo's flag
  convention was previously "off = hidden"; these are the first ON flags, kept
  for reversibility, not because they're off.
- Swipe-to-skip (mobile SwipeCard) bypasses the skip prompt — it calls
  `handleAction` directly. Acceptable v1; the prompt is on the desktop button.
- `/api/post-chat` model behavior is only E2E-testable against the deployed URL
  (no local Anthropic key). Build clean ≠ verified — smoke-test in prod.
- Build on desktop: `node node_modules/next/dist/bin/next build` (npx/.bin shim
  doesn't resolve under git-bash here). Build exit 0, 27 routes.

## Follow-up (same day)
6. **"N more queued" box removed** — Samarth flagged the `QueueIndicator`
   ("18 queued") box below the card. Gated off with `{false && ...}` at the
   render site (reversible). Header dot-counter still conveys progress, so the
   card stays single-focus. Commit `85b3130`.

## Status
Built clean. Deployed to main → Vercel (cc99fa2 + 85b3130). Prod smoke-test of
/api/post-chat green; homepage 200.
