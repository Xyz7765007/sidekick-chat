export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// ═══════════════════════════════════════════════════════════════════
// Chatbot proxy → SignalScope movement scan status.
//
// Multi-tenant: by default (no baseId param), asks SignalScope for the
// latest running scan across ALL configured bases. The response includes
// campaignName, so the banner shows which client the scan is for.
//
// If the chatbot ever needs to lock to one client (e.g. an operator
// focused on a specific account), pass ?baseId=X and it'll filter.
//
// Env vars:
//   SIGNALSCOPE_API_URL  — base URL of the SignalScope deployment
//   SIDEKICK_API_KEY     — bearer key shared with SignalScope
//
// The old VELOKA_BASE_ID env var is intentionally NOT read here anymore
// — its hardcoded single-base behavior is what caused the banner to
// stop showing when scans started running on bases other than Veloka.
// Adding new clients now requires zero chatbot config: just add a
// Campaign row in Airtable and run scans on its base.
// ═══════════════════════════════════════════════════════════════════

const SIGNALSCOPE_URL = process.env.SIGNALSCOPE_API_URL;
const SIDEKICK_KEY = process.env.SIDEKICK_API_KEY;

export async function GET(request) {
  if (!SIGNALSCOPE_URL || !SIDEKICK_KEY) {
    return Response.json(
      { ok: false, error: "SIGNALSCOPE_API_URL or SIDEKICK_API_KEY not set" },
      { status: 500 }
    );
  }

  // Pass through optional baseId. When absent, SignalScope returns the
  // latest running run across all bases — the multi-tenant default.
  const url = new URL(request.url);
  const baseId = url.searchParams.get("baseId");
  const upstreamQuery = baseId ? `?baseId=${encodeURIComponent(baseId)}` : "";

  try {
    const upstream = `${SIGNALSCOPE_URL.replace(/\/$/, "")}/api/sidekick/movement-scan-status${upstreamQuery}`;
    const r = await fetch(upstream, {
      headers: { Authorization: `Bearer ${SIDEKICK_KEY}` },
      cache: "no-store",
    });
    const data = await r.json();
    return Response.json(data, { status: r.status });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 502 });
  }
}
