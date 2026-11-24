# 📫 FewChat

Open-source Instagram DM automation you host yourself. Comment-to-DM, story and keyword automations on a visual flow builder, a live inbox for every conversation, contacts, and the numbers on how your DMs perform.

If you've used Manychat for Instagram, you'll know your way around: FewChat is a self-hosted alternative for one Instagram account. It runs on your own Cloudflare account through the official Instagram API, so your contacts and conversations stay in your database, with no per-contact pricing.

## What it does

- **Comment-to-DM automations.** Someone comments your keyword on a post or reel and gets your DM, plus an optional public reply under their comment. Works on one post, every post, or the next one you publish.
- **Story and DM automations.** Trigger on a reply to your story (any story or one in particular), a story mention, a keyword in a DM, or someone's first message.
- **A visual flow builder.** Messages with buttons and quick replies, smart delays, conditions (tag, keyword, follows you), A/B randomizers and actions (tag, start another automation), drawn as cards on a canvas. Drafts autosave; Publish makes them live. Each published automation shows its key metrics and who's behind them.
- **Inbox.** Every conversation live in one place, with photos, voice notes, reactions and swipe-to-reply, the 24-hour reply window counted down, tags, and replies you send by hand.
- **Contacts.** Everyone who messaged or commented, searchable, filtered by tag.
- **Metrics.** Messages received, people reached, reply rate and click-through rate against the days before, messages per day, and your top automations.
- **Reliable sending.** Private replies queue under Instagram's hourly cap and retry, missed comments are backfilled, and your phone gets an alert when something keeps failing.

### In beta: AI replies

An optional AI assistant can answer DMs in your voice with Claude, from a script and facts you write. It's off by default and still a work in progress: turn it on for one conversation to try it. Everything above works without it.

## Quick start

You need:

- **Node 22+**
- **[Claude Code](https://claude.com/claude-code)** (recommended: it runs the whole setup with you)
- An **Instagram professional account** (Business or Creator)
- A **Cloudflare account**. Workers Paid ($5/mo) is strongly recommended: the free plan's database read limit runs out with a busy inbox.
- A **Meta developer account** (free), logged in with the Facebook account that manages your Instagram
- An **Anthropic API key**. The setup asks for one: it describes photos people send you and powers the beta AI replies.

```bash
git clone https://github.com/jasonc00person/fewchat.git
cd fewchat
claude
```

Then say **"set this up"**. Claude follows [`SETUP.md`](SETUP.md) top to bottom: it fills in your account details with you, creates the Cloudflare resources, walks you through the Meta app, deploys, and proves everything end to end from a second Instagram account. You only do what needs your hands (accounts, dashboard clicks, pasting secrets into `.env`).

Prefer doing it yourself? [`SETUP.md`](SETUP.md) reads fine as a manual checklist. `npm run deploy` refuses to ship while any setup placeholder is left.

Want to look around first? `bash scripts/preview.sh` runs the console on your machine with made-up sample data.

## Make it yours

| File | What goes in it |
| --- | --- |
| `src/brand.ts` | Your handle, business name, contact email and community |
| `wrangler.jsonc` | Cloudflare config: database id, Instagram app id, the link your automations send |
| `src/prompt.ts`, `src/knowledge.ts` | The beta AI's script and the facts it answers from. Setup has you fill them in even if you leave the AI off |

[`CLAUDE.md`](CLAUDE.md) explains how everything works, for you and for Claude.

## Instagram's rules

FewChat follows them by design; staying within them is still your responsibility.

- Automated messages only go out within 24 hours of the person's last message, comment or button tap. You can always reply by hand from the Instagram app.
- Official APIs only. For an account you own or manage, Standard Access is enough and App Review isn't required, but the Meta app has to be Live.
- Instagram has no "new follower" event, so follow-triggered DMs aren't possible here.
- Some places require disclosing that a bot is replying. If you turn on AI replies, set `DISCLOSE` in `src/autonomy.ts` where that applies to you.
- Media is fetched when you view it and never stored, in line with Meta's Platform Terms.

## Development

```bash
npm test            # the full suite, with real SQL through a local D1 shim
npm run typecheck
npm run deploy      # checks for setup placeholders first
npx wrangler tail   # live logs
```

Issues and pull requests are welcome.

## License and trademarks

[MIT](LICENSE). Built by [@jasoncooperson](https://www.instagram.com/jasoncooperson/).

FewChat is an independent project. It is not affiliated with, endorsed by or sponsored by Manychat, Meta, Instagram, Cloudflare, Anthropic or Skool. Their names are trademarks of their owners and are used here only to say what FewChat works with or is an alternative to.
