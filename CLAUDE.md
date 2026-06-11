# CLAUDE.md — Side Kick Chat

This file is read by Claude Code when working in this repo. It is authoritative — if anything here contradicts the actual code, the code is right and this file is stale (fix this file).

## 0. Design principle: LESS IS MORE (Samarth, 2026-06-12)

The standing rule for ALL UX/UI work in this app. One thing in focus, clear
direction, no competing surfaces (the Biscuit-style one-at-a-time queue is
the embodiment — see `.learnings/2026-06-11-biscuit-redesign.md`).

In practice, before adding ANY new UI element ask:
- Can an existing affordance carry this instead of a new button/section?
- Can it live behind an existing surface (chat panel, Handled panel, queue
  step) instead of adding a parallel one to the main column?
- Does it compete with the focused card for attention? If yes, it's wrong.
- Default to removing/hiding over adding. Quiet > loud, fewer > more.

When Samarth asks for a feature, the first design pass should be the
SMALLEST visible footprint that does the job — then offer the richer
version only if the minimal one falls short.

---

## 1. What this is

A web chatbot UI for Side Kick. It is the **operator-facing companion** to SignalScope — Veloka's growth team uses it daily to review pending tasks (signal-driven outreach opportunities), approve AI-drafted LinkedIn outreach, mark tasks done/skipped, and chat with an AI assistant about specific leads.

The chatbot does NOT own any data. It is a thin client over SignalScope's `/api/sidekick/*` endpoints, plus a handful of its own AI orchestration routes.

Hardcoded to **Veloka** as the only campaign at this time. Refactoring needed if extending to other clients.

Live at `https://sidekick-chat-beige.vercel.app/`.

## 2. Tech stack (verified from `package.json`)

| Layer | Choice |
|---|---|
| Framework | **Next.js 14.2.15** (App Router) — same as SignalScope |
| Language | **JavaScript** — no TypeScript |
| UI | **React 18.3.1** + raw CSS in `app/globals.css` (29K) — **no Tailwind**, no UI library |
| AI SDK | None as a package — Anthropic API called via `fetch` |
| Data | **None local** — every data read/write proxies to SignalScope which talks to Airtable |
| Hosting | **Vercel** (Hobby plan + Fluid Compute → 300s function max) |
| Fonts | Inter + JetBrains Mono via Google Fonts (in `layout.jsx`) |

`package.json` dependencies are deliberately minimal:
```json
{
  "next": "14.2.15",
  "react": "^18.3.1",
  "react-dom": "^18.3.1"
}
```

Three. That's it. No state library, no fetcher library, no UI kit. The chatbot is intentionally bare so updates to SignalScope's API are the only place changes propagate.

## 3. Repo layout

```
side-kick-chat/
├── app/
│   ├── api/                            # 16 route handlers (see §6)
│   ├── layout.jsx                      # Root layout + Google Fonts
│   ├── page.jsx                        # Mounts <SideKick /> (3 lines)
│   └── globals.css                     # 29K of raw CSS — the whole design system
├── components/
│   └── SideKick.jsx                    # 1557 lines — the whole chatbot SPA
├── .github/workflows/
│   └── slack-daily-briefing.yml        # GitHub Actions cron (10am IST Mon-Fri)
├── README.md
├── next.config.js                      # 3 lines
└── package.json
```

`README.md` here is short and roughly accurate (3 env vars listed; some are out of date — see §10 for the current list).

## 4. The two roles this app plays

### Role A — Proxy to SignalScope

10 of 16 routes are pure proxies: they receive a browser request, attach the `SIDEKICK_API_KEY` Bearer header server-side, and forward to SignalScope. The browser never sees the API key.

This proxy pattern is the **only acceptable way** for the browser to talk to SignalScope. If new SignalScope endpoints get added, mirror them as proxy routes here.

### Role B — Own AI orchestration

6 routes do real work locally:

- `app/api/chat/route.js` — chat orchestrator. Receives user message + history → calls Anthropic → handles tool calls back to SignalScope → returns reply.
- `app/api/summarize/route.js` — 1-2 sentence SDR-focused summary of a lead for the card UI.
- `app/api/slack-daily-briefing/route.js` — Static Slack reminder posted by the GH Actions cron.
- `app/api/auto-batch/generate/route.js` — Proxy *with* `maxDuration: 300` because the underlying SignalScope call is slow (AI-personalized 4-message generation for 5 leads).
- `app/api/scan/route.js` — Proxy *with* `maxDuration: 300` for the same reason.
- `app/api/enrich-phone/route.js` — Proxy with `maxDuration: 30` (Apollo phone enrichment).

## 5. UI overview (from `components/SideKick.jsx`, 1557 lines)

Single-page app with these surfaces, all rendered by `SideKick.jsx`:

- **Card stack** — pending tasks polled every 30s from `/api/feed`. Each card: lead name, company, score badge, signal, CTAs (Mark Done / Skip / Chat About)
- **Chat panel** — chat with Claude about a specific lead or general Veloka questions. Tool calls under the hood let Claude pull live data from SignalScope.
- **Auto-batch view** — list of AI-drafted outreach pending operator approval (connection note + DM 1/2/3 per lead)
- **Movement scan tile** — start/stop/status the background movement scan via SignalScope
- **Top leads to call** — cold-call queue sorted by SignalScope's composite score

No router, no separate pages. All state in React. The full UI is one viewport.

## 6. API routes (all 16)

### Pure proxies to SignalScope (`SIGNALSCOPE_URL` + Bearer `SIDEKICK_API_KEY`)
- `POST /api/action` → `/api/sidekick/action` (mark task done/skip)
- `GET  /api/chat-history` → `/api/sidekick/chat-history`
- `GET  /api/count` → `/api/sidekick/count` (badge count)
- `GET  /api/feed` → `/api/sidekick/feed` (pending tasks for card stack)
- `POST /api/message-action` → `/api/sidekick/message-action`
- `GET  /api/messages-feed` → `/api/sidekick/messages-feed`
- `GET  /api/movement-scan-status` → `/api/sidekick/movement-scan-status` (start/stop/status via query param)
- `POST /api/top-leads-to-call` → `/api/sidekick/top-leads-to-call`
- `POST /api/auto-batch/action` → `/api/sidekick/auto-batch/action`
- `GET  /api/auto-batch/pending` → `/api/sidekick/auto-batch/pending`

### Proxies with extended timeout
- `POST /api/auto-batch/generate` → `/api/sidekick/auto-batch/generate` — `maxDuration: 300`
- `POST /api/scan` → `/api/sidekick/scan` — `maxDuration: 300`
- `POST /api/enrich-phone` → `/api/sidekick/enrich-phone` — `maxDuration: 30`

### Own work (not proxies)
- `POST /api/chat` — Chat orchestrator. Calls Anthropic API. Has its own tool-calling loop. **The only complex route in this repo.**
- `POST /api/summarize` — Lead summary. Calls Anthropic with `SUMMARY_MODEL` (default `claude-haiku-4-5-20251001`).
- `GET|POST /api/slack-daily-briefing` — Static Slack reminder. Posts to `SLACK_BRIEFING_WEBHOOK_URL`. Auth: `Authorization: Bearer <BRIEFING_CRON_SECRET>`.

## 7. AI models used in this repo

Two Anthropic models, both configurable via env:

- **`CLAUDE_MODEL`** — Chat orchestrator. Default `claude-sonnet-4-6`. (NOTE: header comment in `chat/route.js` line 14 says "haiku-4-5 (fast + cheap, plenty smart for intent + chat)" — comment is **stale**. Actual default is `claude-sonnet-4-6` per line 27. Either the comment is wrong or the override is set in env. Verify Vercel env vars before assuming.)
- **`SUMMARY_MODEL`** — Lead summary. Default `claude-haiku-4-5-20251001`.
- **`COMMENT_MODEL`** — Comment-angles + generate-comment. Default `claude-sonnet-4-6`. Haiku produced generic, indistinct angles (Kunal Jun9 #9); Sonnet grounds them in the post's substance. summarize stays on Haiku.

The chatbot does NOT use OpenAI directly. All OpenAI work (auto-batch message generation, scoring, etc.) happens on SignalScope's side and reaches the chatbot via the proxy routes.

## 8. Environment variables (full list, verified)

```
ANTHROPIC_API_KEY              # Required — both chat orchestrator + summarize
BRIEFING_CRON_SECRET           # Auth for the GH Actions daily Slack briefing cron
CHATBOT_URL                    # Public URL of this chatbot (used in Slack reminder's CTA button)
CLAUDE_MODEL                   # Optional, default claude-sonnet-4-6 (per code; comment says haiku)
COMMENT_MODEL                  # Optional, default claude-sonnet-4-6 — comment-angles + generate-comment (reasoning quality; Haiku gave generic angles)
SIDEKICK_API_KEY               # Bearer token sent to SignalScope — MUST match SignalScope's env var
SIGNALSCOPE_API_URL            # Base URL for SignalScope (e.g. https://news-material-two.vercel.app)
SLACK_BRIEFING_WEBHOOK_URL     # Slack incoming webhook for #veloka-daily-test
SUMMARY_MODEL                  # Optional, default claude-haiku-4-5-20251001
VELOKA_ACCOUNT_ID              # Hardcoded campaign reference (single Account ID)
VELOKA_BASE_ID                 # Hardcoded Airtable base ID (appPcAzAyMmtNNEmT) — used in 15 places
```

**The README still references only 3 env vars** (`SIGNALSCOPE_API_URL`, `SIDEKICK_API_KEY`, `VELOKA_BASE_ID`). The actual list is 10. Either the README is stale or Vercel got the rest added without README update. Verify in Vercel project settings.

## 9. Veloka coupling (this matters)

This chatbot is **hardcoded to Veloka** in three ways:

1. **`VELOKA_BASE_ID` is referenced 15 times** across the route handlers. It's passed as the `baseId` parameter to SignalScope's per-campaign endpoints.
2. **`VELOKA_ACCOUNT_ID` is referenced 1 time** — for the LinkedIn account ID used in outreach.
3. **The Slack briefing route says `Veloka daily reminder`** in the post body (line 58 of `slack-daily-briefing/route.js`).

If extending to other clients (Material, Volopay, etc.), the campaign needs to become a runtime parameter — either via path (e.g. `/[campaign]/api/feed`) or via header. Until then, this app is Veloka-only.

## 10. The chat orchestrator (`/api/chat`)

This is the single non-trivial route. What it does:

1. Receives `{ messages: [...], leadId?: "..." }` from the UI
2. Builds a system prompt that includes Veloka campaign context and (if `leadId` is provided) the lead's brief
3. Calls Anthropic with the conversation + a set of **tool definitions** for actions the AI can take (e.g. `fetch_lead_details`, `mark_task_done`, `enqueue_outreach`)
4. If the model responds with `tool_use` blocks, the orchestrator proxies those to SignalScope, returns the results, and loops
5. When the model returns plain text, the orchestrator returns it to the UI

The tool definitions live in this route. If you're adding new actions the AI can take, this is the file.

Critical detail: the orchestrator does NOT pass the lead's full Airtable record to Claude directly. It passes a **summarized brief** so token usage stays bounded.

## 11. Slack daily briefing

Static-content endpoint at `/api/slack-daily-briefing` that posts to `#veloka-daily-test` (configurable via `SLACK_BRIEFING_WEBHOOK_URL`). The Slack message contains a single CTA button linking to `CHATBOT_URL`.

The cron is **not run by Vercel** — it's a GitHub Actions workflow in `.github/workflows/slack-daily-briefing.yml`:
- Schedule: `30 4 * * 1-5` (04:30 UTC = 10:00 IST, Mon-Fri)
- Trigger: HTTP POST to `BRIEFING_ENDPOINT` (= `{CHATBOT_URL}/api/slack-daily-briefing`) with `Authorization: Bearer <BRIEFING_CRON_SECRET>`
- Also has `workflow_dispatch` enabled (manual trigger via Actions tab UI)

Why GH Actions instead of Vercel cron: documented in the workflow file's header comment — Vercel cron has reliability quirks on short intervals, and the rest of the Side Kick OS (movement scan tick, outreach cron) uses GH Actions, so keeping the same scheduling layer means one tool to monitor.

**Known timing quirk:** GitHub Actions cron is subject to platform-wide queue lag at the top of each hour. The 04:30 UTC slot is right at peak load; the actual fire time can be 5-30min after scheduled (sometimes more). Daily intervals are reliable enough; do not rely on this layer for sub-hour timing.

## 12. Where we are right now (state, end of May 29 2026)

**Live in production at `https://sidekick-chat-beige.vercel.app/`:**

- All proxy routes wired to SignalScope's stable URL (`https://news-material-two.vercel.app`)
- Chat orchestrator working with `claude-sonnet-4-6` + tool calling
- Lead summary working with `claude-haiku-4-5-20251001`
- Slack daily briefing wired and running (10am IST Mon-Fri)
- Auto-batch view rendering pending-approval items + handling approve/reject/edit
- Movement scan tile showing live status from SignalScope

**Pending / known issues:**

- **Veloka coupling.** 15 references to `VELOKA_BASE_ID`. To extend to other clients, parameterize the campaign at the route level.
- **Stale README.** Lists 3 env vars; actual count is 10. Update.
- **Stale comment in `chat/route.js` line 14.** Says default model is "haiku-4-5"; actual code default is `claude-sonnet-4-6`. Either correct the comment or override the env var.
- **No completion tracking semantics differentiation.** Currently `Mark Done` and `Skip` both stamp `Handled At` — the underlying SignalScope action endpoint doesn't yet distinguish completion type. If we want analytics on "skipped because bad fit" vs "done", add a `Completion Status` + `Completion Note` extension to the action contract.
- **No login on the chatbot UI** — anyone with the URL can use it. Acceptable for v1 (chatbot URL is private), but if Sales team or external clients ever need access, add an auth layer.

## 13. Coding rules (surgical precision required)

### File patterns
- **`components/SideKick.jsx` is 1557 lines.** Use `grep -n` to find sections. State machine + render in one file.
- **Every API route starts with `export const dynamic = "force-dynamic"; export const fetchCache = "force-no-store";`** — required to disable Vercel's default caching. Without this, the feed shows stale data.
- **Routes with AI calls or scans use `export const maxDuration = ...;`** to bypass Vercel's default 10s function timeout. Verify the duration matches the worst-case wall time.

### Proxy pattern (10 of 16 routes follow this)
```js
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const SIGNALSCOPE_URL = process.env.SIGNALSCOPE_API_URL;
const SIDEKICK_KEY = process.env.SIDEKICK_API_KEY;

export async function GET(request) {  // or POST
  if (!SIGNALSCOPE_URL || !SIDEKICK_KEY) {
    return Response.json({ error: "missing env" }, { status: 500 });
  }
  const url = new URL(request.url);
  // forward to SignalScope with Bearer auth
  const r = await fetch(`${SIGNALSCOPE_URL}/api/sidekick/...?...`, {
    method: "GET",
    headers: { Authorization: `Bearer ${SIDEKICK_KEY}` },
    cache: "no-store",
  });
  const data = await r.json();
  return Response.json(data, { status: r.status });
}
```

When adding a new proxy route, copy this pattern exactly. Do NOT add validation, retry logic, or response transformation in the proxy — that work belongs in SignalScope.

### Browser security
- **`SIDEKICK_API_KEY` is read server-side ONLY.** Never expose it to the browser. If you find yourself wanting to pass it as a header from the client, add a proxy route instead.
- **The browser only ever calls `/api/*` on this chatbot's own origin.** It does NOT call SignalScope directly. This is enforced by simply not having any client-side fetch calls that hit SignalScope's URL.

### Anthropic patterns (chat orchestrator + summarize)
- **Use the Messages API via fetch** (no SDK). `https://api.anthropic.com/v1/messages` with `x-api-key` header + `anthropic-version: 2023-06-01`.
- **Default to `claude-haiku-4-5-20251001` for cheap/fast tasks** (summarize). Use `claude-sonnet-4-6` only when reasoning quality matters (chat orchestrator). The cost difference at this scale matters because chat is high-volume.
- **Tool-calling loop in chat orchestrator** — when the model returns `stop_reason: "tool_use"`, run the tool call, append `tool_result` to messages, call again. Cap the loop at ~5 iterations to prevent runaway costs.

### Veloka-specific assumptions
- **`VELOKA_BASE_ID` is non-optional.** All SignalScope calls require it. If extending to other clients, either parameterize via path or add a campaign-selector UI.
- **The Slack briefing references "Veloka" explicitly.** If multi-client, this becomes per-campaign config.

### Auth patterns
- **GH Actions cron uses `BRIEFING_CRON_SECRET`** via `Authorization: Bearer ...` header. The endpoint accepts both GET and POST so manual curl and GH Actions both work.
- **Chatbot UI has no login.** Treat the Vercel URL itself as the access control.

## 14. Dev workflow

```bash
# Unzip the latest zip
cd /home/claude
unzip /mnt/user-data/outputs/side-kick-chat.zip -d side-kick-chat
cd side-kick-chat

# Install once
npm install

# Verify build before shipping
npx next build

# Rezip excluding bulky dirs
cd /home/claude
rm -f /mnt/user-data/outputs/side-kick-chat.zip
cd side-kick-chat
zip -rq /mnt/user-data/outputs/side-kick-chat.zip . \
  -x "node_modules/*" ".next/*" ".git/*" "package-lock.json"
```

Deploy: zip → upload to GitHub → Vercel auto-deploys on push to main.

## 15. How this app relates to SignalScope

```
                ┌─────────────────────────┐
                │   Browser (operator)    │
                └────────────┬────────────┘
                             │  (cookies, no API key)
                             ▼
              ┌─────────────────────────────┐
              │   side-kick-chat (Vercel)   │
              │   - 10 proxy routes         │
              │   - chat orchestrator       │
              │   - summarize               │
              │   - slack daily briefing    │
              └────────────┬────────────────┘
                           │ Bearer SIDEKICK_API_KEY
                           ▼
              ┌─────────────────────────────┐
              │   SignalScope (Vercel)      │
              │   /api/sidekick/*           │
              └────────────┬────────────────┘
                           │
                           ▼
                  ┌─────────────────┐
                  │    Airtable     │
                  └─────────────────┘
```

If you need new functionality:
- **New data shape from Airtable** → add the endpoint in SignalScope first, then add a proxy here
- **New AI behavior** → likely in this repo's `chat/route.js` (chat orchestrator) or `summarize/route.js`
- **New UI surface** → `components/SideKick.jsx`

The principle: **this repo owns presentation + AI orchestration. SignalScope owns data + business logic.**

## 16. Operator conventions

Same as SignalScope:
- Terse Hinglish in chat. Wants decisions and execution, not options.
- Slack messages: single asterisks for bold, no em dashes, plain English.
- "Think harder" means search past chats + ground in actual data, not argue from priors.

## 17. Quick orientation checklist

1. Read this file end to end
2. `npm install` if `node_modules/` isn't present
3. `npx next build` to confirm clean compile
4. For UI changes → `components/SideKick.jsx`. Find with `grep -n`.
5. For proxy route additions → copy the pattern in §13
6. For chat orchestrator changes → `app/api/chat/route.js`
7. For new SignalScope dependencies → add the endpoint on SignalScope's side first
8. After change → `npx next build` again before rezipping
