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

Verified against Meta's current docs, 14 Jul 2026. Meta's flow is now **use-case
driven** — you do NOT pick an app "type" any more, and the WhatsApp settings do
NOT live under a "WhatsApp" sidebar item. Follow these labels exactly.

1. <https://developers.facebook.com/apps> → **Create app**.
2. **App name** + contact email.
3. **Use case** screen → pick **"Connect with customers through WhatsApp"**.
   (This is the screen that asks "what do you want your app to do". Don't pick
   "Other".) → **Next**.
4. **Business portfolio** → select one, or **create one on the spot**. This is the
   "business profile" prompt. Name it Side Kick, use your work email.
   - **You do NOT need Business Verification for this test.** Verification is only
     required for a *production* phone number, higher send limits, and template
     approval. The free test number works on an unverified portfolio.
5. **Publishing requirements** → likely empty → **Next** → **Create app**.

Meta now auto-creates a test WhatsApp Business Account + a **free test phone
number** for you.

6. Go to **Use cases → Customize → API Setup** (NOT a "WhatsApp" sidebar item —
   that's the old flow). There you get:
   - the **test phone number** (this is the number Kunal messages)
   - **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID` *(the ID, not the number)*
   - **Generate access token** → `WHATSAPP_TOKEN` (temporary, 24h)
7. Same page → **To** field → **Manage phone number list** → add **Kunal's number
   and yours**. Max 5 recipients on a test number. Each gets a confirmation code
   on WhatsApp that you must enter.
8. **App settings → Basic → App secret** (click **Show**) → `WHATSAPP_APP_SECRET`.

> ⚠️ **The token from step 6 expires in 24 HOURS.** This is the #1 thing that breaks
> this setup: everything works, then silently stops ~a day later. The symptom is
> that inbound messages still arrive (the webhook is fine) but no reply ever sends —
> Meta rejects the send with `OAuthException code 190, subcode 463`.
>
> Check any token's real expiry (don't guess) with `debug_token`:
> ```bash
> curl -s "https://graph.facebook.com/v21.0/debug_token?input_token=<TOKEN>&access_token=<APP_ID>|<APP_SECRET>"
> ```
> Look at `is_valid` and `expires_at` (`0` = never expires).

## Step 2b — Get a permanent token (do this before any real use)

Verified against Meta's docs 16 Jul 2026. The temporary token is only for a same-day
smoke test; a System User token never expires.

1. <https://business.facebook.com/latest/settings> → sidebar → **Users → System users**.
2. **Add+** (top-right) → name it e.g. `sidekick-wa` → role **Admin** → **Create system user**.
3. Select it → **Assign assets**. **Both** are required — the app alone cannot send:
   - **Apps** → *Side Kick - Chat App* → **Full control** (toggle **Manage app**)
   - **WhatsApp accounts** → your WABA → **Full control** (toggle **Manage WhatsApp Business accounts**)
   - → **Assign assets**
4. **Generate token** → select the app → **Next**.
5. Under **Assign Permissions**, tick **all three** (`business_management` is easy to
   miss and is in Meta's own list):
   - `business_management`
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
6. If a **token expiration** dropdown appears, choose **Never**.
7. **Generate token** → copy it. **Meta shows it once.**

Then swap it in and rebuild:
```bash
npx vercel env rm WHATSAPP_TOKEN production --yes
printf '%s' "<new token>" | npx vercel env add WHATSAPP_TOKEN production
npx vercel deploy --prod --yes        # env vars only bind on the next deploy
```
Verify with `debug_token` before trusting it: `is_valid: true`, `expires_at: 0`.

## Step 2 — Set the env vars (Vercel → sidekick-chat → Settings → Environment Variables)

```
WHATSAPP_TOKEN             = EAAG...            # from API Setup
WHATSAPP_PHONE_NUMBER_ID   = 123456789012345    # the ID, not the number
WHATSAPP_APP_SECRET        = abc123...          # App Settings → Basic
WHATSAPP_VERIFY_TOKEN      = <invent any string, e.g. sidekick_wa_7765007>
WHATSAPP_ALLOWED_NUMBERS   = 91XXXXXXXXXX,91YYYYYYYYYY   # Kunal, you. No "+", comma-separated.
WHATSAPP_PUSH_SECRET       = <invent any string>         # auth for /api/whatsapp/push
```

**That's the whole list — no OpenAI key needed here.** Voice notes are transcribed
by SignalScope's `/api/sidekick/transcribe`, which already has `OPENAI_API_KEY`.
This app calls it with the `SIDEKICK_API_KEY` it already carries.

(Why not Claude? The Anthropic Messages API takes text, images and PDFs — there is
no audio input and no speech-to-text endpoint. Transcription is the one step in the
flow that can't run on the Claude key. Everything downstream of the transcript —
angles, comment, post, refine — still does.)

**Env vars only take effect on the NEXT deployment.** After adding them, redeploy:
`npx vercel --prod --yes` from the repo, or hit Redeploy in the Vercel dashboard.

## Step 3 — Point Meta at the webhook

Go to **Use cases → Customize → Configuration**. (On the use-case flow this is
where webhooks live. The old docs say "WhatsApp → Configuration" — that sidebar
item does not exist on a use-case app. Same panel, different path.)

- **Callback URL:** `https://sidekick-chat-beige.vercel.app/api/whatsapp/webhook`
- **Verify token:** the exact `WHATSAPP_VERIFY_TOKEN` string you invented
- Click **Verify and save**. Meta calls the GET route and expects the challenge
  echoed back. If this fails, it's almost always because the env vars from Step 2
  were set but **not redeployed** — the running build doesn't have the token yet.
- Then, in the **Webhook fields** list, click **Manage** and **subscribe to
  `messages`**. This is the step everyone forgets. Without it Meta happily accepts
  your callback URL and then never sends you a single message.

> **If the URL verifies but no messages ever arrive:** flip the app from **Dev** to
> **Live** using the toggle at the top of the dashboard. Meta's docs warn that
> "some webhooks will not be sent if your app is in Dev mode." Going Live needs a
> **Privacy Policy URL** under App settings → Basic (any valid policy URL works;
> Side Kick's site is fine). It does NOT need Business Verification.

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
