/**
 * Which Monad chain a passkey account signs on, and how its MON is read.
 *
 * ## The chain is the deployment's
 *
 * An injected wallet is on whichever chain its owner left it on, and the
 * masthead reports that. A passkey account is on no chain at all: it signs
 * whatever chain id it is handed. So it takes the deployment's chain, which
 * the server knows from `MONAD_CHAIN_ID` and the browser bundle cannot see.
 * `NEXT_PUBLIC_MONAD_CHAIN_ID` is the same fact made visible to the client,
 * and a page that asks the account to sign passes the deployment's chain and
 * endpoint again through `ensureChain`, so the two can never disagree for
 * long: the page's own values win the moment it asks to sign.
 *
 * ## The balance is a read, never a guess
 *
 * `eth_getBalance` against the endpoint, returned as a `Result`. A read that
 * failed is reported as a failure, not as zero, because a reader deciding
 * whether to visit the faucet needs to know the difference.
 */

import { JsonRpcProvider, formatUnits } from "ethers";

import { MONAD_CHAINS, MONAD_TESTNET_CHAIN, type ChainSpec } from "../wallet/eip1193";
import { type Result, err, ok } from "../wallet/result";

/** Where the MON faucet is. Testnet only; on Mainnet MON is bought, not asked for. */
export const MONAD_FAUCET_URL = "https://faucet.monad.xyz";

/** The chain and endpoint a passkey account signs against. */
export interface PasskeyChain {
  readonly id: number;
  readonly name: string;
  readonly rpcUrl: string;
  readonly testnet: boolean;
}

function fromSpec(spec: ChainSpec, rpcUrl: string | undefined): PasskeyChain {
  const endpoint = rpcUrl?.trim();
  return {
    id: spec.id,
    name: spec.name,
    // Both Monad entries in the table carry an endpoint; the fallback only
    // satisfies the optional field on the type.
    rpcUrl: endpoint !== undefined && endpoint.length > 0 ? endpoint : (spec.rpcUrl ?? ""),
    testnet: spec.id === MONAD_TESTNET_CHAIN.id,
  };
}

/** A chain from the two Monad networks, with the endpoint given or the network's own. */
export function passkeyChainFor(chainId: number, rpcUrl?: string | undefined): PasskeyChain | undefined {
  const spec = MONAD_CHAINS[chainId];
  return spec === undefined ? undefined : fromSpec(spec, rpcUrl);
}

/**
 * The deployment's chain as the client bundle sees it.
 *
 * Only `NEXT_PUBLIC_` names are inlined into the client, so these two are the
 * browser-side mirror of `MONAD_CHAIN_ID` and `MONAD_RPC_URL`. Unset, they
 * fall back to Testnet exactly as `parseChainId` does on the server, because
 * the cost of mistaking testnet for mainnet is smaller than the reverse.
 */
export function defaultPasskeyChain(): PasskeyChain {
  const raw = process.env["NEXT_PUBLIC_MONAD_CHAIN_ID"]?.trim();
  const parsed = raw !== undefined && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  const rpc = process.env["NEXT_PUBLIC_MONAD_RPC_URL"];
  return passkeyChainFor(parsed, rpc) ?? fromSpec(MONAD_TESTNET_CHAIN, rpc);
}

/** A provider pinned to one chain, so a wrong endpoint fails loudly rather than signing elsewhere. */
export function providerFor(chain: PasskeyChain): JsonRpcProvider {
  return new JsonRpcProvider(chain.rpcUrl, chain.id, { staticNetwork: true });
}

/** The account's MON, in wei. */
export async function readNativeBalance(chain: PasskeyChain, address: string): Promise<Result<bigint>> {
  const provider = providerFor(chain);
  try {
    return ok(await provider.getBalance(address));
  } catch (cause) {
    const detail = cause instanceof Error && cause.message.trim().length > 0 ? cause.message : "no reason given";
    return err(`The balance could not be read from ${chain.name}: ${detail}`);
  } finally {
    provider.destroy();
  }
}

/**
 * Wei as `1.2345 MON`: four decimals, trailing zeros kept so the column
 * lines up, and never rounded up to a figure the account does not hold.
 */
export function formatMon(wei: bigint): string {
  const full = formatUnits(wei, 18);
  const [whole = "0", fraction = ""] = full.split(".");
  const cut = fraction.padEnd(4, "0").slice(0, 4);
  return `${whole}.${cut} MON`;
}
