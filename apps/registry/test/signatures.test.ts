/**
 * The contracts are the authority for every signature this service indexes.
 *
 * These tests re-read `packages/contracts/src/*.sol` and compare each event
 * declaration against `src/events.ts`, field by field: type, `indexed` flag, and
 * parameter name, in order. Then they recompute `topics[0]` from the source's own
 * declaration and compare it with the topic hash the service filters on.
 *
 * Why it is worth this much machinery. An indexer that disagrees with the deployed
 * contract does not fail loudly; it silently matches nothing, or matches and puts a
 * settled amount in the wrong column, and both look like a healthy service with an
 * empty or subtly wrong table. Three specific ways that could happen here are all
 * closed by these assertions:
 *
 * - **A reordered field.** `Settled` carries eight fields, three of them `uint128`
 *   in a row. An encode-then-decode round trip is symmetric and would not
 *   notice them swapped; reading the declaration out of the source does.
 * - **A changed `indexed` flag.** It moves a field between `topics` and `data`, so
 *   the decode shifts silently by one.
 * - **A renamed parameter.** `src/rows.ts` reads decoded fields by the contract's own
 *   name, so a rename would leave a column empty rather than raise.
 *
 * The enumeration members are checked the same way and for the same reason: a
 * reordered enumeration would relabel every historical row in the read layer while
 * the numbers on chain stayed put.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { id } from "ethers";

import {
  EVENT_DECLARATIONS,
  EVENT_OWNER,
  EVENT_TOPIC0,
  INDEXED_EVENT_NAMES,
  REGISTRY_INTERFACE,
  type IndexedEventName,
} from "../src/events.js";
import { SOLIDITY_ENUMS, type SolidityEnumName } from "../src/enum-names.js";

const CONTRACTS_SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "contracts",
  "src",
);

/**
 * The ERC-8004 sources, vendored under `vendor/erc8004` and unmodified below
 * the registry's provenance header: the canonical Identity registry from
 * `erc-8004/erc-8004-contracts`, and OpenZeppelin's `IERC721`, which is where
 * the `Transfer` the registry inherits is declared.
 * They are the authority for the identity events exactly as `packages/contracts`
 * is for Tab's; see `src/erc8004.ts` for the provenance.
 */
const VENDOR_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "erc8004");

/** Which source file each watched contract lives in. */
const SOURCE_FILE = {
  TabBook: "TabBook.sol",
  TabSettlement: "TabSettlement.sol",
  ServiceRegistry: "ServiceRegistry.sol",
  Bond: "Bond.sol",
  IdentityRegistry: join(VENDOR_SRC, "IdentityRegistryUpgradeable.sol"),
} as const;

/**
 * Events declared somewhere other than their owner's own file. `Transfer` is
 * inherited from ERC-721, so the registry's source never spells it out.
 */
const DECLARED_IN: Readonly<Partial<Record<IndexedEventName, string>>> = {
  Transfer: join(VENDOR_SRC, "IERC721.sol"),
};

/**
 * An enumeration is `uint8` on the wire, so a declaration naming one is equivalent
 * to a declaration naming `uint8` and produces an identical topic hash. Listed
 * explicitly rather than pattern-matched, so a custom type this test has never seen
 * fails instead of being guessed at.
 */
const ENUM_AS_UINT8 = new Set(["Tier", "ChangeKind"]);

/**
 * Structs an event carries by name, and the file each is declared in.
 *
 * A struct is a tuple of its members on the wire, so `EVENT_DECLARATIONS` names the
 * expanded tuple while the source names the struct. The expansion is **parsed from
 * the struct declaration** rather than written out here, which is the whole point:
 * a member reordered or retyped in the contract changes the tuple this produces and
 * fails the comparison, where a literal would have silently kept agreeing with a
 * declaration that no longer matched the chain.
 */
const STRUCT_AS_TUPLE: Readonly<Record<string, string>> = {
  "LimitLib.SettlementRecord": "LimitLib.sol",
};

/**
 * Expands a struct declaration into its ABI tuple.
 *
 * Members only: a comment line carries no `;` terminator inside the body once the
 * doc comments are stripped, and every member of these structs is a value type, so
 * no recursion is needed. A nested struct would produce a type this does not know
 * and fail loudly at the comparison rather than be flattened wrongly.
 */
function parseStructAsTuple(source: string, qualified: string): string {
  const bare = qualified.slice(qualified.indexOf(".") + 1);
  const marker = `struct ${bare} {`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `no declaration of \`struct ${bare}\``);
  const body = source.slice(start + marker.length, source.indexOf("}", start));
  const members = body
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line.endsWith(";"))
    .map((line) => {
      const type = line.split(/\s+/)[0] ?? "";
      assert.ok(type.length > 0, `cannot read a member type from \`${line}\``);
      return ENUM_AS_UINT8.has(type) ? "uint8" : type;
    });
  assert.ok(members.length > 0, `\`struct ${bare}\` parsed to no members`);
  return `tuple(${members.join(",")})`;
}

interface SourceParameter {
  readonly type: string;
  readonly indexed: boolean;
  readonly name: string;
}

const readSource = (file: string): string =>
  readFileSync(file.startsWith("/") ? file : join(CONTRACTS_SRC, file), "utf8");

/** The file the declaration of one event is read from. */
const declarationFile = (name: IndexedEventName): string =>
  DECLARED_IN[name] ?? SOURCE_FILE[EVENT_OWNER[name] as keyof typeof SOURCE_FILE];

/**
 * Extracts one event declaration from Solidity source.
 *
 * Deliberately literal: it finds `event <Name>(`, reads to the matching close
 * parenthesis, and splits on top-level commas. No comment stripping is needed
 * because a declaration's parameter list carries none in these files, and a
 * declaration that ever does will fail this test rather than be misread.
 */
function parseEventDeclaration(source: string, name: string): readonly SourceParameter[] {
  const marker = `event ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `no declaration of \`event ${name}\` in the source`);

  let depth = 0;
  let end = -1;
  for (let cursor = start + marker.length - 1; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        end = cursor;
        break;
      }
    }
  }
  assert.notEqual(end, -1, `unterminated parameter list on \`event ${name}\``);

  const body = source.slice(start + marker.length, end).replace(/\s+/g, " ").trim();
  if (body.length === 0) return [];

  return body.split(",").map((entry) => {
    const tokens = entry.trim().split(" ").filter((token) => token.length > 0);
    assert.ok(tokens.length >= 2, `cannot read parameter \`${entry.trim()}\` of ${name}`);
    const rawType = tokens[0] ?? "";
    const indexed = tokens.includes("indexed");
    const parameterName = tokens[tokens.length - 1] ?? "";
    const structSource = STRUCT_AS_TUPLE[rawType];
    const type = ENUM_AS_UINT8.has(rawType)
      ? "uint8"
      : structSource === undefined
        ? rawType
        : parseStructAsTuple(readSource(structSource), rawType);
    return { type, indexed, name: parameterName };
  });
}

/** Members of one Solidity enumeration, in declaration order. */
function parseEnumMembers(source: string, name: string): readonly string[] {
  const marker = `enum ${name} {`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `no declaration of \`enum ${name}\``);
  const end = source.indexOf("}", start);
  assert.notEqual(end, -1, `unterminated \`enum ${name}\``);
  return source
    .slice(start + marker.length, end)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The signature Solidity actually hashes.
 *
 * A struct is a parenthesised tuple in the canonical form and carries no `tuple`
 * keyword: `HistoryExtended(address,address,bytes32,uint32,(bytes32,...))`. The
 * `tuple(` spelling is the human-readable ABI's, which is what `EVENT_DECLARATIONS`
 * is written in and what {@link parseStructAsTuple} produces for the field-by-field
 * comparison, so it is stripped here and only here. Hashing the human-readable
 * spelling would produce a topic no contract ever emits, which is exactly the
 * failure this test exists to catch, so getting it wrong here would have made the
 * test raise a false alarm against correct production code.
 */
const canonicalSignature = (name: string, parameters: readonly SourceParameter[]): string =>
  `${name}(${parameters.map((parameter) => parameter.type.replaceAll("tuple(", "(")).join(",")})`;

test("every indexed event names a contract this service watches", () => {
  for (const name of INDEXED_EVENT_NAMES) {
    const owner = EVENT_OWNER[name];
    assert.ok(owner in SOURCE_FILE, `${name} claims an unknown owner ${owner}`);
  }
});

test("each declaration matches the contract field for field, in order", () => {
  const sources = new Map<string, string>();
  const read = (owner: keyof typeof SOURCE_FILE): string => {
    const cached = sources.get(owner);
    if (cached !== undefined) return cached;
    const text = readSource(SOURCE_FILE[owner]);
    sources.set(owner, text);
    return text;
  };

  for (const name of INDEXED_EVENT_NAMES) {
    const owner = EVENT_OWNER[name] as keyof typeof SOURCE_FILE;
    const fromSource = parseEventDeclaration(
      DECLARED_IN[name] === undefined ? read(owner) : readSource(declarationFile(name)),
      name,
    );

    const fragment = REGISTRY_INTERFACE.getEvent(name);
    assert.notEqual(fragment, null, `${name} has no fragment`);
    const fromService = (fragment?.inputs ?? []).map((input) => ({
      type: input.type,
      indexed: input.indexed === true,
      name: input.name,
    }));

    assert.deepEqual(
      fromService,
      fromSource.map((parameter) => ({ ...parameter })),
      `${name} in ${declarationFile(name)} disagrees with EVENT_DECLARATIONS`,
    );
  }
});

test("topics[0] recomputed from the contract source matches what the filter asks for", () => {
  for (const name of INDEXED_EVENT_NAMES) {
    const parameters = parseEventDeclaration(readSource(declarationFile(name)), name);
    assert.equal(
      id(canonicalSignature(name, parameters)),
      EVENT_TOPIC0[name],
      `${name} filters on a topic hash the contract would never emit`,
    );
  }
});

test("Settled carries its eight fields in the contract's order", () => {
  // Spelled out rather than derived, because this is the event the Settlement feed is
  // built from and the one whose field order is most expensive to get wrong: three
  // indexed identities, then the money, then where it went.
  const expected: readonly SourceParameter[] = [
    { type: "bytes32", indexed: true, name: "settlementId" },
    { type: "address", indexed: true, name: "agent" },
    { type: "bytes32", indexed: true, name: "serviceId" },
    { type: "address", indexed: false, name: "asset" },
    { type: "uint128", indexed: false, name: "amount" },
    { type: "uint128", indexed: false, name: "applied" },
    { type: "uint128", indexed: false, name: "toPrepaid" },
    { type: "address", indexed: false, name: "collection" },
  ];

  const fromSource = parseEventDeclaration(readSource(SOURCE_FILE.TabSettlement), "Settled");
  assert.equal(fromSource.length, 8);
  assert.deepEqual(
    fromSource.map((parameter) => ({ ...parameter })),
    expected.map((parameter) => ({ ...parameter })),
  );
});

test("every enumeration member list matches ServiceRegistry.sol in order", () => {
  const source = readSource(SOURCE_FILE.ServiceRegistry);
  for (const enumName of Object.keys(SOLIDITY_ENUMS) as SolidityEnumName[]) {
    assert.deepEqual(
      [...SOLIDITY_ENUMS[enumName]],
      [...parseEnumMembers(source, enumName)],
      `${enumName} members disagree with the contract, which would relabel stored rows`,
    );
  }
});

test("nothing moves prepaid credit except the two events the Agent read subtracts", () => {
  // The Agent read serves a prepaid balance as `SettlementApplied.toPrepaid` less
  // `PrepaidConsumed.consumed` and calls it exact rather than a lower bound, which is
  // a claim about the contract and not about this service. It holds only while
  // `tab.prepaid` has exactly two writers: one decrement inside `_recordOnTab`,
  // which emits `PrepaidConsumed`, and one increment in `applySettlement`, which
  // emits `SettlementApplied`. A third writer would make the served balance quietly
  // wrong in a way no read could detect, so it is asserted against the source rather
  // than trusted.
  const source = readSource(SOURCE_FILE.TabBook);
  const writes = [...source.matchAll(/\.prepaid\s*(\+=|-=|=(?!=))/g)].map((match) => match[1]);
  assert.deepEqual(writes.sort(), ["+=", "-="], "tab.prepaid gained or lost a writer");

  // And each one is answered by an event in this service's surface.
  assert.ok(INDEXED_EVENT_NAMES.includes("PrepaidConsumed"), "the decrement is indexed");
  assert.ok(INDEXED_EVENT_NAMES.includes("SettlementApplied"), "the increment is indexed");
});

test("the vendored ERC-8004 registry is the 2.0.0 contract and declares the three identity events", () => {
  // The registries on Monad answer `getVersion()` with "2.0.0", so the vendored
  // source has to be that version: a declaration read from an older one could
  // match no log on chain while this test kept passing.
  const source = readSource(SOURCE_FILE.IdentityRegistry);
  assert.match(source, /return "2\.0\.0";/);
  assert.match(source, /contract IdentityRegistryUpgradeable is\s+ERC721URIStorageUpgradeable/);
  for (const name of ["Registered", "MetadataSet", "URIUpdated"] as const) {
    assert.ok(source.includes(`event ${name}(`), `the registry declares ${name}`);
    assert.equal(EVENT_OWNER[name], "IdentityRegistry");
  }
  assert.equal(EVENT_OWNER.Transfer, "IdentityRegistry");
  assert.match(readSource(DECLARED_IN.Transfer ?? ""), /interface IERC721 is IERC165/);
});

test("no two indexed events share a topic hash", () => {
  const seen = new Map<string, IndexedEventName>();
  for (const name of INDEXED_EVENT_NAMES) {
    const topic = EVENT_TOPIC0[name];
    const clash = seen.get(topic);
    assert.equal(clash, undefined, `${name} and ${clash} would be indistinguishable`);
    seen.set(topic, name);
  }
  assert.equal(seen.size, Object.keys(EVENT_DECLARATIONS).length);
});
