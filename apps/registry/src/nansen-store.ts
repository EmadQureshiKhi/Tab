/**
 * The Postgres side of the Nansen profile: the weekly rows, the payment ledger
 * the daily budget is counted from, and the check that an address is an Agent.
 *
 * A pool of its own, of two connections: the profile is read on a page view and
 * written at most once a week per Agent, and neither should queue behind the
 * indexer's writes or the read API's pool.
 */

import postgres from "postgres";

import type { ProfileStore, StoredProfile } from "./nansen-profile.js";

type Row = Record<string, unknown>;

export class PostgresNansenStore implements ProfileStore {
  private readonly client: postgres.Sql;

  private constructor(client: postgres.Sql) {
    this.client = client;
  }

  static open(databaseUrl: string): PostgresNansenStore {
    return new PostgresNansenStore(postgres(databaseUrl, { max: 2, connect_timeout: 10, onnotice: () => {} }));
  }

  async read(address: string): Promise<{ readonly fetchedAt: Date; readonly profile: StoredProfile } | null> {
    const rows = await this.client<Row[]>`
      SELECT fetched_at, profile FROM registry.nansen_profile WHERE address = ${address}`;
    const row = rows[0];
    if (row === undefined) return null;
    return { fetchedAt: new Date(row.fetched_at as string | Date), profile: row.profile as StoredProfile };
  }

  async write(address: string, fetchedAt: Date, profile: StoredProfile): Promise<void> {
    const json = this.client.json(profile as unknown as postgres.JSONValue);
    await this.client`
      INSERT INTO registry.nansen_profile (address, chain, fetched_at, profile)
      VALUES (${address}, 'monad', ${fetchedAt}, ${json})
      ON CONFLICT (address) DO UPDATE
        SET chain = EXCLUDED.chain, fetched_at = EXCLUDED.fetched_at, profile = EXCLUDED.profile`;
  }

  async recordPayment(payment: {
    readonly address: string;
    readonly endpoint: string;
    readonly amount: bigint;
    readonly asset: string;
    readonly txHash: string | null;
  }): Promise<void> {
    await this.client`
      INSERT INTO registry.nansen_payment (address, endpoint, amount, asset, tx_hash)
      VALUES (${payment.address}, ${payment.endpoint}, ${payment.amount.toString()}, ${payment.asset}, ${payment.txHash})`;
  }

  async spentSince(since: Date): Promise<bigint> {
    const rows = await this.client<Row[]>`
      SELECT COALESCE(SUM(amount), 0)::text AS spent FROM registry.nansen_payment WHERE paid_at >= ${since}`;
    return BigInt(String(rows[0]?.spent ?? "0"));
  }

  async isAgent(address: string): Promise<boolean> {
    const rows = await this.client<Row[]>`
      SELECT EXISTS (SELECT 1 FROM registry.authorisation_set WHERE agent = ${address})
          OR EXISTS (SELECT 1 FROM registry.delivery_recorded WHERE agent = ${address})
          OR EXISTS (SELECT 1 FROM registry.settlement_applied WHERE agent = ${address}) AS known`;
    return rows[0]?.known === true;
  }

  async close(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }
}
