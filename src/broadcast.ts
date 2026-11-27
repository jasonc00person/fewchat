// Broadcasts: one automation run for a list of people, a few a minute from the cron, so a promo never goes out as one
// burst. Instagram only allows it inside the 24h window (their last message or tap), so only people inside it are
// picked, the ones whose window closes soonest first. Each broadcast is setting `broadcast:<automation id>`, JSON:
//   from     automation ids: people who ran any of them, or "any": people who ran any automation at all (so not
//            the ones who only ever DM'd on their own: collabs, friends, threads answered by hand)
//   not_from automation ids: never people who ran these          tag    people with this tag (from + tag = both)
//   skip     tags never sent to (friend always is)                per_min  people a minute (max 20)
//   cap      stop after this many runs of the automation          start_at  ms; waits until then
//   status   "paused" | "running" | "done"                        note   why it stopped
//   left     written each minute: how many it could send to right now
// The automation's own one-run-per-person (flow_starts) is the sent list, so pausing, raising cap and resuming never
// sends anyone twice. Never picked: groups, test threads, Manychat-routed leads, anyone the AI stopped on, flagged or
// paused (a handoff, a thread being answered by hand), anyone who wrote in the last 15 minutes or has a smart delay
// waiting. It pauses itself, and alerts, on any Instagram error that reads like a limit or a spam flag, or when most of
// a minute's sends fail. `scripts/fc.mjs broadcast` sets these up.

import * as db from "./db";
import { startFlow } from "./flows";
import { alert, logError } from "./health";
import type { Env } from "./setter";

export interface Broadcast {
  from?: number[] | "any";
  not_from?: number[];
  tag?: string;
  skip?: string[];
  per_min: number;
  cap: number;
  start_at?: number;
  status: "paused" | "running" | "done";
  note?: string;
  left?: number;
  idle?: number;
}

const QUIET_MS = 15 * 60_000; // they're mid-conversation: wait
const MARGIN_MS = 5 * 60_000; // don't start a send that could land after their window closes
const MAX_PER_MIN = 20;
const IDLE_DONE = 60; // minutes with nobody left to send to
export const LIMITED = /limit|spam|restrict|abusive|blocked|too many|code (4|17|32|368|613)\b/i;

function audience(id: number, b: Broadcast, now: number): [string, unknown[]] {
  return [
    `FROM leads l
     WHERE l.last_inbound_at >= ?2 AND l.status = 'active' AND l.test = 0 AND l.mc_id IS NULL AND l.subscriber_id NOT LIKE 'g:%'
       AND COALESCE(l.last_at, 0) < ?3
       AND (?4 IS NULL OR EXISTS (SELECT 1 FROM flow_starts s WHERE s.subscriber_id = l.subscriber_id AND s.trigger_id IN (SELECT value FROM json_each(?4))))
       AND (?7 = 0 OR EXISTS (SELECT 1 FROM flow_starts s WHERE s.subscriber_id = l.subscriber_id AND s.trigger_id > 0))
       AND NOT EXISTS (SELECT 1 FROM flow_starts s WHERE s.subscriber_id = l.subscriber_id AND s.trigger_id IN (SELECT value FROM json_each(?8)))
       AND (?5 IS NULL OR EXISTS (SELECT 1 FROM lead_tags t WHERE t.subscriber_id = l.subscriber_id AND lower(t.tag) = lower(?5)))
       AND NOT EXISTS (SELECT 1 FROM lead_tags t WHERE t.subscriber_id = l.subscriber_id AND lower(t.tag) IN (SELECT lower(value) FROM json_each(?6)))
       AND NOT EXISTS (SELECT 1 FROM flow_starts s WHERE s.trigger_id = ?1 AND s.subscriber_id = l.subscriber_id)
       AND NOT EXISTS (SELECT 1 FROM flow_runs r WHERE r.subscriber_id = l.subscriber_id AND r.status = 'scheduled')`,
    [
      id,
      now - db.WINDOW_MS + MARGIN_MS,
      now - QUIET_MS,
      Array.isArray(b.from) && b.from.length ? JSON.stringify(b.from) : null,
      b.tag?.trim() || null,
      JSON.stringify(["friend", ...(b.skip ?? [])]),
      b.from === "any" ? 1 : 0,
      JSON.stringify(b.not_from ?? []),
    ],
  ];
}

// json_set, so a pause typed into the CLI while a minute is sending is never overwritten.
function patch(d: D1Database, id: number, fields: Record<string, string | number>) {
  const sets = Object.keys(fields).map((k, i) => `'$.${k}', ?${i + 2}`);
  return d.prepare(`UPDATE settings SET value = json_set(value, ${sets.join(", ")}) WHERE key = ?1`).bind(`broadcast:${id}`, ...Object.values(fields)).run();
}

async function stop(env: Env, id: number, status: "paused" | "done", note: string, now: number) {
  await patch(env.DB, id, { status, note });
  await alert(env, `broadcast:${id}`, `broadcast #${id} ${status}`, note, now, 0);
}

export async function runBroadcasts(env: Env, now: number): Promise<void> {
  const { results } = await env.DB.prepare(`SELECT key, value FROM settings WHERE key LIKE 'broadcast:%'`).all<{ key: string; value: string }>();
  const token = await db.getSetting(env.DB, "ig_token");
  for (const row of results) {
    const id = Number(row.key.slice("broadcast:".length));
    const b = JSON.parse(row.value) as Broadcast;
    if (!id || b.status === "done" || (!b.from?.length && !b.tag?.trim())) continue;
    const [where, binds] = audience(id, b, now);
    const left = (await env.DB.prepare(`SELECT COUNT(*) AS n ${where}`).bind(...binds).first<{ n: number }>())?.n ?? 0;
    await patch(env.DB, id, { left });
    if (b.status !== "running" || !token || (b.start_at && now < b.start_at)) continue;

    const ran = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM flow_starts WHERE trigger_id = ?1`).bind(id).first<{ n: number }>())?.n ?? 0;
    if (ran >= b.cap) {
      await stop(env, id, "paused", `reached its cap of ${b.cap} (${left} more inside the window right now)`, now);
      continue;
    }
    const n = Math.max(0, Math.min(b.per_min, MAX_PER_MIN, b.cap - ran));
    const { results: picks } = await env.DB.prepare(`SELECT l.subscriber_id ${where} ORDER BY l.last_inbound_at LIMIT ${n}`)
      .bind(...binds)
      .all<{ subscriber_id: string }>();
    if (!picks.length) {
      const idle = (b.idle ?? 0) + 1;
      if (idle >= IDLE_DONE) await stop(env, id, "done", `nobody left inside the window (${ran} sent)`, now);
      else await patch(env.DB, id, { idle });
      continue;
    }
    if (b.idle) await patch(env.DB, id, { idle: 0 });

    let failed = 0;
    for (const { subscriber_id } of picks) {
      try {
        await startFlow(env, token, id, subscriber_id, Date.now(), null, null, false); // a rate limit pauses it (below)
      } catch (e) {
        failed++;
        await logError(env.DB, "broadcast", `#${id} ${subscriber_id}`, e, now);
        if (LIMITED.test(String(e))) {
          await stop(env, id, "paused", `Instagram refused a send, so it stopped: ${String(e).slice(0, 300)}`, now);
          break;
        }
      }
    }
    if (failed >= 3 && failed * 2 >= picks.length) await stop(env, id, "paused", `${failed} of ${picks.length} sends failed in one minute (see Problems)`, now);
  }
}
