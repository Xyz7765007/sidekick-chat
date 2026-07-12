"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { FEATURES } from "../lib/features";

// ═══════════════════════════════════════════════════════════════════
// SIDE KICK — Main chatbot UI
//
// Chat flow:
//   - On mount: load chat history from Airtable (last 20 messages)
//   - User types: append to UI, POST to /api/chat with history + count
//   - /api/chat: calls Claude (Haiku 4.5) for intent + reply
//   - If Claude decides an action (scan/refresh), backend executes it
//   - Bot reply (with execution result merged) returned + saved to Airtable
//   - UI appends bot bubble + refreshes feed if action says so
//
// Task feed: polls /api/feed every 30s, renders cards with CTAs.
// All chat persistence + dynamic memory lives in Sidekick Chat table.
// ═══════════════════════════════════════════════════════════════════

const POLL_INTERVAL_MS = 30000;
const FEED_LIMIT = 20;
const HISTORY_LIMIT = 30;

// ─────────────────────────────────────────────────────────────────────
// Clipboard helper — navigator.clipboard with a textarea fallback for
// older browsers / non-secure contexts. Extracted to module scope so the
// LinkedIn comment flow and the email draft modal share one impl.
// ─────────────────────────────────────────────────────────────────────
function copyToClipboard(text, done) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => done?.()).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    done?.();
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════
// FEEDBACK CAPTURE (highlight-to-feedback — Claude-style select-to-reply)
//
// Wraps any block of generated copy. When the operator highlights text
// inside it, a small floating "💬 Feedback" pill appears near the
// selection. Click → popover with the quoted span (read-only) + a note
// textarea + Submit/Cancel. Submit POSTs /api/feedback. This is the REAL
// capture→store path that replaces the old dead-end (prefill-chat) flow.
//
// Selection extraction (native DOM only, no deps):
//   - <textarea/input>: window.getSelection() does NOT see text inside these.
//     We read selectionStart/selectionEnd off document.activeElement (scoped to
//     this wrapper) and slice its value. Pill is positioned from the field's
//     bounding rect (caret coords aren't reliable cross-browser).
//   - rendered (non-textarea) text: window.getSelection() +
//     getRangeAt(0).getBoundingClientRect() to position the pill.
//
// Events (desktop AND touch): mobile text selection does NOT fire mouseup/keyup,
// and onSelect on a div is unreliable, so we listen at the DOCUMENT level for
// `selectionchange` (debounced ~150ms) — the only event mobile fires — plus
// mouseup/keyup/touchend for snappy desktop. The selected span is STORED IN
// STATE the moment it's detected, so the affordance survives the selection
// being collapsed when the operator taps the control (a touch quirk).
//
// Affordance: floating pill at the selection rect on desktop; a fixed docked
// bar (bottom-center) on coarse-pointer / narrow viewports so the OS's native
// selection toolbar (Copy/Share) can't cover it. Both open the same popover.
//
// Props:
//   itemType      "comment" | "connection_note" | "dm"  (required)
//   leadName, leadCompany   for the stored record (optional)
//   onSubmitted   (item_type) => void   — fires after a successful save
//                 (parent shows a toast + refreshes comment prefs)
// ═══════════════════════════════════════════════════════════════════
function FeedbackCapture({ itemType, leadName, leadCompany, onSubmitted, children }) {
  const wrapRef = useRef(null);
  const pillRef = useRef(null);   // the floating pill button (desktop)
  const dockRef = useRef(null);   // the docked bar button (mobile)
  const popRef = useRef(null);    // the feedback popover (portaled to body)
  // Pointer coords (clientX/clientY) from the LAST mouseup/touchend that ended
  // a drag inside this wrapper. The pill anchors here so it appears right where
  // the operator released the drag — not at the field's bounding-box edge (the
  // old bug: a tall textarea low on the page positioned the pill near the action
  // buttons, far from the highlighted text). Cleared after each capture so a
  // selectionchange-only path (mobile) falls back to rect math.
  const lastPointRef = useRef(null);
  // pill = { x, y, span } in viewport coords; popover open state separate.
  // `span` is stored as soon as a selection is detected, so the affordance no
  // longer depends on the selection still being alive when the operator taps
  // it (on touch, tapping the control collapses the native selection first).
  const [pill, setPill] = useState(null);
  const [open, setOpen] = useState(false);
  const [span, setSpan] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  // SSR/hydration guard for the body portal. The floating pill/dock/popover are
  // `position:fixed` with VIEWPORT coords, but FeedbackCapture renders inside the
  // card tree, which has TRANSFORMED ancestors (.card-stack / .li-comment-card
  // entering animation, .swipe-card translateX). A transformed ancestor becomes
  // the containing block for fixed descendants, so the pill would anchor to the
  // CARD, not the viewport (the ~+304/+186px offset bug). Portaling the overlays
  // to document.body escapes those transforms so `position:fixed` is genuinely
  // viewport-relative. Only portal on the client — `document` is undefined in SSR.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Coarse pointer / narrow viewport → dock the control as a fixed bottom bar
  // so the OS's native selection toolbar (Copy/Share) can't cover it. Desktop
  // keeps the floating pill at the selection rect. Computed on mount + resize.
  const [docked, setDocked] = useState(false);
  useEffect(() => {
    function compute() {
      let coarse = false;
      try { coarse = !!window.matchMedia && window.matchMedia("(pointer: coarse)").matches; } catch {}
      setDocked(coarse || window.innerWidth <= 640);
    }
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, []);

  // Read the current selection inside this wrapper and (if non-empty) store the
  // span + (for desktop) the pill coords. Handles both textarea/input and
  // rendered text. Works without an event (selectionchange has no useful
  // target), reading document.activeElement for the field path.
  // Clamp a pill anchor to the viewport so the pill never renders off-screen or
  // under the sticky chat input. The pill is drawn with translate(-50%,-100%):
  // it sits ABOVE (x,y) centred on x — so keep a margin on every side.
  const clampPoint = useCallback((x, y) => {
    const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
    const vh = typeof window !== "undefined" ? window.innerHeight : 768;
    const cx = Math.max(60, Math.min(x, vw - 60));      // half-pill margin l/r
    const cy = Math.max(40, Math.min(y, vh - 96));      // clear sticky chat input
    return { x: cx, y: cy };
  }, []);

  const captureSelection = useCallback(() => {
    if (open) return; // don't move the pill while the popover is up
    const root = wrapRef.current;
    if (!root) return;

    // Prefer the actual pointer-release coords (where the drag ended) so the
    // pill appears next to the highlighted text. `y - 40` lifts it just above
    // the pointer. Fall back to rect math when there's no pointer (e.g. a
    // selectionchange-driven capture on mobile).
    const pt = lastPointRef.current;

    // ── textarea / input path ── (window.getSelection can't see inside these)
    const ae = document.activeElement;
    if (ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT") && root.contains(ae)) {
      const start = ae.selectionStart;
      const end = ae.selectionEnd;
      if (typeof start === "number" && typeof end === "number" && end > start) {
        const selected = String(ae.value).slice(start, end).trim();
        if (selected) {
          let x, y;
          if (pt) {
            ({ x, y } = clampPoint(pt.x, pt.y - 40));
          } else {
            // No pointer (mobile selectionchange): fall back to near the field
            // TOP (not the centre of a tall field), where text starts.
            const r = ae.getBoundingClientRect();
            ({ x, y } = clampPoint(r.left + Math.min(r.width / 2, 120), r.top - 8));
          }
          setPill({ x, y, span: selected });
          return;
        }
      }
      // active field but nothing selected — fall through to rendered-text check
    }

    // ── rendered (non-textarea) text path ──
    const sel = window.getSelection ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || !sel.rangeCount) { setPill(null); return; }
    const text = sel.toString().trim();
    if (!text) { setPill(null); return; }
    // Only react if the selection is inside this wrapper.
    const anchor = sel.anchorNode;
    if (anchor && !root.contains(anchor)) { setPill(null); return; }
    let x, y;
    if (pt) {
      ({ x, y } = clampPoint(pt.x, pt.y - 40));
    } else {
      let rect;
      try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch { rect = null; }
      ({ x, y } = clampPoint(
        rect ? rect.left + Math.min(rect.width / 2, 120) : 40,
        rect ? rect.top - 8 : 40
      ));
    }
    setPill({ x, y, span: text });
  }, [open, clampPoint]);

  // Wire selection detection. PERF (listener fan-out fix): the auto-batch view
  // mounts ~20 FeedbackCapture instances, so every document-level listener runs
  // its callback ~20× per event on the mobile hot path. To cut that churn
  // WITHOUT changing behavior:
  //   - mouseup/keyup/touchend (the snappy desktop + touch-end-drag paths) are
  //     scoped to THIS wrapper element (wrapRef), not document. A selection that
  //     matters to this instance starts inside its own subtree, so the wrapper
  //     captures these just as well — but only this instance's handler fires.
  //   - `selectionchange` MUST stay document-level (it doesn't bubble and is the
  //     only event mobile text selection reliably fires). It's debounced ~150ms,
  //     and captureSelection cheaply no-ops for non-matching instances via the
  //     `root.contains(...)` scope checks before doing any real work.
  useEffect(() => {
    let t = null;
    function onSelectionChange() {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        t = null;
        // A real drag's trailing selectionchange fires right after mouseup/
        // touchend stamped lastPointRef. Don't clobber a FRESH pointer anchor
        // (< 600ms old) — that would yank the pill from the drag end back to the
        // rect fallback. Only drop STALE coords so the genuine mobile/keyboard
        // selectionchange path (no recent pointer) uses rect math.
        const pt = lastPointRef.current;
        if (!pt || (Date.now() - pt.ts) > 600) lastPointRef.current = null;
        captureSelection();
      }, 150);
    }
    // Pointer-ending events carry the release coords — stash them so the pill
    // anchors at the drag end. keyup (keyboard selection) has no usable point.
    function onPointerEnd(e) {
      let cx, cy;
      if (e.type === "touchend") {
        const tch = e.changedTouches && e.changedTouches[0];
        if (tch) { cx = tch.clientX; cy = tch.clientY; }
      } else if (typeof e.clientX === "number") {
        cx = e.clientX; cy = e.clientY;
      }
      lastPointRef.current = (typeof cx === "number" && typeof cy === "number")
        ? { x: cx, y: cy, ts: Date.now() }
        : null;
      captureSelection();
    }
    function onKeyEnd() { lastPointRef.current = null; captureSelection(); }
    // mouseup/keyup/touchend are LOW-frequency (once per release/keypress), and
    // captureSelection cheaply no-ops for non-matching instances via root.contains.
    // Keep them document-level so a drag that STARTS in this wrapper but RELEASES
    // outside it (mouseup fires on another element) is still captured immediately
    // — the earlier wrapper-scoped version lost that snappiness. The genuinely
    // high-frequency event (selectionchange) is the one that's debounced.
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("mouseup", onPointerEnd);
    document.addEventListener("keyup", onKeyEnd);
    document.addEventListener("touchend", onPointerEnd);
    return () => {
      if (t) clearTimeout(t);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("mouseup", onPointerEnd);
      document.removeEventListener("keyup", onKeyEnd);
      document.removeEventListener("touchend", onPointerEnd);
    };
  }, [captureSelection]);

  // Dismiss the pill/popover on a press outside this wrapper AND outside the
  // control itself (the docked bar is fixed-positioned, so it isn't a DOM
  // descendant of the wrapper — must be excluded explicitly). Listen for both
  // mousedown (desktop) and touchstart (mobile).
  useEffect(() => {
    if (!pill && !open) return;
    function onDocDown(e) {
      const root = wrapRef.current;
      const inWrap = root && root.contains(e.target);
      const inPill = pillRef.current && pillRef.current.contains(e.target);
      const inDock = dockRef.current && dockRef.current.contains(e.target);
      // The popover is portaled to <body> (outside `root`), so clicks inside it
      // are NOT caught by inWrap. Without this guard, clicking into the popover's
      // textarea or Submit button dismisses the popover before you can use it.
      const inPop = popRef.current && popRef.current.contains(e.target);
      if (!inWrap && !inPill && !inDock && !inPop) { setOpen(false); setPill(null); }
    }
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("touchstart", onDocDown, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("touchstart", onDocDown);
    };
  }, [pill, open]);

  // When the native selection collapses (and the popover isn't open), drop the
  // stored affordance so a stale control doesn't linger after a tap-elsewhere.
  useEffect(() => {
    if (!pill || open) return;
    function onSelChange() {
      const ae = document.activeElement;
      const root = wrapRef.current;
      // A focused field inside the wrapper may keep its own selection — leave it.
      if (ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT") && root && root.contains(ae)) {
        if (ae.selectionEnd > ae.selectionStart) return;
      }
      const sel = window.getSelection ? window.getSelection() : null;
      if (!sel || sel.isCollapsed) setPill(null);
    }
    document.addEventListener("selectionchange", onSelChange);
    return () => document.removeEventListener("selectionchange", onSelChange);
  }, [pill, open]);

  function openPopover() {
    if (!pill?.span) return;
    setSpan(pill.span); // use the STORED span — selection may already be gone
    setNote("");
    setOpen(true);
  }
  function closePopover() {
    setOpen(false);
    setPill(null);
    setNote("");
  }

  async function submit() {
    const fb = note.trim();
    if (!fb) return;
    setSaving(true);
    try {
      const r = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_type: itemType,
          quoted_span: span,
          feedback_text: fb,
          lead_name: leadName,
          lead_company: leadCompany,
        }),
      });
      const d = await r.json().catch(() => ({}));
      setSaving(false);
      closePopover();
      // Forward needsSetup (412: feedback table not created upstream) so the
      // parent can show a specific "ping admin" toast instead of a generic one.
      onSubmitted?.(itemType, d?.ok !== false, { needsSetup: !!d?.needsSetup });
    } catch {
      setSaving(false);
      closePopover();
      onSubmitted?.(itemType, false, {});
    }
  }

  // Where the popover anchors: at the selection rect on desktop, centered just
  // above the docked bar on mobile (so it clears the native selection toolbar).
  const popStyle = docked
    ? { left: "50%", bottom: 140, top: "auto" } // above the lifted dock bar (item 13)
    : { left: pill?.x ?? 40, top: (pill?.y ?? 40) + 8 };

  // The floating pill / docked bar / popover are all `position:fixed` and must
  // be anchored to the VIEWPORT, not to a transformed card ancestor. They're
  // portaled to document.body to escape `.swipe-card` / `.card-stack` /
  // `.li-comment-card` transforms (see the `mounted` comment above). Refs work
  // through portals, so the outside-click dismiss (pillRef/dockRef `.contains`)
  // and the click-to-edit guard still function; only the DOM *position* changes,
  // not the React tree, so `onSubmitted`/state callbacks are unaffected.
  const overlays = (
    <>
      {/* Desktop: floating pill at the selection rect. */}
      {pill && !open && !docked && (
        <button
          type="button"
          ref={pillRef}
          className="fb-pill"
          style={{ left: pill.x, top: pill.y }}
          onMouseDown={(e) => e.preventDefault() /* keep the selection alive */}
          onClick={openPopover}
          title="Give feedback on the highlighted text"
        >
          💬 Feedback
        </button>
      )}

      {/* Mobile: fixed docked bar above the chat input — not covered by the
          OS selection toolbar, and tappable even after the selection clears
          (the span is already stored in state). */}
      {pill && !open && docked && (
        <div className="fb-dock" ref={dockRef}>
          <button
            type="button"
            className="fb-dock-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={openPopover}
            title="Give feedback on the highlighted text"
          >
            💬 Feedback on selection
          </button>
        </div>
      )}

      {open && (
        <div ref={popRef} className={`fb-pop${docked ? " fb-pop-docked" : ""}`} style={popStyle}>
          <div className="fb-pop-label">Feedback on:</div>
          <div className="fb-pop-span" title={span}>{span.slice(0, 280)}</div>
          <textarea
            className="fb-pop-note"
            placeholder="What should change? e.g. too formal, drop the question, shorter…"
            value={note}
            autoFocus
            rows={3}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); closePopover(); }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
            }}
          />
          <div className="fb-pop-row">
            <button type="button" className="btn" onClick={closePopover} disabled={saving}>Cancel</button>
            <button type="button" className="btn primary" onClick={submit} disabled={saving || !note.trim()}>
              {saving ? "Saving…" : "Submit"}
            </button>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div
      ref={wrapRef}
      className="fb-capture"
    >
      {children}

      {/* Overlays portal to <body> so fixed positioning is viewport-relative,
          not relative to a transformed card ancestor. The in-tree wrapper above
          (wrapRef) stays put — selection scoping (root.contains) depends on it. */}
      {mounted && typeof document !== "undefined" && createPortal(overlays, document.body)}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// RelevanceMenu — universal per-field relevance affordance (Kunal 2026-06-09)
// A quiet "⋯" dot next to a data point. Click → a small portaled popover with
// the ONE structured action that fits that field. Kept minimal: no
// always-visible buttons, one dot per field. For the score field, `mode="score"`
// renders an inline 0-100 input. The popover is `position:fixed` and MUST portal
// to <body> — the card stack has transformed ancestors (.swipe-card /
// .card-stack / .li-comment-card) that would otherwise re-base the fixed coords
// (see 2026-06-08 portal learnings).
// ─────────────────────────────────────────────────────────────────────
function RelevanceMenu({ label, actionLabel, mode = "action", scoreInitial, onConfirm, title }) {
  const dotRef = useRef(null);
  const popRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [scoreVal, setScoreVal] = useState(
    typeof scoreInitial === "number" ? String(scoreInitial) : ""
  );
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Dismiss on outside press — popRef is portaled to body (outside the dot's
  // tree), so it must be excluded explicitly alongside the dot itself.
  useEffect(() => {
    if (!open) return;
    function onDown(e) {
      const inDot = dotRef.current && dotRef.current.contains(e.target);
      const inPop = popRef.current && popRef.current.contains(e.target);
      if (!inDot && !inPop) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [open]);

  function toggle() {
    if (open) { setOpen(false); return; }
    const r = dotRef.current ? dotRef.current.getBoundingClientRect() : null;
    if (r) {
      const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
      const x = Math.max(140, Math.min(r.left, vw - 140));
      setPos({ x, y: r.bottom + 6 });
    }
    setScoreVal(typeof scoreInitial === "number" ? String(scoreInitial) : "");
    setOpen(true);
  }

  function confirmAction() {
    setOpen(false);
    if (mode === "score") {
      const n = parseInt(scoreVal, 10);
      if (Number.isNaN(n)) return;
      onConfirm(Math.max(0, Math.min(100, n)));
    } else {
      onConfirm();
    }
  }

  const overlay = open ? (
    <div
      ref={popRef}
      className="rel-pop"
      style={{ left: pos.x, top: pos.y }}
    >
      <div className="rel-pop-label">{label}</div>
      {mode === "score" ? (
        <div className="rel-pop-score-row">
          <input
            type="number"
            min={0}
            max={100}
            value={scoreVal}
            autoFocus
            className="rel-pop-score-input"
            placeholder="0–100"
            onChange={(e) => setScoreVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); confirmAction(); }
              if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
            }}
          />
          <button
            type="button"
            className="btn primary rel-pop-go"
            onClick={confirmAction}
            disabled={scoreVal.trim() === ""}
          >{actionLabel}</button>
        </div>
      ) : (
        <button type="button" className="rel-pop-action" onClick={confirmAction}>
          {actionLabel}
        </button>
      )}
    </div>
  ) : null;

  return (
    <span className="rel-menu">
      <button
        type="button"
        ref={dotRef}
        className={`rel-dot ${open ? "rel-dot-open" : ""}`}
        onClick={toggle}
        title={title || "Give relevance feedback"}
        aria-label={title || "Give relevance feedback"}
      >⋯</button>
      {mounted && typeof document !== "undefined" && overlay &&
        createPortal(overlay, document.body)}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Signal text formatter
// Server delivers the signal as one big paragraph with emoji markers
// inline (→, 📝, 💬, 🔍, 💡, 📊, 📋, •). Operators were getting walls of
// text. Insert a newline before each marker (except the very first) so
// the structure is visible. CSS `white-space: pre-wrap` on the rendering
// container then renders the newlines as real line breaks.
//
// Also strips trailing whitespace and stray separator chars (em dash etc.)
// that get left dangling before a newline.
// ─────────────────────────────────────────────────────────────────────
function formatSignalText(raw) {
  if (!raw || typeof raw !== "string") return raw;
  // Markers that each start a new line. Notes on the alternation:
  //   - `🔗` is a marker on its own. Card stack mode's signal can have
  //     `→ 🔗` together; lookahead on `→` prevents splitting them.
  //   - `→(?!\s*🔗)` matches `→` only when NOT followed by `🔗`, so the
  //     header arrow on movement cards ("→ ICP fit (80/100)") still acts
  //     as a section break for any subsequent → blocks in the same text.
  const markerPattern = /(🔗|📝|💬|🔍|💡|📊|📋|•|→(?!\s*🔗))/g;
  let firstSeen = false;
  let out = raw.replace(markerPattern, (match) => {
    if (!firstSeen) {
      firstSeen = true;
      return match;
    }
    return `\n${match}`;
  });
  // Strip trailing whitespace + stray separator chars (em dash, en dash,
  // hyphen) immediately before a newline — these get orphaned when we
  // break "X — 📊 Y" into "X —\n📊 Y".
  out = out.replace(/[\s—–-]+\n/g, "\n");
  return out;
}

// handledAgo — compact relative time for the Handled panel rows.
function handledAgo(iso) {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// getConnector — the card's TITLE IDENTITY (Kunal item 14): every card is
// titled by the CONNECTOR it came from, with an icon beside it, shown
// uniformly across every card type. Derived from task_type first (most
// reliable), then source/task_rule hints. Returns { icon, label, tone }.
// The lead name/company still render below as the card's subject.
function getConnector(card) {
  if (!card) return { icon: "•", label: "Task", tone: "default" };
  const byType = {
    linkedin_engagement:          { icon: "🔗", label: "LinkedIn Posts",        tone: "li" },
    lead_movement:                { icon: "🔁", label: "Movement",              tone: "movement" },
    top_x:                        { icon: "⭐", label: "Top Leads",             tone: "top" },
    engagement:                   { icon: "🌐", label: "Site Visits",           tone: "ga" },
    // Unipile DM / outreach-sequence signals (created by /api/unipile-triggers).
    unipile_message_reply:        { icon: "📬", label: "DM reply",              tone: "movement" },
    unipile_connection_accepted:  { icon: "🤝", label: "Connection accepted",   tone: "movement" },
    unipile_post_comment_on_yours:{ icon: "💬", label: "Commented on your post", tone: "li" },
    unipile_post_reaction_on_yours:{ icon: "👍", label: "Reacted to your post",  tone: "li" },
    unipile_message_reaction:     { icon: "😊", label: "Reacted to your DM",     tone: "movement" },
    unipile_profile_view:         { icon: "👀", label: "Viewed your profile",    tone: "ga" },
  };
  if (byType[card.task_type]) return byType[card.task_type];
  // Fallback: infer from source / task_rule text for less-common connectors.
  const hint = `${card.source || ""} ${card.task_rule || ""}`.toLowerCase();
  if (/news/.test(hint))                       return { icon: "📰", label: "News",          tone: "default" };
  if (/job|hiring/.test(hint))                 return { icon: "💼", label: "Job Posts",     tone: "default" };
  if (/linkedin|post/.test(hint))              return { icon: "🔗", label: "LinkedIn Posts", tone: "li" };
  if (/movement|hire|promot|exit/.test(hint))  return { icon: "🔁", label: "Movement",      tone: "movement" };
  return { icon: "•", label: card.source || "Task", tone: "default" };
}

// Session cache of company one-liner blurbs (keyed by lowercased company name),
// so /api/company-blurb fires at most once per company per session. Module-level
// so it survives re-renders and card re-polls. "" = fetched but no confident
// blurb (don't refetch).
const companyBlurbCache = new Map();

// companyHoverText — the title-tooltip on a connection row's company name.
// Real data only (from the Leads join in /api/sidekick/connections-sent):
// "<Company> · <N> employees". blurb (what the company does) is appended when
// present. Never fabricates — omits any part we don't have.
function companyHoverText(l) {
  if (!l) return undefined;
  // Show ONE employee figure — the exact count if we have it, else the band.
  // (The raw count and range fields sometimes disagree, so don't show both.)
  const emp = l.employees
    ? `${l.employees} employees`
    : (l.employee_range ? `${l.employee_range} employees` : "");
  const parts = [l.company, emp, l.blurb].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

// ─── Task-switcher tiles (Kunal Jun30, ported from the approved mock) ───
// A tile-per-task-family filter row. The tiles are DYNAMIC: a family tile only
// renders when the live feed actually contains a card of that family (Samarth:
// "only the relevant task blocks show; if more add, only then the block should
// be present"). "All" is always first + default; "Create post" is always last
// (it's a capability, not feed data). Icons are inline SVG so the 3-dependency
// rule holds — no icon library. They inherit currentColor, so the active
// accent-tint recolors them. `match(task_type)` decides which family a card is.
//
// task_type → family mapping mirrors getConnector's taxonomy:
//   linkedin_engagement            → comments  ("a post you comment on == a
//                                                comment", Kunal — label it
//                                                "LinkedIn comments")
//   unipile_post_comment_on_yours  → comments  (a comment on your post)
//   lead_movement / top_x / …      → their own families, surfaced only if present
const SWITCHER_FAMILIES = [
  {
    key: "comments",
    label: "LinkedIn comments",
    icon: '<path d="M20 12.4c0 3.7-3.36 6.6-7.5 6.6-.86 0-1.69-.12-2.46-.35L4.5 20.25l1.06-3.2A6.27 6.27 0 0 1 4.5 12.4C4.5 8.7 7.86 5.8 12 5.8s8 2.9 8 6.6Z"/>',
    match: (t) => t === "linkedin_engagement" || t === "unipile_post_comment_on_yours",
  },
  {
    key: "movement",
    label: "Movement",
    icon: '<path d="M4.5 9.5 8 6v2.5h9M19.5 14.5 16 18v-2.5H7"/>',
    match: (t) => t === "lead_movement",
  },
  {
    key: "top",
    label: "Top leads",
    icon: '<path d="m12 4.5 2.06 4.36 4.69.62-3.44 3.26.9 4.76L12 15.7l-4.21 2.06.9-4.76L5.25 9.7l4.69-.62L12 4.5Z"/>',
    match: (t) => t === "top_x",
  },
  {
    key: "visits",
    label: "Site visits",
    icon: '<circle cx="12" cy="12" r="7.5"/><path d="M4.5 12h15M12 4.5c2 2.3 3 4.9 3 7.5s-1 5.2-3 7.5c-2-2.3-3-4.9-3-7.5s1-5.2 3-7.5Z"/>',
    match: (t) => t === "engagement",
  },
  {
    key: "dms",
    label: "DMs & connections",
    icon: '<rect x="3.75" y="5.75" width="16.5" height="12.5" rx="3"/><path d="m4.5 7.5 7.5 5 7.5-5"/>',
    match: (t) =>
      t === "unipile_message_reply" ||
      t === "unipile_connection_accepted" ||
      t === "unipile_message_reaction" ||
      t === "unipile_post_reaction_on_yours" ||
      t === "unipile_profile_view",
  },
  {
    key: "news",
    label: "News",
    icon: '<path d="M5.25 5.5h10.5a1.25 1.25 0 0 1 1.25 1.25v10.5a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V5.5Z"/><path d="M17 9.5h1.5a1.25 1.25 0 0 1 1.25 1.25v6a1.25 1.25 0 0 1-2.5 0M7.75 9h6M7.75 12.25h6M7.75 15.5h3.5"/>',
    match: (t, card) => {
      if (["linkedin_engagement", "lead_movement", "top_x", "engagement"].includes(t)) return false;
      if ((t || "").startsWith("unipile_")) return false;
      const hint = `${(card && card.source) || ""} ${(card && card.task_rule) || ""}`.toLowerCase();
      return /news/.test(hint);
    },
  },
];
// The always-present, non-data-driven tiles.
const TILE_ALL = {
  key: "all",
  label: "All",
  icon: '<circle cx="6.25" cy="6.25" r="2.75"/><circle cx="17.75" cy="6.25" r="2.75"/><circle cx="6.25" cy="17.75" r="2.75"/><circle cx="17.75" cy="17.75" r="2.75"/>',
};
const TILE_CREATE = {
  key: "createpost",
  label: "Create post",
  icon: '<path d="M15.6 4.6 19.4 8.4 9 18.8l-4.2.8.8-4.2 10-10.8Z"/><path d="M14.2 6 18 9.8"/>',
};
// Connections-sent review tile (Kunal 07 Jul). Dynamic: only appears when the
// connections card is available (past24h >= 5), so tapping it always lands on a
// real card, never a dead-end. Paper-plane = "requests sent".
const TILE_CONNECTIONS = {
  key: "connections",
  label: "Connections",
  icon: '<path d="M21.5 3.5 2.8 10.3a.5.5 0 0 0 .05.95l6.35 2.05 2.05 6.35a.5.5 0 0 0 .95.05L21.5 3.5Z"/><path d="M21.5 3.5 9.2 13.3"/>',
};
// DMs-sent review tile (2026-07-09). Dynamic: only appears when the DMs card is
// available (past24h >= 1), so tapping it always lands on a real card. Speech
// bubble = "messages sent".
const TILE_DMS = {
  key: "dms",
  label: "DMs sent",
  icon: '<path d="M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4.5 19.5l1.3-4.2A7.5 7.5 0 1 1 20 11.5Z"/>',
};

// The 5 DM/connection Unipile task types (DM reply, connection accepted, DM
// reaction, post reaction on yours, profile view). Hidden from BOTH the queue
// and the switcher when FEATURES.dmsConnections is off (Kunal Jul01). NOTE:
// unipile_post_comment_on_yours is deliberately NOT here — it's a COMMENT and
// stays visible.
const DM_CONNECTION_TASK_TYPES = new Set([
  "unipile_message_reply",
  "unipile_connection_accepted",
  "unipile_message_reaction",
  "unipile_post_reaction_on_yours",
  "unipile_profile_view",
]);
// isDmConnectionCard — true iff this card is a hidden-while-flag-off DM/connection
// signal. The single predicate the queue AND the switcher both consult.
function isDmConnectionCard(card) {
  return DM_CONNECTION_TASK_TYPES.has(card && card.task_type);
}

// queueEligibleCards — the cards the queue can ACTUALLY render under the current
// FEATURES config with NO family filter applied (the "All" set). This is the
// SAME feature-strip the orderedQueue memo applies (see ~L1498): when otherCards
// is off the queue keeps ONLY Unipile signals + LinkedIn-comment tasks, so a tile
// must never be offered for a family (movement/top/GA/news) the queue can't show
// — tapping it would filter the stripped queue to empty and dead-end the operator
// into a FALSE "All clear" (ux: Nielsen #5 error-prevention / #1 system-status).
// When otherCards is on, every card is queue-eligible (tiles span all families).
// When dmsConnections is off, the 5 DM/connection Unipile signals are ALSO
// stripped here (in BOTH otherCards modes) so neither the queue nor a switcher
// tile can surface them (Kunal Jul01) — comments (unipile_post_comment_on_yours)
// stay.
function queueEligibleCards(cards) {
  // News signal tasks (task_type "news", Kunal Jul13) are ALWAYS eligible —
  // they ride alongside the comment queue even with otherCards off, without
  // un-hiding the other stripped families (movement/top_x/GA).
  let eligible = FEATURES.otherCards
    ? cards
    : cards.filter(
        (c) =>
          c.task_type === "linkedin_engagement" ||
          c.task_type === "news" ||
          (c.task_type || "").startsWith("unipile_")
      );
  if (!FEATURES.dmsConnections) {
    eligible = eligible.filter((c) => !isDmConnectionCard(c));
  }
  return eligible;
}
// deriveTiles — compute the visible tile set from the queue-eligible cards (NOT
// the raw feed). Non-comment families appear only with ≥1 renderable card
// (dynamic); the "LinkedIn comments" tile is PINNED (always shown) so it can be
// navigated to for an "All clear" even with 0 comment cards. All first; Create
// post last (a capability, only when the feature is on). For the current live
// feed (comment tasks only, otherCards off) this yields exactly:
// All · LinkedIn comments · Create post.
function deriveTiles(cards, includeCreate, hasConnections, hasDms) {
  const eligible = queueEligibleCards(cards);
  const present = SWITCHER_FAMILIES.filter((fam) =>
    // "LinkedIn comments" is the app's PRIMARY family — keep its tile in the
    // switcher even when 0 comment cards remain, so the operator can navigate to
    // it and land on an explicit "All clear" instead of the tile silently
    // vanishing (Samarth 2026-07-08: "it shouldn't go away, it should stay and
    // show as all clear when navigated to via the options"). Every other family
    // stays dynamic (tile appears only when it has a renderable card).
    fam.key === "comments" || eligible.some((c) => fam.match(c.task_type, c))
  );
  const tiles = [TILE_ALL, ...present];
  if (hasConnections) tiles.push(TILE_CONNECTIONS);
  if (hasDms) tiles.push(TILE_DMS);
  if (includeCreate) tiles.push(TILE_CREATE);
  return tiles;
}
// tileMatch — does a card belong to the given (non-"all", non-"createpost")
// filter key? Consumed by orderedQueue to filter the visible queue.
function tileMatch(card, filterKey) {
  const fam = SWITCHER_FAMILIES.find((f) => f.key === filterKey);
  return fam ? fam.match(card.task_type, card) : true;
}

// stripInternalSignal — for the in-app "full post" view on a LinkedIn comment
// card (Kunal item 16: don't leave the app). The raw `signal` interleaves the
// public post text (🔗/📝/💬 markers) with INTERNAL scoring (📊 score, 📋 rule
// names). We render the post in-app but MUST NOT surface scores/rule names, so
// drop any line carrying an internal marker or an obvious score token. The
// model-generated summary/bullets remain the primary view; this is the
// "read the whole post without leaving" affordance. Run formatSignalText FIRST.
function stripInternalSignal(formatted) {
  if (!formatted || typeof formatted !== "string") return formatted || "";
  const lines = formatted.split("\n").filter((ln) => {
    const t = ln.trim();
    if (!t) return false;
    if (t.startsWith("📊") || t.startsWith("📋")) return false; // score / rule lines
    if (/\b\d{1,3}\/100\b/.test(t)) return false;               // residual score token
    if (/\bicp fit\b/i.test(t) || /\brules? matched\b/i.test(t)) return false;
    return true;
  });
  return lines.join("\n").trim();
}

// ─────────────────────────────────────────────────────────────────────
// ExpandableSignal — collapses long structured text after N lines with
// a "Show N more lines" / "Show less" toggle. Used so multi-post signal
// blocks (e.g. Rahul's 2 LinkedIn posts × 8 sections each = 16+ lines)
// don't overwhelm the card. Threshold is line-based on the already-
// formatted text (formatSignalText must run BEFORE this).
// ─────────────────────────────────────────────────────────────────────
function ExpandableSignal({ text, threshold = 8 }) {
  const [expanded, setExpanded] = useState(false);
  if (!text || typeof text !== "string") return text || null;
  const lines = text.split("\n");
  if (lines.length <= threshold) return text;
  if (expanded) {
    return (
      <>
        {text}
        {"\n"}
        <button className="signal-toggle" onClick={(e) => { e.stopPropagation(); setExpanded(false); }}>
          Show less
        </button>
      </>
    );
  }
  const hiddenCount = lines.length - threshold;
  return (
    <>
      {lines.slice(0, threshold).join("\n")}
      {"\n"}
      <button className="signal-toggle" onClick={(e) => { e.stopPropagation(); setExpanded(true); }}>
        Show {hiddenCount} more {hiddenCount === 1 ? "line" : "lines"}
      </button>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Task prioritization (Kunal 2026-06-19) — a fresh post should outrank a
// stale one, but seniority/ICP fit (the score) still leads. So priority =
// score + a freshness boost that decays with the post's age. This brings
// today's posts up without letting a low-fit fresh post leapfrog a strong
// senior lead. Uses the post's publish date when known, else the task's
// created date. Pure function of the card — no side effects.
// ─────────────────────────────────────────────────────────────────────
function postAgeDays(card) {
  const d = card?.post_date || card?.created_at;
  if (!d) return null;
  const t = new Date(d).getTime();
  if (isNaN(t)) return null;
  return Math.max(0, (Date.now() - t) / 86400000);
}
function freshnessBoost(card) {
  const age = postAgeDays(card);
  if (age === null) return 0;       // unknown age → no boost (don't guess)
  if (age <= 1) return 15;
  if (age <= 2) return 11;
  if (age <= 3) return 7;
  if (age <= 4) return 4;
  if (age <= 5) return 2;
  return 0;                         // 6-7 days: about to age out, no boost
}
function taskPriority(card) {
  return (card?.score || 0) + freshnessBoost(card);
}

export default function SideKick() {
  const [cards, setCards] = useState([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);
  const [leaving, setLeaving] = useState(new Set());
  const [toast, setToast] = useState("");
  // Optional Undo affordance attached to the current toast (relevance
  // suppression). Shape: { label, onUndo } | null. Lives alongside `toast`
  // so the same show/hide timing drives both.
  const [toastUndo, setToastUndo] = useState(null);
  const toastTimerRef = useRef(null);

  // Sticky top card — see render block. Locks the visible card until it's
  // gone from the feed (user actioned it OR server removed it). Stored in
  // a ref since it's only read in render and updated alongside it; no
  // re-render needed on change.
  const stickyTopIdRef = useRef(null);

  // ─── Focused top card ref (card-ergonomics: keyboard + swipe) ───
  // The visible top card is resolved inside the render IIFE. To let the
  // window-level keydown handler and the touch-swipe handler act on the
  // card CURRENTLY on screen (not a value captured at mount), we lift the
  // resolved top card's identity into a ref and update it during render.
  // Avoids the classic stale-closure bug: the keydown effect attaches once
  // and always reads topCardRef.current. Shape: { id, task_type } | null.
  const topCardRef = useRef(null);
  // Mirror `leaving` into a ref so the once-attached keydown handler can
  // bail when the current top card is already animating out — matching the
  // `disabled={leaving}` re-entry guard the on-screen buttons have. Without
  // this, holding `d`/`Enter` fires handleAction multiple times on the same id.
  const leavingRef = useRef(leaving);
  leavingRef.current = leaving;

  // AI summary cache. Keyed by card.id → string (the generated summary)
  // OR "loading" OR "error". Fetched lazily for the visible top card so
  // we don't burn tokens summarising cards the operator never sees.
  const [summaries, setSummaries] = useState({});
  // Tracks in-flight summary requests so a re-render doesn't kick off
  // duplicate fetches before the first one's setState resolves.
  const pendingSummariesRef = useRef(new Set());

  // ─── LinkedIn comment flow cache (item 1) ──────────────────────
  // Keyed by card.id → { status: "loading"|"ready"|"error",
  //   summary, bullets, angles } for the angle brief. Lazy-fetched for
  //   the visible top card the same way summaries are, so we don't burn
  //   tokens on cards the operator never reaches. The generated comment
  //   itself lives in component-local state inside LinkedInCommentCard.
  const [commentData, setCommentData] = useState({});
  const pendingCommentDataRef = useRef(new Set());

  // ─── Comment-feedback prefs (closed loop) ──────────────────────
  // Learned operator preferences for LinkedIn comments, fetched once per
  // session from /api/preferences?item_type=comment and passed into the
  // comment-angles + generate-comment routes so future drafts apply past
  // corrections. Refreshed after the operator submits new comment
  // feedback (so the next generation reflects it immediately). Held in a
  // ref because it's read inside fetch callbacks, not rendered.
  const commentPrefsRef = useRef([]);
  const commentPrefsLoadedRef = useRef(false);
  const refreshCommentPrefs = useCallback(async () => {
    try {
      const r = await fetch("/api/preferences?item_type=comment&limit=15", { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (d && Array.isArray(d.prefs)) commentPrefsRef.current = d.prefs;
    } catch { /* prefs are best-effort; generation still works without them */ }
    commentPrefsLoadedRef.current = true;
  }, []);


  // Chat state — initialized empty, populated from Airtable on mount
  const [messages, setMessages] = useState([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const chatScrollRef = useRef(null);
  const countRef = useRef(count); // kept in sync so /api/chat always gets fresh count

  // ─── Chat focus context (pt7) ──────────────────────────────────
  // The operator can put a specific lead "in focus" so chat is about
  // THAT lead (the assistant gets the lead's full card injected) — or
  // clear it to chat generally. Fixes the old "chat is contextless"
  // complaint (pt6/pt7). Holds the trimmed card object or null.
  const [focusLead, setFocusLead] = useState(null);

  // ─── Chat panel (2026-06-11 redesign) ──────────────────────────
  // Chat lives in a floating panel (launcher bottom-right) so the task
  // queue stays the only thing in the main column. `chatUnread` lights a
  // dot on the launcher when a bot reply lands while the panel is closed.
  const [chatOpen, setChatOpen] = useState(false);
  const [chatUnread, setChatUnread] = useState(false);
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;

  // ─── Session progress (header queue dots) ──────────────────────
  // Counts tasks handled this session so the header can show Biscuit-style
  // progress dots (done → green, current → orange, queued → neutral).
  const [sessionDone, setSessionDone] = useState(0);

  // ─── Email draft modal (pt4 V1: draft + edit + copy) ───────────
  // V1 does NOT send. It composes an editable draft client-side from the
  // lead's card data, the operator edits it, then copies to their mail
  // client. Actual send-from-app is deferred to V2 (needs email infra).
  // Shape: { lead_name, company, to, subject, body } or null.
  const [emailDraft, setEmailDraft] = useState(null);

  // Cursor spotlight
  const [cursor, setCursor] = useState({ x: -1000, y: -1000 });

  // Movement scan status — polls every 30s, drives the live banner
  const [scanStatus, setScanStatus] = useState(null);
  const [scanConcurrentCount, setScanConcurrentCount] = useState(0);

  // ─── LinkedIn auto-batch (Stage 1 — pre-send approval) ─────────
  // Replaces the old "Sent Messages Review" (which was post-send audit).
  // Now: Daily 5 LI connection requests with pre-generated AI notes + DM
  // sequence, awaiting human approval. User clicks Send → Outreach record
  // flips from pending_approval → queued → cron picks it up → sends.
  const [autoBatches, setAutoBatches] = useState([]);
  // Manual-with-assist outreach queue (Kunal Batch-2 #18/#19). In-flight
  // Outreach records, each annotated with a computed `nextAction` telling the
  // exec the single manual move to make on LinkedIn (send connection / mark
  // accepted / send DM N / waiting). NO automation — exec sends by hand.
  const [outreachQueue, setOutreachQueue] = useState([]);
  const [batchLeaving, setBatchLeaving] = useState(new Set());
  const [batchExpanded, setBatchExpanded] = useState(new Set()); // batch IDs currently "Review one-by-one"
  // One-at-a-time queue (2026-06-11): every surface is a STEP in a single
  // queue — the daily batch is a step like any task card, so exactly one
  // thing is ever in focus. "Later" defers a step to the back of the queue
  // for this session. Step keys: "batch" | "connections" | card.id.
  const [deferred, setDeferred] = useState([]);

  // ─── Connection-requests-sent digest (Kunal 2026-07-07) ─────────
  // { count, past24h, leads:[{name,title,company,linkedin}], lastMarkedDone }
  // or null. Polled alongside the feed. The card only enters the queue when
  // FEATURES.connectionsSent is on AND past24h >= 5 (the visibility gate).
  const [connData, setConnData] = useState(null);
  // Session-only "remind me later" — hides the connections card without resetting
  // the count (only Mark as done resets). Reappears on reload / next session.
  const [connDismissed, setConnDismissed] = useState(false);

  // ─── DMs-sent digest (sibling of the connections card, 2026-07-09) ─────
  // { count, past24h, leads:[{name,title,company,linkedin,website,employees,
  //   employee_range,dm_step,last_dm_at}], lastMarkedDone } or null. The card
  // enters the queue when FEATURES.dmsSent is on AND past24h >= 1 (any DM in the
  // recent window — DMs are lower-volume than connection blasts, so gate at 1).
  const [dmData, setDmData] = useState(null);
  const [dmsDismissed, setDmsDismissed] = useState(false);

  // ─── Handled history (revisit actioned tasks — 2026-06-11) ─────
  // Done/Skip stamps Handled At server-side; "reopen" clears it so the
  // task returns to the feed. Three ways back: the Undo button on the
  // action toast, the U hotkey (last action this session), and the
  // Handled panel (any recently handled task, survives reloads).
  const [handledOpen, setHandledOpen] = useState(false);
  // Post-creation "hooks engine" overlay (Kunal Jun30) — gated on FEATURES.postCreate.
  const [postCreateOpen, setPostCreateOpen] = useState(false);
  // Task-switcher active filter (Kunal Jun30). null = "All" (unfiltered queue).
  // Otherwise a tile key ("comments", etc.) → queue filtered to that task family.
  const [queueFilter, setQueueFilter] = useState(null);
  const [handledList, setHandledList] = useState({ status: "idle", items: [] });
  const lastHandledRef = useRef(null); // last task id actioned this session
  // ─── Reopen/undo optimism (instant UI, no manual refresh) ──────────
  // Airtable's filterByFormula lags a beat after {Handled At} is cleared, so a
  // refetch right after a reopen comes back WITHOUT the task — the operator used
  // to have to refresh the page to see it. We instead re-insert the card
  // immediately and keep "forcing" it into the feed until the backend catches
  // up. reopenedRef: id → card still being forced. reopenCardRef: id → card
  // captured at action time (so Undo can re-insert a done/skip card we removed).
  // pendingRemovalRef: id → the done/skip removal timeout, so reopen can cancel
  // it and the card isn't yanked out from under a fast Undo.
  const reopenedRef = useRef(new Map());
  const reopenCardRef = useRef(new Map());
  const pendingRemovalRef = useRef(new Map());
  const [editingDraft, setEditingDraft] = useState(null); // { recordId, field, text }
  const [batchGenerating, setBatchGenerating] = useState(false);

  const fetchAutoBatches = useCallback(async () => {
    try {
      const r = await fetch("/api/auto-batch/pending", { cache: "no-store" });
      const data = await r.json();
      if (data.ok) {
        setAutoBatches(data.batches || []);
        setOutreachQueue(data.outreach_queue || []);
      }
    } catch {}
  }, []);

  // ─── Manual-with-assist outreach actions (no automation) ──────────
  // Each posts to a 1:1 proxy that forwards to SignalScope /api/outreach
  // with the Bearer header server-side, then refetches the queue.
  async function recordConnectionSent(outreachItemId) {
    try {
      const r = await fetch("/api/outreach/record-connection-sent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outreachItemIds: [outreachItemId] }),
      });
      const data = await r.json();
      if (data.marked) showToast("Marked connection sent", 2200);
      else showToast(`Error: ${data.error || "Action failed"}`, 4000);
      await fetchAutoBatches();
    } catch (e) {
      showToast(`Network error: ${e.message}`, 4000);
    }
  }

  async function markConnectionAccepted(outreachItemId) {
    try {
      const r = await fetch("/api/outreach/mark-connected", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outreachItemIds: [outreachItemId] }),
      });
      const data = await r.json();
      if (data.marked) showToast("Marked accepted — DM1 due in 2 days", 2600);
      else showToast(`Error: ${data.error || "Action failed"}`, 4000);
      await fetchAutoBatches();
    } catch (e) {
      showToast(`Network error: ${e.message}`, 4000);
    }
  }

  async function recordDmSent(outreachItemId, step) {
    try {
      const r = await fetch("/api/outreach/record-dm-sent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outreachItemId, step }),
      });
      const data = await r.json();
      if (data.ok) showToast(`Marked DM${step} sent`, 2200);
      else showToast(`Error: ${data.error || "Action failed"}`, 4000);
      await fetchAutoBatches();
    } catch (e) {
      showToast(`Network error: ${e.message}`, 4000);
    }
  }

  async function handleGenerateBatch(force = false) {
    if (batchGenerating) return;
    setBatchGenerating(true);
    showToast("Generating today's batch…", 4000);
    try {
      const r = await fetch("/api/auto-batch/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ size: 5, force }),
      });
      const data = await r.json();
      if (data.ok) {
        if (data.alreadyGeneratedToday) {
          showToast("Today's batch is ready — review below");
        } else {
          showToast(`Batch ready · ${data.count || 0} leads · $${(data.costUsd || 0).toFixed(3)}`);
        }
        await fetchAutoBatches();
      } else {
        showToast(`Error: ${data.error || "Generation failed"}`, 5000);
      }
    } catch (e) {
      showToast(`Network error: ${e.message}`, 5000);
    } finally {
      setBatchGenerating(false);
    }
  }

  async function handleBatchAction(action, params = {}) {
    try {
      const r = await fetch("/api/auto-batch/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...params }),
      });
      const data = await r.json();
      if (data.ok) {
        if (action === "send_all") showToast(`✓ ${data.count} sent to outreach queue`, 3000);
        else if (action === "send_one") showToast("✓ Sent to outreach queue", 2400);
        else if (action === "skip_all") showToast(`Skipped batch (${data.count})`, 2400);
        else if (action === "skip_one") showToast("Skipped", 2000);
        else if (action === "edit") showToast("Saved", 1800);
        await fetchAutoBatches();
        return true;
      } else {
        showToast(`Error: ${data.error || "Action failed"}`, 4000);
        return false;
      }
    } catch (e) {
      showToast(`Network error: ${e.message}`, 4000);
      return false;
    }
  }

  // ─── Fetch feed ─────────────────────────────────────────────────
  const fetchFeed = useCallback(async () => {
    try {
      // Cards come from /api/feed (capped at FEED_LIMIT for render). The header
      // counter must reflect the TRUE pending total, not the page size — /api/feed
      // returns count = cards.length (≤ limit), so the badge would stick at ~20.
      // Pull the real total from /api/count in parallel, SCOPED to the same task
      // type the queue renders (LinkedIn posts only when otherCards is off) so the
      // "N left" badge matches what the operator actually sees in the queue.
      // Badge counts what the stripped queue shows: LinkedIn-post tasks + ALL
      // Unipile outreach-sequence signals. "unipile_" is a substring match on the
      // backend (FIND), so it covers every unipile_* type in one clause.
      // dmsConnections OFF (Kunal Jul01): the 5 DM/connection unipile types are
      // hidden, so DON'T fetch every unipile_* — fetch only comment tasks
      // (linkedin_engagement + unipile_post_comment_on_yours, both COMMENTS) so
      // the DM/connection cards never enter the feed or the count.
      // "news" added to both scoped variants (Kunal Jul13) so the badge counts
      // the news signal cards the queue now renders.
      const countQS = FEATURES.otherCards
        ? ""
        : FEATURES.dmsConnections
          ? "?taskType=linkedin_engagement,unipile_,news"
          : "?taskType=linkedin_engagement,unipile_post_comment_on_yours,news";
      const [r, rc] = await Promise.all([
        fetch(`/api/feed?limit=${FEED_LIMIT}`, { cache: "no-store" }),
        fetch(`/api/count${countQS}`, { cache: "no-store" }).catch(() => null),
      ]);
      const data = await r.json();
      if (data.ok) {
        let feedCards = data.cards || [];
        // Merge optimistically-reopened cards the backend feed hasn't caught up
        // to yet (Airtable filterByFormula lags a beat after {Handled At} clears).
        // Once a forced card actually shows in the feed, stop forcing it.
        let forcedExtra = 0;
        if (reopenedRef.current.size) {
          const feedIds = new Set(feedCards.map((c) => c.id));
          for (const [id, card] of Array.from(reopenedRef.current.entries())) {
            if (feedIds.has(id)) {
              reopenedRef.current.delete(id); // feed caught up
            } else {
              feedCards = [card, ...feedCards.filter((c) => c.id !== id)];
              // Count it toward the badge only if it's in the badge's scope —
              // i.e. it's a card the queue actually renders under the current
              // FEATURES config (excludes hidden DM/connection cards when
              // dmsConnections is off). Same predicate queueEligibleCards uses.
              if (queueEligibleCards([card]).length > 0) {
                forcedExtra++;
              }
            }
          }
        }
        setCards(feedCards);
        // Prefer the true total from /api/count; fall back to the feed page size.
        let n = typeof data.count === "number" ? data.count : (data.cards || []).length;
        if (rc && rc.ok) {
          const cd = await rc.json().catch(() => null);
          if (cd && cd.ok && typeof cd.count === "number") n = cd.count;
        }
        n += forcedExtra; // reflect still-pending reopened cards the count missed
        setCount(n);
        countRef.current = n;
        setFetchError(null);
      } else {
        setFetchError(data.error || `Feed failed (HTTP ${r.status})`);
      }
    } catch (e) {
      setFetchError(`Network error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // ─── Fetch connection-requests-sent digest ─────────────────────
  // Best-effort — a failure just leaves the card hidden (connData null), never
  // blocks the feed. Gated on FEATURES.connectionsSent so it doesn't even hit
  // the network when the feature is off.
  const fetchConnections = useCallback(async () => {
    if (!FEATURES.connectionsSent) return;
    try {
      const r = await fetch("/api/connections-sent", { cache: "no-store" });
      const d = await r.json().catch(() => null);
      if (d && d.ok) {
        // Attach any already-cached company blurbs synchronously so the hover
        // tooltip has "what the company is" immediately on re-poll.
        if (Array.isArray(d.leads)) {
          for (const l of d.leads) {
            const cached = companyBlurbCache.get((l.company || "").trim().toLowerCase());
            if (cached) l.blurb = cached;
          }
        }
        setConnData(d);
        // Fire-and-forget: fetch missing blurbs (one AI call per NEW company,
        // cached for the session), then merge them in. Never blocks the card.
        enrichCompanyBlurbs(d.leads);
      }
    } catch {
      /* non-fatal — card stays hidden until the next poll succeeds */
    }
  }, []);

  // enrichCompanyBlurbs — lazily fill l.blurb for the shown companies via
  // /api/company-blurb (Claude), cached per company for the session so it fires
  // at most once each. On success, patch connData's leads in place. Best-effort:
  // any failure just leaves the tooltip at "<Company> · N employees".
  const enrichCompanyBlurbs = useCallback(async (leads) => {
    if (!Array.isArray(leads) || !leads.length) return;
    const pending = [...new Set(
      leads.map((l) => (l.company || "").trim()).filter((c) => c && !companyBlurbCache.has(c.toLowerCase()))
    )];
    if (!pending.length) return;
    await Promise.all(pending.map(async (company) => {
      const website = (leads.find((l) => (l.company || "").trim() === company) || {}).website || "";
      try {
        const r = await fetch("/api/company-blurb", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ company, website }),
        });
        const d = await r.json().catch(() => null);
        companyBlurbCache.set(company.toLowerCase(), d && d.ok ? (d.blurb || "") : "");
      } catch {
        companyBlurbCache.set(company.toLowerCase(), ""); // don't retry a hard failure this session
      }
    }));
    // Merge freshly-fetched blurbs into the current connData AND dmData leads.
    const mergeBlurbs = (cur) => {
      if (!cur || !Array.isArray(cur.leads)) return cur;
      let changed = false;
      const merged = cur.leads.map((l) => {
        const b = companyBlurbCache.get((l.company || "").trim().toLowerCase());
        if (b && l.blurb !== b) { changed = true; return { ...l, blurb: b }; }
        return l;
      });
      return changed ? { ...cur, leads: merged } : cur;
    };
    setConnData(mergeBlurbs);
    setDmData(mergeBlurbs);
  }, []);

  // ─── Fetch DMs-sent digest (sibling of fetchConnections) ────────
  const fetchDms = useCallback(async () => {
    if (!FEATURES.dmsSent) return;
    try {
      const r = await fetch("/api/dms-sent", { cache: "no-store" });
      const d = await r.json().catch(() => null);
      if (d && d.ok) {
        if (Array.isArray(d.leads)) {
          for (const l of d.leads) {
            const cached = companyBlurbCache.get((l.company || "").trim().toLowerCase());
            if (cached) l.blurb = cached;
          }
        }
        setDmData(d);
        enrichCompanyBlurbs(d.leads);
      }
    } catch {
      /* non-fatal — card stays hidden until the next poll succeeds */
    }
  }, [enrichCompanyBlurbs]);

  // Mark the DMs card done → resets the count server-side. Optimistic hide + Undo.
  async function markDmsDone() {
    const prev = dmData;
    setDmData((c) => (c ? { ...c, past24h: 0 } : c));
    setQueueFilter((f) => (f === "dms" ? null : f));
    try {
      const r = await fetch("/api/dms-sent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_done" }),
      });
      const d = await r.json().catch(() => ({}));
      if (d && d.ok) {
        stickyTopIdRef.current = null;
        showToast("Marked done — count reset", 4000, {
          label: "Undo",
          onUndo: async () => {
            try {
              await fetch("/api/dms-sent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "mark_done", at: prev?.lastMarkedDone || new Date(0).toISOString() }),
              });
            } catch { /* best-effort */ }
            await fetchDms();
          },
        });
        fetchDms();
      } else {
        setDmData(prev);
        showToast(`Error: ${(d && d.error) || "Couldn't mark done"}`, 4000);
      }
    } catch (e) {
      setDmData(prev);
      showToast(`Network error: ${e.message}`, 4000);
    }
  }

  // Flag a wrong lead from the DMs card feedback box → Outreach Status="excluded".
  async function excludeDmLead({ leadName, linkedin }) {
    try {
      const r = await fetch("/api/dms-sent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "exclude_lead", leadName, linkedin }),
      });
      return await r.json().catch(() => ({ ok: false }));
    } catch {
      return { ok: false };
    }
  }

  // Mark the connections card done → resets the count server-side. Optimistic:
  // hide the card immediately, then confirm + offer Undo (restores the previous
  // marked-done timestamp so the same requests resurface).
  async function markConnectionsDone() {
    const prev = connData;
    setConnData((c) => (c ? { ...c, past24h: 0 } : c)); // gate falls → card leaves
    setQueueFilter((f) => (f === "connections" ? null : f)); // don't strand on an empty filter
    try {
      const r = await fetch("/api/connections-sent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_done" }),
      });
      const d = await r.json().catch(() => ({}));
      if (d && d.ok) {
        stickyTopIdRef.current = null;
        showToast("Marked done — count reset", 4000, {
          label: "Undo",
          onUndo: async () => {
            // Restore the previous marked-done timestamp so the card returns.
            try {
              await fetch("/api/connections-sent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "mark_done", at: prev?.lastMarkedDone || new Date(0).toISOString() }),
              });
            } catch { /* best-effort */ }
            await fetchConnections();
          },
        });
        fetchConnections();
      } else {
        setConnData(prev); // revert the optimistic hide
        showToast(`Error: ${(d && d.error) || "Couldn't mark done"}`, 4000);
      }
    } catch (e) {
      setConnData(prev);
      showToast(`Network error: ${e.message}`, 4000);
    }
  }

  // Flag a wrong lead from the feedback box → Outreach Status="excluded" on the
  // Leads table (best-effort). Returns the server result so the card can echo
  // the right reply bubble.
  async function excludeConnLead({ leadName, linkedin }) {
    try {
      const r = await fetch("/api/connections-sent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "exclude_lead", leadName, linkedin }),
      });
      return await r.json().catch(() => ({ ok: false }));
    } catch {
      return { ok: false };
    }
  }

  // ─── Load chat history on mount ─────────────────────────────────
  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch(`/api/chat-history?limit=${HISTORY_LIMIT}`, { cache: "no-store" });
      const data = await r.json();
      if (data.ok && Array.isArray(data.messages) && data.messages.length > 0) {
        setMessages(data.messages.map(m => ({
          id: m.id,
          role: m.role,
          text: m.text,
        })));
      } else {
        // No history yet — show welcome
        setMessages([{
          id: "welcome",
          role: "bot",
          text: "Hey. Your pending tasks are above. Click a card to action it, or chat with me below. Scans happen on SignalScope — I just show what's already in the queue.",
        }]);
      }
    } catch {
      setMessages([{
        id: "welcome",
        role: "bot",
        text: "Hey. (Couldn't load past chat history — starting fresh.)",
      }]);
    } finally {
      setHistoryLoaded(true);
    }
  }, []);

  // Auto-generate trigger: on first chatbot mount of the day, if no
  // pending batch exists, request one. Idempotent on the server side.
  // item 6 (Kunal Jun12): the recurring daily LinkedIn DM review pop-up is
  // DISABLED. It auto-generated a batch on first mount each day, surfacing the
  // DailyBatchCard as a queue step; "Later" only deferred it within the session
  // so it reappeared the next day. Kunal wants it gone for his reviews. The
  // batch is no longer auto-generated — it only appears when the operator
  // explicitly hits the "Batch" (regenerate) action. Flip AUTO_GENERATE_BATCH
  // to true to restore the old recurring behavior.
  const AUTO_GENERATE_BATCH = false;
  const autoGenerateAttemptedRef = useRef(false);
  useEffect(() => {
    if (!AUTO_GENERATE_BATCH) return;
    if (!historyLoaded) return;
    if (autoGenerateAttemptedRef.current) return;
    if (autoBatches.length > 0) {
      autoGenerateAttemptedRef.current = true;
      return; // already a pending batch — no need to generate
    }
    autoGenerateAttemptedRef.current = true;
    // Fire-and-forget — server enforces idempotency, returns existing
    // batch if already generated today
    handleGenerateBatch(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyLoaded, autoBatches]);

  useEffect(() => {
    fetchFeed();
    fetchAutoBatches();
    fetchConnections();
    fetchDms();
    loadHistory();
    const i = setInterval(() => {
      fetchFeed();
      fetchAutoBatches();
      fetchConnections();
      fetchDms();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(i);
  }, [fetchFeed, fetchAutoBatches, fetchConnections, fetchDms, loadHistory]);

  // ─── Movement scan status polling ───────────────────────────────
  // Polls every 20s when running (active progress); 60s when idle.
  // When state transitions running → done, auto-refreshes feed so
  // movement-detected tasks appear without waiting for next 30s feed poll.
  const fetchScanStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/movement-scan-status", { cache: "no-store" });
      const data = await r.json();
      if (data.ok && data.run) {
        setScanStatus(prev => {
          if (prev?.state === "running" && data.run.state === "done") {
            // Scan just finished → pull fresh tasks
            fetchFeed();
          }
          return data.run;
        });
        setScanConcurrentCount(data.concurrentRunsCount || 0);
      } else {
        setScanStatus(null);
        setScanConcurrentCount(0);
      }
    } catch {
      // Non-fatal — banner just stays hidden
    }
  }, [fetchFeed]);

  useEffect(() => {
    fetchScanStatus();
    const intervalMs = scanStatus?.state === "running" ? 20000 : 60000;
    const i = setInterval(fetchScanStatus, intervalMs);
    return () => clearInterval(i);
  }, [fetchScanStatus, scanStatus?.state]);

  // ─── Cursor spotlight ───────────────────────────────────────────
  useEffect(() => {
    const onMove = (e) => setCursor({ x: e.clientX, y: e.clientY });
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  // ─── Chat auto-scroll on new message / panel open ───────────────
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [messages, chatOpen]);

  // ─── Keyboard shortcuts for the focused top card (item A) ───────
  // Desktop ergonomics — act on the single visible card without reaching
  // for the mouse: D = Done, S = Skip. (Enter is deliberately NOT bound —
  // see Kunal 2026-06-19; it was marking tasks done unexpectedly.) The 1/2/3 angle pick for a
  // LinkedIn card is handled INSIDE LinkedInCommentCard's own effect (it's
  // the focused card when mounted) so it can reach its angle-select state.
  //
  // Guards (the main bug surface):
  //  - Ignore when typing in an input/textarea/select/contenteditable so
  //    chat typing and draft editing are never hijacked.
  //  - Ignore while chat is busy or the email-draft modal is open.
  //  - Never preventDefault on Ctrl/Cmd/Alt-chorded keys (don't break
  //    browser shortcuts).
  //  - Read the current top card from topCardRef (kept fresh in render) so
  //    this once-attached handler never acts on a stale card.
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement;
      if (el) {
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return;
      }
      if (chatBusy || emailDraft || chatOpenRef.current) return;
      // U = undo the last done/skip of this session — works even when the
      // feed is empty (e.g. the operator just actioned the final card).
      if (e.key === "u" || e.key === "U") {
        if (lastHandledRef.current) {
          e.preventDefault();
          reopenTask(lastHandledRef.current);
        }
        return;
      }
      const top = topCardRef.current;
      if (!top) return;
      // Re-entry guard: ignore if the top card is already animating out
      // (prevents double-fire on rapid keypress / key-repeat).
      if (leavingRef.current && leavingRef.current.has(top.id)) return;
      const k = e.key;
      // Enter is intentionally NOT a Done shortcut (Kunal, 2026-06-19: "the enter
      // key should not work… just click the button"). Enter kept marking the task
      // done — including right after a post-chat send blurred the chat input — so
      // it's removed entirely. Done is D / swipe / button; Skip is S.
      if (k === "d" || k === "D") {
        e.preventDefault();
        handleAction(top.id, "done");
      } else if (k === "s" || k === "S") {
        e.preventDefault();
        handleAction(top.id, "skip");
      }
      // 1/2/3 (angle pick) intentionally NOT handled here — owned by
      // LinkedInCommentCard so it can wire to its angle-select handler.
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatBusy, emailDraft]);

  // Clear the top-card ref when the feed is empty so a keyboard shortcut
  // can't fire Done/Skip on an already-removed card. The render IIFE clears
  // it on its own empty path (sortedStack === 0), but it is NOT entered at
  // all when cards is empty — this covers that path.
  useEffect(() => {
    if (cards.length === 0) topCardRef.current = null;
  }, [cards]);

  // ─── Lazy AI summary fetch + next-step prefetch (item 8) ────────
  // When the visible top card changes (sticky pin advanced), fire a
  // single Haiku call to /api/summarize and cache the result. The
  // pendingSummariesRef guards against duplicate fetches during the
  // window between fetch start and setState completion.
  //
  // item 8 (Kunal Jun12): EXACTLY ONE post is loaded eagerly — the focused
  // top card. The card immediately AFTER it in the queue is PREFETCHED in the
  // background so advancing is instant (no spinner on the next post). We never
  // prefetch more than one ahead. `fetchSummaryFor` is idempotent (cache +
  // in-flight guards), so calling it for top + next is safe and never dupes.
  //
  // We resolve the stack here using the same priority order as the render IIFE
  // — keeping them in sync. This duplicates a few lines but is cheaper than
  // restructuring the whole component.
  const fetchSummaryFor = useCallback((target) => {
    if (!target) return;
    // LinkedIn-engagement cards use the dedicated comment flow (item 1),
    // which fetches its own post brief via /api/comment-angles. Don't also
    // spend on an SDR summary it never displays.
    if (target.task_type === "linkedin_engagement") return;
    // Unipile signal cards (DM reply, connection accepted, reactions, profile
    // view, etc.) render their raw signal — don't spend a summarize call on them.
    if ((target.task_type || "").startsWith("unipile_")) return;
    // Already cached / loading / in-flight? Skip.
    if (summaries[target.id]) return;
    if (pendingSummariesRef.current.has(target.id)) return;

    pendingSummariesRef.current.add(target.id);
    setSummaries(s => ({ ...s, [target.id]: "loading" }));

    fetch("/api/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: target.id,
        lead_name: target.lead_name,
        lead_title: target.lead_title,
        company: target.company,
        score: target.score,
        signal: target.signal,
        reasons: target.reasons,
        task_type: target.task_type,
        movement_type: target.movement_type,
      }),
    })
      .then(r => r.json())
      .then(d => {
        setSummaries(s => ({ ...s, [target.id]: d.ok ? d.summary : "error" }));
      })
      .catch(() => {
        setSummaries(s => ({ ...s, [target.id]: "error" }));
      })
      .finally(() => {
        pendingSummariesRef.current.delete(target.id);
      });
  }, [summaries]);

  // ─── Lazy comment-angle fetch (item 1) ──────────────────────────
  // When the visible top card is a LinkedIn-engagement card, fetch the
  // 3 commenting angles once and cache by card.id. Mirrors the summary
  // lazy-fetch so we never spend tokens on cards the operator never sees.
  // Only the TOP card is considered (matches the single-card stack UX).
  // `opts.regenerate` (item 10): force a fresh set of angles distinct from the
  // ones the operator already saw. We clear the cached angles BEFORE the fetch
  // (so the stale 3 vanish immediately) and pass them as `avoidAngles` so the
  // route instructs the model to produce 3 NEW ones at a higher temperature.
  const fetchCommentAngles = useCallback((card, opts = {}) => {
    if (!card || card.task_type !== "linkedin_engagement") return;
    if (pendingCommentDataRef.current.has(card.id)) return;

    const prev = commentData[card.id];
    const regenerate = !!opts.regenerate;
    // First load: skip if already cached. Regenerate: always proceed.
    if (!regenerate && prev) return;

    const avoidAngles = regenerate && prev?.angles?.length
      ? prev.angles.map(a => ({ label: a.label, hint: a.hint }))
      : [];

    // Lazy-load learned comment prefs once per session (best-effort).
    if (!commentPrefsLoadedRef.current) refreshCommentPrefs();

    pendingCommentDataRef.current.add(card.id);
    // Clear the cached angles for this card so the rejected set is gone while
    // the new ones load (item 10 — never re-show the same 3).
    setCommentData(s => ({ ...s, [card.id]: { status: "loading" } }));

    fetch("/api/comment-angles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lead_name: card.lead_name,
        company: card.company,
        lead_title: card.lead_title,
        // signal carries the post content; route caps + strips internal markers
        signal: card.signal,
        url: card.url || card.lead_linkedin || "",
        // learned comment prefs bias the suggested angles
        feedback: commentPrefsRef.current,
        // on regenerate: the angles the operator already rejected
        avoidAngles,
      }),
    })
      .then(r => r.json())
      .then(d => {
        setCommentData(s => ({
          ...s,
          [card.id]: d.ok
            ? { status: "ready", summary: d.summary, bullets: d.bullets || [], angles: d.angles || [] }
            : { status: "error" },
        }));
      })
      .catch(() => {
        setCommentData(s => ({ ...s, [card.id]: { status: "error" } }));
      })
      .finally(() => {
        pendingCommentDataRef.current.delete(card.id);
      });
  }, [commentData, refreshCommentPrefs]);

  // ─── Ordered queue — single source of truth (2026-06-12) ────────
  // The exact step order the operator advances through: grouped+score-sorted
  // task cards, the virtual "batch" step prepended, and deferred steps sunk to
  // the back. BOTH the render below and the item-8 prefetch effect consume this
  // so "what we prefetch" can never drift from "what the user sees next".
  // Steps: { key: "batch"|card.id, card?, batch? }. (Sticky-top focus is
  // resolved by each consumer against stickyTopIdRef — not memoized here, since
  // it's a ref read, not reactive state.)
  const orderedQueue = useMemo(() => {
    // 1. Task cards, priority-sorted (movements → top → comments → ga → other).
    //    Task-switcher (Kunal Jun30): when a family tile is active, filter the
    //    source cards to that family FIRST — the whole sort/priority/batch
    //    engine below is reused unchanged, it just operates on the subset.
    //    queueFilter === null ("All") keeps the full unfiltered queue.
    //    First strip anything the current FEATURES config can't render
    //    (queueEligibleCards) so hidden DM/connection cards (dmsConnections off,
    //    Kunal Jul01) never reach the rendered queue even if one slips through
    //    the feed fetch (e.g. an optimistically-reopened card).
    const renderable = queueEligibleCards(cards);
    // "connections" is a virtual family (a single digest card, not feed tasks) —
    // its filter shows ONLY the connections card, so strip all task cards here.
    const allCards = (queueFilter === "connections" || queueFilter === "dms")
      ? []
      : queueFilter
      ? renderable.filter((c) => tileMatch(c, queueFilter))
      : [...renderable];
    const movements   = allCards.filter(c => c.task_type === "lead_movement");
    const topLeads    = allCards.filter(c => c.task_type === "top_x");
    const liComments  = allCards.filter(c => c.task_type === "linkedin_engagement");
    const gaVisitors  = allCards.filter(c => c.task_type === "engagement");
    // Unipile DM / outreach-sequence signals (created by /api/unipile-triggers):
    // DM reply, connection accepted, DM reaction, post comment/reaction, profile
    // view. These are the outreach-sequence flow — a lead replied / accepted /
    // engaged. Kunal 2026-06-19: "those become priority tasks." Surfaced even in
    // the stripped (otherCards off) queue, ranked FIRST (time-sensitive), and by
    // score within (DM reply 95 > comment 80 > connection accepted 70 > …).
    const unipileSignals = allCards.filter(c => (c.task_type || "").startsWith("unipile_"));
    const accountedFor = new Set([
      ...movements.map(c => c.id),
      ...topLeads.map(c => c.id),
      ...liComments.map(c => c.id),
      ...gaVisitors.map(c => c.id),
      ...unipileSignals.map(c => c.id),
    ]);
    const other = allCards.filter(c => !accountedFor.has(c.id));
    const byScore = (a, b) => (b.score || 0) - (a.score || 0);
    // LinkedIn tasks rank by freshness-weighted priority (Kunal 2026-06-19):
    // score leads, but a fresher post gets a decaying boost so today's posts
    // surface ahead of week-old ones. Tiebreak on raw score, then on recency.
    const byPriority = (a, b) => {
      const d = taskPriority(b) - taskPriority(a);
      if (d !== 0) return d;
      const ds = (b.score || 0) - (a.score || 0);
      if (ds !== 0) return ds;
      return (postAgeDays(a) ?? 1e9) - (postAgeDays(b) ?? 1e9); // newer first
    };
    // Kunal Jun12 strip: when otherCards is off, the queue shows ONLY
    // LinkedIn-post cards — movement / top-leads / GA cards are hidden.
    const sortedStack = FEATURES.otherCards
      ? [
          ...unipileSignals.sort(byPriority),
          ...movements.sort(byScore),
          ...topLeads.sort(byScore),
          ...liComments.sort(byPriority),
          ...gaVisitors.sort(byScore),
          ...other.sort(byScore),
        ]
      // Stripped queue (otherCards off): Unipile outreach-sequence signals first
      // (DM reply / connection accepted / engagement — time-sensitive, score-led),
      // then LinkedIn-post tasks.
      : [...unipileSignals.sort(byPriority), ...liComments.sort(byPriority)];

    // 2. Daily batch step — merge all pending_approval records into ONE virtual
    //    batch. Dedup by record id, then by name+company.
    let mergedBatch = null;
    if (FEATURES.connectionFlow && autoBatches.length) {
      const allLeads = autoBatches.flatMap(b => b.leads || []);
      const seenIds = new Set();
      const seenNameCo = new Set();
      const dedupedLeads = [];
      for (const lead of allLeads) {
        if (seenIds.has(lead.id)) continue;
        const key = `${(lead.lead_name || "").toLowerCase().trim()}|${(lead.company || "").toLowerCase().trim()}`;
        if (key !== "|" && seenNameCo.has(key)) continue;
        seenIds.add(lead.id);
        if (key !== "|") seenNameCo.add(key);
        dedupedLeads.push(lead);
      }
      dedupedLeads.sort((a, b) => (b.composite_score || 0) - (a.composite_score || 0));
      if (dedupedLeads.length > 0) {
        mergedBatch = { batch_id: "all", leads: dedupedLeads, count: dedupedLeads.length };
      }
    }

    // 3. The queue: batch first (the daily ritual), then tasks.
    const steps = [];
    if (mergedBatch) steps.push({ key: "batch", batch: mergedBatch });
    for (const c of sortedStack) steps.push({ key: c.id, card: c });

    // Connection-requests-sent digest — ONE card at the END of the queue
    // (actionable task cards keep priority; the finalized card-spec orders the
    // review/digest surfaces last). Only in the unfiltered "All" view (it's a
    // digest, not a task family, so it never appears under a switcher filter),
    // and only when the visibility gate passes (>=5 sent in the recent window —
    // widened 24h→72h, Samarth 2026-07-08, so a batch sent yesterday doesn't
    // vanish overnight; `past24h` now carries the 72h count).
    if (FEATURES.connectionsSent && (queueFilter === null || queueFilter === "connections") && !connDismissed && connData && connData.past24h >= 5) {
      steps.push({ key: "connections", conn: connData });
    }
    // DMs-sent digest — same placement rule, gated at >=1 (DMs are lower-volume).
    if (FEATURES.dmsSent && (queueFilter === null || queueFilter === "dms") && !dmsDismissed && dmData && dmData.past24h >= 1) {
      steps.push({ key: "dms", dms: dmData });
    }

    // 4. Deferred steps sink to the back, in the order they were deferred.
    const deferredSet = new Set(deferred);
    return [
      ...steps.filter(s => !deferredSet.has(s.key)),
      ...deferred.map(k => steps.find(s => s.key === k)).filter(Boolean),
    ];
  }, [cards, autoBatches, deferred, queueFilter, connData, connDismissed, dmData, dmsDismissed]);

  // ─── Eager top + single next-step prefetch (item 8) ─────────────
  // item 8 (Kunal Jun12): EXACTLY ONE post is loaded eagerly — the focused
  // top card. The card immediately AFTER it in the queue is PREFETCHED in the
  // background so advancing is instant (no spinner on the next post). We never
  // prefetch more than one ahead. Both fetchSummaryFor and fetchCommentAngles
  // are idempotent (cache + in-flight guards), so calling them for top + next
  // never dupes. Defined AFTER fetchCommentAngles so its dep ref is in scope.
  //
  // Consumes orderedQueue — the SAME step order the render uses — so the
  // one-ahead prefetch tracks the real next step even when a batch step is in
  // play or cards have been deferred. Skips the virtual "batch" step (no
  // summary/angles to warm) when resolving top + next.
  useEffect(() => {
    if (orderedQueue.length === 0) return;

    // Resolve the sticky top's index over the SAME ordering the render uses.
    let topIdx = 0;
    if (stickyTopIdRef.current) {
      const i = orderedQueue.findIndex(s => s.key === stickyTopIdRef.current);
      if (i >= 0) topIdx = i;
    }
    const target = orderedQueue[topIdx]?.card;       // batch step has no .card
    const next = orderedQueue[topIdx + 1]?.card;     // the single step to prefetch

    // 1. Eager: the focused post. 2. Prefetch: exactly the next one.
    // fetchSummaryFor is a no-op on undefined (batch step / end of queue).
    // Kunal Jun12 strip: skip warming the AI summary/angles entirely when
    // neither the summary nor comment-assist surfaces are shown — the stripped
    // card renders the raw post and needs no model call.
    if (FEATURES.summary) {
      fetchSummaryFor(target);
      fetchSummaryFor(next);
    }
    // Prefetch the next LinkedIn-engagement card's comment brief too, so its
    // angles are ready the instant it becomes focused. fetchCommentAngles is
    // a no-op for non-LI cards and idempotent for already-cached ones.
    if ((FEATURES.commentAssist || FEATURES.summary) && next && next.task_type === "linkedin_engagement") {
      fetchCommentAngles(next);
    }
  }, [orderedQueue, fetchSummaryFor, fetchCommentAngles]);

  // ─── Toast helper ───────────────────────────────────────────────
  function showToast(msg, ms = 2400, undo = null) {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    setToastUndo(undo);
    toastTimerRef.current = setTimeout(() => {
      setToast("");
      setToastUndo(null);
    }, ms);
  }

  // ─── Action handler (Mark Done / Skip) ──────────────────────────
  // Regular task cards (top_x, lead_movement, engagement,
  // linkedin_engagement) → POST /api/action → SignalScope stamps
  // the Task record with Handled At/As/Notes fields.
  async function handleAction(taskId, action) {
    setLeaving((s) => new Set([...s, taskId]));
    // Stash the card so Undo can re-insert it instantly (no refetch round-trip).
    const cardObj = cards.find((c) => c.id === taskId);
    if (cardObj) reopenCardRef.current.set(taskId, cardObj);

    try {
      const r = await fetch("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, action }),
      });
      const data = await r.json();
      if (data.ok) {
        // Schedule the removal but keep its handle so a fast Undo can cancel it
        // (otherwise the timeout fires after reopen and yanks the card back out).
        const tid = setTimeout(() => {
          pendingRemovalRef.current.delete(taskId);
          setCards((c) => c.filter((card) => card.id !== taskId));
          setCount((n) => { const nn = Math.max(0, n - 1); countRef.current = nn; return nn; });
          setLeaving((s) => { const ns = new Set(s); ns.delete(taskId); return ns; });
          // Clear sticky so the next render picks the new top card from
          // the sorted stack (rather than waiting for next poll to re-resolve).
          if (stickyTopIdRef.current === taskId) {
            stickyTopIdRef.current = null;
          }
        }, 300);
        pendingRemovalRef.current.set(taskId, tid);
        setSessionDone((n) => n + 1);
        lastHandledRef.current = taskId;
        showToast(
          action === "done" ? "Marked done ✓" : "Skipped",
          6000,
          { label: "Undo", onUndo: () => reopenTask(taskId) }
        );
      } else {
        setLeaving((s) => { const ns = new Set(s); ns.delete(taskId); return ns; });
        // Setup-fix case: surface the curl command so operator can act
        // immediately rather than digging through error logs.
        if (data.needsSetup || /Handled At.*missing/i.test(data.error || "")) {
          showToast("Setup needed: Tasks table is missing Handled fields. Have an admin run POST /api/setup-fix?key=…&baseId=… in SignalScope.", 8000);
        } else {
          showToast(`Error: ${data.error || "Action failed"}`, 4000);
        }
      }
    } catch (e) {
      setLeaving((s) => { const ns = new Set(s); ns.delete(taskId); return ns; });
      showToast(`Network error: ${e.message}`, 4000);
    }
  }

  // ─── Phone enrichment handler ───────────────────────────────────
  // Per-card action: clicks "Enrich Phone" → POST to /api/enrich-phone →
  // Apollo lookup → updates card in-place with the new phone (no re-fetch).
  const [enriching, setEnriching] = useState(new Set());
  async function handleEnrichPhone(taskId) {
    setEnriching((s) => new Set([...s, taskId]));
    try {
      const r = await fetch("/api/enrich-phone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId }),
      });
      const data = await r.json();
      if (data.ok && data.phone) {
        // Patch the card in state with the new phone + phone type (so the
        // Call button can show what kind it is in the tooltip)
        setCards((c) => c.map(card => card.id === taskId ? {
          ...card,
          lead_phone: data.phone,
          lead_phone_type: data.phoneType || "",
          lead_phone_description: data.phoneTypeDescription || "",
        } : card));
        // Toast tells operator WHICH type — mobile is gold, company main = switchboard
        const typeLabel = {
          mobile: "📱 Mobile",
          company_main: "🏢 Company main line",
          other_listed: "☎ Listed phone",
        }[data.phoneType] || "Phone";
        showToast(`${typeLabel}: ${data.phone}`, 3500);
      } else if (data.ok && !data.phone) {
        showToast(data.note || "No phone found in Apollo", 3500);
      } else {
        showToast(`Error: ${data.error || "Enrich failed"}`, 4000);
      }
    } catch (e) {
      showToast(`Network error: ${e.message}`, 4000);
    } finally {
      setEnriching((s) => { const ns = new Set(s); ns.delete(taskId); return ns; });
    }
  }

  // ─── Chat: add a transient message to UI ────────────────────────
  function pushMessage(role, text) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setMessages((m) => [...m, { id, role, text }]);
    return id;
  }
  function updateMessage(id, text) {
    setMessages((m) => m.map((x) => (x.id === id ? { ...x, text } : x)));
  }

  // ─── Submit user message — delegate to Claude orchestrator ──────
  async function handleSubmit(e) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || chatBusy) return;

    // Append user message locally
    pushMessage("user", text);
    setInput("");
    setChatBusy(true);

    // Add a placeholder bot bubble showing "Thinking…"
    const pendingId = pushMessage("bot", "…");

    try {
      // Snapshot history for the API — exclude the placeholder bot bubble
      // (we send everything up to and including the new user message)
      const historyForApi = messages.concat([{ role: "user", text }]).map(m => ({
        role: m.role,
        text: m.text,
      }));

      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          history: historyForApi,
          currentCount: countRef.current,
          // pt7: when a lead is in focus, send its full card so the
          // orchestrator answers about THAT lead specifically.
          focusLead: focusLead || null,
        }),
      });
      const data = await r.json();
      if (data.ok) {
        updateMessage(pendingId, data.reply);
        // Light the launcher dot if the operator closed the panel mid-reply.
        if (!chatOpenRef.current) setChatUnread(true);
        // Refresh action means re-pull the feed. Scans are handled on SignalScope, not here.
        if (data.action?.type === "refresh") {
          await fetchFeed();
        }
      } else {
        updateMessage(pendingId, `Error: ${data.error || "Unknown error"}`);
      }
    } catch (e) {
      updateMessage(pendingId, `Network error: ${e.message}`);
    } finally {
      setChatBusy(false);
    }
  }

  // ─── Render helpers ─────────────────────────────────────────────
  function getSubject(card) {
    return card.lead_name || card.company || "Untitled task";
  }

  // ─── Focus context handlers (pt7) ───────────────────────────────
  // Put a lead in focus for chat. Trims to the fields the orchestrator
  // needs so the POST body stays small. Clears with a null arg.
  function handleSetFocus(card) {
    if (!card) { setFocusLead(null); return; }
    // Focusing a lead is an intent to chat — open the panel right away.
    setChatOpen(true);
    setChatUnread(false);
    setFocusLead({
      lead_name: card.lead_name || "",
      company: card.company || "",
      lead_title: card.lead_title || "",
      score: card.score ?? null,
      signal: card.signal || "",
      score_reason: card.score_reason || "",
      movement_type: card.movement_type || "",
      task_rule: card.task_rule || "",
      lead_email: card.lead_email || "",
      lead_linkedin: card.lead_linkedin || "",
    });
    showToast(`Chat now focused on ${card.lead_name || "this lead"}`, 2200);
  }

  // ─── Feedback loop: post-submit handler ─────────────────────────
  // REPLACES the old dead-end handleItemFeedback (which only prefilled
  // the chat box and was never read by any generator). The real
  // capture→store path now lives in <FeedbackCapture>; this fires AFTER
  // a successful POST /api/feedback. For comment feedback we refresh the
  // session comment-prefs cache so the very next comment generation
  // applies it. The toast confirms the loop is closed.
  function handleFeedbackSubmitted(itemType, ok, meta) {
    if (ok === false) {
      if (meta?.needsSetup) {
        showToast("Feedback store not set up yet — ping admin");
      } else {
        showToast("Couldn't save feedback — try again");
      }
      return;
    }
    if (itemType === "comment") refreshCommentPrefs();
    // Silent path (item 7 exemplar capture): refresh prefs but don't stack a
    // "Feedback saved" toast on top of the operator's "Comment copied" toast.
    if (meta?.silent) return;
    showToast("Feedback saved — future drafts will use it.");
  }

  // ─── Universal relevance feedback (Kunal 2026-06-09) ────────────
  // Structured suppress/adjust rules on any data point of a card.
  // Backend enforces hard-suppress retroactively; after each create we
  // refetch the feed so suppressed leads visibly disappear. Reversible
  // via the Undo button on the toast (deactivates the just-created rule).
  async function deactivateRule(ruleId) {
    try {
      const r = await fetch("/api/relevance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ruleId, active: false }),
      });
      const d = await r.json().catch(() => ({}));
      if (d?.ok !== false) {
        showToast("Undone — rule removed.");
        await fetchFeed();
      } else {
        showToast("Couldn't undo — try again", 3000);
      }
    } catch {
      showToast("Couldn't undo — network error", 3000);
    }
  }

  // Create a relevance rule. `okToast` is the success message; on success we
  // refetch the feed (retroactive suppression made visible) and surface an
  // Undo that deactivates the created rule.
  async function createRelevanceRule(payload, okToast) {
    try {
      const r = await fetch("/api/relevance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => ({}));
      if (d?.needsSetup) {
        showToast("Relevance rules not set up yet — ping admin", 3500);
        return;
      }
      if (d?.ok === false || !r.ok) {
        showToast(`Couldn't save — ${d?.error || "try again"}`, 3500);
        return;
      }
      await fetchFeed();
      const undo = d?.id ? { label: "Undo", onUndo: () => deactivateRule(d.id) } : null;
      showToast(okToast, 5000, undo);
    } catch (e) {
      showToast(`Network error: ${e.message}`, 3500);
    }
  }

  // Per-field structured actions (see RelevanceMenu). Each maps a card field
  // to the right `kind`. For Exited movement cards `company` is the OLD
  // employer — send the real company name, not the "Ex-" display prefix.
  function suppressTitle(card) {
    if (!card.lead_title) return;
    createRelevanceRule(
      { kind: "title_irrelevant", value: card.lead_title },
      `Hiding "${card.lead_title}" titles`
    );
  }
  function suppressCompany(card) {
    if (!card.company) return;
    createRelevanceRule(
      { kind: "company_irrelevant", value: card.company },
      `Hiding ${card.company}`
    );
  }
  function suppressSignal(card) {
    const value = card.movement_type || card.task_type;
    if (!value) return;
    createRelevanceRule(
      { kind: "signal_irrelevant", value },
      `Muting "${value}" signals`
    );
  }
  function adjustScore(card, targetScore) {
    const n = Math.max(0, Math.min(100, parseInt(targetScore, 10)));
    if (Number.isNaN(n) || !card.lead_title) return;
    createRelevanceRule(
      { kind: "role_fit", value: card.lead_title, targetScore: n },
      `Set ${card.lead_title} fit to ${n}`
    );
  }

  // Defer a queue step ("Later") — moves it to the back of the session
  // queue and releases the sticky focus so the next step renders.
  function deferStep(key) {
    setDeferred((d) => [...d.filter((k) => k !== key), key]);
    if (stickyTopIdRef.current === key) stickyTopIdRef.current = null;
  }

  // ─── Reopen a handled task (Undo / U / Handled panel) ───────────
  // Clears Handled At server-side, then pins the task as the focused
  // step so it's immediately back on screen.
  const fetchHandled = useCallback(async () => {
    setHandledList((s) => ({ ...s, status: "loading" }));
    try {
      const r = await fetch("/api/handled?limit=20", { cache: "no-store" });
      const d = await r.json();
      if (d.ok) setHandledList({ status: "ready", items: d.items || [] });
      else setHandledList({ status: "error", items: [] });
    } catch {
      setHandledList({ status: "error", items: [] });
    }
  }, []);

  async function reopenTask(taskId, cardData) {
    // The card to put back on screen: the one passed (Handled panel hands us the
    // full record), else the one we stashed when it was actioned this session.
    const card = cardData || reopenCardRef.current.get(taskId);
    try {
      const r = await fetch("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, action: "reopen" }),
      });
      const data = await r.json();
      if (data.ok) {
        // Cancel any in-flight done/skip removal so it can't yank the card back
        // out after we re-insert it (fast-Undo race).
        const pend = pendingRemovalRef.current.get(taskId);
        if (pend) { clearTimeout(pend); pendingRemovalRef.current.delete(taskId); }
        setLeaving((s) => { const ns = new Set(s); ns.delete(taskId); return ns; });

        // OPTIMISTIC: put the card straight back on screen now. Airtable's feed
        // filter lags a beat after Handled At clears, so we also "force" it via
        // reopenedRef until a later fetchFeed confirms it's really back — no
        // manual page refresh needed.
        if (card) {
          reopenedRef.current.set(taskId, card);
          setCards((c) => (c.some((x) => x.id === taskId) ? c : [card, ...c]));
          setCount((n) => { const nn = n + 1; countRef.current = nn; return nn; });
        }
        reopenCardRef.current.delete(taskId);
        setDeferred((d) => d.filter((k) => k !== taskId));
        setSessionDone((n) => Math.max(0, n - 1));
        if (lastHandledRef.current === taskId) lastHandledRef.current = null;
        stickyTopIdRef.current = taskId; // straight back into focus
        setHandledOpen(false);
        showToast("Reopened — back in focus");
        // Reconcile in the background; fetchFeed merges reopenedRef so a lagging
        // feed can't drop the card we just restored.
        fetchFeed();
      } else {
        showToast(`Error: ${data.error || "Couldn't reopen"}`, 4000);
      }
    } catch (e) {
      showToast(`Network error: ${e.message}`, 4000);
    }
  }

  function openHandled() {
    setHandledOpen(true);
    fetchHandled();
  }

  // Universal "Not needed" — NOT a rule. A per-task skip (advances the stack)
  // with a note so the backend can distinguish it from a plain skip.
  async function markNotNeeded(card) {
    const taskId = card.id;
    setLeaving((s) => new Set([...s, taskId]));
    reopenCardRef.current.set(taskId, card); // stash for instant Undo
    try {
      const r = await fetch("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, action: "skip", notes: "not needed" }),
      });
      const data = await r.json();
      if (data.ok) {
        const tid = setTimeout(() => {
          pendingRemovalRef.current.delete(taskId);
          setCards((c) => c.filter((cc) => cc.id !== taskId));
          setCount((n) => { const nn = Math.max(0, n - 1); countRef.current = nn; return nn; });
          setLeaving((s) => { const ns = new Set(s); ns.delete(taskId); return ns; });
          if (stickyTopIdRef.current === taskId) stickyTopIdRef.current = null;
        }, 300);
        pendingRemovalRef.current.set(taskId, tid);
        setSessionDone((n) => n + 1);
        lastHandledRef.current = taskId;
        showToast("Marked not needed", 6000, { label: "Undo", onUndo: () => reopenTask(taskId) });
      } else {
        setLeaving((s) => { const ns = new Set(s); ns.delete(taskId); return ns; });
        showToast(`Error: ${data.error || "Action failed"}`, 4000);
      }
    } catch (e) {
      setLeaving((s) => { const ns = new Set(s); ns.delete(taskId); return ns; });
      showToast(`Network error: ${e.message}`, 4000);
    }
  }

  // ─── Email draft (pt4 V1: draft + edit + copy, NO send) ─────────
  // Composes an editable draft client-side from the lead's card data.
  // Operator edits, then copies to their own mail client. Sending from
  // the app is V2 (needs verified domain + provider — see Kanban).
  function handleDraftEmail(card) {
    const name = card.lead_name || "there";
    const firstName = name.split(" ")[0];
    // IMPORTANT: do NOT seed the body with the SDR summary or score_reason —
    // those are INTERNAL (they contain "69/100 fit", rule names, etc.) and this
    // draft goes TO the lead. Use only lead-safe, public-facing context.
    // For an exited lead the `company` field is the OLD employer — make the
    // body acknowledge they've moved rather than addressing the old company.
    const movedNote = card.movement_type === "Exited"
      ? `\n\nI saw you've recently moved on from ${card.company}. Congrats on the next chapter.`
      : "";
    const roleLine = card.lead_title && card.company && card.movement_type !== "Exited"
      ? `I came across your work as ${card.lead_title} at ${card.company}. `
      : "";
    const subject = card.movement_type === "Exited"
      ? `Following your move from ${card.company}`
      : `Quick note for ${firstName}${card.company ? ` at ${card.company}` : ""}`;
    const body =
`Hi ${firstName},${movedNote}

${roleLine}I work on Side Kick — we help B2B teams turn buying signals into personalized outreach without the manual SDR overhead.

Would a short chat be useful? Happy to share what we've been building if it's relevant.

Best,
`;
    setEmailDraft({
      lead_name: name,
      company: card.company || "",
      to: card.lead_email || "",
      subject,
      body,
    });
  }

  function getMeta(card) {
    const parts = [];
    if (card.lead_name && card.company && card.lead_name !== card.company) {
      // pt3 fix: for an Exited movement the `company` field is the company
      // the lead LEFT, not where they are now. Don't render it as current.
      // The new company (if known) lives in the signal text / summary.
      // Label it "Ex-<company>" so the operator isn't misled.
      if (card.movement_type === "Exited") {
        parts.push(`Ex-${card.company}`);
      } else {
        parts.push(card.company);
      }
    }
    // pt3: only show the stored title as current when the lead has NOT exited.
    // For an exited lead the stored title is also stale (it was their role at
    // the old company), so suppress it — the signal carries their new role.
    if (card.lead_title && card.movement_type !== "Exited") parts.push(card.lead_title);
    return parts.join(" · ");
  }

  return (
    <>
      <div
        className="spotlight"
        style={{ left: cursor.x, top: cursor.y, opacity: cursor.x < 0 ? 0 : 1 }}
        aria-hidden="true"
      />
      <main className="app">
        <header className="hdr">
          <div className="hdr-l">
            {/* item 3 (Kunal Jun12): top-corner logo removed entirely. */}
            <div className="brand">
              <div className="brand-name">Side Kick</div>
              <div className="brand-sub">your Veloka pipeline sidekick</div>
            </div>
          </div>
          {/* item 5 (Kunal Jun12): 3-slot header row — brand left, queue
              progress centered, action buttons right. */}
          <div className="hdr-c">
            <HeaderQueue
              // Visibility of system status (Nielsen #1): the badge must match
              // the section in view. "All" (queueFilter === null) → the accurate
              // GLOBAL server total from /api/count (now excludes hidden
              // DM/connection tasks via the scoped countQS, Kunal Jul01). A
              // filtered section → the length of the ALREADY-FILTERED rendered
              // queue (orderedQueue), i.e. EXACTLY what's on screen, so the count
              // can never disagree with the filtered view. Caveat: /api/feed is
              // capped at FEED_LIMIT, so a filtered count reflects the loaded page
              // (fine here — the filtered feed is well under the cap).
              pending={
                queueFilter
                  ? orderedQueue.length
                  : count + (FEATURES.connectionFlow && autoBatches.some(b => (b.leads || []).length > 0) ? 1 : 0)
              }
              done={sessionDone}
              loading={loading || !!fetchError}
            />
          </div>
          <div className="hdr-r">
            <button
              className="hdr-action"
              onClick={openHandled}
              title="Recently handled — reopen a task you marked done or skipped"
            >
              ↩<span className="hdr-action-label"> Handled</span>
            </button>
            {/* Header "Create post" CTA removed (Samarth Jul13) — the switcher
                tile row already carries Create post (always reachable: the
                pinned LinkedIn-comments tile keeps the row rendered), and the
                PostCreatorCard has its own Close. One affordance, not two
                (less-is-more). */}
            {FEATURES.connectionFlow && (
              <button
                className="hdr-action"
                onClick={() => {
                  // item 1 (Kunal Jun12): confirm before regenerating — a misclick
                  // wipes the existing batch. Native confirm (3-dependency rule).
                  if (typeof window !== "undefined" &&
                      !window.confirm("Are you sure you want to reload it?")) return;
                  handleGenerateBatch(true);
                }}
                disabled={batchGenerating}
                title="Regenerate today's LinkedIn batch (replaces existing)"
              >
                {batchGenerating
                  ? <><span className="spinner spinner-sm" /><span className="hdr-action-label"> Generating…</span></>
                  : <>↻<span className="hdr-action-label"> Batch</span></>}
              </button>
            )}
          </div>
        </header>

        {/* ─── Task-switcher tile row (Kunal Jun30, ported from approved mock) ─
            Dynamic tiles: All + one tile per task family PRESENT in the live
            feed + Create post (capability). Filters the queue by task type; the
            focused-card queue below stays one-at-a-time (less-is-more). Hidden
            while there are no tiles beyond "All" and Create post is off (nothing
            to switch between) and while loading/errored. */}
        {!loading && !fetchError && (() => {
          const hasConnections = FEATURES.connectionsSent && !connDismissed && connData && connData.past24h >= 5;
          const hasDms = FEATURES.dmsSent && !dmsDismissed && dmData && dmData.past24h >= 1;
          const tiles = deriveTiles(cards, FEATURES.postCreate, hasConnections, hasDms);
          // Only "All" (+ maybe Create post) → nothing to switch; hide the row.
          const hasFamilies = tiles.some(t => t.key !== "all" && t.key !== "createpost");
          if (!hasFamilies) return null;
          const activeKey = postCreateOpen ? "createpost" : (queueFilter || "all");
          const selectTile = (key) => {
            if (key === "createpost") { setPostCreateOpen(true); return; }
            setPostCreateOpen(false);
            setQueueFilter(key === "all" ? null : key);
            stickyTopIdRef.current = null; // refocus the top of the filtered queue
          };
          return (
            <div className="switchwrap">
              <div className="switchrow" role="tablist" aria-label="Filter tasks by type">
                {tiles.map(t => (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={activeKey === t.key}
                    className={`tile ${activeKey === t.key ? "on" : ""}`}
                    onClick={() => selectTile(t.key)}
                    title={t.label}
                  >
                    <span className="tile-lbl">{t.label}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })()}

        <ScanBanner status={scanStatus} concurrentRunsCount={scanConcurrentCount} />

        {loading && (
          <div className="loading">
            <div className="spinner" />
            <div style={{ marginTop: 12 }}>Loading tasks…</div>
          </div>
        )}

        {!loading && fetchError && (
          <div className="error">Feed error: {fetchError}</div>
        )}

        {/* ─── UNIFIED QUEUE (Biscuit one-at-a-time, 2026-06-11) ─────
            Exactly ONE step is ever in focus. The daily LinkedIn batch is
            a queue step like any task card — nothing competes with the
            focused card. "Later" defers a step to the back of the queue.
            LinkedIn follow-ups are hidden for now (Unipile drives that
            state automatically); the outreach handlers stay wired. */}
        {!loading && !fetchError && (() => {
          // Post-creation overlay takes over the single-card column when open.
          // It is not a queue task — clear the focus ref so card keyboard
          // shortcuts don't fire on a stale card behind it.
          if (postCreateOpen) {
            topCardRef.current = null;
            return (
              <div className="task-stack">
                <PostCreatorCard
                  onClose={(action) => {
                    setPostCreateOpen(false);
                    if (action === "done") showToast("Post marked done", 2600);
                  }}
                  onCopied={(msg) => showToast(msg, 2600)}
                />
              </div>
            );
          }

          // Steps 1-4 (group+score sort, virtual batch step, deferred sinking)
          // now live in the `orderedQueue` memo — the SINGLE source of truth the
          // item-8 prefetch effect also consumes, so prefetch can't drift from
          // what's rendered. Render just consumes it.
          const ordered = orderedQueue;

          if (ordered.length === 0) {
            topCardRef.current = null;
            return (
              <div className="task-stack">
                <div className="empty">
                  <div className="empty-check">✓</div>
                  <div className="empty-title">All clear</div>
                  <div>No tasks need your attention right now.</div>
                </div>
              </div>
            );
          }

          // 5. Sticky focus — the same step stays visible until it's gone
          //    (actioned, deferred, or removed server-side).
          let topStep = stickyTopIdRef.current
            ? ordered.find(s => s.key === stickyTopIdRef.current)
            : null;
          if (!topStep) {
            topStep = ordered[0];
            stickyTopIdRef.current = topStep.key;
          }
          const remaining = ordered.filter(s => s.key !== topStep.key);

          // Keyboard + swipe act only on a TASK focus — never the batch step.
          topCardRef.current = topStep.card
            ? { id: topStep.card.id, task_type: topStep.card.task_type }
            : null;

          const remainingCards = remaining.filter(s => s.card).map(s => s.card);
          const breakdown = {
            batch:     remaining.some(s => s.key === "batch") ? 1 : 0,
            movements: remainingCards.filter(c => c.task_type === "lead_movement").length,
            top:       remainingCards.filter(c => c.task_type === "top_x").length,
            comments:  remainingCards.filter(c => c.task_type === "linkedin_engagement").length,
            ga:        remainingCards.filter(c => c.task_type === "engagement").length,
            other:     remainingCards.filter(c => !["lead_movement", "top_x", "linkedin_engagement", "engagement"].includes(c.task_type)).length,
          };

          const topCard = topStep.card;
          const topIsFocused = topCard && focusLead && focusLead.lead_name === topCard.lead_name && focusLead.company === topCard.company;

          return (
            <div className="task-stack">
              {topStep.key === "batch" ? (
                <DailyBatchCard
                  key="merged-pending-batch"
                  batch={topStep.batch}
                  expanded={batchExpanded.has("all")}
                  onToggleExpand={() => {
                    setBatchExpanded(prev => {
                      const next = new Set(prev);
                      if (next.has("all")) next.delete("all");
                      else next.add("all");
                      return next;
                    });
                  }}
                  onDefer={remaining.length > 0 ? () => deferStep("batch") : null}
                  onSendAll={(sendMode) => handleBatchAction("send_all", { batchId: "all", sendMode })}
                  onSkipAll={() => handleBatchAction("skip_all", { batchId: "all" })}
                  onSendOne={(recordId, sendMode) => handleBatchAction("send_one", { recordId, sendMode })}
                  onSkipOne={(recordId) => handleBatchAction("skip_one", { recordId })}
                  onEditField={(recordId, field, newText) => handleBatchAction("edit", { recordId, field, newText })}
                  editingDraft={editingDraft}
                  setEditingDraft={setEditingDraft}
                  onFeedbackSubmitted={handleFeedbackSubmitted}
                />
              ) : topStep.key === "connections" ? (
                <ConnectionsSentCard
                  key="connections-sent"
                  conn={topStep.conn}
                  onMarkDone={markConnectionsDone}
                  onDefer={() => { setConnDismissed(true); setQueueFilter((f) => (f === "connections" ? null : f)); }}
                  onExcludeLead={excludeConnLead}
                />
              ) : topStep.key === "dms" ? (
                <DmsSentCard
                  key="dms-sent"
                  dms={topStep.dms}
                  onMarkDone={markDmsDone}
                  onDefer={() => { setDmsDismissed(true); setQueueFilter((f) => (f === "dms" ? null : f)); }}
                  onExcludeLead={excludeDmLead}
                />
              ) : (
                <SwipeCard key={`swipe-${topCard.id}`} cardId={topCard.id} onAction={handleAction}>
                  {topCard.task_type === "linkedin_engagement" ? (
                    <LinkedInCommentCard
                      key={topCard.id}
                      card={topCard}
                      leaving={leaving.has(topCard.id)}
                      subject={getSubject(topCard)}
                      meta={getMeta(topCard)}
                      commentData={commentData[topCard.id]}
                      onRequestAngles={() => fetchCommentAngles(topCard)}
                      onRegenerateAngles={() => fetchCommentAngles(topCard, { regenerate: true })}
                      onAction={handleAction}
                      onSetFocus={handleSetFocus}
                      onFeedbackSubmitted={handleFeedbackSubmitted}
                      commentPrefs={commentPrefsRef}
                      isFocused={topIsFocused}
                      onCopied={(msg) => showToast(msg, 2600)}
                      onNotNeeded={markNotNeeded}
                    />
                  ) : (
                    <Card
                      key={topCard.id}
                      card={topCard}
                      leaving={leaving.has(topCard.id)}
                      enriching={enriching.has(topCard.id)}
                      subject={getSubject(topCard)}
                      meta={getMeta(topCard)}
                      summary={summaries[topCard.id]}
                      onAction={handleAction}
                      onEnrichPhone={handleEnrichPhone}
                      onSetFocus={handleSetFocus}
                      onDraftEmail={handleDraftEmail}
                      isFocused={topIsFocused}
                      onSuppressTitle={suppressTitle}
                      onSuppressCompany={suppressCompany}
                      onSuppressSignal={suppressSignal}
                      onAdjustScore={adjustScore}
                      onNotNeeded={markNotNeeded}
                      onFeedbackSubmitted={handleFeedbackSubmitted}
                    />
                  )}
                </SwipeCard>
              )}
              {/* "N more queued" box REMOVED per Kunal Jun16 — keep the card
                  single-focus. Gated off, not deleted: flip `false` to restore.
                  The header dot-counter still shows progress. */}
              {false && remaining.length > 0 && <QueueIndicator count={remaining.length} breakdown={breakdown} />}
            </div>
          );
        })()}

      </main>

      {/* ─── Chat — floating launcher + slide-up panel (2026-06-11) ───
          The assistant lives in its own surface so the task queue stays
          the only thing in the main column. The launcher shows a green
          dot when a reply landed while the panel was closed. */}
      {FEATURES.chat && !chatOpen && (
        <button
          className="chat-fab"
          onClick={() => { setChatOpen(true); setChatUnread(false); }}
          title="Chat with Side Kick"
          aria-label="Open chat"
          type="button"
        >
          💬
          {chatUnread && <span className="chat-fab-dot" aria-hidden="true" />}
        </button>
      )}

      {FEATURES.chat && chatOpen && (
        <div className="chat-panel" role="dialog" aria-label="Side Kick chat">
          <div className="chat-panel-hdr">
            <div className="chat-avatar"><div className="dot" /></div>
            <div className="chat-panel-title">Ask Side Kick</div>
            <button
              className="chat-panel-close"
              onClick={() => setChatOpen(false)}
              title="Close chat"
              aria-label="Close chat"
              type="button"
            >✕</button>
          </div>

          {historyLoaded && (
            <div className="chat-thread" ref={chatScrollRef}>
              {messages.map((m) => (
                <ChatBubble key={m.id} msg={m} />
              ))}
            </div>
          )}

          {/* pt7: focus chip — shows which lead chat is "about". Click ✕ to clear. */}
          {focusLead && (
            <div className="chat-focus-chip">
              <span className="chat-focus-icon">🎯</span>
              <span className="chat-focus-label">
                Talking about: <strong>{focusLead.lead_name || "this lead"}</strong>
                {focusLead.company ? ` · ${focusLead.movement_type === "Exited" ? "Ex-" : ""}${focusLead.company}` : ""}
              </span>
              <button
                className="chat-focus-clear"
                onClick={() => setFocusLead(null)}
                title="Clear focus — chat about anything"
                type="button"
              >✕</button>
            </div>
          )}

          <div className="chat-input-wrap">
            <div className="chat-input-inner">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); handleSubmit(e); } }}
                placeholder={chatBusy ? "Thinking…" : focusLead ? `Ask about ${focusLead.lead_name || "this lead"}…` : "Talk to Side Kick…"}
                disabled={chatBusy}
                className="chat-input"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck="false"
              />
              <button
                onClick={handleSubmit}
                disabled={chatBusy || !input.trim()}
                className="chat-send"
                aria-label="Send"
              >
                {chatBusy ? <span className="spinner spinner-sm" /> : "→"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Handled history — reopen tasks already marked done/skip */}
      {handledOpen && (
        <div className="hist-overlay" onClick={() => setHandledOpen(false)}>
          <div className="hist-panel" onClick={(e) => e.stopPropagation()}>
            <div className="hist-hdr">
              <span className="hist-title">Recently handled</span>
              <button
                className="chat-panel-close"
                onClick={() => setHandledOpen(false)}
                type="button"
                aria-label="Close"
              >✕</button>
            </div>
            <div className="hist-sub">Changed your mind? Reopen a task and it comes straight back into focus.</div>
            <div className="hist-list">
              {handledList.status === "loading" && (
                <div className="hist-empty"><span className="spinner spinner-sm" /> Loading…</div>
              )}
              {handledList.status === "error" && (
                <div className="hist-empty">Couldn't load history — close and try again.</div>
              )}
              {handledList.status === "ready" && handledList.items.length === 0 && (
                <div className="hist-empty">Nothing handled recently.</div>
              )}
              {handledList.status === "ready" && handledList.items.map((it) => (
                <div key={it.id} className="hist-row">
                  <div className="hist-info">
                    <div className="hist-name">
                      {it.lead_name || it.company || "Untitled"}
                      {it.company && it.lead_name !== it.company ? (
                        <span className="hist-co"> · {it.movement_type === "Exited" ? `Ex-${it.company}` : it.company}</span>
                      ) : null}
                    </div>
                    <div className="hist-meta">
                      <span className={`hist-badge ${it.handled_as === "done" ? "hist-badge-done" : "hist-badge-skip"}`}>
                        {it.handled_as === "done" ? "✓ done" : "skipped"}
                      </span>
                      <span>{getConnector(it).label}</span>
                      <span>{handledAgo(it.handled_at)}</span>
                    </div>
                  </div>
                  <button className="btn hist-reopen" onClick={() => reopenTask(it.id, it)} type="button">
                    ↩ Reopen
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* pt4 V1: email draft modal — edit + copy, no send */}
      {emailDraft && (
        <EmailDraftModal
          draft={emailDraft}
          onChange={setEmailDraft}
          onClose={() => setEmailDraft(null)}
          onCopied={(what) => showToast(`${what} copied to clipboard`, 1800)}
        />
      )}

      <div className={`toast ${toast ? "show" : ""}`}>
        <span className="toast-msg">{toast}</span>
        {toastUndo && (
          <button
            type="button"
            className="toast-undo"
            onClick={() => {
              const fn = toastUndo.onUndo;
              if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
              setToast("");
              setToastUndo(null);
              fn?.();
            }}
          >
            {toastUndo.label || "Undo"}
          </button>
        )}
      </div>
    </>
  );
}

// ─── Header queue progress (Biscuit-style dots) ──────────────────
// done → green, current → orange (scaled), queued → neutral. When the
// session total exceeds MAX_DOTS the dots map proportionally so the row
// never overflows the header.
function HeaderQueue({ pending, done, loading }) {
  if (loading) return null;
  if (pending === 0) return <span className="queue-alldone">All done ✓</span>;
  const total = done + pending;
  const MAX_DOTS = 10;
  let states;
  if (total <= MAX_DOTS) {
    states = Array.from({ length: total }, (_, i) =>
      i < done ? "done" : i === done ? "current" : ""
    );
  } else {
    const doneDots = Math.min(MAX_DOTS - 1, Math.round((done / total) * MAX_DOTS));
    states = Array.from({ length: MAX_DOTS }, (_, i) =>
      i < doneDots ? "done" : i === doneDots ? "current" : ""
    );
  }
  return (
    <div className="counter" title={`${pending} task${pending === 1 ? "" : "s"} left · ${done} handled this session`}>
      <span className="queue-label">{pending} left</span>
      <div className="queue-dots">
        {states.map((s, i) => <div key={i} className={`q-dot ${s}`} />)}
      </div>
    </div>
  );
}

function ChatBubble({ msg }) {
  return (
    <div className={`chat-msg chat-msg-${msg.role}`}>
      {msg.role === "bot" && <div className="chat-avatar"><div className="dot" /></div>}
      <div className="chat-bubble">{msg.text}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SWIPE CARD WRAPPER (item B — mobile Tinder-style swipe)
// Native touch events only (3-dependency rule — no gesture lib). Wraps
// the focused top card. Right swipe → Done, left swipe → Skip.
//
// Guards that keep it from fighting the rest of the UI:
//  - Only triggers when horizontal movement dominates vertical AND clears
//    the threshold — so vertical page scroll still works.
//  - Ignores gestures that START on a button / link / textarea / input /
//    angle-chip so tapping buttons, picking angles, and editing the
//    comment keep working.
//  - Under threshold → animated snap-back. Over threshold → fly-out then
//    fires the action on the CURRENT card (read at gesture-end, never
//    captured stale).
// ═══════════════════════════════════════════════════════════════════
const SWIPE_THRESHOLD = 80;   // px horizontal travel to commit
const SWIPE_DOMINANCE = 1.4;  // |dx| must exceed |dy| * this to count as horizontal

function SwipeCard({ cardId, onAction, children }) {
  const wrapRef = useRef(null);
  const start = useRef(null);   // { x, y } | null
  const [dx, setDx] = useState(0);
  const [horizontal, setHorizontal] = useState(false); // locked-in horizontal gesture
  const [flying, setFlying] = useState(0); // 0 | 1 (right) | -1 (left) — fly-out direction

  // Reset transient drag state whenever the focused card changes.
  useEffect(() => {
    setDx(0); setHorizontal(false); setFlying(0); start.current = null;
  }, [cardId]);

  const interactiveStart = (target) => {
    // Walk up from the touch target — if the gesture began on an
    // interactive element, don't hijack it as a swipe.
    let n = target;
    while (n && n !== wrapRef.current) {
      const tag = n.tagName;
      if (tag === "BUTTON" || tag === "A" || tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return true;
      if (n.classList && n.classList.contains("li-angle-chip")) return true;
      n = n.parentNode;
    }
    return false;
  };

  const onTouchStart = (e) => {
    if (flying) return;
    const t = e.touches[0];
    if (!t) return;
    if (interactiveStart(e.target)) { start.current = null; return; }
    start.current = { x: t.clientX, y: t.clientY };
    setHorizontal(false);
  };

  const onTouchMove = (e) => {
    if (!start.current) return;
    const t = e.touches[0];
    if (!t) return;
    const ddx = t.clientX - start.current.x;
    const ddy = t.clientY - start.current.y;
    // Decide direction once we have a few px of travel.
    if (!horizontal) {
      if (Math.abs(ddx) < 8 && Math.abs(ddy) < 8) return;
      if (Math.abs(ddx) > Math.abs(ddy) * SWIPE_DOMINANCE) {
        setHorizontal(true);
      } else {
        // Vertical-dominant → let the page scroll, abandon this gesture.
        start.current = null;
        return;
      }
    }
    // Horizontal gesture locked in — track it and suppress page scroll.
    if (e.cancelable) e.preventDefault();
    setDx(ddx);
  };

  const onTouchEnd = () => {
    if (!start.current || !horizontal) {
      start.current = null; setDx(0); setHorizontal(false); return;
    }
    const committed = dx;
    start.current = null; setHorizontal(false);
    if (Math.abs(committed) >= SWIPE_THRESHOLD) {
      const dir = committed > 0 ? 1 : -1;
      setFlying(dir);
      const action = dir > 0 ? "done" : "skip";
      // Let the fly-out animation play, then fire on the current card id.
      setTimeout(() => { onAction(cardId, action); }, 180);
    } else {
      setDx(0); // snap back (CSS transition handles the ease)
    }
  };

  const past = Math.abs(dx) >= SWIPE_THRESHOLD;
  const dragging = horizontal && dx !== 0 && !flying;
  const translate = flying ? flying * (typeof window !== "undefined" ? window.innerWidth : 600) : dx;
  const rot = flying ? flying * 8 : Math.max(-6, Math.min(6, dx / 14));

  return (
    <div
      ref={wrapRef}
      className={`swipe-card ${flying ? "swipe-flying" : ""} ${dragging ? "swipe-dragging" : ""}`}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
      style={{ transform: `translateX(${translate}px) rotate(${rot}deg)` }}
    >
      {/* Swipe affordances — appear as the card passes threshold */}
      <div className={`swipe-hint swipe-hint-done ${dx > 0 && past ? "show" : ""}`} aria-hidden="true">✓ Done</div>
      <div className={`swipe-hint swipe-hint-skip ${dx < 0 && past ? "show" : ""}`} aria-hidden="true">Skip</div>
      {children}
    </div>
  );
}

// ─── Email draft modal (pt4 V1) ──────────────────────────────────
// Edit + copy only. NO send — actual send-from-app is V2 (needs a
// verified sending domain + provider; see the SignalScope Kanban).
// Uses navigator.clipboard with a textarea fallback for older browsers.
// Also offers a mailto: link as a convenience (opens the operator's own
// mail client with the draft prefilled — still their account, not ours).
function EmailDraftModal({ draft, onChange, onClose, onCopied }) {
  function copy(text, label) {
    copyToClipboard(text, () => onCopied?.(label));
  }
  const mailto = `mailto:${encodeURIComponent(draft.to || "")}?subject=${encodeURIComponent(draft.subject || "")}&body=${encodeURIComponent(draft.body || "")}`;

  return (
    <div className="email-modal-overlay" onClick={onClose}>
      <div className="email-modal" onClick={(e) => e.stopPropagation()}>
        <div className="email-modal-hdr">
          <span>✉ Draft email — {draft.lead_name}</span>
          <button className="email-modal-close" onClick={onClose} type="button">✕</button>
        </div>
        <label className="email-field">
          <span>To {draft.to ? "" : "(no email on file — add the new-company address)"}</span>
          <input
            type="email"
            value={draft.to}
            placeholder="name@newcompany.com"
            onChange={(e) => onChange({ ...draft, to: e.target.value })}
          />
        </label>
        <label className="email-field">
          <span>Subject</span>
          <input
            type="text"
            value={draft.subject}
            onChange={(e) => onChange({ ...draft, subject: e.target.value })}
          />
        </label>
        <label className="email-field">
          <span>Body</span>
          <textarea
            rows={10}
            value={draft.body}
            onChange={(e) => onChange({ ...draft, body: e.target.value })}
          />
        </label>
        <div className="email-modal-actions">
          <button className="btn" onClick={() => copy(draft.body, "Body")} type="button">Copy body</button>
          <button className="btn" onClick={() => copy(`Subject: ${draft.subject}\n\n${draft.body}`, "Email")} type="button">Copy all</button>
          <a className="btn primary" href={mailto}>Open in mail client</a>
        </div>
      </div>
    </div>
  );
}

// Section wrapper with a header showing what category the cards below belong to.
// Used to group the feed into Calls / Movements / Comments / etc.
function Section({ icon, title, sub, count, children }) {
  return (
    <div className="feed-section">
      <div className="section-hdr">
        <span className="section-icon">{icon}</span>
        <span className="section-title">{title}</span>
        <span className="section-count">{count}</span>
        {sub && <span className="section-sub">{sub}</span>}
      </div>
      <div className="feed">
        {children}
      </div>
    </div>
  );
}

// MessageCard — review item for a LinkedIn invite/DM that already went out
// via Unipile. Shows the AI-drafted text + Approve / Flag.
function MessageCard({ message, leaving, onAction }) {
  const isDisabled = leaving;
  const subtitle = [message.company, message.lead_title].filter(Boolean).join(" · ");
  const typeLabel = {
    connection_invite: "Connection invite",
    invite: "Connection invite",
    first_dm: "First DM",
    followup: "Follow-up",
    dm: "DM",
  }[message.message_type] || message.message_type || "Message";
  return (
    <div className={`card review-card ${leaving ? "leaving" : "entering"}`}>
      <div className="card-top">
        <div>
          <div className="subject">{message.lead_name || "(unknown lead)"}</div>
          {subtitle && <div className="subject-meta">{subtitle}</div>}
        </div>
        <div className="msg-type-tag">{typeLabel}</div>
      </div>
      <div className="ai-message">{message.ai_message || "(no message content)"}</div>
      <div className="tags">
        {message.campaign && <div className="tag tag-rule">{message.campaign}</div>}
      </div>
      <div className="ctas">
        {message.lead_linkedin && (
          <a
            className="btn"
            href={message.lead_linkedin}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => { if (isDisabled) e.preventDefault(); }}
          >
            in LinkedIn
          </a>
        )}
        <button className="btn primary" disabled={isDisabled} onClick={() => onAction(message.id, "approve")}>
          ✓ Approve
        </button>
        <button className="btn danger" disabled={isDisabled} onClick={() => onAction(message.id, "flag")}>
          🚩 Flag
        </button>
      </div>
    </div>
  );
}

// Live banner showing movement scan progress. Shows when state is running.
// Also shows briefly (5 min) after state flips to done — then hides.
// Hides on idle, error, cancelled (errors shown elsewhere).
//
// Multi-tenant: when the upstream returns campaignName (multi-base mode)
// we render it as a chip so the operator sees which client is being
// scanned. When concurrent runs exist (rare today, expected as we add
// more clients), we surface the count so it's obvious that other scans
// are happening in parallel even though the banner only shows one.
function ScanBanner({ status, concurrentRunsCount = 0 }) {
  if (!status) return null;

  // Compute time-since for last tick / completion
  function timeAgo(iso) {
    if (!iso) return "—";
    const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    return `${hours}h ago`;
  }

  const moves = (status.hired || 0) + (status.promoted || 0) + (status.exited || 0);
  const campaignLabel = status.campaignName || null;
  const extraCount = Math.max(0, concurrentRunsCount - 1); // other runs besides the shown one

  if (status.state === "running") {
    return (
      <div className="scan-banner scan-running">
        <span className="scan-spinner" />
        <div className="scan-text">
          <div className="scan-title">
            {campaignLabel ? `${campaignLabel} · ` : ""}Movement scan in progress
            {extraCount > 0 ? <span className="scan-extra-chip"> +{extraCount} more running</span> : null}
          </div>
          <div className="scan-detail">
            Batch {status.batchesRun || 0} · {status.totalProcessed || 0} leads scanned · {moves} movement{moves === 1 ? "" : "s"} found
            {status.lastTickAt ? ` · last tick ${timeAgo(status.lastTickAt)}` : ""}
          </div>
        </div>
      </div>
    );
  }

  if (status.state === "done" && status.completedAt) {
    // Hide done banner after 5 min — operator's seen it by then
    const completedSecondsAgo = Math.max(0, Math.round((Date.now() - new Date(status.completedAt).getTime()) / 1000));
    if (completedSecondsAgo > 300) return null;
    return (
      <div className="scan-banner scan-done">
        <span className="scan-check">✓</span>
        <div className="scan-text">
          <div className="scan-title">
            {campaignLabel ? `${campaignLabel} · ` : ""}Movement scan complete
          </div>
          <div className="scan-detail">
            {status.totalProcessed || 0} leads scanned · {moves} movement{moves === 1 ? "" : "s"} ({status.hired || 0}H/{status.promoted || 0}P/{status.exited || 0}E) · ${(status.totalCostUSD || 0).toFixed(4)}
          </div>
        </div>
      </div>
    );
  }

  if (status.state === "error") {
    return (
      <div className="scan-banner scan-error">
        <span className="scan-x">✗</span>
        <div className="scan-text">
          <div className="scan-title">Movement scan failed</div>
          <div className="scan-detail">{status.error || "Unknown error"}</div>
        </div>
      </div>
    );
  }

  return null;
}

function Card({ card, leaving, enriching, subject, meta, summary, onAction, onEnrichPhone, onSetFocus, onDraftEmail, isFocused, onSuppressTitle, onSuppressCompany, onSuppressSignal, onAdjustScore, onNotNeeded, onFeedbackSubmitted }) {
  const hasLink = !!card.url;
  const hasPhone = !!card.lead_phone;
  const hasLinkedIn = !!card.lead_linkedin && card.lead_linkedin !== card.url;
  const isDisabled = leaving;

  // Per-card state for "View more data" toggle. Local to the card so
  // toggling one doesn't affect others. Resets when card.id changes
  // (React remounts via key prop in parent).
  const [showFullData, setShowFullData] = useState(false);

  // Show enrich CTA only when there's enough data for Apollo to match.
  // Skip if already has phone or if no lead identity available.
  const canEnrich = !hasPhone && !isDisabled && (
    card.lead_name || card.lead_linkedin || card.lead_email
  );

  // Connector chip — the card's TITLE IDENTITY (Kunal item 14): connector
  // name + icon, derived uniformly via getConnector so every card type is
  // titled the same way. The lead name/company render below as the subject.
  const typeChip = getConnector(card);

  // Movement-specific badge (Hired/Promoted/Exited) — distinct from typeChip
  const movementBadge = card.movement_type ? ({
    Hired:    "🎉 New hire",
    Promoted: "📈 Promoted",
    Exited:   "👋 Exited",
  })[card.movement_type] : null;

  // Has either summary or raw signal to show?
  const hasSignal = !!card.signal;
  const summaryIsReady = summary && summary !== "loading" && summary !== "error";
  // Unipile DM / outreach-sequence signals (connection accepted, DM reply, DM
  // reaction, post comment/reaction, profile view): show the raw signal by
  // default — it carries the event detail the operator needs (the reply text,
  // the connection date, etc.). No AI summary — these are event notifications,
  // not posts to summarize.
  const isUnipileSignal = (card.task_type || "").startsWith("unipile_");

  // Relevance affordances — the real company is the stored `company` even on an
  // Exited card (the meta DISPLAYS it as "Ex-…", but the suppress rule must use
  // the real name). Signal-mute value = movement_type for movement cards, else
  // task_type. Guard each affordance on the field actually existing.
  const canTitleFb = !!onSuppressTitle && !!card.lead_title;
  const canCompanyFb = !!onSuppressCompany && !!card.company;
  const canScoreFb = !!onAdjustScore && !!card.lead_title && typeof card.score === "number";
  const signalMuteValue = card.movement_type || card.task_type;
  const canSignalFb = !!onSuppressSignal && !!signalMuteValue;

  return (
    <div className={`card card-stack ${leaving ? "leaving" : "entering"}`}>
      {/* Type chip on top — small, low-noise.
          item 7 (Kunal Jun12): numeric relevance score display removed.
          Score data still arrives on `card.score` (used for sorting) — only
          the on-card rendering is gone. */}
      <div className="card-header">
        <span className={`card-type card-type-${typeChip.tone}`}>
          <span className="card-type-icon">{typeChip.icon}</span>
          {typeChip.label}
        </span>
        {false && typeof card.score === "number" && card.score > 0 && (
          <span className="card-score-wrap">
            <span className="card-score-chip" title={`Composite score ${card.score}`}>
              {card.score}
            </span>
            {canScoreFb && (
              <RelevanceMenu
                mode="score"
                title="Adjust fit score for this role"
                label={`Right fit score for "${card.lead_title}"?`}
                actionLabel="Set"
                scoreInitial={card.score}
                onConfirm={(n) => onAdjustScore(card, n)}
              />
            )}
          </span>
        )}
      </div>

      {/* Lead identity — name large, meta small */}
      <div className="card-name">{subject}</div>
      {meta && <div className="card-meta">{meta}</div>}

      {/* Per-field relevance affordances — quiet dots, each opens the ONE
          structured action for that field (title/company). Kept off the meta
          line itself so it stays readable; rendered as a low-noise row. */}
      {(canTitleFb || canCompanyFb) && (
        <div className="card-rel-row">
          {canTitleFb && (
            <span className="card-rel-item">
              <span className="card-rel-field">{card.lead_title}</span>
              <RelevanceMenu
                title="Mark this title not relevant"
                label={`"${card.lead_title}" titles`}
                actionLabel="Mark this title not relevant"
                onConfirm={() => onSuppressTitle(card)}
              />
            </span>
          )}
          {canCompanyFb && (
            <span className="card-rel-item">
              <span className="card-rel-field">
                {card.movement_type === "Exited" ? `Ex-${card.company}` : card.company}
              </span>
              <RelevanceMenu
                title="Mark this company not relevant"
                label={`${card.company}`}
                actionLabel="Mark this company not relevant"
                onConfirm={() => onSuppressCompany(card)}
              />
            </span>
          )}
        </div>
      )}

      {/* Movement badge — only for movement cards, sits below identity */}
      {movementBadge && (
        <div className="card-movement-badge-row">
          <span className="card-movement-badge">{movementBadge}</span>
          {canSignalFb && (
            <RelevanceMenu
              title="Mute this signal type"
              label={`"${signalMuteValue}" signals`}
              actionLabel="Mute this signal type"
              onConfirm={() => onSuppressSignal(card)}
            />
          )}
        </div>
      )}

      {/* Summary (AI-generated, default view) + View more data toggle.
          When summary is ready and showFullData is false, show the summary.
          When showFullData is true OR summary failed, show the raw
          structured signal via ExpandableSignal.
          Loading state: subtle placeholder so the card doesn't reflow. */}
      {hasSignal && (
        <div className="card-signal-block">
          {/* Signal-mute affordance for cards WITHOUT a movement badge (top_x,
              engagement). Movement cards already carry it on the badge row. */}
          {canSignalFb && !movementBadge && (
            <div className="card-signal-mute-row">
              <span className="card-rel-hint">signal: {signalMuteValue}</span>
              <RelevanceMenu
                title="Mute this signal type"
                label={`"${signalMuteValue}" signals`}
                actionLabel="Mute this signal type"
                onConfirm={() => onSuppressSignal(card)}
              />
            </div>
          )}
          {!isUnipileSignal && !showFullData && summary === "loading" && (
            <div className="card-summary card-summary-loading">
              <span className="spinner spinner-sm" /> Generating SDR summary…
            </div>
          )}
          {!isUnipileSignal && !showFullData && summaryIsReady && (
            <FeedbackCapture
              itemType="comment"
              leadName={card.lead_name}
              leadCompany={card.company}
              onSubmitted={onFeedbackSubmitted}
            >
              <div className="card-summary">{summary}</div>
              <div className="li-post-fbhint" aria-hidden="true">💬 highlight to give feedback</div>
            </FeedbackCapture>
          )}
          {/* With FEATURES.summary off, no AI summary is ever fetched — show the
              raw signal by default so non-unipile cards (news, Kunal Jul13)
              aren't left bodyless. Unipile cards already rendered raw. */}
          {(isUnipileSignal || !FEATURES.summary || showFullData || summary === "error") && (
            <div className="card-signal-text">
              <ExpandableSignal text={formatSignalText(card.signal)} threshold={8} />
            </div>
          )}
          {/* Toggle: only show once summary has resolved (success or error).
              When summary is "error", the full data is already showing, so the
              toggle button just lets the operator collapse it back if they want.
              Connection-accepted always shows raw signal, so no toggle. */}
          {!isUnipileSignal && (summaryIsReady || summary === "error") && (
            <button
              className="card-view-more-btn"
              onClick={(e) => { e.stopPropagation(); setShowFullData(v => !v); }}
              type="button"
            >
              {showFullData ? "↑ Hide breakdown" : "↓ View full breakdown"}
            </button>
          )}
        </div>
      )}

      {/* Source / rule — small chips below signal */}
      {(card.task_rule || card.source) && (
        <div className="card-source-row">
          {card.task_rule && <span className="card-source-chip">{card.task_rule}</span>}
          {card.source && <span className="card-source-chip">{card.source}</span>}
        </div>
      )}

      {/* Actions: primary (Done/Skip) left, secondary icon buttons right */}
      <div className="card-actions-row">
        <div className="card-actions-primary">
          <button
            className="btn primary"
            disabled={isDisabled}
            onClick={() => onAction(card.id, "done")}
          >
            ✓ Mark Done
          </button>
          <button
            className="btn danger"
            disabled={isDisabled}
            onClick={() => onAction(card.id, "skip")}
          >
            Skip
          </button>
          {onNotNeeded && (
            <button
              className="btn quiet card-not-needed"
              disabled={isDisabled}
              onClick={() => onNotNeeded(card)}
              title="Not needed — skip this task and move on"
              type="button"
            >
              Not needed
            </button>
          )}
        </div>
        <div className="card-actions-secondary">
          {/* pt7: put this lead in focus for chat (or clear it) */}
          {onSetFocus && (card.lead_name || card.company) && (
            <button
              className={`card-icon-btn ${isFocused ? "card-icon-btn-active" : ""}`}
              onClick={() => onSetFocus(isFocused ? null : card)}
              title={isFocused ? "Stop focusing chat on this lead" : "Focus chat on this lead"}
              type="button"
            >{isFocused ? "🎯" : "💬"}</button>
          )}
          {/* pt4 V1: draft an email to this lead (edit + copy, no send) */}
          {onDraftEmail && (card.lead_name || card.lead_email) && (
            <button
              className="card-icon-btn"
              onClick={() => onDraftEmail(card)}
              title="Draft an email to this lead"
              type="button"
            >✉</button>
          )}
          {hasLink && (
            <a
              className="card-icon-btn"
              href={card.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => { if (isDisabled) e.preventDefault(); }}
              title="Open link"
            >↗</a>
          )}
          {hasLinkedIn && (
            <a
              className="card-icon-btn"
              href={card.lead_linkedin}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => { if (isDisabled) e.preventDefault(); }}
              title="LinkedIn profile"
            >in</a>
          )}
          {hasPhone && (
            <a
              className="card-icon-btn"
              href={`tel:${card.lead_phone}`}
              onClick={(e) => { if (isDisabled) e.preventDefault(); }}
              title={`Call ${card.lead_phone}${card.lead_phone_type === "mobile" ? " (mobile)" : card.lead_phone_type === "company_main" ? " (company)" : ""}`}
            >☎</a>
          )}
          {canEnrich && (
            <button
              className="card-icon-btn"
              disabled={enriching}
              onClick={() => onEnrichPhone(card.id)}
              title="Enrich phone via Apollo"
            >
              {enriching ? <span className="spinner spinner-sm" /> : "☎+"}
            </button>
          )}
        </div>
      </div>

      {/* Ask-about-this-task chat on every card type (not just LinkedIn posts).
          Non-post tasks (connection accepted, DM reply, top leads…) have no
          post_text, so the bot works off the signal + full lead context. */}
      {FEATURES.postContextChat && (card.post_text || card.signal) && (
        <PostChat
          post={card.post_text || ""}
          author={postAuthorLine(card)}
          cardId={card.id}
          leadName={card.lead_name}
          leadCompany={card.company}
          leadContext={{ score: card.score, signal: card.signal, task_rule: card.task_rule, task_type: card.task_type }}
        />
      )}

      {/* Keyboard hint — desktop only (hidden on touch via CSS).
          Enter is NOT a Done shortcut anymore (Kunal 2026-06-19) — use D. */}
      <div className="card-kbd-hint" aria-hidden="true">
        <span className="kb-key">D</span> done · <span className="kb-key">S</span> skip · <span className="kb-key">U</span> undo
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// LINKEDIN COMMENT CARD (item 1 — Kunal's favorite experience)
// Dedicated rich flow for task_type === "linkedin_engagement" cards.
//   - Title (author + company), a short summary, bullet points of what
//     the post is about, and a "View full post" CTA.
//   - 3 distinct angle chips (lazy-fetched via /api/comment-angles).
//   - Pick an angle → /api/generate-comment → editable comment textarea
//     + Regenerate.
//   - "Comment on LinkedIn" opens the post URL in a new tab AND copies
//     the comment to the clipboard. NO auto-post, NO backend side-effects.
//   - Mark Done / Skip via the existing handleAction.
//
// Internal-vs-public split: the angle + comment routes are told to treat
// the signal purely as the post's content and never surface scores / rule
// names. The card itself shows the model-generated public summary/bullets,
// NOT the raw internal signal.
// ═══════════════════════════════════════════════════════════════════
function LinkedInCommentCard({
  card, leaving, subject, meta, commentData,
  onRequestAngles, onRegenerateAngles, onAction, onSetFocus, onFeedbackSubmitted, commentPrefs, isFocused, onCopied,
  onNotNeeded,
}) {
  const isDisabled = leaving;
  const postUrl = card.url || card.lead_linkedin || "";

  // Kunal Jun12 strip: with comment-assist + summary off, the card is just
  // the original post text + a "Comment on LinkedIn" CTA. Flip the flags in
  // lib/features.js to bring the AI angles / generated comment / summary back.
  const showCommentAssist = FEATURES.commentAssist;
  const showSummary = FEATURES.summary;

  const [chosenAngleId, setChosenAngleId] = useState(null);
  const [comment, setComment] = useState("");
  const [commentStatus, setCommentStatus] = useState("idle"); // idle | loading | ready | error
  // item 16: read the WHOLE post inline (no app exit). The feed now serves the
  // RAW post text (card.post_text, written at scan time — Samarth 2026-06-11:
  // "Read full post" must show the actual post, not the summary). Legacy tasks
  // created before the backend change have no post_text, so fall back to the
  // internal-scrubbed signal (summary-ish, better than nothing; those tasks
  // age out of the feed within 7 days).
  const [showFullPost, setShowFullPost] = useState(false);
  const rawPostText = (card.post_text || "").trim();
  const fullPostText = rawPostText || stripInternalSignal(formatSignalText(card.signal));
  const hasFullPost = !!fullPostText;

  // ─── Ask / feedback chat (Kunal 2026-06-30 consistent card grammar) ──
  // The input is pinned in the sticky footer (.fbrow); replies append into
  // the scroll area (.fb-thread). Same /api/post-chat backing as before —
  // just relocated into the shared card chrome. Replaces the inline PostChat.
  const [askMsgs, setAskMsgs] = useState([]);
  const [askInput, setAskInput] = useState("");
  const [askBusy, setAskBusy] = useState(false);
  const askThreadRef = useRef(null);
  useEffect(() => { setAskMsgs([]); setAskInput(""); setAskBusy(false); }, [card.id]);
  useEffect(() => {
    if (askThreadRef.current) askThreadRef.current.scrollTop = askThreadRef.current.scrollHeight;
  }, [askMsgs, askBusy]);
  async function sendAsk(q) {
    const text = (q || "").trim();
    if (!text || askBusy) return;
    setAskMsgs((m) => [...m, { role: "user", text }]);
    setAskInput("");
    setAskBusy(true);
    try {
      const r = await fetch("/api/post-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          post: rawPostText,
          author: postAuthorLine(card),
          history: askMsgs.slice(-6),
          leadContext: { score: card.score, signal: card.signal, task_rule: card.task_rule, task_type: card.task_type },
        }),
      });
      const d = await r.json();
      setAskMsgs((m) => [...m, { role: "assistant", text: d?.ok ? d.reply : (d?.error || "Couldn't answer that.") }]);
      if (d?.ok && d.feedback?.text) {
        fetch("/api/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            item_type: "task_feedback",
            feedback_text: d.feedback.text,
            quoted_span: rawPostText.slice(0, 280),
            lead_name: card.lead_name || "",
            lead_company: card.company || "",
          }),
        }).catch(() => {});
        onFeedbackSubmitted?.();
      }
    } catch {
      setAskMsgs((m) => [...m, { role: "assistant", text: "Network error — try again." }]);
    } finally {
      setAskBusy(false);
    }
  }

  // ─── Skip-feedback prompt (Kunal Jun16) ─────────────────────────
  // Clicking Skip opens a tiny "why?" prompt instead of skipping straight
  // away. One-tap reason chips (or a typed note) log to /api/feedback so
  // the feed learns; then the skip fires. Best-effort — a failed log never
  // blocks the skip. Swipe-to-skip (mobile) still skips directly.
  const [skipping, setSkipping] = useState(false);
  function submitSkip(reason) {
    const r = (reason || "").trim();
    if (r) {
      fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_type: "skip_reason",
          quoted_span: rawPostText.slice(0, 280),
          feedback_text: r,
          lead_name: card.lead_name || "",
          lead_company: card.company || "",
        }),
      }).catch(() => {}); // never block the skip on a logging failure
    }
    setSkipping(false);
    onAction(card.id, "skip");
  }

  // Lazy-fetch angles when this card mounts (it only mounts when it's the
  // visible top card — the stack renders one card at a time).
  useEffect(() => {
    // Only hit /api/comment-angles when the AI summary or comment angles are
    // actually shown — the stripped card needs neither.
    if (showCommentAssist || showSummary) onRequestAngles?.();
    setShowFullPost(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id]);

  const status = commentData?.status || "loading";
  const angles = commentData?.angles || [];

  // ─── 1/2/3 angle-pick keyboard shortcut (item A) ────────────────
  // This card is the focused top card while mounted, so it owns the angle
  // hotkeys. Same guards as the parent's Done/Skip handler: ignore while
  // typing in a field, while leaving (mid-action), and on modifier chords.
  // Reads the latest `angles` via the effect dep so it never picks a stale
  // angle list.
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement;
      if (el) {
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return;
      }
      if (isDisabled) return;
      // item 7: don't let a 1/2/3 hotkey clobber an in-progress "write my own"
      // draft when focus is outside the textarea.
      if (chosenAngleId === "custom") return;
      if (e.key === "1" || e.key === "2" || e.key === "3") {
        const idx = Number(e.key) - 1;
        const a = angles[idx];
        if (a) { e.preventDefault(); pickAngle(a); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [angles, isDisabled, chosenAngleId]);
  const bullets = commentData?.bullets || [];
  const postSummary = commentData?.summary || "";

  async function generate(angle, regenerate = false) {
    if (!angle) return;
    setCommentStatus("loading");
    try {
      const r = await fetch("/api/generate-comment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lead_name: card.lead_name,
          company: card.company,
          lead_title: card.lead_title,
          signal: card.signal,
          url: postUrl,
          angle: { label: angle.label, hint: angle.hint },
          // learned comment prefs (closes the loop) — replaces persona
          feedback: commentPrefs?.current || [],
          // higher-temperature path so the rewrite actually varies (item 10)
          regenerate,
        }),
      });
      const d = await r.json();
      if (d.ok) {
        setComment(d.comment);
        setCommentStatus("ready");
      } else {
        setCommentStatus("error");
      }
    } catch {
      setCommentStatus("error");
    }
  }

  function pickAngle(angle) {
    setChosenAngleId(angle.id);
    generate(angle);
  }
  function regenerate() {
    const a = angles.find(x => x.id === chosenAngleId);
    if (a) generate(a, true);
  }
  // item 10: ask the parent for a genuinely NEW set of 3 angles (the rejected
  // ones are passed server-side as avoidAngles). Reset the chosen angle +
  // any drafted comment since the angle list is about to change underneath us.
  function regenerateAngles() {
    setChosenAngleId(null);
    setComment("");
    setCommentStatus("idle");
    onRegenerateAngles?.();
  }

  // item 7 (Kunal Jun 9): "give me a way to post a comment here itself" — the
  // operator can ignore all 3 suggested angles and write their OWN comment.
  // Reveal the editable comment box immediately (chosenAngleId="custom" so the
  // li-comment-block renders; no generation call). What they write is captured
  // as a positive exemplar on commit (see commentOnLinkedIn).
  function writeMyOwn() {
    setChosenAngleId("custom");
    setComment("");
    setCommentStatus("ready");
  }

  // item 7: the comment the operator actually POSTS is the strongest feedback —
  // "Kunal chose to ignore the three comments, posted a fourth version… that is
  // Kunal giving feedback… pick up the tonality from what I am posting." Capture
  // the final committed text as a `comment` exemplar via the existing feedback
  // loop so future angle/comment generation learns the operator's real voice.
  // Fire-and-forget; deduped so re-clicking the same text doesn't re-post.
  const exemplarSavedRef = useRef("");
  function captureCommentExemplar(text) {
    const t = String(text || "").trim();
    if (!t || t.length < 8) return;             // ignore trivial/empty
    if (exemplarSavedRef.current === t) return; // already captured this text
    exemplarSavedRef.current = t;
    fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        item_type: "comment",
        quoted_span: "",
        // Short prefix + the comment; backend caps the note, voice still lands.
        feedback_text: `Operator posted this comment himself — match this voice/approach for similar posts: "${t}"`,
        lead_name: card.lead_name || "",
        lead_company: card.company || "",
      }),
    })
      .then(r => r.json())
      // Refresh the in-session comment prefs (itemType "comment") but stay
      // silent — the operator already saw "Comment copied"; no second toast.
      .then(d => { if (d?.ok) onFeedbackSubmitted?.("comment", true, { silent: true }); })
      .catch(() => {}); // best-effort; never block the operator's posting flow
  }

  function commentOnLinkedIn() {
    if (postUrl) window.open(postUrl, "_blank", "noopener,noreferrer");
    copyToClipboard(comment, () => onCopied?.("Comment copied — paste it on LinkedIn."));
    captureCommentExemplar(comment);
  }

  // Stripped-card CTA (Kunal Jun12): no AI comment to copy — just open the
  // post so the operator can write their comment on LinkedIn directly.
  function openOnLinkedInToComment() {
    if (postUrl) window.open(postUrl, "_blank", "noopener,noreferrer");
  }

  // Connector title identity (item 14) — same helper every other card uses.
  const connector = getConnector(card);

  return (
    <div className={`card card-stack li-comment-card sk-card ${leaving ? "leaving" : "entering"}`}>
      <div className="card-scroll">
      <div className="card-header">
        <span className={`card-type card-type-${connector.tone}`}>
          <span className="card-type-icon">{connector.icon}</span>
          {connector.label}
        </span>
        {/* item 7 (Kunal Jun12): numeric relevance score display removed. */}
        {false && typeof card.score === "number" && card.score > 0 && (
          <span className="card-score-chip" title={`Composite score ${card.score}`}>{card.score}</span>
        )}
      </div>

      {/* Title — author + context header */}
      <div className="card-name">{subject}</div>
      {/* Kunal Jun16: a clear "who posted this" context header so the exec
          has identity context BEFORE reading the post (his #1 ask — "this
          doesn't give me enough context as to who he is"). Uses only public
          lead fields (headline/title + company) — never the internal signal
          (repo rule #6). Falls back to the generic meta line if neither is set. */}
      {(card.lead_title || card.company) ? (
        <div className="li-author">
          {card.lead_title ? <span className="li-author-role">{card.lead_title}</span> : null}
          {card.lead_title && card.company ? <span className="li-author-sep">·</span> : null}
          {card.company ? (
            <span className="li-author-co">
              {card.movement_type === "Exited" ? `Ex-${card.company}` : card.company}
            </span>
          ) : null}
        </div>
      ) : (meta && <div className="card-meta">{meta}</div>)}

      {/* Kunal Jun16: post engagement (likes / comments). Shows the post's
          traction at a glance so the exec can gauge relevance before reading
          ("zero comments tells me something"). Only renders when the scan
          captured a real number — a null (no data) hides the metric rather
          than show a misleading 0. Populates on posts scanned from 2026-06-17. */}
      {(typeof card.post_likes === "number" || typeof card.post_comments === "number") && (
        <div className="li-engagement">
          {typeof card.post_likes === "number" && (
            <span className="li-eng-item" title={`${card.post_likes} reactions`}>👍 {fmtCount(card.post_likes)}</span>
          )}
          {typeof card.post_comments === "number" && (
            <span className="li-eng-item" title={`${card.post_comments} comments`}>💬 {fmtCount(card.post_comments)}</span>
          )}
        </div>
      )}

      {/* Post summary + bullets (public-facing, model-generated) */}
      <div className="li-post-block">
        {!showSummary && (
          /* Kunal Jun12 strip: show the ORIGINAL post text inline — no AI
             summary, no bullets, no "read full post" toggle. Use ONLY the raw
             post (card.post_text). Do NOT fall back to card.signal: that's the
             internal brief (suggested comment / evidence / why-it-matters) and
             must never be shown as if it were the post (repo rule #6). Legacy
             tasks with no stored post_text just get the open-on-LinkedIn CTA. */
          <>
            {rawPostText ? (
              <div className="li-fullpost">{rawPostText}</div>
            ) : (
              <div className="li-post-error">This post’s text isn’t stored — open it on LinkedIn to read and comment.</div>
            )}
            {/* Open on LinkedIn moved into the sticky footer CTAs (consistent
                card grammar, Kunal 2026-06-30) — removed here to avoid redundancy. */}
          </>
        )}
        {showSummary && status === "loading" && (
          <div className="card-summary card-summary-loading">
            <span className="spinner spinner-sm" /> Reading the post…
          </div>
        )}
        {showSummary && status === "error" && (
          <div className="li-post-error">Couldn't load the post brief. You can still open the post and Mark Done.</div>
        )}
        {showSummary && status === "ready" && (postSummary || bullets.length > 0) && (
          <>
            {/* Highlight-to-feedback on the most natural-to-highlight text on the
                card: the AI summary line + the bullet points. Maps to the
                "comment" item_type (already whitelisted backend-side) so feedback
                here feeds the same comment-generation prefs loop. */}
            <FeedbackCapture
              itemType="comment"
              leadName={card.lead_name}
              leadCompany={card.company}
              onSubmitted={onFeedbackSubmitted}
            >
              {postSummary && <div className="card-summary">{postSummary}</div>}
              {bullets.length > 0 && (
                <ul className="li-post-bullets">
                  {bullets.map((b, i) => <li key={i}>{b}</li>)}
                </ul>
              )}
              <div className="li-post-fbhint" aria-hidden="true">💬 highlight to give feedback</div>
            </FeedbackCapture>
          </>
        )}
        {/* item 16: read the whole post WITHOUT leaving the app. Inline toggle
            reveals the full (internal-scrubbed) post text; a secondary link
            still opens it on LinkedIn for those who want the live thread.
            Only in summary mode — the stripped card already shows the full
            post inline above. */}
        {showSummary && (
          <div className="li-post-actions">
            {hasFullPost && (
              <button
                className="li-fullpost-toggle"
                onClick={(e) => { e.stopPropagation(); setShowFullPost(v => !v); }}
                type="button"
                aria-expanded={showFullPost}
              >
                {showFullPost ? "↑ Hide full post" : "↓ Read full post here"}
              </button>
            )}
            {/* Open on LinkedIn lives in the sticky footer CTAs now — removed
                here too (Kunal redundancy: one "open" per card). The "Read full
                post here" toggle stays (stay-in-app, not redundant). */}
          </div>
        )}
        {showSummary && showFullPost && hasFullPost && (
          <FeedbackCapture
            itemType="comment"
            leadName={card.lead_name}
            leadCompany={card.company}
            onSubmitted={onFeedbackSubmitted}
          >
            <div className="li-fullpost">{fullPostText}</div>
          </FeedbackCapture>
        )}
      </div>

      {/* Per-post ask/feedback chat relocated into the sticky footer (input)
          + the scroll thread below (Kunal 2026-06-30 consistent card grammar). */}

      {/* Angle chips */}
      {showCommentAssist && status === "ready" && angles.length > 0 && (
        <div className="li-angles">
          <div className="li-angles-hdr">
            <span className="li-angles-label">Pick an angle to comment from:</span>
            <div className="li-angles-hdr-btns">
              <button
                className="li-angles-regen"
                onClick={regenerateAngles}
                disabled={isDisabled}
                title="None of these fit? Get 3 different angles"
                type="button"
              >
                ↻ New angles
              </button>
              {/* item 7: ignore all 3 and write your own — captured as a voice exemplar */}
              <button
                className={`li-angles-own ${chosenAngleId === "custom" ? "li-angles-own-active" : ""}`}
                onClick={writeMyOwn}
                disabled={isDisabled}
                title="Ignore these and write your own comment — it trains future suggestions"
                type="button"
              >
                ✍ Write my own
              </button>
            </div>
          </div>
          <div className="li-angles-row">
            {angles.map((a) => (
              <button
                key={a.id}
                className={`li-angle-chip ${chosenAngleId === a.id ? "li-angle-chip-active" : ""}`}
                onClick={() => pickAngle(a)}
                disabled={isDisabled}
                title={a.hint}
                type="button"
              >
                {a.label}
                {a.hint && <span className="li-angle-hint">{a.hint}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Generated comment (editable) + regenerate */}
      {showCommentAssist && chosenAngleId && (
        <div className="li-comment-block">
          {commentStatus === "loading" && (
            <div className="card-summary card-summary-loading">
              <span className="spinner spinner-sm" /> Writing a comment…
            </div>
          )}
          {commentStatus === "error" && (
            <div className="li-post-error">Comment generation failed. Try Regenerate or a different angle.</div>
          )}
          {(commentStatus === "ready" || (commentStatus !== "loading" && comment)) && (
            <>
              <div className="li-comment-hdr">
                <span className="li-comment-label">Your comment (editable · highlight text to give feedback)</span>
                <span className="li-comment-meta">{comment.length} chars</span>
              </div>
              {/* Highlight-to-feedback: select text inside the comment → 💬
                  Feedback pill → note → POST /api/feedback. Closes the loop
                  (item_type "comment"). Replaces the old prefill-chat button. */}
              <FeedbackCapture
                itemType="comment"
                leadName={card.lead_name}
                leadCompany={card.company}
                onSubmitted={onFeedbackSubmitted}
              >
                <textarea
                  className="li-comment-edit"
                  value={comment}
                  rows={Math.max(3, Math.min(8, Math.ceil((comment.length || 1) / 70)))}
                  onChange={(e) => setComment(e.target.value)}
                />
              </FeedbackCapture>
              <div className="li-comment-row">
                {/* No angle to regenerate from when the operator is writing their own (item 7). */}
                {chosenAngleId !== "custom" && (
                  <button className="btn" onClick={regenerate} disabled={isDisabled || commentStatus === "loading"} type="button">
                    ↻ Regenerate
                  </button>
                )}
                <button
                  className="btn primary"
                  onClick={commentOnLinkedIn}
                  disabled={isDisabled || !comment.trim()}
                  type="button"
                  title="Opens the post in a new tab and copies your comment"
                >
                  ↗ Comment on LinkedIn
                </button>
              </div>
            </>
          )}
        </div>
      )}

        {/* Ask/feedback conversation — appends into the scroll area (never
            pinned), exactly like the post-creation card's thread. */}
        {askMsgs.length > 0 && (
          <div className="fb-thread" ref={askThreadRef}>
            {askMsgs.map((m, i) => (
              <div key={i} className={`fb-bub fb-bub-${m.role}`}>{m.text}</div>
            ))}
            {askBusy && <div className="fb-bub fb-bub-assistant"><span className="spinner spinner-sm" /> Thinking…</div>}
          </div>
        )}
      </div>{/* /.card-scroll */}

      {/* ── Sticky footer: the CONSISTENT card grammar (Kunal 2026-06-30) ──
          Same on every card type: the ask/feedback text box + the CTAs. */}
      <div className="card-foot">
        {skipping ? (
          <SkipReason onConfirm={submitSkip} onCancel={() => setSkipping(false)} disabled={isDisabled} />
        ) : (
          <>
            <div className="fbrow">
              <input
                type="text"
                className="fbrow-input"
                placeholder="Ask about this task, or give feedback…"
                value={askInput}
                disabled={askBusy}
                onChange={(e) => setAskInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); sendAsk(askInput); } }}
                autoComplete="off"
              />
              <button type="button" className="fb-send" onClick={() => sendAsk(askInput)} disabled={askBusy || !askInput.trim()} aria-label="Send">
                {askBusy ? <span className="spinner spinner-sm" /> : "→"}
              </button>
            </div>
            <div className="actions">
              <button className="btn primary" disabled={isDisabled} onClick={() => onAction(card.id, "done")}>✓ Mark Done</button>
              {postUrl && (
                <a className="btn btn-secondary" href={postUrl} target="_blank" rel="noopener noreferrer">↗ Open on LinkedIn</a>
              )}
              <button className="btn btn-ghost" disabled={isDisabled} onClick={() => (FEATURES.skipReason ? setSkipping(true) : onAction(card.id, "skip"))}>Skip</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// CONNECTIONS-SENT CARD  (Kunal 2026-07-07)
// A single digest step in the queue. Ported from the approved mockup
// (sidekick-ui-mockups-demo/connection-requests-sent.html) into the app's
// native card grammar: shared .sk-card chrome (scroll area + sticky footer),
// the DM-Serif count headline, and an inner-scroll list (only the list
// scrolls — the headline + CTA stay put). ONE orange CTA ("Mark as done",
// resets the count); the feedback box flags a wrong lead → excluded.
// Public facts only (name, title, company, LinkedIn) — no internal signal.
// ═══════════════════════════════════════════════════════════════════
function ConnectionsSentCard({ conn, onMarkDone, onDefer, onExcludeLead }) {
  const count = conn?.count || 0;
  const leads = Array.isArray(conn?.leads) ? conn.leads : [];
  const more = Math.max(0, count - leads.length);
  const word = count === 1 ? "connection request has gone out" : "connection requests have gone out";

  const [busy, setBusy] = useState(false);
  const [fbInput, setFbInput] = useState("");
  const [fbMsgs, setFbMsgs] = useState([]);
  const [fbBusy, setFbBusy] = useState(false);
  const threadRef = useRef(null);
  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [fbMsgs, fbBusy]);

  async function markDone() {
    if (busy) return;
    setBusy(true);
    await onMarkDone(); // parent hides the card on success (component unmounts)
    setBusy(false);
  }

  async function sendFeedback(text) {
    const v = (text || "").trim();
    if (!v || fbBusy) return;
    setFbInput("");
    setFbMsgs((m) => [...m, { role: "user", text: v }]);
    setFbBusy(true);
    // Map free text → a lead in the list (case-insensitive name mention).
    const lower = v.toLowerCase();
    const named = leads.find((l) => l.name && lower.includes(l.name.toLowerCase()));
    let reply;
    if (named) {
      const res = await onExcludeLead({ leadName: named.name, linkedin: named.linkedin });
      reply = res && res.excluded
        ? `Got it — dropped ${named.name}, and told the ranking to stop surfacing them for future outreach.`
        : `Got it — noted ${named.name} as off. I'll keep them out of future picks.`;
    } else {
      reply = "Got it — noted. Tell me the person's name and I'll drop them from this list and future outreach.";
    }
    setFbMsgs((m) => [...m, { role: "assistant", text: reply }]);
    setFbBusy(false);
  }

  return (
    <div className="card card-stack sk-card entering">
      <div className="card-scroll">
        <div className="card-header">
          <span className="card-type card-type-movement">Connection requests · sent</span>
        </div>

        {/* Headline count — the number reads at a glance (DM-Serif), the label stays quiet. */}
        <div className="conn-count">
          <span className="conn-num">{count}</span>
          <span className="conn-word">{word}</span>
        </div>
        <div className="conn-sub">
          Sent on your behalf since you last marked this done. Flag anyone who's off in the box below.
        </div>

        {/* Inner-scroll window — only the list scrolls (fixed height), so the
            headline + CTA never move. */}
        <div className="conn-window">
          <div className="conn-winhead">
            <span className="conn-winhead-t">Sent requests</span>
          </div>
          <div className="conn-scroll">
            <div className="conn-list">
              {leads.map((l, i) => (
                <div className="conn-row" key={i}>
                  <div className="conn-name">
                    {l.linkedin
                      ? <a href={l.linkedin} target="_blank" rel="noopener noreferrer">{l.name || "Unknown"}</a>
                      : (l.name || "Unknown")}
                  </div>
                  {(l.title || l.company) && (
                    <div className="conn-rowsub">
                      {l.title}{l.title && l.company ? " · " : ""}
                      {l.company
                        ? <a
                            href={l.website || `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(l.company)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={companyHoverText(l)}
                          >{l.company}</a>
                        : null}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          {more > 0 && (
            <div className="conn-more">+ {more} more sent</div>
          )}
        </div>

        {/* Feedback thread appends into the scroll area (never pinned). */}
        {fbMsgs.length > 0 && (
          <div className="fb-thread" ref={threadRef}>
            {fbMsgs.map((m, i) => (
              <div key={i} className={`fb-bub fb-bub-${m.role}`}>{m.text}</div>
            ))}
            {fbBusy && <div className="fb-bub fb-bub-assistant"><span className="spinner spinner-sm" /> …</div>}
          </div>
        )}
      </div>

      {/* Sticky footer — same grammar as every card: feedback box + ONE CTA. */}
      <div className="card-foot">
        <div className="fbrow">
          <input
            type="text"
            className="fbrow-input"
            placeholder="Someone off? Tell me who and I'll drop them"
            value={fbInput}
            disabled={fbBusy}
            onChange={(e) => setFbInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); sendFeedback(fbInput); } }}
            autoComplete="off"
          />
          <button type="button" className="fb-send" onClick={() => sendFeedback(fbInput)} disabled={fbBusy || !fbInput.trim()} aria-label="Send">
            {fbBusy ? <span className="spinner spinner-sm" /> : "→"}
          </button>
        </div>
        <div className="actions">
          <button className="btn primary" disabled={busy} onClick={markDone}>
            {busy ? <><span className="spinner spinner-sm" /> Marking…</> : "✓ Mark as done"}
          </button>
          {/* Secondary defer — matches every card's footer grammar. Hides the card
              for this session WITHOUT resetting the count (Mark as done is the only
              thing that resets). Kunal: "the bottom stays the same." */}
          <button className="btn btn-ghost" disabled={busy} onClick={() => onDefer && onDefer()}>
            Skip · remind me later
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// DMS-SENT CARD — sibling of ConnectionsSentCard, for DMs that have gone out.
// Same grammar/layout; each row shows which DM step (DM1/2/3) landed.
// ═══════════════════════════════════════════════════════════════════
function DmsSentCard({ dms, onMarkDone, onDefer, onExcludeLead }) {
  const count = dms?.count || 0;
  const leads = Array.isArray(dms?.leads) ? dms.leads : [];
  const more = Math.max(0, count - leads.length);
  const word = count === 1 ? "DM has gone out" : "DMs have gone out";

  const [busy, setBusy] = useState(false);
  const [fbInput, setFbInput] = useState("");
  const [fbMsgs, setFbMsgs] = useState([]);
  const [fbBusy, setFbBusy] = useState(false);
  const threadRef = useRef(null);
  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [fbMsgs, fbBusy]);

  async function markDone() {
    if (busy) return;
    setBusy(true);
    await onMarkDone();
    setBusy(false);
  }

  async function sendFeedback(text) {
    const v = (text || "").trim();
    if (!v || fbBusy) return;
    setFbInput("");
    setFbMsgs((m) => [...m, { role: "user", text: v }]);
    setFbBusy(true);
    const lower = v.toLowerCase();
    const named = leads.find((l) => l.name && lower.includes(l.name.toLowerCase()));
    let reply;
    if (named) {
      const res = await onExcludeLead({ leadName: named.name, linkedin: named.linkedin });
      reply = res && res.excluded
        ? `Got it — dropped ${named.name}, and told the ranking to stop surfacing them for future outreach.`
        : `Got it — noted ${named.name} as off. I'll keep them out of future picks.`;
    } else {
      reply = "Got it — noted. Tell me the person's name and I'll drop them from this list and future outreach.";
    }
    setFbMsgs((m) => [...m, { role: "assistant", text: reply }]);
    setFbBusy(false);
  }

  return (
    <div className="card card-stack sk-card entering">
      <div className="card-scroll">
        <div className="card-header">
          <span className="card-type card-type-movement">DMs · sent</span>
        </div>

        <div className="conn-count">
          <span className="conn-num">{count}</span>
          <span className="conn-word">{word}</span>
        </div>
        <div className="conn-sub">
          Sent on your behalf since you last marked this done. Flag anyone who's off in the box below.
        </div>

        <div className="conn-window">
          <div className="conn-winhead">
            <span className="conn-winhead-t">DMs sent</span>
          </div>
          <div className="conn-scroll">
            <div className="conn-list">
              {leads.map((l, i) => (
                <div className="conn-row" key={i}>
                  <div className="conn-name">
                    {l.linkedin
                      ? <a href={l.linkedin} target="_blank" rel="noopener noreferrer">{l.name || "Unknown"}</a>
                      : (l.name || "Unknown")}
                    {l.dm_step ? <span className="conn-step"> · DM{l.dm_step}</span> : null}
                  </div>
                  {(l.title || l.company) && (
                    <div className="conn-rowsub">
                      {l.title}{l.title && l.company ? " · " : ""}
                      {l.company
                        ? <a
                            href={l.website || `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(l.company)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={companyHoverText(l)}
                          >{l.company}</a>
                        : null}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          {more > 0 && (
            <div className="conn-more">+ {more} more sent</div>
          )}
        </div>

        {fbMsgs.length > 0 && (
          <div className="fb-thread" ref={threadRef}>
            {fbMsgs.map((m, i) => (
              <div key={i} className={`fb-bub fb-bub-${m.role}`}>{m.text}</div>
            ))}
            {fbBusy && <div className="fb-bub fb-bub-assistant"><span className="spinner spinner-sm" /> …</div>}
          </div>
        )}
      </div>

      <div className="card-foot">
        <div className="fbrow">
          <input
            type="text"
            className="fbrow-input"
            placeholder="Someone off? Tell me who and I'll drop them"
            value={fbInput}
            disabled={fbBusy}
            onChange={(e) => setFbInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); sendFeedback(fbInput); } }}
            autoComplete="off"
          />
          <button type="button" className="fb-send" onClick={() => sendFeedback(fbInput)} disabled={fbBusy || !fbInput.trim()} aria-label="Send">
            {fbBusy ? <span className="spinner spinner-sm" /> : "→"}
          </button>
        </div>
        <div className="actions">
          <button className="btn primary" disabled={busy} onClick={markDone}>
            {busy ? <><span className="spinner spinner-sm" /> Marking…</> : "✓ Mark as done"}
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => onDefer && onDefer()}>
            Skip · remind me later
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// QUEUE INDICATOR
// Shown below the visible top card. Tells operator how many tasks are
// queued behind + breakdown by type so they know what's coming next
// without seeing all the detail.
// ═══════════════════════════════════════════════════════════════════
function QueueIndicator({ count, breakdown }) {
  const chips = [
    breakdown.batch     > 0 && { icon: "🤝", label: "daily batch" },
    breakdown.movements > 0 && { icon: "📈", label: `${breakdown.movements} movement${breakdown.movements > 1 ? "s" : ""}` },
    breakdown.top       > 0 && { icon: "🎯", label: `${breakdown.top} top lead${breakdown.top > 1 ? "s" : ""}` },
    breakdown.comments  > 0 && { icon: "💬", label: `${breakdown.comments} LinkedIn` },
    breakdown.ga        > 0 && { icon: "🌐", label: `${breakdown.ga} site visit${breakdown.ga > 1 ? "s" : ""}` },
    breakdown.other     > 0 && { icon: "·",  label: `${breakdown.other} other` },
  ].filter(Boolean);

  return (
    <div className="queue-indicator">
      <div className="queue-stack-visual" aria-hidden="true">
        <div className="queue-card-ghost queue-card-ghost-1" />
        <div className="queue-card-ghost queue-card-ghost-2" />
      </div>
      <div className="queue-text">
        <div className="queue-count">{count} more queued</div>
        {chips.length > 0 && (
          <div className="queue-breakdown">
            {chips.map((c, i) => (
              <span key={i} className="queue-chip">
                <span className="queue-chip-icon">{c.icon}</span>
                {c.label}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Compact engagement count: 0-999 as-is, 1.4k for thousands (Kunal Jun16).
function fmtCount(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "";
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}k`;
}

// ─── Author identity line (Kunal Jun16) ─────────────────────────
// Public-only "Name — Title — Company" string handed to the per-post
// chatbot as author context. NEVER includes the internal signal/score.
function postAuthorLine(card) {
  return [
    card.lead_name || null,
    card.lead_title || null,
    card.company ? (card.movement_type === "Exited" ? `Ex-${card.company}` : card.company) : null,
  ].filter(Boolean).join(" — ");
}

// ═══════════════════════════════════════════════════════════════════
// SKIP REASON PROMPT (Kunal Jun16)
// Replaces the action buttons when the exec hits Skip. One-tap reason
// chips fire the skip immediately; a typed note + Skip does the same.
// "Keep it super simple" — no required field, Cancel backs out.
// ═══════════════════════════════════════════════════════════════════
const SKIP_REASONS = ["Not relevant", "Too complex", "Wrong audience", "Already engaged"];
function SkipReason({ onConfirm, onCancel, disabled }) {
  const [note, setNote] = useState("");
  return (
    <div className="skip-reason">
      <div className="skip-reason-q">Why skip this? <span className="skip-reason-opt">(optional, tunes your feed)</span></div>
      <div className="skip-reason-chips">
        {SKIP_REASONS.map((r) => (
          <button key={r} type="button" className="skip-chip" disabled={disabled} onClick={() => onConfirm(r)}>
            {r}
          </button>
        ))}
      </div>
      <div className="skip-reason-row">
        <input
          type="text"
          className="skip-reason-input"
          placeholder="or type a reason…"
          value={note}
          disabled={disabled}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onConfirm(note); }}
          autoComplete="off"
        />
        <button type="button" className="btn danger" disabled={disabled} onClick={() => onConfirm(note)}>
          Skip
        </button>
        <button type="button" className="btn quiet" disabled={disabled} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// PER-POST CONTEXT CHATBOT (Kunal Jun16)
// Collapsed to one quiet line by default (single-focus card stays clean).
// Expands to a tiny inline chat scoped ONLY to this post — "simplify this
// for me", "who is this", "why does this matter". Hits /api/post-chat,
// which can ONLY discuss the post text it's handed (no leads, no tools).
// ═══════════════════════════════════════════════════════════════════
function PostChat({ post, author, cardId, leadName, leadCompany, leadContext }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState([]); // { role:'user'|'assistant', text }
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const threadRef = useRef(null);

  // Reset the thread whenever the focused card changes (component is reused
  // across cards by the single-card stack).
  useEffect(() => { setOpen(false); setMsgs([]); setInput(""); setBusy(false); }, [cardId]);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [msgs, busy]);

  // Smart feedback capture: when the bot decides the operator's message was
  // FEEDBACK about this task/feed (not a question), persist it durably as
  // item_type "task_feedback" so it's not lost. Best-effort; on success show a
  // quiet confirmation bubble. NOTE: this captures feedback — it does not auto-
  // suppress the feed (no silent task-nuking from a single read).
  async function captureFeedback(feedbackText) {
    try {
      const r = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_type: "task_feedback",
          feedback_text: feedbackText,
          quoted_span: (post || "").slice(0, 280),
          lead_name: leadName || "",
          lead_company: leadCompany || "",
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (d?.ok) {
        setMsgs((m) => [...m, { role: "assistant", text: "✓ Noted as feedback — it'll help tune your tasks." }]);
      }
    } catch { /* best-effort: capture failure shouldn't break the chat */ }
  }

  async function send(q) {
    const text = (q || "").trim();
    if (!text || busy) return;
    const history = msgs.slice(-6);
    setMsgs((m) => [...m, { role: "user", text }]);
    setInput("");
    setBusy(true);
    try {
      const r = await fetch("/api/post-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, post, author, history, leadContext }),
      });
      const data = await r.json();
      setMsgs((m) => [...m, { role: "assistant", text: data?.ok ? data.reply : (data?.error || "Couldn't answer that.") }]);
      // If the bot flagged this turn as feedback, durably capture it.
      if (data?.ok && data.feedback?.text) captureFeedback(data.feedback.text);
    } catch (e) {
      setMsgs((m) => [...m, { role: "assistant", text: "Network error — try again." }]);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="postchat-open" onClick={() => setOpen(true)}>
        💬 Ask about this task
      </button>
    );
  }

  return (
    <div className="postchat">
      <div className="postchat-hdr">
        <span className="postchat-title">Ask about this task</span>
        <button type="button" className="postchat-close" onClick={() => setOpen(false)} aria-label="Close">✕</button>
      </div>
      {msgs.length === 0 && (
        <div className="postchat-suggest">
          <button type="button" className="postchat-chip" disabled={busy} onClick={() => send("Simplify this for me.")}>Simplify this</button>
          <button type="button" className="postchat-chip" disabled={busy} onClick={() => send("Is this a good fit for our GTM, and what's the smartest way to engage?")}>Good fit + how to engage?</button>
          <button type="button" className="postchat-chip" disabled={busy} onClick={() => send("Draft a short, human comment I can leave on this post.")}>Draft a comment</button>
        </div>
      )}
      {msgs.length > 0 && (
        <div className="postchat-thread" ref={threadRef}>
          {msgs.map((m, i) => (
            <div key={i} className={`postchat-msg postchat-msg-${m.role}`}>{m.text}</div>
          ))}
          {busy && <div className="postchat-msg postchat-msg-assistant postchat-typing"><span className="spinner spinner-sm" /> Thinking…</div>}
        </div>
      )}
      <div className="postchat-inputwrap">
        <input
          type="text"
          className="postchat-input"
          placeholder="Ask anything about this task…"
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // Enter here ONLY sends the chat message. Stop it from bubbling to
              // the window-level card shortcut handler (which could otherwise act
              // on the focused task — e.g. if the input blurs on send).
              e.preventDefault();
              e.stopPropagation();
              send(input);
            }
          }}
          autoComplete="off"
        />
        <button type="button" className="postchat-send" disabled={busy || !input.trim()} onClick={() => send(input)} aria-label="Send">
          {busy ? <span className="spinner spinner-sm" /> : "→"}
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// POST CREATOR CARD — the "hooks engine" (Kunal Jun30 feedback standup)
//
// The second paid value prop: create an ORIGINAL LinkedIn post. One card,
// fixed footer, never auto-posts. Flow:
//   stage "hooks"   → pick 1 of 3 AI hooks (Trending / ICP / Competitor),
//                     or "skip — just record".
//   stage "compose" → record (Web Speech API, native — no dep) or type the
//                     gist → Generate.
//   stage "post"    → editable post in your voice + live char count +
//                     Copy / Open LinkedIn (manual).
// "Talk to your agent about this task" refines the draft live (mode:refine).
// Footer is ALWAYS the standard 3: Mark as done (primary/orange) · Skip ·
// Regenerate hooks. Orange is reserved for Mark as done only (Kunal: "make
// it gray, not orange" — every other surface here is neutral).
// ═══════════════════════════════════════════════════════════════════
function PostCreatorCard({ onCopied }) {
  // Faithful port of the approved mockup's create-a-post STAGE MACHINE:
  //   pick → record → generating → post. Each stage replaces the card
  //   (card-enter animation), one focused screen at a time — not a long
  //   accumulating scroll. Real hooks/voice/generation/refine under it.
  const [stage, setStage] = useState("pick");          // pick | record | generating | post
  const [recordMode, setRecordMode] = useState("voice"); // voice | type
  const [hooks, setHooks] = useState([]);
  const [hooksStatus, setHooksStatus] = useState("loading"); // loading | ready | error
  const [chosenHook, setChosenHook] = useState(null);
  const [notes, setNotes] = useState("");
  const [post, setPost] = useState("");
  const [genStatus, setGenStatus] = useState("idle");  // loading | ready | error (used in generating)
  const seenHooksRef = useRef([]);

  // ── voice: browser-native Web Speech API (no new dep; Chrome/Edge) ──
  const [listening, setListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const recogRef = useRef(null);
  const notesBaseRef = useRef("");
  const pendingGenRef = useRef(false);

  // ── refine ("tweak it") ──
  const [refineInput, setRefineInput] = useState("");
  const [refineBusy, setRefineBusy] = useState(false);

  useEffect(() => { loadHooks(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => {
    const SR = typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);
    setVoiceSupported(!!SR);
    if (!SR) setRecordMode("type");
    return () => { try { recogRef.current?.stop(); } catch {} };
  }, []);

  async function loadHooks(regenerate) {
    setHooksStatus("loading");
    try {
      const r = await fetch("/api/post-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "hooks", avoid: regenerate ? seenHooksRef.current.slice(-9) : [] }),
      });
      const d = await r.json();
      if (d?.ok && Array.isArray(d.hooks) && d.hooks.length) {
        setHooks(d.hooks);
        seenHooksRef.current = [...seenHooksRef.current, ...d.hooks.map(h => h.line)];
        setHooksStatus("ready");
      } else { setHooksStatus("error"); }
    } catch { setHooksStatus("error"); }
  }

  function enterRecord(hook) {
    setChosenHook(hook);
    setNotes("");
    setRecordMode(voiceSupported ? "voice" : "type");
    setStage("record");
  }

  // Web Speech API. Tap mic → listen; tap again → stop and shape it into a post
  // (matches the mockup: "Tap and just talk … tap again when you're done").
  function startVoice() {
    if (!voiceSupported || listening) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = "en-US"; rec.continuous = true; rec.interimResults = true;
    notesBaseRef.current = notes ? notes.trim() + " " : "";
    rec.onresult = (e) => {
      let finalT = "", interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalT += t; else interim += t;
      }
      if (finalT) notesBaseRef.current = notesBaseRef.current + finalT + " ";
      setNotes((notesBaseRef.current + interim).slice(0, 4000));
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => { setListening(false); if (pendingGenRef.current) { pendingGenRef.current = false; goGenerate(); } };
    recogRef.current = rec;
    try { rec.start(); setListening(true); } catch { setListening(false); }
  }
  function stopVoiceAndGen() {
    pendingGenRef.current = true;
    try { recogRef.current?.stop(); } catch { pendingGenRef.current = false; goGenerate(); }
  }

  async function goGenerate() {
    if (!chosenHook && !notes.trim()) return;
    setGenStatus("loading"); setStage("generating");
    try {
      const r = await fetch("/api/post-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "generate", hook: chosenHook, notes: notes.trim() }),
      });
      const d = await r.json();
      if (d?.ok && d.post) { setPost(d.post); setGenStatus("ready"); setStage("post"); }
      else setGenStatus("error");
    } catch { setGenStatus("error"); }
  }

  // Manual-first: copy the post, then open LinkedIn's composer (LinkedIn no
  // longer prefills share text — the copy is the real delivery). Never auto-posts.
  function copyAndOpen() {
    if (!post.trim()) return;
    copyToClipboard(post, () => onCopied?.("Post copied — paste it into LinkedIn"));
    if (typeof window !== "undefined") {
      window.open("https://www.linkedin.com/feed/?shareActive=true", "_blank", "noopener");
    }
  }

  // The footer "tweak it" input reworks the post in place (stays user-editable).
  async function refine() {
    const v = refineInput.trim();
    if (!v || refineBusy || !post.trim()) return;
    setRefineInput(""); setRefineBusy(true);
    try {
      const r = await fetch("/api/post-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "refine", post, feedback: v }),
      });
      const d = await r.json();
      if (d?.ok && d.post) setPost(d.post);
    } catch { /* leave the post as-is on a failed tweak */ }
    finally { setRefineBusy(false); }
  }

  function tryAnotherHook() {
    setPost(""); setNotes(""); setChosenHook(null); setGenStatus("idle");
    setRecordMode(voiceSupported ? "voice" : "type");
    setStage("pick");
  }

  const Badge = () => (
    <div className="pc-badge"><span className="pc-badge-dot" />Create · LinkedIn post</div>
  );
  const ChosenHook = () => chosenHook ? (
    <div className="pc-chosen"><span>Your hook</span>{chosenHook.line}</div>
  ) : null;

  return (
    <div className="card pc-card">
      {/* ── STAGE: pick a hook ── */}
      {stage === "pick" && (
        <div className="pc-stage card-enter" key="pick">
          <div className="pc-scroll">
            <Badge />
            <div className="pc-title">What do you want to post about?</div>
            <div className="pc-body">Pick a hook to start, or just hit record. A hook is a one-line seed so you&apos;re never staring at a blank page.</div>
            <div className="pc-step">Step 1 · pick a hook <span className="pc-step-opt">(optional)</span></div>
            {hooksStatus === "loading" && (
              <div className="pc-genwait"><span className="spinner" /> Pulling your hooks…</div>
            )}
            {hooksStatus === "error" && (
              <div className="pc-err">Couldn&apos;t load hooks. <button className="pc-textlink" onClick={() => loadHooks(false)} type="button">Try again</button></div>
            )}
            {hooksStatus === "ready" && (
              <>
                <div className="pc-grouplbl">Suggested from your signals</div>
                <div className="pc-hooks">
                  {hooks.map(h => (
                    <button key={h.id} type="button" className="pc-hook sig" onClick={() => enterRecord(h)}>
                      <span className="pc-htag">{h.tag}</span>
                      {h.line}
                    </button>
                  ))}
                </div>
                <button type="button" className="pc-reghooks" onClick={() => loadHooks(true)}>↻ show me different hooks</button>
              </>
            )}
            <button type="button" className="pc-skiprec" onClick={() => enterRecord(null)}>Skip — just let me record →</button>
          </div>
        </div>
      )}

      {/* ── STAGE: record (voice) or type ── */}
      {stage === "record" && (
        <div className="pc-stage card-enter" key="record">
          <div className="pc-scroll">
            <Badge />
            <ChosenHook />
            <div className="pc-step">Step 2 · record your thoughts</div>
            {recordMode === "voice" && voiceSupported ? (
              <div className="pc-recz">
                <button type="button" className={`pc-recbtn ${listening ? "live" : ""}`} onClick={() => (listening ? stopVoiceAndGen() : startVoice())}>🎙️</button>
                <div className="pc-rechint">
                  {listening ? "Listening… tap again when you're done." : "Tap and just talk. Ramble is fine, we'll shape it into your voice."}
                </div>
                {!!notes.trim() && <div className="pc-livetxt">{notes}</div>}
                <div className="pc-recor">prefer typing? <a onClick={() => setRecordMode("type")}>write it out instead</a></div>
              </div>
            ) : (
              <div className="pc-typez">
                <textarea
                  className="pc-typearea"
                  placeholder="Type the gist — rough is fine, we'll shape it into your voice."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  autoFocus
                />
                <button type="button" className="pc-btn pc-btn-primary" onClick={goGenerate} disabled={!chosenHook && !notes.trim()}>Shape it into a post →</button>
                {voiceSupported && <div className="pc-recor"><a onClick={() => setRecordMode("voice")}>← record instead</a></div>}
              </div>
            )}
          </div>
          <div className="pc-foot">
            <div className="pc-actions">
              <button type="button" className="pc-btn pc-btn-ghost" onClick={() => setStage("pick")}>← back to hooks</button>
            </div>
          </div>
        </div>
      )}

      {/* ── STAGE: generating ── */}
      {stage === "generating" && (
        <div className="pc-stage card-enter" key="generating">
          <div className="pc-scroll">
            <Badge />
            <ChosenHook />
            {!!notes.trim() && <div className="pc-transcript">“{notes.trim()}”</div>}
            <div className="pc-step">Step 3 · your post</div>
            {genStatus === "error" ? (
              <div className="pc-err">
                Couldn&apos;t write the post. <button className="pc-textlink" onClick={goGenerate} type="button">Try again</button>
                <button className="pc-textlink" onClick={() => setStage("record")} type="button" style={{ marginLeft: 10 }}>← back</button>
              </div>
            ) : (
              <div className="pc-genwait"><span className="spinner" />&nbsp; Writing it in your voice…</div>
            )}
          </div>
        </div>
      )}

      {/* ── STAGE: your post — edit + refine + copy/open ── */}
      {stage === "post" && (
        <div className="pc-stage card-enter" key="post">
          <div className="pc-scroll">
            <Badge />
            <div className="pc-step">Step 3 · your post — edit anything</div>
            <span className="pc-humanchip">✓ Written in your voice</span>
            <textarea className="pc-postedit" value={post} onChange={(e) => setPost(e.target.value)} />
            <div className="pc-charnote">{refineBusy ? "reworking in your voice…" : `${post.length} characters`}</div>
          </div>
          <div className="pc-foot">
            <div className="pc-fbrow">
              <input
                type="text"
                className="pc-fbinput"
                placeholder="Tweak it — shorter, punchier, add a stat…"
                value={refineInput}
                disabled={refineBusy}
                onChange={(e) => setRefineInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); refine(); } }}
                autoComplete="off"
              />
              <button type="button" className="pc-fbsend" onClick={refine} disabled={refineBusy || !refineInput.trim()} aria-label="Send">
                {refineBusy ? <span className="spinner spinner-sm" /> : "→"}
              </button>
            </div>
            <div className="pc-actions">
              <button type="button" className="pc-btn pc-btn-primary" onClick={copyAndOpen} disabled={!post.trim()}>Copy &amp; open LinkedIn ↗</button>
              <button type="button" className="pc-btn pc-btn-secondary" onClick={tryAnotherHook}>Try another hook</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Score tooltip helper ───────────────────────────────────────
// Composite score = baseScore (50 default or lead.Score) + decayed bonuses:
//   - GA visits (up to 20, decays over 7d)
//   - LinkedIn engagement (up to 15, decays over 14d)
//   - Top X ICP match (up to 30, decays over 30d)
// Movement leads are floored at 90 regardless of other signals.
function buildScoreTooltip(lead) {
  const parts = [`baseScore ${lead.base_score ?? 50}`];
  const bb = lead.bonus_breakdown || {};
  if (bb.li) parts.push(`+${bb.li} LinkedIn engagement`);
  if (bb.ga) parts.push(`+${bb.ga} GA visits`);
  if (bb.topx) parts.push(`+${bb.topx} ICP fit`);
  if (lead.has_movement) parts.push("(movement preempt: floored at 90)");
  return `Composite score ${lead.score}: ${parts.join(" ")}`;
}

// ═══════════════════════════════════════════════════════════════════
// MANUAL-WITH-ASSIST OUTREACH CARD (Kunal Batch-2 #18/#19)
// One in-flight Outreach lead. The exec performs the LinkedIn action by
// HAND — this card just hands them the right copy + opens the profile, then
// records the state. NO automation, NO Unipile auto-send.
// Renders by `nextAction.type`: connection / accept / dm / waiting.
// ═══════════════════════════════════════════════════════════════════
function ManualAssistCard({ item, onRecordConnectionSent, onMarkAccepted, onRecordDmSent, onCopied }) {
  const na = item.nextAction || {};
  const linkedinUrl = na.linkedinUrl || item.linkedin_url || "";
  const lead = item.lead_name || "this lead";
  // Profile URL tidy for display
  const profileShort = linkedinUrl.replace(/^https?:\/\/(www\.)?linkedin\.com\//, "linkedin.com/");

  function copyAndOpen(text, msg) {
    if (linkedinUrl) window.open(linkedinUrl, "_blank", "noopener,noreferrer");
    copyToClipboard(text || "", () => onCopied?.(msg));
  }
  // Standalone copy (no open) — parity with the comment flow's clean one-click copy.
  function copyText(text, msg) {
    copyToClipboard(text || "", () => onCopied?.(msg));
  }

  const header = (
    <div className="ma-hdr">
      <div className="ma-name">
        {lead}
        {item.title && <span className="ma-title"> · {item.title}</span>}
        {item.company && <span className="ma-company"> @ {item.company}</span>}
      </div>
      {item.signal && <div className="ma-context">{item.signal}</div>}
    </div>
  );

  if (na.type === "connection") {
    const note = na.messageToCopy || "";
    return (
      <div className="ma-card">
        {header}
        <div className="ma-step-label">Send connection request</div>
        {note ? (
          <>
            {/* Header mirrors the comment flow's copybox (label + char count). */}
            <div className="ma-copy-hdr">
              <span className="ma-copy-label">Connection note (copy &amp; paste)</span>
              <span className="ma-copy-meta">{note.length} chars</span>
            </div>
            <div className="ma-copybox">{note}</div>
          </>
        ) : (
          <div className="ma-copybox ma-copybox-empty">No connection note — send without one.</div>
        )}
        <div className="ma-ctas">
          {/* Standalone copy (parity with the comment flow's clean copy). */}
          {note && (
            <button className="btn" onClick={() => copyText(note, "Note copied — paste it in LinkedIn")} type="button">
              ⧉ Copy note
            </button>
          )}
          <button className="btn primary" onClick={() => copyAndOpen(note, "Note copied — paste it in LinkedIn")} type="button">
            ↗ Copy &amp; open LinkedIn
          </button>
          <button className="btn" onClick={() => onRecordConnectionSent(item.id)} type="button">
            Mark connection sent
          </button>
        </div>
      </div>
    );
  }

  // "accept" boxes are intentionally NOT rendered — Unipile flags
  // connection acceptance automatically, so asking the operator to
  // confirm it by hand is dead UI. (Parent also filters these out;
  // this is defense-in-depth. The mark-connected proxy stays wired
  // for the chat orchestrator / future automation.)
  if (na.type === "accept") return null;

  if (na.type === "dm") {
    const step = na.step;
    const dm = na.messageToCopy || "";
    return (
      <div className="ma-card">
        {header}
        <div className="ma-step-label">DM{step} to {lead}</div>
        {dm ? (
          <>
            <div className="ma-copy-hdr">
              <span className="ma-copy-label">DM{step} (copy &amp; paste)</span>
              <span className="ma-copy-meta">{dm.length} chars</span>
            </div>
            <div className="ma-copybox">{dm}</div>
          </>
        ) : (
          <div className="ma-copybox ma-copybox-empty">No DM{step} text generated.</div>
        )}
        <div className="ma-ctas">
          {dm && (
            <button className="btn" onClick={() => copyText(dm, `DM${step} copied — paste it in LinkedIn`)} type="button">
              ⧉ Copy DM
            </button>
          )}
          <button className="btn primary" onClick={() => copyAndOpen(dm, `DM${step} copied — paste it in LinkedIn`)} type="button">
            ↗ Copy &amp; open LinkedIn
          </button>
          <button className="btn" onClick={() => onRecordDmSent(item.id, step)} type="button">
            Mark DM{step} sent
          </button>
        </div>
      </div>
    );
  }

  if (na.type === "waiting") {
    return (
      <div className="ma-card ma-card-waiting">
        {header}
        <div className="ma-waiting">DM{na.step} scheduled — due {na.dueDate || "soon"}</div>
      </div>
    );
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════
// DAILY LINKEDIN BATCH CARD
// The flagship: 5 highest-scored leads with pre-generated AI connection
// notes + 3-DM sequences. One meta-card collapsed; expands inline into
// per-lead BatchLeadCards on "Review one-by-one".
// ═══════════════════════════════════════════════════════════════════
function DailyBatchCard({
  batch, expanded, onToggleExpand, onDefer,
  onSendAll, onSkipAll, onSendOne, onSkipOne, onEditField,
  editingDraft, setEditingDraft, onFeedbackSubmitted,
}) {
  const count = batch.leads?.length || 0;
  // Per-batch send mode. Default "manual" — the team sends by hand (execs).
  // "auto" → SignalScope's cron sends the connection + DMs via LinkedIn.
  const [sendMode, setSendMode] = useState("manual");
  if (count === 0) return null;

  const totalConnChars = (batch.leads || []).reduce((s, l) => s + (l.connection_note?.length || 0), 0);
  const avgConnChars = Math.round(totalConnChars / count);

  // One-at-a-time queue: this card renders as the FOCUSED step. "Later"
  // defers it to the back of the queue (hidden when it's the only step).
  return (
    <div className="batch-card">
      <div className="batch-hdr">
        <div className="batch-hdr-l">
          <span className="batch-icon">🤝</span>
          <div>
            <div className="batch-title">Daily LinkedIn batch · {count} ready</div>
            <div className="batch-sub">
              Top {count} highest-scored Veloka leads · AI-personalized connection notes + 3-DM sequences · avg {avgConnChars} chars
            </div>
          </div>
        </div>
        {onDefer && (
          <button className="batch-later-btn" onClick={onDefer} type="button" title="Come back to this — show the next task">
            Later →
          </button>
        )}
      </div>

      {/* Send-mode toggle (per-batch). Default Manual — the team sends by
          hand. Auto hands the send off to SignalScope's LinkedIn cron. */}
      <div className="batch-sendmode" role="radiogroup" aria-label="Send mode">
        <button
          type="button"
          className={`batch-sendmode-opt ${sendMode === "manual" ? "is-active" : ""}`}
          role="radio"
          aria-checked={sendMode === "manual"}
          onClick={() => setSendMode("manual")}
        >
          ✋ Manual (I'll send)
        </button>
        <button
          type="button"
          className={`batch-sendmode-opt ${sendMode === "auto" ? "is-active" : ""}`}
          role="radio"
          aria-checked={sendMode === "auto"}
          onClick={() => setSendMode("auto")}
        >
          🤖 Auto (send for me)
        </button>
      </div>
      <div className="batch-sendmode-explainer">
        {sendMode === "manual"
          ? "You'll copy each message and send the connection + DMs by hand on LinkedIn."
          : "SignalScope sends the connection request + DMs automatically via LinkedIn."}
      </div>

      {/* item 3: two primaries only. "Review one-by-one" is demoted to a
          quieter inline text toggle below the primary row, not a third
          equal-weight button. */}
      <div className="batch-ctas">
        <button className="btn primary" onClick={() => onSendAll(sendMode)}>
          ▶ Send all {count}
        </button>
        <button className="btn danger" onClick={onSkipAll}>
          ⏭ Skip today
        </button>
      </div>
      <button className="batch-review-toggle" onClick={onToggleExpand} type="button">
        {expanded ? "▼ Hide reviews" : "👀 Review one-by-one"}
      </button>

      {expanded && (
        <div className="batch-expanded">
          {batch.leads.map((lead, idx) => (
            <BatchLeadCard
              key={lead.id}
              lead={lead}
              index={idx + 1}
              total={count}
              onSend={() => onSendOne(lead.id, sendMode)}
              onSkip={() => onSkipOne(lead.id)}
              onEdit={(field, newText) => onEditField(lead.id, field, newText)}
              editingDraft={editingDraft}
              setEditingDraft={setEditingDraft}
              onFeedbackSubmitted={onFeedbackSubmitted}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// BATCH LEAD CARD
// One lead from a Daily LinkedIn Batch, expanded for review.
// Shows the lead's "why now" as CLEAN BULLETS (parsed from rich signal
// data, not raw text dump), a clickable post link if available, and all
// 4 pre-generated messages with char counts (green if under limit).
// Click any message to inline-edit; saves on blur/cmd+enter.
// ═══════════════════════════════════════════════════════════════════
function BatchLeadCard({ lead, index, total, onSend, onSkip, onEdit, editingDraft, setEditingDraft, onFeedbackSubmitted }) {
  // Map a batch field key to the feedback item_type taxonomy.
  // connection_note → "connection_note"; dm1/dm2/dm3 → "dm".
  const fieldToItemType = (key) => (key === "connection_note" ? "connection_note" : "dm");
  // why_reasons is now clean newline-separated bullets (server-side parsed
  // from raw Signal text via buildLeadBrief → briefToUiBullets).
  // Fall back to splitting on " · " for legacy records.
  const reasons = (lead.why_reasons || "")
    .split(/\n+/)
    .flatMap(line => line.includes(" · ") ? line.split(" · ") : [line])
    .map(s => s.trim())
    .filter(Boolean);

  const FIELDS = [
    { key: "connection_note", label: "Connection note", airtableField: "Generated Connection Note", limit: 300, sentLabel: "sent on accept" },
    { key: "dm1", label: "DM 1", airtableField: "Generated DM 1", limit: 8000, sentLabel: "sent 2d after connect" },
    { key: "dm2", label: "DM 2", airtableField: "Generated DM 2", limit: 8000, sentLabel: "sent 3d after DM 1" },
    { key: "dm3", label: "DM 3", airtableField: "Generated DM 3", limit: 8000, sentLabel: "sent 4d after DM 2" },
  ];

  // Tidy the LinkedIn profile URL display
  const profileUrl = lead.linkedin_url || "";
  const profileShort = profileUrl.replace(/^https?:\/\/(www\.)?linkedin\.com\//, "linkedin.com/");

  return (
    <div className="batch-lead">
      <div className="batch-lead-hdr">
        <div className="batch-lead-name">
          <span className="batch-lead-index">{index}/{total}</span>
          {lead.lead_name}
          {lead.title && <span className="batch-lead-title"> · {lead.title}</span>}
          {lead.company && <span className="batch-lead-company"> @ {lead.company}</span>}
        </div>
        <div className="batch-lead-score">
          {/* item 7 (Kunal Jun12): numeric score display removed; the Movement
              badge stays (it's a category flag, not a numeric score). */}
          {lead.composite_score >= 1000 && <span className="badge-movement">🔥 Movement</span>}
        </div>
      </div>

      {/* Clean why-now bullets — replaces the raw signal blob */}
      {reasons.length > 0 && (
        <div className="batch-lead-reasons">
          {reasons.map((r, i) => <div key={i} className="batch-reason">→ {r}</div>)}
        </div>
      )}

      {/* AI personalization warning — shows when one or more messages
          fell back to deterministic template (AI generation failed
          silently). Server-side flag from /api/sidekick/auto-batch/pending.
          When this fires, all 4 messages for that lead are the SAME
          template every other lead received — only first_name + company
          differ. Operator should review the AI Debug field on the
          Outreach record in Airtable to diagnose the root cause, or
          hit /api/sidekick/diagnose-ai for a live OpenAI test. */}
      {lead.ai_any_fallback && (
        <div className={`batch-ai-warning ${lead.ai_all_fallback ? "batch-ai-warning-severe" : ""}`}>
          <div className="batch-ai-warning-title">
            {lead.ai_all_fallback ? "⚠️ All messages used the fallback template — not personalized" : "⚠️ Some messages fell back to template"}
          </div>
          <div className="batch-ai-warning-detail">
            {lead.ai_all_fallback
              ? "AI generation failed for this lead. The connection note + 3 DMs are the same template every other un-personalized lead received. Hit /api/sidekick/diagnose-ai (with ?key=CRON_SECRET) to test OpenAI, or check the AI Debug field on this Outreach record in Airtable for the raw error."
              : `Fell back: ${["connection_note","dm1","dm2","dm3"].filter(k => lead.ai_fallback_flags?.[k]).join(", ")}. The rest were AI-personalized.`}
          </div>
        </div>
      )}

      {/* Profile + post links — separate clickable chips */}
      <div className="batch-lead-links">
        {profileUrl && (
          <a className="batch-link-chip" href={profileUrl} target="_blank" rel="noopener noreferrer">
            in {profileShort}
          </a>
        )}
        {lead.post_url && (
          <a className="batch-link-chip" href={lead.post_url} target="_blank" rel="noopener noreferrer">
            🔗 view post
          </a>
        )}
      </div>

      <div className="batch-msgs">
        {FIELDS.map(({ key, label, airtableField, limit, sentLabel }) => {
          const text = lead[key] || "";
          const isEditing = editingDraft?.recordId === lead.id && editingDraft?.field === airtableField;
          const overLimit = text.length > limit;
          return (
            <div key={key} className="batch-msg">
              <div className="batch-msg-hdr">
                <span className="batch-msg-label">{label}</span>
                <span className="batch-msg-meta">
                  <span className={overLimit ? "char-over" : "char-ok"}>{text.length} chars</span>
                  <span className="batch-msg-sent"> · {sentLabel}</span>
                  {/* item 2: visible edit affordance so it's obvious the
                      field is editable (was click-to-edit but undiscoverable) */}
                  {!isEditing && (
                    <button
                      className="batch-msg-affordance"
                      onClick={() => setEditingDraft({ recordId: lead.id, field: airtableField, text })}
                      title="Edit this message"
                      type="button"
                    >✎ edit</button>
                  )}
                  {/* feedback loop: highlight the message text below to get a
                      💬 Feedback pill → note → POST /api/feedback. Replaces
                      the old prefill-chat button (which no generator read). */}
                  <span className="batch-msg-affordance batch-msg-fbhint" title="Highlight any part of the message below to give feedback">💬 highlight to give feedback</span>
                </span>
              </div>
              {/* item_type: connection_note for the note, dm for DM1/2/3. */}
              <FeedbackCapture
                itemType={fieldToItemType(key)}
                leadName={lead.lead_name}
                leadCompany={lead.company}
                onSubmitted={onFeedbackSubmitted}
              >
                {isEditing ? (
                  <textarea
                    className="batch-msg-edit"
                    defaultValue={text}
                    autoFocus
                    rows={Math.max(2, Math.min(8, Math.ceil(text.length / 80)))}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== text) onEdit(airtableField, v);
                      setEditingDraft(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.target.value = text;
                        setEditingDraft(null);
                      }
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.target.blur();
                      }
                    }}
                  />
                ) : (
                  <div
                    className="batch-msg-text"
                    onClick={() => {
                      // If the operator just highlighted text (to give
                      // feedback), don't hijack the click into edit mode —
                      // that would unmount the selection + the pill.
                      const sel = window.getSelection?.();
                      if (sel && !sel.isCollapsed && sel.toString().trim()) return;
                      setEditingDraft({ recordId: lead.id, field: airtableField, text });
                    }}
                    title="Click to edit · highlight to give feedback"
                  >
                    {text || <span className="batch-msg-empty">(empty — click to write)</span>}
                  </div>
                )}
              </FeedbackCapture>
            </div>
          );
        })}
      </div>

      <div className="batch-lead-ctas">
        <button className="btn primary" onClick={onSend}>✓ Send this lead</button>
        <button className="btn danger" onClick={onSkip}>⏭ Skip</button>
      </div>
    </div>
  );
}
