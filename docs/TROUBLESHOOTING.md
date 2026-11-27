# Troubleshooting

**Start here, every time:**

```bash
npm run check
```

It looks at your live FewChat and lists what works and what doesn't, with the fix next to each problem. Most of this page is the longer version of what it tells you.

Running `npm run setup` again is always safe. It never deletes anything and continues from wherever it stopped.

## During setup

| What you see | What to do |
| --- | --- |
| `npm: command not found` or `node: command not found` | Node.js isn't installed. Get it from nodejs.org (the "LTS" button), close and reopen your terminal, try again. |
| "FewChat needs Node 22 or newer" | Install the current version from nodejs.org over the old one. |
| The browser tab for Cloudflare never opened | Run `npm run setup` again. If it still doesn't open, copy the link the terminal prints into your browser. |
| "Cloudflare wants your email address verified" | Click the link in the email Cloudflare sent when you signed up, then run setup again. |
| "doesn't have a workers.dev address yet" | Every Cloudflare account picks one name, once. Open dash.cloudflare.com → Workers & Pages, choose a subdomain, then run setup again. |
| "already has a Worker called fewchat" | Something with that name is already on your Cloudflare account. Setup stops instead of replacing it and prints the two ways forward. |
| Something about your plan, or queues | Open dash.cloudflare.com → Workers & Pages → Plans and switch to Workers Paid ($5 a month), then run setup again. |
| Anything else | The full details are in `.wrangler/setup.log`. It can contain your Cloudflare account id and email, so read it before sharing it. |

## The Meta app

These are the steps in `MY-SETUP.md`. The step number is where to look.

| Problem | Usual cause |
| --- | --- |
| Meta says the callback URL or verify token couldn't be validated | On a new (Unified login) app, setup sets the webhook itself: run `npm run setup` again. On an older Instagram-login app it's step 5: a stray space or the wrong value pasted, so copy both again. Run `npm run check`: if "Answers Instagram's webhook check" has a ✓, your side is fine. |
| An error about the redirect URI when you log in | Step 5 (older apps: step 6): the redirect URL has to match exactly, ending in `/auth/callback`. |
| An error about your developer role, or not being a tester | Older Instagram-login apps, step 8: add your Instagram account as an Instagram tester, **and** accept the invite inside Instagram. Both halves are needed. |
| The **Business login settings** button does nothing | Open (unfold) that section of the page first, then click it. |
| Meta says "API setup with Instagram login is not available for newer apps" | That's normal for any app made since late October 2026. FewChat's default steps are for that kind (Unified login). Only an older app that still offers Instagram login needs `npm run setup -- --login=instagram`. |
| "Meta didn't share an Instagram account with FewChat" after logging in | The login configuration is missing `business_management` (steps 6 and 7), or you didn't tick your account when Meta asked. Add it, then log in again. |
| Your Instagram account isn't in Meta's list at login | It isn't in your business portfolio yet: business.facebook.com/settings → Instagram accounts → Add (step 3). |
| Meta won't let you Publish (or switch to Live) | It lists what's missing, usually the privacy policy URL, the app icon or the category from App settings → Basic. |
| Meta talks about App Review | You can skip it. For an Instagram account you own, standard access is enough. |

## Messages aren't arriving

`npm run check` says "Nothing has ever arrived from Instagram", or your Inbox stays empty.

1. **Is the Meta app published (Live)?** Step 8 (older apps: step 9). Until then, Instagram only delivers messages from accounts that have a role on your app.
2. **Is the webhook set?** `npm run check` says ("The Meta app's webhook points here"); on a new app `npm run setup` sets it again. Older apps: step 5, where the fields are separate switches under the callback URL.
3. **Comments arrive but DMs only show up a minute late (or not at all)?** On a Unified login app this is Meta's own limitation when your Instagram account is linked to a Facebook Page and the Page wasn't shared at login. Open `<your address>/auth/start` and, when Meta asks, pick that Page as well as your Instagram account (steps 6 and 7 add the Page option if your configuration doesn't have it yet). Business settings → Instagram accounts → your account → Connected assets shows which Page it is.
4. **Is Instagram connected?** Logging in with Instagram the first time is what tells Instagram to send this account's messages to your FewChat. If in doubt, open `<your address>/auth/start` and approve again. It's harmless.
4. **Test from a different account.** A message you send to yourself doesn't count.

## An automation isn't firing

- **Is it LIVE?** A draft does nothing until you click Publish. OFF means it was switched off.
- **Is the keyword a whole word in the comment?** `GUIDE` matches "guide please" but not "guides". Add the plural as a second keyword, separated by a comma.
- **Is it on the right post?** An automation for one post ignores comments on every other post.
- **Did this person already get it?** Each person gets an automation once. To test over and over, use the editor's **Test** button: it gives a 3-digit code to DM from another account.
- **Did the same keyword match another automation?** One for a specific post wins over one for every post.
- **Does Home show "Delivery problems"?** It lists the reason Instagram gave.

## A DM wasn't delivered

- **"The requested user cannot be found"**: that account was deleted or blocked you. Nothing to fix.
- **Sent too late**: more than 24 hours since their last message. Instagram's rule, and FewChat doesn't try.
- **"not the thread owner"**: another DM tool on the same Instagram account owns that conversation. Don't run the same keyword in two tools.
- **Buttons don't show**: buttons and quick replies only appear in the Instagram phone app, not on desktop.
- **Lots waiting to send**: Instagram allows about 750 comment DMs an hour. FewChat queues the rest and sends them as the hour rolls on.
- **Comment DMs go out, but delays longer than 15 seconds, follow-ups, retries or broadcasts never do**: you're probably on Cloudflare's free plan, which cuts each background run off after 10 milliseconds of processing. Switch to Workers Paid ($5 a month): dash.cloudflare.com → Workers & Pages → Plans.
- **"The thread owner has archived or deleted this conversation, or the thread does not exist"** on a post that's blowing up: Instagram limits how many new conversations an account can start in an hour, and on a viral post you hit it (roughly 300 an hour). Only people who have never messaged you are refused. FewChat retries them by itself once Instagram eases off, and replies under their comment telling them to DM you the keyword, which gets them the same automation straight away. Pause any broadcast while it's happening, and don't force retries. The full playbook is in `CLAUDE.md` under "When a post goes viral".

## The console

- **Forgot the password?** It's in `MY-SETUP.md`, and in `.env` as `ADMIN_PASSWORD`. To change it: edit that line in `.env`, then run `npm run setup`.
- **No "Log in with Instagram" button?** Phones only get the password form, because the Instagram app takes over its approval screen. Use the password, or a computer.
- **A "busy" page that reloads itself**: something failed for a moment. If it stays, see "Everything stopped" below.
- **"Log in with Instagram" refuses you**: it only lets in the Instagram account this FewChat was set up for. Wrong username in setup? Fix `instagram_handle` in `fewchat.config.json` and run `npm run setup`.

## Everything stopped at once

**"Application request limit reached" (code 4) in Problems, or a phone alert saying "Meta's rate limit"**: Meta caps how many calls your Meta app can make, and a post that blows up can use it up (it happened to an account sending about 400 comment DMs an hour, ten minutes after it moved to Unified login). When Instagram says so, FewChat stops calling it for 5 minutes (longer each time it happens again, up to an hour, or as long as Meta says), so it can't make things worse. Nothing is lost while it waits: comment DMs queue, automation messages wait and continue from where they stopped, and broadcasts pause themselves. You'll see the alert at most once an hour. Don't restart or redeploy to "fix" it; it clears by itself. While Meta reports your app over 75% of its budget, FewChat also skips what can wait (profile pictures, the missed-message check, broadcasts) so the rest goes to replies.

On Cloudflare's free plan the database can only read and write so much per day. A busy inbox uses it up, and then the console, your automations and incoming messages all pause until midnight UTC. Nothing is lost: missed comments and messages are picked up afterwards. The fix is Workers Paid ($5 a month), which FewChat needs for real use anyway: dash.cloudflare.com → Workers & Pages → Plans.

## Updating

| What you see | What to do |
| --- | --- |
| "Not possible to fast-forward" or "Your local changes would be overwritten" | You changed FewChat's code, and the update changes the same files. Nothing was changed and your live FewChat still runs. Commit your changes (`git add -A && git commit -m "My changes"`), run `git pull --no-rebase`, then `npm run update` again. Details in README.md under "Getting updates". |
| "Already up to date", but you know there's a newer version | Your folder is a copy of a GitHub fork. Click **Sync fork** on your fork's GitHub page, then run `npm run update`. |
| "CONFLICT" after `git pull --no-rebase` | You and the update changed the same lines. Git marks each spot in the file between `<<<<<<<` and `>>>>>>>`. Keep what you want, delete the markers, then `git add -A && git commit`. Or ask your AI agent to finish the merge and keep your changes. |

## Watching it live

```bash
npx wrangler tail
```

Shows what your FewChat is doing right now, as it happens. Send yourself a test DM and watch it arrive. Press Ctrl+C to stop.

## Starting over, or removing FewChat

To redo your answers: delete `fewchat.config.json` and run `npm run setup`.

To remove FewChat from Cloudflare completely (this deletes your conversations and automations for good), run these in order. Replace `fewchat` if you chose another name:

```bash
npx wrangler queues consumer remove fewchat-send fewchat
```

```bash
npx wrangler delete --name fewchat
```

```bash
npx wrangler queues delete fewchat-send
```

```bash
npx wrangler d1 delete fewchat
```

Then delete your app on developers.facebook.com, and remove it in Instagram under Settings → Website permissions → Apps and websites.

## Asking for help

Open an issue on GitHub with what `npm run check` prints and what you expected to happen. **Never post your `.env` or `MY-SETUP.md`**: they hold your passwords.
