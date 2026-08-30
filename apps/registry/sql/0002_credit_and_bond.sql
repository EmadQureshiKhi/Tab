-- Tab registry read layer — schema `registry`, second file: the credit witness and
-- the Bond ledger.
--
-- Applied after `0001_registry_schema.sql` by `pnpm --filter @tabai/registry db:apply`
-- and by the service on start, in lexical order. Every statement is guarded, so a
-- second application is a no-op. The domains, the envelope table, and the two
-- conventions this file relies on are declared in `0001`; this file only adds
-- typed tables that hang off `registry.event_log` the same way the first seventeen
-- do.
--
-- Why these nine tables exist. `TabBook.creditLimit` answers only against a
-- `LimitWitness` that folds to the stored history commitment, and the four fields
-- the contract authors at settlement time (`settledAt`, `firstDeliveryAt`,
-- `curated`, `bonded`) reach the outside world through exactly one event,
-- `HistoryExtended`. The bond cap and free Bond rest on the four ledger figures
-- `Bond` keeps, which move only through its seven ledger events. And a spending
-- authorisation makes a Service a counterparty before any Settlement exists, which
-- is the one case `TabBook._resolveBonds` admits a Bond entry on. So the Credit
-- Limit a Dashboard shows is reconstructable from logs alone precisely when all of
-- these are indexed, and from nothing less.
--
-- Requirements: 12.6, 24.1, 24.3, 24.7

-- `TabBook.HistoryExtended` — the committed record, flattened.
--
-- One row per Verified Settlement that reached a tab, in the order the commitment
-- folded them; `count` is the commitment length after this append, so a gap in the
-- sequence for one (agent, asset) is a missing row and not a reorder. The eight
-- `record_*` columns are `LimitLib.SettlementRecord` in declaration order, and the
-- rolling `root` is what a rebuilt witness is checked against.
CREATE TABLE IF NOT EXISTS registry.history_extended (
  block_hash               registry.hex_word    NOT NULL,
  log_index                INTEGER              NOT NULL,
  agent                    registry.hex_address NOT NULL,
  asset                    registry.hex_address NOT NULL,
  root                     registry.hex_word    NOT NULL,
  count                    INTEGER              NOT NULL CHECK (count >= 1),
  record_service_id        registry.hex_word    NOT NULL,
  record_asset             registry.hex_address NOT NULL,
  record_amount            NUMERIC(39,0)        NOT NULL,
  record_settled_at        BIGINT               NOT NULL,
  record_first_delivery_at BIGINT               NOT NULL,
  record_chain_key         BIGINT               NOT NULL,
  record_curated           BOOLEAN              NOT NULL,
  record_bonded            BOOLEAN              NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT history_extended_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS history_extended_agent_idx ON registry.history_extended (agent, asset, count);

-- `TabBook.AuthorisationSet` — an Agent named a Service it will be metered by.
CREATE TABLE IF NOT EXISTS registry.authorisation_set (
  block_hash     registry.hex_word    NOT NULL,
  log_index      INTEGER              NOT NULL,
  agent          registry.hex_address NOT NULL,
  service_id     registry.hex_word    NOT NULL,
  asset          registry.hex_address NOT NULL,
  max_cumulative NUMERIC(39,0)        NOT NULL,
  expiry         BIGINT               NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT authorisation_set_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS authorisation_set_agent_idx ON registry.authorisation_set (agent, asset);

-- `Bond.BondFunded` — stake arrived by proven deposit. `staked += amount`.
--
-- `party` is `Bond.partyOf(bondAccount)`, the account address widened to a word.
-- `replay_key` is the Verified Settlement that proved the deposit, and joining it to
-- `settlement_recorded` is how a party is mapped back to the Service it belongs to.
CREATE TABLE IF NOT EXISTS registry.bond_funded (
  block_hash registry.hex_word    NOT NULL,
  log_index  INTEGER              NOT NULL,
  party      registry.hex_word    NOT NULL,
  asset      registry.hex_address NOT NULL,
  amount     NUMERIC(39,0)        NOT NULL,
  replay_key registry.hex_word    NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT bond_funded_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS bond_funded_party_idx  ON registry.bond_funded (party, asset);
CREATE INDEX IF NOT EXISTS bond_funded_replay_idx ON registry.bond_funded (replay_key);

-- `Bond.BondReserved` — stake pledged against a Provisional Clearing. `reserved += amount`.
CREATE TABLE IF NOT EXISTS registry.bond_reserved (
  block_hash  registry.hex_word    NOT NULL,
  log_index   INTEGER              NOT NULL,
  clearing_id registry.hex_word    NOT NULL,
  party       registry.hex_word    NOT NULL,
  asset       registry.hex_address NOT NULL,
  amount      NUMERIC(39,0)        NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT bond_reserved_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS bond_reserved_party_idx ON registry.bond_reserved (party, asset);
CREATE INDEX IF NOT EXISTS bond_reserved_id_idx    ON registry.bond_reserved (clearing_id);

-- `Bond.BondReleased` — a pledge returned to free Bond. `reserved -= amount`.
CREATE TABLE IF NOT EXISTS registry.bond_released (
  block_hash  registry.hex_word    NOT NULL,
  log_index   INTEGER              NOT NULL,
  clearing_id registry.hex_word    NOT NULL,
  party       registry.hex_word    NOT NULL,
  asset       registry.hex_address NOT NULL,
  amount      NUMERIC(39,0)        NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT bond_released_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS bond_released_party_idx ON registry.bond_released (party, asset);

-- `Bond.SlashedForUnconfirmedClearing` — a pledge slashed at its deadline.
-- `reserved -= amount; slashed += amount`, and the Agent is credited prepaid.
CREATE TABLE IF NOT EXISTS registry.slashed_for_unconfirmed_clearing (
  block_hash  registry.hex_word    NOT NULL,
  log_index   INTEGER              NOT NULL,
  clearing_id registry.hex_word    NOT NULL,
  party       registry.hex_word    NOT NULL,
  asset       registry.hex_address NOT NULL,
  amount      NUMERIC(39,0)        NOT NULL,
  beneficiary registry.hex_address NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT slashed_unconfirmed_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS slashed_unconfirmed_party_idx ON registry.slashed_for_unconfirmed_clearing (party, asset);

-- `Bond.SlashedForReorg` — free stake slashed for a superseded Settlement.
-- `slashed += amount`, taken from free Bond and capped at it.
CREATE TABLE IF NOT EXISTS registry.slashed_for_reorg (
  block_hash  registry.hex_word    NOT NULL,
  log_index   INTEGER              NOT NULL,
  replay_key  registry.hex_word    NOT NULL,
  party       registry.hex_word    NOT NULL,
  asset       registry.hex_address NOT NULL,
  amount      NUMERIC(39,0)        NOT NULL,
  beneficiary registry.hex_address NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT slashed_reorg_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS slashed_reorg_party_idx ON registry.slashed_for_reorg (party, asset);

-- `Bond.ReorgSlashShortfall` — the part of a reorg slash free Bond could not cover.
-- Informational: the ledger moved by `slashed`, and `requested - slashed` is public.
CREATE TABLE IF NOT EXISTS registry.reorg_slash_shortfall (
  block_hash registry.hex_word    NOT NULL,
  log_index  INTEGER              NOT NULL,
  replay_key registry.hex_word    NOT NULL,
  party      registry.hex_word    NOT NULL,
  asset      registry.hex_address NOT NULL,
  requested  NUMERIC(39,0)        NOT NULL,
  slashed    NUMERIC(39,0)        NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT reorg_shortfall_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS reorg_shortfall_party_idx ON registry.reorg_slash_shortfall (party, asset);

-- `Bond.WithdrawalReleased` — free stake moved to the withdrawal-eligible figure.
-- `released += amount`.
CREATE TABLE IF NOT EXISTS registry.withdrawal_released (
  block_hash registry.hex_word    NOT NULL,
  log_index  INTEGER              NOT NULL,
  party      registry.hex_word    NOT NULL,
  asset      registry.hex_address NOT NULL,
  amount     NUMERIC(39,0)        NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT withdrawal_released_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS withdrawal_released_party_idx ON registry.withdrawal_released (party, asset);

-- ---------------------------------------------------------------- bond deposits
--
-- The Bond branch's counterpart to `settlement_recorded`. `SettlementVerifier`
-- routes a Settlement naming a Bond Collection Address to `Bond` and emits
-- `BondDepositRecorded` rather than `SettlementRecorded`, so a deposit appears in
-- neither the settlement feed nor any join through it. This is the only row that
-- carries the Bond `party` beside the `service_id`, which is what maps a ledger to
-- the Service that owns it.

CREATE TABLE IF NOT EXISTS registry.bond_deposit_recorded (
  block_hash          registry.hex_word    NOT NULL,
  log_index           INTEGER              NOT NULL,
  replay_key          registry.hex_word    NOT NULL,
  chain_key           BIGINT               NOT NULL,
  source_block_height BIGINT               NOT NULL,
  source_tx_index     BIGINT               NOT NULL,
  source_log_index    BIGINT               NOT NULL,
  depositor           registry.hex_address NOT NULL,
  service_id          registry.hex_word    NOT NULL,
  asset               registry.hex_address NOT NULL,
  amount              NUMERIC(78,0)        NOT NULL,
  payer_address       registry.hex_address NOT NULL,
  party               registry.hex_word    NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT bond_deposit_recorded_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS bond_deposit_recorded_replay_idx
  ON registry.bond_deposit_recorded (replay_key);
CREATE INDEX IF NOT EXISTS bond_deposit_recorded_party_idx
  ON registry.bond_deposit_recorded (service_id, party, asset);
