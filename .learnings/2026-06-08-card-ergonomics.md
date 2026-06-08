# 2026-06-08 — Card ergonomics batch (keyboard, swipe, responsive, PWA)

## What
Delivered the intent of Kunal's "mobile app + Tinder swipe" on the existing web
app: one card, act fast, next. Frontend-only, 3-dependency rule intact
(next/react/react-dom; native KeyboardEvent/TouchEvent only, no libs).

## Changes per file
- **components/SideKick.jsx:**
  - A. `topCardRef` (lifted in the render IIFE) + a window `keydown` effect
    attached once: Enter/D = Done, S = Skip on the CURRENT top card. Guards:
    skip when activeElement is INPUT/TEXTAREA/SELECT/contenteditable, when
    chatBusy or emailDraft modal open, never preventDefault on Ctrl/Cmd/Alt.
    1/2/3 angle-pick handled inside LinkedInCommentCard's own keydown effect
    (it's the focused card while mounted; reads latest `angles` via dep).
  - B. New `SwipeCard` wrapper around the focused top card. Native touch only.
    Right→Done, Left→Skip. Threshold 80px, horizontal must beat vertical by
    1.4x (else abandon → page scrolls). Ignores gestures starting on
    button/a/textarea/input/.li-angle-chip. Snap-back under threshold,
    fly-out + fire action over it.
  - Desktop-only `card-kbd-hint` footer on both cards.
- **app/globals.css:** card-kbd-hint (hidden on coarse pointers), swipe-card/
  swipe-hint styles, additive `@media (max-width:430px)` block (header wraps,
  card/batch/queue padding scales, angle chips fill width, chat input full).
  Desktop untouched.
- **app/layout.jsx:** manifest link + theme-color + apple-touch metas; metadata
  manifest + appleWebApp; `viewport.themeColor`.
- **public/manifest.json + public/icon.svg (NEW):** standalone PWA, theme
  #7B9FE8 / bg #E4E0DA (palette vars), one maskable SVG icon. NO service worker.

## Verification
`npx next build` clean, 19 routes, 3 deps unchanged. Not verified on a real
device (prod-only keys); swipe/keyboard logic is pure client JS.

## Prevention
- Stale-closure fix: top card lives in `topCardRef`, refreshed during render;
  the once-attached keydown handler always reads current. Don't capture topCard
  in the effect's deps — it's resolved in the render IIFE, not in scope.
- Swipe scroll-guard: `touch-action: pan-y` + dominance check + only
  preventDefault once horizontal is locked, so vertical scroll never breaks.
- NO service worker on purpose — a SW cache serves stale data on this live feed.

## Review fixes (post-review, before deploy)
Reviewer (CHANGES REQUIRED) caught 2 keyboard-path bugs, both fixed:
1. topCardRef not cleared when the feed empties -> shortcut could fire Done/Skip on a removed card. Fix: clear ref on the allCards===0 early return + a new effect clearing it when cards & topCallable are both empty (covers the IIFE-not-entered path).
2. keydown Done/Skip missing the `leaving` re-entry guard the buttons have -> double-fire on key-repeat. Fix: leavingRef mirrors `leaving` each render; handler bails if leavingRef.current.has(top.id).
Build clean after fixes. Swipe path was already correct (reads cardId from props, remounts via key).
