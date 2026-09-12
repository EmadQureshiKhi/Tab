/**
 * The WASM entry point. The SDK executes `main()` itself and reports a
 * rejection, so nothing here calls it.
 */

import { Runner } from "@chainlink/cre-sdk";

import { configSchema, initWorkflow } from "./workflow.js";

export async function main() {
  // Inferred from the schema: its input allows the defaults to be absent and
  // its output is the `Config` every handler reads.
  const runner = await Runner.newRunner({ configSchema });
  await runner.run(initWorkflow);
}
