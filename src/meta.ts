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
  const p = payload as { object?: string; entry?: { messaging?: { message?: RawMessaging["message"] & { reply_to?: { story?: { url?: string; id?: string } } } }[] }[] };
  if (p?.object !== "instagram" || !Array.isArray(p.entry)) return out;
  for (const entry of p.entry) {
    for (const ev of entry.messaging ?? []) {
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
  const p = payload as { object?: string; entry?: { messaging?: RawMessaging[] }[] };
  if (p?.object !== "instagram" || !Array.isArray(p.entry)) return out;
  for (const entry of p.entry) {
    for (const ev of entry.messaging ?? []) {
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
    entry?: {
      id?: string;
      messaging?: {
        sender?: { id?: string };
        message?: { mid?: string; is_deleted?: boolean };
        reaction?: { mid?: string; action?: string; emoji?: string };
        message_edit?: { mid?: string; text?: string };
      }[];
    }[];
  };
  if (p?.object !== "instagram" || !Array.isArray(p.entry)) return [];
  const out: MessageUpdate[] = [];
  for (const entry of p.entry) {
    for (const ev of entry.messaging ?? []) {
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
  const p = payload as { object?: string; entry?: { id?: string; messaging?: RawMessaging[] }[] };
  if (p?.object !== "instagram" || !Array.isArray(p.entry)) return [];
  const events: MetaEvent[] = [];
  for (const entry of p.entry) {
    for (const ev of entry.messaging ?? []) {
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

export async function graph<T>(path: string, init?: RequestInit): Promise<T> {
  // The host follows the call's own token (the Authorization header, or access_token in the query); paging links come
  // back as full URLs on either host; "/me" is the account under Unified login.
  const token = new Headers(init?.headers).get("Authorization")?.replace(/^Bearer /, "") ?? new URL(path, "https://x").searchParams.get("access_token");
  const unified = unifiedToken(token);
  const rel = path.replace(/^https:\/\/graph\.(instagram|facebook)\.com\/v[\d.]+/, "").replace(/^\/me(?=[/?]|$)/, unified && account ? `/${account}` : "/me");
  const res = await fetch(`${unified ? FB_GRAPH : IG_GRAPH}${rel}`, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number } };
  if (!res.ok || body.error) throw new Error(`instagram ${res.status}${body.error?.code ? ` code ${body.error.code}` : ""}: ${body.error?.message ?? "request failed"}`);
  return body;
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

export async function subscribe(token: string): Promise<void> {
  await graph(`/me/subscribed_apps?${new URLSearchParams({ subscribed_fields: "messages,messaging_postbacks,messaging_seen,comments,live_comments", access_token: token })}`, { method: "POST" });
}

// The other login's subscription, once the account has moved: its app stops delivering (until then src/index.ts ignores it).
export async function unsubscribe(token: string): Promise<void> {
  await graph(`/me/subscribed_apps?${new URLSearchParams({ access_token: token })}`, { method: "DELETE" });
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
