-- Watcher persistence, initial migration.
--
-- This is design section 8.7 verbatim, with `IF NOT EXISTS` added so applying it
-- twice is a no-op. It is the SQL half of `src/db/schema.ts`; `test/schema.test.mjs`
-- checks the two against each other so they cannot drift.
--
-- Apply with:  pnpm --filter @tabai/watcher db:migrate     (needs DATABASE_URL)
--
-- Requirements: 20.6, 20.7, 20.9, 20.11, 20.12

CREATE TABLE IF NOT EXISTS observed_settlement (
  replay_key            BYTEA PRIMARY KEY,          -- packed 32 bytes
  chain_key             BIGINT NOT NULL,
  block_height          BIGINT NOT NULL,
  tx_index              BIGINT,                     -- null until proof material exists
  log_index             BIGINT NOT NULL,
  source_tx_hash        BYTEA NOT NULL,
  asset                 BYTEA NOT NULL,
  payer_address         BYTEA NOT NULL,
  collection_address    BYTEA NOT NULL,
  service_id            BYTEA NOT NULL,
  amount                NUMERIC(39,0) NOT NULL,
  state                 TEXT NOT NULL,              -- OBSERVED|PROVISIONAL|READY|SUBMITTED|CONFIRMED|WITHHELD|HALTED
  attested_digest       BYTEA,                      -- digest observed at Provisional Clearing time
  clearing_id           BYTEA,
  proof_source          TEXT,                       -- PROOF_BUILDER|RAW_BUILDER
  local_root            BYTEA,
  received_root         BYTEA,
  submit_attempts       INT NOT NULL DEFAULT 0,
  next_attempt_at       TIMESTAMPTZ,
  cc_tx_hash            BYTEA,
  last_error_category   TEXT,
  observed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chain_cursor (
  chain_key             BIGINT PRIMARY KEY,
  last_processed_block  BIGINT NOT NULL,
  last_attested_height  BIGINT NOT NULL,
  attesting             BOOLEAN NOT NULL DEFAULT true,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS endpoint_health (
  chain_key             BIGINT NOT NULL,
  endpoint_url          TEXT NOT NULL,
  consecutive_failures  INT NOT NULL DEFAULT 0,
  active                BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (chain_key, endpoint_url)
);

-- "What is due now?" — the retry loop's only query.
CREATE INDEX IF NOT EXISTS observed_state_idx ON observed_settlement (state, next_attempt_at);
-- "What did I see in this block range?" — gap catch-up after a restart.
CREATE INDEX IF NOT EXISTS observed_chain_block_idx ON observed_settlement (chain_key, block_height);
