# 2026-06-25 — Finalized one-card UI spec (for the future main-app port)

Kunal's 24 Jun "Feedback Standup" finalized the app's UI direction. It was
designed + iterated in a **separate mockup surface, NOT this repo's live app**
(per Samarth — work the mockup, not the live UI). When we decide to bring it
into `components/SideKick.jsx`, start from the locked spec, don't re-derive.

## Where the spec + mockup live (in the My OS repo, not this repo)
- **Locked spec:** `My OS/Side Kick/sidekick-ui-mockups-demo/FINALIZED-CARD-SPEC.md`
- **Live mockup:** https://sidekick-ui-mockups-demo.vercel.app
- **Mockup source:** `My OS/Side Kick/sidekick-ui-mockups/index.html`

## The locked design (essentials — full detail in the spec)
- One-card single-focus queue; progress dots (no "N queued" box).
- **Sticky footer = ONLY the feedback input + the CTAs.** The feedback message
  thread appends into the *scrolling* content, never sticky, never overlays.
- Warm-signal-led order: DM reply → connection-accepted ("DM window") → comment
  → connections-review → DMs-sent digest (collapsed by default).
- Manual-first, never auto-send: Copy + Open on LinkedIn everywhere.
- Orange only on the main CTA. Skip → reason chips (Not relevant / Too complex /
  Wrong audience / Already engaged). Undo toast on Mark-as-done.
- Create-a-post hooks engine: optional + signal-seeded hooks → record/type →
  "in your voice" (humanizer) → editable post + live char count → copy & open
  LinkedIn (manual). The transcribe + generate-in-voice is the new build.
- Removed: the 4-flow comparison harness and "Ask about this task".

## Implementation notes when porting here
- Maps to existing backend: warm cards = `unipile_*` task types (already
  captured); comment cards = `linkedin_engagement`; connection date is on the
  `unipile_connection_accepted` signal. See Batch 02 in the feedback-ledger.
- Keep: less-is-more (§0), public/internal split (rule #6), proxy discipline,
  3-dependency rule, FEATURES-flag reversibility, Enter `preventDefault`+`stopPropagation`.
- The post-creation hooks engine is the only genuinely new backend work.
