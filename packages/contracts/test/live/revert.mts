/**
 * Live harness — revert observation.
 *
 * The point of the negative-path suite is what the chain says when it refuses a submission, so the
 * refusal is recorded as data rather than as prose. Every outcome carries two things:
 *
 *   - `raw`, the returndata exactly as the node produced it, and
 *   - `decoded`, the custom error those bytes are, with its name, four-byte selector, full signature,
 *     and every argument.
 *
 * Raw bytes come first on purpose. A decoder can be wrong and a signature can drift; the bytes
 * cannot. Anyone holding `results.json` can decode them again against a different ABI and check the
 * harness rather than take its word.
 *
 * The dictionary is assembled from the compiled artefacts of the deployed contracts rather than from
 * signatures written out by hand, and it spans the collaborators as well as the entrypoint — a
 * submission can revert inside `TabBook`, `AgentRegistry`, `Bond`, or `ServiceRegistry`, and their
 * errors are not in `SettlementVerifier`'s own ABI. Two builtins are added on top, because neither
 * appears in any ABI: `Error(string)` for `require` and `revert` strings, which is how the BlockProver
 * Precompile reports a root mismatch, and `Panic(uint256)` for compiler-inserted failures.
 *
 * Requirements: 27.3
 */

import {existsSync, readFileSync} from 'node:fs';
import {resolve as resolvePath} from 'node:path';

import {AbiCoder, type ErrorFragment, Interface, dataSlice, isHexString} from 'ethers';

import {CONTRACTS_DIR} from './config.mjs';

/** Contracts whose errors a live submission can surface, entrypoint first. */
const ERROR_SOURCES = [
  'SettlementVerifier',
  'TabAscBase',
  'TabBook',
  'AgentRegistry',
  'Bond',
  'ServiceRegistry',
] as const;

/** `Error(string)`, which is what a `require` string and the precompile's own refusal arrive as. */
const SELECTOR_ERROR_STRING = '0x08c379a0';

/** `Panic(uint256)`, inserted by the compiler for overflow, division by zero, and kin. */
const SELECTOR_PANIC = '0x4e487b71';

/** Solidity panic codes, so a panic reads as a cause instead of a number. */
const PANIC_REASONS: Record<string, string> = {
  '0x00': 'generic compiler panic',
  '0x01': 'assertion failed',
  '0x11': 'arithmetic overflow or underflow',
  '0x12': 'division or modulo by zero',
  '0x21': 'invalid enum conversion',
  '0x22': 'invalid storage byte array encoding',
  '0x31': 'pop on an empty array',
  '0x32': 'array index out of bounds',
  '0x41': 'out of memory',
  '0x51': 'call to an uninitialised internal function',
};

// ---------------------------------------------------------------------------- the error dictionary

export interface ErrorDictionary {
  /** Four-byte selector to its error fragment. */
  readonly bySelector: Map<string, ErrorFragment>;
  /** Which artefacts contributed, so `results.json` can state what the decoder knew. */
  readonly sources: readonly string[];
  readonly errorCount: number;
}

function artifactPath(name: string): string {
  return resolvePath(CONTRACTS_DIR, 'out', `${name}.sol`, `${name}.json`);
}

/**
 * Assemble the dictionary from `out/`. `forge build` is a prerequisite of the harness, and a missing
 * artefact fails here rather than producing an undecodable result later.
 */
export function loadErrorDictionary(): ErrorDictionary {
  const bySelector = new Map<string, ErrorFragment>();
  const sources: string[] = [];

  for (const name of ERROR_SOURCES) {
    const path = artifactPath(name);
    if (!existsSync(path)) {
      throw new Error(
        `compiled artefact for ${name} is absent at out/${name}.sol/${name}.json. Run \`forge build\` in packages/contracts first.`,
      );
    }
    const artifact = JSON.parse(readFileSync(path, 'utf8')) as {abi?: unknown[]};
    if (!Array.isArray(artifact.abi)) throw new Error(`compiled artefact for ${name} carries no ABI.`);

    let contributed = 0;
    new Interface(artifact.abi).forEachError((fragment) => {
      if (!bySelector.has(fragment.selector)) {
        bySelector.set(fragment.selector, fragment);
        contributed += 1;
      }
    });
    sources.push(`${name} (${contributed} new)`);
  }

  return {bySelector, sources, errorCount: bySelector.size};
}

// ------------------------------------------------------------------------------- decoded outcomes

export type DecodedRevert =
  | {kind: 'none'; note: string}
  | {kind: 'empty'; note: string}
  | {kind: 'errorString'; selector: string; signature: string; message: string}
  | {kind: 'panic'; selector: string; signature: string; code: string; reason: string}
  | {kind: 'customError'; selector: string; name: string; signature: string; args: Record<string, string>}
  | {kind: 'unrecognised'; selector: string | null; note: string};

/** One observed refusal: the bytes, and what they are. */
export interface RevertObservation {
  /** Returndata exactly as the node produced it, or null when the call did not revert. */
  readonly raw: string | null;
  readonly rawByteLength: number | null;
  readonly decoded: DecodedRevert;
  /** The node's own message, kept because it sometimes names an exhaustion or a nonce fault. */
  readonly nodeMessage: string | null;
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.map(stringifyValue).join(', ')}]`;
  return String(value);
}

/** Decode returndata against the dictionary. Never throws: an undecodable answer is still an answer. */
export function decodeRevertData(data: string | null, dictionary: ErrorDictionary): DecodedRevert {
  if (data === null) return {kind: 'none', note: 'the call returned without reverting'};
  if (!isHexString(data)) {
    return {kind: 'unrecognised', selector: null, note: 'the node produced no hexadecimal returndata'};
  }
  if (data === '0x') {
    return {
      kind: 'empty',
      note: 'reverted with no returndata, which is what a bare revert, an invalid opcode, or an exhausted gas limit produces',
    };
  }
  if (data.length < 10) {
    return {
      kind: 'unrecognised',
      selector: null,
      note: `returndata is ${(data.length - 2) / 2} bytes, too short to carry a selector`,
    };
  }

  const selector = dataSlice(data, 0, 4);
  const body = dataSlice(data, 4);

  if (selector === SELECTOR_ERROR_STRING) {
    try {
      const [message] = AbiCoder.defaultAbiCoder().decode(['string'], body);
      return {kind: 'errorString', selector, signature: 'Error(string)', message: String(message)};
    } catch {
      return {kind: 'unrecognised', selector, note: 'the selector is Error(string) but the payload did not decode'};
    }
  }

  if (selector === SELECTOR_PANIC) {
    try {
      const [code] = AbiCoder.defaultAbiCoder().decode(['uint256'], body) as [bigint];
      const hex = `0x${code.toString(16).padStart(2, '0')}`;
      return {
        kind: 'panic',
        selector,
        signature: 'Panic(uint256)',
        code: hex,
        reason: PANIC_REASONS[hex] ?? 'unassigned panic code',
      };
    } catch {
      return {kind: 'unrecognised', selector, note: 'the selector is Panic(uint256) but the payload did not decode'};
    }
  }

  const fragment = dictionary.bySelector.get(selector);
  if (fragment === undefined) {
    return {
      kind: 'unrecognised',
      selector,
      note: 'no error in the deployed contracts or their collaborators carries this selector',
    };
  }

  const args: Record<string, string> = {};
  try {
    const decoded = AbiCoder.defaultAbiCoder().decode(fragment.inputs, body);
    fragment.inputs.forEach((input, index) => {
      args[input.name.length > 0 ? input.name : `arg${index}`] = stringifyValue(decoded[index]);
    });
  } catch {
    args.undecodable = 'the selector matched but the payload did not decode against its inputs';
  }

  return {kind: 'customError', selector, name: fragment.name, signature: fragment.format('sighash'), args};
}

// -------------------------------------------------------------------- pulling bytes out of ethers

/**
 * Dig the returndata out of whatever the provider threw.
 *
 * A JSON-RPC error carries it in several places depending on the node and on how deep in the stack
 * the failure was noticed, so every documented location is walked and the first hexadecimal payload
 * longer than a bare `0x` wins. The search is deliberately exhaustive: losing the bytes turns a
 * recorded rejection back into a prose summary, which is the thing this file exists to prevent.
 */
export function extractRevertData(error: unknown): {data: string | null; message: string | null} {
  const seen = new Set<unknown>();
  let message: string | null = null;

  // `shortMessage` wins over `message`, which ethers pads with the whole transaction request. The
  // request is already recorded field by field, so repeating it inside a message string would double
  // the size of every record and add nothing.
  const note = (record: Record<string, unknown>): void => {
    if (typeof record.shortMessage === 'string') {
      message = record.shortMessage;
      return;
    }
    if (message === null && typeof record.message === 'string') {
      message = record.message.split(' (action=')[0];
    }
  };

  const walk = (node: unknown, depth: number): string | null => {
    if (node === null || node === undefined || depth > 6) return null;
    if (typeof node === 'string') return isHexString(node) && node.length > 2 ? node : null;
    if (typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);

    const record = node as Record<string, unknown>;
    note(record);

    for (const key of ['data', 'error', 'info', 'value', 'cause', 'body', 'result']) {
      const found = walk(record[key], depth + 1);
      if (found !== null) return found;
    }
    return null;
  };

  const data = walk(error, 0);
  if (message === null && error instanceof Error) message = error.message.split(' (action=')[0];
  return {data, message: message === null ? null : message.slice(0, 400)};
}

/** Fold a caught error into the recorded shape. */
export function observeRevert(error: unknown, dictionary: ErrorDictionary): RevertObservation {
  const {data, message} = extractRevertData(error);
  // A node that refuses a call without returndata still refused it, so an empty payload is recorded
  // as `0x` rather than as nothing. Only a genuinely absent answer becomes null.
  const raw = data ?? (message !== null ? '0x' : null);
  return {
    raw,
    rawByteLength: raw === null ? null : (raw.length - 2) / 2,
    decoded: decodeRevertData(raw, dictionary),
    nodeMessage: message,
  };
}

/** The recorded shape for a call that did not revert. */
export function observeSuccess(returnData: string): RevertObservation {
  return {
    raw: null,
    rawByteLength: null,
    decoded: {kind: 'none', note: `the call returned ${returnData} without reverting`},
    nodeMessage: null,
  };
}
