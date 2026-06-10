# 2026-06-09 — Kunal item 7: capture the operator's OWN comment as feedback

## What
Kunal (Jun 9 feedback call): "Kunal chose to ignore the three comments… posted a
fourth version which was not suggested to him. So that is Kunal giving feedback…
pick up the tonality from what I am posting." Two asks:
- (7a) a way to post a comment *here itself* even when none of the 3 angles fit;
- (7b) treat the comment the operator actually posts as a training signal.

## Root
The comment editor (`li-comment-block`) only rendered after the operator picked
an angle and `/api/generate-comment` returned. If he ignored all 3 angles there
was NO in-app box to write his own. And the closed feedback loop only captured
*highlight-to-feedback* notes — never the final comment the operator committed.

## Fix (frontend-only, additive — `components/SideKick.jsx` + `globals.css`)
- **7a `writeMyOwn()`** — new "✍ Write my own" button in the angles header
  (beside "↻ New angles"). Sets `chosenAngleId="custom"` + `commentStatus="ready"`
  + empty `comment`, so the existing editable textarea renders with no generation
  call. The "↻ Regenerate" button is hidden in custom mode (no angle to regen).
- **7b `captureCommentExemplar(text)`** — on `commentOnLinkedIn()` (the commit
  moment: copy + open post), POST the final comment to the EXISTING `/api/feedback`
  proxy as `item_type:"comment"`, `feedback_text:"Operator posted this comment
  himself — match this voice/approach…: \"<comment>\""`. It flows into the same
  `Sidekick Feedback` table and the last ~15 `comment` notes already inject into
  both `/api/comment-angles` and `/api/generate-comment` (buildFeedbackBlock) —
  so the operator's real voice + tonality trains future suggestions. Deduped via
  `exemplarSavedRef` (re-clicking same text won't re-post); ignores <8-char text.

## Guardrail
- NO Unipile auto-post. Kunal mused about posting directly via Unipile; that's a
  real outbound side-effect on the declined/needs-spec list. "Comment on LinkedIn"
  stays copy-to-clipboard + open-post (same as the connection-note flow).
- No backend change, no new deps (native fetch). Reuses the existing feedback
  contract + injection — zero new surface area on SignalScope.

## Build
`./node_modules/.bin/next build` → exit 0.
NOT verifiable locally: generation actually biasing toward the captured exemplar
(no local Anthropic key) — confirm on the deployed URL.
