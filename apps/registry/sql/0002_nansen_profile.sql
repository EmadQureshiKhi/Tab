-- Nansen profiles, bought per call over x402 and kept for a week.
--
-- Applied after 0001, by the same `db:apply`. Every statement is guarded, so
-- applying it twice is a no-op.
--
-- These two tables are not indexed from the chain, so neither keys on the event
-- envelope nor cascades from `event_log`, and a reorganisation leaves them alone.
-- They are an overlay the Dashboard shows beside the indexed facts: what Nansen
-- said about an Agent's address, when, and what it cost to ask.
--
-- **`nansen_profile`** holds one row per address: the profile as served, and the
-- time Nansen answered. A row younger than a week is served as it is, to every
-- reader, without asking Nansen again; an older one is refreshed on the next
-- read. Kept in the database rather than in memory so a redeploy or a restart
-- does not pay for the same answer twice.
--
-- **`nansen_payment`** records every x402 payment made to Nansen, whether or not
-- the answer was usable, so the daily budget counts what was actually spent.

CREATE TABLE IF NOT EXISTS registry.nansen_profile (
  address     registry.hex_address PRIMARY KEY,
  chain       TEXT        NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL,
  profile     JSONB       NOT NULL
);

CREATE TABLE IF NOT EXISTS registry.nansen_payment (
  id          BIGSERIAL PRIMARY KEY,
  address     registry.hex_address NOT NULL,
  endpoint    TEXT          NOT NULL,
  amount      NUMERIC(78,0) NOT NULL,
  asset       registry.hex_address NOT NULL,
  tx_hash     TEXT,
  paid_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nansen_payment_paid_at_idx ON registry.nansen_payment (paid_at);
