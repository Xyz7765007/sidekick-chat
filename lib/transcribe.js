// ═══════════════════════════════════════════════════════════════════
// Voice note → text
//
// Kunal's create-post card kept exactly two CTAs when he stripped it to the
// bone on 30 Jun, and one was "Skip, let me record". On WhatsApp, holding the
// mic IS the native gesture — so a voice note is a first-class input here, not
// a nice-to-have.
//
// Claude cannot do this: the Messages API accepts text, images and PDFs, and
// Anthropic has no speech-to-text endpoint at all. Transcription is the one
// step in the whole flow that can't run on the Claude key.
//
// So we do NOT add an OpenAI key to this repo. SignalScope already has one, so
// the audio goes there — POST /api/sidekick/transcribe, authenticated with the
// same SIDEKICK_API_KEY this app already carries. No new credential anywhere,
// and the key stays in the one repo that already owned it.
//
// Everything downstream of the transcript (angles, comment, post, refine) still
// runs on Claude exactly as before.
// ═══════════════════════════════════════════════════════════════════

const SIGNALSCOPE_URL = process.env.SIGNALSCOPE_API_URL;
const SIDEKICK_KEY = process.env.SIDEKICK_API_KEY;

// Returns the transcript, or null. Never throws into the webhook path — a failed
// transcription must degrade to "say it again, or type it", not kill the turn.
export async function transcribe(buffer, mime = "audio/ogg") {
  if (!SIGNALSCOPE_URL || !SIDEKICK_KEY) return null;
  if (!buffer?.length) return null;

  try {
    const r = await fetch(`${SIGNALSCOPE_URL.replace(/\/$/, "")}/api/sidekick/transcribe`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SIDEKICK_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ audio: buffer.toString("base64"), mime }),
      cache: "no-store",
    });
    const d = await r.json().catch(() => ({}));
    if (!d?.ok || !d.text) {
      console.error("[TRANSCRIBE] failed:", r.status, String(d?.error || "").slice(0, 120));
      return null;
    }
    return d.text;
  } catch (e) {
    console.error("[TRANSCRIBE] Exception:", e.message);
    return null;
  }
}
