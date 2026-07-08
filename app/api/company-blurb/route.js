// ═══════════════════════════════════════════════════════════════════
// POST /api/company-blurb
// Body: { company, website? }
//
// Returns a ONE-LINE description of what the company does, for the hover
// tooltip on the connection-requests-sent card's company name. There is no
// company-description field in the data (Leads has employee count but no
// "what they do"), so this is model-derived from the company name + website.
// The operator can click the company name (links to the real site) to verify.
//
// Cheap path: Haiku 4.5. The frontend caches the result per company for the
// session, so this fires at most once per company shown. Best-effort — on any
// failure the card just shows employee count without the blurb.
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 20;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BLURB_MODEL = process.env.SUMMARY_MODEL || "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You describe what a B2B company does in ONE short line for a sales rep's hover tooltip.

Given a company name (and often its website domain), output a single factual clause of 6-14 words saying what the company does / who it serves — e.g. "AI-powered underwriting platform for commercial insurers" or "logistics visibility software for e-commerce brands".

Rules:
- ONE line, no trailing period, max ~14 words. No marketing fluff ("leading", "innovative", "world-class").
- Say what they DO and ideally who for. If the domain makes the category obvious, use it.
- If you are NOT reasonably confident what the company does, output exactly: UNKNOWN
- Output ONLY the line (or UNKNOWN). No preamble, labels, or quotes.`;

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

  const company = (body?.company || "").toString().trim();
  const website = (body?.website || "").toString().trim();
  if (!company) {
    return Response.json({ ok: false, error: "company required" }, { status: 400 });
  }

  const userMsg = [
    `Company: ${company}`,
    website ? `Website: ${website}` : null,
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
        model: BLURB_MODEL,
        max_tokens: 60,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMsg }],
      }),
    });

    if (!r.ok) {
      const errTxt = await r.text();
      console.error("[COMPANY-BLURB] Anthropic error:", r.status, errTxt.slice(0, 200));
      return Response.json({ ok: false, error: "Blurb generation failed", status: r.status }, { status: 500 });
    }

    const data = await r.json();
    let blurb = (data?.content?.[0]?.text || "").trim().replace(/^["']|["']$/g, "").replace(/\.$/, "");
    // Model signals low confidence → no blurb (never show a guess as fact).
    if (!blurb || /^unknown$/i.test(blurb)) {
      return Response.json({ ok: true, blurb: "" });
    }
    return Response.json({ ok: true, blurb });
  } catch (e) {
    console.error("[COMPANY-BLURB] Exception:", e.message);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
