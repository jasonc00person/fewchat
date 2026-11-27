import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeD1 } from "./d1shim";
import * as db from "../src/db";
import { runDueFlows } from "../src/flows";
import worker from "../src/index";
import { graph, graphUnheld, hmacHex, metaBusy, metaHeld, useMetaState } from "../src/meta";
import type { Env } from "../src/setter";

// Meta's rate limits (RATE_LIMITED in src/meta.ts): one answer holds every call, shared through D1, and what was
// stopped waits instead of failing. Seen live 2026-11-27: code 4 on every call for 17 minutes under a viral reel.

const ME = "17840000000000001";
const LEAD = "990011";
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 27, 18, 0, 0);
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function makeEnv(): Env {
  return {
    DB: makeD1(),
    ANTHROPIC_API_KEY: "test",
    MANYCHAT_API_KEY: "",
    INBOUND_SECRET: "s",
    ADMIN_PASSWORD: "pw",
    REVIEW_PASSWORD: "rv",
    AI: {} as Ai,
    SKOOL_LINK: "https://www.skool.com/your-community/about",
    AUTOPILOT: "false",
    REPLY_DELAY_MIN_S: "60",
    REPLY_DELAY_MAX_S: "240",
    TRANSPORT: "meta",
    META_IG_APP_ID: "100000000000001",
    META_APP_SECRET: "appsecret",
    META_VERIFY_TOKEN: "vt",
  };
}

const LIMIT = { error: { message: "(#4) Application request limit reached", code: 4 } };
let limited: (text: string | undefined) => boolean = () => false;
let headers: Record<string, string> = {};
let calls: { url: string; text?: string }[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  limited = () => false;
  headers = {};
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, text: body?.message?.text });
      if (limited(body?.message?.text)) return Response.json(LIMIT, { status: 403, headers });
      if (url.endsWith("/me/messages")) return Response.json({ recipient_id: LEAD, message_id: `out-${calls.length}` }, { headers });
      if (url.includes("fields=name,username")) return Response.json({ username: "lead.handle", name: "Sam Lee" }, { headers });
      return Response.json({ success: true }, { headers });
    }),
  );
});
afterEach(() => {
  useMetaState(null, null, null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const send = (text: string) => graph("/me/messages", { method: "POST", headers: { Authorization: "Bearer IGAAtok", "Content-Type": "application/json" }, body: JSON.stringify({ recipient: { id: LEAD }, message: { text } }) });
const hold = async (d1: D1Database, kind = "ig") => JSON.parse((await db.getSetting(d1, "meta_hold")) ?? "{}")[kind] ?? null;

describe("Meta's rate limit", () => {
  it("holds every call once Meta answers one, for longer each time, and starts over once it lifts", async () => {
    const d1 = makeD1();
    useMetaState(d1, null, null);
    limited = () => true;
    await expect(send("a")).rejects.toThrow(/instagram 403 code 4/);
    expect(metaHeld()).toBe(true);
    expect(await hold(d1)).toEqual({ until: T0 + 5 * MIN, strikes: 1 });
    await expect(send("b")).rejects.toThrow(/instagram 429 code 4: held by FewChat/);
    expect(calls).toHaveLength(1); // held: Meta isn't asked again

    vi.setSystemTime(T0 + 5 * MIN + 1);
    await expect(send("c")).rejects.toThrow(/code 4/);
    expect((await hold(d1)).until).toBe(T0 + 15 * MIN + 1); // 10 minutes the second time

    vi.setSystemTime(T0 + 16 * MIN);
    limited = () => false;
    await send("d");
    expect(await hold(d1)).toEqual({ until: 0, strikes: 0 });
    limited = () => true;
    await expect(send("e")).rejects.toThrow(/code 4/);
    expect((await hold(d1)).until).toBe(T0 + 21 * MIN); // back to 5

    // Meta's own estimate wins when it's longer.
    vi.setSystemTime(T0 + 22 * MIN);
    headers = { "x-business-use-case-usage": JSON.stringify({ "1784": [{ type: "instagram", call_count: 100, total_cputime: 30, total_time: 40, estimated_time_to_regain_access: 30 }] }) };
    await expect(send("f")).rejects.toThrow(/code 4/);
    expect((await hold(d1)).until).toBe(T0 + 52 * MIN);
  });

  it("a burst already on its way is one strike; each login has its own hold; logging in never waits", async () => {
    const d1 = makeD1();
    useMetaState(d1, null, null, "IGAAtok");
    limited = () => true;
    await Promise.all([send("a"), send("b"), send("c")].map((p) => p.catch(() => {})));
    expect(await hold(d1)).toEqual({ until: T0 + 5 * MIN, strikes: 1 });
    // The other login (another Meta app, another budget) isn't held by this one.
    limited = () => false;
    await graph("/me/messages", { method: "POST", headers: { Authorization: "Bearer EAAother" }, body: "{}" });
    await expect(send("d")).rejects.toThrow(/held by FewChat/);
    // Connecting or signing in goes through regardless.
    await graphUnheld("/me?fields=user_id", { headers: { Authorization: "Bearer IGAAtok" } });
  });

  it("an isolate never shortens or clears a hold another one wrote", async () => {
    const d1 = makeD1();
    await db.setSetting(d1, "meta_hold", JSON.stringify({ ig: { until: T0 + 40 * MIN, strikes: 3 } }));
    useMetaState(d1, null, null, "IGAAtok"); // this isolate read it before the other one wrote
    limited = () => true;
    await expect(send("a")).rejects.toThrow(/code 4/);
    expect(await hold(d1)).toEqual({ until: T0 + 40 * MIN, strikes: 3 }); // its 5 minutes didn't overwrite the 40
    vi.setSystemTime(T0 + 6 * MIN);
    limited = () => false;
    await send("b"); // this isolate's hold is over and a call works: the other one's 40 minutes still stand
    expect(await hold(d1)).toEqual({ until: T0 + 40 * MIN, strikes: 3 });
  });

  it("the private-replies cap worded as code 4 (subcode 2534040) holds nothing else", async () => {
    useMetaState(makeD1(), null, null);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { message: "(#4) Application request limit reached", code: 4, error_subcode: 2534040 } }, { status: 403 }));
    await expect(send("a")).rejects.toThrow(/code 4/);
    expect(metaHeld()).toBe(false);
    await send("b");
  });

  it("every isolate waits: the hold comes from D1 with each request", async () => {
    const env = makeEnv();
    await db.setSetting(env.DB, "ig_token", "IGAAtok");
    await db.setSetting(env.DB, "meta_hold", JSON.stringify({ ig: { until: T0 + 3 * MIN, strikes: 1 } }));
    await worker.fetch(new Request("https://x/privacy"), env, ctx); // any request loads it
    expect(metaHeld()).toBe(true);
    await expect(send("x")).rejects.toThrow(/held by FewChat/);
    expect(calls).toHaveLength(0);
  });

  it("reads Meta's usage headers: past 75% the cron's optional calls wait", async () => {
    const d1 = makeD1();
    useMetaState(d1, null, null);
    headers = { "x-app-usage": JSON.stringify({ call_count: 40, total_time: 12, total_cputime: 9 }) };
    await send("a");
    expect(metaBusy()).toBe(false);
    headers = { "x-app-usage": JSON.stringify({ call_count: 81, total_time: 12, total_cputime: 9 }) };
    await send("b");
    expect(metaBusy()).toBe(true);
    expect(JSON.parse((await db.getSetting(d1, "meta_usage"))!)).toEqual({ pct: 81, at: T0 });
    headers = {};
    await send("c"); // no reading: the last one stands
    expect(metaBusy()).toBe(true);
    vi.setSystemTime(T0 + 6 * MIN);
    expect(metaBusy()).toBe(false); // a reading that old says nothing
  });

  it("a flow message the limit stops waits, then goes on from that message, once, even if they wrote meanwhile", async () => {
    const env = makeEnv();
    await db.setSetting(env.DB, "ig_token", "IGAAtok");
    const id = (
      await env.DB.prepare(`INSERT INTO triggers (source, keyword, dm, created_at) VALUES ('dm', 'guide', 'one', 0) RETURNING id`).first<{ id: number }>()
    )!.id;
    await env.DB.prepare(`INSERT INTO flow_steps (trigger_id, position, kind, text) VALUES (?1, 0, 'message', 'two'), (?1, 1, 'message', 'three')`).bind(id).run();
    const dm = async (mid: string, text: string) => {
      const body = JSON.stringify({ object: "instagram", entry: [{ id: ME, time: 1, messaging: [{ sender: { id: LEAD }, recipient: { id: ME }, timestamp: Date.now(), message: { mid, text } }] }] });
      return worker.fetch(new Request("https://x/meta", { method: "POST", body, headers: { "X-Hub-Signature-256": `sha256=${await hmacHex("appsecret", body)}` } }), env, ctx);
    };
    const texts = () => calls.filter((c) => c.url.endsWith("/me/messages")).map((c) => c.text);

    limited = (t) => t === "two";
    await dm("m1", "send the guide");
    expect(texts()).toEqual(["one", "two"]);
    const parked = await env.DB.prepare(`SELECT node_id, run_at, status FROM flow_runs`).all<{ node_id: string; run_at: number; status: string }>();
    expect(parked.results).toHaveLength(1);
    expect(parked.results[0].node_id).toMatch(/^rl:0:/);
    expect(parked.results[0].run_at).toBeGreaterThanOrEqual(T0 + 5 * MIN);

    limited = () => false;
    await dm("m2", "?? where is it");
    await runDueFlows(env, Date.now()); // still held
    expect(texts()).toEqual(["one", "two"]);

    vi.setSystemTime(T0 + 7 * MIN);
    await runDueFlows(env, Date.now());
    await runDueFlows(env, Date.now()); // claimed once
    expect(texts()).toEqual(["one", "two", "two", "three"]);
    const bots = await env.DB.prepare(`SELECT text FROM messages WHERE role = 'bot' ORDER BY id`).all<{ text: string }>();
    expect(bots.results.map((m) => m.text)).toEqual(["one", "two", "three"]);
  });
});
