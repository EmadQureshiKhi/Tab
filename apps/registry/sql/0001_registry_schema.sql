-- Tab registry read layer, schema `registry`.
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

-- `TabBook.DeliveryRecorded`: a Service metered usage into an Open Tab.
CREATE TABLE IF NOT EXISTS registry.delivery_recorded (
  block_hash               registry.hex_word    NOT NULL,
  log_index                INTEGER              NOT NULL,
  agent                    registry.hex_address NOT NULL,
  service_id               registry.hex_word    NOT NULL,
  asset                    registry.hex_address NOT NULL,
  tool                     registry.hex_word    NOT NULL,
  units                    BIGINT               NOT NULL,
  amount                   NUMERIC(78,0)        NOT NULL,
  timestamp                BIGINT               NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT delivery_recorded_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS delivery_recorded_agent_idx ON registry.delivery_recorded (agent, asset);
CREATE INDEX IF NOT EXISTS delivery_recorded_service_idx ON registry.delivery_recorded (service_id, asset);

-- `TabBook.SettlementApplied`: a Settlement lowered an Open Tab. `settlement_id` is the
-- book's own identity for it, shared with `settled` below.
CREATE TABLE IF NOT EXISTS registry.settlement_applied (
  block_hash               registry.hex_word    NOT NULL,
  log_index                INTEGER              NOT NULL,
  settlement_id            registry.hex_word    NOT NULL,
  agent                    registry.hex_address NOT NULL,
  service_id               registry.hex_word    NOT NULL,
  asset                    registry.hex_address NOT NULL,
  applied                  NUMERIC(78,0)        NOT NULL,
  to_prepaid               NUMERIC(78,0)        NOT NULL,
  open_after               NUMERIC(39,0)        NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT settlement_applied_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS settlement_applied_id_idx ON registry.settlement_applied (settlement_id);
CREATE INDEX IF NOT EXISTS settlement_applied_agent_idx ON registry.settlement_applied (agent, asset);
CREATE INDEX IF NOT EXISTS settlement_applied_service_idx ON registry.settlement_applied (service_id, asset);

-- `TabBook.HistoryExtended`: the committed `LimitLib.SettlementRecord`, in full, which is
-- what a `LimitWitness` is rebuilt from.
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
  record_curated           BOOLEAN              NOT NULL,
  record_bonded            BOOLEAN              NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT history_extended_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS history_extended_agent_idx ON registry.history_extended (agent, asset, count);

-- `TabBook.PrepaidConsumed`: a delivery was paid from prepaid credit before it raised the tab.
CREATE TABLE IF NOT EXISTS registry.prepaid_consumed (
  block_hash               registry.hex_word    NOT NULL,
  log_index                INTEGER              NOT NULL,
  agent                    registry.hex_address NOT NULL,
  service_id               registry.hex_word    NOT NULL,
  asset                    registry.hex_address NOT NULL,
  consumed                 NUMERIC(39,0)        NOT NULL,
  prepaid_after            NUMERIC(39,0)        NOT NULL,
  open_added               NUMERIC(39,0)        NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT prepaid_consumed_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS prepaid_consumed_agent_idx ON registry.prepaid_consumed (agent, asset);

-- `TabBook.TabDelinquent`: a Settlement Window closed with the tab still open.
CREATE TABLE IF NOT EXISTS registry.tab_delinquent (
  block_hash               registry.hex_word    NOT NULL,
  log_index                INTEGER              NOT NULL,
  tab_id                   registry.hex_word    NOT NULL,
  agent                    registry.hex_address NOT NULL,
  service_id               registry.hex_word    NOT NULL,
  asset                    registry.hex_address NOT NULL,
  unsettled                NUMERIC(39,0)        NOT NULL,
  window_end               BIGINT               NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT tab_delinquent_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tab_delinquent_tab_idx ON registry.tab_delinquent (tab_id);
CREATE INDEX IF NOT EXISTS tab_delinquent_agent_idx ON registry.tab_delinquent (agent, asset);

-- `TabBook.TabDelinquencyCleared`: the delinquent tab settled to zero.
CREATE TABLE IF NOT EXISTS registry.tab_delinquency_cleared (
  block_hash               registry.hex_word    NOT NULL,
  log_index                INTEGER              NOT NULL,
  tab_id                   registry.hex_word    NOT NULL,
  agent                    registry.hex_address NOT NULL,
  asset                    registry.hex_address NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT tab_delinquency_cleared_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tab_delinquency_cleared_tab_idx ON registry.tab_delinquency_cleared (tab_id);
CREATE INDEX IF NOT EXISTS tab_delinquency_cleared_agent_idx ON registry.tab_delinquency_cleared (agent, asset);

-- `TabBook.AuthorisationSet`: an Agent capped what a Service may meter to its tab.
CREATE TABLE IF NOT EXISTS registry.authorisation_set (
  block_hash               registry.hex_word    NOT NULL,
  log_index                INTEGER              NOT NULL,
  agent                    registry.hex_address NOT NULL,
  service_id               registry.hex_word    NOT NULL,
  asset                    registry.hex_address NOT NULL,
  max_cumulative           NUMERIC(39,0)        NOT NULL,
  expiry                   BIGINT               NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT authorisation_set_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS authorisation_set_agent_idx ON registry.authorisation_set (agent, asset);

-- `TabBook.CreditLimitZeroed`: a delinquency suppressed the Agent's limit in one Asset.
CREATE TABLE IF NOT EXISTS registry.credit_limit_zeroed (
  block_hash               registry.hex_word    NOT NULL,
  log_index                INTEGER              NOT NULL,
  agent                    registry.hex_address NOT NULL,
  asset                    registry.hex_address NOT NULL,
  reason_tab_id            registry.hex_word    NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT credit_limit_zeroed_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS credit_limit_zeroed_agent_idx ON registry.credit_limit_zeroed (agent, asset);

-- `TabSettlement.Settled`: the Asset moved from the Agent to the Service's Collection address.
CREATE TABLE IF NOT EXISTS registry.settled (
  block_hash               registry.hex_word    NOT NULL,
  log_index                INTEGER              NOT NULL,
  settlement_id            registry.hex_word    NOT NULL,
  agent                    registry.hex_address NOT NULL,
  service_id               registry.hex_word    NOT NULL,
  asset                    registry.hex_address NOT NULL,
  amount                   NUMERIC(39,0)        NOT NULL,
  applied                  NUMERIC(39,0)        NOT NULL,
  to_prepaid               NUMERIC(39,0)        NOT NULL,
  collection               registry.hex_address NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT settled_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS settled_id_idx ON registry.settled (settlement_id);
CREATE INDEX IF NOT EXISTS settled_agent_idx ON registry.settled (agent, asset);
CREATE INDEX IF NOT EXISTS settled_service_idx ON registry.settled (service_id, asset);

-- `ServiceRegistry.ServiceRegistered`.
CREATE TABLE IF NOT EXISTS registry.service_registered (
  block_hash               registry.hex_word    NOT NULL,
  log_index                INTEGER              NOT NULL,
  service_id               registry.hex_word    NOT NULL,
  operator                 registry.hex_address NOT NULL,
  tier                     SMALLINT             NOT NULL,
  tier_name                TEXT                 NOT NULL,
  settlement_window        BIGINT               NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT service_registered_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS service_registered_service_idx ON registry.service_registered (service_id);
CREATE INDEX IF NOT EXISTS service_registered_operator_idx ON registry.service_registered (operator);

-- `ServiceRegistry.CollectionRegistered`: where a Service is paid in one Asset.
CREATE TABLE IF NOT EXISTS registry.collection_registered (
  block_hash               registry.hex_word    NOT NULL,
  log_index                INTEGER              NOT NULL,
  service_id               registry.hex_word    NOT NULL,
  asset                    registry.hex_address NOT NULL,
  collection               registry.hex_address NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT collection_registered_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS collection_registered_service_idx ON registry.collection_registered (service_id, asset);
CREATE INDEX IF NOT EXISTS collection_registered_collection_idx ON registry.collection_registered (collection);

-- `ServiceRegistry.CollectionReleased`: a Collection address a Service moved away from.
CREATE TABLE IF NOT EXISTS registry.collection_released (
  block_hash               registry.hex_word    NOT NULL,
  log_index                INTEGER              NOT NULL,
  service_id               registry.hex_word    NOT NULL,
  asset                    registry.hex_address NOT NULL,
  collection               registry.hex_address NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT collection_released_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS collection_released_service_idx ON registry.collection_released (service_id, asset);

-- `ServiceRegistry.ToolPriceSet`.
CREATE TABLE IF NOT EXISTS registry.tool_price_set (
  block_hash               registry.hex_word    NOT NULL,
  log_index                INTEGER              NOT NULL,
  service_id               registry.hex_word    NOT NULL,
  asset                    registry.hex_address NOT NULL,
  tool                     registry.hex_word    NOT NULL,
  base_units               NUMERIC(78,0)        NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT tool_price_set_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tool_price_service_idx ON registry.tool_price_set (service_id, asset);

-- `ServiceRegistry.RegistryChangeQueued`.
CREATE TABLE IF NOT EXISTS registry.registry_change_queued (
  block_hash               registry.hex_word    NOT NULL,
  log_index                INTEGER              NOT NULL,
  change_id                registry.hex_word    NOT NULL,
  service_id               registry.hex_word    NOT NULL,
  change_kind              SMALLINT             NOT NULL,
  change_kind_name         TEXT                 NOT NULL,
  payload                  registry.hex_bytes   NOT NULL,
  eta                      BIGINT               NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT registry_change_queued_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS change_queued_id_idx ON registry.registry_change_queued (change_id);
CREATE INDEX IF NOT EXISTS change_queued_service_idx ON registry.registry_change_queued (service_id, eta);

-- `ServiceRegistry.RegistryChangeApplied`.
CREATE TABLE IF NOT EXISTS registry.registry_change_applied (
  block_hash               registry.hex_word    NOT NULL,
  log_index                INTEGER              NOT NULL,
  change_id                registry.hex_word    NOT NULL,
  service_id               registry.hex_word    NOT NULL,
  change_kind              SMALLINT             NOT NULL,
  change_kind_name         TEXT                 NOT NULL,
  payload                  registry.hex_bytes   NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT registry_change_applied_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS change_applied_id_idx ON registry.registry_change_applied (change_id);
CREATE INDEX IF NOT EXISTS change_applied_service_idx ON registry.registry_change_applied (service_id);

-- `ServiceRegistry.RegistryChangeCancelled`.
CREATE TABLE IF NOT EXISTS registry.registry_change_cancelled (
  block_hash               registry.hex_word    NOT NULL,
  log_index                INTEGER              NOT NULL,
  change_id                registry.hex_word    NOT NULL,
  service_id               registry.hex_word    NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT registry_change_cancelled_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS change_cancelled_id_idx ON registry.registry_change_cancelled (change_id);

-- `Bond.BondFunded`: stake entered the escrow.
CREATE TABLE IF NOT EXISTS registry.bond_funded (
  block_hash               registry.hex_word    NOT NULL,
  log_index                INTEGER              NOT NULL,
  party                    registry.hex_word    NOT NULL,
  asset                    registry.hex_address NOT NULL,
  amount                   NUMERIC(39,0)        NOT NULL,
  depositor                registry.hex_address NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT bond_funded_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS bond_funded_party_idx ON registry.bond_funded (party, asset);

-- `Bond.BondWithdrawn`: stake left the escrow.
CREATE TABLE IF NOT EXISTS registry.bond_withdrawn (
  block_hash               registry.hex_word    NOT NULL,
  log_index                INTEGER              NOT NULL,
  party                    registry.hex_word    NOT NULL,
  asset                    registry.hex_address NOT NULL,
  amount                   NUMERIC(39,0)        NOT NULL,
  -- `to` in the event; a reserved word in SQL, so the column is named for what it is.
  recipient                registry.hex_address NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT bond_withdrawn_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS bond_withdrawn_party_idx ON registry.bond_withdrawn (party, asset);

-- ---------------------------------------------------- ERC-8004 Identity registry
--
-- The canonical ERC-8004 Identity registry is an ERC-721 whose token id is the
-- agentId. It is watched beside Tab's own contracts so an Agent's on-chain identity
-- can be served next to its credit. Four raw tables, one per event, in the same
-- envelope-keyed, cascading shape as everything above, and one view that folds
-- them into the current state per agent. Nothing is written to the view, so a
-- reorganisation that removes a row removes its contribution with it.

-- ERC-721 `Transfer`: the owner of the agent token changed. `from` is the zero
-- address on a mint.
CREATE TABLE IF NOT EXISTS registry.identity_transfer (
  block_hash               registry.hex_word    NOT NULL,
  log_index                INTEGER              NOT NULL,
  -- `from` and `to` in the event; both reserved words in SQL.
  sender                   registry.hex_address NOT NULL,
  recipient                registry.hex_address NOT NULL,
  agent_id                 NUMERIC(78,0)        NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT identity_transfer_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS identity_transfer_agent_idx ON registry.identity_transfer (agent_id);
CREATE INDEX IF NOT EXISTS identity_transfer_recipient_idx ON registry.identity_transfer (recipient);

-- `IdentityRegistry.Registered`: a mint, with the initial agent URI (possibly empty).
CREATE TABLE IF NOT EXISTS registry.identity_registered (
  block_hash               registry.hex_word    NOT NULL,
  log_index                INTEGER              NOT NULL,
  agent_id                 NUMERIC(78,0)        NOT NULL,
  agent_uri                TEXT                 NOT NULL,
  owner                    registry.hex_address NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT identity_registered_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS identity_registered_agent_idx ON registry.identity_registered (agent_id);
CREATE INDEX IF NOT EXISTS identity_registered_owner_idx ON registry.identity_registered (owner);

-- `IdentityRegistry.MetadataSet`: a metadata entry was written. The `agentWallet`
-- key carries the address the agent acts from, ABI-packed, or empty once cleared.
CREATE TABLE IF NOT EXISTS registry.identity_metadata_set (
  block_hash               registry.hex_word    NOT NULL,
  log_index                INTEGER              NOT NULL,
  agent_id                 NUMERIC(78,0)        NOT NULL,
  -- The indexed copy of the key, which reaches a log only as its keccak-256 hash.
  metadata_key_hash        registry.hex_word    NOT NULL,
  metadata_key             TEXT                 NOT NULL,
  metadata_value           registry.hex_bytes   NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT identity_metadata_set_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS identity_metadata_set_agent_idx ON registry.identity_metadata_set (agent_id, metadata_key);

-- `IdentityRegistry.URIUpdated`: `setAgentURI` rewrote the agent card's URI.
CREATE TABLE IF NOT EXISTS registry.identity_uri_updated (
  block_hash               registry.hex_word    NOT NULL,
  log_index                INTEGER              NOT NULL,
  agent_id                 NUMERIC(78,0)        NOT NULL,
  new_uri                  TEXT                 NOT NULL,
  updated_by               registry.hex_address NOT NULL,
  PRIMARY KEY (block_hash, log_index),
  CONSTRAINT identity_uri_updated_event_log_fk FOREIGN KEY (block_hash, log_index)
    REFERENCES registry.event_log (block_hash, log_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS identity_uri_updated_agent_idx ON registry.identity_uri_updated (agent_id);

-- The current identity of every agent the index has seen, keyed by agent id.
--
-- Owner is the recipient of the latest `Transfer`. The URI is whichever of the
-- latest `Registered` and the latest `URIUpdated` came later. The wallet is the
-- latest `agentWallet` metadata write, decoded from its packed twenty bytes, or
-- null once the registry cleared it. Every "latest" is by `(block_number,
-- log_index)`, so two writes in one block resolve in emission order.
--
-- A view rather than a table on purpose: the four tables above are the facts,
-- and a state row of its own would be a second thing to keep right across a
-- reorganisation. `CREATE OR REPLACE` keeps the apply idempotent.
CREATE OR REPLACE VIEW registry.agent_identity AS
WITH owner AS (
  SELECT DISTINCT ON (t.agent_id)
         t.agent_id,
         t.recipient        AS owner,
         l.block_number     AS owner_block
    FROM registry.identity_transfer t
    JOIN registry.event_log l ON l.block_hash = t.block_hash AND l.log_index = t.log_index
   ORDER BY t.agent_id, l.block_number DESC, t.log_index DESC
),
uri_events AS (
  SELECT r.agent_id, r.agent_uri AS uri, l.block_number, r.log_index
    FROM registry.identity_registered r
    JOIN registry.event_log l ON l.block_hash = r.block_hash AND l.log_index = r.log_index
  UNION ALL
  SELECT u.agent_id, u.new_uri AS uri, l.block_number, u.log_index
    FROM registry.identity_uri_updated u
    JOIN registry.event_log l ON l.block_hash = u.block_hash AND l.log_index = u.log_index
),
uri AS (
  SELECT DISTINCT ON (agent_id)
         agent_id,
         uri            AS agent_uri,
         block_number   AS uri_block
    FROM uri_events
   ORDER BY agent_id, block_number DESC, log_index DESC
),
wallet AS (
  SELECT DISTINCT ON (m.agent_id)
         m.agent_id,
         CASE WHEN m.metadata_value ~ '^0x[0-9a-f]{40}$' THEN m.metadata_value ELSE NULL END AS agent_wallet,
         l.block_number AS wallet_block
    FROM registry.identity_metadata_set m
    JOIN registry.event_log l ON l.block_hash = m.block_hash AND l.log_index = m.log_index
   WHERE m.metadata_key = 'agentWallet'
   ORDER BY m.agent_id, l.block_number DESC, m.log_index DESC
),
registered AS (
  SELECT DISTINCT ON (r.agent_id)
         r.agent_id,
         l.block_number AS registered_block
    FROM registry.identity_registered r
    JOIN registry.event_log l ON l.block_hash = r.block_hash AND l.log_index = r.log_index
   ORDER BY r.agent_id, l.block_number ASC, r.log_index ASC
)
SELECT o.agent_id,
       o.owner,
       o.owner_block,
       u.agent_uri,
       u.uri_block,
       w.agent_wallet,
       w.wallet_block,
       reg.registered_block
  FROM owner o
  LEFT JOIN uri u        ON u.agent_id = o.agent_id
  LEFT JOIN wallet w     ON w.agent_id = o.agent_id
  LEFT JOIN registered reg ON reg.agent_id = o.agent_id;
