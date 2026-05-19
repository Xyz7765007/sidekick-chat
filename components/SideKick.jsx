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

export default function SideKick() {
  const [cards, setCards] = useState([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);
  const [leaving, setLeaving] = useState(new Set());
  const [toast, setToast] = useState("");

  // Chat state — initialized empty, populated from Airtable on mount
  const [messages, setMessages] = useState([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const chatScrollRef = useRef(null);
  const countRef = useRef(count); // kept in sync so /api/chat always gets fresh count

  // Cursor spotlight
  const [cursor, setCursor] = useState({ x: -1000, y: -1000 });

  // Movement scan status — polls every 30s, drives the live banner
  const [scanStatus, setScanStatus] = useState(null);

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
      } else {
        setScanStatus(null);
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

  // ─── Toast helper ───────────────────────────────────────────────
  function showToast(msg, ms = 2400) {
    setToast(msg);
    setTimeout(() => setToast(""), ms);
  }

  // ─── Action handler (Mark Done / Skip) ──────────────────────────
  async function handleAction(taskId, action) {
    setLeaving((s) => new Set([...s, taskId]));
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
        }, 300);
        showToast(action === "done" ? "Marked done ✓" : "Skipped");
      } else {
        setLeaving((s) => { const ns = new Set(s); ns.delete(taskId); return ns; });
        showToast(`Error: ${data.error || "Action failed"}`, 4000);
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
  function getMeta(card) {
    const parts = [];
    if (card.lead_name && card.company && card.lead_name !== card.company) parts.push(card.company);
    if (card.lead_title) parts.push(card.lead_title);
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

        <ScanBanner status={scanStatus} />

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

        {/* ─── TOP LEADS TO CALL (server-curated) ───────────────
            Composite-scored top N leads with full "why now" reasons.
            Phone availability is NOT a filter — leads without phone
            show "Enrich Phone" CTA so operator can pull one on demand. */}
        {topCallable.length > 0 && (
          <Section
            icon="📞"
            title="Top leads to call"
            sub="Highest composite-score · movement preempts · enrich phone on demand"
            count={topCallable.length}
          >
            {topCallable.map(lead => (
              <TopCallableCard
                key={lead.id}
                lead={lead}
                enriching={enriching.has(lead.id)}
                onEnrichPhone={() => handleEnrichPhone(lead.id)}
              />
            ))}
          </Section>
        )}

        {!loading && !fetchError && cards.length > 0 && (() => {
          // ─── STACK MODE: one task at a time, rest queued behind ─────
          // Client feedback: too much text overwhelms. Show only the
          // single highest-priority card; everything else summarized as a
          // queue indicator below. Acting on the top card removes it →
          // next slides up.
          //
          // Priority order: movements first (time-sensitive hires/exits),
          // then top X (curated ICP matches), then LinkedIn engagement,
          // then GA visits, then any other tasks. Within each group:
          // composite score desc.
          const movements = cards.filter(c => c.task_type === "lead_movement");
          const liComments = cards.filter(c => c.task_type === "linkedin_engagement");
          const gaVisitors = cards.filter(c => c.task_type === "engagement");
          const topLeads = cards.filter(c => c.task_type === "top_x");
          const accountedFor = new Set([
            ...movements.map(c => c.id),
            ...liComments.map(c => c.id),
            ...gaVisitors.map(c => c.id),
            ...topLeads.map(c => c.id),
          ]);
          const other = cards.filter(c => !accountedFor.has(c.id));

          const byScore = (a, b) => (b.score || 0) - (a.score || 0);
          const stack = [
            ...movements.sort(byScore),
            ...topLeads.sort(byScore),
            ...liComments.sort(byScore),
            ...gaVisitors.sort(byScore),
            ...other.sort(byScore),
          ];

          if (stack.length === 0) return null;
          const topCard = stack[0];
          const remaining = stack.slice(1);

          // Breakdown by type — excludes topCard (it's the visible one)
          const breakdown = {
            movements: remaining.filter(c => c.task_type === "lead_movement").length,
            top:       remaining.filter(c => c.task_type === "top_x").length,
            comments:  remaining.filter(c => c.task_type === "linkedin_engagement").length,
            ga:        remaining.filter(c => c.task_type === "engagement").length,
            other:     remaining.filter(c => !["lead_movement", "top_x", "linkedin_engagement", "engagement"].includes(c.task_type)).length,
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
                onAction={handleAction}
                onEnrichPhone={handleEnrichPhone}
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
        <div className="chat-input-inner">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(e); }}
            placeholder={chatBusy ? "Thinking…" : "Talk to Side Kick…"}
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
function ScanBanner({ status }) {
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

  if (status.state === "running") {
    return (
      <div className="scan-banner scan-running">
        <span className="scan-spinner" />
        <div className="scan-text">
          <div className="scan-title">Movement scan in progress</div>
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
          <div className="scan-title">Movement scan complete</div>
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

function Card({ card, leaving, enriching, subject, meta, onAction, onEnrichPhone }) {
  const hasLink = !!card.url;
  const hasPhone = !!card.lead_phone;
  const hasLinkedIn = !!card.lead_linkedin && card.lead_linkedin !== card.url;
  const isDisabled = leaving;

  // Show enrich CTA only when there's enough data for Apollo to match.
  // Skip if already has phone or if no lead identity available.
  const canEnrich = !hasPhone && !isDisabled && (
    card.lead_name || card.lead_linkedin || card.lead_email
  );

  // Type chip — small visual category indicator at the top.
  // Replaces the old section header (since stack mode merges all sections).
  const typeChip = ({
    lead_movement:       { icon: "📈", label: "Movement",    tone: "movement" },
    linkedin_engagement: { icon: "💬", label: "LinkedIn",    tone: "li" },
    engagement:          { icon: "🌐", label: "Site visit",  tone: "ga" },
    top_x:               { icon: "🎯", label: "Top lead",    tone: "top" },
  })[card.task_type] || { icon: "·", label: "Task", tone: "default" };

  // Movement-specific badge (Hired/Promoted/Exited) — distinct from typeChip
  const movementBadge = card.movement_type ? ({
    Hired:    "🎉 New hire",
    Promoted: "📈 Promoted",
    Exited:   "👋 Exited",
  })[card.movement_type] : null;

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

      {/* Signal — clamped to 3 lines via CSS line-clamp */}
      {card.signal && <div className="card-signal-text">{card.signal}</div>}

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
          {reasons.map((r, i) => <div key={i} className="callable-reason">→ {r}</div>)}
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
