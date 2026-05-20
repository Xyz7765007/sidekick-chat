// ═══════════════════════════════════════════════════════════════════
// POST /api/summarize
// Body: { id, lead_name, lead_title, company, score, signal, reasons }
//
// Returns a short SDR-focused summary (1-2 sentences) of the lead's
// signal. The chatbot calls this on first card display and caches the
// result by card id so subsequent renders / polls don't re-spend.
//
// Cheap path: Haiku 4.5. ~$0.001 / call. Even a noisy feed costs
// pennies a day. If cost becomes an issue, cache server-side on the
// Task/Lead record in Airtable.
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 20;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Use Haiku 4.5 explicitly — summaries are short and high-volume, so
// Sonnet is overkill. (chat/route.js uses Sonnet for intent classification
// which is a different cost/latency tradeoff.)
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You are an analyst helping a B2B SDR (Sales Development Rep) decide who to contact and why.

Given a lead's signal data, produce a SHORT summary (1-2 sentences, max ~40 words) that captures everything an SDR needs to:
1. Decide if this lead is worth contacting right now
2. Know what to say in the first message

Keep it dense and concrete. Lead with the "why now" trigger if there is one (job movement, recent post, site visit, etc.) then the qualifying fact. No fluff, no "this lead is interesting" — get straight to what matters.

Output ONLY the summary text. No preamble, no labels, no bullet points, no quotes.

Examples of good summaries:
- "Sr. VP Sales at Infomedia18 — 80/100 ICP fit. High revenue potential + enterprise sales motion (31+ reps) + mature marketing org. Worth a call."
- "CTO at Adopt AI posted 2x in last 24h on AI system design and agent identity (avg 83/100). Engage by commenting on failure modes / audit trails — clear thought leadership signal."
- "Promoted to VP Marketing at Acme 3 days ago. New role buying season. 76/100 base fit. Lead with congrats + concrete observation about their team's GTM."`;

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

  const { lead_name, lead_title, company, score, signal, reasons, task_type, movement_type } = body || {};
  if (!signal && (!reasons || reasons.length === 0)) {
    return Response.json({ ok: false, error: "signal or reasons required" }, { status: 400 });
  }

  // Build the context block. The signal text already has structured
  // markers from server-side (📊 score, 📋 rules, 📝 post details, etc.).
  // Pass it through verbatim; the prompt extracts what an SDR needs.
  const reasonsText = Array.isArray(reasons) ? reasons.join("\n\n") : "";
  const contextBlock = [
    lead_name ? `Lead: ${lead_name}` : null,
    lead_title ? `Title: ${lead_title}` : null,
    company ? `Company: ${company}` : null,
    typeof score === "number" ? `Composite score: ${score}/100` : null,
    movement_type ? `Movement: ${movement_type}` : null,
    task_type ? `Signal type: ${task_type}` : null,
    "",
    "Signal data:",
    signal || reasonsText,
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
        max_tokens: 200,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: contextBlock }],
      }),
    });

    if (!r.ok) {
      const errTxt = await r.text();
      console.error("[SUMMARIZE] Anthropic error:", r.status, errTxt.slice(0, 200));
      return Response.json({ ok: false, error: "Summary generation failed", status: r.status }, { status: 500 });
    }

    const data = await r.json();
    const summary = (data?.content?.[0]?.text || "").trim();
    if (!summary) {
      return Response.json({ ok: false, error: "Empty summary returned" }, { status: 500 });
    }

    return Response.json({ ok: true, summary });
  } catch (e) {
    console.error("[SUMMARIZE] Exception:", e.message);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
