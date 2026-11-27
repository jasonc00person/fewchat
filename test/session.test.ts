import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeD1 } from "./d1shim";
import * as db from "../src/db";
import worker from "../src/index";
import { hasSession, sessionCookie } from "../src/session";
import { graph, useLogin } from "../src/meta";
import type { Env } from "../src/setter";

const OWNER = "17840000000000001";
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function makeEnv(): Env {
  return {
    DB: makeD1(),
    AI: {} as Ai,
    ANTHROPIC_API_KEY: "test",
    MANYCHAT_API_KEY: "",
    INBOUND_SECRET: "s",
    ADMIN_PASSWORD: "pw",
    REVIEW_PASSWORD: "rv",
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

let meId = OWNER;
let meName = "";
let calls: string[] = [];
beforeEach(() => {
  meId = OWNER;
  meName = "";
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("api.instagram.com/oauth/access_token")) return Response.json({ access_token: "short", user_id: 33900000000000001 });
      if (url.includes("graph.instagram.com/access_token")) return Response.json({ access_token: "long" });
      if (url.includes("/me?fields=user_id")) return Response.json({ user_id: meId, username: meName });
      return Response.json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const cookieOf = (res: Response) => (res.headers.get("Set-Cookie") ?? "").split(";")[0];
const withCookie = (path: string, cookie: string) => new Request(`https://x${path}`, { headers: { Cookie: cookie } });

// Start a sign-in; returns a function that finishes it from the same browser (its own state cookie).
async function startLogin(env: Env) {
  const start = await worker.fetch(new Request("https://x/auth/login"), env, ctx);
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("Location")!).searchParams.get("state");
  const jar = cookieOf(start);
  return () => worker.fetch(new Request(`https://x/auth/callback?code=abc&state=${state}`, { headers: { Cookie: jar } }), env, ctx);
}
const loginFlow = async (env: Env) => (await startLogin(env))();

describe("log in with Instagram", () => {
  it("signs a cookie that opens the console, and rejects tampered or expired ones", async () => {
    const env = makeEnv();
    const c = (await sessionCookie(env, Date.now())).split(";")[0];
    expect(await hasSession(withCookie("/admin/dashboard", c), env)).toBe(true);
    expect(await hasSession(withCookie("/admin/dashboard", c.replace(/.$/, (x) => (x === "0" ? "1" : "0"))), env)).toBe(false);
    expect(await hasSession(withCookie("/admin/dashboard", c), env, Date.now() + 91 * 24 * 3600 * 1000)).toBe(false);
    expect((await worker.fetch(withCookie("/admin/dashboard", c), env, ctx)).status).toBe(200);
  });

  it("sends a visitor with no credentials to the login page; the password path still works", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://x/admin/inbox"), env, ctx);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://x/login");
    expect(await (await worker.fetch(new Request("https://x/login"), env, ctx)).text()).toContain("Log in with Instagram");
    expect((await worker.fetch(new Request("https://x/admin/password"), env, ctx)).status).toBe(401);
    const basic = new Request("https://x/admin/password", { headers: { Authorization: `Basic ${btoa("j:pw")}` } });
    expect((await worker.fetch(basic, env, ctx)).headers.get("Location")).toBe("https://x/admin/dashboard");
  });

  it("lets the owner in with a fresh token, and turns any other Instagram account away", async () => {
    const env = makeEnv();
    await db.setSetting(env.DB, "ig_account_id", OWNER);
    const ok = await loginFlow(env);
    expect(ok.status).toBe(303);
    expect(ok.headers.get("Location")).toBe("https://x/admin/dashboard");
    expect(await hasSession(withCookie("/admin", cookieOf(ok)), env)).toBe(true);
    expect(await db.getSetting(env.DB, "ig_token")).toBe("long");

    meId = "17841400000000000";
    const no = await loginFlow(env);
    expect(no.status).toBe(403);
    expect(no.headers.get("Set-Cookie")).not.toContain("dms_session="); // only the state cookie is cleared
    expect(await no.text()).toContain("the one this setter runs");
  });

  it("the first sign-in on a fresh install claims and connects it, and only the account it was set up for can", async () => {
    const env = makeEnv();
    // The handle this install was set up for, as the login page shows it.
    const handle = (await (await worker.fetch(new Request("https://x/login"), env, ctx)).text()).match(/name="username"[^>]*value="([^"]+)"/)![1];

    meName = "someone.else";
    const stranger = await loginFlow(env);
    expect(await stranger.text()).toContain(`set up for @${handle}`);
    expect(await db.getSetting(env.DB, "ig_account_id")).toBeNull();
    expect(await db.getSetting(env.DB, "ig_token")).toBeNull();

    meName = handle.toUpperCase(); // Instagram usernames aren't case-sensitive
    const owner = await loginFlow(env);
    expect(owner.status).toBe(303);
    expect(await hasSession(withCookie("/admin/dashboard", cookieOf(owner)), env)).toBe(true);
    expect(await db.getSetting(env.DB, "ig_account_id")).toBe(OWNER);
    expect(await db.getSetting(env.DB, "ig_token")).toBe("long");
    expect(await db.getSetting(env.DB, "ig_user_id")).toBeTruthy(); // connected, as /auth/start would
    expect(calls.some((u) => u.includes("/me/subscribed_apps"))).toBe(true); // DMs and comments now arrive
  });

  it("a forged state, or one from another browser, can't log anyone in, and shows the login page", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://x/auth/callback?code=abc&state=login:forged"), env, ctx);
    expect(res.status).toBe(403);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Set-Cookie")).not.toContain("dms_session=");
  });

  it("two sign-ins in flight at once (phone + laptop) both work", async () => {
    const env = makeEnv();
    await db.setSetting(env.DB, "ig_account_id", OWNER);
    const phone = await startLogin(env);
    const laptop = await startLogin(env);
    expect((await laptop()).headers.get("Set-Cookie")).toContain("dms_session=");
    expect((await phone()).headers.get("Set-Cookie")).toContain("dms_session=");
  });
});

describe("favicon", () => {
  it("every page carries the 📫 icon, and /favicon.ico serves it", async () => {
    const env = makeEnv();
    const login = await (await worker.fetch(new Request("https://x/login"), env, ctx)).text();
    expect(login).toContain('<link rel="icon" href="data:image/svg+xml,');
    expect(decodeURIComponent(login)).toContain("📫");
    const ico = await worker.fetch(new Request("https://x/favicon.ico"), env, ctx);
    expect(ico.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(await ico.text()).toContain("📫");
  });
});

describe("password form", () => {
  const form = (pw: string, ua = "Mozilla/5.0 (Macintosh)") =>
    new Request("https://x/login", { method: "POST", body: new URLSearchParams({ username: "yourhandle", password: pw }), headers: { "User-Agent": ua } });

  it("the right password sets the same 90-day cookie; a wrong one doesn't", async () => {
    const env = makeEnv();
    const ok = await worker.fetch(form("pw"), env, ctx);
    expect(ok.status).toBe(303);
    expect(ok.headers.get("Location")).toBe("https://x/admin/dashboard");
    expect(await hasSession(withCookie("/admin", cookieOf(ok)), env)).toBe(true);
    const no = await worker.fetch(form("nope"), env, ctx);
    expect(no.status).toBe(403);
    expect(no.headers.get("Set-Cookie")).toBeNull();
    expect(await no.text()).toContain("Wrong password");
  });

  it("phones only get the password form (Instagram's app hijacks its consent screen there)", async () => {
    const env = makeEnv();
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) CriOS/140.0";
    const phone = await (await worker.fetch(new Request("https://x/login", { headers: { "User-Agent": iphone } }), env, ctx)).text();
    expect(phone).toContain('autocomplete="current-password"');
    expect(phone).not.toContain("Log in with Instagram"); // nothing on a phone may open Instagram's app
    const hop = await worker.fetch(new Request("https://x/auth/login", { headers: { "User-Agent": iphone } }), env, ctx);
    expect(hop.headers.get("Location")).toBe("https://x/login");
    const desk = await (await worker.fetch(new Request("https://x/login"), env, ctx)).text();
    expect(desk.indexOf("Log in with Instagram")).toBeLessThan(desk.indexOf('autocomplete="current-password"'));
  });
});

describe("Unified login (Meta apps created since late October 2026)", () => {
  const ACCT = "17841499999999999";
  let accounts: { id: string; username?: string }[] = [];
  let handle = "";
  const unifiedEnv = (): Env => ({ ...makeEnv(), META_IG_APP_ID: "1234567890", META_LOGIN_CONFIG_ID: "cfg42" });
  beforeEach(async () => {
    handle = (await (await worker.fetch(new Request("https://x/login"), makeEnv(), ctx)).text()).match(/name="username"[^>]*value="([^"]+)"/)![1];
    accounts = [{ id: ACCT, username: handle }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes("graph.facebook.com/v26.0/oauth/access_token")) return Response.json({ access_token: "suat" });
        if (url.includes("graph.facebook.com/v26.0/me/assigned_instagram_accounts")) return Response.json({ data: accounts });
        return Response.json({});
      }),
    );
  });
  afterEach(() => useLogin(false, null));

  it("logs in through the configuration, claims the account it was set up for, and calls graph.facebook.com with its id", async () => {
    const env = unifiedEnv();
    const start = await worker.fetch(new Request("https://x/auth/login"), env, ctx);
    const to = new URL(start.headers.get("Location")!);
    expect(to.origin + to.pathname).toBe("https://www.facebook.com/dialog/oauth");
    expect(to.searchParams.get("config_id")).toBe("cfg42");
    expect(to.searchParams.get("client_id")).toBe("1234567890");
    expect(to.searchParams.get("scope")).toBeNull();

    const res = await loginFlow(env);
    expect(res.status).toBe(303);
    expect(await hasSession(withCookie("/admin/dashboard", cookieOf(res)), env)).toBe(true);
    expect(await db.getSetting(env.DB, "ig_account_id")).toBe(ACCT);
    expect(await db.getSetting(env.DB, "ig_token")).toBe("suat");
    expect(calls.some((u) => u.startsWith(`https://graph.facebook.com/v26.0/${ACCT}/subscribed_apps?`))).toBe(true);
    expect(calls.some((u) => u.includes("graph.instagram.com") || u.includes("api.instagram.com"))).toBe(false);

    // Later requests address the account by id on graph.facebook.com (the console refreshes its profile from /me).
    calls = [];
    await worker.fetch(withCookie("/admin/dashboard", cookieOf(res)), env, ctx);
    expect(calls.some((u) => u.startsWith(`https://graph.facebook.com/v26.0/${ACCT}?fields=`))).toBe(true);
    expect(calls.some((u) => u.includes("graph.instagram.com"))).toBe(false);
  });

  it("turns away a login that shares another account, or none, with a reason", async () => {
    const env = unifiedEnv();
    accounts = [{ id: "17841400000000001", username: "someone.else" }];
    expect(await (await loginFlow(env)).text()).toContain(`set up for @${handle}`);
    accounts = [];
    expect(await (await loginFlow(env)).text()).toContain("business_management");
    expect(await db.getSetting(env.DB, "ig_token")).toBeNull();
    // Once claimed, only that account gets in, even if the login also shares others.
    await db.setSetting(env.DB, "ig_account_id", ACCT);
    accounts = [{ id: "17841400000000001", username: handle }];
    expect(await (await loginFlow(env)).text()).toContain("the one this setter runs");
    accounts = [{ id: "17841400000000001" }, { id: ACCT }];
    expect((await loginFlow(env)).status).toBe(303);
  });

  it("an install without the configuration id stays on Instagram Login", async () => {
    const env = makeEnv();
    const start = await worker.fetch(new Request("https://x/auth/login"), env, ctx);
    expect(start.headers.get("Location")).toContain("https://www.instagram.com/oauth/authorize?");
  });
});

describe("graph()", () => {
  afterEach(() => useLogin(false, null));
  it("rewrites /me and paging links for Unified login, and leaves Instagram Login as it was", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (seen.push(url), Response.json({ ok: true }))));
    await graph("/me/messages", { method: "POST" });
    await graph("/me?fields=user_id");
    useLogin(true, "1784");
    await graph("/me/messages", { method: "POST" });
    await graph("/me?fields=username");
    await graph("/media123/comments?limit=50");
    await graph("https://graph.facebook.com/v26.0/1784/conversations?after=abc");
    await graph("/messenger_profile_x"); // only "/me" itself is the account, not anything that starts with it
    expect(seen).toEqual([
      "https://graph.instagram.com/v26.0/me/messages",
      "https://graph.instagram.com/v26.0/me?fields=user_id",
      "https://graph.facebook.com/v26.0/1784/messages",
      "https://graph.facebook.com/v26.0/1784?fields=username",
      "https://graph.facebook.com/v26.0/media123/comments?limit=50",
      "https://graph.facebook.com/v26.0/1784/conversations?after=abc",
      "https://graph.facebook.com/v26.0/messenger_profile_x",
    ]);
  });
});
