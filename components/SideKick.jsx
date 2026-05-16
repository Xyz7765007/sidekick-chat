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

  // ─── LinkedIn outreach review queue ────────────────────────────
  // AI-drafted invitations + DMs that SignalScope's outreach engine sent
  // via Unipile. Each one is logged to Sent Messages Review with status
  // 'needs_review' until a human approves or flags. This is the chatbot's
  // approval surface for the "Top 10 LinkedIn requests with AI notes"
  // whiteboard item.
  const [reviewMessages, setReviewMessages] = useState([]);
  const [reviewLeaving, setReviewLeaving] = useState(new Set());

  const fetchReviewMessages = useCallback(async () => {
    try {
      const r = await fetch("/api/messages-feed?limit=20", { cache: "no-store" });
      const data = await r.json();
      if (data.ok) setReviewMessages(data.messages || []);
    } catch {}
  }, []);

  async function handleMessageAction(messageId, action) {
    setReviewLeaving((s) => new Set([...s, messageId]));
    setTimeout(async () => {
      try {
        const r = await fetch("/api/message-action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageId, action }),
        });
        const data = await r.json();
        if (data.ok) {
          setReviewMessages((m) => m.filter(x => x.id !== messageId));
          showToast(action === "approve" ? "Approved" : "Flagged", 2200);
        } else {
          showToast(`Error: ${data.error || "Action failed"}`, 4000);
        }
      } catch (e) {
        showToast(`Network error: ${e.message}`, 4000);
      } finally {
        setReviewLeaving((s) => { const ns = new Set(s); ns.delete(messageId); return ns; });
      }
    }, 250);
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

  useEffect(() => {
    fetchFeed();
    fetchReviewMessages();
    loadHistory();
    const i = setInterval(() => { fetchFeed(); fetchReviewMessages(); }, POLL_INTERVAL_MS);
    return () => clearInterval(i);
  }, [fetchFeed, fetchReviewMessages, loadHistory]);

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
          <div className="counter">
            <span className="count-num">{count}</span>
            <span style={{ color: "var(--t2)" }}>pending</span>
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

        {/* LinkedIn outreach approval queue — sits above tasks because it's
            time-sensitive (messages already went out via Unipile). Hidden
            when nothing needs review. */}
        {reviewMessages.length > 0 && (
          <Section
            icon="✉"
            title="LinkedIn requests to review"
            sub="AI-drafted invitations + DMs sent via Unipile, awaiting your approval"
            count={reviewMessages.length}
          >
            {reviewMessages.map((m) => (
              <MessageCard
                key={m.id}
                message={m}
                leaving={reviewLeaving.has(m.id)}
                onAction={handleMessageAction}
              />
            ))}
          </Section>
        )}

        {!loading && !fetchError && cards.length > 0 && (() => {
          // ─── Section grouping ────────────────────────────────────
          // "Top 2 to call" picks the 2 highest-score callable tasks. Those
          // 2 only show in the Top 2 section, NOT in their natural type
          // section, to avoid duplicate display. The remaining callable
          // tasks still show in their type section (with the Call CTA on
          // each card, so operator can still call them — they just don't
          // get the dedicated "Top 2" surface).
          const sortedByScore = [...cards].sort((a, b) => (b.score || 0) - (a.score || 0));
          const topCallable = sortedByScore.filter(c => !!c.lead_phone).slice(0, 2);
          const promoted = new Set(topCallable.map(c => c.id));

          const movements = cards.filter(c => c.task_type === "lead_movement" && !promoted.has(c.id));
          const liComments = cards.filter(c => c.task_type === "linkedin_engagement" && !promoted.has(c.id));
          const gaVisitors = cards.filter(c => c.task_type === "engagement" && !promoted.has(c.id));
          const topLeads = cards.filter(c => c.task_type === "top_x" && !promoted.has(c.id));
          const accountedFor = new Set([
            ...promoted,
            ...movements.map(c => c.id),
            ...liComments.map(c => c.id),
            ...gaVisitors.map(c => c.id),
            ...topLeads.map(c => c.id),
          ]);
          const other = cards.filter(c => !accountedFor.has(c.id));

          const sections = [
            { key: "top2call", icon: "📞", title: "Top 2 to call", sub: "Highest-score tasks with a phone number — call now", items: topCallable },
            { key: "movements", icon: "📈", title: "Account movements", sub: "Hires, promotions, exits", items: movements },
            { key: "comments", icon: "💬", title: "LinkedIn posts to comment", sub: "AI-suggested engagement on lead posts", items: liComments },
            { key: "ga", icon: "🌐", title: "Website engagement", sub: "Leads visiting your site", items: gaVisitors },
            { key: "top", icon: "🎯", title: "Top leads", sub: "Top X picks", items: topLeads },
            { key: "other", icon: "·", title: "Other", sub: "", items: other },
          ].filter(s => s.items.length > 0);

          return sections.map(s => (
            <Section key={s.key} icon={s.icon} title={s.title} sub={s.sub} count={s.items.length}>
              {s.items.map((card) => (
                <Card
                  key={card.id}
                  card={card}
                  leaving={leaving.has(card.id)}
                  enriching={enriching.has(card.id)}
                  subject={getSubject(card)}
                  meta={getMeta(card)}
                  onAction={handleAction}
                  onEnrichPhone={handleEnrichPhone}
                />
              ))}
            </Section>
          ));
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

  // Movement badge — colored chip for Hired / Promoted / Exited
  const movementBadge = card.movement_type ? {
    Hired: { label: "🎉 NEW HIRE", className: "badge-hired" },
    Promoted: { label: "📈 PROMOTED", className: "badge-promoted" },
    Exited: { label: "👋 EXITED", className: "badge-exited" },
  }[card.movement_type] : null;

  return (
    <div className={`card ${leaving ? "leaving" : "entering"}`}>
      <div className="card-top">
        <div>
          <div className="subject">{subject}</div>
          {meta && <div className="subject-meta">{meta}</div>}
          {movementBadge && (
            <div className={`movement-badge ${movementBadge.className}`}>{movementBadge.label}</div>
          )}
        </div>
        {typeof card.score === "number" && card.score > 0 && (
          <div className="score">
            <span className="score-label">SCORE</span>
            {card.score}
          </div>
        )}
      </div>

      {card.signal && <div className="signal">{card.signal}</div>}

      <div className="tags">
        {card.task_rule && <div className="tag tag-rule">{card.task_rule}</div>}
        {card.source && <div className="tag">{card.source}</div>}
      </div>

      <div className="ctas">
        {hasLink && (
          <a
            className="btn"
            href={card.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => { if (isDisabled) e.preventDefault(); }}
          >
            ↗ Open Link
          </a>
        )}
        {hasLinkedIn && (
          <a
            className="btn"
            href={card.lead_linkedin}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => { if (isDisabled) e.preventDefault(); }}
          >
            in LinkedIn
          </a>
        )}
        {hasPhone && (
          <a
            className="btn"
            href={`tel:${card.lead_phone}`}
            onClick={(e) => { if (isDisabled) e.preventDefault(); }}
            title={card.lead_phone_description ? `${card.lead_phone} · ${card.lead_phone_description}` : card.lead_phone}
          >
            ☎ Call{card.lead_phone_type === "mobile" ? " (mobile)" : card.lead_phone_type === "company_main" ? " (company)" : ""}
          </a>
        )}
        {canEnrich && (
          <button
            className="btn"
            disabled={enriching}
            onClick={() => onEnrichPhone(card.id)}
            title="Use Apollo to find this lead's phone number"
          >
            {enriching ? <><span className="spinner spinner-sm" /> Enriching…</> : "☎ Enrich Phone"}
          </button>
        )}
        <button className="btn primary" disabled={isDisabled} onClick={() => onAction(card.id, "done")}>
          ✓ Mark Done
        </button>
        <button className="btn danger" disabled={isDisabled} onClick={() => onAction(card.id, "skip")}>
          Skip
        </button>
      </div>
    </div>
  );
}
