/**
 * The four MCP tools, declared.
 *
 * This file is the contract. A model reads these schemas to decide what to send
 * and what it will get back, `tools/list` serves them verbatim, every tool
 * validates its input against the schema here before doing any work, and the
 * test suite validates every output against it. There is one declaration of
 * each shape and it lives here, so the published contract and the enforced
 * contract cannot drift apart.
 *
 * ## Amounts are decimal strings, never numbers
 *
 * Every field whose name ends in `BaseUnits` is a string of digits matching
 * {@link BASE_UNITS_PATTERN}. A `uint256` does not survive a double: 2^53 base
 * units of a 6-decimal Asset is about 9 billion units of that Asset, which is
 * inside the range a Credit Limit can reach, and a rounded amount that still
 * looks plausible is the worst possible failure for a billing surface. JSON has
 * no integer type wide enough, so the wire form is a string and the boundary
 * converts.
 *
 * ## Failure is a value, not an exception
 *
 * Every output schema carries an optional `error` object of
 * `{ category, code, message }`. Nothing in this package throws across the MCP
 * boundary, so a tool that cannot do its job returns a schema-valid payload
 * whose `error` says why, and the model can act on it. `tab_call` and
 * `tab_settle` additionally carry a required `ok` boolean, because those two
 * change state and "did it happen" is the first thing a caller must read.
 *
 * `LIMIT_EXCEEDED` is the case that matters most: the Agent has no headroom
 * for the Asset, so the tool answers `ok: false` with both `requiredBaseUnits`
 * and `headroomBaseUnits` populated. That is the difference between a model that
 * decides to settle and a model that guesses.
 */

import type { JsonObjectSchema, JsonSchema } from "./json-schema.js";

/** A `uint256` in decimal, as a string. 78 digits is the ceiling; 39 covers every real amount. */
export const BASE_UNITS_PATTERN = "^[0-9]{1,39}$";
/** A 20-byte address. */
export const ADDRESS_PATTERN = "^0x[a-fA-F0-9]{40}$";
/** A 32-byte word: a serviceId, a tool key, a tabId, a settlement id. */
export const WORD_PATTERN = "^0x[a-fA-F0-9]{64}$";
/** An Asset named with its network: the decimal EVM chain id, a colon, the token address. */
export const ASSET_PATTERN = "^[0-9]+:0x[a-fA-F0-9]{40}$";

const baseUnits = (description: string): JsonSchema => ({
  type: "string",
  pattern: BASE_UNITS_PATTERN,
  description,
});

/**
 * An amount the source may be unable to serve.
 *
 * Null is "this figure was withheld", never "zero". The registry read API
 * withholds a Credit Limit it could not cross-check against `TabBook` rather
 * than serving an unchecked one, and a zero in its place would read as an Agent
 * with no credit -- the opposite of what a withheld figure means.
 */
const nullableBaseUnits = (description: string): JsonSchema => ({
  type: ["string", "null"],
  pattern: BASE_UNITS_PATTERN,
  description,
});

const address = (description: string): JsonSchema => ({ type: "string", pattern: ADDRESS_PATTERN, description });
const word = (description: string): JsonSchema => ({ type: "string", pattern: WORD_PATTERN, description });
const assetRef = (description: string): JsonSchema => ({ type: "string", pattern: ASSET_PATTERN, description });
const nullableString = (description: string): JsonSchema => ({ type: ["string", "null"], description });

/**
 * The failure block every tool can return.
 *
 * `category` is the same nine-value vocabulary `@tabai/shared` uses everywhere
 * else, so a code path that maps a category to an HTTP status on one surface
 * maps it the same way here. `requiredBaseUnits` and `headroomBaseUnits` are
 * present only on `LIMIT_EXCEEDED`.
 */
export const ERROR_SCHEMA: JsonSchema = {
  type: "object",
  description: "Why the call did not do what was asked. Absent when it did.",
  properties: {
    category: {
      type: "string",
      enum: [
        "VALIDATION",
        "AUTHORISATION",
        "NOT_FOUND",
        "LIMIT",
        "CHAIN",
        "UPSTREAM",
        "CONFLICT",
        "UNAVAILABLE",
        "INTERNAL",
      ],
      description:
        "The failure class, in the vocabulary the rest of Tab uses. VALIDATION and NOT_FOUND are the caller's to fix; LIMIT means the Credit Limit or the headroom is exhausted.",
    },
    code: { type: "string", description: "A stable machine-readable code, such as LIMIT_EXCEEDED." },
    message: { type: "string", description: "One sentence a model or a person can act on." },
    retryable: { type: "boolean", description: "Whether repeating the identical call could succeed." },
    requiredBaseUnits: baseUnits("LIMIT_EXCEEDED only: what the call needed, in Asset base units."),
    headroomBaseUnits: baseUnits("LIMIT_EXCEEDED only: what the Agent had, in Asset base units."),
  },
  required: ["category", "code", "message"],
  additionalProperties: false,
};

// ---------------------------------------------------------------- tab_discover

export const TAB_DISCOVER_INPUT: JsonObjectSchema = {
  type: "object",
  description: "Filters over the registered Services. Every field is optional; no filter lists everything.",
  properties: {
    asset: assetRef(
      "Keep only Services that accept this Asset, as `chainId:tokenAddress`, for example `143:0x7547...b603`.",
    ),
    tier: {
      type: "string",
      enum: ["curated", "permissionless", "any"],
      default: "any",
      description:
        "Curation tier. A Curated Service carries more Credit Limit weight; a Permissionless one is registered and unreviewed.",
    },
    search: {
      type: "string",
      maxLength: 128,
      description: "Case-insensitive substring matched against the Service name and its serviceId.",
    },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 25, description: "How many Services to return." },
  },
  required: [],
  additionalProperties: false,
};

const SERVICE_ASSET_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    chainId: { type: "integer", description: "The EVM chain id: 143 is Monad Mainnet, 10143 is Monad Testnet." },
    address: address("The token contract on that chain."),
    symbol: nullableString("Null when this package ships no descriptor for the Asset."),
    decimals: { type: ["integer", "null"], description: "Null when this package ships no descriptor for the Asset." },
    collectionAddress: {
      type: ["string", "null"],
      pattern: ADDRESS_PATTERN,
      description: "Where the Service collects Settlements of this Asset. Null when no Tab Collection resolves.",
    },
    curatedAsset: {
      type: "boolean",
      description:
        "True when this package ships a descriptor for the pair, which is what supplies symbol and decimals. False means the Asset is accepted on chain but unknown here, so its symbol and decimals are null and a caller must not assume six decimals.",
    },
  },
  required: ["chainId", "address", "symbol", "decimals", "collectionAddress", "curatedAsset"],
  additionalProperties: false,
};

const SERVICE_TOOL_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    tool: word("The tool key: the tool name, left-aligned and zero-padded to 32 bytes."),
    toolName: nullableString("The ascii the tool key decodes to, when it decodes to printable ascii."),
    asset: assetRef("The Asset this price is denominated in."),
    priceBaseUnits: baseUnits("What one call costs, in Asset base units."),
  },
  required: ["tool", "toolName", "asset", "priceBaseUnits"],
  additionalProperties: false,
};

const SERVICE_BOND_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    asset: assetRef("The Asset the stake is denominated in."),
    stakedBaseUnits: baseUnits("Total Bond staked for this Asset."),
    freeBaseUnits: baseUnits(
      "Stake the Service can still withdraw. It is what caps the credit its history backs.",
    ),
  },
  required: ["asset", "stakedBaseUnits", "freeBaseUnits"],
  additionalProperties: false,
};

const PENDING_CHANGE_SCHEMA: JsonSchema = {
  type: ["object", "null"],
  description: "The next queued registry change, or null when nothing is queued.",
  properties: {
    changeId: word("The id the RegistryChangeQueued event reported."),
    kind: nullableString("Tier, SettlementWindow, ToolPrice, and so on."),
    etaIso: nullableString("When the timelock lets the change apply."),
  },
  required: ["changeId", "kind", "etaIso"],
  additionalProperties: false,
};

const HUB_ENDPOINT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    endpoint: { type: "string", description: "The provider-relative path, for example `/get_current_weather`." },
    name: nullableString("The Hub's display name for the endpoint."),
    description: nullableString("What the endpoint does, as the Hub describes it."),
    priceType: {
      type: "string",
      description: "How the Hub prices it: PER_CALL, PER_RESULT, PER_UNIT or PER_UNIT_MATRIX. Only PER_CALL has a fixed base-unit price.",
    },
    priceUsd: nullableString("The Hub's decimal USD figure. The metered charge is this plus the fronting Service's margin."),
    priceBaseUnits: nullableBaseUnits("The USD figure as six-decimal base units, for PER_CALL only. Null otherwise."),
    networks: { type: "array", items: { type: "string" }, description: "CAIP-2 networks the Hub takes payment on." },
  },
  required: ["endpoint", "name", "description", "priceType", "priceUsd", "priceBaseUnits", "networks"],
  additionalProperties: false,
};

const SERVICE_HUB_SCHEMA: JsonSchema = {
  type: "object",
  description:
    "The API Hub provider this Service fronts, when it fronts one. Each endpoint is called through the Service at `<endpoint>/hub/<prefix><endpoint path>`, paid upstream by the Service and metered onto the Agent's Open Tab for the upstream price plus the Service's margin.",
  properties: {
    provider: { type: "string", description: "The Hub provider slug." },
    prefix: { type: "string", description: "The mount under the Service endpoint: `/hub/<prefix>`." },
    endpoints: { type: "array", items: HUB_ENDPOINT_SCHEMA },
    total: { type: "integer", description: "How many endpoints the Hub lists for the provider." },
    error: ERROR_SCHEMA,
  },
  required: ["provider", "prefix", "endpoints", "total"],
  additionalProperties: false,
};

export const TAB_DISCOVER_OUTPUT: JsonObjectSchema = {
  type: "object",
  properties: {
    services: {
      type: "array",
      description: "The matching Services. Empty on failure, with `error` populated.",
      items: {
        type: "object",
        properties: {
          serviceId: word("The Service's 32-byte registry key."),
          name: nullableString("The ascii the serviceId decodes to, when it decodes to printable ascii."),
          endpoint: nullableString(
            "Where tab_call sends requests. Null when nothing configured one: the chain records no endpoint, so it comes from tab.config or from the server options.",
          ),
          tier: { type: "string", enum: ["curated", "permissionless", "unknown"] },
          settlementWindowSeconds: {
            type: "integer",
            description: "How long after a Metered Delivery the Agent has to settle before the tab is delinquent.",
          },
          assets: { type: "array", items: SERVICE_ASSET_SCHEMA },
          tools: { type: "array", items: SERVICE_TOOL_SCHEMA },
          bonds: { type: "array", items: SERVICE_BOND_SCHEMA },
          pendingChange: PENDING_CHANGE_SCHEMA,
          hub: SERVICE_HUB_SCHEMA,
        },
        required: [
          "serviceId",
          "name",
          "endpoint",
          "tier",
          "settlementWindowSeconds",
          "assets",
          "tools",
          "bonds",
          "pendingChange",
        ],
        additionalProperties: false,
      },
    },
    error: ERROR_SCHEMA,
  },
  required: ["services"],
  additionalProperties: false,
};

// ---------------------------------------------------------------- tab_call

export const TAB_CALL_INPUT: JsonObjectSchema = {
  type: "object",
  description: "Calls one tool on one Service. The call is metered onto the Agent's Open Tab and paid for later.",
  properties: {
    serviceId: word("The Service to call, as reported by tab_discover."),
    tool: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description: "The tool name, for example `quote.generate`. A 32-byte hex word is accepted too.",
    },
    asset: assetRef("Which Asset to meter in. Defaults to the Service's only priced Asset when it has one."),
    arguments: { type: "object", description: "The tool's own arguments, passed through untouched." },
    timeoutMs: { type: "integer", minimum: 1000, maximum: 120000, default: 30000 },
  },
  required: ["serviceId", "tool"],
  additionalProperties: false,
};

export const TAB_CALL_OUTPUT: JsonObjectSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean", description: "Whether the Service served the call and it was metered." },
    result: { description: "Whatever the Service returned. Absent when ok is false." },
    charge: {
      type: "object",
      description: "What this call cost. Present whenever the Service reported a charge block.",
      properties: {
        amountBaseUnits: baseUnits("Charged when ok is true; required but not charged when ok is false."),
        asset: assetRef("The Asset the charge is denominated in."),
        tool: word("The tool key that was metered."),
      },
      required: ["amountBaseUnits", "asset", "tool"],
      additionalProperties: false,
    },
    tab: {
      type: "object",
      description: "The Agent's position for this Asset, as the Service reported it on this response.",
      properties: {
        openTabBaseUnits: baseUnits("What the Agent now owes for this Asset."),
        headroomBaseUnits: baseUnits("What the Agent may still spend before the Credit Limit binds."),
        creditLimitBaseUnits: baseUnits("The Credit Limit for this Asset, when the response carried one."),
        asset: assetRef("The Asset these figures are denominated in."),
        settlementDueIso: nullableString("When the Settlement Window closes on this tab."),
      },
      required: ["openTabBaseUnits", "headroomBaseUnits", "asset"],
      additionalProperties: false,
    },
    x402: {
      type: "object",
      description:
        "Present when the Service refused the call on credit and it was prepaid through x402 instead, with the signer tab.config's `x402` factory built. Nothing landed on the Open Tab: the call was paid in full, once, by this transaction.",
      properties: {
        txHash: { type: "string", description: "The settlement transaction the facilitator broadcast. Empty when it reported none." },
        network: { type: "string", description: "The CAIP-2 network it settled on, for example `eip155:10143`." },
        amountBaseUnits: baseUnits("What was paid, in atomic units of the asset."),
        asset: assetRef("The token the payment was made in."),
        payTo: address("Where the funds went: the Service's Collection address."),
        payer: address("Who signed: the x402 signer's address."),
        explorerUrl: nullableString("A link to the transaction on the configured explorer."),
      },
      required: ["txHash", "network", "amountBaseUnits", "asset", "payTo", "payer", "explorerUrl"],
      additionalProperties: false,
    },
    error: ERROR_SCHEMA,
  },
  required: ["ok"],
  additionalProperties: false,
};

// ---------------------------------------------------------------- tab_status

export const TAB_STATUS_INPUT: JsonObjectSchema = {
  type: "object",
  description: "The Agent's credit picture: what it owes, what it may still spend, and what has settled.",
  properties: {
    agent: address("The Agent's Monad address. Defaults to the Agent this server is configured for."),
    asset: assetRef("Report only this Asset. Omitted reports every Asset the Agent has touched."),
    historyLimit: { type: "integer", minimum: 0, maximum: 200, default: 20 },
  },
  required: [],
  additionalProperties: false,
};

const PER_ASSET_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    asset: assetRef("The Asset these figures are denominated in."),
    creditLimitBaseUnits: nullableBaseUnits(
      "What this Agent may owe for this Asset at once. Null when the source withheld the figure because it could not cross-check it against TabBook.",
    ),
    openTabBaseUnits: baseUnits("What it owes now."),
    prepaidBaseUnits: nullableBaseUnits(
      "Credit paid in ahead of use, which is drawn on before the Credit Limit. Null when the source serves only cumulative settlement totals and no live balance.",
    ),
    headroomBaseUnits: nullableBaseUnits("What it may still spend. Null whenever the Credit Limit is null."),
    delinquent: { type: "boolean", description: "True while a Settlement Window has closed on an unsettled tab." },
    tabs: {
      type: "array",
      description: "The tabs behind the figures, newest first, capped by historyLimit.",
      items: {
        type: "object",
        properties: {
          tabId: {
            type: ["string", "null"],
            pattern: WORD_PATTERN,
            description:
              "The tab's identity on TabBook. Null when the source reports the observation by Agent, Service and Asset without naming the tab.",
          },
          serviceId: word("The Service the tab is with."),
          openBaseUnits: baseUnits(
            "The Open Tab on this tab, read from TabBook.tabOf at the index horizon. Where the registry serves no live read, the Open Tab left by the tab's last Settlement, which is a lower bound because a Metered Delivery raises a tab without an indexed total.",
          ),
          dueIso: nullableString("When this tab's Settlement Window closes."),
        },
        required: ["tabId", "serviceId", "openBaseUnits", "dueIso"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "asset",
    "creditLimitBaseUnits",
    "openTabBaseUnits",
    "prepaidBaseUnits",
    "headroomBaseUnits",
    "delinquent",
    "tabs",
  ],
  additionalProperties: false,
};

const SETTLEMENT_SCHEMA: JsonSchema = {
  type: "object",
  description: "A Settlement the Agent paid on Monad: the Asset moved to the Service and the Open Tab fell in one transaction.",
  properties: {
    settlementId: word("The Settlement's identity, assigned by TabBook when it was applied."),
    txHash: word("The Monad transaction that paid it."),
    serviceId: word("The Service that was paid."),
    asset: assetRef("The Asset that was paid."),
    amountBaseUnits: baseUnits("How much was paid."),
    appliedBaseUnits: baseUnits("How much of it lowered the Open Tab."),
    prepaidBaseUnits: baseUnits("How much of it was banked as prepaid credit."),
    explorerUrl: nullableString("The transaction on the Monad explorer."),
  },
  required: ["settlementId", "txHash", "serviceId", "asset", "amountBaseUnits", "appliedBaseUnits", "prepaidBaseUnits", "explorerUrl"],
  additionalProperties: false,
};

export const TAB_STATUS_OUTPUT: JsonObjectSchema = {
  type: "object",
  properties: {
    agent: address("The Agent these figures are about."),
    indexedBlock: {
      type: ["integer", "null"],
      minimum: 0,
      description:
        "The Monad block every figure is as at. A Settlement sent a moment ago sits in a later block and is not yet reflected; read again after the index passes it. Null when the index has never ticked.",
    },
    perAsset: { type: "array", items: PER_ASSET_SCHEMA },
    settlements: { type: "array", items: SETTLEMENT_SCHEMA },
    error: ERROR_SCHEMA,
  },
  required: ["agent", "indexedBlock", "perAsset"],
  additionalProperties: false,
};

// ---------------------------------------------------------------- tab_settle

export const TAB_SETTLE_INPUT: JsonObjectSchema = {
  type: "object",
  description:
    "Pays down an Open Tab by calling TabSettlement.settle on Monad with the Agent's own key. This spends real funds unless dryRun is set.",
  properties: {
    serviceId: word("The Service being paid."),
    asset: assetRef("The Asset to pay in, as `chainId:tokenAddress`."),
    amountBaseUnits: baseUnits("How much to pay, in Asset base units."),
    strategyId: { type: "string", maxLength: 64, description: "Which registered payment strategy to settle through." },
    dryRun: {
      type: "boolean",
      default: false,
      description: "Build and validate the Settlement, report what would be sent, and broadcast nothing.",
    },
  },
  required: ["serviceId", "asset", "amountBaseUnits"],
  additionalProperties: false,
};

export const TAB_SETTLE_OUTPUT: JsonObjectSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean", description: "Whether the Settlement was sent, or would have been on a dry run." },
    dryRun: { type: "boolean", description: "True when nothing was sent." },
    txHash: nullableString("The Monad transaction. Null on a dry run and on failure."),
    chainId: { type: ["integer", "null"] },
    amountBaseUnits: baseUnits("What was paid, echoed from the request."),
    strategyId: nullableString("The payment strategy that settled, or would settle on a dry run."),
    note: nullableString(
      "On a dry run, what the strategy would do: its gas, and for a funded strategy the funding step it would take before the Settlement. Null once sent.",
    ),
    settlementId: {
      type: ["string", "null"],
      pattern: WORD_PATTERN,
      description: "The Settlement's identity from the receipt. Null on a dry run, and null when the receipt was not awaited.",
    },
    appliedBaseUnits: nullableString("How much lowered the Open Tab, from the receipt."),
    prepaidBaseUnits: nullableString("How much was banked as prepaid credit, from the receipt."),
    explorerUrl: nullableString("The transaction on the Monad explorer."),
    indexed: {
      type: ["boolean", "null"],
      description:
        "Whether the registry had indexed this Settlement when the tool answered. True: tab_status now reads the tab as paid. False: the read API is still catching up, so read the chain or wait; do not settle again.",
    },
    error: ERROR_SCHEMA,
  },
  required: ["ok", "dryRun", "amountBaseUnits"],
  additionalProperties: false,
};

// ---------------------------------------------------------------- the declaration

/** One tool as `tools/list` serves it. */
export interface TabToolDeclaration {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonObjectSchema;
  readonly outputSchema: JsonObjectSchema;
  /**
   * MCP behaviour hints. `tab_discover` and `tab_status` are read-only;
   * `tab_call` meters onto an Open Tab, and `tab_settle`, which spends funds,
   * is the one destructive tool.
   */
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const TAB_TOOLS: readonly TabToolDeclaration[] = [
  {
    name: "tab_discover",
    title: "Discover Tab Services",
    description:
      "Lists Services registered on Monad, with the Assets each accepts, what each tool costs, and how much stake each has posted. Read-only and keyless. Start here: tab_call needs a serviceId from this list.",
    inputSchema: TAB_DISCOVER_INPUT,
    outputSchema: TAB_DISCOVER_OUTPUT,
    annotations: READ_ONLY,
  },
  {
    name: "tab_call",
    title: "Call a metered tool",
    description:
      "Calls a tool on a Service. Nothing is paid at call time: the charge lands on the Agent's Open Tab and is settled later with tab_settle. When the Agent has no headroom the call returns ok false with code LIMIT_EXCEEDED and both requiredBaseUnits and headroomBaseUnits, which is the signal to settle rather than retry. If tab.config declares an x402 signer and the Service offered x402 on that refusal, the call is prepaid instead and the output carries an x402 block naming the transaction.",
    inputSchema: TAB_CALL_INPUT,
    outputSchema: TAB_CALL_OUTPUT,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "tab_status",
    title: "Read the Agent's credit picture",
    description:
      "Reports the Agent's Credit Limit, Open Tab, prepaid credit and headroom per Asset, plus its recent Settlements. Read-only and keyless.",
    inputSchema: TAB_STATUS_INPUT,
    outputSchema: TAB_STATUS_OUTPUT,
    annotations: READ_ONLY,
  },
  {
    name: "tab_settle",
    title: "Settle an Open Tab",
    description:
      "Pays down an Open Tab by sending a Settlement on Monad with the Agent's own key. This spends real funds. Set dryRun to build and check the Settlement without sending it.",
    inputSchema: TAB_SETTLE_INPUT,
    outputSchema: TAB_SETTLE_OUTPUT,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
];

/** The tool names, in the order `tools/list` serves them. */
export const TAB_TOOL_NAMES = TAB_TOOLS.map((tool) => tool.name);

export const tabToolByName = (name: string): TabToolDeclaration | undefined =>
  TAB_TOOLS.find((tool) => tool.name === name);
