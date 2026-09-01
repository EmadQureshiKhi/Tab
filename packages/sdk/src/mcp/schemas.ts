/**
 * The four MCP tools, declared. (R25.1, R25.2)
 *
 * This file is the contract. A model reads these schemas to decide what to send
 * and what it will get back, `tools/list` serves them verbatim, every tool
 * validates its input against the schema here before doing any work, and the
 * task 16.3 tests validate every output against it. There is one declaration of
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
 * `LIMIT_EXCEEDED` is the case the design singles out: the Agent has no headroom
 * for the Asset, so the tool answers `ok: false` with both `requiredBaseUnits`
 * and `headroomBaseUnits` populated. That is the difference between a model that
 * decides to settle and a model that guesses. (R21.5)
 *
 * Requirements: 21.5, 25.1, 25.2, 25.3, 25.4
 */

import type { JsonObjectSchema, JsonSchema } from "./json-schema.js";

/** A `uint256` in decimal, as a string. 78 digits is the ceiling; 39 covers every real amount. */
export const BASE_UNITS_PATTERN = "^[0-9]{1,39}$";
/** A 20-byte address. */
export const ADDRESS_PATTERN = "^0x[a-fA-F0-9]{40}$";
/** A 32-byte word: a serviceId, a tool key, a tabId, a replay key. */
export const WORD_PATTERN = "^0x[a-fA-F0-9]{64}$";
/** An Asset named across chains: decimal chainKey, a colon, the token address. */
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
 * `category` is the same seven-value vocabulary `@tabai/shared` uses everywhere
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
        "PROOF",
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
      "Keep only Services that accept this Asset, as `chainKey:tokenAddress`, for example `3:0xa0b8...eb48`.",
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
    chainKey: { type: "integer", description: "Tab's own chain key: 1 is Ethereum Sepolia, 3 is Ethereum Mainnet." },
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
  required: ["chainKey", "address", "symbol", "decimals", "collectionAddress", "curatedAsset"],
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
      "Bond not already committed to a Provisional Clearing. This is what a new clearing is covered by.",
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
      description: "The tool name, for example `proof.generate`. A 32-byte hex word is accepted too.",
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
    agent: address("The Agent's Creditcoin address. Defaults to the Agent this server is configured for."),
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
            "The Open Tab last observed on this tab. A lower bound: a Metered Delivery raises a tab without an indexed event, so the per-Asset figure above is the one to trust.",
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

const PROVISIONAL_CLEARING_SCHEMA: JsonSchema = {
  type: "object",
  description:
    "Credit extended against the Service's Bond while an attestation is still in flight. Applied is not yet final.",
  properties: {
    clearingId: word("The clearing's identity, which is the Settlement's replay key."),
    asset: assetRef("The Asset cleared."),
    amountBaseUnits: baseUnits("How much was cleared."),
    state: { type: "string", enum: ["applied", "confirmed", "reversed", "declined", "superseded"] },
    deadlineIso: nullableString("When an applied clearing may be reversed if no attestation arrives."),
    sourceTxHash: nullableString("The Source Chain transaction the clearing was raised against."),
  },
  required: ["clearingId", "asset", "amountBaseUnits", "state", "deadlineIso", "sourceTxHash"],
  additionalProperties: false,
};

const VERIFIED_SETTLEMENT_SCHEMA: JsonSchema = {
  type: "object",
  description: "A Settlement the Attestcoin BlockProver Precompile proved, recorded on Creditcoin.",
  properties: {
    replayKey: word("The Settlement's identity: chainKey, blockHeight, txIndex and logIndex packed into one word."),
    chainKey: { type: "integer" },
    blockHeight: { type: "string", pattern: BASE_UNITS_PATTERN, description: "Source Chain block, in decimal." },
    txIndex: { type: "integer" },
    logIndex: { type: "integer", description: "The per-receipt log ordinal, never the block-wide index." },
    serviceId: word("The Service that was paid."),
    asset: assetRef("The Asset that was paid."),
    amountBaseUnits: baseUnits("How much was paid."),
    explorerUrl: nullableString("The Creditcoin transaction that recorded it, on Blockscout."),
  },
  required: [
    "replayKey",
    "chainKey",
    "blockHeight",
    "txIndex",
    "logIndex",
    "serviceId",
    "asset",
    "amountBaseUnits",
    "explorerUrl",
  ],
  additionalProperties: false,
};

export const TAB_STATUS_OUTPUT: JsonObjectSchema = {
  type: "object",
  properties: {
    agent: address("The Agent these figures are about."),
    boundAddresses: {
      type: "array",
      description: "Source Chain addresses bound to this Agent. A Settlement paid from one of these is credited to it.",
      items: {
        type: "object",
        properties: {
          chainKey: { type: "integer" },
          address: address("The bound account on that chain."),
        },
        required: ["chainKey", "address"],
        additionalProperties: false,
      },
    },
    perAsset: { type: "array", items: PER_ASSET_SCHEMA },
    provisionalClearings: { type: "array", items: PROVISIONAL_CLEARING_SCHEMA },
    verifiedSettlements: { type: "array", items: VERIFIED_SETTLEMENT_SCHEMA },
    error: ERROR_SCHEMA,
  },
  required: ["agent", "perAsset"],
  additionalProperties: false,
};

// ---------------------------------------------------------------- tab_settle

export const TAB_SETTLE_INPUT: JsonObjectSchema = {
  type: "object",
  description:
    "Pays down an Open Tab by broadcasting a Settlement on the Source Chain. This spends real funds unless dryRun is set.",
  properties: {
    serviceId: word("The Service being paid."),
    asset: assetRef("The Asset to pay in, as `chainKey:tokenAddress`."),
    amountBaseUnits: baseUnits("How much to pay, in Asset base units."),
    mode: {
      type: "string",
      enum: ["direct-transfer", "settlement-contract", "auto"],
      default: "auto",
      description:
        "`auto` takes the surface the chain descriptor declares: the settlement contract on Sepolia, a plain transfer on Mainnet.",
    },
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
    ok: { type: "boolean", description: "Whether the Settlement was broadcast, or would have been on a dry run." },
    dryRun: { type: "boolean", description: "True when nothing was broadcast." },
    sourceTxHash: nullableString("The Source Chain transaction. Null on a dry run and on failure."),
    chainKey: { type: ["integer", "null"] },
    amountBaseUnits: baseUnits("What was paid, echoed from the request."),
    collectionAddress: {
      type: ["string", "null"],
      pattern: ADDRESS_PATTERN,
      description: "Where the funds were sent: the Service's Tab Collection Address for this Asset.",
    },
    tabId: {
      type: ["string", "null"],
      pattern: WORD_PATTERN,
      description:
        "The tab this Settlement names on the settlement-contract surface. The zero word when none was named, and always the zero word on a plain transfer, which carries no tab identifier at all.",
    },
    expectedAttestationWait: nullableString(
      "Roughly how long until the Watcher can prove this Settlement on Creditcoin.",
    ),
    provisionalClearingExpected: {
      type: "boolean",
      description:
        "Whether the Service's free Bond covers this amount. True means the Open Tab is expected to drop as soon as the Watcher observes the Settlement, rather than tens of minutes later when the attestation lands. A prediction from the Bond ledger, not a promise.",
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
  /** MCP behaviour hints. `tab_settle` is the only tool that is not read-only. */
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
      "Lists Services registered on Creditcoin, with the Assets each accepts, what each tool costs, and how much Bond each has staked. Read-only and keyless. Start here: tab_call needs a serviceId from this list.",
    inputSchema: TAB_DISCOVER_INPUT,
    outputSchema: TAB_DISCOVER_OUTPUT,
    annotations: READ_ONLY,
  },
  {
    name: "tab_call",
    title: "Call a metered tool",
    description:
      "Calls a tool on a Service. Nothing is paid at call time: the charge lands on the Agent's Open Tab and is settled later with tab_settle. When the Agent has no headroom the call returns ok false with code LIMIT_EXCEEDED and both requiredBaseUnits and headroomBaseUnits, which is the signal to settle rather than retry.",
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
      "Reports the Agent's Credit Limit, Open Tab, prepaid credit and headroom per Asset, plus its Provisional Clearings and Verified Settlements. Read-only and keyless.",
    inputSchema: TAB_STATUS_INPUT,
    outputSchema: TAB_STATUS_OUTPUT,
    annotations: READ_ONLY,
  },
  {
    name: "tab_settle",
    title: "Settle an Open Tab",
    description:
      "Pays down an Open Tab by broadcasting a Settlement on the Source Chain with the Agent's own key. This spends real funds. Set dryRun to build and check the Settlement without broadcasting it.",
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
