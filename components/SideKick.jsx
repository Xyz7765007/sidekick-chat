"use client";

import { useEffect, useRef, useState, useCallback } from "react";

// ═══════════════════════════════════════════════════════════════════
// SIDE KICK — Main chatbot UI
//
// Polls /api/feed every 30s. Renders each task as a card with score
// badge, signal text, and CTAs (Open Link, Mark Done, Skip).
//
// CTA click flow:
//   1. Card slides out (optimistic UI)
//   2. POST /api/action → SignalScope → Airtable
//   3. On success, card removed from list + count decremented
//   4. On error, card slides back in + toast shown
//
// Empty state: "All clear" message.
// Error state: toast for transient errors, full error block if feed fetch fails.
// ═══════════════════════════════════════════════════════════════════

const POLL_INTERVAL_MS = 30000;
const FEED_LIMIT = 20;

export default function SideKick() {
  const [cards, setCards] = useState([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);
  const [leaving, setLeaving] = useState(new Set()); // task IDs currently animating out
  const [toast, setToast] = useState("");

  // Cursor spotlight position
  const [cursor, setCursor] = useState({ x: -1000, y: -1000 });
  const spotlightRef = useRef(null);

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

  // ─── Toast helper ───────────────────────────────────────────────
  function showToast(msg, ms = 2400) {
    setToast(msg);
    setTimeout(() => setToast(""), ms);
  }

  // ─── Action handler ─────────────────────────────────────────────
  async function handleAction(taskId, action) {
    // Optimistic: start slide-out animation
    setLeaving((s) => new Set([...s, taskId]));

    try {
      const r = await fetch("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, action }),
      });
      const data = await r.json();
      if (data.ok) {
        // After animation, remove from list + decrement count
        setTimeout(() => {
          setCards((c) => c.filter((card) => card.id !== taskId));
          setCount((n) => Math.max(0, n - 1));
          setLeaving((s) => {
            const ns = new Set(s);
            ns.delete(taskId);
            return ns;
          });
        }, 300);
        showToast(action === "done" ? "Marked done ✓" : "Skipped");
      } else {
        // Revert animation
        setLeaving((s) => {
          const ns = new Set(s);
          ns.delete(taskId);
          return ns;
        });
        showToast(`Error: ${data.error || "Action failed"}`, 4000);
      }
    } catch (e) {
      setLeaving((s) => {
        const ns = new Set(s);
        ns.delete(taskId);
        return ns;
      });
      showToast(`Network error: ${e.message}`, 4000);
    }
  }

  // ─── Render helpers ─────────────────────────────────────────────
  // The chatbot subject prefers lead_name, falls back to company (some
  // Veloka tasks have the lead name in Company field due to import quirk),
  // then "Untitled".
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
        ref={spotlightRef}
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
          <div className="error">
            Feed error: {fetchError}
          </div>
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
      </main>

      <div className={`toast ${toast ? "show" : ""}`}>{toast}</div>
    </>
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
    </div>
  );
}
