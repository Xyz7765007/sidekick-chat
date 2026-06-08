// ═══════════════════════════════════════════════════════════════════
// POST /api/generate-comment
// Body: { lead_name, company, lead_title, signal, url,
//         angle: { label, hint },
//         feedback?: [{ quoted_span, feedback_text }] }
//
// Generates ONE LinkedIn comment for the operator to post on a lead's
// post, written from the chosen angle. Output: { ok, comment }.
//
// FEEDBACK LOOP: `feedback` carries the operator's most-recent learned
// preferences for comments (from GET /api/preferences?item_type=comment).
// They're injected as a bounded "OPERATOR FEEDBACK" block so future
// comments reflect past corrections. (Replaces the old unused `persona`
// plumbing.) Style guidance only — the internal-vs-public rule below
// still binds, so prefs can never reintroduce scores / rule names.
//
// IMPORTANT (internal-vs-public split): the inbound `signal` MAY contain
// internal scoring markers (scores, rule names). The comment is PUBLIC —
// it gets pasted on LinkedIn. The prompt is told to treat the signal as a
// description of the post only and to NEVER surface scores / rule names /
// internal jargon. NO auto-post — this route only returns text.
//
// Bounded input (post text capped at 2000 chars). Haiku 4.5.
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || "claude-haiku-4-5-20251001";

const POST_TEXT_CAP = 2000;
const FEEDBACK_BLOCK_CHAR_CAP = 1500;

// Build a bounded "OPERATOR FEEDBACK" block from learned prefs. Capped at
// ~1500 chars so it can't balloon the prompt. Most-recent-first (prefs
// already arrive sorted that way). Style guidance only.
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
  return `OPERATOR FEEDBACK — apply these learned preferences (most recent first):\n${lines.join("\n")}`;
}

const SYSTEM_PROMPT = `You write a single LinkedIn comment for a B2B professional to post on someone else's post.

You are given the post's content/context, the author, a chosen ANGLE (the take to make), and optionally an OPERATOR FEEDBACK block of learned preferences from past comments.

Some input may contain internal sales-scoring jargon (numeric scores, rule names, "ICP fit"). NEVER repeat any of it — it is internal-only. Treat the input purely as a description of what the post is about.

Write a comment that:
- Makes a REAL point of view that fits the chosen angle — a sharpening, a concrete example, a respectful counter, or a question that extends the idea.
- Is NOT generic praise. Never "Great post", "Couldn't agree more", "Thanks for sharing", "Spot on".
- Does NOT just reword one sentence of the post back at the author.
- Is concise: 2-4 sentences, professional LinkedIn voice. No hashtags. No em dashes. At most one question.
- Sounds like a human peer, not a marketer pitching.
- If an OPERATOR FEEDBACK block is provided, FOLLOW those preferences — they are corrections from past comments. They are style guidance only; never let them reintroduce internal scoring or rule names.

Output ONLY the comment text. No preamble, no quotes, no labels.`;

// Output-side leak guard — mirrors news-material's detectInternalLeak.
// The OPERATOR FEEDBACK block is an untrusted free-text channel injected
// into a PUBLIC-facing comment, so back the prompt instruction with a regex
// backstop. If a draft trips this, we withhold it rather than post internal
// scoring to LinkedIn.
function detectInternalLeak(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase();
  const leaks = [
    /\b\d{1,3}\/100\b/, /\bicp fit\b/, /\bicp score\b/, /\bicp profile\b/,
    /\bqualification score\b/, /\bscore:\s*\d/, /\bdeterministic[:\s]/,
    /\blead-side rules\b/, /\bacv score\b/, /\btam (small|large|big)\b/,
    /\btop \d+ leads?\b/, /\brules matched\b/,
    /\b\d{1,3}-\d{1,3}\s+(sales|marketing) team\b/,
  ];
  return leaks.some((re) => re.test(t));
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

  const { lead_name, company, lead_title, signal, url, angle, feedback } = body || {};
  const postText = typeof signal === "string" ? signal.slice(0, POST_TEXT_CAP) : "";
  const angleLabel = angle?.label ? String(angle.label).slice(0, 80) : "";
  const angleHint = angle?.hint ? String(angle.hint).slice(0, 240) : "";
  if (!angleLabel && !angleHint) {
    return Response.json({ ok: false, error: "angle required" }, { status: 400 });
  }

  const feedbackBlock = buildFeedbackBlock(feedback);

  const contextBlock = [
    lead_name ? `Post author: ${lead_name}` : null,
    lead_title ? `Author title: ${lead_title}` : null,
    company ? `Author company: ${company}` : null,
    url ? `Post URL: ${url}` : null,
    "",
    "Post content / context:",
    postText || "(no post text available — infer from author context only)",
    "",
    `Chosen angle: ${angleLabel}`,
    angleHint ? `Angle direction: ${angleHint}` : null,
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
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: contextBlock }],
      }),
    });

    if (!r.ok) {
      const errTxt = await r.text();
      console.error("[GENERATE-COMMENT] Anthropic error:", r.status, errTxt.slice(0, 200));
      return Response.json({ ok: false, error: "Comment generation failed", status: r.status }, { status: 500 });
    }

    const data = await r.json();
    const comment = (data?.content?.[0]?.text || "").trim();
    if (!comment) {
      return Response.json({ ok: false, error: "Empty comment returned" }, { status: 500 });
    }

    // Withhold rather than surface internal scoring on a public comment.
    if (detectInternalLeak(comment)) {
      console.error("[GENERATE-COMMENT] internal-leak guard tripped; withholding draft");
      return Response.json({ ok: false, error: "Draft withheld (internal data detected) — hit regenerate" }, { status: 422 });
    }

    return Response.json({ ok: true, comment });
  } catch (e) {
    console.error("[GENERATE-COMMENT] Exception:", e.message);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
