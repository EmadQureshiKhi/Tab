/**
 * `@tabai/agent-demo` is the worked example: two agents trading over the rail end
 * to end, and a smart-account Settlement proving the payer is resolved from
 * `topics[1]` rather than from the transaction sender.
 *
 * It is a demo rather than a library, so the interesting surface is the command
 * in `main.ts` and the README beside it. What is exported here is the part with a
 * claim in it: the cast, the ledger arithmetic, and the payer-resolution verdict.
 * Those are exported so they can be tested without a chain, which is what makes
 * the demo's claims checkable rather than merely observable.
 *
 * Requirements: 8.1, 8.2, 8.3, 12.1, 16.1, 21.2, 22.4, 23.1
 */

export const WORKSPACE_ID_AGENT_DEMO = "@tabai/agent-demo" as const;

export * from "./cast.js";
export * from "./ledger.js";
export * from "./narrate.js";
export * from "./secrets.js";
export * from "./wait.js";
export * from "./settlement.js";
export * from "./chain.js";
export * from "./story.js";
export * from "./acts/index.js";
export * from "./acts/stage.js";
export * from "./acts/authorise.js";
export * from "./acts/consume.js";
export * from "./acts/settle.js";
export * from "./acts/smart-account.js";
export * from "./acts/bind.js";
