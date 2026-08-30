-- Tab registry read layer — schema `registry`.
--
-- Applied by `pnpm --filter @tabai/registry db:apply`, and by the service itself on
-- start. Every statement is guarded, so applying it twice is a no-op rather than an
-- error; that matters because several replicas may start at once.
--
-- This file is the authority for the database. `src/schema.ts` declares the same
-- tables for the query builder, and `test/schema.test.ts` fails when the two
-- disagree on a table or a column.
--
-- Two conventions worth stating before the tables.
--
-- **Row identity is `(block_hash, log_index)`.** A log ordinal is unique within a
-- block, and a block hash identifies the block, so the pair is unique across the
-- chain. It also stays distinct across a reorganisation: a re-mined block carrying
-- the same logs has a different hash, so its rows can never overwrite the
-- abandoned branch's rows in place. Re-indexing the same range therefore writes
-- nothing new, and correcting a reorganisation is a delete by block number.
--
-- **Byte-shaped values are lowercase `0x` hex text, with a CHECK on width.** The
-- read API serves them as hex, so text saves an encode on every read and a decode
-- on every hand-written query. Amounts are `numeric` at the exact decimal width of
-- their Solidity type, never a float: `numeric(78,0)` for `uint256` and
-- `numeric(39,0)` for `uint128`.
--
-- Requirements: 12.6, 24.4

CREATE SCHEMA IF NOT EXISTS registry;

-- ---------------------------------------------------------------- domains

-- Shape checks live in one place rather than being restated per column. A domain
-- is checked on every write, so a malformed address cannot land through any path.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'hex_address' AND n.nspname = 'registry') THEN
    CREATE DOMAIN registry.hex_address AS TEXT CHECK (VALUE ~ '^0x[0-9a-f]{40}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'hex_word' AND n.nspname = 'registry') THEN
    CREATE DOMAIN registry.hex_word AS TEXT CHECK (VALUE ~ '^0x[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'hex_bytes' AND n.nspname = 'registry') THEN
    CREATE DOMAIN registry.hex_bytes AS TEXT CHECK (VALUE ~ '^0x([0-9a-f]{2})*$');
  END IF;
END
$$;

-- ---------------------------------------------------------------- envelope

-- One row per indexed log, and the identity of every typed row below.
CREATE TABLE IF NOT EXISTS registry.event_log (
  block_number  BIGINT              NOT NULL CHECK (block_number >= 0),
  block_hash    registry.hex_word   NOT NULL,
  -- Null where the block header was not read. A log carries no timestamp, so the
  -- timestamp is a second chain read, and a failed read must not cost us the log.
  block_time    TIMESTAMPTZ,
  tx_hash       registry.hex_word   NOT NULL,
  tx_index      INTEGER             NOT NULL CHECK (tx_index >= 0),
  log_index     INTEGER             NOT NULL CHECK (log_index >= 0),
  emitter       registry.hex_address NOT NULL,
  topic0        registry.hex_word   NOT NULL,
  event_name    TEXT                NOT NULL,
  indexed_at    TIMESTAMPTZ         NOT NULL DEFAULT now(),
  PRIMARY KEY (block_hash, log_index)
);

CREATE INDEX IF NOT EXISTS event_log_block_idx ON registry.event_log (block_number, log_index);
CREATE INDEX IF NOT EXISTS event_log_name_idx  ON registry.event_log (event_name, block_number);
CREATE INDEX IF NOT EXISTS event_log_tx_idx    ON registry.event_log (tx_hash);

-- Every block that produced at least one indexed log, with the hash it carried.
-- This is the reorganisation detector: a block number whose hash has changed is a
-- block that was re-mined, and the indexer rewinds to it.
CREATE TABLE IF NOT EXISTS registry.indexed_block (
  block_number  BIGINT            PRIMARY KEY CHECK (block_number >= 0),
  block_hash    registry.hex_word NOT NULL,
  log_count     INTEGER           NOT NULL CHECK (log_count >= 0),
  seen_at       TIMESTAMPTZ       NOT NULL DEFAULT now()
);

-- How far the indexer has read. One row per named stream.
CREATE TABLE IF NOT EXISTS registry.indexer_cursor (
  stream          TEXT        PRIMARY KEY,
  last_block      BIGINT      NOT NULL CHECK (last_block >= -1),
  last_block_hash registry.hex_word,
  reorg_count     INTEGER     NOT NULL DEFAULT 0 CHECK (reorg_count >= 0),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ typed payloads
--
-- Every table below keys on the envelope pair and cascades from it. Two
-- consequences, both deliberate: no typed row can exist without the log it was
-- decoded from, and correcting a reorganisation is a single delete against
-- `event_log` that takes every decoded row with it.

-- `SettlementVerifier.SettlementRecorded` — eleven fields, in the contract's order.
--
-- `source_log_index` is the ordinal of the log within its own transaction's
-- receipt logs, which is NOT the block-wide `log_index` of the envelope. The two
-- are named differently on purpose; conflating them reads the wrong log.
--
-- `payer_address` is the Source Chain address from `topics[1]`, and `agent` is who
-- that address is bound to. Different facts, both kept.
CREATE TABLE IF NOT EXISTS registry.settlement_recorded (
  block_hash          registry.hex_word    NOT NULL,
  log_index           INTEGER              NOT NULL,
  replay_key          registry.hex_word    NOT NULL,
  chain_key           BIGINT               NOT NULL,
  source_block_height BIGINT               NOT NULL,
  source_tx_index     BIGINT               NOT NULL,
  source_log_index    BIGINT               NOT NULL,
  agent               registry.hex_address NOT NULL,
  service_id          registry.hex_word    NOT NULL,
  asset               registry.hex_address NOT NULL,
  amount              NUMERIC(78,0)        NOT NULL,
  payer_address       registry.hex_address NOT NULL,
  source_tab_id       registry.hex_word    NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT settlement_recorded_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS settlement_recorded_replay_idx  ON registry.settlement_recorded (replay_key);
CREATE INDEX IF NOT EXISTS settlement_recorded_agent_idx   ON registry.settlement_recorded (agent, asset);
CREATE INDEX IF NOT EXISTS settlement_recorded_service_idx ON registry.settlement_recorded (service_id, asset);
CREATE INDEX IF NOT EXISTS settlement_recorded_payer_idx   ON registry.settlement_recorded (chain_key, payer_address);

-- `TabBook.SettlementApplied` — what the Verified Settlement did to the tab.
CREATE TABLE IF NOT EXISTS registry.settlement_applied (
  block_hash  registry.hex_word    NOT NULL,
  log_index   INTEGER              NOT NULL,
  replay_key  registry.hex_word    NOT NULL,
  agent       registry.hex_address NOT NULL,
  service_id  registry.hex_word    NOT NULL,
  asset       registry.hex_address NOT NULL,
  applied     NUMERIC(78,0)        NOT NULL,
  to_prepaid  NUMERIC(78,0)        NOT NULL,
  open_after  NUMERIC(39,0)        NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT settlement_applied_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS settlement_applied_replay_idx ON registry.settlement_applied (replay_key);
CREATE INDEX IF NOT EXISTS settlement_applied_agent_idx  ON registry.settlement_applied (agent, asset);

-- `TabBook.ProvisionalClearingApplied` — the `provisional` state.
--
-- `clearing_id` is the replay key of the observed Settlement, which is the
-- clearing's identity and is computed independently by both sides.
CREATE TABLE IF NOT EXISTS registry.provisional_clearing_applied (
  block_hash     registry.hex_word    NOT NULL,
  log_index      INTEGER              NOT NULL,
  clearing_id    registry.hex_word    NOT NULL,
  agent          registry.hex_address NOT NULL,
  service_id     registry.hex_word    NOT NULL,
  asset          registry.hex_address NOT NULL,
  amount         NUMERIC(39,0)        NOT NULL,
  source_tx_hash registry.hex_word    NOT NULL,
  deadline       BIGINT               NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT clearing_applied_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS clearing_applied_id_idx       ON registry.provisional_clearing_applied (clearing_id);
CREATE INDEX IF NOT EXISTS clearing_applied_agent_idx    ON registry.provisional_clearing_applied (agent, asset);
CREATE INDEX IF NOT EXISTS clearing_applied_deadline_idx ON registry.provisional_clearing_applied (deadline);

-- `TabBook.ProvisionalClearingConfirmed` — the `confirmed` state.
CREATE TABLE IF NOT EXISTS registry.provisional_clearing_confirmed (
  block_hash     registry.hex_word    NOT NULL,
  log_index      INTEGER              NOT NULL,
  clearing_id    registry.hex_word    NOT NULL,
  agent          registry.hex_address NOT NULL,
  service_id     registry.hex_word    NOT NULL,
  asset          registry.hex_address NOT NULL,
  amount         NUMERIC(39,0)        NOT NULL,
  source_tx_hash registry.hex_word    NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT clearing_confirmed_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS clearing_confirmed_id_idx    ON registry.provisional_clearing_confirmed (clearing_id);
CREATE INDEX IF NOT EXISTS clearing_confirmed_agent_idx ON registry.provisional_clearing_confirmed (agent, asset);

-- `TabBook.ProvisionalClearingReversed` — the `reversed` state.
CREATE TABLE IF NOT EXISTS registry.provisional_clearing_reversed (
  block_hash     registry.hex_word    NOT NULL,
  log_index      INTEGER              NOT NULL,
  clearing_id    registry.hex_word    NOT NULL,
  agent          registry.hex_address NOT NULL,
  service_id     registry.hex_word    NOT NULL,
  asset          registry.hex_address NOT NULL,
  amount         NUMERIC(39,0)        NOT NULL,
  source_tx_hash registry.hex_word    NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT clearing_reversed_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS clearing_reversed_id_idx    ON registry.provisional_clearing_reversed (clearing_id);
CREATE INDEX IF NOT EXISTS clearing_reversed_agent_idx ON registry.provisional_clearing_reversed (agent, asset);

-- `TabBook.ProvisionalClearingDeclined` — the `declined` state.
--
-- A decline is NOT a failed Settlement. Free Bond did not cover an observation, so
-- the Open Tab was left alone until the Verified Settlement arrives, and
-- `free_bond` records how much Bond there was at that moment.
--
-- There is no `clearing_id`, because a decline creates no clearing and the contract
-- emits no identity for something that does not exist.
CREATE TABLE IF NOT EXISTS registry.provisional_clearing_declined (
  block_hash     registry.hex_word    NOT NULL,
  log_index      INTEGER              NOT NULL,
  agent          registry.hex_address NOT NULL,
  service_id     registry.hex_word    NOT NULL,
  asset          registry.hex_address NOT NULL,
  amount         NUMERIC(39,0)        NOT NULL,
  source_tx_hash registry.hex_word    NOT NULL,
  free_bond      NUMERIC(39,0)        NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT clearing_declined_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS clearing_declined_agent_idx     ON registry.provisional_clearing_declined (agent, asset);
CREATE INDEX IF NOT EXISTS clearing_declined_source_tx_idx ON registry.provisional_clearing_declined (source_tx_hash);

-- `TabBook.SettlementSuperseded` — the `superseded` state.
--
-- `attested_digest` is zero when the block has left the attested chain entirely.
CREATE TABLE IF NOT EXISTS registry.settlement_superseded (
  block_hash      registry.hex_word    NOT NULL,
  log_index       INTEGER              NOT NULL,
  replay_key      registry.hex_word    NOT NULL,
  agent           registry.hex_address NOT NULL,
  service_id      registry.hex_word    NOT NULL,
  asset           registry.hex_address NOT NULL,
  amount          NUMERIC(39,0)        NOT NULL,
  observed_digest registry.hex_word    NOT NULL,
  attested_digest registry.hex_word    NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT settlement_superseded_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS settlement_superseded_replay_idx ON registry.settlement_superseded (replay_key);
CREATE INDEX IF NOT EXISTS settlement_superseded_agent_idx  ON registry.settlement_superseded (agent, asset);

-- `TabBook.TabDelinquent` — an Open Tab passed its Settlement Window unsettled.
CREATE TABLE IF NOT EXISTS registry.tab_delinquent (
  block_hash  registry.hex_word    NOT NULL,
  log_index   INTEGER              NOT NULL,
  tab_id      registry.hex_word    NOT NULL,
  agent       registry.hex_address NOT NULL,
  service_id  registry.hex_word    NOT NULL,
  asset       registry.hex_address NOT NULL,
  unsettled   NUMERIC(39,0)        NOT NULL,
  window_end  BIGINT               NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT tab_delinquent_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tab_delinquent_tab_idx   ON registry.tab_delinquent (tab_id);
CREATE INDEX IF NOT EXISTS tab_delinquent_agent_idx ON registry.tab_delinquent (agent, asset);

-- `AgentRegistry.AddressBound` — a Source Chain address proven to belong to an Agent.
CREATE TABLE IF NOT EXISTS registry.address_bound (
  block_hash         registry.hex_word    NOT NULL,
  log_index          INTEGER              NOT NULL,
  agent              registry.hex_address NOT NULL,
  chain_key          BIGINT               NOT NULL,
  eth_address        registry.hex_address NOT NULL,
  proving_replay_key registry.hex_word    NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT address_bound_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS address_bound_agent_idx   ON registry.address_bound (agent, chain_key);
CREATE INDEX IF NOT EXISTS address_bound_address_idx ON registry.address_bound (chain_key, eth_address);

-- `ServiceRegistry.RegistryChangeQueued` — a change entered its 48-hour hold.
--
-- `payload` is the raw abi-encoded hex the contract emitted. Decoding it needs the
-- kind, and a wrong guess would rewrite a price or a tier in the read layer while
-- the chain says otherwise, so the bytes are stored whole.
CREATE TABLE IF NOT EXISTS registry.registry_change_queued (
  block_hash       registry.hex_word  NOT NULL,
  log_index        INTEGER            NOT NULL,
  change_id        registry.hex_word  NOT NULL,
  service_id       registry.hex_word  NOT NULL,
  change_kind      SMALLINT           NOT NULL,
  change_kind_name TEXT               NOT NULL,
  payload          registry.hex_bytes NOT NULL,
  eta              BIGINT             NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT change_queued_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS change_queued_id_idx      ON registry.registry_change_queued (change_id);
CREATE INDEX IF NOT EXISTS change_queued_service_idx ON registry.registry_change_queued (service_id, eta);

-- `ServiceRegistry.RegistryChangeApplied` — the hold elapsed and the change landed.
CREATE TABLE IF NOT EXISTS registry.registry_change_applied (
  block_hash       registry.hex_word  NOT NULL,
  log_index        INTEGER            NOT NULL,
  change_id        registry.hex_word  NOT NULL,
  service_id       registry.hex_word  NOT NULL,
  change_kind      SMALLINT           NOT NULL,
  change_kind_name TEXT               NOT NULL,
  payload          registry.hex_bytes NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT change_applied_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS change_applied_id_idx      ON registry.registry_change_applied (change_id);
CREATE INDEX IF NOT EXISTS change_applied_service_idx ON registry.registry_change_applied (service_id);

-- `ServiceRegistry.RegistryChangeCancelled` — the change was withdrawn.
--
-- Without it the read layer would serve a cancelled change as pending forever,
-- with an ETA that never arrives.
CREATE TABLE IF NOT EXISTS registry.registry_change_cancelled (
  block_hash registry.hex_word NOT NULL,
  log_index  INTEGER           NOT NULL,
  change_id  registry.hex_word NOT NULL,
  service_id registry.hex_word NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT change_cancelled_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS change_cancelled_id_idx ON registry.registry_change_cancelled (change_id);

-- `ServiceRegistry.ServiceRegistered` — a Service joined, at the Permissionless Tier.
CREATE TABLE IF NOT EXISTS registry.service_registered (
  block_hash        registry.hex_word    NOT NULL,
  log_index         INTEGER              NOT NULL,
  service_id        registry.hex_word    NOT NULL,
  operator          registry.hex_address NOT NULL,
  tier              SMALLINT             NOT NULL,
  tier_name         TEXT                 NOT NULL,
  settlement_window BIGINT               NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT service_registered_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS service_registered_service_idx  ON registry.service_registered (service_id);
CREATE INDEX IF NOT EXISTS service_registered_operator_idx ON registry.service_registered (operator);

-- `ServiceRegistry.EmitterAuthorised` — a `(chainKey, emitter)` pair became authorised.
CREATE TABLE IF NOT EXISTS registry.emitter_authorised (
  block_hash        registry.hex_word    NOT NULL,
  log_index         INTEGER              NOT NULL,
  chain_key         BIGINT               NOT NULL,
  emitter           registry.hex_address NOT NULL,
  emitter_kind      SMALLINT             NOT NULL,
  emitter_kind_name TEXT                 NOT NULL,
  asset             registry.hex_address NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT emitter_authorised_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS emitter_authorised_pair_idx ON registry.emitter_authorised (chain_key, emitter);

-- `ServiceRegistry.CollectionRegistered` — a Collection Address was claimed.
CREATE TABLE IF NOT EXISTS registry.collection_registered (
  block_hash           registry.hex_word    NOT NULL,
  log_index            INTEGER              NOT NULL,
  service_id           registry.hex_word    NOT NULL,
  chain_key            BIGINT               NOT NULL,
  collection           registry.hex_address NOT NULL,
  asset                registry.hex_address NOT NULL,
  collection_kind      SMALLINT             NOT NULL,
  collection_kind_name TEXT                 NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT collection_registered_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS collection_registered_pair_idx    ON registry.collection_registered (chain_key, collection);
CREATE INDEX IF NOT EXISTS collection_registered_service_idx ON registry.collection_registered (service_id);

-- `ServiceRegistry.CollectionReleased` — a Collection Address stopped resolving.
CREATE TABLE IF NOT EXISTS registry.collection_released (
  block_hash registry.hex_word    NOT NULL,
  log_index  INTEGER              NOT NULL,
  service_id registry.hex_word    NOT NULL,
  chain_key  BIGINT               NOT NULL,
  collection registry.hex_address NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT collection_released_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS collection_released_pair_idx ON registry.collection_released (chain_key, collection);

-- `ServiceRegistry.ToolPriceSet` — a price in Asset base units for one named tool.
CREATE TABLE IF NOT EXISTS registry.tool_price_set (
  block_hash registry.hex_word    NOT NULL,
  log_index  INTEGER              NOT NULL,
  service_id registry.hex_word    NOT NULL,
  asset      registry.hex_address NOT NULL,
  tool       registry.hex_word    NOT NULL,
  base_units NUMERIC(78,0)        NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT tool_price_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tool_price_service_idx ON registry.tool_price_set (service_id, asset);
