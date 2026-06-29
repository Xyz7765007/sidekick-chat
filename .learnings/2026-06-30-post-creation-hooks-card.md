# Post-creation "hooks engine" card (Kunal Jun30 feedback)

## What shipped
The second paid value prop — create an ORIGINAL LinkedIn post — as a one-card
flow behind `FEATURES.postCreate` (off by default). Header "✎ Create post"
button opens it; it takes over the single-card column (clears `topCardRef`).
- 3 AI hooks (Trending / ICP / Competitor) + Regenerate hooks
- Voice (browser Web Speech API) or type → generate post in the operator's
  voice → editable textarea + live char count → Copy + Open LinkedIn (manual)
- "Talk to your agent about this task" chat = the live refine loop
- Fixed footer (same on every card): Mark as done (orange) / Skip / Regenerate
- New `POST /api/post-create` (modes: hooks | generate | refine), Sonnet,
  public-facts-only prompt, never auto-posts.

## Key decisions (from the call + PM scoping)
- **Voice IS in v1.** No transcription provider in this repo + the 3-dep rule
  blocks adding one (OpenAI/Whisper). Solution: browser-native Web Speech API
  (`window.SpeechRecognition || webkitSpeechRecognition`) — records + transcribes
  client-side, zero deps, zero backend key. Works in Chrome/Edge; on unsupported
  browsers the mic button is hidden and it's type-only. No loss to the dep rule.
- **Orange reserved for Mark-as-done only.** Kunal "make it gray, not orange" →
  the chosen-hook highlight + active-hook state are NEUTRAL gray, not the
  mockup's `--accent` orange. The single orange CTA (Mark as done) stays, per
  the locked global rule. Reconciled, call-specific changes win.
- **Footer is fixed at 3.** Generate / Copy / Open live in the content (on the
  post block), NOT the footer — same way the comment card kept Open out of the
  footer. Never let the agent chat add a 4th footer button.

## Gotchas / prevention
- LinkedIn no longer prefills share text. "Open LinkedIn" copies the post then
  opens the share composer (`/feed/?shareActive=true`) — the copy is the real
  delivery mechanism. Don't expect a prefilled URL.
- Build: system Node 18.14.2 is too old for Next 14. Use portable Node 20
  (`My OS/.tools/node-v20.18.1-win-x64`) + `node node_modules/next/dist/bin/next
  build` (npx pulls Next 16 / `next` not on PATH).
- Route isn't flag-gated (only the UI is), so it can be verified live even with
  the card dark — curl `/api/post-create` with each mode. Verified Jun30: all
  three modes return correct shapes against the real model.

## Still gated OFF
`FEATURES.postCreate: false`. Flip to `true` to turn it on for the operator —
that one-line change is the actual go-live and Kunal's call to make.
