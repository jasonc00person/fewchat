-- Picking up work a database restart cut off (Cloudflare resets the database when one query runs out of CPU): see
-- resumeInbound in src/flows.ts and handleComment in src/comments.ts. Plus indexes so the per-comment lookups stop
-- reading the whole comments table.
ALTER TABLE messages ADD COLUMN flow_pending TEXT;  -- JSON: what a DM's or tap's automation needs, cleared once it has run
ALTER TABLE flow_taps ADD COLUMN done_at INTEGER;   -- when the tap's work finished; still empty long after = cut off, retried
UPDATE flow_taps SET done_at = created_at WHERE done_at IS NULL;
CREATE INDEX IF NOT EXISTS messages_flow_pending ON messages (id) WHERE flow_pending IS NOT NULL;
CREATE INDEX IF NOT EXISTS comments_by_lead ON comments (subscriber_id, trigger_id);
CREATE INDEX IF NOT EXISTS comments_by_sent ON comments (sent_at);
