/**
 * The x402 payer the Nansen profile buys through: the SDK's client over a key
 * that holds USDC on Monad Mainnet.
 *
 * Each call is limited to a cent and to Mainnet USDC, so an offer in anything
 * else, or a repriced endpoint, is refused before a signature is made. The
 * facilitator submits the transfer and pays its gas, so the key needs no MON.
 * A call that does not answer within twenty seconds is abandoned.
 */

import { Wallet } from "ethers";
import { MAINNET_ASSETS, ok, type Result } from "@tabai/shared";
import { createX402Client } from "@tabai/sdk/x402/client";

import { NANSEN_CALL_CEILING, type PaidCall, type PaidFetch } from "./nansen-profile.js";

const CALL_TIMEOUT_MS = 20_000;

export function createNansenPayer(privateKey: string): { readonly address: string; readonly paidFetch: PaidFetch } {
  const signer = new Wallet(privateKey);
  const client = createX402Client<Response>({
    signer,
    chainId: 143n,
    asset: MAINNET_ASSETS.USDC.address,
    maxAmount: NANSEN_CALL_CEILING,
    fetchImpl: (url, init) => fetch(url, { ...(init as RequestInit), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) }),
  });

  const paidFetch: PaidFetch = async (url, body): Promise<Result<PaidCall>> => {
    const answered = await client.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!answered.ok) return answered;
    const { response, payment } = answered.value;
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    return ok({
      status: response.status,
      body: parsed,
      ...(payment === undefined ? {} : { payment: { amount: payment.amount, asset: payment.asset, txHash: payment.txHash } }),
    });
  };

  return { address: signer.address, paidFetch };
}
