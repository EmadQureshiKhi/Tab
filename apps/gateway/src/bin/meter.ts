/**
 * `pnpm --filter @tabai/gateway meter`
 *
 * Records one real Metered Delivery against the deployed `TabBook`.
 *
 * **Read-only by default.** Without `--broadcast` this simulates the delivery over
 * a keyless `eth_call`, prints exactly what would be charged and what the tab and
 * headroom would become, and spends nothing. That is not a convenience: a refused
 * `recordDelivery` costs real gas and returns the same revert data a simulation
 * returns for free, so paying for it first would be paying for information already
 * available.
 *
 * **Gas is stated, never estimated.** An estimate comes from a warm simulation and
 * underestimates cold-storage writes, and Monad charges the limit rather than the
 * gas used, so a limit that is a little too low comes back `status 0` with
 * `gasUsed == gasLimit` exactly, which is indistinguishable from a refusal unless
 * the two are compared. `recordDelivery` validates a witness, resolves every Bond
 * entry, recomputes the Credit Limit and then writes tab state, and the stated
 * limit sits well above it rather than beside it.
 *
 * Flags:
 *   --broadcast        record the delivery on chain; without it, nothing is spent
 *   --agent 0x…        Agent to charge
 *   --service 0x…      serviceId, 32 bytes, defaulting to GATEWAY_SERVICE_ID
 *   --asset 0x…        Asset contract address, defaulting to MOCK_USDC_ADDRESS
 *   --tool <name>      priced unit name, encoded to bytes32, default "quote.generate"
 *   --units N          how many units, default 1
 *   --gas N            override the stated gas limit
 *
 * Exit codes: 0 the delivery simulated or recorded, 1 it was refused, 2 the run
 * could not start.
 */

import { JsonRpcProvider, Wallet, Interface, encodeBytes32String } from "ethers";

import { loadGatewayConfig, requireOperatorKey } from "../config.js";
import { buildWitness, createWitnessReader, SERVICE_FIELD } from "../witness.js";
import { createTabBookClient, RECORD_DELIVERY_GAS_LIMIT, type MeteredDelivery } from "../tab-book.js";
import { authorisationCovers, readAuthorisation } from "../authorisation.js";

/** Every read here is pinned to one tag, so the witness and the simulation see one chain. */
const BLOCK_TAG = "latest";

/**
 * The priced unit this Service registered by default.
 *
 * Read off the applied price list rather than guessed: `priceOf` reverts
 * `UnknownTool` for any other name.
 */
const DEFAULT_TOOL = "quote.generate";

const argv = process.argv;
const exit = (code: number): void => {
  process.exitCode = code;
};

function flag(name: string): string | undefined {
  const at = argv.indexOf(name);
  if (at === -1) return undefined;
  return argv[at + 1];
}

const has = (name: string): boolean => argv.includes(name);

/** `bytes32` from a short name, or a 32-byte word passed through unchanged. */
function toolWord(raw: string): string {
  return /^0x[0-9a-fA-F]{64}$/.test(raw) ? raw.toLowerCase() : encodeBytes32String(raw);
}

/** `Service` carries no leading `serviceId`; see the note on `SERVICE_ABI` in `witness.ts`. */
const REGISTRY_ABI = [
  "function serviceOf(bytes32 serviceId) view returns ((address operator, uint8 tier, uint32 settlementWindow, address bondAccount, uint64 registeredAt, bool exists) service)",
  "function priceOf(bytes32 serviceId, address asset, bytes32 tool) view returns (uint256 baseUnits)",
  "function tierOf(bytes32 serviceId) view returns (uint8 tier)",
] as const;

async function main(): Promise<number> {
  const config = loadGatewayConfig();
  if (!config.ok) {
    console.error(`meter: ${config.error.code}: ${config.error.message}`);
    return 2;
  }

  const broadcast = has("--broadcast");
  const serviceId = flag("--service") ?? process.env.GATEWAY_SERVICE_ID ?? "";
  const asset = (flag("--asset") ?? process.env.MOCK_USDC_ADDRESS ?? "").toLowerCase();
  const historyFromBlock = Number(process.env.REGISTRY_START_BLOCK ?? "0");
  const tool = toolWord(flag("--tool") ?? DEFAULT_TOOL);
  const unitsRaw = flag("--units") ?? "1";
  const gasOverride = flag("--gas");

  if (!/^0x[0-9a-fA-F]{64}$/.test(serviceId)) {
    console.error("meter: --service (or GATEWAY_SERVICE_ID) must be the Service's 32-byte identifier");
    return 2;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(asset)) {
    console.error("meter: --asset (or MOCK_USDC_ADDRESS) must be a 20-byte 0x address");
    return 2;
  }
  if (!Number.isInteger(historyFromBlock) || historyFromBlock < 0) {
    console.error("meter: REGISTRY_START_BLOCK must be the block the contracts were deployed in");
    return 2;
  }
  if (!/^\d+$/.test(unitsRaw) || Number(unitsRaw) < 1) {
    console.error("meter: --units must be a positive integer");
    return 2;
  }
  const units = Number(unitsRaw);

  const agent = (flag("--agent") ?? "").toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(agent)) {
    console.error("meter: --agent is required and must be the Agent's 20-byte Monad address");
    return 2;
  }

  const provider = new JsonRpcProvider(config.value.rpcUrl, config.value.chainId, {
    batchMaxCount: config.value.batchMaxCount,
    staticNetwork: true,
  });

  try {
    const registry = new Interface([...REGISTRY_ABI]);
    const read = async (data: string): Promise<string> =>
      provider.call({ to: config.value.serviceRegistry, data, blockTag: BLOCK_TAG });

    const service = registry.decodeFunctionResult(
      "serviceOf",
      await read(registry.encodeFunctionData("serviceOf", [serviceId])),
    )[0] as readonly unknown[];
    const operator = String(service[SERVICE_FIELD.operator]);
    const tier = Number(service[SERVICE_FIELD.tier]);

    const unitPrice = BigInt(
      registry.decodeFunctionResult(
        "priceOf",
        await read(registry.encodeFunctionData("priceOf", [serviceId, asset, tool])),
      )[0] as bigint,
    );

    console.error(
      `meter: service operator ${operator}, tier ${tier === 1 ? "Curated" : "Permissionless"}, unit price ${unitPrice} base units`,
    );
    if (unitPrice === 0n) {
      console.error("meter: this tool has no price in the applied price list, so recordDelivery would revert UnknownTool");
      return 2;
    }

    // The witness first, because it is the thing most likely to be wrong and it
    // costs nothing to find out. A witness that does not fold to the on-chain
    // commitment is refused here rather than by a paid-for revert.
    const reader = createWitnessReader(
      provider,
      {
        tabBook: config.value.tabBook,
        bond: config.value.bond,
        serviceRegistry: config.value.serviceRegistry,
      },
      BLOCK_TAG,
      historyFromBlock,
    );
    const built = await buildWitness(reader, agent, asset, { authorised: [serviceId.toLowerCase()] });
    if (!built.ok) {
      console.error(`meter: ${built.error.code}: ${built.error.message}`);
      return 1;
    }
    console.error(
      `meter: witness rebuilt from ${built.value.witness.history.length} HistoryExtended record(s) folds to ${built.value.rebuilt.root}, which is what TabBook holds`,
    );
    for (const entry of built.value.witness.bonds) {
      console.error(`meter:   counterparty ${entry.serviceId} staked ${entry.amount}`);
    }

    const charge = BigInt(units) * unitPrice;

    const authorisation = await readAuthorisation(
      provider,
      config.value.tabBook,
      agent,
      serviceId,
      asset,
      BLOCK_TAG,
    );
    if (!authorisation.ok) {
      console.error(`meter: ${authorisation.error.code}: ${authorisation.error.message}`);
      return 1;
    }
    console.error(
      `meter: authorisation exists=${authorisation.value.exists} ceiling=${authorisation.value.maxCumulative} spent=${authorisation.value.spent} remaining=${authorisation.value.remaining} expiry=${authorisation.value.expiry}`,
    );
    const block = await provider.getBlock(BLOCK_TAG);
    const covers = authorisationCovers(authorisation.value, charge, BigInt(block?.timestamp ?? 0));
    if (!covers.ok) {
      console.error(`meter: ${covers.error.code}: ${covers.error.message}`);
      if (covers.error.code === "AUTHORISATION_MISSING") {
        console.error(
          `meter: the Agent itself must send: cast send --private-key <AGENT_PRIVATE_KEY> ${config.value.tabBook} "authorise(bytes32,address,uint128,uint64)" ${serviceId} ${asset} <ceiling> <expiry> --gas-limit 400000`,
        );
      }
      return 1;
    }

    const signer =
      broadcast && config.value.operatorKey !== undefined
        ? new Wallet(config.value.operatorKey, provider)
        : undefined;
    if (broadcast && signer === undefined) {
      const key = requireOperatorKey(config.value);
      console.error(`meter: ${key.ok ? "GATEWAY_KEY_MISSING" : key.error.code}: a broadcast needs the Service operator key`);
      return 2;
    }
    if (signer !== undefined) {
      const from = (await signer.getAddress()).toLowerCase();
      if (from !== operator.toLowerCase()) {
        console.error(
          `meter: GATEWAY_PRIVATE_KEY is ${from} but the Service operator is ${operator}, so recordDelivery would revert NotServiceOperator`,
        );
        return 2;
      }
    }

    const gasLimit = gasOverride !== undefined && /^\d+$/.test(gasOverride) ? BigInt(gasOverride) : RECORD_DELIVERY_GAS_LIMIT;
    const client = createTabBookClient({
      provider,
      tabBook: config.value.tabBook,
      blockTag: BLOCK_TAG,
      witnessFor: async () => ({ ok: true, value: built.value.witness }),
      gasLimit,
      // Without this the simulation runs as the zero address and is refused
      // `NotServiceOperator` before it can report a charge.
      simulateFrom: operator,
      ...(signer === undefined ? {} : { signer }),
    });

    const delivery: MeteredDelivery = { agent, serviceId, asset, tool, units, expectedUnitPrice: unitPrice };

    const limit = await client.creditLimit(agent, asset);
    console.error(`meter: Credit Limit ${limit.ok ? limit.value : `unreadable (${limit.error.code})`}`);

    const simulated = await client.simulateDelivery(delivery);
    if (!simulated.ok) {
      console.error(`meter: ${simulated.error.code}: ${simulated.error.message}`);
      return 1;
    }
    console.error(
      `meter: SIMULATED charge ${simulated.value.charged}, Open Tab after ${simulated.value.openAfter}, headroom after ${simulated.value.headroomAfter}`,
    );

    if (!broadcast) {
      console.log(
        JSON.stringify(
          {
            mode: "simulate",
            agent,
            serviceId,
            asset,
            tool,
            units,
            unitPrice: unitPrice.toString(10),
            charge: charge.toString(10),
            creditLimit: limit.ok ? limit.value.toString(10) : null,
            wouldCharge: simulated.value.charged.toString(10),
            openTabAfter: simulated.value.openAfter.toString(10),
            headroomAfter: simulated.value.headroomAfter.toString(10),
            gasLimitThatWouldBeStated: gasLimit.toString(10),
            witness: {
              historyLength: built.value.witness.history.length,
              root: built.value.rebuilt.root,
              matchesChain: true,
            },
          },
          null,
          2,
        ),
      );
      console.error("meter: simulate only; pass --broadcast to record the delivery on chain");
      return 0;
    }

    const recorded = await client.recordDelivery(delivery);
    if (!recorded.ok) {
      console.error(`meter: ${recorded.error.code}: ${recorded.error.message}`);
      return 1;
    }
    console.log(
      JSON.stringify(
        {
          mode: "broadcast",
          monadTxHash: recorded.value.monadTxHash,
          charged: recorded.value.charged.toString(10),
          openTabAfter: recorded.value.openAfter.toString(10),
          headroomAfter: recorded.value.headroomAfter.toString(10),
          gasLimitStated: gasLimit.toString(10),
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    console.error(`meter: the run failed: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  } finally {
    provider.destroy();
  }
}

exit(await main());
