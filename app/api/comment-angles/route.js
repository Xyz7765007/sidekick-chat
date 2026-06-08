// ═══════════════════════════════════════════════════════════════════
// POST /api/comment-angles
// Body: { lead_name, company, lead_title, signal, url }
//
// For a LinkedIn-engagement card (task_type === "linkedin_engagement"),
// produce a lead-safe brief + EXACTLY 3 distinct commenting angles the
// operator can pick from. Output JSON:
//   { ok, summary, bullets: [string], angles: [{ id, label, hint }] }
//
// IMPORTANT (internal-vs-public split): the inbound `signal` text MAY
// contain internal scoring markers (📊 score, 📋 rule names, etc.). This
// route is generating PUBLIC-facing commenting guidance, so the prompt is
// told to treat the signal ONLY as a description of the post's content and
// to NEVER surface scores, rule names, or internal jargon. The downstream
// generate-comment route does the same.
//
// Cheap path: Haiku 4.5. Bounded input (post text capped at 2000 chars).
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || "claude-haiku-4-5-20251001";

const POST_TEXT_CAP = 2000;
const FEEDBACK_BLOCK_CHAR_CAP = 1500;

// Bounded "OPERATOR FEEDBACK" block from learned comment prefs. Same
// builder shape as generate-comment. Style guidance only — never lets a
// pref reintroduce internal scoring or rule names.
function buildFeedbackBlock(feedback) {
  if (!Array.isArray(feedback) || !feedback.length) return "";
  const lines = [];
  let used = 0;
  for (const p of feedback) {
    const note = String(p?.feedback_text || "").replace(/\s+/g, " ").trim();
    if (!note) continue;
    const span = String(p?.quoted_span || "").replace(/\s+/g, " ").trim();
    const line = span
      ? `- on "${span.slice(0, 120)}": ${note.slice(0, 240)}`
      : `- ${note.slice(0, 240)}`;
    if (used + line.length + 1 > FEEDBACK_BLOCK_CHAR_CAP) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return "";
  return `OPERATOR FEEDBACK — past preferences on comments (bias the angles toward these, most recent first):\n${lines.join("\n")}`;
}

const SYSTEM_PROMPT = `You help a B2B operator decide how to comment on a LinkedIn post so the comment starts a real conversation (not empty praise).

You are given context about a LinkedIn post and its author. Some of that context may contain internal sales-scoring jargon (numeric scores out of 100, rule names, "ICP fit", etc.). NEVER repeat any of that — it is internal-only. Treat the input purely as a description of what the post is ABOUT and who the author is.

Return STRICT JSON ONLY (no markdown, no prose, no code fences) with this exact shape:
{
  "summary": "<1 sentence, max ~30 words, what the post is about>",
  "bullets": ["<short phrase>", "<short phrase>", "<short phrase>"],
  "angles": [
    { "id": "a1", "label": "<3-5 word angle name>", "hint": "<1 sentence on the take to make>" },
    { "id": "a2", "label": "...", "hint": "..." },
    { "id": "a3", "label": "...", "hint": "..." }
  ]
}

Rules:
- EXACTLY 3 angles. Each must be genuinely DISTINCT — a different lens, not three rewordings.
- NO generic "great post / I agree / well said / thanks for sharing" angles. Each angle must add a point of view: a sharpening, a counter, a concrete example, a question that extends the idea, a related tension, etc.
- bullets: 2-4 short phrases capturing what the post covers. No scores, no rule names.
- Keep everything concise and concrete. Output ONLY the JSON object.`;

function safeParseJson(text) {
  if (!text) return null;
  let t = text.trim();
  // Strip accidental code fences.
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(t);
  } catch {
    // Last-ditch: pull the first {...} block.
    const m = t.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { return null; }
    }
    return null;
  }
}

export async function POST(request) {
  if (!ANTHROPIC_API_KEY) {
    return Response.json({ ok: false, error: "Server missing ANTHROPIC_API_KEY" }, { status: 500 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const { lead_name, company, lead_title, signal, url, feedback } = body || {};
  const postText = typeof signal === "string" ? signal.slice(0, POST_TEXT_CAP) : "";
  if (!postText && !lead_name) {
    return Response.json({ ok: false, error: "post context required" }, { status: 400 });
  }

  const feedbackBlock = buildFeedbackBlock(feedback);

  const contextBlock = [
    lead_name ? `Author: ${lead_name}` : null,
    lead_title ? `Author title: ${lead_title}` : null,
    company ? `Author company: ${company}` : null,
    url ? `Post URL: ${url}` : null,
    "",
    "Post content / context:",
    postText || "(no post text available — infer from author context only)",
    feedbackBlock ? `\n${feedbackBlock}` : null,
  ].filter(Boolean).join("\n");

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        max_tokens: 600,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: contextBlock }],
      }),
    });

    if (!r.ok) {
      const errTxt = await r.text();
      console.error("[COMMENT-ANGLES] Anthropic error:", r.status, errTxt.slice(0, 200));
      return Response.json({ ok: false, error: "Angle generation failed", status: r.status }, { status: 500 });
    }

    const data = await r.json();
    const raw = (data?.content?.[0]?.text || "").trim();
    const parsed = safeParseJson(raw);
    if (!parsed || !Array.isArray(parsed.angles)) {
      console.error("[COMMENT-ANGLES] Unparseable model output:", raw.slice(0, 200));
      return Response.json({ ok: false, error: "Model returned malformed angles" }, { status: 500 });
    }

    // Normalize: exactly 3 angles, stable ids.
    const angles = (parsed.angles || []).slice(0, 3).map((a, i) => ({
      id: a?.id || `a${i + 1}`,
      label: String(a?.label || `Angle ${i + 1}`).slice(0, 60),
      hint: String(a?.hint || "").slice(0, 200),
    }));
    const bullets = Array.isArray(parsed.bullets)
      ? parsed.bullets.map(b => String(b).slice(0, 140)).filter(Boolean).slice(0, 4)
      : [];

    return Response.json({
      ok: true,
      summary: String(parsed.summary || "").slice(0, 240),
      bullets,
      angles,
    });
  } catch (e) {
    console.error("[COMMENT-ANGLES] Exception:", e.message);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
