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

  // AI summary cache. Keyed by card.id → string (the generated summary)
  // OR "loading" OR "error". Fetched lazily for the visible top card so
  // we don't burn tokens summarising cards the operator never sees.
  const [summaries, setSummaries] = useState({});
  // Tracks in-flight summary requests so a re-render doesn't kick off
  // duplicate fetches before the first one's setState resolves.
  const pendingSummariesRef = useRef(new Set());

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

  // ─── Email draft (pt4 V1: draft + edit + copy, NO send) ─────────
  // Composes an editable draft client-side from the lead's card data.
  // Operator edits, then copies to their own mail client. Sending from
  // the app is V2 (needs verified domain + provider — see Kanban).
  function handleDraftEmail(card) {
    const name = card.lead_name || "there";
    const firstName = name.split(" ")[0];
    const summary = summaries[card.id];
    const summaryLine = (summary && summary !== "loading" && summary !== "error")
      ? summary
      : (card.signal || "").replace(/\s+/g, " ").trim().slice(0, 240);
    // For an exited lead the `company` field is the OLD employer — make the
    // body acknowledge they've moved rather than addressing the old company.
    const movedNote = card.movement_type === "Exited"
      ? `\n\nI saw you've recently moved on from ${card.company}. Congrats on the next chapter.`
      : "";
    const subject = card.movement_type === "Exited"
      ? `Following your move from ${card.company}`
      : `Quick note for ${firstName}${card.company ? ` at ${card.company}` : ""}`;
    const body =
`Hi ${firstName},${movedNote}

${summaryLine ? summaryLine + "\n\n" : ""}I work on Side Kick — we help B2B teams turn buying signals into personalized outreach without the manual SDR overhead.

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

          if (allCards.length === 0) return null;

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

          if (sortedStack.length === 0) return null;

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

          const breakdown = {
            movements: remaining.filter(c => c.task_type === "lead_movement").length,
            callable:  remaining.filter(c => c.task_type === "top_callable").length,
            top:       remaining.filter(c => c.task_type === "top_x").length,
            comments:  remaining.filter(c => c.task_type === "linkedin_engagement").length,
            ga:        remaining.filter(c => c.task_type === "engagement").length,
            other:     remaining.filter(c => !["lead_movement", "top_callable", "top_x", "linkedin_engagement", "engagement"].includes(c.task_type)).length,
          };

          return (
            <div className="task-stack">
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
                isFocused={focusLead && focusLead.lead_name === topCard.lead_name && focusLead.company === topCard.company}
              />
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

// ─── Email draft modal (pt4 V1) ──────────────────────────────────
// Edit + copy only. NO send — actual send-from-app is V2 (needs a
// verified sending domain + provider; see the SignalScope Kanban).
// Uses navigator.clipboard with a textarea fallback for older browsers.
// Also offers a mailto: link as a convenience (opens the operator's own
// mail client with the draft prefilled — still their account, not ours).
function EmailDraftModal({ draft, onChange, onClose, onCopied }) {
  function copy(text, label) {
    const done = () => onCopied?.(label);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
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
  batch, expanded, onToggleExpand,
  onSendAll, onSkipAll, onSendOne, onSkipOne, onEditField,
  editingDraft, setEditingDraft,
}) {
  const count = batch.leads?.length || 0;
  if (count === 0) return null;

  const totalConnChars = (batch.leads || []).reduce((s, l) => s + (l.connection_note?.length || 0), 0);
  const avgConnChars = Math.round(totalConnChars / count);

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
      </div>

      <div className="batch-ctas">
        <button className="btn primary" onClick={onSendAll}>
          ▶ Send all {count}
        </button>
        <button className="btn" onClick={onToggleExpand}>
          {expanded ? "▼ Hide reviews" : "👀 Review one-by-one"}
        </button>
        <button className="btn danger" onClick={onSkipAll}>
          ⏭ Skip today
        </button>
      </div>

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
function BatchLeadCard({ lead, index, total, onSend, onSkip, onEdit, editingDraft, setEditingDraft }) {
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
                </span>
              </div>
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
                  onClick={() => setEditingDraft({ recordId: lead.id, field: airtableField, text })}
                  title="Click to edit"
                >
                  {text || <span className="batch-msg-empty">(empty — click to write)</span>}
                </div>
              )}
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
