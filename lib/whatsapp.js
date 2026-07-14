// ═══════════════════════════════════════════════════════════════════
// WhatsApp transport — Meta Cloud API (Graph)
//
// The send/receive plumbing ONLY. No product logic lives here (that's
// lib/wa-flow.js). Kept behind these four functions so swapping the
// provider later (Twilio, a BSP) is a rewrite of this file and nothing
// else.
//
// No SDK — the 3-dependency rule (AGENTS.md) holds: next, react,
// react-dom and nothing more. Graph is a plain fetch + Bearer token.
//
// Env:
//   WHATSAPP_TOKEN             — Graph access token (system-user token in prod)
//   WHATSAPP_PHONE_NUMBER_ID   — the sending number's Graph ID (NOT the number)
//   WHATSAPP_APP_SECRET        — Meta app secret; verifies inbound signatures
//   WHATSAPP_VERIFY_TOKEN      — shared string echoed during webhook setup
//   WHATSAPP_ALLOWED_NUMBERS   — comma-separated E.164 allowlist (no "+")
// ═══════════════════════════════════════════════════════════════════

import crypto from "crypto";

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || "v21.0";
const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;

// Meta's hard limits. Exceeding any of them is a 400 from Graph, so we clamp
// at the edge rather than discover it in production.
export const LIMITS = {
  TEXT: 4096,        // body of a text message
  INTERACTIVE_BODY: 1024,
  BUTTON_TITLE: 20,  // and max 3 buttons
  ROW_TITLE: 24,     // list rows: max 10
  ROW_DESC: 72,
  REPLY_ID: 256,
};

export function waConfigured() {
  return Boolean(TOKEN && PHONE_NUMBER_ID);
}

// Digits only — Meta sends `from` as E.164 without "+", and humans write the
// allowlist however they please.
export function normalizeNumber(n) {
  return String(n || "").replace(/\D/g, "");
}

export function allowedNumbers() {
  return String(process.env.WHATSAPP_ALLOWED_NUMBERS || "")
    .split(",")
    .map(normalizeNumber)
    .filter(Boolean);
}

// The test number can only reach pre-registered recipients anyway, but an
// explicit allowlist means a wrong-number inbound can never burn AI spend or
// leak a lead's name to a stranger.
export function isAllowed(from) {
  const list = allowedNumbers();
  if (!list.length) return false; // fail closed — unset allowlist blocks all
  return list.includes(normalizeNumber(from));
}

// Meta signs every webhook body with the app secret. Verify against the RAW
// body text — re-serializing the parsed JSON changes bytes and breaks the HMAC.
export function verifySignature(rawBody, header) {
  if (!APP_SECRET) return false; // fail closed
  const sig = String(header || "");
  if (!sig.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", APP_SECRET).update(rawBody, "utf8").digest("hex");
  const got = sig.slice(7);
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got, "utf8"), Buffer.from(expected, "utf8"));
}

function clamp(s, n) {
  const t = String(s ?? "").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

async function graphSend(payload) {
  if (!waConfigured()) {
    return { ok: false, error: "WhatsApp not configured (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)" };
  }
  const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const code = data?.error?.code;
    const msg = data?.error?.message || `Graph ${r.status}`;
    console.error("[WA] send failed:", r.status, code, String(msg).slice(0, 200));
    // 131047 = "message outside the 24h customer-service window". It is the one
    // error the operator can actually fix (by messaging the number), so name it.
    if (code === 131047) {
      return { ok: false, error: "outside_24h_window", detail: msg };
    }
    return { ok: false, error: msg, code };
  }
  return { ok: true, id: data?.messages?.[0]?.id || null };
}

// A plain text message. The AI drafts go out through THIS — on its own, with no
// prefix or chrome — because a standalone WhatsApp message is long-press
// copyable. That is the whole "post it" affordance on this surface (we never
// auto-post; AGENTS.md).
export function sendText(to, text, { preview = false } = {}) {
  return graphSend({
    to: normalizeNumber(to),
    type: "text",
    text: { body: clamp(text, LIMITS.TEXT), preview_url: preview },
  });
}

// Up to 3 reply buttons. `buttons` = [{ id, title }]. The id comes back on the
// inbound webhook verbatim, so it carries the intent (e.g. "done", "hook:h2").
export function sendButtons(to, body, buttons, { footer } = {}) {
  const action = {
    buttons: buttons.slice(0, 3).map((b) => ({
      type: "reply",
      reply: { id: clamp(b.id, LIMITS.REPLY_ID), title: clamp(b.title, LIMITS.BUTTON_TITLE) },
    })),
  };
  return graphSend({
    to: normalizeNumber(to),
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: clamp(body, LIMITS.INTERACTIVE_BODY) },
      ...(footer ? { footer: { text: clamp(footer, 60) } } : {}),
      action,
    },
  });
}

// A single-section list — the escape hatch when 3 buttons aren't enough
// (hook picking needs 3 hooks + regenerate). `rows` = [{ id, title, description }].
export function sendList(to, body, buttonLabel, rows, { header } = {}) {
  return graphSend({
    to: normalizeNumber(to),
    type: "interactive",
    interactive: {
      type: "list",
      ...(header ? { header: { type: "text", text: clamp(header, 60) } } : {}),
      body: { text: clamp(body, LIMITS.INTERACTIVE_BODY) },
      action: {
        button: clamp(buttonLabel, LIMITS.BUTTON_TITLE),
        sections: [{
          rows: rows.slice(0, 10).map((r) => ({
            id: clamp(r.id, LIMITS.REPLY_ID),
            title: clamp(r.title, LIMITS.ROW_TITLE),
            ...(r.description ? { description: clamp(r.description, LIMITS.ROW_DESC) } : {}),
          })),
        }],
      },
    },
  });
}

// Download an inbound media object (we only ever want voice notes). Two hops:
// the media id resolves to a short-lived URL, which must then be fetched with
// the SAME bearer token — an unauthenticated GET on that URL returns nothing.
export async function downloadMedia(mediaId) {
  const meta = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    cache: "no-store",
  });
  if (!meta.ok) throw new Error(`media lookup failed: ${meta.status}`);
  const { url, mime_type } = await meta.json();
  if (!url) throw new Error("media has no url");

  const bin = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    cache: "no-store",
  });
  if (!bin.ok) throw new Error(`media download failed: ${bin.status}`);
  return {
    buffer: Buffer.from(await bin.arrayBuffer()),
    mime: mime_type || "audio/ogg",
  };
}

// Normalize an inbound webhook message into { from, id, kind, value }:
//   kind "reply" → value is the button/list id we set (an intent)
//   kind "text"  → value is what they typed
//   kind "audio" → value is the media id, to be transcribed into text
//   kind "unsupported" → an image/doc/etc we have no use for
export function parseInbound(payload) {
  const change = payload?.entry?.[0]?.changes?.[0]?.value;
  const msg = change?.messages?.[0];
  if (!msg) return null; // delivery/read status events land here — ignore them

  const base = { from: msg.from, id: msg.id, type: msg.type };

  if (msg.type === "interactive") {
    const i = msg.interactive || {};
    const reply = i.button_reply || i.list_reply;
    if (reply?.id) return { ...base, kind: "reply", value: reply.id, title: reply.title || "" };
    return { ...base, kind: null, value: "" };
  }
  if (msg.type === "text") {
    return { ...base, kind: "text", value: String(msg.text?.body || "").trim() };
  }
  // A voice note IS the point of being on WhatsApp — it's the native gesture,
  // and the one Kunal asked for on the create-post card ("Skip, let me record").
  // Transcribed upstream, then treated exactly like typed text.
  if (msg.type === "audio" || msg.type === "voice") {
    return { ...base, kind: "audio", value: msg.audio?.id || msg.voice?.id || "" };
  }
  return { ...base, kind: "unsupported", value: msg.type };
}
