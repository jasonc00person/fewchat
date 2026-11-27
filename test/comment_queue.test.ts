import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeD1 } from "./d1shim";
import * as db from "../src/db";
import { drainComments, handleComment, HOURLY_BUDGET, tellBacklog, tellRefused } from "../src/comments";
import { pace } from "../src/setter";
import { handleInboundFlow } from "../src/flows";
import { syncComments } from "../src/comment_sync";
import type { Env } from "../src/setter";

const ME = "17840000000000001";
const MIN = 60_000;
const T = 1_800_000_000_000;

type Call = { url: string; body: any };
let calls: Call[] = [];
let failNext: string | null = null;
let feed: { id: string; text: string; timestamp: string; from: { id: string; username: string } }[] = [];

beforeEach(() => {
  calls = [];
  failNext = null;
  feed = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      if (url.endsWith("/me/messages")) {
        if (failNext) {
          const msg = failNext;
          failNext = null;
          return Response.json({ error: { message: msg, code: /rate/i.test(msg) ? 613 : 100 } }, { status: 400 });
        }
        return Response.json({ recipient_id: body.recipient.comment_id ? "lead-1" : body.recipient.id, message_id: `m${calls.length}` });
      }
      if (url.includes("/comments?")) return Response.json({ data: feed });
      return Response.json({ data: [] });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const env = { DB: makeD1(), SKOOL_LINK: "https://www.skool.com/your-community/about" } as unknown as Env;
  await db.setSetting(env.DB, "ig_token", "tok");
  await db.setSetting(env.DB, "ig_account_id", ME);
  const t = await env.DB.prepare(
    `INSERT INTO triggers (source, keyword, dm, media_id, enabled, created_at) VALUES ('comment', 'AGENT', 'here you go', 'reel1', 1, 1) RETURNING id`,
  ).first<{ id: number }>();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO flow_nodes (trigger_id, id, kind, data, x, y) VALUES (?1, 'trigger', 'trigger', '{}', 0, 0)`).bind(t!.id),
    env.DB.prepare(`INSERT INTO flow_nodes (trigger_id, id, kind, data, x, y) VALUES (?1, 'm1', 'message', ?2, 1, 0)`).bind(
      t!.id,
      JSON.stringify({ bubbles: [{ text: "here you go", buttons: [] }], quick_replies: [] }),
    ),
    env.DB.prepare(`INSERT INTO flow_edges (trigger_id, from_id, port, to_id) VALUES (?1, 'trigger', 'next', 'm1')`).bind(t!.id),
  ]);
  return env;
}
const privateReplies = () => calls.filter((c) => c.url.endsWith("/me/messages") && c.body?.recipient?.comment_id);
const comment = (id: string, text = "AGENT", lead = `lead-${id}`) => ({ comment_id: id, lead_id: lead, username: "u", media_id: "reel1", text });
const status = async (env: Env, id: string) => (await env.DB.prepare(`SELECT status, attempts FROM comments WHERE comment_id = ?1`).bind(id).first<{ status: string; attempts: number }>())!;

describe("private reply queue", () => {
  it("past the hourly budget, keyword comments wait and go out as the budget frees up, oldest first", async () => {
    const env = await setup();
    // An hour's worth already sent.
    await env.DB.batch(
      Array.from({ length: HOURLY_BUDGET }, (_, i) =>
        env.DB.prepare(`INSERT INTO comments (comment_id, subscriber_id, text, status, created_at, sent_at) VALUES (?1, ?2, 'x', 'sent', ?3, ?3)`).bind(`old${i}`, `o${i}`, T - 30 * MIN),
      ),
    );
    await handleComment(env.DB, "tok", env.SKOOL_LINK, comment("c1"), T);
    await handleComment(env.DB, "tok", env.SKOOL_LINK, comment("c2"), T + 1000);
    expect(privateReplies()).toHaveLength(0);
    expect((await status(env, "c1")).status).toBe("queued");
    expect(await drainComments(env.DB, "tok", env.SKOOL_LINK, T + 10 * MIN)).toBe(0); // still no room
    expect(await drainComments(env.DB, "tok", env.SKOOL_LINK, T + 31 * MIN)).toBe(2); // the old hour rolled off
    expect(privateReplies().map((c) => c.body.recipient.comment_id)).toEqual(["c1", "c2"]);
    expect((await status(env, "c2")).status).toBe("sent");
  });

  // Each matched comment checks the budget. Counting the whole hour on every check read up to 700 × 700 rows an hour on
  // a viral post, so the cron saves the part of the hour older than 20 minutes and a comment counts the rest live.
  it("the budget check uses the cron's count without ever reading low, and recounts when it's stale", async () => {
    const env = await setup();
    const sent = (n: number, prefix: string, at: number) =>
      env.DB.batch(
        Array.from({ length: n }, (_, i) =>
          env.DB.prepare(`INSERT INTO comments (comment_id, subscriber_id, text, status, created_at, sent_at) VALUES (?1, ?2, 'x', 'sent', ?3, ?3)`).bind(`${prefix}${i}`, `${prefix}${i}`, at),
        ),
      );
    await sent(HOURLY_BUDGET - 20, "old", T - 30 * MIN);
    await drainComments(env.DB, "tok", env.SKOOL_LINK, T);
    expect(await db.getSetting(env.DB, "comment_sent_hour")).toBe(`${HOURLY_BUDGET - 20}:${T}`);
    // A drain or backfill pass stamped before the count and written after it: still counted.
    await sent(10, "late", T - 5 * MIN);
    for (let i = 1; i <= 11; i++) await handleComment(env.DB, "tok", env.SKOOL_LINK, comment(`c${i}`), T + i * 1000);
    expect(privateReplies()).toHaveLength(10); // 680 + 10 late + 10 sent now = the budget: the 11th waits
    expect((await status(env, "c11")).status).toBe("queued");
    // A backfill pass whose time is older than the saved count reads it too, and doesn't overwrite it.
    await handleComment(env.DB, "tok", env.SKOOL_LINK, comment("c12"), T - MIN);
    expect((await status(env, "c12")).status).toBe("queued");
    expect(await db.getSetting(env.DB, "comment_sent_hour")).toBe(`${HOURLY_BUDGET - 20}:${T}`); // read, never recounted

    // Past 2 minutes old the saved count isn't trusted: a recount, which also sees the old hour roll off.
    await handleComment(env.DB, "tok", env.SKOOL_LINK, comment("c13"), T + 31 * MIN);
    expect((await status(env, "c13")).status).toBe("sent");
    expect(await db.getSetting(env.DB, "comment_sent_hour")).toBe(`20:${T + 31 * MIN}`); // the 680 rolled off; the 20 from around T are older than 20 min
  });

  it("a rate-limit refusal retries with backoff; a permanent error fails; past 7 days it expires", async () => {
    const env = await setup();
    failNext = "Calls to this api have exceeded the rate limit.";
    await handleComment(env.DB, "tok", env.SKOOL_LINK, comment("c1"), T);
    expect(await status(env, "c1")).toEqual({ status: "queued", attempts: 1 });
    expect(await drainComments(env.DB, "tok", env.SKOOL_LINK, T + MIN)).toBe(0); // backoff: 2 minutes
    expect(await drainComments(env.DB, "tok", env.SKOOL_LINK, T + 3 * MIN)).toBe(1);
    expect((await status(env, "c1")).status).toBe("sent");

    failNext = "The comment was deleted";
    await handleComment(env.DB, "tok", env.SKOOL_LINK, comment("c2"), T);
    expect((await status(env, "c2")).status).toBe("failed");

    // Too many new conversations at once: Instagram says the thread doesn't exist. It waits an hour, then sends.
    failNext = "The thread owner has archived or deleted this conversation, or the thread does not exist.";
    await handleComment(env.DB, "tok", env.SKOOL_LINK, comment("c4"), T);
    expect(await status(env, "c4")).toEqual({ status: "queued", attempts: 1 });
    expect(await drainComments(env.DB, "tok", env.SKOOL_LINK, T + 30 * MIN)).toBe(0);
    // A live comment still gets refused at T+55, so the retry holds off until it's been quiet 10 minutes.
    failNext = "The thread owner has archived or deleted this conversation, or the thread does not exist.";
    await handleComment(env.DB, "tok", env.SKOOL_LINK, comment("c5"), T + 55 * MIN);
    expect(await drainComments(env.DB, "tok", env.SKOOL_LINK, T + 61 * MIN)).toBe(0);
    expect(await drainComments(env.DB, "tok", env.SKOOL_LINK, T + 66 * MIN)).toBe(1);
    expect((await status(env, "c4")).status).toBe("sent");
    expect((await status(env, "c5")).status).toBe("queued");

    failNext = "rate limit";
    await handleComment(env.DB, "tok", env.SKOOL_LINK, comment("c3"), T);
    await drainComments(env.DB, "tok", env.SKOOL_LINK, T + 8 * 24 * 60 * MIN);
    expect((await status(env, "c3")).status).toBe("expired");
  });
});

describe("refused as too many new conversations", () => {
  const REFUSED = "The thread owner has archived or deleted this conversation, or the thread does not exist.";
  const publicReplies = () => calls.filter((c) => c.url.includes("/replies?")).map((c) => new URL(c.url).searchParams.get("message"));

  it("the public reply says to DM the keyword when a DM automation answers it, once, and never says sent", async () => {
    const env = await setup();
    await env.DB.prepare(`UPDATE triggers SET public_reply = 'gotchu, sent'`).run();
    failNext = REFUSED;
    await handleComment(env.DB, "tok", env.SKOOL_LINK, comment("c1"), T);
    expect(publicReplies()).toEqual([]); // no "sent" for a DM that didn't go

    failNext = REFUSED;
    await handleComment(env.DB, "tok", env.SKOOL_LINK, comment("c2"), T + 2 * MIN);
    expect(await tellRefused(env.DB, "tok", T + 3 * MIN)).toBe(2);
    expect(publicReplies()).toHaveLength(2);
    expect(publicReplies()[0]).toMatch(/DM me AGENT/);
    expect(await tellRefused(env.DB, "tok", T + 4 * MIN)).toBe(0); // once per comment

    // When the retry gets through later, the normal reply goes out too.
    expect(await drainComments(env.DB, "tok", env.SKOOL_LINK, T + 70 * MIN)).toBe(2);
    expect(publicReplies().slice(2)).toEqual(["gotchu, sent", "gotchu, sent"]);
  });

  it("DMing the keyword gets them the automation for the post they commented on; the retry then stands down", async () => {
    const env = await setup();
    // A second post shares the keyword: the DM must run the one they commented on.
    const other = await env.DB.prepare(`INSERT INTO triggers (source, keyword, dm, media_id, enabled, created_at) VALUES ('comment', 'AGENT', '', 'reel2', 1, 1) RETURNING id`).first<{ id: number }>();
    failNext = REFUSED;
    await handleComment(env.DB, "tok", env.SKOOL_LINK, comment("c1"), T);
    await env.DB.prepare(`INSERT INTO leads (subscriber_id, created_at, last_inbound_at) VALUES ('lead-c1', ?1, ?1)`).bind(T + 5 * MIN).run();
    expect(await handleInboundFlow(env as any, "tok", { lead_id: "lead-c1", text: "Agent" } as any, undefined, false, T + 5 * MIN)).toBe(true);
    const dms = calls.filter((c) => c.url.endsWith("/me/messages") && c.body?.recipient?.id === "lead-c1" && c.body?.message);
    expect(dms.map((c) => c.body.message.text)).toEqual(["here you go"]);
    const starts = (await env.DB.prepare(`SELECT trigger_id FROM flow_starts WHERE subscriber_id = 'lead-c1' AND status = 'sent'`).all<{ trigger_id: number }>()).results;
    expect(starts.map((r) => r.trigger_id)).not.toContain(other!.id);
    expect(starts).toHaveLength(1);

    await drainComments(env.DB, "tok", env.SKOOL_LINK, T + 70 * MIN);
    expect((await status(env, "c1")).status).toBe("repeat");
    expect(privateReplies()).toHaveLength(1); // only the refused one
  });
});

describe("a DM keyword trigger added while Instagram refuses the comment DMs", () => {
  const REFUSED = "The thread owner has archived or deleted this conversation, or the thread does not exist.";
  const more = async (env: Env, id = 1) => JSON.parse((await env.DB.prepare(`SELECT more FROM triggers WHERE id = ?1`).bind(id).first<{ more: string | null }>())?.more ?? "[]");

  it("the automation answers its keyword in DMs from then on, even from people who never commented, its draft too", async () => {
    const env = await setup();
    await env.DB.prepare(`UPDATE triggers SET public_reply = 'sent', draft = ?1`).bind(JSON.stringify({ trigger: { source: "comment", keyword: "AGENT" }, nodes: [], edges: [] })).run();
    failNext = REFUSED;
    await handleComment(env.DB, "tok", env.SKOOL_LINK, comment("c1"), T);
    expect(await more(env)).toEqual([]); // not yet: the cron adds it with the "DM me" reply
    await tellRefused(env.DB, "tok", T + MIN);
    expect(await more(env)).toEqual([{ source: "dm", keyword: "AGENT", media_id: null, public_reply: null, id: "auto", auto: true }]);
    const draft = JSON.parse((await env.DB.prepare(`SELECT draft FROM triggers WHERE id = 1`).first<{ draft: string }>())!.draft);
    expect(draft.more).toEqual(await more(env));

    // Someone who only read the reply under another comment DMs the word.
    await env.DB.prepare(`INSERT INTO leads (subscriber_id, created_at, last_inbound_at) VALUES ('reader', ?1, ?1)`).bind(T + 2 * MIN).run();
    expect(await handleInboundFlow(env as any, "tok", { lead_id: "reader", text: "agent pls" } as any, undefined, false, T + 2 * MIN)).toBe(true);
    expect((await env.DB.prepare(`SELECT via FROM flow_starts WHERE subscriber_id = 'reader'`).first<{ via: string }>())?.via).toBe("auto");

    failNext = REFUSED;
    await handleComment(env.DB, "tok", env.SKOOL_LINK, comment("c2"), T + 3 * MIN);
    await tellRefused(env.DB, "tok", T + 4 * MIN);
    expect(await more(env)).toHaveLength(1); // once
  });

  it("not when another live automation already answers that DM keyword", async () => {
    const env = await setup();
    await env.DB.prepare(`UPDATE triggers SET public_reply = 'sent'`).run();
    await env.DB.prepare(`INSERT INTO triggers (source, keyword, dm, enabled, created_at) VALUES ('dm', 'free, agent', '', 1, 1)`).run();
    failNext = REFUSED;
    await handleComment(env.DB, "tok", env.SKOOL_LINK, comment("c1"), T);
    await tellRefused(env.DB, "tok", T + MIN);
    expect(await more(env)).toEqual([]);
  });
});

describe("backlog of refused comments", () => {
  const REFUSED = "The thread owner has archived or deleted this conversation, or the thread does not exist.";
  const publicReplies = () => calls.filter((c) => c.url.includes("/replies?")).map((c) => new URL(c.url).searchParams.get("message"));

  it("one apology reply a tick, newest first, rotated, skipping anyone who already got it; a refusal stops it for a day", async () => {
    vi.spyOn(pace, "sleep").mockResolvedValue();
    const env = await setup();
    await env.DB.prepare(`UPDATE triggers SET public_reply = 'gotchu, sent'`).run();
    for (const [id, at] of [["old", T], ["mid", T + MIN], ["new", T + 2 * MIN], ["got", T + 3 * MIN]] as const) {
      failNext = REFUSED;
      await handleComment(env.DB, "tok", env.SKOOL_LINK, comment(id), at);
    }
    await env.DB.prepare(`UPDATE comments SET fallback_at = -1`).run(); // held, like the night it was built
    await env.DB.prepare(`UPDATE flow_starts SET status = 'sent' WHERE subscriber_id = 'lead-got'`).run(); // DM'd the keyword already
    const e = { ...env, ALERT_TOPIC: undefined } as unknown as Env;

    expect(await tellBacklog(e, "tok", T + 10 * MIN)).toBe(true);
    expect(await tellBacklog(e, "tok", T + 11 * MIN)).toBe(true);
    const replied = calls.filter((c) => c.url.includes("/replies?")).map((c) => c.url.split("/").at(-2)?.split("?")[0]);
    expect(replied).toEqual(["new", "mid"]);
    expect(publicReplies()[0]).toMatch(/DM me AGENT/);
    expect(publicReplies()[0]).not.toEqual(publicReplies()[1]);

    // Instagram refuses a public reply: nothing more for 24 hours.
    vi.mocked(fetch).mockImplementationOnce(async () => Response.json({ error: { message: "Action blocked", code: 368 } }, { status: 400 }));
    expect(await tellBacklog(e, "tok", T + 12 * MIN)).toBe(false);
    expect(await tellBacklog(e, "tok", T + 13 * MIN)).toBe(false);
    expect(publicReplies()).toHaveLength(2);
    expect(await tellBacklog(e, "tok", T + 12 * MIN + 25 * 60 * MIN)).toBe(true);
    expect(publicReplies()).toHaveLength(3);
  });

  it("our own database restarting mid-reply isn't Instagram refusing: the replies carry on next minute", async () => {
    vi.spyOn(pace, "sleep").mockResolvedValue();
    const env = await setup();
    await env.DB.prepare(`UPDATE triggers SET public_reply = 'gotchu, sent'`).run();
    failNext = REFUSED;
    await handleComment(env.DB, "tok", env.SKOOL_LINK, comment("one"), T);
    await env.DB.prepare(`UPDATE comments SET fallback_at = -1`).run();
    const e = { ...env, ALERT_TOPIC: undefined } as unknown as Env;
    const batch = env.DB.batch;
    env.DB.batch = (async () => {
      throw new Error("D1_ERROR: D1 DB exceeded its CPU time limit and was reset.");
    }) as never;
    expect(await tellBacklog(e, "tok", T + 10 * MIN)).toBe(false);
    env.DB.batch = batch;
    expect(await db.getSetting(env.DB, "backlog_replies_paused_until")).toBeNull();
    expect(await tellBacklog(e, "tok", T + 11 * MIN)).toBe(true);
  });
});

describe("missed-comment backfill", () => {
  const iso = (t: number) => new Date(t).toISOString().replace(".000Z", "+0000");

  it("starts from now, then DMs keyword comments the webhook never delivered, skipping ours and ones already seen", async () => {
    const env = await setup();
    feed = [{ id: "before", text: "AGENT", timestamp: iso(T - 60 * MIN), from: { id: "x", username: "x" } }];
    expect(await syncComments(env, T)).toBe(0); // first pass only sets the starting point
    expect(privateReplies()).toHaveLength(0);

    await handleComment(env.DB, "tok", env.SKOOL_LINK, comment("hooked"), T + MIN); // the webhook got this one
    feed = [
      { id: "ours", text: "gotchu fam, sent", timestamp: iso(T + 3 * MIN), from: { id: ME, username: "yourhandle" } },
      { id: "lost", text: "Agent 🔥", timestamp: iso(T + 2 * MIN), from: { id: "lead-lost", username: "l" } },
      { id: "hooked", text: "AGENT", timestamp: iso(T + MIN), from: { id: "lead-hooked", username: "h" } },
      { id: "before", text: "AGENT", timestamp: iso(T - 60 * MIN), from: { id: "x", username: "x" } },
    ];
    expect(await syncComments(env, T + 4 * MIN)).toBe(1);
    expect(privateReplies().map((c) => c.body.recipient.comment_id)).toEqual(["hooked", "lost"]);
    expect(await syncComments(env, T + 5 * MIN)).toBe(0); // inside 3 minutes: no pass
    expect(await syncComments(env, T + 8 * MIN)).toBe(0); // nothing new
  });
});
