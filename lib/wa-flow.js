// ═══════════════════════════════════════════════════════════════════
// The WhatsApp conversation — Side Kick's second front-end
//
// Kunal (2026-07-14): "I need the Side Kick chat app tasks on WhatsApp."
// Test scope, deliberately narrow: a batch of 3 LinkedIn comment tasks
// (task_type "linkedin_engagement") + the Create-post feature. Nothing else.
//
// This owns ZERO business logic. Every draft comes from the same routes the
// web app calls (/api/comment-angles, /api/generate-comment, /api/post-create),
// every state change goes through the same /api/action, every steer lands in
// the same /api/feedback learned-prefs store, and the batch is ranked by the
// same taskPriority the web queue uses. WhatsApp is a new SURFACE on the
// existing brain, not a second brain — so the two can never drift.
//
// Kunal's laws, applied to a chat surface:
//   - The post goes out WHOLE. "Going to the post means I'm leaving the
//     platform, which is a loss for you" (Jun-9). Truncating it would force
//     him to LinkedIn just to DECIDE. The action can leave; the decision can't.
//   - The footer grammar is fixed: Mark as done / Skip, with Open on LinkedIn
//     alongside them. "This has to be the same every time."
//   - No redundant CTA: a blind "Rewrite" button is a worse version of typing
//     what you want changed, so it doesn't exist. Free text (or a voice note)
//     IS the rewrite.
//   - Never auto-post. The draft goes out as its OWN message — on WhatsApp a
//     standalone message is long-press-copyable, and that is the Copy button
//     on this surface. He copies, opens LinkedIn, pastes.
// ═══════════════════════════════════════════════════════════════════

import { sendText, sendButtons, sendList, normalizeNumber, downloadMedia } from "./whatsapp.js";
import { transcribe } from "./transcribe.js";
import { byPriority } from "./task-priority.js";

const SIGNALSCOPE_URL = process.env.SIGNALSCOPE_API_URL;
const SIDEKICK_KEY = process.env.SIDEKICK_API_KEY;
const BASE_ID = process.env.VELOKA_BASE_ID;

const BATCH_SIZE = 3;              // Kunal asked for a batch of 3
const POST_CAP = 3400;             // the whole post — WhatsApp allows 4096/message
const LINKEDIN_COMPOSER = "https://www.linkedin.com/feed/";

// ─── SignalScope (server-side; the browser is never in this path, so the
// proxy-route rule doesn't apply — this IS the server side of it) ──────

function ssHeaders() {
  return { Authorization: `Bearer ${SIDEKICK_KEY}`, "Content-Type": "application/json" };
}

async function getSession(phone) {
  const r = await fetch(`${SIGNALSCOPE_URL}/api/sidekick/wa-session`, {
    method: "POST",
    headers: ssHeaders(),
    body: JSON.stringify({ baseId: BASE_ID, phone, action: "get" }),
    cache: "no-store",
  });
  const d = await r.json().catch(() => ({}));
  return d?.state && typeof d.state === "object" ? d.state : {};
}

async function saveSession(phone, state) {
  await fetch(`${SIGNALSCOPE_URL}/api/sidekick/wa-session`, {
    method: "POST",
    headers: ssHeaders(),
    body: JSON.stringify({ baseId: BASE_ID, phone, action: "set", state }),
    cache: "no-store",
  });
}

// The SAME queue the web app shows, ranked the SAME way (score + freshness
// boost). Kunal's standing rule: priority is never static, never hardcoded —
// so the WhatsApp batch must not invent its own order.
async function fetchCommentTasks(limit) {
  const r = await fetch(
    `${SIGNALSCOPE_URL}/api/sidekick/feed?baseId=${encodeURIComponent(BASE_ID)}&limit=40`,
    { headers: { Authorization: `Bearer ${SIDEKICK_KEY}` }, cache: "no-store" }
  );
  const d = await r.json().catch(() => ({}));
  const cards = Array.isArray(d?.cards) ? d.cards : [];
  // The feed only ever returns PENDING tasks, so a done/skipped one can't come
  // back in the next batch. No client-side dedupe needed.
  return cards
    .filter((c) => c.task_type === "linkedin_engagement")
    .sort(byPriority)
    .slice(0, limit)
    .map((c) => ({
      id: c.id,
      lead_name: c.lead_name || "",
      company: c.company || "",
      lead_title: c.lead_title || "",
      // `signal` carries the post's content — same field the web card feeds to
      // comment-angles. Both routes strip internal scoring markers from it.
      signal: String(c.signal || "").slice(0, POST_CAP),
      post_text: String(c.post_text || "").slice(0, POST_CAP),
      url: c.url || c.lead_linkedin || "",
    }));
}

async function actionTask(taskId, action) {
  const r = await fetch(`${SIGNALSCOPE_URL}/api/sidekick/action`, {
    method: "POST",
    headers: ssHeaders(),
    body: JSON.stringify({ baseId: BASE_ID, taskId, action, notes: "via WhatsApp" }),
    cache: "no-store",
  });
  return r.ok;
}

// ─── The app's own AI routes, called on its own origin ────────────────
// Same endpoints, same payloads, same prompts, same COMMENT_MODEL as the web
// UI. `origin` comes from the inbound request, so this needs no extra env var
// and works on preview deploys too.

async function ai(origin, path, body) {
  const r = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  return r.json().catch(() => ({ ok: false, error: "bad response" }));
}

// Learned comment preferences — the same store the web app's highlight-to-
// feedback box writes to. Kunal checks this ("the feedback I'm giving it, that
// feedback is going to go in and help?"), so WhatsApp both READS it here and
// WRITES to it below. One memory, two surfaces.
async function commentPrefs(origin) {
  try {
    const r = await fetch(`${origin}/api/preferences?item_type=comment&limit=15`, { cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    return Array.isArray(d?.prefs) ? d.prefs : [];
  } catch { return []; }
}

async function saveSteer(origin, card, draft, steer) {
  try {
    await fetch(`${origin}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        item_type: "comment",
        quoted_span: String(draft || "").slice(0, 200),
        feedback_text: steer,
        lead_name: card?.lead_name || "",
        lead_company: card?.company || "",
      }),
    });
  } catch { /* best-effort: a failed log must never cost him the redraft */ }
}

// Pick the angle the way he actually behaves: on Jun-9 he ignored all three
// suggested comments and wrote his own fourth. He doesn't shop angles, he
// reshapes a draft. So we take the top-ranked angle, draft it, and let a typed
// (or spoken) steer do the reshaping — no extra turn for a choice he skips.
async function draftComment(origin, card, { steer = "", regenerate = false, prefs = [] } = {}) {
  const post = card.post_text || card.signal;
  const angles = await ai(origin, "/api/comment-angles", {
    lead_name: card.lead_name,
    company: card.company,
    lead_title: card.lead_title,
    signal: post,
    url: card.url,
    feedback: prefs,
  });
  const angle = angles?.angles?.[0] || { label: "Add a sharp take", hint: "" };

  const out = await ai(origin, "/api/generate-comment", {
    lead_name: card.lead_name,
    company: card.company,
    lead_title: card.lead_title,
    signal: post,
    url: card.url,
    angle,
    regenerate: regenerate || Boolean(steer),
    // The steer rides in front of the learned prefs — it's about THIS draft.
    feedback: steer ? [{ feedback_text: steer }, ...prefs] : prefs,
  });
  return out?.ok ? out.comment : null;
}

// ─── Rendering ────────────────────────────────────────────────────────

// The WHOLE post. Never an excerpt (see the header). Airtable caps Post Text at
// 3000, so this always fits inside WhatsApp's 4096-char message.
function cardText(card, idx, total) {
  const who = [card.lead_title, card.company].filter(Boolean).join(", ");
  const post = (card.post_text || card.signal || "").trim();
  return [
    `*${idx + 1} of ${total} · Comment on a post*`,
    "",
    `*${card.lead_name}*${who ? `\n${who}` : ""}`,
    "",
    post || "(post text unavailable)",
  ].join("\n");
}

// His locked footer grammar: Mark as done / Skip, with Open on LinkedIn
// alongside. WhatsApp can't render a URL as a reply button (a link button and
// reply buttons are mutually exclusive message types), so Open sits as a
// tappable link in the same message, immediately above the two actions — not
// buried in a bubble further up.
function actionPrompt(url) {
  return [
    url ? `Open the post: ${url}` : null,
    "Copy the comment above, post it, then:",
  ].filter(Boolean).join("\n\n");
}

const TASK_BUTTONS = [
  { id: "done", title: "Mark as done" },
  { id: "skip", title: "Skip" },
];

async function sendMenu(phone, prefix) {
  return sendButtons(phone, prefix || "What do you want to do?", [
    { id: "tasks", title: "My tasks" },
    { id: "post", title: "Create a post" },
  ]);
}

// Send the task at state.idx: the card, then the draft on its own (copyable),
// then the actions.
async function presentTask(origin, phone, state, { steer = "", redraft = false } = {}) {
  const card = state.batch[state.idx];
  if (!card) return endBatch(phone, state);

  // Only re-send the card when arriving at this task. A redraft keeps the post
  // on screen and just replaces the comment — less noise, same focus.
  if (!redraft) {
    await sendText(phone, cardText(card, state.idx, state.batch.length), { preview: true });
  }

  const prefs = await commentPrefs(origin);
  if (steer) await saveSteer(origin, card, state.draft, steer);

  const comment = await draftComment(origin, card, { steer, regenerate: redraft, prefs });
  if (!comment) {
    await sendButtons(phone, "Couldn't draft that one.", [
      { id: "retry", title: "Try again" },
      { id: "skip", title: "Skip" },
    ]);
    return { ...state, draft: "" };
  }

  await sendText(phone, comment);                      // ← standalone = copyable
  await sendButtons(phone, actionPrompt(card.url), TASK_BUTTONS, {
    footer: "Or tell me what to change",
  });

  return { ...state, draft: comment };
}

async function endBatch(phone, state) {
  await sendMenu(phone, "That's the batch. Nothing else pending.");
  return { ...state, mode: "idle", batch: [], idx: 0, draft: "" };
}

async function advance(origin, phone, state) {
  const next = { ...state, idx: state.idx + 1 };
  if (next.idx >= next.batch.length) return endBatch(phone, next);
  return presentTask(origin, phone, next);
}

// ─── Create a post — the hooks engine ─────────────────────────────────

async function sendHooks(origin, phone, state, { regenerate = false } = {}) {
  const avoid = regenerate ? (state.seenHooks || []) : [];
  const out = await ai(origin, "/api/post-create", { mode: "hooks", avoid });
  if (!out?.ok || !out.hooks?.length) {
    await sendMenu(phone, "Couldn't get hooks. Try again?");
    return { ...state, mode: "idle" };
  }

  const hooks = out.hooks;
  // The full hook lines go in a text message — a list row truncates at 72 chars
  // and the line IS the hook. The list below is purely the picker.
  await sendText(phone, [
    "*Three hooks. Pick one.*",
    "",
    ...hooks.map((h, i) => `*${i + 1}. ${h.tag}*\n${h.line}`),
  ].join("\n\n"));

  await sendList(phone, "Which one do you want to write?", "Pick a hook", [
    ...hooks.map((h, i) => ({
      id: `hook:${i}`,
      title: `${i + 1}. ${h.tag}`,
      description: h.line,
    })),
    { id: "hooks:regen", title: "Show me Different Hooks", description: "Three new angles" },
  ]);

  return {
    ...state,
    mode: "post_hooks",
    hooks,
    seenHooks: [...(state.seenHooks || []), ...hooks.map((h) => h.line)].slice(-9),
  };
}

const POST_BUTTONS = [
  { id: "post:done", title: "Mark as done" },
  { id: "post:skip", title: "Skip" },
];

async function sendPostDraft(origin, phone, state, { notes = "", feedback = "" } = {}) {
  const out = feedback
    ? await ai(origin, "/api/post-create", { mode: "refine", post: state.post, feedback })
    : await ai(origin, "/api/post-create", { mode: "generate", hook: state.hook, notes });

  if (!out?.ok || !out.post) {
    await sendButtons(phone, "Couldn't write that one.", [
      { id: "post:retry", title: "Try again" },
      { id: "post:skip", title: "Skip" },
    ]);
    return state;
  }

  await sendText(phone, out.post);                     // ← standalone = copyable
  await sendButtons(phone, `Copy it and post it.\n\nOpen LinkedIn: ${LINKEDIN_COMPOSER}`, POST_BUTTONS, {
    footer: "Or tell me what to change",
  });

  return { ...state, mode: "post_review", post: out.post };
}

// ─── The state machine ────────────────────────────────────────────────

export async function startBatch(origin, phone, state = {}) {
  const cards = await fetchCommentTasks(BATCH_SIZE);
  if (!cards.length) {
    await sendMenu(phone, "No comment tasks pending right now.");
    return { ...state, mode: "idle", batch: [], idx: 0 };
  }
  const next = { ...state, mode: "tasks", batch: cards, idx: 0, draft: "" };
  const intro = await sendText(phone, `You've got *${cards.length}* ${cards.length === 1 ? "post" : "posts"} to comment on.`);
  // A PUSH (cron / manual kick) can land outside WhatsApp's 24h service window,
  // where Meta only allows approved templates. Inbound-triggered batches never
  // hit this — the inbound message is what opens the window. Surface it loudly
  // instead of silently dropping three tasks on the floor.
  if (!intro.ok && intro.error === "outside_24h_window") {
    throw Object.assign(new Error("outside_24h_window"), { code: "outside_24h_window" });
  }
  return presentTask(origin, phone, next);
}

export async function handleInbound(origin, msg) {
  const phone = normalizeNumber(msg.from);
  let state = await getSession(phone);

  // Meta re-delivers a webhook until it gets a 200, and an AI turn can outrun
  // its patience. Without this, one message drafts (and bills) twice.
  if (state.lastMsgId === msg.id) return;
  state.lastMsgId = msg.id;
  await saveSession(phone, state);

  // A voice note is just text that arrived by mic. Transcribe it up front and
  // let it flow through whatever step he's on — notes, a steer, refine feedback.
  if (msg.kind === "audio") {
    const media = await downloadMedia(msg.value).catch(() => null);
    const text = media ? await transcribe(media.buffer, media.mime) : null;
    if (!text) {
      await sendText(phone, "Couldn't catch that. Send it again, or type it.");
      return saveSession(phone, state);
    }
    msg = { ...msg, kind: "text", value: text };
  }

  if (msg.kind === "unsupported") {
    await sendText(phone, "Send me a message or a voice note.");
    return saveSession(phone, state);
  }

  const raw = String(msg.value || "").trim();
  const cmd = msg.kind === "reply" ? raw : raw.toLowerCase();
  const mode = state.mode || "idle";

  // Global commands — they work from anywhere, so he's never stuck mid-flow.
  if (["tasks", "task", "my tasks", "start"].includes(cmd)) {
    state = await startBatch(origin, phone, state);
    return saveSession(phone, state);
  }
  if (["post", "create a post", "create post", "new post"].includes(cmd)) {
    state = await sendHooks(origin, phone, state);
    return saveSession(phone, state);
  }
  if (["menu", "hi", "hello", "hey", "help"].includes(cmd)) {
    await sendMenu(phone, "Side Kick here. Two things I can do:");
    return saveSession(phone, { ...state, mode: "idle" });
  }

  // ── In a task ──
  if (mode === "tasks" && state.batch?.length) {
    const card = state.batch[state.idx];
    if (cmd === "done" || cmd === "skip") {
      if (card) await actionTask(card.id, cmd === "done" ? "done" : "skip");
      state = await advance(origin, phone, state);
      return saveSession(phone, state);
    }
    if (cmd === "retry") {
      state = await presentTask(origin, phone, state, { redraft: true });
      return saveSession(phone, state);
    }
    // Anything he says is a steer on the current draft — typed or spoken. This
    // is the rewrite, and it also lands in the learned-prefs store.
    if (msg.kind === "text" && raw) {
      state = await presentTask(origin, phone, state, { steer: raw, redraft: true });
      return saveSession(phone, state);
    }
  }

  // ── Creating a post ──
  if (cmd === "hooks:regen") {
    state = await sendHooks(origin, phone, state, { regenerate: true });
    return saveSession(phone, state);
  }
  if (cmd.startsWith("hook:")) {
    const i = parseInt(cmd.split(":")[1], 10);
    const hook = state.hooks?.[i];
    if (!hook) {
      state = await sendHooks(origin, phone, state);
      return saveSession(phone, state);
    }
    await sendText(phone, `*${hook.tag}*\n\n${hook.line}\n\nNow tell me what you want to say. Record a voice note or type a couple of lines. Or send *go* and I'll write it from the hook alone.`);
    return saveSession(phone, { ...state, hook, mode: "post_notes" });
  }
  if (mode === "post_notes" && msg.kind === "text") {
    const notes = ["go", "just write it", "write it"].includes(cmd) ? "" : raw;
    state = await sendPostDraft(origin, phone, state, { notes });
    return saveSession(phone, state);
  }
  if (mode === "post_review") {
    if (cmd === "post:done" || cmd === "post:skip") {
      await sendMenu(phone, cmd === "post:done" ? "Done. Anything else?" : "Skipped. Anything else?");
      return saveSession(phone, { ...state, mode: "idle", post: "", hook: null });
    }
    if (cmd === "post:retry") {
      state = await sendPostDraft(origin, phone, state, { feedback: "Rewrite this from scratch, different structure." });
      return saveSession(phone, state);
    }
    // Same as comments: whatever he says is the refine loop.
    if (msg.kind === "text" && raw) {
      state = await sendPostDraft(origin, phone, state, { feedback: raw });
      return saveSession(phone, state);
    }
  }

  // Fell through — show the two doors rather than "I didn't understand that".
  await sendMenu(phone, "Not sure what you meant. Here's what I can do:");
  return saveSession(phone, { ...state, mode: "idle" });
}
