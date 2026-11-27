-- More than one trigger per automation (src/graph.ts ExtraTrigger): the When... card's main trigger stays in the
-- triggers row's own columns, the others (DM keywords, story replies, mentions) go here as JSON.
ALTER TABLE triggers ADD COLUMN more TEXT;
-- Which trigger started a run: "main" or an extra trigger's id. NULL = from before this column, a button, another
-- automation or a broadcast; the lists count those under the main trigger.
ALTER TABLE flow_starts ADD COLUMN via TEXT;
