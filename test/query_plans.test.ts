// The cron runs these every minute (and the Inbox on every load). On 2026-11-27 a viral reel put a few thousand leads
// inside the 24h window and each of these scanned per lead: 4.45B rows read in 10 hours and two database resets.
// Each test records the SQL a code path really sends and checks SQLite's plan for it: no full scan of a big table and
// none of the index choices that read whole tables that day. migrations/read_indexes.sql holds the indexes.
import { describe, expect, it, vi } from "vitest";
import { makeD1 } from "./d1shim";
import { leadsNeedingFollowUp, resumeManualPauses } from "../src/autonomy";
import { runBroadcasts } from "../src/broadcast";
import * as db from "../src/db";
import { handleRead } from "../src/flows";
import { graphStats } from "../src/graph";
import worker from "../src/index";
import type { Env } from "../src/setter";

const NOW = Date.UTC(2026, 10, 27, 12, 0);
const BIG = new Set(["leads", "l", "messages", "m", "b", "flow_starts", "s", "flow_runs", "r", "drafts", "d", "h", "flow_sends", "comments"]);
const WRONG = [
  /USING INDEX messages_by_mid/, // `mid IS NULL` on the unique index = every unmatched message
  /drafts_by_status/, // every sent draft, for each lead
  /sqlite_autoindex_flow_starts_1 \(trigger_id>\?\)/, // "ran any automation": the whole table, for each lead
  /flow_runs_due \(status=\?\)$/, // every scheduled run, for each lead
];

function recording() {
  const d1 = makeD1();
  const sql: string[] = [];
  const spy = { prepare: (s: string) => (sql.push(s), d1.prepare(s)), batch: d1.batch } as unknown as D1Database;
  return { d1, spy, sql };
}

async function problems(d1: D1Database, statements: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const s of statements) {
    const { results } = await d1.prepare(`EXPLAIN QUERY PLAN ${s}`).all<{ detail: string }>();
    for (const { detail } of results) {
      const scan = detail.match(/^SCAN (\w+)$/);
      if ((scan && BIG.has(scan[1])) || WRONG.some((w) => w.test(detail))) out.push(`${detail}  <=  ${s.replace(/\s+/g, " ").slice(0, 120)}`);
    }
  }
  return out;
}

function env(DB: D1Database): Env {
  return { DB, ADMIN_PASSWORD: "pw", REVIEW_PASSWORD: "rv", AUTOPILOT: "false", TRANSPORT: "meta", SKOOL_LINK: "https://x" } as Env;
}

describe("hot queries stay on indexes", () => {
  it("setter drafts and the health check's waiting count", async () => {
    const { d1, spy, sql } = recording();
    await db.leadsNeedingDraft(spy, NOW, 45_000, false);
    await db.leadsNeedingDraft(spy, NOW, 45_000, true);
    expect(await problems(d1, sql)).toEqual([]);
  });

  it("follow-ups and auto-resume", async () => {
    const { d1, spy, sql } = recording();
    await leadsNeedingFollowUp(spy, NOW, false);
    await resumeManualPauses(spy, NOW);
    expect(sql.some((s) => s.includes("paused_reason = 'manual_reply' AND paused_at"))).toBe(true);
    expect(await problems(d1, sql)).toEqual([]);
  });

  it("an echo claiming our own unmatched bubble", async () => {
    const { d1, spy, sql } = recording();
    await db.recordEcho(spy, "1", "hey", "mid-1", NOW);
    expect(await problems(d1, sql)).toEqual([]);
  });

  it("broadcast audiences, from a list and from any automation", async () => {
    const { d1, spy, sql } = recording();
    const b = { per_min: 5, cap: 100, status: "paused" };
    await db.setSetting(d1, "broadcast:50", JSON.stringify({ ...b, from: [43, 44], skip: ["member"] }));
    await db.setSetting(d1, "broadcast:52", JSON.stringify({ ...b, from: "any", not_from: [43, 50] }));
    await db.setSetting(d1, "broadcast:51", JSON.stringify({ ...b, tag: "black friday" }));
    await runBroadcasts(env(spy), NOW);
    expect(sql.filter((s) => s.includes("FROM leads l")).length).toBe(3);
    expect(await problems(d1, sql)).toEqual([]);
  });

  it("the Inbox list walks leads newest first instead of sorting all of them", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { d1, spy, sql } = recording();
    const req = new Request("https://x/admin/inbox", { headers: { Authorization: `Basic ${btoa("owner:pw")}` } });
    try {
      await worker.fetch(req, env(spy), { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext);
    } finally {
      vi.useRealTimers();
    }
    const list = sql.filter((s) => s.includes("ORDER BY COALESCE(l.last_at, l.created_at) DESC"));
    expect(list.length).toBe(1);
    expect(await problems(d1, list)).toEqual([]);
  });

  // Nearly every flow_sends row is 'sent', so an index led by status reads the whole table for these. A plain
  // (status, created_at) index for the health checks once took them over; the partial ones can't.
  it("read receipts and card stats stay on their lead and automation indexes", async () => {
    const { d1, spy, sql } = recording();
    await handleRead(spy, { lead_id: "1", mid: "m1", at: NOW });
    await graphStats(spy, 49);
    const sent = sql.filter((s) => /\bflow_sends\b[^(]*WHERE[^(]*status = 'sent'/.test(s));
    expect(sent.length).toBeGreaterThanOrEqual(2);
    for (const s of sent) {
      const { results } = await d1.prepare(`EXPLAIN QUERY PLAN ${s}`).all<{ detail: string }>();
      const uses = results.map((r) => r.detail).filter((x) => /flow_sends|\bs\b USING/.test(x));
      expect(uses.join(" | ")).toMatch(/flow_sends_by_(lead|trigger)/);
    }
  });
});
