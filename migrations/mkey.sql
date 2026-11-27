-- messages.mkey: the message's "<account>:<thread>:<item>" (midKey in src/meta.ts). Instagram Login and Unified login
-- give the same message different ids with these three numbers inside, so a reaction, edit, unsend, reply or read
-- receipt that arrives after a switch still finds the older message. Filled by the cron (fillMessageKeys in src/db.ts).
ALTER TABLE messages ADD COLUMN mkey TEXT;
CREATE INDEX IF NOT EXISTS messages_by_mkey ON messages (mkey) WHERE mkey IS NOT NULL;
