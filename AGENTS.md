# AGENTS.md — Side Kick Chat

This file defines the workflow rules for any agent (Claude Code, Codex, or similar) working in this repo. These rules are non-negotiable — they exist because each one prevents a class of bug that has actually happened in production.

Read this file at the start of every session. Read `CLAUDE.md` next.

---

## A. CORE WORKFLOW RULES (NON-NEGOTIABLE)

### A1. Always use the Kanban board to track tasks

- Every task — bug, feature, refactor, or investigation — gets a card on the Kanban board before any code is written.
- Move the card through columns: `Backlog → In Progress → Review → Deployed → Done`.
- If a task is too big for one card, break it into subcards before starting.
- Link the deployment zip to the card.
- If you discover unrelated bugs while working on a card, **create a new card** — do not silently fix them in the same change.

### A2. Ask for user approval before making code changes

- For any change that touches more than one file, OR touches `components/SideKick.jsx`, OR touches `app/api/chat/route.js` (the chat orchestrator): **present the plan first**, get explicit "yes, do it" before editing.
- Typo fixes, comment cleanups, single-line bug fixes in a single file: proceed without asking, but tell the user immediately after.
- Adding a new proxy route to mirror a new SignalScope endpoint: ALWAYS ask first. The proxy contract must be agreed before the route exists.
- "Approval" means an explicit affirmative. Silence is not approval.

### A3. Ask for approval before deploying

- Never push to GitHub or re-zip the deployment artifact without explicit deployment approval.
- Approval is given per-deployment, not per-session.
- Before asking for deployment approval, you must have run `npx next build` and confirmed clean compile.

### A4. Use browser tools for testing

- After any UI change in `SideKick.jsx`, open `https://sidekick-chat-beige.vercel.app/` and verify the change renders correctly.
- After any API route change, hit the endpoint via the browser dev tools or curl and verify the response shape matches what `SideKick.jsx` expects.
- For chat orchestrator changes, **test the actual conversation flow end-to-end** — send a message, verify tool calls fire, verify responses make sense.
- For Slack briefing changes, trigger via `workflow_dispatch` from GitHub Actions UI, verify the Slack post arrives correctly. Do NOT wait for the scheduled run to test.

### A5. Log important learnings in the `.learnings` folder

- Create `.learnings/` at the repo root if it doesn't exist.
- After every non-trivial bug fix, write a single markdown file: `.learnings/YYYY-MM-DD-short-slug.md`.
- Sections: **What broke** / **Root cause** / **Fix** / **Prevention**.
- Keep under 30 lines per file.
- Specifically log: any change you made to the proxy pattern, any new env var, any AI prompt change, any breakage caused by a SignalScope-side change you weren't expecting.

### A6. Maintain context using memory

- At the start of every session, read `CLAUDE.md` (authoritative context) and the 5 most recent files in `.learnings/`.
- When you discover a fact about the system that contradicts `CLAUDE.md`, update `CLAUDE.md` in the same change.
- Stay aware of what SignalScope is doing — this app is a thin client over it. When the operator mentions SignalScope changes, ask whether you need to update the proxy contract or the chat orchestrator's tool definitions.

---

## B. CODE CHANGE PROTOCOL

### B1. Before any change

1. State which file(s) you're about to edit and why.
2. If touching `components/SideKick.jsx`, name the section (search by header comment).
3. If touching `app/api/chat/route.js`, name the function or tool definition you're changing.
4. If adding a new proxy route, state which SignalScope endpoint it will mirror.

### B2. Read before you write

- `components/SideKick.jsx` is 1557 lines. Use `grep -n` to navigate.
- `app/api/chat/route.js` is the most complex route — read it in full before editing the tool-calling loop.
- Other routes are mostly identical proxies. Read one to understand the pattern before adding more.

### B3. Surgical edits only

- Use `str_replace` for targeted edits. Avoid bulk rewrites.
- One logical change per `str_replace`.
- When changing the shape of a `/api/*` response, grep for callers in `SideKick.jsx` and verify each one handles the new shape.

### B4. The 3-dependency rule

The `package.json` has exactly three dependencies: `next`, `react`, `react-dom`. **Do not add more.** The minimalism is the point — it forces the chatbot to stay a thin client.

If a task seems to require a new dependency:
1. Check whether the same outcome can be achieved with vanilla JS / native fetch / built-in browser APIs.
2. If genuinely impossible, escalate to the operator before adding the dependency.
3. Never add a state library, fetcher library, UI kit, or animation library without explicit approval.

### B5. Preserve patterns

- New API routes follow the existing pattern: `export const dynamic = "force-dynamic"; export const fetchCache = "force-no-store";` at the top. Vercel default caching will break the feed otherwise.
- Long-running routes need `export const maxDuration = N;` to bypass the 10s default.
- Proxy routes copy the canonical template (see `CLAUDE.md` §13) exactly. Don't add validation, retry logic, or response transformation in the proxy — that belongs in SignalScope.

---

## C. THE PROXY DISCIPLINE (CRITICAL)

This is the most important architectural rule in this repo.

### C1. The browser never talks to SignalScope directly

- Every SignalScope call is routed through a proxy route on this chatbot's own origin.
- The proxy attaches the `SIDEKICK_API_KEY` Bearer header server-side.
- The browser never sees the API key. Never.
- If you find yourself wanting to fetch SignalScope from client-side React code, **STOP** and add a proxy route instead.

### C2. The proxy adds nothing

- Proxies do not validate request bodies. SignalScope validates.
- Proxies do not transform responses. The browser gets what SignalScope returned.
- Proxies do not retry failed requests. SignalScope handles retries internally.
- Proxies do not log request bodies (may contain PII).
- The only thing a proxy adds: the auth header.

### C3. New SignalScope endpoints need new proxy routes

- When SignalScope adds a new `/api/sidekick/*` endpoint that the chatbot needs, mirror it as a proxy route here using the canonical template.
- File the SignalScope endpoint URL in the route file's header comment so future agents can find it.
- Don't reuse a generic proxy that forwards arbitrary paths. The 1:1 mapping is intentional.

### C4. Some routes do "own work" — don't make new ones

These 3 routes do real work locally (not proxies):
- `app/api/chat/route.js` — chat orchestrator
- `app/api/summarize/route.js` — lead summary
- `app/api/slack-daily-briefing/route.js` — Slack post

Adding a 4th "own work" route should be rare and approved. If a feature could live on SignalScope side, it usually should — the chatbot stays thin.

---

## D. TESTING PROTOCOL

### D1. Always build before declaring done

```bash
npx next build
```

A change is not done until this passes cleanly.

### D2. Manually verify end-to-end

- For card-stack changes: open the chatbot, scroll through the feed, perform Mark Done / Skip / Chat actions.
- For chat orchestrator changes: send a real message, verify the response, verify any tool calls fired correctly.
- For auto-batch changes: trigger a generation, review the output, approve/reject one item.
- For Slack briefing changes: hit `workflow_dispatch` from GitHub Actions UI and verify the Slack post.

### D3. Test against staging, not production

- If extending or testing, use a sandbox lead in the Veloka base, not a real prospect.
- Never trigger outreach (auto-batch approve, manual connection) on a real lead during testing.

### D4. Cross-verify with SignalScope

- After any proxy contract change, manually call the SignalScope endpoint and verify the response shape matches what your proxy expects.
- If the SignalScope endpoint changed, update the proxy + the calling code in `SideKick.jsx` in the same change.

---

## E. DEPLOYMENT PROTOCOL

### E1. Pre-deployment checklist

Before asking for deployment approval:

- [ ] `npx next build` passes cleanly
- [ ] You've manually tested the change in the browser
- [ ] You've verified no new dependencies snuck into `package.json`
- [ ] If you added a new env var, you've documented it in `CLAUDE.md` §8
- [ ] If you added a new route, you've documented it in `CLAUDE.md` §6
- [ ] Any SignalScope-side changes the chatbot depends on are already deployed
- [ ] A learning file is written if this was a bug fix

### E2. Zip and deliver

```bash
cd /home/claude
rm -f /mnt/user-data/outputs/side-kick-chat.zip
cd side-kick-chat
zip -rq /mnt/user-data/outputs/side-kick-chat.zip . \
  -x "node_modules/*" ".next/*" ".git/*" "package-lock.json"
```

Always exclude `node_modules`, `.next`, `.git`, `package-lock.json`. Present the zip to the operator after creation.

### E3. After deployment

- Verify the deployed version by opening `https://sidekick-chat-beige.vercel.app/` and exercising the changed code path.
- If anything looks wrong, request rollback ASAP.
- Update the Kanban card to "Deployed".

### E4. NEVER deploy without explicit approval

- Changes to the proxy pattern
- New dependencies in `package.json`
- Changes to the auth model (`SIDEKICK_API_KEY` handling, `BRIEFING_CRON_SECRET` handling)
- Changes to the GH Actions cron workflow
- Changes that touch the chat orchestrator's tool definitions

---

## F. VELOKA COUPLING AWARENESS

### F1. This chatbot is Veloka-only right now

- `VELOKA_BASE_ID` is referenced 15 times across route handlers.
- `VELOKA_ACCOUNT_ID` is referenced once.
- The Slack briefing says "Veloka daily reminder" in the post body.
- The Slack channel is `#veloka-daily-test`.

### F2. Don't add new Veloka hardcodes

- When adding a new route or feature, do NOT add new `VELOKA_*` env var references.
- If the feature needs a campaign ID, accept it as a request parameter and pass it through.
- If the feature genuinely needs Veloka-specific behavior, ask the operator first — this is the boundary at which the chatbot becomes multi-campaign.

### F3. If the operator wants to extend to other clients

- This is a refactor, not a quick add. The campaign needs to become a runtime parameter.
- Options: URL path (`/[campaign]/api/feed`), HTTP header, or query parameter.
- The Slack briefing becomes per-campaign config — different webhook URLs, different post bodies.
- This work is more than a session. Scope and plan it explicitly before starting.

---

## G. AI USAGE RULES

### G1. Two models, two purposes

- `CLAUDE_MODEL` (default `claude-sonnet-4-6`) — chat orchestrator. Reasoning quality matters.
- `SUMMARY_MODEL` (default `claude-haiku-4-5-20251001`) — lead summary. Cheap + fast.

Don't use sonnet for summaries (overspend). Don't use haiku for the chat orchestrator (reasoning lost).

### G2. Tool calling loop discipline

In `app/api/chat/route.js`, the model can call back into SignalScope via tools. Rules:

- **Cap the tool-use loop at 5 iterations.** Without a cap, a misbehaving model can rack up cost.
- **Each tool call must validate inputs** before forwarding to SignalScope. Don't blindly pass user-supplied IDs.
- **Tool results are passed back as `tool_result` messages.** Don't try to format them as plain text.
- **If the model returns text and tool calls in the same response**, handle both. Don't drop text.

### G3. Don't pass full Airtable records to Claude

- The chat orchestrator passes a **brief** (summarized fields) to Claude, not raw records.
- This bounds token usage and prevents PII bleed.
- If you need new fields exposed, extend the brief, don't widen the record.

### G4. No new AI providers without approval

- This repo uses Anthropic only.
- OpenAI lives on the SignalScope side.
- If a task seems to need OpenAI here, the work probably belongs in SignalScope. Escalate.

---

## H. SECURITY RULES

### H1. The browser must never see secrets

- `SIDEKICK_API_KEY`, `ANTHROPIC_API_KEY`, `BRIEFING_CRON_SECRET`, `SLACK_BRIEFING_WEBHOOK_URL` — all server-side only.
- Never put any of these in client-side JS. Never expose via a route response.
- If you're tempted to expose a "safe" env var to the client, ask first.

### H2. Auth on all sensitive routes

- The Slack daily briefing endpoint validates `BRIEFING_CRON_SECRET` via `Authorization: Bearer` header. Required.
- The chatbot UI has no login — the URL itself is the access control. If you need user-level auth, escalate.

### H3. Diagnostic logging discipline

- Log shapes, not values: `phone: <set/unset>`, not the actual phone.
- Never log API keys.
- Never log full message bodies from the chat orchestrator (may contain operator-typed PII).

---

## I. COMMUNICATION PROTOCOL WITH OPERATOR

### I1. Match the operator's communication style

- Terse Hinglish. Decisions and execution, not options.
- Slack messages: single asterisks for bold, no em dashes, plain English.

### I2. Be honest about uncertainty

- Say so when you're not sure.
- Don't fabricate test results.
- If you couldn't test something, say "I haven't verified this end-to-end" — operator will decide whether to ship.

### I3. Don't ask redundant questions

- Check `CLAUDE.md` and `.learnings/` first.
- Bundle related questions.
- Lead with your best guess so the operator can confirm in one word.

### I4. When SignalScope is the bottleneck

- If a task needs a SignalScope-side change first, say so explicitly.
- Don't try to work around a missing endpoint with client-side hacks.
- Block on SignalScope, deliver the chatbot side once unblocked.

---

## J. EMERGENCY PROCEDURES

### J1. Chatbot is broken

- Open Vercel logs. Look at the most recent function invocations.
- Verify SignalScope is up: open `https://news-material-two.vercel.app` and check.
- If SignalScope is down, the chatbot will fail every proxy call. Communicate this to the operator immediately — don't try to fix the chatbot.

### J2. Auth failures

- "401 Unauthorized" on every proxy route → `SIDEKICK_API_KEY` env var mismatch between chatbot and SignalScope.
- Both repos must have the same value. Operator manages the keys.

### J3. Slack briefing not firing

- Check GitHub Actions tab on this repo. If the workflow ran but failed, read the log.
- Common failure: `BRIEFING_ENDPOINT` or `BRIEFING_CRON_SECRET` secret not set in repo settings.
- Common timing quirk: scheduled run can be delayed 5-30min at 04:30 UTC (GitHub peak load). Don't troubleshoot until 04:45 UTC has passed.
- Manual trigger via `workflow_dispatch` always works if the secrets are set.

### J4. Chat orchestrator misbehaving

- Look at the actual tool calls fired (Vercel logs).
- If the model is hallucinating tool calls that don't exist, check the tool definitions in `chat/route.js`.
- If the model is looping (5+ tool calls in one request), the loop cap is broken. Verify it's still in place.

---

## K. PATTERN-SPECIFIC GOTCHAS

### K1. Stale comment in `chat/route.js`

Line 14 says the default model is "haiku-4-5". The actual code default (line 27) is `claude-sonnet-4-6`. Either the comment is wrong or the override is set in Vercel env. Verify in Vercel project settings before making model-related changes.

### K2. README env var count

`README.md` lists 3 env vars. The actual count is 10. Either the README is stale or production vars were added without README update. **When in doubt, treat `CLAUDE.md` §8 as authoritative.**

### K3. The cron URL is `CHATBOT_URL`, not Vercel-internal

The GitHub Actions cron POSTs to `BRIEFING_ENDPOINT` which is built from `CHATBOT_URL`. If you change the Vercel deployment URL, update both the env var and the GH Actions secret.

### K4. `Mark Done` and `Skip` both stamp `Handled At`

Currently no semantic differentiation between completion types. If the operator wants analytics (e.g. "skipped because bad fit" vs "done because actioned"), this needs:
- A `Completion Status` field in the SignalScope Tasks table
- A `Completion Note` field
- Extended action contract on both sides
- This is a known v2 task, not a current bug.

### K5. GitHub Actions cron timing variance

The Slack briefing is scheduled `30 4 * * 1-5` = 04:30 UTC. Actual fire time varies 5-30min after scheduled due to GitHub's queue. **Don't troubleshoot until 04:45 UTC has passed.** If still not fired by 05:00, escalate.

---

## L. WHAT TO DO AT THE END OF A SESSION

1. Update the Kanban board: move completed cards, leave clear notes on partial work.
2. Write any pending learning files in `.learnings/`.
3. Update `CLAUDE.md` if you discovered facts that need to be authoritative.
4. Verify the zip in `/mnt/user-data/outputs/` is the latest version.
5. Leave a one-paragraph session summary for the operator.

---

## M. WHAT NEVER TO DO

- Never deploy without explicit approval
- Never bypass the proxy pattern (browser must NEVER call SignalScope directly)
- Never expose env vars or API keys to client-side code
- Never add a 4th dependency to `package.json` without operator approval
- Never delete `.learnings/` files
- Never make changes that hardcode another campaign besides Veloka (until multi-campaign refactor is approved)
- Never log secrets or full PII-containing request bodies
- Never make changes that disable the auth on `/api/slack-daily-briefing`
- Never assume — verify with code
- Never silently fix a bug you noticed outside your task scope (create a card instead)
- Never push a change you haven't built (`npx next build`)
- Never modify the chat orchestrator's tool-loop cap without operator approval
