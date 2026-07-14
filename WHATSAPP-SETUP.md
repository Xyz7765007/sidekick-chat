# WhatsApp channel — setup runbook

Side Kick tasks, delivered on WhatsApp. Test scope (Kunal, 14 Jul 2026):
a batch of **3 LinkedIn comment tasks** + the **Create a post** feature.

The code is deployed and inert. It stays inert until the env vars below are
set: both the signature check and the number allowlist fail closed.

---

## What ships

| Route | What it does |
|---|---|
| `GET  /api/whatsapp/webhook` | Meta's one-time subscription handshake |
| `POST /api/whatsapp/webhook` | Every inbound message. The whole conversation runs here. |
| `POST /api/whatsapp/push` | Fire a batch of 3 at a number (you, or a cron) |
| `POST /api/sidekick/wa-session` | *(SignalScope)* per-phone conversation state |

`lib/whatsapp.js` = Meta transport. `lib/wa-flow.js` = the conversation.
`lib/transcribe.js` = voice note → text. `lib/task-priority.js` = the shared
score+freshness ranking (same order the web queue uses).

No new npm dependencies. The 3-dependency rule holds.

---

## Step 1 — Create the Meta app (~10 min)

1. <https://developers.facebook.com/apps> → **Create App** → type **Business**.
2. In the app, add the **WhatsApp** product.
3. Meta hands you, free, on the **API Setup** page:
   - a **test phone number** (this is the number Kunal will message)
   - a **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`
   - a **temporary access token** (24h) → `WHATSAPP_TOKEN`
4. On the same page, **add recipient numbers**: Kunal's and yours. The test
   number can only message numbers registered here (max 5). Each gets a
   confirmation code on WhatsApp.
5. **App Settings → Basic → App Secret** → `WHATSAPP_APP_SECRET`.

> The 24h token is fine for the test. For anything lasting, create a **System
> User** in Business Settings and issue a permanent token with `whatsapp_business_messaging`.

## Step 2 — Set the env vars (Vercel → sidekick-chat → Settings → Environment Variables)

```
WHATSAPP_TOKEN             = EAAG...            # from API Setup
WHATSAPP_PHONE_NUMBER_ID   = 123456789012345    # the ID, not the number
WHATSAPP_APP_SECRET        = abc123...          # App Settings → Basic
WHATSAPP_VERIFY_TOKEN      = <invent any string, e.g. sidekick_wa_7765007>
WHATSAPP_ALLOWED_NUMBERS   = 91XXXXXXXXXX,91YYYYYYYYYY   # Kunal, you. No "+", comma-separated.
WHATSAPP_PUSH_SECRET       = <invent any string>         # auth for /api/whatsapp/push
OPENAI_API_KEY             = sk-...             # voice notes only (Whisper)
```

**Env vars only take effect on the NEXT deployment.** After adding them, redeploy:
`npx vercel --prod --yes` from the repo, or hit Redeploy in the Vercel dashboard.

## Step 3 — Point Meta at the webhook

Meta app → **WhatsApp → Configuration → Edit** callback URL:

- **Callback URL:** `https://sidekick-chat-beige.vercel.app/api/whatsapp/webhook`
- **Verify token:** the exact `WHATSAPP_VERIFY_TOKEN` string you invented
- Click **Verify and save** (Meta calls the GET route; it echoes the challenge back)
- Then **Manage** → subscribe to the **`messages`** field. This is the step everyone forgets — without it Meta accepts the webhook but never sends you anything.

## Step 4 — Test it

From Kunal's (or your) WhatsApp, message the test number:

| Send | You get |
|---|---|
| `hi` | The menu: **My tasks** / **Create a post** |
| `tasks` | "You've got 3 posts to comment on" → task 1 of 3 |
| — per task | the full post + author, then the drafted comment **on its own** (long-press → Copy), then **Open the post** link + **Mark as done** / **Skip** |
| type anything during a task | it's a steer — the comment gets redrafted that way (and the steer is saved to the same learned-prefs store the web app writes to) |
| `post` | 3 hooks (Trending / ICP / Competitor) → pick one → talk or type your notes → your post, drafted in your voice → keep talking to refine it |
| a **voice note**, any time | transcribed and used as if you'd typed it |

To push a batch instead of waiting for him to ask:

```bash
curl -X POST https://sidekick-chat-beige.vercel.app/api/whatsapp/push \
  -H "Authorization: Bearer $WHATSAPP_PUSH_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"to":"91XXXXXXXXXX"}'
```

---

## The one platform constraint to know before Kunal asks

WhatsApp only lets a business send **free-form** messages within **24 hours** of
the user's last message. Outside that window Meta requires a **pre-approved
template**.

So for this test: **Kunal has to message the number first** (that opens the
window). `/api/whatsapp/push` returns a clear `409 outside_24h_window` if you
fire it into a closed window, rather than failing silently.

For a real "your 3 tasks are ready" ping every morning, submit a **utility
template** (Meta → WhatsApp → Message Templates). Approval is usually hours.
That's the unlock for a daily cron, and it's the answer to "so will this ping me
every morning?" — *yes, once the template is approved*.

Also: the free **test number** reaches max **5** registered recipients. Going
properly live needs a real number + Business verification.

---

## This is an EXTENSION. Nothing in the app changes. (Samarth, 14 Jul)

The web app is not being migrated, replaced, or refactored. WhatsApp is a second
front-end bolted onto the existing brain — the app must behave **identically**
whether or not WhatsApp exists.

Verified at the commit level: every file in this feature is a NEW file.
`components/SideKick.jsx`, `app/globals.css`, `package.json`, and every existing
API route are **untouched**. On SignalScope, `wa-session` is a new route and a new
auto-created table; no existing table, field, or endpoint was altered.

**Consequence — a deliberate duplication, do NOT "tidy" it:**
`lib/task-priority.js` holds a COPY of the ranking functions (`postAgeDays` /
`freshnessBoost` / `taskPriority`) that also live inside `components/SideKick.jsx`.
Collapsing the component onto the shared module would be a clean refactor and it is
**explicitly not wanted** — it would mean editing the app to ship the extension.
The copy is the price of leaving the app alone, and it is the right price.

If the web ranking ever changes, mirror the change into `lib/task-priority.js` so
the two surfaces don't drift on what "next" means.

Everything else the extension needs, it already reuses read-only: the same
`/api/comment-angles`, `/api/generate-comment`, `/api/post-create`, `/api/post-chat`,
`/api/action`, `/api/feedback`, `/api/preferences`. It calls them; it doesn't change
them. The one new `item_type` it writes (`comment_steer`) is new precisely so it
can't alter what the app already reads.

## Known follow-ups

- **Daily push template** — see the 24h-window section above.
