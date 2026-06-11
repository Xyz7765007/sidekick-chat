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
