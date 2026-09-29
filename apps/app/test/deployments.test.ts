/**
 * The Dashboard's built-in deployment table, held against `deployments.json`.
 *
 * The table is a copy because the Dashboard is deployed from its own directory
 * and cannot read the record at run time. A copy drifts the day somebody
 * redeploys and updates only one side, and the page would then read a contract
 * the record no longer names. This is what makes that a failing build instead.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { DEPLOYMENTS, MAINNET_DEPLOYMENT, TESTNET_DEPLOYMENT } from "../src/dashboard/deployments";

const RECORD = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "deployments.json");

interface RecordedNetwork {
  readonly chainId: number;
  readonly startBlock: number;
  readonly contracts: Readonly<Record<string, { readonly address: string }>>;
  readonly roles: { readonly curationAuthority: { readonly address: string } };
}

function recorded(chainId: number): RecordedNetwork {
  const record = JSON.parse(readFileSync(RECORD, "utf8")) as { networks: Record<string, RecordedNetwork> };
  const network = record.networks[String(chainId)];
  if (network === undefined) throw new Error(`deployments.json has no entry for chain ${chainId}`);
  return network;
}

const lower = (address: string | undefined): string | undefined => address?.toLowerCase();

for (const deployment of [TESTNET_DEPLOYMENT, MAINNET_DEPLOYMENT]) {
  test(`the chain ${deployment.chainId} table is the one deployments.json records`, () => {
    if (!existsSync(RECORD)) return;
    const network = recorded(deployment.chainId);
    assert.equal(network.chainId, deployment.chainId);
    assert.equal(lower(network.contracts["ServiceRegistry"]?.address), deployment.serviceRegistry);
    assert.equal(lower(network.contracts["Bond"]?.address), deployment.bond);
    assert.equal(lower(network.contracts["TabBook"]?.address), deployment.tabBook);
    assert.equal(lower(network.contracts["TabSettlement"]?.address), deployment.tabSettlement);
    assert.equal(lower(network.contracts["MockUsdc"]?.address), deployment.mockUsdc);
    assert.equal(lower(network.roles.curationAuthority.address), deployment.curationAuthority);
    assert.equal(network.startBlock, deployment.startBlock);
  });
}

test("every recorded network is in the table, keyed by its own chain id", () => {
  if (!existsSync(RECORD)) return;
  const record = JSON.parse(readFileSync(RECORD, "utf8")) as { networks: Record<string, RecordedNetwork> };
  assert.deepEqual(Object.keys(record.networks).sort(), Object.keys(DEPLOYMENTS).sort());
  for (const [key, deployment] of Object.entries(DEPLOYMENTS)) assert.equal(String(deployment.chainId), key);
});

test("the table holds lowercase addresses, and a test token on Testnet only", () => {
  for (const deployment of Object.values(DEPLOYMENTS)) {
    for (const address of [
      deployment.serviceRegistry,
      deployment.bond,
      deployment.tabBook,
      deployment.tabSettlement,
      deployment.curationAuthority,
    ]) {
      assert.match(address, /^0x[0-9a-f]{40}$/);
    }
  }
  assert.notEqual(TESTNET_DEPLOYMENT.mockUsdc, undefined);
  assert.equal(MAINNET_DEPLOYMENT.mockUsdc, undefined);
});
