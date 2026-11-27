-- Indexes for the per-minute cron queries that read billions of rows a day once a reel went viral (2026-11-27:
-- 4.45B rows read in 10 hours, two CPU resets). Each one turns a per-lead scan into a seek. Indexes only: safe to run
-- on the live DB before the code ships, and the code before them keeps working.

-- Broadcast audience: "ran any automation" (`from: "any"`) searched flow_starts by trigger_id > 0 for every lead in
-- the window, reading most of the table each time.
CREATE INDEX IF NOT EXISTS flow_starts_by_lead ON flow_starts (subscriber_id, trigger_id);
-- Broadcast audience's "no smart delay parked" check searched every scheduled run for every lead.
CREATE INDEX IF NOT EXISTS flow_runs_by_lead ON flow_runs (subscriber_id, status);
-- leadSpokeLast (setter, health check, Inbox): MAX(id) of one role walked every message of the lead.
CREATE INDEX IF NOT EXISTS messages_by_role ON messages (subscriber_id, role, id);
-- leadSpokeLast's hold-on-line check: found a lead's handoff draft by scanning every sent draft.
CREATE INDEX IF NOT EXISTS drafts_by_answer ON drafts (subscriber_id, after_message_id);
-- The 24h window (setter drafts, follow-ups, broadcasts) scanned the whole leads table.
CREATE INDEX IF NOT EXISTS leads_by_inbound ON leads (last_inbound_at);
-- Inbox list and the profile-picture refresh sort on this expression; without an index every page sorted all leads
-- (and ran leadSpokeLast on each).
CREATE INDEX IF NOT EXISTS leads_by_recent ON leads (COALESCE(last_at, created_at));
-- Auto-resume of manual-reply pauses scanned the whole leads table every minute.
CREATE INDEX IF NOT EXISTS leads_paused ON leads (paused_at) WHERE status = 'paused';
-- Health checks count failed / stuck flow messages every minute. Partial, so queries on sent rows (read receipts,
-- card stats) keep their lead / automation indexes: a plain (status, created_at) index took those over and read
-- every sent row.
CREATE INDEX IF NOT EXISTS flow_sends_failed ON flow_sends (created_at) WHERE status = 'failed';
CREATE INDEX IF NOT EXISTS flow_sends_sending ON flow_sends (created_at) WHERE status = 'sending';
