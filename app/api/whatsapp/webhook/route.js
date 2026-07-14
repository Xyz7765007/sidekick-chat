// ═══════════════════════════════════════════════════════════════════
// WhatsApp webhook — Meta Cloud API
//
// GET  → the one-time subscription handshake (Meta echoes hub.challenge)
// POST → every inbound message + delivery status for the number
//
// Set this URL in the Meta app (WhatsApp → Configuration → Callback URL)
// and subscribe to the `messages` field:
//   https://sidekick-chat-beige.vercel.app/api/whatsapp/webhook
//
// Security: Meta HMAC-signs each body with the app secret. We verify against
// the RAW bytes before we look at the payload, then check the sender against
// WHATSAPP_ALLOWED_NUMBERS. Both fail CLOSED — an unset secret or an empty
// allowlist rejects everything rather than opening the door.
//
// We always answer 200 once the signature checks out, even on internal error:
// Meta re-delivers on any non-2xx, so a poison message would otherwise loop
// forever, redrafting (and re-billing) on every retry. Dedupe on message id
// in the session covers the retries that DO happen (a slow AI turn can outrun
// Meta's patience).
// ═══════════════════════════════════════════════════════════════════

import { verifySignature, parseInbound, isAllowed, waConfigured } from "../../../../lib/whatsapp.js";
import { handleInbound } from "../../../../lib/wa-flow.js";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
// Worst case in one turn: comment-angles (Sonnet) + generate-comment (Sonnet)
// + a few Airtable round-trips. 60s is generous headroom over the ~15s real cost.
export const maxDuration = 60;

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// ─── Subscription handshake ───────────────────────────────────────────
export async function GET(request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    // Meta wants the raw challenge back as text/plain, not JSON.
    return new Response(challenge || "", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return new Response("Forbidden", { status: 403 });
}

// ─── Inbound messages ─────────────────────────────────────────────────
export async function POST(request) {
  if (!waConfigured()) {
    return Response.json({ ok: false, error: "WhatsApp env not set" }, { status: 500 });
  }

  const raw = await request.text();
  if (!verifySignature(raw, request.headers.get("x-hub-signature-256"))) {
    console.error("[WA] signature verification failed");
    return new Response("Forbidden", { status: 403 });
  }

  let payload;
  try { payload = JSON.parse(raw); }
  catch { return Response.json({ ok: true }); } // malformed: ack, don't retry

  const msg = parseInbound(payload);
  if (!msg) return Response.json({ ok: true });  // delivery/read status event

  if (!isAllowed(msg.from)) {
    console.warn("[WA] blocked sender:", msg.from);
    return Response.json({ ok: true });          // ack silently; never reply
  }

  try {
    await handleInbound(new URL(request.url).origin, msg);
  } catch (e) {
    console.error("[WA] handler error:", e.message);
  }
  return Response.json({ ok: true });
}
