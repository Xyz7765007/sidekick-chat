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
// Model: COMMENT_MODEL (default claude-sonnet-4-6). Reasoning quality
// matters here — Haiku produced generic, indistinct angles (Kunal: "none of
// these made sense"). Sonnet grounds the angles in the post's actual
// substance. generate-comment uses the SAME model. summarize stays on Haiku.
// Bounded input (post text capped at 4000 chars — Kunal item 16: give the
// model the FULL post so angles are grounded and the operator never has to
// leave the app to read it).
// ═══════════════════════════════════════════════════════════════════

import { OPERATOR_WORLD, OPERATOR_VOICE, OPERATOR_MOVES } from "../../../lib/comment-voice.js";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const COMMENT_MODEL = process.env.COMMENT_MODEL || "claude-sonnet-4-6";

const POST_TEXT_CAP = 4000;
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

const SYSTEM_PROMPT = `${OPERATOR_WORLD}

${OPERATOR_VOICE}

${OPERATOR_MOVES}

You help this operator decide how to comment on a specific LinkedIn post so the comment starts a real conversation and makes the operator look insightful. Empty praise is worthless — the operator wants angles they could actually defend in a reply thread.

You are given the FULL text of the post plus context about its author. Some context may contain internal sales-scoring jargon (numeric scores out of 100, rule names, "ICP fit", etc.). NEVER repeat any of that — it is internal-only. Treat the input purely as a description of what the post is ABOUT and who the author is.

Read the post closely. Ground every angle in the SPECIFIC substance of THIS post — its claim, example, number, or framing — not in generic LinkedIn engagement tactics. If you could paste an angle under any post, it is too generic and is WRONG.

Return STRICT JSON ONLY (no markdown, no prose, no code fences) with this exact shape:
{
  "summary": "<1 sentence, max ~30 words, what the post is actually about>",
  "bullets": ["<short phrase>", "<short phrase>", "<short phrase>"],
  "angles": [
    { "id": "a1", "label": "<3-5 word angle name>", "hint": "<1 sentence: the actual take to make, referencing something specific from the post>" },
    { "id": "a2", "label": "...", "hint": "..." },
    { "id": "a3", "label": "...", "hint": "..." }
  ]
}

Rules for the 3 angles:
- EXACTLY 3, and genuinely DISTINCT — three different lenses on the post, never three rewordings of the same point.
- Every angle must be one of the operator's FOUR MOVES described above (transpose / principle-or-prediction / first-hand / leading question). Pick the three that THIS post actually supports.
- Prefer a TRANSPOSE angle first whenever the post's mechanic plausibly shows up in outbound, GTM tooling, sales data, agency delivery, or running a company. That is his most common and most valuable move.
- At most ONE of the three may be a question angle.
- Each "hint" must name something concrete FROM THE POST so the operator knows exactly what to say.
- Each "hint" is read on a small CHIP in the UI: ONE sentence, at most 25 words (~150 characters). No semicolon-chained clauses, no stacked parentheticals.
- BANNED (never produce these): "great post", "I agree", "well said", "thanks for sharing", "spot on", "love this", and any angle whose whole substance is praise or agreement.
- bullets: 2-4 short phrases capturing what the post specifically covers. No scores, no rule names.
- Output ONLY the JSON object.`;

// When regenerating, the operator already saw (and rejected) a set of angles.
// Tell the model to produce 3 NEW angles that don't overlap those.
function buildAvoidBlock(avoidAngles) {
  if (!Array.isArray(avoidAngles) || !avoidAngles.length) return "";
  const lines = [];
  for (const a of avoidAngles) {
    const label = String(a?.label || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const hint = String(a?.hint || "").replace(/\s+/g, " ").trim().slice(0, 160);
    if (!label && !hint) continue;
    lines.push(label && hint ? `- ${label}: ${hint}` : `- ${label || hint}`);
    if (lines.length >= 6) break;
  }
  if (!lines.length) return "";
  return `ALREADY SHOWN — the operator saw these angles and wants DIFFERENT ones. Produce 3 genuinely NEW angles that take different lenses from every angle below (no rewordings):\n${lines.join("\n")}`;
}

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

  const { lead_name, company, lead_title, signal, url, feedback, avoidAngles } = body || {};
  const postText = typeof signal === "string" ? signal.slice(0, POST_TEXT_CAP) : "";
  if (!postText && !lead_name) {
    return Response.json({ ok: false, error: "post context required" }, { status: 400 });
  }

  const feedbackBlock = buildFeedbackBlock(feedback);
  const avoidBlock = buildAvoidBlock(avoidAngles);
  // Regenerate path (operator rejected the first set): run hotter so the new
  // angles genuinely diverge instead of paraphrasing.
  const temperature = avoidBlock ? 1.0 : 0.7;

  const contextBlock = [
    lead_name ? `Author: ${lead_name}` : null,
    lead_title ? `Author title: ${lead_title}` : null,
    company ? `Author company: ${company}` : null,
    url ? `Post URL: ${url}` : null,
    "",
    "Full post content / context:",
    postText || "(no post text available — infer from author context only)",
    avoidBlock ? `\n${avoidBlock}` : null,
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
        model: COMMENT_MODEL,
        max_tokens: 900,
        temperature,
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
