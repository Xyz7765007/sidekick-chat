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

## Go-live + UX pass (same day)
Turned ON (`FEATURES.postCreate: true`) after a UX tightening to Kunal's
less-is-more bar:
- Hooks render ONLY during selection, then collapse to a single gray chosen-hook
  recap (mockup parity — one thing in focus) with a quiet "change hook" link.
- The agent chat renders only once a post exists (no premature surface).
- "← edit what you said" quiet link back to compose.
Verified live with a headless Chrome click-through (puppeteer-core in scratch,
no repo dep). Commit `7bbaf58`.

## CORRECTION — rebuilt to the mockup's flow (same day, commit `58a1a13`)
Samarth: "cross refer the mockup, the flow is so smooth … the current flow is
messed up." My single accumulating-scroll card (hooks → compose → post stacked
in one scroll, fixed Mark-done/Skip/Regenerate footer, gray accents) was a
reinterpretation, NOT the approved mockup. **Lesson: for the create-post card,
port `sidekick-ui-mockups-demo/index.html` `screenCreatePost()` faithfully — do
not reinterpret.**
Rebuilt `PostCreatorCard` as the mockup's STAGE MACHINE — one focused screen at
a time, each replacing the card with a card-enter animation:
- **pick** — badge "Create · LinkedIn post", title "What do you want to post
  about?", "Suggested from your signals" + 3 tagged hooks, "↻ show me different
  hooks", "Skip — just let me record →". No footer.
- **record** — orange "Your hook" recap, big 84px tactile mic (pulses red when
  live), "Tap and just talk…", "prefer typing? write it out instead" (→ textarea
  + "Shape it into a post →"). Footer: "← back to hooks".
- **generating** — hook recap + italic transcript + "Writing it in your voice…".
- **post** — "Step 3 · your post — edit anything", "✓ Written in your voice"
  chip, orange-bordered editable post + char count. Footer: refine input
  ("Tweak it — shorter, punchier, add a stat…") + "Copy & open LinkedIn ↗"
  (primary) + "Try another hook".
**Orange is RESTORED to match the mockup** (hook recap, mic, post border,
primary CTA) — the earlier gray treatment + the generic Mark-done/Skip/Regen
footer were dropped for the create-post card. Real hooks/voice(Web Speech)/
generate/refine wired under it. Re-verified live headless: pick(title+group+3
tags+regen+skiprec, no footer) → record(orange hook, 84x84 mic, type link, back-
to-hooks) → type → generating → post(1014 chars, human chip, orange post border,
refine input, "Copy & open LinkedIn ↗" + "Try another hook", primary orange).
