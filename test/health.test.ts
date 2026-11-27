import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeD1 } from "./d1shim";
import * as db from "../src/db";
import { checkHealth, cronStep, recentProblems, webhookSeen } from "../src/health";
import type { Env } from "../src/setter";

const MIN = 60_000;
const T = 1_800_000_000_000;
let pushes: { url: string; title: string | null; body: string }[] = [];
beforeEach(() => {
  pushes = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      pushes.push({ url, title: new Headers(init?.headers).get("Title"), body: String(init?.body) });
      return new Response("ok");
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
const env = (topic: string | undefined = "secret-topic") => ({ DB: makeD1(), ALERT_TOPIC: topic }) as unknown as Env;

describe("phone alerts", () => {
  it("a quiet webhook alerts once an hour, not every minute", async () => {
    const e = env();
    await webhookSeen(e.DB, T);
    await checkHealth(e, T + 30 * MIN);
    expect(pushes).toHaveLength(0);
    await checkHealth(e, T + 61 * MIN);
    await checkHealth(e, T + 62 * MIN);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].url).toBe("https://ntfy.sh/secret-topic");
    expect(pushes[0].title).toContain("webhook is quiet");
    await checkHealth(e, T + 122 * MIN); // an hour later, still quiet: again
    expect(pushes).toHaveLength(2);
  });

  it("three failed sends in 15 minutes alert with the last error; a comment backlog alerts too", async () => {
    const e = env();
    for (const i of [1, 2, 3])
      await e.DB.prepare(`INSERT INTO comments (comment_id, subscriber_id, text, status, error, created_at) VALUES (?1, 'x', 'AGENT', 'failed', 'instagram 400: boom', ?2)`).bind(`f${i}`, T - MIN).run();
    for (let i = 0; i < 51; i++)
      await e.DB.prepare(`INSERT INTO comments (comment_id, subscriber_id, text, status, created_at) VALUES (?1, 'x', 'AGENT', 'queued', ?2)`).bind(`q${i}`, T - 5 * MIN).run();
    await checkHealth(e, T);
    expect(pushes.map((p) => p.title)).toEqual(["FewChat: 3 sends failed in 15 min", "FewChat: 51 comment DMs waiting"]);
    expect(pushes[0].body).toContain("boom");
  });

  it("a cron step alerts after five failures in a row, and a success resets the count", async () => {
    const e = env();
    const boom = async () => {
      throw new Error("D1 read limit");
    };
    for (let i = 0; i < 4; i++) await cronStep(e, "setter", T + i * MIN, boom);
    expect(pushes).toHaveLength(0);
    await cronStep(e, "setter", T + 4 * MIN, async () => {});
    for (let i = 0; i < 5; i++) await cronStep(e, "setter", T + (5 + i) * MIN, boom);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].body).toContain("D1 read limit");
  });

  it("without a topic nothing is sent", async () => {
    const e = env("");
    await webhookSeen(e.DB, T);
    await checkHealth(e, T + 2 * 60 * MIN);
    expect(pushes).toHaveLength(0);
    expect(await db.getSetting(e.DB, "alert_at:webhook")).toBeNull();
  });
});

describe("Home's delivery problems", () => {
  it("a refused comment DM counts once, with its comment; a real flow failure still shows as a flow message", async () => {
    const e = env();
    const REFUSED = "Error: instagram 400 code 100: The thread owner has archived or deleted this conversation, or the thread does not exist.";
    const comment = (id: string, who: string, status: string, error: string | null) =>
      e.DB.prepare(`INSERT INTO comments (comment_id, subscriber_id, text, trigger_id, status, error, created_at) VALUES (?1, ?2, 'STYLE', 49, ?3, ?4, ?5)`)
        .bind(id, who, status, error, T - 60 * MIN)
        .run();
    const send = (who: string, status: string, error: string | null, trigger = 49) =>
      e.DB.prepare(`INSERT INTO flow_sends (trigger_id, subscriber_id, status, error, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`)
        .bind(trigger, who, status, error, T - 30 * MIN)
        .run();
    await comment("c1", "refused", "queued", REFUSED); // still waiting: its failed try is the comment DM's
    await send("refused", "failed", REFUSED);
    await comment("c2", "dmed", "repeat", null); // refused, then got it by DMing the keyword: nothing to report
    await send("dmed", "failed", REFUSED);
    await send("dmed", "sent", null);
    await comment("c3", "reached", "sent", null); // the DM went out, a later message failed: a real flow failure
    await send("reached", "sent", null);
    await send("reached", "failed", "Error: instagram 400: boom");
    await comment("c6", "retried", "sent", null); // refused once, then a retry got through: nothing to report
    await send("retried", "failed", REFUSED);
    await send("retried", "sent", null);
    await comment("c4", "gone", "failed", "Error: The requested user cannot be found.");
    await send("gone", "failed", "Error: The requested user cannot be found.");
    await send("dm-only", "failed", "Error: instagram 400: boom", 7); // a DM-keyword flow, no comment at all
    await comment("c5", "budget", "queued", null); // waiting on the hourly cap, not a failure

    const problems = await recentProblems(e.DB, T - 24 * 60 * MIN);
    const by = Object.fromEntries(problems.map((p) => [p.kind, p]));
    expect(Object.keys(by).sort()).toEqual(["comment DM", "comment DM waiting to retry", "flow message"]);
    expect(by["comment DM waiting to retry"].n).toBe(1);
    expect(by["comment DM waiting to retry"].detail).toContain("Instagram is limiting new conversations");
    expect(by["comment DM"].n).toBe(1);
    expect(by["flow message"].n).toBe(2);
    expect(by["flow message"].detail).toContain("boom");
  });
});
