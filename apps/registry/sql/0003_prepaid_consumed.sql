-- Tab registry read layer - schema `registry`, third file: prepaid credit spent.
--
-- Applied after `0002_credit_and_bond.sql` by `pnpm --filter @tabai/registry db:apply`
-- and by the service on start, in lexical order. Every statement is guarded, so a
-- second application is a no-op. The domains, the envelope table, and the two
-- conventions this file relies on are declared in `0001`; this file only adds one
-- typed table that hangs off `registry.event_log` the same way the earlier ones do.
--
-- Why this table exists. `SettlementApplied.to_prepaid` records prepaid credit
-- arriving and nothing recorded it leaving, so a tab funded by an excess settlement
-- looked permanently funded to every reader of this schema. `TabBook.PrepaidConsumed`
-- is the other half: it fires inside `_recordOnTab` whenever a Metered Delivery draws
-- on the balance, carrying what was taken, what is left on the tab afterwards, and
-- how much of the same charge had to be borrowed instead. With this row indexed, a
-- delivery that cost the Agent nothing on its Open Tab explains itself - the balance
-- it spent is named, and so is the moment it ran out.
--
-- It is not a substitute for `DeliveryRecorded`, which is still not indexed. A
-- delivery that drew no prepaid credit emits nothing here, so the rows are the
-- prepaid-funded deliveries only and `open_added` sums to a lower bound on borrowing,
-- never the whole of it. The read layer says so in the same words.
--
-- Requirements: 12.5, 12.6, 24.1, 24.7

-- `TabBook.PrepaidConsumed` - a Metered Delivery paid out of prepaid credit.
--
-- Keyed by the tab triple `(agent, service_id, asset)`, the same identity
-- `TabBook.tabIdOf` hashes, so the latest row per triple is that tab's last observed
-- prepaid balance. `prepaid_after` is a point-in-time observation and only moves down
-- here: a later `SettlementApplied` with a non-zero `to_prepaid` raises the balance
-- again and is recorded in its own table.
CREATE TABLE IF NOT EXISTS registry.prepaid_consumed (
  block_hash    registry.hex_word    NOT NULL,
  log_index     INTEGER              NOT NULL,
  agent         registry.hex_address NOT NULL,
  service_id    registry.hex_word    NOT NULL,
  asset         registry.hex_address NOT NULL,
  consumed      NUMERIC(39,0)        NOT NULL,
  prepaid_after NUMERIC(39,0)        NOT NULL,
  open_added    NUMERIC(39,0)        NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT prepaid_consumed_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

-- The Agent credit read groups by Asset and orders within a tab, which is exactly
-- this index.
CREATE INDEX IF NOT EXISTS prepaid_consumed_agent_idx ON registry.prepaid_consumed (agent, asset);
