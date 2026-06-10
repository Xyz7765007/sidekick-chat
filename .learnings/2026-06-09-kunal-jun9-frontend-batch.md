# 2026-06-09 — Kunal Jun9 frontend batch (items 8/9/10/13/14/16)

## What
6 UX fixes from the Jun9 Kunal call on the LinkedIn-comment + manual-assist flow.

## Root
- #9 Angles "made no sense": both comment routes ran on Haiku (SUMMARY_MODEL),
  weak prompt, post text capped at 2000, hints hidden in tooltips.
- #10 Regenerate re-showed the same 3 angles (cache never cleared, no avoid list,
  same temperature).
- #13 Bottom widgets (toast bottom:90px, fb-dock bottom:12px) collided over the
  sticky chat input.
- #14 Card title identity inconsistent — each card hardcoded its own type chip.
- #16 Full post only reachable by leaving the app (link to LinkedIn).
- #8 Manual DM copybox lacked the comment flow's copy header + standalone copy.

## Fix
- **#9** New `COMMENT_MODEL` env (default claude-sonnet-4-6) on comment-angles +
  generate-comment; summarize stays Haiku. Hardened angle prompt (3 distinct
  lenses: add-value / contrarian / advancing-question, banned praise, must cite
  post specifics). POST_TEXT_CAP 2000->4000, max_tokens 600->900. Angle hints now
  render inline under each chip (li-angle-hint), not just tooltips.
- **#10** `fetchCommentAngles(card,{regenerate})` clears the cached angles, sends
  the rejected set as `avoidAngles`, runs temp 1.0 (vs 0.7). New "↻ New angles"
  button. Comment regenerate sends `regenerate:true` -> temp 0.9 (vs 0.6).
- **#13** Toast -> bottom 132px, z-70, max-width pill, opacity fade; fb-dock ->
  bottom 84px (above chat input); docked popover bottom 64->140. No more overlap.
- **#14** New module helper `getConnector(card)` (task_type -> source/task_rule
  fallback): 🔗 LinkedIn Posts / 🔁 Movement / ⭐ Top Leads / 🌐 Site Visits /
  📰 News / 💼 Job Posts. Used by both `Card` and `LinkedInCommentCard` headers;
  chip enlarged to read as the title line. Lead name/company unchanged below.
- **#16** New `stripInternalSignal()` scrubs 📊/📋/score lines from
  `formatSignalText(card.signal)`; inline "↓ Read full post here" toggle shows the
  whole post in-app (li-fullpost), LinkedIn link kept as secondary "↗ Open".
- **#8** ManualAssistCard connection+DM blocks got the comment-flow copy header
  (label + char count) + a standalone "⧉ Copy" button alongside "↗ Copy & open".

## Prevention
- The LinkedIn `signal` mixes PUBLIC post text with INTERNAL scoring markers —
  any in-app render of it MUST run `stripInternalSignal` (don't show raw signal).
- New bottom-fixed overlays: pick a `bottom` that clears chat input (z<70) and
  the fb-dock band; toast is the topmost (z-70).
- `npx next build` -> exit 0, ✓ Compiled, 25 routes, 3-dep rule intact.
- NOT verified: model behavior (no local keys) — angle quality/regen variance
  must be confirmed on the deployed URL.
