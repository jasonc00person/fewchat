import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeD1 } from "./d1shim";
import { runBroadcasts, type Broadcast } from "../src/broadcast";
import * as db from "../src/db";
import type { Env } from "../src/setter";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 10, 27, 4, 0);

function makeEnv(): Env {
  return {
    DB: makeD1(),
    ANTHROPIC_API_KEY: "test",
    MANYCHAT_API_KEY: "",
    INBOUND_SECRET: "s",
    ADMIN_PASSWORD: "pw",
    REVIEW_PASSWORD: "rv",
    AI: {} as Ai,
    SKOOL_LINK: "https://www.skool.com/x/about",
    AUTOPILOT: "false",
    REPLY_DELAY_MIN_S: "60",
    REPLY_DELAY_MAX_S: "240",
    TRANSPORT: "meta",
    META_IG_APP_ID: "1",
    META_APP_SECRET: "appsecret",
    META_VERIFY_TOKEN: "vt",
    ALERT_TOPIC: "topic",
  } as Env;
}

let calls: { url: string; body: any }[] = [];
let refuse: ((to: string) => string | null) | null = null;
beforeEach(() => {
  // runBroadcasts hands Date.now() to each send, so the clock has to be NOW (it failed once real time passed NOW + 1h).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  calls = [];
  refuse = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body && String(url).includes("graph") ? JSON.parse(String(init.body)) : init?.body ?? null;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/me/messages")) {
        const err = refuse?.(body.recipient.id);
        if (err) return Response.json({ error: { message: err, code: 4 } }, { status: 400 });
        return Response.json({ recipient_id: body.recipient.id, message_id: `out-${calls.length}` });
      }
      return Response.json({ success: true });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const dms = () => calls.filter((c) => c.url.endsWith("/me/messages")).map((c) => c.body.recipient.id);
const alerts = () => calls.filter((c) => c.url.startsWith("https://ntfy.sh/")).map((c) => String(c.body));

async function auto(env: Env, text = "want the details?"): Promise<number> {
  const row = await env.DB.prepare(`INSERT INTO triggers (source, keyword, dm, created_at) VALUES ('none', '', ?1, 0) RETURNING id`).bind(text).first<{ id: number }>();
  return row!.id;
}
async function lead(env: Env, id: string, o: { wrote?: number; status?: string; ran?: number; tag?: string; mc?: boolean } = {}) {
  const at = NOW - (o.wrote ?? 2 * HOUR);
  await env.DB.prepare(`INSERT INTO leads (subscriber_id, username, status, last_inbound_at, last_at, created_at, mc_id) VALUES (?1, ?1, ?2, ?3, ?3, ?3, ?4)`)
    .bind(id, o.status ?? "active", at, o.mc ? "mc1" : null)
    .run();
  if (o.ran) await env.DB.prepare(`INSERT INTO flow_starts (trigger_id, subscriber_id, status, created_at) VALUES (?1, ?2, 'sent', ?3)`).bind(o.ran, id, at).run();
  if (o.tag) await env.DB.prepare(`INSERT INTO lead_tags (subscriber_id, tag, created_at) VALUES (?1, ?2, 0)`).bind(id, o.tag).run();
}
const set = (env: Env, id: number, b: Partial<Broadcast>) =>
  db.setSetting(env.DB, `broadcast:${id}`, JSON.stringify({ per_min: 5, cap: 100, status: "running", ...b }));
const get = async (env: Env, id: number) => JSON.parse((await db.getSetting(env.DB, `broadcast:${id}`))!) as Broadcast;

async function setup() {
  const env = makeEnv();
  await db.setSetting(env.DB, "ig_token", "tok");
  const source = await auto(env, "the reel's automation");
  const id = await auto(env);
  return { env, source, id };
}

describe("broadcasts", () => {
  it("sends only inside the window, soonest-to-close first, a few a minute, never twice", async () => {
    const { env, source, id } = await setup();
    await lead(env, "late", { ran: source, wrote: 23 * HOUR });
    await lead(env, "mid", { ran: source, wrote: 10 * HOUR });
    await lead(env, "fresh", { ran: source, wrote: 1 * HOUR });
    await lead(env, "closing", { ran: source, wrote: 24 * HOUR - 2 * MIN }); // would land after the window closes
    await lead(env, "expired", { ran: source, wrote: 25 * HOUR });
    await lead(env, "chatting", { ran: source, wrote: 5 * MIN });
    await lead(env, "member", { ran: source, tag: "member" });
    await lead(env, "friend", { ran: source, tag: "friend" });
    await lead(env, "stopped", { ran: source, status: "done" });
    await lead(env, "handoff", { ran: source, status: "paused" });
    await lead(env, "manychat", { ran: source, mc: true });
    await lead(env, "stranger"); // never ran the reel's automation
    await set(env, id, { from: [source], skip: ["member"], per_min: 2 });

    await runBroadcasts(env, NOW);
    expect(dms()).toEqual(["late", "mid"]);
    await runBroadcasts(env, NOW + MIN);
    await runBroadcasts(env, NOW + 2 * MIN);
    expect(dms()).toEqual(["late", "mid", "fresh"]);
    expect((await get(env, id)).left).toBe(0);
  });

  it("a paused broadcast only counts who it could reach", async () => {
    const { env, source, id } = await setup();
    await lead(env, "a", { ran: source });
    await lead(env, "b", { ran: source });
    await set(env, id, { from: [source], status: "paused" });
    await runBroadcasts(env, NOW);
    expect(dms()).toEqual([]);
    expect((await get(env, id)).left).toBe(2);
  });

  it("waits for start_at, and a tag picks the audience", async () => {
    const { env, id } = await setup();
    await lead(env, "yes", { tag: "black friday" });
    await lead(env, "no");
    await set(env, id, { tag: "Black Friday", start_at: NOW + HOUR });
    await runBroadcasts(env, NOW);
    expect(dms()).toEqual([]);
    await runBroadcasts(env, NOW + HOUR);
    expect(dms()).toEqual(["yes"]);
  });

  it('"any" = everyone who came in through an automation, minus not_from', async () => {
    const { env, source, id } = await setup();
    const other = await auto(env, "another reel");
    await lead(env, "reel", { ran: source });
    await lead(env, "story", { ran: other });
    await lead(env, "organic"); // DM'd on their own: collabs, friends, hand-answered threads
    await set(env, id, { from: "any", not_from: [source] });
    await runBroadcasts(env, NOW);
    expect(dms()).toEqual(["story"]);
  });

  it("stops at its cap and says so", async () => {
    const { env, source, id } = await setup();
    for (const x of ["a", "b", "c"]) await lead(env, x, { ran: source });
    await set(env, id, { from: [source], cap: 2 });
    await runBroadcasts(env, NOW);
    await runBroadcasts(env, NOW + MIN);
    expect(dms()).toEqual(["a", "b"]);
    const b = await get(env, id);
    expect(b.status).toBe("paused");
    expect(b.note).toMatch(/cap of 2 \(1 more/);
    expect(alerts().join()).toMatch(/cap of 2/);
  });

  it("pauses itself the moment Instagram says limit or spam", async () => {
    const { env, source, id } = await setup();
    for (const x of ["a", "b", "c", "d"]) await lead(env, x, { ran: source, wrote: 10 * HOUR });
    refuse = (to) => (to === "b" ? "Application request limit reached" : null);
    await set(env, id, { from: [source] });
    await runBroadcasts(env, NOW);
    expect(dms()).toEqual(["a", "b"]);
    const b = await get(env, id);
    expect(b.status).toBe("paused");
    expect(b.note).toMatch(/request limit reached/);
    await runBroadcasts(env, NOW + MIN);
    expect(dms()).toEqual(["a", "b"]);
  });

  it("a pause typed in mid-minute is never overwritten", async () => {
    const { env, source, id } = await setup();
    await lead(env, "a", { ran: source });
    await set(env, id, { from: [source] });
    refuse = () => {
      // the CLI pauses it while this minute's send is in flight
      void env.DB.prepare(`UPDATE settings SET value = json_set(value, '$.status', 'paused') WHERE key = ?1`).bind(`broadcast:${id}`).run();
      return null;
    };
    await runBroadcasts(env, NOW);
    expect((await get(env, id)).status).toBe("paused");
  });
});
