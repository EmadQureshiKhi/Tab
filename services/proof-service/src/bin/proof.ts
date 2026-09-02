/**
 * `pnpm --filter @tabai/proof-service proof`
 *
 * Buys one proof from this Service end to end, without a socket: fetch the material
 * from the Proof Builder, gate it on the attested frontier, fold the Merkle path
 * locally, and then meter the delivery against `TabBook` exactly as the served app
 * would.
 *
 * **Read-only by default.** Without `--broadcast` the delivery is simulated over a
 * keyless `eth_call` presenting the operator's address as `from`, which prints what
 * would be charged and what the tab and headroom would become, and spends nothing.
 * That is not a convenience: a refused `recordDelivery` costs real CTC and returns
 * the same revert data a simulation returns for free.
 *
 * **The proof material is never printed on a read-only run.** Simulating a charge
 * is not paying one, and a driver that prints the goods when nothing was metered
 * would be the shortcut R22.3 exists to forbid. What it prints instead is the shape
 * of the material: the height, the derived root, the path depth, and the Continuity
 * Proof length.
 *
 * **The proof's Source Chain and the billing Asset are separate choices.** A proof
 * about an Ethereum Mainnet transaction can be sold for USDC on Sepolia, because the
 * tab is denominated in whatever Asset the Agent authorised and the proof is about
 * whatever chain the Agent asked about. Conflating the two would make the Asset a
 * function of the request, which no price list is.
 *
 * Flags:
 *   --broadcast          record the Metered Delivery on chain; without it nothing is spent
 *   --agent 0x…          the Agent to charge, 20 bytes
 *   --tx 0x…             the Source Chain transaction to prove, 32 bytes
 *   --chain-key N        the Source Chain the proof is about, default 1
 *   --asset-chain-key N  the chain the Asset the tab is billed in lives on, default 1
 *   --height N           the block the transaction sits in, gating before any fetch
 *   --show-material      print the full material, allowed only alongside --broadcast
 *
 * Exit codes: 0 the delivery simulated or recorded, 1 it was refused, 2 the run
 * could not start.
 */

import { Wallet } from "ethers";

import { loadProofServiceConfig, requireOperatorKey } from "../config.js";
import { createRuntime, assetFor, proofToolWord } from "../runtime.js";
import { readAuthorisation, authorisationCovers } from "../authorisation.js";
import { BLOCK_TAG } from "../runtime.js";
import type { MeteredDelivery } from "../tab-book.js";

const argv = process.argv;

function flag(name: string): string | undefined {
  const at = argv.indexOf(name);
  if (at === -1) return undefined;
  return argv[at + 1];
}

const has = (name: string): boolean => argv.includes(name);

async function main(): Promise<number> {
  const config = loadProofServiceConfig();
  if (!config.ok) {
    console.error(`proof: ${config.error.code}: ${config.error.message}`);
    return 2;
  }

  const broadcast = has("--broadcast");
  const showMaterial = has("--show-material");

  const agent = (flag("--agent") ?? "").toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(agent)) {
    console.error("proof: --agent is required and must be the Agent's 20-byte Creditcoin address");
    return 2;
  }

  const sourceTxHash = (flag("--tx") ?? "").toLowerCase();
  if (!/^0x[0-9a-fA-F]{64}$/.test(sourceTxHash)) {
    console.error("proof: --tx is required and must be a 32-byte Source Chain transaction hash");
    return 2;
  }

  const chainKeyRaw = flag("--chain-key") ?? "1";
  if (!/^\d+$/.test(chainKeyRaw)) {
    console.error("proof: --chain-key must be a decimal chainKey; 1 is Sepolia and 3 is Mainnet");
    return 2;
  }
  const chainKey = BigInt(chainKeyRaw);

  // The Asset the tab is billed in, which is not a function of the chain the proof
  // is about. An Agent can buy a Mainnet proof and be charged in Sepolia USDC.
  const assetChainKeyRaw = flag("--asset-chain-key") ?? "1";
  if (!/^\d+$/.test(assetChainKeyRaw)) {
    console.error("proof: --asset-chain-key must be a decimal chainKey; 1 is Sepolia and 3 is Mainnet");
    return 2;
  }

  const heightRaw = flag("--height");
  if (heightRaw !== undefined && !/^\d+$/.test(heightRaw)) {
    console.error("proof: --height must be a decimal block number");
    return 2;
  }

  const asset = assetFor(config.value, BigInt(assetChainKeyRaw));
  if (!asset.ok) {
    console.error(`proof: ${asset.error.code}: ${asset.error.message}`);
    return 2;
  }

  // A key is loaded only for a broadcast. A read-only run needs the operator's
  // address and not its key, and the address is public.
  let signer: Wallet | undefined;
  if (broadcast) {
    const key = requireOperatorKey(config.value);
    if (!key.ok) {
      console.error(`proof: ${key.error.code}: ${key.error.message}`);
      return 2;
    }
    signer = new Wallet(key.value);
  }

  const operator = flag("--operator")?.toLowerCase();
  const readOnly = createRuntime({ config: config.value });
  const runtime =
    signer === undefined
      ? readOnly
      : createRuntime({
          config: config.value,
          signer: signer.connect(readOnly.provider),
          simulateFrom: await signer.getAddress(),
        });
  const simulateFrom = signer === undefined ? operator : await signer.getAddress();
  if (simulateFrom === undefined) {
    console.error(
      "proof: a keyless run simulates as the zero address, which the operator gate refuses; pass --operator 0x… with the Service operator's public address",
    );
    return 2;
  }

  const simulating =
    signer === undefined
      ? createRuntime({ config: config.value, simulateFrom })
      : runtime;

  console.error(
    `proof: chainKey ${chainKey.toString(10)}, transaction ${sourceTxHash}, agent ${agent}, ${broadcast ? "BROADCAST" : "simulate only"}`,
  );

  // 1. Build the material. This is the delivery, and it happens before any charge.
  const delivered = await simulating.deliverer.deliver({
    chainKey,
    sourceTxHash,
    ...(heightRaw === undefined ? {} : { blockHeight: BigInt(heightRaw) }),
  });
  if (!delivered.ok) {
    console.error(`proof: ${delivered.error.code}: ${delivered.error.message}`);
    if (delivered.error.details !== undefined) {
      console.error(`proof: details ${JSON.stringify(delivered.error.details)}`);
    }
    // R22.5: an unattested height is a refusal with nothing metered. Saying so
    // plainly is the point of the driver.
    console.error("proof: nothing was metered");
    return 1;
  }

  const material = delivered.value;
  console.error(
    `proof: material built at height ${material.blockHeight}, txIndex ${material.txIndex}, path depth ${material.check.depth}, continuity roots ${material.continuityProof.roots.length}, attested frontier ${material.attestation.attestedHeight}`,
  );
  console.error(`proof: derived root ${material.check.derivedRoot} matches the builder's stated root`);
  if (!material.check.txIndexAgrees) {
    console.error(
      `proof: the builder states txIndex ${material.txIndexFromSource} and the sibling laterality encodes ${material.txIndex}; the precompile recomputes it from the path, so the path wins`,
    );
  }

  // 2. Report the Agent's own consent before spending anything on its behalf.
  const authorisation = await readAuthorisation(
    simulating.provider,
    config.value.tabBook,
    agent,
    config.value.serviceId,
    asset.value.address,
    BLOCK_TAG,
  );
  if (authorisation.ok) {
    const covers = authorisationCovers(
      authorisation.value,
      config.value.unitPrice,
      BigInt(Math.floor(Date.now() / 1000)),
    );
    console.error(
      covers.ok
        ? `proof: the Agent's authorisation leaves ${authorisation.value.remaining.toString(10)} of ${authorisation.value.maxCumulative.toString(10)} base units`
        : `proof: ${covers.error.code}: ${covers.error.message}`,
    );
  } else {
    console.error(`proof: ${authorisation.error.code}: ${authorisation.error.message}`);
  }

  // 3. Meter it. Simulated first, always, whether or not a broadcast follows.
  const delivery: MeteredDelivery = {
    agent,
    serviceId: config.value.serviceId,
    asset: asset.value.address,
    tool: proofToolWord(),
    units: 1,
    expectedUnitPrice: config.value.unitPrice,
  };

  const simulated = await simulating.tabBook.simulateDelivery(delivery);
  if (!simulated.ok) {
    console.error(`proof: ${simulated.error.code}: ${simulated.error.message}`);
    console.error("proof: nothing was metered and no material is released");
    return 1;
  }
  console.error(
    `proof: simulated charge ${simulated.value.charged.toString(10)} base units, open tab would become ${simulated.value.openAfter.toString(10)}, headroom ${simulated.value.headroomAfter.toString(10)}`,
  );

  if (!broadcast) {
    console.error(
      "proof: read-only run, so nothing was recorded and the material is not released; re-run with --broadcast to buy it",
    );
    return 0;
  }

  const recorded = await runtime.tabBook.recordDelivery(delivery);
  if (!recorded.ok) {
    console.error(`proof: ${recorded.error.code}: ${recorded.error.message}`);
    console.error("proof: nothing was metered and no material is released");
    return 1;
  }
  console.error(
    `proof: recorded ${recorded.value.charged.toString(10)} base units in ${recorded.value.creditcoinTxHash ?? "an unnamed transaction"}, open tab ${recorded.value.openAfter.toString(10)}`,
  );

  if (showMaterial) {
    process.stdout.write(`${JSON.stringify(material, null, 2)}\n`);
  } else {
    console.error("proof: pass --show-material to print the bytes that were paid for");
  }
  return 0;
}

process.exitCode = await main();
