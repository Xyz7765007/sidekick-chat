// ═══════════════════════════════════════════════════════════════════
// POST /api/post-create   (the "hooks engine" — create an ORIGINAL post)
//
// Kunal feedback (2026-06-30 standup): the post-creation card.
//   - "Give me three hooks ... with an option to regenerate."
//   - "Make this an AI agent only that is chatting and getting feedback
//      and reviewing my post ... giving me updated changes."
//   - Less is more; never auto-post (the operator copies + opens LinkedIn).
//
// One route, three modes (keeps the proxy surface minimal — AGENTS.md):
//   { mode: "hooks",    avoid?: [string], topic?: string }
//        → { ok, hooks: [{ id, tag, line }] }  (EXACTLY 3, tagged
//           Trending / ICP / Competitor — mirrors comment-angles' "exactly 3")
//   { mode: "generate", hook?: {tag,line}, notes?: string }
//        → { ok, post }   (the post written "in the operator's voice")
//   { mode: "refine",   post: string, feedback: string }
//        → { ok, post }   (revised draft — the agent-chat live-refine loop)
//
// Model: POST_CREATE_MODEL (default Sonnet — reasoning quality, same call as
// comment-angles where Haiku gave generic output). Public facts only; the
// drafted post must read like the operator wrote it, zero internal jargon.
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const POST_CREATE_MODEL =
  process.env.POST_CREATE_MODEL || process.env.POST_CHAT_MODEL || "claude-sonnet-4-6";

const NOTES_CAP = 4000;
const POST_CAP = 4000;
const FEEDBACK_CAP = 600;

// Who the operator is — shared GTM context so hooks/posts are grounded in
// the actual motion (mirrors post-chat's framing). The Side Kick edge: hooks
// seeded from real market lenses (a trending take, an ICP pain, a competitor
// move) rather than generic LinkedIn-guru openers.
const OPERATOR_CONTEXT = `WHO THE OPERATOR IS (their GTM context):
- They run outbound for Veloka, a B2B outbound-infrastructure motion: spot a real buying/engagement signal, then engage authentically (comment, connect, DM) to open a conversation. No spray-and-pray.
- Their ICP: companies with an established sales motion, a real marketing org, and meaningful deal size (high ACV).
- They post on LinkedIn to stay visible to that ICP and earn warm inbound — credible, specific, lived-in takes, never thought-leader fluff.`;

const HOOKS_SYSTEM = `You generate LinkedIn post HOOKS for the B2B operator described below. A hook is a single punchy opening line that makes their ICP stop scrolling and want to read on. It is a SEED, not a whole post.

${OPERATOR_CONTEXT}

Return STRICT JSON ONLY (no markdown, no code fences, no prose) with this exact shape:
{"hooks":[
  {"id":"h1","tag":"Trending","line":"<one-line hook riffing on a current trend / debate in their market>"},
  {"id":"h2","tag":"ICP","line":"<one-line hook naming a real pain or truth their ICP feels>"},
  {"id":"h3","tag":"Competitor","line":"<one-line hook reframing a common competitor / category move>"}
]}

Rules:
- EXACTLY 3 hooks, one of each tag, in that order. Tags are EXACTLY "Trending", "ICP", "Competitor".
- Each line is ONE sentence (max ~22 words), specific and opinionated — something the operator could actually defend. No emojis, no hashtags, no "Here's why" cliffhangers, no "Unpopular opinion:".
- Grounded in THEIR world (B2B outbound, sales, GTM, signal-led prospecting). If a topic is given below, anchor all three to it.
- Sound like a sharp practitioner wrote them, not a LinkedIn influencer. No em dashes.
- Output ONLY the JSON object.`;

const GENERATE_SYSTEM = `You write a LinkedIn post FOR the operator, in THEIR voice, from a hook and/or their rough notes.

${OPERATOR_CONTEXT}

VOICE: low-key, direct, lived-in. First person. Short sentences and short paragraphs (1-3 lines each). Concrete specifics over abstractions. It should read like a smart operator typed it between meetings, not like marketing copy and not like AI. No em dashes, no emojis unless the notes clearly want one, no hashtags, no "In conclusion", no "Let me explain", no rule-of-three padding.

INPUT: you are given an optional hook (the chosen opening direction) and optional notes (what they actually want to say — may be a rough voice transcript). Build the post around the hook's angle and the substance of the notes. If notes are thin, expand sensibly within their world but do NOT invent fake numbers, fake clients, or fake stories.

OUTPUT: return ONLY the post text — no preamble, no quotes around it, no commentary. ~80-200 words. End in a way that invites a reply (a real question or a sharp closing line), not a generic "thoughts?".`;

const REFINE_SYSTEM = `You revise a LinkedIn post for the operator based on their feedback. Keep their voice (low-key, direct, first person, short paragraphs, no em dashes, no hashtags, no emoji-spam). Apply the feedback faithfully — if they say "punchier" cut words, if "less salesy" strip pitch language, if "add a specific example" add a plausible concrete one without fabricating named clients or numbers.

${OPERATOR_CONTEXT}

Return ONLY the revised post text — no preamble, no quotes, no commentary about what you changed.`;

function extractJSON(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); }
  catch { return null; }
}

async function callAnthropic({ system, user, maxTokens, temperature }) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: POST_CREATE_MODEL,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) {
    const errTxt = await r.text();
    console.error("[POST-CREATE] Anthropic error:", r.status, errTxt.slice(0, 200));
    return { error: "generation failed", status: r.status };
  }
  const data = await r.json();
  return { text: (data?.content?.[0]?.text || "").trim() };
}

export async function POST(request) {
  if (!ANTHROPIC_API_KEY) {
    return Response.json({ ok: false, error: "Server missing ANTHROPIC_API_KEY" }, { status: 500 });
  }

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }

  const mode = String(body?.mode || "hooks");

  try {
    // ── MODE: hooks ── 3 fresh hooks (Trending / ICP / Competitor) ──
    if (mode === "hooks") {
      const topic = body?.topic ? String(body.topic).slice(0, 300).trim() : "";
      const avoid = Array.isArray(body?.avoid)
        ? body.avoid.map(h => String(h).replace(/\s+/g, " ").trim().slice(0, 160)).filter(Boolean).slice(0, 9)
        : [];
      const avoidBlock = avoid.length
        ? `\nALREADY SHOWN — the operator wants DIFFERENT hooks. Produce 3 genuinely new ones, not rewordings of these:\n${avoid.map(l => `- ${l}`).join("\n")}`
        : "";
      const user = `${topic ? `Topic to anchor all three hooks to: ${topic}\n` : "Generate 3 hooks across the operator's world (outbound, GTM, signal-led prospecting).\n"}${avoidBlock}`;
      // Regenerate runs hotter so the new set genuinely diverges.
      const out = await callAnthropic({ system: HOOKS_SYSTEM, user, maxTokens: 500, temperature: avoid.length ? 1.0 : 0.8 });
      if (out.error) return Response.json({ ok: false, error: out.error }, { status: 500 });
      const parsed = extractJSON(out.text);
      if (!parsed || !Array.isArray(parsed.hooks)) {
        console.error("[POST-CREATE] Unparseable hooks:", out.text.slice(0, 200));
        return Response.json({ ok: false, error: "Model returned malformed hooks" }, { status: 500 });
      }
      const TAGS = ["Trending", "ICP", "Competitor"];
      const hooks = parsed.hooks.slice(0, 3).map((h, i) => ({
        id: h?.id || `h${i + 1}`,
        tag: TAGS.includes(h?.tag) ? h.tag : TAGS[i] || "Hook",
        line: String(h?.line || "").replace(/\s+/g, " ").trim().slice(0, 200),
      })).filter(h => h.line);
      if (!hooks.length) {
        return Response.json({ ok: false, error: "No usable hooks returned" }, { status: 500 });
      }
      return Response.json({ ok: true, hooks });
    }

    // ── MODE: generate ── hook + notes → post in the operator's voice ──
    if (mode === "generate") {
      const hook = (body?.hook && typeof body.hook === "object") ? body.hook : null;
      const hookLine = hook ? String(hook.line || "").slice(0, 300).trim() : "";
      const notes = body?.notes ? String(body.notes).slice(0, NOTES_CAP).trim() : "";
      if (!hookLine && !notes) {
        return Response.json({ ok: false, error: "Need a hook or notes to write from" }, { status: 400 });
      }
      const user = [
        hookLine ? `Chosen hook (the opening direction):\n${hookLine}` : null,
        notes ? `\nThe operator's notes / rough thoughts (may be a voice transcript):\n${notes}` : "\n(No notes — expand the hook into a full post within the operator's world.)",
      ].filter(Boolean).join("\n");
      const out = await callAnthropic({ system: GENERATE_SYSTEM, user, maxTokens: 700, temperature: 0.8 });
      if (out.error) return Response.json({ ok: false, error: out.error }, { status: 500 });
      const post = out.text.replace(/^["']|["']$/g, "").trim();
      if (!post) return Response.json({ ok: false, error: "Empty post returned" }, { status: 500 });
      return Response.json({ ok: true, post: post.slice(0, 3000) });
    }

    // ── MODE: refine ── current draft + feedback → revised draft ──
    if (mode === "refine") {
      const post = body?.post ? String(body.post).slice(0, POST_CAP).trim() : "";
      const feedback = body?.feedback ? String(body.feedback).slice(0, FEEDBACK_CAP).trim() : "";
      if (!post) return Response.json({ ok: false, error: "post required to refine" }, { status: 400 });
      if (!feedback) return Response.json({ ok: false, error: "feedback required to refine" }, { status: 400 });
      const user = `Current post:\n"""\n${post}\n"""\n\nThe operator's feedback:\n${feedback}`;
      const out = await callAnthropic({ system: REFINE_SYSTEM, user, maxTokens: 700, temperature: 0.7 });
      if (out.error) return Response.json({ ok: false, error: out.error }, { status: 500 });
      const revised = out.text.replace(/^["']|["']$/g, "").trim();
      if (!revised) return Response.json({ ok: false, error: "Empty revision returned" }, { status: 500 });
      return Response.json({ ok: true, post: revised.slice(0, 3000) });
    }

    return Response.json({ ok: false, error: `Unknown mode: ${mode}` }, { status: 400 });
  } catch (e) {
    console.error("[POST-CREATE] Exception:", e.message);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
