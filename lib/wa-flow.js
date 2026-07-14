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

import { sendText, sendButtons, sendList, normalizeNumber, downloadMedia, LIMITS } from "./whatsapp.js";
import { transcribe } from "./transcribe.js";
import { byPriority } from "./task-priority.js";
import { classifyTaskMessage } from "./wa-intent.js";

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
      // INTERNAL context — why this surfaced. Never rendered to WhatsApp and
      // never allowed into drafted copy; it exists so the per-task chatbot can
      // answer "why am I seeing this" and "is this a fit". Same leadContext
      // object the web card hands to /api/post-chat.
      score: c.score || 0,
      task_rule: c.task_rule || "",
      task_type: c.task_type || "",
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

// A steer is captured, NOT auto-applied. This matters more than it looks.
//
// `item_type: "comment"` is the store commentPrefs() reads back and injects into
// EVERY future draft, on both surfaces. On the web it is only ever written by a
// deliberate act — highlight the text, type a note, hit Submit. A one-off
// instruction ("make it shorter", "mention fintechs") is not a standing taste;
// writing it there would make a fintech aside leak into an unrelated
// manufacturing lead's comment forever, and would evict the real preferences he
// took the trouble to give. So steers land under their own item_type: reviewable
// signal ("we'll see what kind of things people are saying and then you can learn
// from that"), with nothing auto-steering the next draft behind his back.
async function saveSteer(origin, card, draft, steer) {
  try {
    await fetch(`${origin}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        item_type: "comment_steer",
        quoted_span: String(draft || "").slice(0, 200),
        feedback_text: steer,
        lead_name: card?.lead_name || "",
        lead_company: card?.company || "",
      }),
    });
  } catch { /* best-effort: a failed log must never cost him the redraft */ }
}

async function saveTaskFeedback(origin, card, text) {
  try {
    await fetch(`${origin}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        item_type: "task_feedback",
        feedback_text: text,
        lead_name: card?.lead_name || "",
        lead_company: card?.company || "",
      }),
    });
  } catch { /* best-effort */ }
}

// "Talk to your agent about this task" — the per-post chatbot, on WhatsApp.
// Same /api/post-chat the web card uses, same scoping (this post + this person
// + the internal context), same feedback detection. He can ask who someone is,
// ask it to simplify the post, or say "this isn't relevant" and have that land
// in the feed's memory — then carry on to the next task and do it again there.
async function askAboutTask(origin, card, message, history) {
  const author = [card.lead_name, card.lead_title, card.company].filter(Boolean).join(" — ");
  const d = await ai(origin, "/api/post-chat", {
    message,
    post: card.post_text || card.signal,
    author,
    history,
    leadContext: {
      score: card.score,
      signal: card.signal,
      task_rule: card.task_rule,
      task_type: card.task_type,
    },
  });
  if (!d?.ok || !d.reply) return null;
  // post-chat decides when a message was feedback rather than a question. When
  // it was, capture it durably — same sink, same item_type as the web app. We
  // capture and acknowledge; we do NOT auto-suppress the rule off one read of
  // one sentence. Autonomy nobody asked for is the thing he rejects hardest.
  if (d.feedback?.text) await saveTaskFeedback(origin, card, d.feedback.text);
  return { reply: d.reply, isFeedback: Boolean(d.feedback?.text) };
}

// Pick the angle the way he actually behaves: on Jun-9 he ignored all three
// suggested comments and wrote his own fourth. He doesn't shop angles, he
// reshapes a draft. So we take the top-ranked angle, draft it, and let a typed
// (or spoken) steer do the reshaping — no extra turn for a choice he skips.
async function draftComment(origin, card, { steer = "", regenerate = false, prefs = [], angle: cached = null } = {}) {
  const post = card.post_text || card.signal;
  // The angle doesn't change when he asks for a shorter comment — so on a
  // redraft we reuse the one we already picked. Saves a whole Sonnet round trip
  // and, on a phone, the silence that comes with it.
  let angle = cached;
  if (!angle) {
    const angles = await ai(origin, "/api/comment-angles", {
      lead_name: card.lead_name,
      company: card.company,
      lead_title: card.lead_title,
      signal: post,
      url: card.url,
      feedback: prefs,
    });
    angle = angles?.angles?.[0] || { label: "Add a sharp take", hint: "" };
  }

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
  return out?.ok ? { comment: out.comment, angle } : null;
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

  // Arriving at a task clears the per-task chat: the agent is scoped to ONE
  // post, so the last lead's conversation must not bleed into this one. A
  // redraft is still the same task, so it keeps the thread.
  const base = redraft ? state : { ...state, chat: [] };

  // Only re-send the card when arriving. A redraft keeps the post on screen and
  // just replaces the comment — less noise, same focus.
  if (!redraft) {
    await sendText(phone, cardText(card, state.idx, state.batch.length), { preview: true });
  }

  const prefs = await commentPrefs(origin);
  if (steer) await saveSteer(origin, card, state.draft, steer);

  const out = await draftComment(origin, card, {
    steer,
    regenerate: redraft,
    prefs,
    angle: redraft ? base.angle : null,   // same task, same angle
  });
  if (!out) {
    await sendButtons(phone, "Couldn't draft that one.", [
      { id: "retry", title: "Try again" },
      { id: "skip", title: "Skip" },
    ]);
    return { ...base, draft: "" };
  }

  await sendText(phone, out.comment);                  // ← standalone = copyable
  await sendButtons(phone, actionPrompt(card.url), TASK_BUTTONS, {
    footer: "Ask me anything, or say what to change",
  });

  return { ...base, draft: out.comment, angle: out.angle };
}

// An answer from the per-task agent, with the task's actions riding along so he
// is never left scrolling back up a thread to find Mark as done. Short answers
// (the common case — post-chat is told to stay to 1-4 sentences) go out as ONE
// interactive message; a long one gets its own text bubble first.
async function sendAnswer(phone, card, reply, { isFeedback = false } = {}) {
  // If he just told us the lead is irrelevant, don't leave him staring at a
  // comment for a lead he rejected and make him say it twice. Carry the next
  // move in the same breath. The feedback is captured; the skip stays HIS call.
  const body = isFeedback ? `${reply}\n\nSkip this one?` : reply;
  const footer = "Ask me anything, or say what to change";

  if (body.length > LIMITS.INTERACTIVE_BODY) {
    await sendText(phone, body);
    // Deliberately NOT the full action prompt again — repeating the post link
    // and the copy instruction under every answer turns the thread into chrome.
    await sendButtons(phone, "What next?", TASK_BUTTONS, { footer });
    return;
  }
  await sendButtons(phone, body, TASK_BUTTONS, { footer });
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
    footer: "Ask me anything, or say what to change",
  });

  // A fresh post starts a fresh conversation; a refine continues the one we're in.
  return { ...state, mode: "post_review", post: out.post, chat: feedback ? (state.chat || []) : [] };
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
    // Anything he says — typed or spoken — is one of two things, and he should
    // never have to tell us which. Either he wants the comment changed, or he
    // wants to TALK about the task: ask who this person is, have the post
    // simplified, or say it isn't relevant (which post-chat logs as feedback).
    // Both are things he does on the web card; here they share one input box.
    if (msg.kind === "text" && raw && card) {
      const intent = await classifyTaskMessage(raw, state.draft);

      if (intent === "edit") {
        state = await presentTask(origin, phone, state, { steer: raw, redraft: true });
        return saveSession(phone, state);
      }

      const history = Array.isArray(state.chat) ? state.chat : [];
      const answer = await askAboutTask(origin, card, raw, history);
      if (!answer) {
        await sendButtons(phone, "Didn't catch that. Ask me again?", TASK_BUTTONS, {
          footer: "Ask me anything, or say what to change",
        });
        return saveSession(phone, state);
      }
      await sendAnswer(phone, card, answer.reply, { isFeedback: answer.isFeedback });
      // Keep the thread so follow-ups work ("and what does that company do?").
      // Capped — the session blob is not a transcript store.
      const chat = [...history, { role: "user", text: raw }, { role: "assistant", text: answer.reply }].slice(-8);
      return saveSession(phone, { ...state, chat });
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
    // Same split as a comment task. "Cut the last line" rewrites the post;
    // "is this too long for LinkedIn?" is a question, and rewriting the draft
    // in answer to it would be maddening. Kunal asked for this card to be "an
    // AI agent that is chatting and getting feedback and reviewing my post" —
    // chatting and rewriting are both in that, and they are not the same thing.
    if (msg.kind === "text" && raw) {
      const intent = await classifyTaskMessage(raw, state.post);

      if (intent === "edit") {
        state = await sendPostDraft(origin, phone, state, { feedback: raw });
        return saveSession(phone, state);
      }

      const history = Array.isArray(state.chat) ? state.chat : [];
      const d = await ai(origin, "/api/post-chat", {
        message: raw,
        post: state.post,
        author: "The operator themselves — this is their OWN draft post, not someone else's",
        history,
        leadContext: { task_type: "post_create" },
      });
      const reply = d?.ok && d.reply ? d.reply : null;
      if (!reply) {
        await sendButtons(phone, "Didn't catch that. Ask me again?", POST_BUTTONS, {
          footer: "Ask me anything, or say what to change",
        });
        return saveSession(phone, state);
      }
      // Same capture as the comment path — a hole here would be a silent gap in
      // the one loop he checks on ("the feedback I'm giving it, that goes in?").
      if (d.feedback?.text) await saveTaskFeedback(origin, null, d.feedback.text);
      if (reply.length > LIMITS.INTERACTIVE_BODY) {
        await sendText(phone, reply);
        await sendButtons(phone, "Your post is above.", POST_BUTTONS, { footer: "Ask me anything, or say what to change" });
      } else {
        await sendButtons(phone, reply, POST_BUTTONS, { footer: "Ask me anything, or say what to change" });
      }
      const chat = [...history, { role: "user", text: raw }, { role: "assistant", text: reply }].slice(-8);
      return saveSession(phone, { ...state, chat });
    }
  }

  // Fell through — show the two doors rather than "I didn't understand that".
  await sendMenu(phone, "Not sure what you meant. Here's what I can do:");
  return saveSession(phone, { ...state, mode: "idle" });
}
