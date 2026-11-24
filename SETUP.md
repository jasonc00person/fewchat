# SETUP.md: from this folder to a live FewChat

Claude runs this top to bottom when the user says "set this up". Do every step you can with your own tools; the user only does what needs their hands (accounts, payment, clicks inside Meta's and Cloudflare's dashboards, pasting their API key into `.env`). Tick each step off in chat as it lands, and verify each one where it lands before moving on.

**Secrets never go in chat.** The user types them into `.env` themselves; you push them with `grep '^NAME=' .env | cut -d= -f2- | npx wrangler secret put NAME`, so the value never prints. Never `cat .env`.

## 0. What the user needs first (about 30 minutes, once)

- A Mac, Windows or Linux machine with **Node 22+** (`node -v`). Install from nodejs.org if missing.
- An **Instagram professional account** (Business or Creator: Instagram app → Settings → Account type and tools).
- A **Cloudflare account** (free to create at dash.cloudflare.com). **Workers Paid ($5/mo) is strongly recommended**: the free plan's 5M database reads/day runs out with a busy inbox, and then the console, webhook and cron all stop until midnight UTC.
- An **Anthropic API key** (console.anthropic.com → API keys) with billing on. Replies are drafted by Claude Opus; expect a few cents per conversation.
- A **Meta developer account** (developers.facebook.com, log in with the Facebook account that manages the Instagram account).

## 1. Install

```bash
npm ci
npx wrangler login
```

`wrangler login` opens the browser; the user approves. Check with `npx wrangler whoami`. Then `npm test` and `npm run typecheck` must both pass before anything else.

## 2. Make it theirs (brand, script, knowledge)

Interview the user, one short question at a time, then fill every `<<FILL: ...>>` and `REPLACE_...` (except `ORIGIN`, the D1 id and the Instagram app id, which come in steps 3-5):

1. **`src/brand.ts`**: Instagram handle, business or legal name (shows on the privacy policy), website, contact email, community name, Skool slug (`skool.com/<slug>`). Also set `SKOOL_LINK` in `wrangler.jsonc` to the join link (usually `https://www.skool.com/<slug>/about`).
2. **`src/prompt.ts`**: what they sell, price, what's inside, member wins, who buys. **The voice comes from their real DMs, not from adjectives**: ask them to paste 10-20 messages they typed by hand to leads or members (screenshots work), and pull the phrases, length, casing and emoji habits from those. Keep the framework, objections and actions as written; only rephrase the quoted lines to sound like them.
3. **`src/knowledge.ts`**: the facts people ask before buying (price, what's inside, setup, requirements, the honest "no" answers), plus a section for each freebie their automations send.

Then run `npm test` again (it runs against `test/brand.ts`, so it should still pass) and `node scripts/preflight.mjs` to see what's left.

## 3. Cloudflare resources

```bash
npx wrangler d1 create fewchat            # copy the database_id into wrangler.jsonc
npx wrangler queues create fewchat-send
npm run db:setup                             # schema.sql + every migration, in order
```

Verify: `npx wrangler d1 execute fewchat --remote --command "SELECT COUNT(*) FROM sqlite_master WHERE type='table'"` returns a few dozen tables.

## 4. Secrets + first deploy

Copy `.env.example` to `.env`, then generate the three internal secrets into it:

```bash
for k in INBOUND_SECRET ADMIN_PASSWORD META_VERIFY_TOKEN; do sed -i.bak "s/^$k=.*/$k=$(openssl rand -hex 16)/" .env; done; rm .env.bak
```

Ask the user to paste their Anthropic key into `.env` as `ANTHROPIC_API_KEY=` and say done. Push each of the four with the `grep | wrangler secret put` line above.

Deploy once with the placeholders still in `ORIGIN` and the Instagram app id, to learn the URL: `npx wrangler deploy` (bypasses the preflight on purpose, this one time). Wrangler prints `https://fewchat.<subdomain>.workers.dev`. Put that in `ORIGIN` in `src/brand.ts`. Open `<ORIGIN>/privacy` in the browser: it should show their business name and handle.

The user's console password is `ADMIN_PASSWORD` in `.env`: tell them where it is, don't print it.

## 5. The Meta app (the user clicks, you guide)

On developers.facebook.com → My Apps:

1. **Create app** → use case "Other" → type **Business** → name it (e.g. "FewChat"), attach their business portfolio if they have one.
2. Add the **Instagram** product → **API setup with Instagram login**.
3. Copy the **Instagram app ID** into `META_IG_APP_ID` in `wrangler.jsonc`. Have the user paste the **Instagram app secret** into `.env` as `META_APP_SECRET=`, then push it as a secret.
4. **Configure webhooks**: callback URL `<ORIGIN>/meta`, verify token = `META_VERIFY_TOKEN` from `.env` (the user copies it from the file). Verify and save, then turn on the fields `messages`, `messaging_postbacks`, `messaging_seen`, `messaging_referral`, `message_reactions`, `message_edit`, `comments`, `live_comments`.
5. **Set up Instagram business login** (expand section 3 on the API setup page first; the button does nothing while it's collapsed): OAuth redirect URI `<ORIGIN>/auth/callback`.
6. **App settings → Basic**: Privacy policy URL `<ORIGIN>/privacy`, Terms URL `<ORIGIN>/terms`, User data deletion → Data deletion callback `<ORIGIN>/data-deletion`, App domain = the workers.dev host, a category and an app icon. Under Instagram → "Deauthorize callback URL" `<ORIGIN>/deauthorize` and "Data deletion request URL" `<ORIGIN>/data-deletion`.
7. **App roles → Roles → Instagram Testers**: add their Instagram account, then accept it in the Instagram app (Settings → Website permissions → Apps and websites → Tester invites).
8. Switch the app to **Live** (top of the dashboard). Meta may ask for a Data Use Checkup or business verification first; the user completes it. **App Review is not needed** for an account they own (Standard Access).

Now `npm run deploy` (the preflight must pass: no `<<FILL` or `REPLACE` left anywhere).

## 6. Connect Instagram

Open `<ORIGIN>/admin/password`, log in with `ADMIN_PASSWORD`, then open `<ORIGIN>/auth/start` and approve the Instagram consent screen (three permissions: basic, messages, comments). From then on **Log in with Instagram** at `<ORIGIN>/login` works, and only for that account (the password stays as the fallback).

Verify: the sidebar shows their name and handle under the logo, and My Profile shows the account.

## 7. Prove it end to end (before the AI talks to anyone)

The master AI switch stays **off**. From a second Instagram account (a friend's or a spare), with `npx wrangler tail` running:

1. **DM**: send the account a DM. It must show in the Inbox within seconds (no webhook hit in the tail = step 5.4 or 5.8 isn't done). In that thread, flip "AI off · turn on here" and send another DM from the second account: the setter should read it, show typing, and reply in their voice. Turn it back off.
2. **Comment-to-DM**: Automations → new automation from a template → a comment trigger with a test keyword on one post → Publish. Comment the keyword from the second account: a private-reply DM must arrive within seconds.
3. **Voice note**: send a voice note from the second account in the AI-on thread; the reply should react to what was said.

Read 5-10 drafted replies with the user. Anything off-voice → fix `src/prompt.ts`; any wrong or missing fact → `src/knowledge.ts`; `npm run deploy`.

## 8. Go live

When the user is happy: open **AI** in the sidebar and turn **AI replies** on. From then on it answers every DM within seconds, inside Instagram's 24h window.

Optional, ask the user about each:
- **Phone alerts** (recommended): install the ntfy app, subscribe to a long random topic, `ALERT_TOPIC=<topic>` into `.env` and push it.
- **Link tracking**: Settings → track links (counts clicks per lead, needed for join matching).
- **Skool customers + join verification**: the user copies their Skool `auth_token` cookie (skool.com → browser dev tools → Application → Cookies) into `.env` as `SKOOL_AUTH_TOKEN=` and you push it. Members are then never pitched and joins from the DMs are confirmed on the Dashboard.
- **Friends & family**: Settings → Friends & family, add the @usernames the AI must never answer.
- **Manychat users**: `MANYCHAT_API_KEY` (Manychat → Settings → API) so the setter can reply in threads Manychat owns. Move keyword automations over one at a time; turn each one OFF in Manychat the moment it's live here (see CLAUDE.md "Manychat").
- **Import past DMs**: `scripts/backfill.mjs` (see CLAUDE.md Lab Notes), so the Inbox and the AI know who they've already talked to. 90 days is plenty.
- **Bot disclosure**: `DISCLOSE` in `src/autonomy.ts`; their call, mention California's bot law.

Done = a real lead got a reply from the AI that the user would have sent themselves.
