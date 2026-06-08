# 2026-06-08 — Closed feedback loop (frontend)

## What
Replaced the dead-end "feedback" prefill-chat button with a Claude-style
highlight-a-span → capture that stores feedback (via SignalScope) and feeds it
back into comment generation same-session. 3-dep rule intact (native DOM only).

## Changes (sidekick-chat)
- NEW `POST /api/feedback` → SignalScope `/api/sidekick/feedback`; injects
  `baseId: VELOKA_BASE_ID` + Bearer server-side (CLAUDE.md §13 proxy pattern).
- NEW `GET /api/preferences` → `/api/sidekick/preferences`; forwards item_type +
  limit, injects baseId + Bearer.
- SideKick.jsx: `FeedbackCapture` wrapper — on selection shows a floating 💬
  Feedback pill near the rect; click → popover (read-only span + note textarea +
  Submit/Cancel) → POST /api/feedback → toast. Wraps the comment textarea
  (`comment`), batch connection note (`connection_note`), DM1/2/3 (`dm`).
  `commentPrefsRef` session cache + `refreshCommentPrefs()` (item_type=comment,
  limit 15), passed as `feedback` into comment-angles + generate-comment;
  re-fetched after a comment-feedback submit. Old `handleItemFeedback` REMOVED.
- comment-angles + generate-comment: accept `feedback:[{quoted_span,
  feedback_text}]`, inject a bounded (~1500 char) OPERATOR FEEDBACK block.

## Textarea vs rendered text (the gotcha)
`window.getSelection()` does NOT return text inside a `<textarea>`.
FeedbackCapture branches on `e.target.tagName`: TEXTAREA/INPUT → read
selectionStart/selectionEnd, slice value, position pill from the field rect;
rendered text → getSelection() + range getBoundingClientRect(). Pill/popover are
`position:fixed` (viewport coords). A click-guard on the batch field (bail if
selection not collapsed) stops edit-click from unmounting an active selection.

## Build / prevention
`npx next build` → ✓ Compiled, all routes (feedback/preferences/generate-comment/
comment-angles). 3 deps unchanged. Env build occasionally throws a transient
post-compile manifest ENOENT; clean `.next` + single run (no concurrent build) is
green. Don't re-add a chat-prefill feedback path — no generator reads chat as
prefs; the real loop is /api/feedback → preferences → prompt block.

## Review fixes (2026-06-08)
- Listener fan-out (FeedbackCapture): auto-batch mounts ~20 instances, each
  attaching 4 document listeners; every selectionchange ran ~20 callbacks on the
  mobile hot path. Moved the transient events (mouseup/keyup/touchend) from
  `document` to the instance's own wrapper element (wrapRef) — a selection that
  matters starts inside the wrapper subtree, so the wrapper captures them just as
  well, but only that instance's handler fires. `selectionchange` MUST stay
  document-level (doesn't bubble, only event mobile fires); it's debounced ~150ms
  and `captureSelection` cheaply no-ops for non-matching instances via the
  `root.contains(...)` scope checks first. No behavior change: textarea
  selectionStart/End, rendered getSelection path, the 101cd7b mobile-selection
  fix, pill positioning, and the (separate, still document-level) outside-click
  dismiss are all untouched.
- Toast nit: `handleFeedbackSubmitted` now takes a `meta` arg; `submit()` forwards
  `needsSetup` from the proxy (which passes upstream 412 status + body). On
  needsSetup → "Feedback store not set up yet — ping admin" instead of the
  generic "couldn't save".
- 3-dep rule intact; `npx next build` → exit 0.

## Highlight UX fix (2026-06-08)
User reported "it didn't work" on a REAL mouse drag. Three root causes, all fixed
in `components/SideKick.jsx` (+ `app/globals.css`):
- **Pill landed far from the selection.** The textarea path positioned the pill
  from the field's bounding rect (`r.left+…`, `r.top-8`). On a tall textarea low
  on the page the pill rendered near the field edge / action buttons, not the
  highlighted text — users never connected it to their drag. FIX: capture the
  pointer-release coords. New `lastPointRef` stamped on mouseup (`e.clientX/Y`) and
  touchend (`e.changedTouches[0].clientX/Y`) with a `ts`. `captureSelection` now
  anchors the pill at `clampPoint(pt.x, pt.y - 40)` for BOTH the textarea path and
  the rendered-text path, so the pill appears just above the drag end. Fallbacks:
  no pointer (mobile `selectionchange`) → textarea falls back to field TOP, rendered
  text to the range rect. Trailing `selectionchange` after a drag is debounced
  150ms and only nulls `lastPointRef` if it's STALE (>600ms) — a fresh pointer
  anchor isn't clobbered back to the rect. New `clampPoint` keeps x/y in-viewport
  (≥60px l/r, y ≤ vh-96 to clear the sticky chat input). Pill keeps its
  `onMouseDown preventDefault` so the same mouseup that created it can't dismiss it.
- **Coverage too narrow.** Only the generated-comment textarea + batch fields were
  wrapped. The most natural-to-highlight text — the LinkedInCommentCard AI summary
  line + bullet points — was bare. FIX: wrapped the `{postSummary}` + `li-post-bullets`
  block in `<FeedbackCapture itemType="comment">` (reusing the whitelisted "comment"
  item_type — no backend change). Batch fields already wrapped (connection_note /
  dm) and inherit the positioning fix centrally; click-to-edit guard (bail if
  selection non-collapsed) untouched.
- **Hint not everywhere.** Added a low-noise `💬 highlight to give feedback` hint
  (`.li-post-fbhint`, `user-select:none`) under the summary/bullets, matching the
  batch `batch-msg-fbhint`. Comment textarea hint already present.
- Surfaces now wrapped + item_type: summary+bullets → `comment`, comment textarea
  → `comment`, batch connection note → `connection_note`, batch DM1/2/3 → `dm`.
- 3-dep rule intact (native pointer/DOM only); `npx next build` → ✓ Compiled,
  clean (the transient post-compile manifest ENOENT cleared on a fresh `.next` run,
  as previously documented).
