// ═══════════════════════════════════════════════════════════════════
// CHAT ORCHESTRATOR — /api/chat
//
// Single endpoint that:
//   1. Receives user message + recent history from chatbot UI
//   2. Loads broader history from Airtable for Claude's context (if not provided)
//   3. Saves the user message to Airtable
//   4. Calls Claude with system prompt + history + new message
//   5. Parses Claude's JSON response: { reply, action }
//   6. Executes action if any (scan, refresh, status)
//   7. Saves bot reply (combined with execution result) to Airtable
//   8. Returns { reply, action, executionResult, savedMessages } to UI
//
// Claude model: haiku-4-5 (fast + cheap, plenty smart for intent + chat)
// Falls back gracefully if JSON parse fails — treats raw text as reply,
// no action executed.
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 300; // scan actions can take 30-60s

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SIGNALSCOPE_URL = process.env.SIGNALSCOPE_API_URL;
const SIDEKICK_KEY = process.env.SIDEKICK_API_KEY;
const BASE_ID = process.env.VELOKA_BASE_ID;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are Side Kick, an AI assistant for a B2B sales operator running an outbound campaign called Veloka.

WHAT THE SYSTEM DOES (so you don't promise things outside scope):
- LinkedIn connections + DMs go out automatically every day. You do NOT trigger these from chat — they run on a cron.
- Email campaigns are WIP — not built yet. Do not promise to send emails. If asked, say email engine is in development.
- All scans (Top X scoring, LinkedIn posts, GA engagement, lead movement detection via RapidAPI) run on the SignalScope dashboard, NOT from chat. The chatbot is read-only for tasks — you display whatever scans have already created, you do not trigger new scans.
- The ONLY data-modifying action you can trigger from chat is "refresh" (re-fetch the feed). Phone enrichment exists but is a per-card button on the UI, not a chat command.

YOUR AVAILABLE ACTIONS (include in response when user wants them):
- refresh: Re-fetch the task feed from the database. Useful if the operator wants to check for new tasks without waiting for the 30s auto-poll.
- status: Just report the pending count (no backend call; you already know the count below).

IF USER ASKS TO SCAN: Tell them honestly that scans run on the SignalScope dashboard, not from chat. The chatbot only displays existing tasks. Suggest they open SignalScope and run the scan there.

CURRENT CONTEXT
- Pending task count: {{COUNT}}
- The chat history below spans multiple sessions. Use it to build understanding of the operator's patterns over time. Note what they action vs skip — that's the real signal of their priorities.

RESPONSE FORMAT (MUST be valid JSON only — no markdown fences, no prose around it):
{
  "reply": "Your conversational reply (terse, direct).",
  "action": null
}
or with an action:
{
  "reply": "Refreshing.",
  "action": {"type": "refresh"}
}

STYLE
- Be brief. The operator hates fluff. 1-3 sentences max.
- Hinglish is fine if it feels natural.
- Casual chat → action=null, conversational reply.
- "Refresh" / "any new tasks?" → action.type=refresh.
- NEVER set action.type to "scan" or "movement_scan" — those don't exist as chat actions. If user asks, redirect them to SignalScope.
- Don't invent task data you don't have. You see the count, not individual tasks. If user asks "which task should I do first?" suggest they look at the top card (sorted by score).`;

// Helper: write a message to the Sidekick Chat table
async function logMessage(role, text, extras = {}) {
  try {
    await fetch(`${SIGNALSCOPE_URL.replace(/\/$/, "")}/api/sidekick/chat-log`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SIDEKICK_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ baseId: BASE_ID, role, text, ...extras }),
    });
  } catch (e) {
    // Non-fatal: chat keeps working even if persistence fails. Log to server console.
    console.warn("chat-log failed:", e.message);
  }
}

// Try to extract a JSON object from Claude's response, even if it wraps it in fences.
function extractJSON(raw) {
  if (!raw) return null;
  // Strip markdown fences if present
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  // Find first { and last } to handle prose around it
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  s = s.slice(start, end + 1);
  try { return JSON.parse(s); }
  catch { return null; }
}

export async function POST(request) {
  if (!ANTHROPIC_API_KEY) {
    return Response.json({ ok: false, error: "Server missing ANTHROPIC_API_KEY env var" }, { status: 500 });
  }
  if (!SIGNALSCOPE_URL || !SIDEKICK_KEY || !BASE_ID) {
    return Response.json({ ok: false, error: "Server missing SignalScope env vars" }, { status: 500 });
  }

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 }); }

  const { message, history, currentCount } = body || {};
  if (!message || typeof message !== "string") {
    return Response.json({ ok: false, error: "message required" }, { status: 400 });
  }

  // Log the user message immediately (fire-and-forget; don't block on this)
  const userLogPromise = logMessage("user", message);

  // Build Claude-compatible message array from history
  // history shape from UI: [{ role: "user"|"bot", text: "..." }, ...]
  const historyMsgs = Array.isArray(history) ? history.slice(-20) : []; // last 20 for context window
  const claudeMessages = historyMsgs
    .filter(m => m && m.text && m.role)
    .map(m => ({
      role: m.role === "bot" ? "assistant" : "user",
      content: m.text,
    }));
  // Append the new user message
  claudeMessages.push({ role: "user", content: message });

  // Substitute live values into the system prompt
  const systemPrompt = SYSTEM_PROMPT.replace("{{COUNT}}", String(currentCount ?? "unknown"));

  // Call Claude
  let claudeReply = null;
  let parsed = null;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 800,
        system: systemPrompt,
        messages: claudeMessages,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      // Anthropic error — return readable message
      let errMsg = data?.error?.message || `Claude API error HTTP ${r.status}`;
      if (r.status === 401) errMsg = "Anthropic API key invalid or missing on the chatbot server. Check ANTHROPIC_API_KEY env var on Vercel.";
      else if (r.status === 429) errMsg = "Anthropic rate limit hit. Wait a moment and try again.";
      else if (r.status === 529) errMsg = "Anthropic temporarily overloaded. Try again in a few seconds.";
      await userLogPromise.catch(() => {});
      await logMessage("bot", `Error: ${errMsg}`, { intent: "error" });
      return Response.json({ ok: false, error: errMsg }, { status: 502 });
    }
    // content[0].text — Claude's JSON-formatted response
    claudeReply = data.content?.[0]?.text || "";
    parsed = extractJSON(claudeReply);
  } catch (e) {
    await userLogPromise.catch(() => {});
    await logMessage("bot", `Error: ${e.message}`, { intent: "error" });
    return Response.json({ ok: false, error: `Claude call failed: ${e.message}` }, { status: 502 });
  }

  // If JSON parse failed, treat raw text as reply with no action
  if (!parsed || typeof parsed.reply !== "string") {
    const fallback = claudeReply || "Hmm, I'm not sure how to respond to that.";
    await userLogPromise.catch(() => {});
    await logMessage("bot", fallback, { intent: "parse_fallback" });
    return Response.json({
      ok: true,
      reply: fallback,
      action: null,
      executionResult: null,
    });
  }

  const { reply, action } = parsed;
  let executionResult = null;
  let combinedReply = reply;

  // Execute action if present
  if (action && typeof action === "object" && action.type) {
    try {
      if (action.type === "refresh") {
        // No backend action needed — UI re-fetches on receiving this signal
        executionResult = { ok: true, signal: "refresh_feed" };
      } else if (action.type === "status") {
        // No-op; reply already contains the info
        executionResult = { ok: true, signal: "status_only" };
      } else if (action.type === "scan" || action.type === "movement_scan") {
        // Defensive: Claude shouldn't return these per the system prompt, but
        // if it does (e.g. prompt slip), surface a clear message rather than
        // silently no-op or call removed endpoints.
        executionResult = { ok: false, error: "Scans run on SignalScope, not from chat." };
        combinedReply = `${reply}\n\n(Note: scans aren't available from chat — open SignalScope to run a ${action.type === "scan" ? "Top X" : "movement"} scan.)`;
      }
    } catch (e) {
      executionResult = { ok: false, error: e.message };
      combinedReply = `${reply}\n\n✗ Action error: ${e.message}`;
    }
  }

  // Log the bot's final (combined) reply with metadata
  await userLogPromise.catch(() => {});
  await logMessage("bot", combinedReply, {
    intent: action?.type || "chat",
    actionType: action?.type || null,
    actionResult: executionResult,
  });

  return Response.json({
    ok: true,
    reply: combinedReply,
    action,
    executionResult,
  });
}
