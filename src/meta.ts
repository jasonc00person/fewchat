// Official Instagram API transport: webhooks in, Send API out, OAuth for the token. App: FewChat (its id in META_IG_APP_ID).
//
// Two logins reach the same API. Instagram Login (business login; apps set up before Meta closed it to new apps in late
// October 2026): graph.instagram.com, and the account is "me". Unified login (every app created since, switched on by
// META_LOGIN_CONFIG_ID): a Facebook Login for Business configuration hands out a business system-user token that only
// works on graph.facebook.com, with the account's own id in place of "me". Same paths otherwise. Every call goes through
// graph(), which goes by the token it carries: so moving an install from one login to the other is one moment, storing
// the new token, and a request already running on the old one finishes on it.

import type { MessageUpdate, Part } from "./attachments";

const IG_GRAPH = "https://graph.instagram.com/v26.0";
const FB_GRAPH = "https://graph.facebook.com/v26.0";
export const SCOPES = "instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments";

// Unified login's tokens are Facebook ones ("EAA..."); Instagram Login's start "IG". Checked on both live tokens 2026-11-27.
export const unifiedToken = (token: string | null | undefined): boolean => Boolean(token?.startsWith("EAA"));

// The account's own id, which a Unified login token uses in place of "me" (the same id under both logins). One account
// per install: every entry point sets it (src/index.ts) before any call.
let account: string | null = null;
export function useAccount(id: string | null): void {
  account = id;
}

// The other login's token (ig_token_previous, set with the account): for up to a day after a switch, threads the old
// app took are still its own and refuse the new app's messages ("not the thread owner", subcode 2534037), while the
// old app can still answer in them. graph() sends a refused message once more on it. Null on an install that never moved.
let other: string | null = null;
export function useOtherToken(token: string | null): void {
  other = token;
}
const NOT_OWNER = /not the thread owner/i;

// Meta's rate limits. Code 4 is the app's own ("Application request limit reached"), 17 a user's, 32 a Page's,
// 80002 / 80006 the Instagram / Messenger account budget. Once one answers, every call fails until it lifts, and each
// failed try still counts. So the first one holds every call on that login for a while (Meta's own estimate when it
// gives one, else 5 minutes doubling to an hour), shared through D1 setting `meta_hold` so every isolate waits, and
// callers treat the held call like the real error: comments queue, flow messages park until it lifts (src/flows.ts),
// the cron's background calls stand down. Seen 2026-11-27: the Unified app answered code 4 to everything for 17
// minutes under a viral reel. 613 (the 750 private replies an hour) is one endpoint's cap, not this: the comment queue
// paces it. Each login is its own Meta app with its own budget, so each has its own hold ("ig" / "fb", by token).
export const RATE_LIMITED = /instagram \d+ code (4|17|32|80002|80006):/;
const HOLD_MS = 5 * 60_000;
const MAX_HOLD_MS = 60 * 60_000;
// Meta's usage headers say how much of the budget the last hour used (percent). Past BUSY the cron's optional calls
// (profile pictures, the missed-message sync, comment backfill, broadcasts) wait, so what's left goes to replies.
export const BUSY_PCT = 75;
type Kind = "ig" | "fb";
type Hold = { until: number; strikes: number };
const kindOf = (token: string | null | undefined): Kind => (unifiedToken(token) ? "fb" : "ig");
let store: D1Database | null = null;
let inUse: Kind = "ig";
const holds: Record<Kind, Hold> = { ig: { until: 0, strikes: 0 }, fb: { until: 0, strikes: 0 } };
const setAt: Record<Kind, number> = { ig: 0, fb: 0 };
let usage = { pct: 0, at: 0 };
let usageSaved = 0;
// Every entry point (src/index.ts login) with what D1 has. A hold this isolate set in the last few seconds that D1
// doesn't show yet (its write still on the way, or lost to a database blip) stands; past that D1 is the truth, so
// editing or deleting meta_hold frees every isolate.
const OWN_HOLD_MS = 10_000;
export function useMetaState(d1: D1Database | null, hold: string | null | undefined, saved: string | null | undefined, token?: string | null): void {
  store = d1;
  inUse = kindOf(token);
  const h = parse<Partial<Record<Kind, Partial<Hold>>>>(hold) ?? {};
  const now = Date.now();
  for (const k of ["ig", "fb"] as const) {
    const d = { until: Number(h[k]?.until) || 0, strikes: Number(h[k]?.strikes) || 0 };
    holds[k] = d1 && now - setAt[k] < OWN_HOLD_MS && holds[k].until > d.until ? holds[k] : d;
  }
  const u = parse<{ pct?: number; at?: number }>(saved);
  usage = { pct: u?.pct ?? 0, at: u?.at ?? 0 };
  usageSaved = usage.at; // so a busy reading is written about once a minute across isolates, not once per request
}
const parse = <T>(s: string | null | undefined): T | null => {
  try {
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
};
// The login in use is held.
export const metaHeld = (now = Date.now()) => holds[inUse].until > now;
// When every hold is over: where a stopped message waits till (a thread the other login's app owns needs that one).
export const metaHeldUntil = () => Math.max(holds.ig.until, holds.fb.until);
// Held, or the budget was past BUSY_PCT within the last 5 minutes.
export const metaBusy = (now = Date.now()) => metaHeld(now) || (usage.pct >= BUSY_PCT && now - usage.at < 5 * 60_000);
export const metaUsage = () => ({ ...usage });

const saveSetting = (key: string, value: string) =>
  store?.prepare(`INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(key, value).run().catch(() => {});

// meta_hold is {"ig":{until,strikes},"fb":{...}}: each write touches its own login's part, and never shortens a hold
// another isolate wrote, nor clears one that hasn't run out.
const HOLD_JSON = `CASE WHEN json_valid(settings.value) AND json_type(settings.value) = 'object' THEN settings.value ELSE '{}' END`;
const saveHold = (k: Kind, h: Hold) =>
  store
    ?.prepare(
      `INSERT INTO settings (key, value) VALUES ('meta_hold', json_object(?1, json(?2)))
       ON CONFLICT (key) DO UPDATE SET value = json_set(${HOLD_JSON}, '$.' || ?1, json(?2))
       WHERE COALESCE(json_extract(${HOLD_JSON}, '$.' || ?1 || '.until'), 0) < ?3`,
    )
    .bind(k, JSON.stringify(h), h.until)
    .run()
    .catch(() => {});
const clearHold = (k: Kind, now: number) =>
  store
    ?.prepare(`UPDATE settings SET value = json_set(${HOLD_JSON}, '$.' || ?1, json('{"until":0,"strikes":0}')) WHERE key = 'meta_hold' AND COALESCE(json_extract(${HOLD_JSON}, '$.' || ?1 || '.until'), 0) <= ?2`)
    .bind(k, now)
    .run()
    .catch(() => {});

// X-App-Usage: {"call_count":n,"total_time":n,"total_cputime":n}; X-Business-Use-Case-Usage: {"<id>":[{"type":...,
// "call_count":n,...,"estimated_time_to_regain_access":minutes}]}. Both percent. The highest number is what's left.
export function readUsage(h: Headers): { pct: number; eta: number; seen: boolean } {
  let pct = 0;
  let eta = 0;
  let seen = false;
  const take = (u: { call_count?: number; total_time?: number; total_cputime?: number; estimated_time_to_regain_access?: number } | null | undefined) => {
    if (!u || typeof u !== "object") return;
    seen = true;
    pct = Math.max(pct, Number(u.call_count) || 0, Number(u.total_time) || 0, Number(u.total_cputime) || 0);
    eta = Math.max(eta, Number(u.estimated_time_to_regain_access) || 0);
  };
  take(parse(h.get("x-app-usage")));
  for (const list of Object.values(parse<Record<string, unknown>>(h.get("x-business-use-case-usage")) ?? {})) for (const u of Array.isArray(list) ? list : []) take(u);
  return { pct, eta, seen };
}

async function noteUsage(h: Headers, now: number): Promise<number> {
  const { pct, eta, seen } = readUsage(h);
  if (seen) usage = { pct, at: now };
  if (pct >= BUSY_PCT && now - usageSaved > 60_000) {
    usageSaved = now;
    await saveSetting("meta_usage", JSON.stringify(usage));
  }
  return eta;
}

// A burst of calls that were already on their way when the limit hit is one strike, not one each.
async function hold(k: Kind, now: number, etaMin: number): Promise<void> {
  const h = holds[k];
  const strikes = h.until > now ? h.strikes : h.strikes + 1;
  const until = Math.max(h.until, now + Math.max(etaMin * 60_000, Math.min(HOLD_MS * 2 ** (strikes - 1), MAX_HOLD_MS)));
  holds[k] = { until, strikes };
  setAt[k] = now;
  await saveHold(k, holds[k]);
}

// A message id's "<account>:<thread>:<item>". The two logins give the same message different ids (Instagram Login's
// decode to "ig_d...", Unified login's to "new_ig_dm_..."), but both carry these three numbers in their base64, at an
// offset. So this is what finds a message by an id from either (messages.mkey). Null for anything else ("pb:" taps,
// test ids). Checked 2026-11-27 on @yourhandle's threads: 5 of 5 the same through both logins.
export function midKey(mid: string | null | undefined): string | null {
  if (!mid || mid.includes(":")) return null;
  const s = mid.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  for (let k = 0; k < 4; k++) {
    // Pad the last group rather than drop it: the item number can run to the very end.
    const part = s.slice(k);
    const r = part.length % 4;
    try {
      const t = atob(r === 1 ? part.slice(0, -1) : part + "=".repeat((4 - r) % 4)).match(/\d{10,}:\d{25,}:\d{10,}/);
      if (t) return t[0];
    } catch {
      // not base64 at this offset
    }
  }
  return null;
}

// A message id from the other login than the token's (from before a switch, or after a rollback): Instagram can't take
// it back (reading an Instagram Login id with a Unified token answers code 1), so a reaction or a reply quote that names
// it can't be sent. Instagram Login ids are base64 of "ig_d...", Unified login's of "new_ig_dm_...".
export const otherLoginMid = (mid: string, token: string | null | undefined) => mid.startsWith(unifiedToken(token) ? "aWdfZA" : "bmV3X2lnX2RtX");

// Conversation Routing: an app that doesn't own a thread gets its events under entry.standby, same shape, instead of
// entry.messaging. Under Unified login that's every thread another app took in the last 24h (Manychat's flows, and for a
// day after a switch the old login's app); Instagram Login delivers everything on messaging. Each app gets an event on
// one of the two, so reading both counts nothing twice. Seen live 2026-11-27: taps and DMs in threads the old app owned
// never reached the new app until it subscribed to standby.
export type Routed<T> = { messaging?: T[]; standby?: T[] };
export const messagingOf = <T>(entry: Routed<T>): T[] => [...(entry.messaging ?? []), ...(entry.standby ?? [])];

export async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// X-Hub-Signature-256: "sha256=<hex>" over the raw body with the app secret.
export async function verifySignature(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = await hmacHex(secret, body);
  const got = header.slice(7);
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

// signed_request on the deauthorize and data-deletion callbacks: "<sig>.<payload>", HMAC-SHA256 of the payload.
export async function parseSignedRequest(secret: string, sr: string | null): Promise<{ user_id: string } | null> {
  const [sig, payload] = (sr ?? "").split(".");
  if (!secret || !sig || !payload) return null;
  try {
    const expected = await hmacHex(secret, payload);
    const got = [...b64url(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (got !== expected) return null;
    const data = JSON.parse(new TextDecoder().decode(b64url(payload))) as { user_id?: string | number };
    return data.user_id ? { user_id: String(data.user_id) } : null;
  } catch {
    return null; // not base64 / not JSON
  }
}

export interface MetaEvent {
  kind: "inbound" | "echo";
  lead_id: string; // IGSID of the other person
  mid: string;
  text: string;
  at: number;
  attachments: { type: string; url: string | null }[]; // media URLs (signed, short-lived): read them right away
  parts: Part[]; // the same, as structure (src/attachments.ts), for src/media.ts to read
  app_id: string | null; // set on echoes when an app sent the message (unverified on Instagram; see autonomy.ts)
}

interface RawMessaging {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    is_deleted?: boolean;
    is_unsupported?: boolean;
    app_id?: string | number;
    attachments?: { type?: string; payload?: { url?: string } }[];
    reply_to?: { story?: unknown; mid?: string };
  };
}

const TAGS: Record<string, string> = {
  audio: "[voice note]",
  image: "[image]",
  media: "[image]",
  video: "[video]",
  file: "[file]",
  share: "[shared a post]",
  ig_post: "[shared a post]",
  ig_reel: "[shared a reel]",
  reel: "[shared a reel]",
  story_mention: "[mentioned you in their story]",
  ig_story: "[shared a story]",
  story: "[shared a story]",
  like_heart: "[sent a heart]",
};

function describe(m: NonNullable<RawMessaging["message"]>): string {
  const parts: string[] = [];
  if (m.reply_to?.story) parts.push("[replying to your story]");
  for (const a of dedupeShares(m.attachments ?? [])) {
    const t = a.type ?? "attachment";
    parts.push(TAGS[t] ?? `[${t}]`);
  }
  if (m.text) parts.push(m.text);
  return parts.join(" ").trim();
}

type RawAttachment = { type?: string; payload?: { url?: string; title?: string; ig_post_media_id?: string; reel_video_id?: string; sticker_id?: string | number; name?: string } };

// Nov 2025 - Feb 2026 a shared post came as both "share" and "ig_post": one post, not two.
function dedupeShares<T extends RawAttachment>(atts: T[]): T[] {
  const posts = new Set(atts.filter((a) => a.type === "ig_post").map((a) => a.payload?.ig_post_media_id ?? ""));
  return atts.filter((a) => a.type !== "share" || !posts.has(a.payload?.ig_post_media_id ?? ""));
}

// What a webhook message is made of, as structure for messages.attachments (src/attachments.ts renders it).
export function webhookParts(m: { reply_to?: { story?: { url?: string; id?: string } }; attachments?: RawAttachment[]; is_unsupported?: boolean }): Part[] {
  const out: Part[] = [];
  if (m.reply_to?.story) out.push({ type: "story_reply", url: m.reply_to.story.url ?? null, id: m.reply_to.story.id ?? null });
  for (const a of dedupeShares(m.attachments ?? [])) {
    const p = a.payload ?? {};
    const url = p.url ?? null;
    switch (a.type) {
      case "image":
      case "media":
        out.push({ type: p.sticker_id ? "sticker" : "image", url });
        break;
      case "video":
      case "audio":
        out.push({ type: a.type, url });
        break;
      case "file":
        out.push({ type: "file", url, title: p.name ?? null });
        break;
      case "share":
      case "ig_post":
        out.push({ type: "post", url, id: p.ig_post_media_id ?? null, title: p.title ?? null });
        break;
      case "ig_reel":
      case "reel":
        out.push({ type: "reel", url, id: p.reel_video_id ?? null, title: p.title ?? null });
        break;
      case "story_mention":
        out.push({ type: "story_mention", url });
        break;
      case "ig_story":
      case "story":
        out.push({ type: "story_share", url });
        break;
      case "like_heart":
        out.push({ type: "like" });
        break;
      case "template":
      case "fallback":
        break; // our own buttons: the thread already has them as text
      default:
        out.push({ type: "unsupported", url });
    }
  }
  if (m.is_unsupported && !out.length) out.push({ type: "unsupported" });
  return out;
}

// mid -> parts for every message in a webhook payload that has any.
export function parseParts(payload: unknown): Map<string, Part[]> {
  const out = new Map<string, Part[]>();
  const p = payload as { object?: string; entry?: Routed<{ message?: RawMessaging["message"] & { reply_to?: { story?: { url?: string; id?: string } } } }>[] };
  if (p?.object !== "instagram" || !Array.isArray(p.entry)) return out;
  for (const entry of p.entry) {
    for (const ev of messagingOf(entry)) {
      const m = ev.message;
      if (!m?.mid || m.is_deleted) continue;
      const parts = webhookParts(m);
      if (parts.length) out.set(m.mid, parts);
    }
  }
  return out;
}

// mid -> the mid it replies to (swipe-to-reply), for theirs and for echoes of ours. Only the webhook says this: reading
// a message back through the API has no reply field, so it's saved now or never.
export function parseReplies(payload: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const p = payload as { object?: string; entry?: Routed<RawMessaging>[] };
  if (p?.object !== "instagram" || !Array.isArray(p.entry)) return out;
  for (const entry of p.entry) {
    for (const ev of messagingOf(entry)) {
      const m = ev.message;
      const to = m?.reply_to?.mid;
      if (m?.mid && !m.is_deleted && typeof to === "string" && to && to !== m.mid) out.set(m.mid, to);
    }
  }
  return out;
}

// Reactions, edits and unsends: small updates to a message we already have.
export function parseMessageUpdates(payload: unknown): MessageUpdate[] {
  const p = payload as {
    object?: string;
    entry?: (Routed<{
      sender?: { id?: string };
      message?: { mid?: string; is_deleted?: boolean };
      reaction?: { mid?: string; action?: string; emoji?: string };
      message_edit?: { mid?: string; text?: string };
    }> & { id?: string })[];
  };
  if (p?.object !== "instagram" || !Array.isArray(p.entry)) return [];
  const out: MessageUpdate[] = [];
  for (const entry of p.entry) {
    for (const ev of messagingOf(entry)) {
      if (ev.reaction?.mid) {
        const who = ev.sender?.id && ev.sender.id === entry.id ? "you" : "lead";
        out.push({ kind: "reaction", mid: ev.reaction.mid, who, emoji: ev.reaction.action === "unreact" ? null : asEmoji(ev.reaction.emoji ?? "\u2764") });
      }
      if (ev.message_edit?.mid && typeof ev.message_edit.text === "string") out.push({ kind: "edit", mid: ev.message_edit.mid, text: ev.message_edit.text });
      if (ev.message?.mid && ev.message.is_deleted) out.push({ kind: "unsend", mid: ev.message.mid });
    }
  }
  return out;
}

export function parseWebhook(payload: unknown): MetaEvent[] {
  const p = payload as { object?: string; entry?: (Routed<RawMessaging> & { id?: string })[] };
  if (p?.object !== "instagram" || !Array.isArray(p.entry)) return [];
  const events: MetaEvent[] = [];
  for (const entry of p.entry) {
    for (const ev of messagingOf(entry)) {
      const m = ev.message;
      if (!m?.mid || m.is_deleted || m.is_unsupported) continue;
      const text = describe(m);
      if (!text) continue;
      const echo = Boolean(m.is_echo);
      const lead_id = echo ? ev.recipient?.id : ev.sender?.id;
      if (!lead_id || lead_id === entry.id) continue;
      events.push({
        kind: echo ? "echo" : "inbound",
        lead_id,
        mid: m.mid,
        text,
        at: ev.timestamp ?? Date.now(),
        attachments: (m.attachments ?? []).map((a) => ({ type: a.type ?? "attachment", url: a.payload?.url ?? null })),
        parts: webhookParts(m as Parameters<typeof webhookParts>[0]),
        app_id: m.app_id ? String(m.app_id) : null,
      });
    }
  }
  return events;
}

export interface MetaComment {
  comment_id: string;
  lead_id: string; // commenter's IGSID
  username: string | null;
  media_id: string | null;
  text: string;
}

interface RawChange {
  field?: string;
  value?: { id?: string; comment_id?: string; text?: string; from?: { id?: string; username?: string }; media?: { id?: string } };
}

// "comments" and "live_comments" webhook changes. Skips the account's own comments (including our public replies).
export function parseComments(payload: unknown): MetaComment[] {
  const p = payload as { object?: string; entry?: { id?: string; changes?: RawChange[] }[] };
  if (p?.object !== "instagram" || !Array.isArray(p.entry)) return [];
  const out: MetaComment[] = [];
  for (const entry of p.entry) {
    for (const ch of entry.changes ?? []) {
      const v = ch.value;
      const id = v?.id ?? v?.comment_id; // Unified login's payload calls it comment_id
      if ((ch.field !== "comments" && ch.field !== "live_comments") || !id || !v?.from?.id || !v.text) continue;
      if (v.from.id === entry.id) continue;
      out.push({ comment_id: id, lead_id: v.from.id, username: v.from.username ?? null, media_id: v.media?.id ?? null, text: v.text });
    }
  }
  return out;
}

export const graph = <T>(path: string, init?: RequestInit): Promise<T> => call<T>(path, init, false);
// Logging in and connecting: never waits on the hold (signing in, or going back to the other login, mid-limit).
export const graphUnheld = <T>(path: string, init?: RequestInit): Promise<T> => call<T>(path, init, true);

async function call<T>(path: string, init: RequestInit | undefined, unheld: boolean): Promise<T> {
  // The host follows the call's own token (the Authorization header, or access_token in the query); paging links come
  // back as full URLs on either host; "/me" is the account under Unified login.
  const token = new Headers(init?.headers).get("Authorization")?.replace(/^Bearer /, "") ?? new URL(path, "https://x").searchParams.get("access_token");
  const unified = unifiedToken(token);
  const k = kindOf(token);
  const rel = path.replace(/^https:\/\/graph\.(instagram|facebook)\.com\/v[\d.]+/, "").replace(/^\/me(?=[/?]|$)/, unified && account ? `/${account}` : "/me");
  const now = Date.now();
  if (!unheld && holds[k].until > now) throw new Error(`instagram 429 code 4: held by FewChat until ${new Date(holds[k].until).toISOString()} (Meta's rate limit)`);
  const res = await fetch(`${unified ? FB_GRAPH : IG_GRAPH}${rel}`, init);
  const eta = k === inUse ? await noteUsage(res.headers, now) : readUsage(res.headers).eta;
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number; error_subcode?: number } };
  if (res.ok && !body.error && holds[k].strikes && holds[k].until <= now) {
    holds[k] = { until: 0, strikes: 0 }; // it lifted: the next limit starts over at 5 minutes
    await clearHold(k, now);
  }
  if (!res.ok || body.error) {
    const err = new Error(`instagram ${res.status}${body.error?.code ? ` code ${body.error.code}` : ""}: ${body.error?.message ?? "request failed"}`);
    // 2534040 = the private-replies cap, which Meta sometimes words as code 4: only comment DMs wait for that one.
    if (RATE_LIMITED.test(err.message) && body.error?.error_subcode !== 2534040) await hold(k, now, eta);
    if (other && token && other !== token && NOT_OWNER.test(err.message) && /^\/me\/messages(\?|$)/.test(path)) {
      // The other login's app owns this thread: the same message from it. A clean refusal there (it doesn't own the
      // thread either: Manychat does; or its token is gone) throws the first error, which callers act on (src/setter.ts
      // sends those through Manychat). Anything else (a timeout, a rate limit) may mean it went out: that error stands.
      try {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${other}`);
        return await call<T>(path, { ...init, headers, body: forOther(init?.body, other) }, unheld);
      } catch (e) {
        throw NOT_OWNER.test(String(e)) || / code 190:/.test(String(e)) ? err : e;
      }
    }
    throw err;
  }
  return body;
}

// A reply quote can only name a message by the sending login's own id.
function forOther(body: RequestInit["body"], token: string): RequestInit["body"] {
  if (typeof body !== "string") return body;
  try {
    const j = JSON.parse(body) as { reply_to?: { mid?: string } };
    if (!j.reply_to?.mid || !otherLoginMid(j.reply_to.mid, token)) return body;
    delete j.reply_to;
    return JSON.stringify(j);
  } catch {
    return body;
  }
}

// `replyTo` quotes one of the thread's messages above the text, like swiping to reply in the app.
export async function sendText(token: string, leadId: string, text: string, replyTo?: string): Promise<string> {
  const body = await graph<{ message_id: string }>("/me/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: leadId }, message: { text }, ...(replyTo && !otherLoginMid(replyTo, token) ? { reply_to: { mid: replyTo } } : {}) }),
  });
  return body.message_id;
}

// "Seen" and the typing dots on the lead's side. Typing turns itself off when the message lands.
export async function senderAction(token: string, leadId: string, action: "mark_seen" | "typing_on" | "typing_off"): Promise<void> {
  await graph("/me/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: leadId }, sender_action: action }),
  });
}

// React to a message with any emoji, or take our reaction off (emoji null).
export async function react(token: string, leadId: string, mid: string, emoji: string | null): Promise<void> {
  if (otherLoginMid(mid, token)) throw new Error("Instagram can't react to a message from the other login (before a switch, or after going back)");
  await graph("/me/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: leadId },
      sender_action: emoji ? "react" : "unreact",
      payload: emoji ? { message_id: mid, reaction: emoji } : { message_id: mid },
    }),
  });
}

// Private reply: a DM to whoever left the comment. One per comment, within 7 days of it.
export async function privateReply(token: string, commentId: string, text: string): Promise<{ lead_id: string; mid: string }> {
  const body = await graph<{ recipient_id: string; message_id: string }>("/me/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text } }),
  });
  return { lead_id: body.recipient_id, mid: body.message_id };
}

export async function replyToComment(token: string, commentId: string, text: string): Promise<void> {
  await graph(`/${commentId}/replies?${new URLSearchParams({ message: text })}`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
}

export interface Media {
  id: string;
  caption?: string;
  permalink?: string;
  timestamp?: string;
  media_product_type?: string; // FEED | REELS | AD
}

export async function recentMedia(token: string, limit = 25): Promise<Media[]> {
  const q = new URLSearchParams({ fields: "id,caption,permalink,timestamp,media_product_type", limit: String(limit) });
  return (await graph<{ data: Media[] }>(`/me/media?${q}`, { headers: { Authorization: `Bearer ${token}` } })).data;
}

export interface Story {
  id: string; // the same id a story reply's webhook carries in reply_to.story.id
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string; // videos only
  timestamp?: string;
}

// Stories that are up right now (the last 24h), newest first: what a story-reply automation can be pinned to.
export async function recentStories(token: string): Promise<Story[]> {
  const q = new URLSearchParams({ fields: "id,media_type,media_url,thumbnail_url,timestamp" });
  return (await graph<{ data: Story[] }>(`/me/stories?${q}`, { headers: { Authorization: `Bearer ${token}` } })).data;
}

export async function fetchProfile(token: string, leadId: string): Promise<{ username: string | null; name: string | null; pic: string | null }> {
  try {
    const p = await graph<{ username?: string; name?: string; profile_pic?: string }>(`/${leadId}?fields=name,username,profile_pic`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { username: p.username ?? null, name: p.name ?? null, pic: p.profile_pic ?? null };
  } catch {
    return { username: null, name: null, pic: null };
  }
}

export interface Account {
  username?: string;
  name?: string;
  profile_picture_url?: string;
}

export async function fetchAccount(token: string): Promise<Account> {
  return graph<Account>(`/me?fields=username,name,profile_picture_url`, { headers: { Authorization: `Bearer ${token}` } });
}

// Unified login: the configuration carries the permissions and the account picker, so there's no scope here.
export function authorizeUrl(appId: string, redirectUri: string, state: string, configId?: string): string {
  if (configId) return `https://www.facebook.com/dialog/oauth?${new URLSearchParams({ client_id: appId, config_id: configId, redirect_uri: redirectUri, response_type: "code", state })}`;
  const q = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, response_type: "code", scope: SCOPES, state });
  return `https://www.instagram.com/oauth/authorize?${q}`;
}

// Unified login: the code gives the final token (it lasts as long as the configuration says; no refresh exists), and
// the token names no account: the ones the login granted are listed separately. That list comes back empty unless
// the configuration also has business_management.
export async function exchangeUnified(appId: string, secret: string, redirectUri: string, code: string): Promise<{ token: string; accounts: { id: string; username?: string }[] }> {
  const r = await fetch(`${FB_GRAPH}/oauth/access_token?${new URLSearchParams({ client_id: appId, client_secret: secret, redirect_uri: redirectUri, code })}`);
  const body = (await r.json().catch(() => ({}))) as { access_token?: string; error?: { message?: string } };
  if (!body.access_token) throw new Error(`oauth: ${body.error?.message ?? r.status}`);
  const a = await fetch(`${FB_GRAPH}/me/assigned_instagram_accounts?fields=id,username`, { headers: { Authorization: `Bearer ${body.access_token}` } });
  const list = (await a.json().catch(() => ({}))) as { data?: { id: string; username?: string }[]; error?: { message?: string } };
  if (!a.ok || list.error) throw new Error(`instagram accounts: ${list.error?.message ?? a.status}`);
  return { token: body.access_token, accounts: list.data ?? [] };
}

// code -> short-lived token -> 60-day token. Returns the long-lived token and the account's user id.
export async function exchangeCode(appId: string, secret: string, redirectUri: string, code: string): Promise<{ token: string; userId: string }> {
  const res = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    body: new URLSearchParams({ client_id: appId, client_secret: secret, grant_type: "authorization_code", redirect_uri: redirectUri, code }),
  });
  const short = (await res.json()) as { access_token?: string; user_id?: number | string; error_message?: string };
  if (!short.access_token) throw new Error(`oauth: ${short.error_message ?? res.status}`);
  const r = await fetch(
    `https://graph.instagram.com/access_token?${new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: secret, access_token: short.access_token })}`,
  );
  const long = (await r.json()) as { access_token?: string; error?: { message?: string } };
  if (!long.access_token) throw new Error(`long-lived token: ${long.error?.message ?? r.status}`);
  return { token: long.access_token, userId: String(short.user_id) };
}

export async function refreshToken(token: string): Promise<string> {
  const r = await fetch(`https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: token })}`);
  const body = (await r.json()) as { access_token?: string };
  if (!body.access_token) throw new Error(`token refresh failed: ${r.status}`);
  return body.access_token;
}

// Unified login adds standby: the events of threads another app owns (messagingOf).
export async function subscribe(token: string): Promise<void> {
  const fields = `messages,messaging_postbacks,messaging_seen,comments,live_comments${unifiedToken(token) ? ",standby" : ""}`;
  await graphUnheld(`/me/subscribed_apps?${new URLSearchParams({ subscribed_fields: fields, access_token: token })}`, { method: "POST" });
}

// The other login's app, once the account has moved: its taps. A tap goes to the app that owns the thread, which for a
// day is often the old one; src/index.ts takes the old app's taps and nothing else from it, so whatever else it stays
// subscribed to is acknowledged and dropped.
export async function subscribeTaps(token: string): Promise<void> {
  await graphUnheld(`/me/subscribed_apps?${new URLSearchParams({ subscribed_fields: "messaging_postbacks", access_token: token })}`, { method: "POST" });
}

// Unified login: was the Facebook Page the account is linked to shared at login? Without it Meta delivers comments but
// not DMs. The system user's own /me, not the account's (checked on a live token 2026-11-27: each Page with its
// instagram_business_account).
export async function pageShared(token: string, accountId: string): Promise<boolean> {
  const r = await fetch(`${FB_GRAPH}/me/assigned_pages?fields=instagram_business_account&limit=100`, { headers: { Authorization: `Bearer ${token}` } });
  const body = (await r.json().catch(() => ({}))) as { data?: { instagram_business_account?: { id?: string } }[] };
  return (body.data ?? []).some((p) => p.instagram_business_account?.id === accountId);
}

// Instagram sends a heart as a bare "❤" (U+2764), which browsers draw as a white text glyph. One pictograph without the
// emoji variation selector that defaults to text gets it (U+FE0F), so it shows as the red emoji like in the app.
export const asEmoji = (e: string) => (/^(?!\p{Emoji_Presentation})\p{Extended_Pictographic}$/u.test(e) ? `${e}\uFE0F` : e);
