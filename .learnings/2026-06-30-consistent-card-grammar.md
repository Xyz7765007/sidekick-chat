# Consistent card grammar — sticky footer (text box + CTAs) on every card

## Feedback (Kunal, 2026-06-30 call, verbatim)
"I want the bottom to stay the same." · "this has to be the same every time." ·
"the bottom not changing" · "One primary call to action. One secondary optional.
Third optional." · "Talk to your agent about this task... should be there across
the board... it'll fit for this and fit for everything." · "Same flow for
connection and same flow for DMs." → Every card type must share ONE grammar:
a scroll area + a sticky footer holding the SAME two things — the ask/feedback
TEXT BOX + the CTAs. The conversation thread appends into the scroll, not the footer.

## What shipped (LinkedInCommentCard)
Refactored to match the post-creation card's chrome:
- `.sk-card` (flex column, max-height, overflow hidden) > `.card-scroll` (content +
  `.fb-thread`) + sticky `.card-foot`.
- Footer = `.fbrow` (the "Ask about this task, or give feedback…" input + send,
  relocated from the old inline `PostChat`) + `.actions` (✓ Mark Done orange
  primary · ↗ Open on LinkedIn · Skip).
- The ask thread (`.fb-bub`) appends into `.card-scroll .fb-thread`. Backed by the
  same `/api/post-chat` + `/api/feedback` capture as before — just relocated.
- Removed redundant body-level "Open on LinkedIn" links (stripped + summary
  branches) — Open lives only in the footer now (kunal redundancy gate).
- Shared chrome CSS added once: `.sk-card`, `.card-scroll`, `.card-foot`, `.fbrow`,
  `.fbrow-input`, `.fb-send`, `.fb-thread`, `.fb-bub`, `.actions`, `.btn-secondary`,
  `.btn-ghost`. `.sk-card .card-foot` styling == `.pc-foot` (same `#F0EDE6` etc.)
  so the comment card and post card footers read identically.

## kunal agent
HARD GATE #7 (consistent sticky-footer grammar) — review of this change: PASS on
the grammar, plus one redundancy fix applied (summary-mode Open removed). Model
re-grounded in the verbatim Jun-30 quotes (the Jun-30 call was missing from its
corpus — that's why it had missed this detail).

## Still to do / flagged
- Generic `Card` (unipile/other task types) NOT yet converted — same pattern
  (its actions sit mid-card @ ~line 2900 + inline PostChat). Not currently visible
  in the live feed (no unipile tasks), so lower priority, but needed for full
  "all cards" consistency.
- The comment-assist block's `↗ Comment on LinkedIn` button (gated off,
  `FEATURES.commentAssist`) copies+opens — functionally distinct from the footer
  Open. Left in place (off in live config); flagged to Samarth.

## Verified (headless, live)
`.sk-card .card-scroll` present; sticky `.card-foot` with input placeholder "Ask
about this task, or give feedback…"; CTAs [✓ Mark Done, ↗ Open on LinkedIn, Skip];
footer bg rgb(240,237,230); 0 body Open links; typing in the footer box appends a
reply bubble into the scroll thread. Commit `421e901`.
