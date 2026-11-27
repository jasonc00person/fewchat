import { afterEach, describe, expect, it, vi } from "vitest";
import { makeD1 } from "./d1shim";
import { applyUpdate, threadLink } from "../src/attachments";
import * as db from "../src/db";
import { handleRead } from "../src/flows";
import { midKey, react, sendText } from "../src/meta";
import { groupId } from "../src/sync";

// Instagram glues base64 chunks together, so the numbers sit at an offset. Same shape here, made-up numbers.
const b64 = (s: string) => Buffer.from(s, "latin1").toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const KEY = "17841400000000001:340282366841710300000000000000000000042:33126198863773447199684586547183616";
const oldMid = (k = KEY) => b64("ig_d") + b64("\x01\xb5}item:1:IGMessageID:" + k); // Instagram Login: "aWdfZA..."
const newMid = (k = KEY) => b64("new_ig_dm_") + b64("itd\x05IGMessageID:" + k); // Unified login: "bmV3X2lnX2RtXw..."
const LEAD = "1544102710903897";
const T0 = 1_795_000_000_000;

afterEach(() => {
  vi.unstubAllGlobals();
});

async function withOldMessage() {
  const d = makeD1();
  await d.prepare(`INSERT INTO messages (subscriber_id, role, text, created_at, mid) VALUES (?1, 'lead', 'hey', ?2, ?3)`).bind(LEAD, T0, oldMid()).run();
  await db.fillMessageKeys(d);
  return d;
}

describe("message ids from either login", () => {
  it("both formats carry the same account:thread:item; anything else has no key", () => {
    expect(oldMid().startsWith("aWdfZA")).toBe(true);
    expect(midKey(oldMid())).toBe(KEY);
    expect(midKey(newMid())).toBe(KEY);
    expect(midKey("pb:1544102710903897:1795000000000")).toBeNull();
    expect(midKey("m1")).toBeNull();
    expect(midKey(null)).toBeNull();
    expect(threadLink(newMid())).toBe("https://www.instagram.com/direct/t/340282366841710300000000000000000000042/");
  });

  it("the cron fills mkey a batch at a time from a watermark, then only what's new", async () => {
    const d = makeD1();
    const add = (mid: string | null, t: number) =>
      d.prepare(`INSERT INTO messages (subscriber_id, role, text, created_at, mid) VALUES (?1, 'lead', 'x', ?2, ?3)`).bind(LEAD, t, mid).run();
    await add(oldMid(), T0);
    await add(null, T0 + 1); // a send through Manychat: no id
    await add("pb:1:2", T0 + 2); // a tap
    expect(await db.fillMessageKeys(d)).toBe(1);
    expect(await db.fillMessageKeys(d)).toBe(0);
    await add(oldMid(KEY.replace(/42:/, "43:")), T0 + 3);
    expect(await db.fillMessageKeys(d)).toBe(1);
    const { results } = await d.prepare(`SELECT mid, mkey FROM messages ORDER BY id`).all<{ mid: string | null; mkey: string | null }>();
    expect(results.map((r) => r.mkey)).toEqual([KEY, null, null, KEY.replace(/42:/, "43:")]);
  });

  it("a reaction, edit or unsend named by the other login's id lands on the stored message", async () => {
    const d = await withOldMessage();
    await d.prepare(`INSERT INTO media_cache (mid, data, fetched_at) VALUES (?1, '{}', ?2)`).bind(oldMid(), T0).run();
    await applyUpdate(d, { kind: "reaction", mid: newMid(), who: "lead", emoji: "🔥" }, T0);
    expect((await d.prepare(`SELECT reactions FROM messages`).first<{ reactions: string }>())!.reactions).toBe('{"lead":"🔥"}');
    await applyUpdate(d, { kind: "edit", mid: newMid(), text: "hey there" }, T0);
    expect((await d.prepare(`SELECT text FROM messages`).first<{ text: string }>())!.text).toBe("hey there");
    await applyUpdate(d, { kind: "unsend", mid: newMid() }, T0);
    expect((await d.prepare(`SELECT text FROM messages`).first<{ text: string }>())!.text).toBe("[unsent a message]");
    expect(await d.prepare(`SELECT 1 FROM media_cache`).first()).toBeNull(); // its media goes too
  });

  it("a read receipt named by the other login's id finds the stored message", async () => {
    const d = await withOldMessage();
    const send = (t: number) =>
      d.prepare(`INSERT INTO flow_sends (trigger_id, subscriber_id, status, created_at) VALUES (1, ?1, 'sent', ?2)`).bind(LEAD, t).run();
    await send(T0 - 1000); // before the message they read: opened
    await send(T0 + 1000); // after it: not opened yet, though before the read itself
    await handleRead(d, { lead_id: LEAD, mid: newMid(), at: T0 + 5000 });
    const { results } = await d.prepare(`SELECT seen_at FROM flow_sends ORDER BY id`).all<{ seen_at: number | null }>();
    expect(results.map((r) => r.seen_at)).toEqual([T0 + 5000, null]);
  });

  it("finds by either id through the id indexes, never a scan or a whole thread", async () => {
    const d = await withOldMessage();
    // The SQL the code really sends: a reaction's update, and the read receipt's lookup (a whole thread, before the +).
    const sql: string[] = [];
    const spy = { prepare: (q: string) => (sql.push(q), d.prepare(q)), batch: d.batch.bind(d) } as unknown as D1Database;
    await applyUpdate(spy, { kind: "reaction", mid: newMid(), who: "lead", emoji: "🔥" }, T0);
    await handleRead(spy, { lead_id: LEAD, mid: newMid(), at: T0 });
    const lookups = sql.filter((q) => /FROM messages|UPDATE messages/.test(q) && q.includes("mkey"));
    expect(lookups.length).toBe(2);
    for (const q of lookups) {
      const { results } = await d.prepare(`EXPLAIN QUERY PLAN ${q}`).all<{ detail: string }>();
      const plan = results.map((r) => r.detail).join(" | ");
      expect(plan).toMatch(/messages_by_mid/);
      expect(plan).toMatch(/messages_by_mkey/);
      expect(plan).not.toMatch(/messages_by_lead|SCAN messages(?! USING)/);
    }
  });

  it("a message whose id arrives after the cron passed it still gets its key", async () => {
    const d = makeD1();
    await d.prepare(`INSERT INTO messages (subscriber_id, role, text, created_at) VALUES (?1, 'bot', 'sent via manychat', ?2)`).bind(LEAD, T0).run();
    await db.fillMessageKeys(d); // the watermark passes it while it has no id
    await db.recordEcho(d, LEAD, "sent via manychat", oldMid(), T0 + 1000); // its echo brings the id
    await applyUpdate(d, { kind: "reaction", mid: newMid(), who: "lead", emoji: "🔥" }, T0);
    expect(await d.prepare(`SELECT mkey, reactions FROM messages`).first()).toEqual({ mkey: KEY, reactions: '{"lead":"🔥"}' });
  });

  it("a group's id comes from a message id when its conversation id isn't the old shape", () => {
    expect(groupId("aWdfZAG06" + b64("340282366841710300000000000000000000042"))).toBe("g:340282366841710300000000000000000000042");
    expect(groupId("some-unified-conversation-id", newMid())).toBe("g:340282366841710300000000000000000000042");
    expect(groupId("some-unified-conversation-id")).toBe("g:some-unified-conversation-id");
  });

  it("an id from the other login is never sent back to Instagram, either way: the quote is dropped, a reaction refused", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => (bodies.push(String(init?.body)), Response.json({ message_id: "x" }))));
    await sendText("IGAAtoken", LEAD, "hi", oldMid());
    expect(bodies.pop()).toContain('"reply_to"'); // Instagram Login: its own ids, as before
    await sendText("IGAAtoken", LEAD, "hi", newMid()); // after going back: a Unified id it never gave out
    expect(bodies.pop()).not.toContain('"reply_to"');
    await sendText("EAAtoken", LEAD, "hi", oldMid());
    expect(bodies.pop()).not.toContain('"reply_to"');
    await sendText("EAAtoken", LEAD, "hi", newMid());
    expect(bodies.pop()).toContain('"reply_to"');
    await expect(react("EAAtoken", LEAD, oldMid(), "❤️")).rejects.toThrow(/the other login/);
    await expect(react("IGAAtoken", LEAD, newMid(), "❤️")).rejects.toThrow(/the other login/);
    await react("EAAtoken", LEAD, newMid(), "❤️");
    expect(bodies.pop()).toContain('"react"');
  });

  it("the same message arriving under both logins' ids is stored once: theirs, and our own send's echo", async () => {
    const d = makeD1();
    const lead = { subscriber_id: LEAD, username: null, first_name: null, text: "hey" };
    expect(await db.recordInbound(d, { ...lead, mid: oldMid() }, T0)).toBe(true);
    expect(await db.recordInbound(d, { ...lead, mid: newMid() }, T0 + 5 * 60_000)).toBe(false); // past the text-dupe window too
    const ours = KEY.replace(/42:/, "43:");
    await d.prepare(`INSERT INTO messages (subscriber_id, role, text, created_at, mid, mkey) VALUES (?1, 'bot', 'yo', ?2, ?3, ?4)`).bind(LEAD, T0, oldMid(ours), ours).run();
    expect(await db.recordEcho(d, LEAD, "yo", newMid(ours), T0 + 1000)).toBe(false); // ours: no second row, no "someone answered"
    expect((await d.prepare(`SELECT COUNT(*) AS n FROM messages`).first<{ n: number }>())!.n).toBe(2);
  });
});
