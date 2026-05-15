"use client";

import { useEffect, useRef, useState, useCallback } from "react";

// ═══════════════════════════════════════════════════════════════════
// SIDE KICK — Main chatbot UI
//
// Polls /api/feed every 30s. Renders each task as a card with score
// badge, signal text, and CTAs (Open Link, Mark Done, Skip).
//
// Chat input at the bottom — type commands like:
//   "scan"         → trigger a Top X scan (uses first available rule)
//   "scan top 50"  → trigger a specific rule by name match
//   "help"         → list commands
//   "status"       → show pending count
//   "refresh"      → re-fetch the feed
//
// Command parsing is keyword-based for v1. Future iteration can swap
// in Claude API for natural-language understanding.
// ═══════════════════════════════════════════════════════════════════

const POLL_INTERVAL_MS = 30000;
const FEED_LIMIT = 20;

export default function SideKick() {
  const [cards, setCards] = useState([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);
  const [leaving, setLeaving] = useState(new Set());
  const [toast, setToast] = useState("");

  // Chat state
  const [messages, setMessages] = useState([
    {
      id: "welcome",
      role: "bot",
      text: "Hey. I'll show pending tasks above. Try typing 'scan' to refresh the queue, or 'help' to see commands.",
    },
  ]);
  const [input, setInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const chatScrollRef = useRef(null);

  // Cursor spotlight
  const [cursor, setCursor] = useState({ x: -1000, y: -1000 });

  // ─── Fetch feed ─────────────────────────────────────────────────
  const fetchFeed = useCallback(async () => {
    try {
      const r = await fetch(`/api/feed?limit=${FEED_LIMIT}`, { cache: "no-store" });
      const data = await r.json();
      if (data.ok) {
        setCards(data.cards || []);
        setCount(typeof data.count === "number" ? data.count : (data.cards || []).length);
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

  useEffect(() => {
    fetchFeed();
    const i = setInterval(fetchFeed, POLL_INTERVAL_MS);
    return () => clearInterval(i);
  }, [fetchFeed]);

  // ─── Cursor spotlight ───────────────────────────────────────────
  useEffect(() => {
    const onMove = (e) => setCursor({ x: e.clientX, y: e.clientY });
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  // ─── Chat auto-scroll ───────────────────────────────────────────
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [messages]);

  // ─── Toast ──────────────────────────────────────────────────────
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
          setCount((n) => Math.max(0, n - 1));
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

  // ─── Chat helpers ───────────────────────────────────────────────
  function pushMessage(role, text) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setMessages((m) => [...m, { id, role, text }]);
    return id;
  }
  function updateMessage(id, text) {
    setMessages((m) => m.map((x) => (x.id === id ? { ...x, text } : x)));
  }

  // ─── Command parser ─────────────────────────────────────────────
  function parseCommand(raw) {
    const t = raw.toLowerCase().trim();
    if (!t) return { type: "noop" };

    if (/^(help|\?|commands|what can you do)$/.test(t)) return { type: "help" };
    if (/^(status|count|how many|pending)$/.test(t)) return { type: "status" };
    if (/^(refresh|reload|update)$/.test(t)) return { type: "refresh" };

    // scan / rescan / run scan, with optional rule name
    const scanMatch = t.match(/^(?:scan|rescan|run scan|run a scan)\s*(.*)$/);
    if (scanMatch) return { type: "scan", ruleName: scanMatch[1].trim() || null };

    return { type: "unknown" };
  }

  // ─── Chat: submit ───────────────────────────────────────────────
  async function handleSubmit(e) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || chatBusy) return;

    pushMessage("user", text);
    setInput("");
    setChatBusy(true);

    const cmd = parseCommand(text);

    try {
      if (cmd.type === "help") {
        pushMessage("bot",
          "Commands:\n" +
          "• scan — refresh the task queue using the first scoring rule\n" +
          "• scan <name> — use a specific rule (e.g. 'scan top 50 leads')\n" +
          "• status — how many pending tasks\n" +
          "• refresh — re-fetch the feed without scanning\n" +
          "• help — this list"
        );
      } else if (cmd.type === "status") {
        pushMessage("bot", `${count} task${count === 1 ? "" : "s"} pending.`);
      } else if (cmd.type === "refresh") {
        pushMessage("bot", "Refreshing…");
        await fetchFeed();
        pushMessage("bot", `Done. ${count} pending.`);
      } else if (cmd.type === "scan") {
        const pendingId = pushMessage("bot", cmd.ruleName ? `Running scan: "${cmd.ruleName}"…` : "Running scan…");
        try {
          const r = await fetch("/api/scan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ruleName: cmd.ruleName }),
          });
          const data = await r.json();
          if (data.ok) {
            const created = data.tasksCreated || 0;
            const total = data.totalRecords ? ` (scanned ${data.totalRecords} ${data.scanTarget || "records"})` : "";
            updateMessage(pendingId,
              `✓ Scan complete. ${created} task${created === 1 ? "" : "s"} written.${total}\n` +
              `Rule: ${data.ruleUsed || "(unknown)"}${data.aiScored ? " · AI scored" : ""}`
            );
            await fetchFeed();
          } else {
            updateMessage(pendingId, `✗ Scan failed: ${data.error || "Unknown error"}`);
          }
        } catch (e) {
          updateMessage(pendingId, `✗ Network error: ${e.message}`);
        }
      } else if (cmd.type === "unknown") {
        pushMessage("bot", `Not sure what "${text}" means. Try 'scan' or 'help'.`);
      }
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

        {!loading && !fetchError && cards.length > 0 && (
          <div className="feed">
            {cards.map((card) => (
              <Card
                key={card.id}
                card={card}
                leaving={leaving.has(card.id)}
                subject={getSubject(card)}
                meta={getMeta(card)}
                onAction={handleAction}
              />
            ))}
          </div>
        )}

        {/* Chat thread */}
        <div className="chat-thread" ref={chatScrollRef}>
          {messages.map((m) => (
            <ChatBubble key={m.id} msg={m} />
          ))}
        </div>
      </main>

      {/* Sticky chat input */}
      <div className="chat-input-wrap">
        <div className="chat-input-inner">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(e); }}
            placeholder={chatBusy ? "Working…" : "Type 'scan' or 'help'"}
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

function Card({ card, leaving, subject, meta, onAction }) {
  const hasLink = !!card.url;
  const isDisabled = leaving;

  return (
    <div className={`card ${leaving ? "leaving" : "entering"}`}>
      <div className="card-top">
        <div>
          <div className="subject">{subject}</div>
          {meta && <div className="subject-meta">{meta}</div>}
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
