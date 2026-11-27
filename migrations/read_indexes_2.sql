-- learnFromHandoffs (src/learn.ts, every cron run) looked for handoffs not yet learned from by reading the whole drafts
-- table. Partial, so it holds only those and no other drafts query can pick it up. Answered handoffs are learned and
-- unanswered ones marked done after 2 days; one whose extraction keeps failing past the job's 3-day look-back stays,
-- at one index row a run. On id, not created_at: the query is ORDER BY d.id, and SQLite only takes an index that
-- gives it that order.
CREATE INDEX IF NOT EXISTS drafts_to_learn ON drafts (id) WHERE action = 'handoff' AND learned_at IS NULL;
