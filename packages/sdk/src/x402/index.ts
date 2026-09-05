/**
 * x402, the prepaid protocol, as a fallback beside Tab's credit and as an
 * upstream a Tab Service can front.
 *
 * - `wire.ts` is the V2 wire format: the three headers, the codecs from
 *   `@x402/core`, and the one selector that decides which `accepts` entry this
 *   package can sign.
 * - `client.ts` signs an EIP-3009 authorization with an ethers signer and
 *   repeats a request with it. The Tab 402 client and `tab_call` use it when a
 *   credit refusal carries `PAYMENT-REQUIRED` and an x402 signer is configured.
 * - `server.ts` builds the requirement a Tab `402` can offer and takes a signed
 *   payment through a facilitator: verify, deliver, settle.
 * - `proxy.ts` fronts an x402 upstream: the Service pays it and meters the Agent.
 * - `hub.ts` reads Monad's API Hub manifest so `tab_discover` can list a
 *   fronted provider's endpoints as tools.
 *
 * Nothing here throws. The official `@x402/core` is used for types, header
 * codecs and the facilitator HTTP client; the EIP-3009 signing and the
 * fronting logic are this package's own and are documented against the
 * specification in each file.
 */

export * from "./wire.js";
export * from "./client.js";
export * from "./server.js";
export * from "./proxy.js";
export * from "./hub.js";
