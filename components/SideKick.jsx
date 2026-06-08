"use client";

import { useEffect, useRef, useState, useCallback } from "react";

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
      if (!inWrap && !inPill && !inDock) { setOpen(false); setPill(null); }
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
    ? { left: "50%", bottom: 64, top: "auto" }
    : { left: pill?.x ?? 40, top: (pill?.y ?? 40) + 8 };

  return (
    <div
      ref={wrapRef}
      className="fb-capture"
    >
      {children}

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
        <div className={`fb-pop${docked ? " fb-pop-docked" : ""}`} style={popStyle}>
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
    </div>
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
  //   - `🔗` is a marker on its own — TopCallableCard prepends `→ ` in JSX
  //     so the reason text starts with bare `🔗`. Card stack mode's signal
  //     can have `→ 🔗` together; lookahead on `→` prevents splitting them.
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

export default function SideKick() {
  const [cards, setCards] = useState([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);
  const [leaving, setLeaving] = useState(new Set());
  const [toast, setToast] = useState("");

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

  // Session-only dismissals for top-callable cards. These items reference
  // Lead records (not Task records), so the standard /api/action handler
  // can't stamp them as Handled. Until a dedicated dismiss-callable
  // endpoint exists, dismissed top-callable leads are tracked here and
  // filtered out of the stack for the rest of the session. Reload resets.
  const [dismissedCallableIds, setDismissedCallableIds] = useState(new Set());

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
  const [batchLeaving, setBatchLeaving] = useState(new Set());
  const [batchExpanded, setBatchExpanded] = useState(new Set()); // batch IDs currently "Review one-by-one"
  // item 5: the daily batch card is collapsed to a compact single-line
  // entry by default so it doesn't compete with the unified task stack.
  // Click the compact row to open it. Resets on reload (session-only).
  const [batchCollapsed, setBatchCollapsed] = useState(true);
  const [editingDraft, setEditingDraft] = useState(null); // { recordId, field, text }
  const [batchGenerating, setBatchGenerating] = useState(false);

  // Top callable leads — curated by composite scoring on the server
  // (replaces old "any task with phone" filter). Refreshed on each feed poll.
  const [topCallable, setTopCallable] = useState([]);

  const fetchAutoBatches = useCallback(async () => {
    try {
      const r = await fetch("/api/auto-batch/pending", { cache: "no-store" });
      const data = await r.json();
      if (data.ok) setAutoBatches(data.batches || []);
    } catch {}
  }, []);

  const fetchTopCallable = useCallback(async () => {
    try {
      const r = await fetch("/api/top-leads-to-call?n=2", { cache: "no-store" });
      const data = await r.json();
      if (data.ok) setTopCallable(data.cards || []);
    } catch {}
  }, []);

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
      const r = await fetch(`/api/feed?limit=${FEED_LIMIT}`, { cache: "no-store" });
      const data = await r.json();
      if (data.ok) {
        setCards(data.cards || []);
        const n = typeof data.count === "number" ? data.count : (data.cards || []).length;
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
  const autoGenerateAttemptedRef = useRef(false);
  useEffect(() => {
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
    fetchTopCallable();
    loadHistory();
    const i = setInterval(() => {
      fetchFeed();
      fetchAutoBatches();
      fetchTopCallable();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(i);
  }, [fetchFeed, fetchAutoBatches, fetchTopCallable, loadHistory]);

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

  // ─── Chat auto-scroll on new message ────────────────────────────
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [messages]);

  // ─── Keyboard shortcuts for the focused top card (item A) ───────
  // Desktop ergonomics — act on the single visible card without reaching
  // for the mouse: Enter / D = Done, S = Skip. The 1/2/3 angle pick for a
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
      if (chatBusy || emailDraft) return;
      const top = topCardRef.current;
      if (!top) return;
      // Re-entry guard: ignore if the top card is already animating out
      // (prevents double-fire on rapid keypress / key-repeat).
      if (leavingRef.current && leavingRef.current.has(top.id)) return;
      const k = e.key;
      if (k === "Enter" || k === "d" || k === "D") {
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
  // all when both cards and topCallable are empty — this covers that path.
  useEffect(() => {
    if (cards.length === 0 && topCallable.length === 0) topCardRef.current = null;
  }, [cards, topCallable]);

  // ─── Lazy AI summary fetch ──────────────────────────────────────
  // When the visible top card changes (sticky pin advanced), fire a
  // single Haiku call to /api/summarize and cache the result. The
  // pendingSummariesRef guards against duplicate fetches during the
  // window between fetch start and setState completion.
  //
  // We resolve the top card here using the same priority order as the
  // render IIFE — keeping them in sync. This duplicates a few lines
  // but is cheaper than restructuring the whole component.
  useEffect(() => {
    if (cards.length === 0 && topCallable.length === 0) return;
    // Mirror the render-side stack composition to find the top card id.
    // Filter dismissed callable leads — same filter the render uses.
    const visibleCallable = topCallable.filter(l => !dismissedCallableIds.has(l.id));
    const topCallableCards = visibleCallable.map(lead => ({
      id: lead.id,
      task_type: "top_callable",
      score: lead.score,
      lead_name: lead.lead_name,
      lead_title: lead.lead_title,
      company: lead.company,
      signal: (lead.reasons || []).map(r => `→ ${r}`).join("\n\n"),
      reasons: lead.reasons || [],
      has_movement: lead.has_movement,
      movement_type: lead.movement_type,
    }));
    const tcKey = c => `${(c.lead_name || "").toLowerCase().trim()}|${(c.company || "").toLowerCase().trim()}`;
    const tcKeys = new Set(topCallableCards.map(tcKey).filter(k => k !== "|"));
    const merged = [...topCallableCards, ...cards.filter(c => !tcKeys.has(tcKey(c)))];
    if (merged.length === 0) return;

    const priorityOf = c => ({
      lead_movement: 0,
      top_callable: 1,
      top_x: 2,
      linkedin_engagement: 3,
      engagement: 4,
    })[c.task_type] ?? 5;
    merged.sort((a, b) => {
      const pa = priorityOf(a), pb = priorityOf(b);
      if (pa !== pb) return pa - pb;
      return (b.score || 0) - (a.score || 0);
    });

    // Resolve sticky top
    let target;
    if (stickyTopIdRef.current && merged.find(c => c.id === stickyTopIdRef.current)) {
      target = merged.find(c => c.id === stickyTopIdRef.current);
    } else {
      target = merged[0];
    }
    if (!target) return;

    // LinkedIn-engagement cards use the dedicated comment flow (item 1),
    // which fetches its own post brief via /api/comment-angles. Don't also
    // spend on an SDR summary it never displays.
    if (target.task_type === "linkedin_engagement") return;

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
  }, [cards, topCallable, dismissedCallableIds]);

  // ─── Lazy comment-angle fetch (item 1) ──────────────────────────
  // When the visible top card is a LinkedIn-engagement card, fetch the
  // 3 commenting angles once and cache by card.id. Mirrors the summary
  // lazy-fetch so we never spend tokens on cards the operator never sees.
  // Only the TOP card is considered (matches the single-card stack UX).
  const fetchCommentAngles = useCallback((card) => {
    if (!card || card.task_type !== "linkedin_engagement") return;
    if (commentData[card.id]) return;
    if (pendingCommentDataRef.current.has(card.id)) return;

    // Lazy-load learned comment prefs once per session (best-effort).
    if (!commentPrefsLoadedRef.current) refreshCommentPrefs();

    pendingCommentDataRef.current.add(card.id);
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

  // ─── Toast helper ───────────────────────────────────────────────
  function showToast(msg, ms = 2400) {
    setToast(msg);
    setTimeout(() => setToast(""), ms);
  }

  // ─── Action handler (Mark Done / Skip) ──────────────────────────
  // Two paths:
  //   1. Regular task cards (top_x, lead_movement, engagement,
  //      linkedin_engagement) → POST /api/action → SignalScope stamps
  //      the Task record with Handled At/As/Notes fields.
  //   2. Top-callable cards → the id references a LEAD record (from the
  //      Leads table), NOT a Task record. PATCHing /api/action on a
  //      Lead id would 422 (or 404). For now we dismiss them client-side
  //      and add the lead id to `dismissedCallableIds` so the next poll
  //      doesn't bring them back during this session. A persistent
  //      server-side dismissal would need a new endpoint that marks the
  //      lead's underlying movement/top_x tasks as handled — deferred.
  async function handleAction(taskId, action) {
    setLeaving((s) => new Set([...s, taskId]));

    // Is this a top-callable card? Check the merged feed.
    const isTopCallable = topCallable.some(l => l.id === taskId);
    if (isTopCallable) {
      setDismissedCallableIds(prev => new Set([...prev, taskId]));
      setTimeout(() => {
        // Clear sticky so next poll's top card promotes correctly
        if (stickyTopIdRef.current === taskId) {
          stickyTopIdRef.current = null;
        }
        setLeaving((s) => { const ns = new Set(s); ns.delete(taskId); return ns; });
      }, 300);
      showToast(action === "done" ? "Marked done ✓ (session-only)" : "Skipped (session-only)");
      return;
    }

    try {
      const r = await fetch("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, action }),
      });
      const data = await r.json();
      if (data.ok) {
        setTimeout(() => {
          setCards((c) => c.filter((card) => card.id !== taskId));
          setCount((n) => { const nn = Math.max(0, n - 1); countRef.current = nn; return nn; });
          setLeaving((s) => { const ns = new Set(s); ns.delete(taskId); return ns; });
          // Clear sticky so the next render picks the new top card from
          // the sorted stack (rather than waiting for next poll to re-resolve).
          if (stickyTopIdRef.current === taskId) {
            stickyTopIdRef.current = null;
          }
        }, 300);
        showToast(action === "done" ? "Marked done ✓" : "Skipped");
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
    showToast("Feedback saved — future drafts will use it.");
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
            <div className="avatar"><div className="dot" /></div>
            <div className="brand">
              <div className="brand-name">Side Kick</div>
              <div className="brand-sub">VELOKA · TASKS</div>
            </div>
          </div>
          <div className="hdr-r">
            <button
              className="hdr-action"
              onClick={() => handleGenerateBatch(true)}
              disabled={batchGenerating}
              title="Regenerate today's LinkedIn batch (replaces existing)"
            >
              {batchGenerating ? <><span className="spinner spinner-sm" /> Generating…</> : "↻ Regenerate batch"}
            </button>
            <div className="counter">
              <span className="count-num">{count}</span>
              <span style={{ color: "var(--t2)" }}>pending</span>
            </div>
          </div>
        </header>

        <div className="wip">
          <span className="wip-dot" />
          Email engine in development · LinkedIn DMs + tasks live
        </div>

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

        {!loading && !fetchError && cards.length === 0 && (
          <div className="empty">
            <div className="empty-check">✓</div>
            <div className="empty-title">All clear</div>
            <div>No tasks need your attention right now.</div>
          </div>
        )}

        {/* ─── DAILY LINKEDIN BATCH ─────────────────────────────
            Merges all pending_approval records into ONE batch card
            regardless of Batch ID. Reasoning: Batch ID is internal
            accounting (today's vs yesterday's, etc.) — the operator just
            wants to see "here's everything pending approval, act on it."
            If cleanup ever partially fails server-side (Airtable rate
            limit, etc.) we still render one unified card instead of
            confusing the user with two cards for the same daily batch.

            Dedup also runs here: same lead_name + company → render once.
            Server-side dedup catches most cases; this is defense-in-depth.
        */}
        {(() => {
          if (!autoBatches.length) return null;
          // Collect all leads across all batch groups
          const allLeads = autoBatches.flatMap(b => b.leads || []);
          // Dedup by record id first (just in case), then by name+company
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
          // Sort by composite score desc so highest priority leads surface first
          dedupedLeads.sort((a, b) => (b.composite_score || 0) - (a.composite_score || 0));
          // Build a single virtual batch with batch_id="all" — server interprets
          // "all" as a Status-only filter on send_all/skip_all
          const mergedBatch = {
            batch_id: "all",
            leads: dedupedLeads,
            count: dedupedLeads.length,
          };
          return (
            <DailyBatchCard
              key="merged-pending-batch"
              batch={mergedBatch}
              collapsed={batchCollapsed}
              onToggleCollapsed={() => setBatchCollapsed(v => !v)}
              expanded={batchExpanded.has("all")}
              onToggleExpand={() => {
                setBatchExpanded(prev => {
                  const next = new Set(prev);
                  if (next.has("all")) next.delete("all");
                  else next.add("all");
                  return next;
                });
              }}
              onSendAll={() => handleBatchAction("send_all", { batchId: "all" })}
              onSkipAll={() => handleBatchAction("skip_all", { batchId: "all" })}
              onSendOne={(recordId) => handleBatchAction("send_one", { recordId })}
              onSkipOne={(recordId) => handleBatchAction("skip_one", { recordId })}
              onEditField={(recordId, field, newText) => handleBatchAction("edit", { recordId, field, newText })}
              editingDraft={editingDraft}
              setEditingDraft={setEditingDraft}
              onFeedbackSubmitted={handleFeedbackSubmitted}
            />
          );
        })()}

        {/* ─── UNIFIED TASK STACK (Biscuit-style one-at-a-time) ─────
            Per May 20 client feedback ("check how it was for truffle"
            = the Biscuit prototype from the May 7 chat): one task in
            focus, action taken → next loads. No parallel sections
            cluttering the view.

            The top-leads-to-call items used to live in their own
            Section above the stack. We now fold them in as a new
            `top_callable` task type at the highest non-movement
            priority, so the operator works through ONE pipeline
            instead of jumping between sections. */}
        {!loading && !fetchError && (cards.length > 0 || topCallable.length > 0) && (() => {
          // Convert each top-callable lead into a card-shape so it
          // flows through the same Card component as movement / top_x
          // / etc. The `signal` field is joined from reasons[] so it
          // gets the same formatSignalText + ExpandableSignal treatment.
          // Drop any leads the operator dismissed this session — those
          // can't be persisted server-side yet (top-callable points to
          // Lead records, not Tasks) so we just hide them locally.
          const visibleCallable = topCallable.filter(l => !dismissedCallableIds.has(l.id));
          const topCallableCards = visibleCallable.map(lead => ({
            id: lead.id,
            task_type: "top_callable",
            score: lead.score,
            lead_name: lead.lead_name,
            lead_title: lead.lead_title,
            company: lead.company,
            lead_phone: lead.lead_phone,
            lead_phone_type: lead.lead_phone_type,
            lead_linkedin: lead.lead_linkedin,
            lead_email: lead.lead_email,
            needs_phone_enrich: lead.needs_phone_enrich,
            has_movement: lead.has_movement,
            movement_type: lead.movement_type,
            // Pre-join reasons into a single signal block. JSX no longer
            // prepends `→ ` since Card renders `card.signal` raw.
            signal: (lead.reasons || []).map(r => `→ ${r}`).join("\n\n"),
            reasons: lead.reasons || [],
            source: "top callable",
          }));

          // Merge with regular cards. Dedup by name+company so a lead
          // that's both top-callable AND has a top_x task only appears
          // once (top_callable wins — it's the more curated path).
          const topCallableKey = c => `${(c.lead_name || "").toLowerCase().trim()}|${(c.company || "").toLowerCase().trim()}`;
          const topCallableKeys = new Set(topCallableCards.map(topCallableKey).filter(k => k !== "|"));
          const filteredCards = cards.filter(c => !topCallableKeys.has(topCallableKey(c)));
          const allCards = [...topCallableCards, ...filteredCards];

          if (allCards.length === 0) { topCardRef.current = null; return null; }

          // Priority groups. top_callable sits just below movement
          // because phone-ready leads with high composite are the
          // highest-yield action an SDR can take.
          const movements   = allCards.filter(c => c.task_type === "lead_movement");
          const callable    = allCards.filter(c => c.task_type === "top_callable");
          const topLeads    = allCards.filter(c => c.task_type === "top_x");
          const liComments  = allCards.filter(c => c.task_type === "linkedin_engagement");
          const gaVisitors  = allCards.filter(c => c.task_type === "engagement");
          const accountedFor = new Set([
            ...movements.map(c => c.id),
            ...callable.map(c => c.id),
            ...topLeads.map(c => c.id),
            ...liComments.map(c => c.id),
            ...gaVisitors.map(c => c.id),
          ]);
          const other = allCards.filter(c => !accountedFor.has(c.id));

          const byScore = (a, b) => (b.score || 0) - (a.score || 0);
          const sortedStack = [
            ...movements.sort(byScore),
            ...callable.sort(byScore),
            ...topLeads.sort(byScore),
            ...liComments.sort(byScore),
            ...gaVisitors.sort(byScore),
            ...other.sort(byScore),
          ];

          if (sortedStack.length === 0) { topCardRef.current = null; return null; }

          // Sticky top — keep the same card visible until it's gone
          // from the feed (user actioned it OR server removed it).
          // Stored in a ref so polling doesn't swap the card mid-scroll.
          let topCard;
          const stickyStillValid = stickyTopIdRef.current && sortedStack.find(c => c.id === stickyTopIdRef.current);
          if (stickyStillValid) {
            topCard = sortedStack.find(c => c.id === stickyTopIdRef.current);
          } else {
            topCard = sortedStack[0];
            stickyTopIdRef.current = topCard.id;
          }
          const remaining = sortedStack.filter(c => c.id !== topCard.id);

          // Keep the focused-card ref fresh so the window-level keydown +
          // swipe handlers always act on the card actually on screen.
          topCardRef.current = { id: topCard.id, task_type: topCard.task_type };

          const breakdown = {
            movements: remaining.filter(c => c.task_type === "lead_movement").length,
            callable:  remaining.filter(c => c.task_type === "top_callable").length,
            top:       remaining.filter(c => c.task_type === "top_x").length,
            comments:  remaining.filter(c => c.task_type === "linkedin_engagement").length,
            ga:        remaining.filter(c => c.task_type === "engagement").length,
            other:     remaining.filter(c => !["lead_movement", "top_callable", "top_x", "linkedin_engagement", "engagement"].includes(c.task_type)).length,
          };

          const topIsFocused = focusLead && focusLead.lead_name === topCard.lead_name && focusLead.company === topCard.company;

          return (
            <div className="task-stack">
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
                    onAction={handleAction}
                    onSetFocus={handleSetFocus}
                    onFeedbackSubmitted={handleFeedbackSubmitted}
                    commentPrefs={commentPrefsRef}
                    isFocused={topIsFocused}
                    onCopied={(msg) => showToast(msg, 2600)}
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
                  />
                )}
              </SwipeCard>
              {remaining.length > 0 && <QueueIndicator count={remaining.length} breakdown={breakdown} />}
            </div>
          );
        })()}

        {/* Chat thread */}
        {historyLoaded && (
          <div className="chat-thread" ref={chatScrollRef}>
            {messages.map((m) => (
              <ChatBubble key={m.id} msg={m} />
            ))}
          </div>
        )}
      </main>

      {/* Sticky chat input */}
      <div className="chat-input-wrap">
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
        <div className="chat-input-inner">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(e); }}
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

      {/* pt4 V1: email draft modal — edit + copy, no send */}
      {emailDraft && (
        <EmailDraftModal
          draft={emailDraft}
          onChange={setEmailDraft}
          onClose={() => setEmailDraft(null)}
          onCopied={(what) => showToast(`${what} copied to clipboard`, 1800)}
        />
      )}

      <div className={`toast ${toast ? "show" : ""}`}>{toast}</div>
    </>
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
        <div className="email-modal-note">
          V1: edit then copy or open in your mail client. Sending from the app is coming in V2.
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

function Card({ card, leaving, enriching, subject, meta, summary, onAction, onEnrichPhone, onSetFocus, onDraftEmail, isFocused }) {
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

  // Type chip — small visual category indicator at the top.
  // Replaces the old section header (since stack mode merges all sections).
  const typeChip = ({
    lead_movement:       { icon: "📈", label: "Movement",     tone: "movement" },
    top_callable:        { icon: "📞", label: "Top to call",  tone: "callable" },
    linkedin_engagement: { icon: "💬", label: "LinkedIn",     tone: "li" },
    engagement:          { icon: "🌐", label: "Site visit",   tone: "ga" },
    top_x:               { icon: "🎯", label: "Top lead",     tone: "top" },
  })[card.task_type] || { icon: "·", label: "Task", tone: "default" };

  // Movement-specific badge (Hired/Promoted/Exited) — distinct from typeChip
  const movementBadge = card.movement_type ? ({
    Hired:    "🎉 New hire",
    Promoted: "📈 Promoted",
    Exited:   "👋 Exited",
  })[card.movement_type] : null;

  // Has either summary or raw signal to show?
  const hasSignal = !!card.signal;
  const summaryIsReady = summary && summary !== "loading" && summary !== "error";

  return (
    <div className={`card card-stack ${leaving ? "leaving" : "entering"}`}>
      {/* Type chip + score on top — small, low-noise */}
      <div className="card-header">
        <span className={`card-type card-type-${typeChip.tone}`}>
          <span className="card-type-icon">{typeChip.icon}</span>
          {typeChip.label}
        </span>
        {typeof card.score === "number" && card.score > 0 && (
          <span className="card-score-chip" title={`Composite score ${card.score}`}>
            {card.score}
          </span>
        )}
      </div>

      {/* Lead identity — name large, meta small */}
      <div className="card-name">{subject}</div>
      {meta && <div className="card-meta">{meta}</div>}

      {/* Movement badge — only for movement cards, sits below identity */}
      {movementBadge && <div className="card-movement-badge">{movementBadge}</div>}

      {/* Summary (AI-generated, default view) + View more data toggle.
          When summary is ready and showFullData is false, show the summary.
          When showFullData is true OR summary failed, show the raw
          structured signal via ExpandableSignal.
          Loading state: subtle placeholder so the card doesn't reflow. */}
      {hasSignal && (
        <div className="card-signal-block">
          {!showFullData && summary === "loading" && (
            <div className="card-summary card-summary-loading">
              <span className="spinner spinner-sm" /> Generating SDR summary…
            </div>
          )}
          {!showFullData && summaryIsReady && (
            <div className="card-summary">{summary}</div>
          )}
          {(showFullData || summary === "error") && (
            <div className="card-signal-text">
              <ExpandableSignal text={formatSignalText(card.signal)} threshold={8} />
            </div>
          )}
          {/* Toggle: only show once summary has resolved (success or error).
              When summary is "error", the full data is already showing, so the
              toggle button just lets the operator collapse it back if they want. */}
          {(summaryIsReady || summary === "error") && (
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

      {/* Keyboard hint — desktop only (hidden on touch via CSS) */}
      <div className="card-kbd-hint" aria-hidden="true">⌨ D done · S skip</div>
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
  onRequestAngles, onAction, onSetFocus, onFeedbackSubmitted, commentPrefs, isFocused, onCopied,
}) {
  const isDisabled = leaving;
  const postUrl = card.url || card.lead_linkedin || "";

  const [chosenAngleId, setChosenAngleId] = useState(null);
  const [comment, setComment] = useState("");
  const [commentStatus, setCommentStatus] = useState("idle"); // idle | loading | ready | error

  // Lazy-fetch angles when this card mounts (it only mounts when it's the
  // visible top card — the stack renders one card at a time).
  useEffect(() => {
    onRequestAngles?.();
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
      if (e.key === "1" || e.key === "2" || e.key === "3") {
        const idx = Number(e.key) - 1;
        const a = angles[idx];
        if (a) { e.preventDefault(); pickAngle(a); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [angles, isDisabled]);
  const bullets = commentData?.bullets || [];
  const postSummary = commentData?.summary || "";

  async function generate(angle) {
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
    if (a) generate(a);
  }

  function commentOnLinkedIn() {
    if (postUrl) window.open(postUrl, "_blank", "noopener,noreferrer");
    copyToClipboard(comment, () => onCopied?.("Comment copied — paste it on LinkedIn."));
  }

  return (
    <div className={`card card-stack li-comment-card ${leaving ? "leaving" : "entering"}`}>
      <div className="card-header">
        <span className="card-type card-type-li">
          <span className="card-type-icon">💬</span>
          LinkedIn comment
        </span>
        {typeof card.score === "number" && card.score > 0 && (
          <span className="card-score-chip" title={`Composite score ${card.score}`}>{card.score}</span>
        )}
      </div>

      {/* Title — author + company */}
      <div className="card-name">{subject}</div>
      {meta && <div className="card-meta">{meta}</div>}

      {/* Post summary + bullets (public-facing, model-generated) */}
      <div className="li-post-block">
        {status === "loading" && (
          <div className="card-summary card-summary-loading">
            <span className="spinner spinner-sm" /> Reading the post…
          </div>
        )}
        {status === "error" && (
          <div className="li-post-error">Couldn't load the post brief. You can still open the post and Mark Done.</div>
        )}
        {status === "ready" && (postSummary || bullets.length > 0) && (
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
        {postUrl && (
          <a className="li-view-post" href={postUrl} target="_blank" rel="noopener noreferrer">
            ↗ View full post
          </a>
        )}
      </div>

      {/* Angle chips */}
      {status === "ready" && angles.length > 0 && (
        <div className="li-angles">
          <div className="li-angles-label">Pick an angle to comment from:</div>
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
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Generated comment (editable) + regenerate */}
      {chosenAngleId && (
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
                <button className="btn" onClick={regenerate} disabled={isDisabled || commentStatus === "loading"} type="button">
                  ↻ Regenerate
                </button>
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

      {/* Actions: Mark Done / Skip (primary) + focus chat (secondary) */}
      <div className="card-actions-row">
        <div className="card-actions-primary">
          <button className="btn primary" disabled={isDisabled} onClick={() => onAction(card.id, "done")}>
            ✓ Mark Done
          </button>
          <button className="btn danger" disabled={isDisabled} onClick={() => onAction(card.id, "skip")}>
            Skip
          </button>
        </div>
        <div className="card-actions-secondary">
          {onSetFocus && (card.lead_name || card.company) && (
            <button
              className={`card-icon-btn ${isFocused ? "card-icon-btn-active" : ""}`}
              onClick={() => onSetFocus(isFocused ? null : card)}
              title={isFocused ? "Stop focusing chat on this lead" : "Focus chat on this lead"}
              type="button"
            >{isFocused ? "🎯" : "💬"}</button>
          )}
        </div>
      </div>

      {/* Keyboard hint — desktop only (hidden on touch via CSS) */}
      <div className="card-kbd-hint" aria-hidden="true">
        ⌨ D done · S skip{status === "ready" && angles.length > 0 ? " · 1/2/3 angle" : ""}
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
    breakdown.movements > 0 && { icon: "📈", label: `${breakdown.movements} movement${breakdown.movements > 1 ? "s" : ""}` },
    breakdown.callable  > 0 && { icon: "📞", label: `${breakdown.callable} top to call` },
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
// DAILY LINKEDIN BATCH CARD
// The flagship: 5 highest-scored leads with pre-generated AI connection
// notes + 3-DM sequences. One meta-card collapsed; expands inline into
// per-lead BatchLeadCards on "Review one-by-one".
// ═══════════════════════════════════════════════════════════════════
function DailyBatchCard({
  batch, collapsed, onToggleCollapsed, expanded, onToggleExpand,
  onSendAll, onSkipAll, onSendOne, onSkipOne, onEditField,
  editingDraft, setEditingDraft, onFeedbackSubmitted,
}) {
  const count = batch.leads?.length || 0;
  if (count === 0) return null;

  const totalConnChars = (batch.leads || []).reduce((s, l) => s + (l.connection_note?.length || 0), 0);
  const avgConnChars = Math.round(totalConnChars / count);

  // item 5: collapsed by default to a compact single-line entry so the
  // unified task stack stays the focal point. Click to expand.
  if (collapsed) {
    return (
      <button className="batch-compact" onClick={onToggleCollapsed} type="button">
        <span className="batch-compact-icon">🤝</span>
        <span className="batch-compact-text">
          Daily LinkedIn batch · <strong>{count} ready</strong>
        </span>
        <span className="batch-compact-cta">Review →</span>
      </button>
    );
  }

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
        <button className="batch-collapse-btn" onClick={onToggleCollapsed} type="button" title="Collapse">
          ▲
        </button>
      </div>

      {/* item 3: two primaries only. "Review one-by-one" is demoted to a
          quieter inline text toggle below the primary row, not a third
          equal-weight button. */}
      <div className="batch-ctas">
        <button className="btn primary" onClick={onSendAll}>
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
              onSend={() => onSendOne(lead.id)}
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
          {lead.composite_score >= 1000 && <span className="badge-movement">🔥 Movement</span>}
          <span className="batch-score-val">Score {lead.composite_score}</span>
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

// ═══════════════════════════════════════════════════════════════════
// TOP CALLABLE CARD
// Curated by composite score on the server (movement preempts → GA +
// LinkedIn engagement → base score). Phone is NOT required — if absent,
// shows "Enrich Phone" CTA instead of "Call".
// ═══════════════════════════════════════════════════════════════════
function TopCallableCard({ lead, enriching, onEnrichPhone }) {
  const reasons = lead.reasons || [];
  const hasPhone = !!lead.lead_phone;

  return (
    <div className="card entering">
      <div className="card-top">
        <div>
          <div className="subject">{lead.lead_name}</div>
          <div className="subject-meta">
            {[lead.lead_title, lead.company].filter(Boolean).join(" · ")}
          </div>
          {lead.has_movement && lead.movement_type && (
            <div className={`movement-badge badge-${lead.movement_type.toLowerCase()}`}>
              🔥 {lead.movement_type === "Hired" ? "NEW HIRE" : lead.movement_type === "Promoted" ? "PROMOTED" : "EXITED"}
            </div>
          )}
        </div>
        {typeof lead.score === "number" && (
          <div
            className="score"
            title={buildScoreTooltip(lead)}
          >
            <span className="score-label">SCORE</span>
            {lead.score}
          </div>
        )}
      </div>

      {reasons.length > 0 && (
        <div className="callable-reasons">
          {/* Join all reasons into one structured block. Each reason is
              prefixed with `→` and they're separated by a blank line. The
              whole block is collapsed at 8 lines so multi-post reasons
              (e.g. Rahul's 2 posts × ~8 sections each) don't dominate.
              `ExpandableSignal` adds the Show more / Show less toggle. */}
          <div className="callable-reason">
            <ExpandableSignal
              text={reasons.map(r => `→ ${formatSignalText(r)}`).join("\n\n")}
              threshold={8}
            />
          </div>
        </div>
      )}

      <div className="ctas">
        {lead.lead_linkedin && (
          <a className="btn" href={lead.lead_linkedin} target="_blank" rel="noopener noreferrer">
            in LinkedIn
          </a>
        )}
        {hasPhone ? (
          <a className="btn primary" href={`tel:${lead.lead_phone}`}>
            ☎ Call {lead.lead_phone}
          </a>
        ) : (
          <button
            className="btn primary"
            disabled={enriching}
            onClick={onEnrichPhone}
            title="Use Apollo to find this lead's phone number"
          >
            {enriching ? <><span className="spinner spinner-sm" /> Enriching…</> : "☎ Enrich Phone"}
          </button>
        )}
      </div>
    </div>
  );
}
