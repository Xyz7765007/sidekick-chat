# Side Kick Chat

The Side Kick chatbot — a Voxelised-aesthetic task feed UI that consumes the `/api/sidekick/*` endpoints on SignalScope.

## What it does

- Polls SignalScope every 30s for pending tasks (Veloka campaign)
- Renders each task as a card with score badge, signal, and CTAs
- Clicking "Mark Done" or "Skip" stamps the task in Airtable (via SignalScope) so it disappears from the feed
- Open: no user login on the chatbot UI. The chatbot→SignalScope call is auth'd with a Bearer token.

## Deploy

1. Push this repo to a new GitHub repo (e.g. `side-kick-chat`)
2. Create a new Vercel project pointing to that repo
3. Add 3 env vars in Vercel → Settings → Environment Variables:
   - `SIGNALSCOPE_API_URL` = `https://news-material-two.vercel.app`
   - `SIDEKICK_API_KEY` = `sidekick1237765` (must match SignalScope's)
   - `VELOKA_BASE_ID` = `appPcAzAyMmtNNEmT`
4. Deploy

The default `*.vercel.app` URL is fine — no custom domain needed for v1.

## Architecture

```
Browser
   ↓
chatbot's /api/feed   (chatbot's own Next.js server route)
   ↓
SignalScope /api/sidekick/feed  (Bearer auth)
   ↓
Airtable
```

The browser never sees `SIDEKICK_API_KEY` — it's read server-side only by the chatbot's proxy routes.
