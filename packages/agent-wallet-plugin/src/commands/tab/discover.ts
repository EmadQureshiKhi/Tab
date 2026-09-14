/**
 * `mm tab discover`: the Services registered on Monad, what each tool costs,
 * and the Bond each has staked. A keyless read, so it declares no capability.
 */

import {
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import type { Interfaces } from "@oclif/core";
import type { TabDiscoverOutput } from "@tabai/sdk";

import { settingsOrThrow, unwrap } from "../../boundary.js";
import { runDiscover } from "../../tab/reads.js";

const inputs = {
  asset: {
    type: InputFieldType.Text,
    flag: "asset",
    message: "Only Services accepting this Asset (chainId:0xaddress, or an address on the configured chain)",
    required: false,
    prompt: false,
  },
  tier: {
    type: InputFieldType.Select,
    flag: "tier",
    message: "Curation tier",
    required: false,
    prompt: false,
    options: [
      { value: "any", label: "any" },
      { value: "curated", label: "curated" },
      { value: "permissionless", label: "permissionless" },
    ],
  },
  search: {
    type: InputFieldType.Text,
    flag: "search",
    message: "Substring of a Service id or name",
    required: false,
    prompt: false,
  },
  limit: {
    type: InputFieldType.Text,
    flag: "limit",
    message: "How many Services to return (1 to 100)",
    required: false,
    prompt: false,
  },
} satisfies InputSchema;

export default class TabDiscover extends PluginCommand<TabDiscoverOutput> {
  static override description = "List the Services registered on Monad, the Assets each accepts, what each tool costs, and the Bond each has staked. Needs no wallet.";

  static override examples = [
    "<%= config.bin %> tab discover",
    "<%= config.bin %> tab discover --tier curated --limit 10",
    "<%= config.bin %> tab discover --asset 0x480209747417f5c830fda188a9b9acfa70bc4083 --json",
  ];

  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags: Interfaces.FlagInput = schemaToFlags(inputs);
  static override args: Interfaces.ArgInput = schemaToArgs(inputs);

  protected readonly pluginCommandId = "tab:discover";

  async execute(io: CommandIO): Promise<TabDiscoverOutput> {
    const { asset, tier, search, limit } = await io.resolveInputs(inputs);
    const settings = settingsOrThrow();
    return unwrap(
      await runDiscover(
        { settings },
        {
          ...(asset ? { asset } : {}),
          ...(tier ? { tier } : {}),
          ...(search ? { search } : {}),
          ...(limit ? { limit } : {}),
        },
      ),
    );
  }

  override successHint(data: TabDiscoverOutput): string {
    return data.services.length === 0
      ? "No Service matched. Widen the filter, or check NEXT_PUBLIC_REGISTRY_API_URL."
      : `${data.services.length} Service${data.services.length === 1 ? "" : "s"}. Call one with: mm tab call <serviceId> <tool>`;
  }
}
