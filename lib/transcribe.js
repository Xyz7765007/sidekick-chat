// ═══════════════════════════════════════════════════════════════════
// Voice note → text (OpenAI Whisper)
//
// Kunal's create-post card kept exactly two CTAs when he stripped it to the
// bone on 30 Jun: "Show me Different Hooks" and "Skip, let me record". Record
// is load-bearing — and on WhatsApp, holding the mic is the native gesture.
// So a voice note here is a first-class input, not a nice-to-have: we
// transcribe it and treat it exactly like typed text (notes, a steer on a
// comment, or refine feedback — whatever the current step expects).
//
// Anthropic has no speech-to-text, so this is the one OpenAI call in the repo.
// Still no new npm dependency (the 3-dependency rule holds): FormData + Blob
// are native on Node 18+, so the multipart upload is a plain fetch.
//
// Env: OPENAI_API_KEY  (new to this repo — SignalScope already has one)
// ═══════════════════════════════════════════════════════════════════

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "whisper-1";

// WhatsApp voice notes are ~1 min of Opus at most in practice; 25MB is the API
// ceiling. Anything larger is a misuse of the surface, not a real note.
const MAX_BYTES = 24 * 1024 * 1024;

export function transcribeConfigured() {
  return Boolean(OPENAI_API_KEY);
}

// Returns the transcript string, or null (never throws into the webhook path —
// a failed transcription must degrade to "type it instead", not kill the turn).
export async function transcribe(buffer, mime = "audio/ogg") {
  if (!OPENAI_API_KEY) return null;
  if (!buffer?.length || buffer.length > MAX_BYTES) return null;

  try {
    const form = new FormData();
    // WhatsApp sends Opus-in-Ogg. Whisper sniffs the container, but it needs a
    // filename with a real extension or it rejects the part outright.
    const ext = mime.includes("mp4") || mime.includes("mpeg") ? "m4a" : "ogg";
    form.append("file", new Blob([buffer], { type: mime }), `voice.${ext}`);
    form.append("model", TRANSCRIBE_MODEL);

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });
    if (!r.ok) {
      console.error("[TRANSCRIBE] OpenAI error:", r.status, (await r.text()).slice(0, 200));
      return null;
    }
    const data = await r.json();
    const text = String(data?.text || "").trim();
    return text || null;
  } catch (e) {
    console.error("[TRANSCRIBE] Exception:", e.message);
    return null;
  }
}
