# 2026-06-11 — Biscuit-style UI redesign

## What changed
Full visual redesign to the "Biscuit" reference (warm paper bg #F5F3EE, white
bordered cards, single orange accent #E07B3A, Outfit + DM Serif Display,
springy enter/exit motion, dark toast pill). globals.css rewritten from
scratch; every existing class name kept so component logic was untouched.

UX moves:
- Chat moved out of the main column into a floating launcher (bottom-right)
  + slide-up panel (bottom sheet on mobile). Focusing a lead auto-opens it.
  Card hotkeys are suppressed while the panel is open (chatOpenRef guard).
- Header now shows Biscuit-style session progress dots (sessionDone state,
  proportional mapping past 10 dots) instead of a raw pending counter.
- "Accepted on LinkedIn?" (nextAction.type === "accept") boxes hidden —
  Unipile flags acceptance automatically. Filtered in the queue render AND
  null-returned in ManualAssistCard. mark-connected proxy stays wired.
- "Email engine in development" WIP banner and the email modal's "V2
  coming" note removed.
- Keyboard hints now render as key caps (.kb-key).

## Round 2 (same day): true one-at-a-time UX
Samarth's follow-up: round 1 only reskinned — batch row + follow-ups still
stacked around the focused card. Now there is ONE unified queue:
- The daily batch is a queue STEP (first, as the daily ritual) rendered
  full-card when focused, with "Later →" deferring it to the back of the
  session queue (deferStep / `deferred` state; key "batch" | card.id).
- LinkedIn follow-ups (ma-queue) are NOT rendered at all for now —
  Unipile drives that state; outreach handlers + proxies stay wired.
- The stage (.task-stack) is flex-centered with min-height ≈ viewport so
  a short card sits centered like Biscuit; tall cards scroll naturally.
- Header dots + queue-indicator count the batch step too.
- topCardRef is null while the batch step is focused, so D/S/Enter and
  swipe can never act on a hidden task card.
- DailyBatchCard lost its collapsed/compact mode; sendMode resets to
  "manual" on remount after a defer (safe default, accepted).

## Gotchas for next time
- Old CSS vars (--t1/--t2/--acc/--neu-*) are kept as aliases in :root —
  JSX has inline `var(--t2)` usages; don't delete the alias block.
- HeaderQueue must receive `loading || !!fetchError`, otherwise a feed
  error renders a false "All done ✓".
- Local build on this Windows machine: node_modules\.bin\next.cmd is
  missing — run `node node_modules\next\dist\bin\next build` with the
  portable Node 20 from My OS/.tools.
- No SignalScope keys locally → cards can't render locally; visual QA of
  card internals must happen against the live URL.

## Prevention
Class-name inventory before a CSS rewrite (regex over className=) is the
cheap way to guarantee nothing loses styling.
