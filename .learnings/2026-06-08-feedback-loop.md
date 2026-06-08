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
