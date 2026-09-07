/**
 * Live harness — the case registry.
 *
 * A case is an identity, the requirements it answers, the outcome it expects, and a function that
 * turns genuine proof material into the submission it wants to make. The machinery around it does
 * the connecting, the submitting, the capturing, and the recording.
 *
 * Task 13.1 registered two cases to establish that the machinery works end to end. Task 13.2 adds
 * the rest of design section 15.4, and they come in three shapes:
 *
 *   - **Mutations of genuine Mainnet material**: the forged root, the tampered payload, and the
 *     wrong chainKey. The material is fetched once per run and each case changes one field.
 *   - **Genuine material submitted unchanged**, chosen so the deployment's own logic refuses it: a
 *     reverted Source Chain transaction, a Transfer to a recipient no Service registered, and a
 *     transaction carrying a zero-topic log ahead of the recognised one.
 *   - **Settlements the rail actually accepted**, named by Source Chain transaction hash on the
 *     command line: the replay of a spent key, the relayed payer, the two-log batch, and the
 *     ingested zero-topic case. These expect acceptance or `AlreadyClaimed`, and what they prove is
 *     read back from the deployed contracts before and after rather than inferred from a status.
 *
 * On the expectation field. It names the outcomes a case would accept, and the harness records what
 * actually came back whether or not it matches. A case that expects `ProofRejected` and observes a
 * string revert from the precompile is a finding, not a harness failure, so the recorded outcome
 * distinguishes "refused as expected" from "refused differently" from "accepted", and never collapses
 * the three.
 *
 * Requirements: 27.3, 27.4, 27.5, 27.6, 27.7, 27.8, 27.9, 27.10, 27.11, 27.12
 */

import type {JsonRpcProvider} from 'ethers';

import type {LiveConfig} from './config.mjs';
import type {SubmissionOutcome} from './chain.mjs';
import type {DecodedRevert, ErrorDictionary} from './revert.mjs';
import {
  type ChainKeys,
  type Mutation,
  type PrecompileControl,
  type ProofMaterial,
  type SourceTarget,
  type SourceTxShape,
  forgeMerkleRoot,
  precompileControl,
  substituteChainKey,
  tamperEncodedTransaction,
} from './proof.mjs';
import {
  type AddressSnapshot,
  type Assertion,
  type DeploymentReads,
  type ExpectedIngestion,
  assertion,
  expectedIngestions,
  snapshotAddress,
} from './assertions.mjs';

// ---------------------------------------------------------------------------------------- context

/** Where a case's material comes from. */
export type MaterialKind =
  /** a historical Mainnet USDC Transfer; every Mainnet recipient is unregistered on this deployment */
  | 'mainnet-transfer'
  /** a historical Mainnet transaction whose receipt status is zero */
  | 'mainnet-reverted'
  /** a historical Mainnet transaction with a zero-topic log ahead of a USDC Transfer */
  | 'mainnet-zero-topic'
  /** the Source Chain transaction named on the command line for this case */
  | 'named-source-tx';

/** Genuine material for one target, with the target it belongs to. */
export interface Material {
  readonly target: SourceTarget;
  readonly material: ProofMaterial;
}

/** What a case is handed. */
export interface CaseContext {
  readonly config: LiveConfig;
  readonly creditcoin: JsonRpcProvider;
  readonly chainKeys: ChainKeys;
  readonly dictionary: ErrorDictionary;
  readonly reads: DeploymentReads;
  /** Fetches the material a case asked for. Named targets are read fresh; Mainnet ones are cached per run. */
  material(kind: MaterialKind, caseId: string): Promise<Material>;
}

/** What a case decided to submit, and what the keyless controls said about it. */
export interface PreparedSubmission {
  readonly target: SourceTarget;
  readonly material: ProofMaterial;
  readonly sourceTx: SourceTxShape;
  readonly mutation: Mutation | null;
  readonly controls: {
    /** The unmutated material. Expected to verify; if it does not, the case proves nothing. */
    readonly genuineMaterial: PrecompileControl;
    /** The material as submitted. */
    readonly asSubmitted: PrecompileControl;
  };
  /** What the deployment is expected to do with each Settlement-shaped log, from the registry. */
  readonly expectedIngestions: readonly ExpectedIngestion[] | null;
  /** State read before the submission, for the acceptance cases. */
  readonly before: Record<string, unknown> | null;
}

export type ExpectedKind = 'refusal' | 'acceptance';

export interface LiveCase {
  readonly id: string;
  readonly title: string;
  /** Acceptance criteria this case answers. */
  readonly requirements: readonly string[];
  readonly expected: ExpectedKind;
  /** For a refusal case: errors it would accept, by name or by signature. For acceptance: what an already-spent key answers. */
  readonly expectedRefusals: readonly string[];
  readonly expectation: string;
  readonly material: MaterialKind;
  /** Which Settlement the case needs handed to it, when it needs one. Named for the hand-off file. */
  readonly input: {readonly handoffKey: string; readonly recipe: string} | null;
  prepare(ctx: CaseContext): Promise<PreparedSubmission>;
  /** Acceptance cases read the chain back after the submission and state what they found. */
  assert?(ctx: CaseContext, prepared: PreparedSubmission, outcome: SubmissionOutcome): Promise<readonly Assertion[]>;
}

// -------------------------------------------------------------------------------------- the verdict

export type CaseOutcome =
  | 'refused-as-expected'
  | 'refused-differently'
  | 'accepted-as-expected'
  | 'accepted'
  | 'already-claimed'
  | 'exhausted-gas'
  | 'inconclusive';

export interface CaseVerdict {
  readonly outcome: CaseOutcome;
  /** Which observation the verdict was taken from. */
  readonly basis: 'on-chain transaction' | 'keyless preflight';
  readonly observedRefusal: string | null;
  readonly matchesExpectation: boolean;
  readonly note: string;
}

function nameOf(decoded: DecodedRevert): string | null {
  switch (decoded.kind) {
    case 'customError':
      return decoded.name;
    case 'errorString':
      return 'Error(string)';
    case 'panic':
      return 'Panic(uint256)';
    case 'empty':
      return 'revert with no returndata';
    case 'unrecognised':
      return decoded.selector === null ? 'unrecognised refusal' : `unknown selector ${decoded.selector}`;
    default:
      return null;
  }
}

/**
 * Read a verdict off the observation, preferring what the chain did over what a call predicted.
 *
 * An exhausted gas limit is called out separately and never counted as a refusal. On this network an
 * estimate comes from a warm simulation and understates a cold write, so `gasUsed == gasLimit` is the
 * one receipt shape that looks exactly like a rejection and is not one.
 *
 * For an acceptance case, `AlreadyClaimed` is its own outcome rather than a failure: it means an
 * earlier submission, usually the Watcher's, already spent the key, and the assertions then read the
 * chain to establish what that submission did. `matchesExpectation` on an acceptance case is settled
 * by the assertions, which the driver folds in after this verdict is taken.
 */
export function verdictFor(entry: LiveCase, outcome: SubmissionOutcome): CaseVerdict {
  const onChain = outcome.onChain;
  const expected = entry.expectedRefusals;

  if (onChain !== null) {
    if (onChain.outOfGas) {
      return {
        outcome: 'exhausted-gas',
        basis: 'on-chain transaction',
        observedRefusal: null,
        matchesExpectation: false,
        note: `gasUsed equals the ${onChain.gasLimit} gas limit, so the submission was exhausted rather than refused. Raise the limit and run the case again.`,
      };
    }
    if (onChain.status === 1) {
      return entry.expected === 'acceptance'
        ? {
            outcome: 'accepted-as-expected',
            basis: 'on-chain transaction',
            observedRefusal: null,
            matchesExpectation: true,
            note: 'the deployment accepted the submission, which is what this case expects. The assertions say what it did with it.',
          }
        : {
            outcome: 'accepted',
            basis: 'on-chain transaction',
            observedRefusal: null,
            matchesExpectation: false,
            note: 'the deployment accepted the submission. For a negative-path case that is a failure of the defence under test.',
          };
    }
    const observed = onChain.revertData === null ? null : nameOf(onChain.revertData.decoded);
    if (entry.expected === 'acceptance' && observed === 'AlreadyClaimed') {
      return {
        outcome: 'already-claimed',
        basis: 'on-chain transaction',
        observedRefusal: observed,
        matchesExpectation: true,
        note: 'the deployment answered AlreadyClaimed, so an earlier submission spent this key. The assertions read back what that submission credited.',
      };
    }
    const matches = observed !== null && expected.includes(observed);
    return {
      outcome: matches ? 'refused-as-expected' : 'refused-differently',
      basis: 'on-chain transaction',
      observedRefusal: observed,
      matchesExpectation: entry.expected === 'refusal' && matches,
      note: matches
        ? `the transaction reverted with ${observed}, which is what this case expects.`
        : `the transaction reverted with ${observed ?? 'a refusal the harness could not name'}, where the case expected ${
            entry.expected === 'acceptance' ? 'acceptance' : `one of ${expected.join(', ')}`
          }. The raw returndata is recorded so the difference can be checked rather than argued.`,
    };
  }

  if (outcome.preflight.accepted) {
    return entry.expected === 'acceptance'
      ? {
          outcome: 'accepted-as-expected',
          basis: 'keyless preflight',
          observedRefusal: null,
          matchesExpectation: true,
          note: 'the keyless call returned without reverting, so the deployment would accept this submission. Nothing was spent, so no state changed and no crediting can be asserted from this run.',
        }
      : {
          outcome: 'accepted',
          basis: 'keyless preflight',
          observedRefusal: null,
          matchesExpectation: false,
          note: 'the keyless call returned without reverting, so the deployment would accept this submission.',
        };
  }

  const observed = nameOf(outcome.preflight.decoded);
  if (entry.expected === 'acceptance' && observed === 'AlreadyClaimed') {
    return {
      outcome: 'already-claimed',
      basis: 'keyless preflight',
      observedRefusal: observed,
      matchesExpectation: true,
      note: 'the keyless call answered AlreadyClaimed, so an earlier submission spent this key. The assertions read back what it credited.',
    };
  }
  const matches = observed !== null && expected.includes(observed);
  return {
    outcome: matches ? 'refused-as-expected' : 'refused-differently',
    basis: 'keyless preflight',
    observedRefusal: observed,
    matchesExpectation: entry.expected === 'refusal' && matches,
    note: matches
      ? `the keyless call reverted with ${observed}, which is what this case expects. No transaction was spent, so no Creditcoin transaction hash exists for this run.`
      : `the keyless call reverted with ${observed ?? 'a refusal the harness could not name'}, where the case expected ${
          entry.expected === 'acceptance' ? 'acceptance' : `one of ${expected.join(', ')}`
        }.`,
  };
}

// ------------------------------------------------------------------------------------ case builders

async function controlsFor(
  ctx: CaseContext,
  genuine: SourceTxShape,
  submitted: SourceTxShape,
): Promise<PreparedSubmission['controls']> {
  const [genuineMaterial, asSubmitted] = await Promise.all([
    precompileControl(ctx.creditcoin, ctx.config, genuine),
    precompileControl(ctx.creditcoin, ctx.config, submitted),
  ]);
  return {genuineMaterial, asSubmitted};
}

/** One mutation of genuine Mainnet material. */
function mutationCase(
  id: string,
  title: string,
  requirements: readonly string[],
  expectedRefusals: readonly string[],
  expectation: string,
  mutate: (tx: SourceTxShape, chainKeys: ChainKeys) => {mutated: SourceTxShape; mutation: Mutation},
): LiveCase {
  return {
    id,
    title,
    requirements,
    expected: 'refusal',
    expectedRefusals,
    expectation,
    material: 'mainnet-transfer',
    input: null,
    async prepare(ctx: CaseContext): Promise<PreparedSubmission> {
      const {target, material} = await ctx.material('mainnet-transfer', id);
      const {mutated, mutation} = mutate(material.sourceTx, ctx.chainKeys);
      return {
        target,
        material,
        sourceTx: mutated,
        mutation,
        controls: await controlsFor(ctx, material.sourceTx, mutated),
        expectedIngestions: await expectedIngestions(ctx.reads, ctx.chainKeys, target),
        before: null,
      };
    },
  };
}

/** Genuine material of one kind, submitted unchanged, refused by the deployment's own logic. */
function unmutatedRefusalCase(
  id: string,
  title: string,
  requirements: readonly string[],
  expectedRefusals: readonly string[],
  expectation: string,
  material: MaterialKind,
): LiveCase {
  return {
    id,
    title,
    requirements,
    expected: 'refusal',
    expectedRefusals,
    expectation,
    material,
    input: null,
    async prepare(ctx: CaseContext): Promise<PreparedSubmission> {
      const fetched = await ctx.material(material, id);
      const controls = await controlsFor(ctx, fetched.material.sourceTx, fetched.material.sourceTx);
      return {
        target: fetched.target,
        material: fetched.material,
        sourceTx: fetched.material.sourceTx,
        mutation: null,
        controls,
        expectedIngestions: await expectedIngestions(ctx.reads, ctx.chainKeys, fetched.target),
        before: null,
      };
    },
  };
}

/** The credit-relevant state around a named Settlement, read before and after. */
interface CreditState {
  readonly payer: AddressSnapshot;
  readonly sender: AddressSnapshot;
  readonly claimed: Record<string, boolean>;
}

async function readCreditState(
  ctx: CaseContext,
  target: SourceTarget,
  ingestions: readonly ExpectedIngestion[],
): Promise<CreditState> {
  const first = ingestions.find((entry) => entry.recognised && entry.collectionRegistered) ?? ingestions[0] ?? null;
  const asset = first?.asset ?? null;
  const payerAddress = target.settlementLog?.payerFromTopic1 ?? target.txFrom;
  const [payer, sender] = await Promise.all([
    snapshotAddress(ctx.reads, target.chainKey, payerAddress, asset),
    snapshotAddress(ctx.reads, target.chainKey, target.txFrom, asset),
  ]);
  const claimed: Record<string, boolean> = {};
  for (const entry of ingestions) claimed[entry.replayKey] = await ctx.reads.claimedLog(entry.replayKey);
  return {payer, sender, claimed};
}

/** A Settlement the rail accepted, or should accept, named by hash on the command line. */
function namedSettlementCase(
  id: string,
  title: string,
  requirements: readonly string[],
  expected: ExpectedKind,
  expectedRefusals: readonly string[],
  expectation: string,
  input: {handoffKey: string; recipe: string},
  assert: LiveCase['assert'],
): LiveCase {
  return {
    id,
    title,
    requirements,
    expected,
    expectedRefusals,
    expectation,
    material: 'named-source-tx',
    input,
    async prepare(ctx: CaseContext): Promise<PreparedSubmission> {
      const {target, material} = await ctx.material('named-source-tx', id);
      const ingestions = await expectedIngestions(ctx.reads, ctx.chainKeys, target);
      const before = await readCreditState(ctx, target, ingestions);
      const controls = await controlsFor(ctx, material.sourceTx, material.sourceTx);
      return {
        target,
        material,
        sourceTx: material.sourceTx,
        mutation: null,
        controls,
        expectedIngestions: ingestions,
        before: before as unknown as Record<string, unknown>,
      };
    },
    ...(assert === undefined ? {} : {assert}),
  };
}

/**
 * Abbreviate a replay key without hiding what distinguishes one from another.
 *
 * A replay key packs `(chainKey, blockHeight, txIndex, logIndex)` at bit offsets 192, 128, 64, and 0,
 * so its leading bytes are the chainKey and are the *same* for every log of a Source Chain, and its
 * trailing bytes are the log ordinal. Eliding the middle, which is where the height and the
 * transaction index live, renders two keys of one transaction as the identical string. The tail is
 * kept wide enough to carry the height, the index, and the ordinal.
 */
const short = (hex: string): string => `${hex.slice(0, 6)}…${hex.slice(-34)}`;

/**
 * The assertions every acceptance case shares: each recognised, registered log's replay key is spent
 * afterwards, and the verifier emitted exactly one `SettlementRecorded` per such key, crediting the
 * agent bound to `topics[1]`.
 */
async function assertIngested(
  ctx: CaseContext,
  prepared: PreparedSubmission,
): Promise<{assertions: Assertion[]; creditedAgents: string[]}> {
  const assertions: Assertion[] = [];
  const creditedAgents: string[] = [];
  const ingestions = prepared.expectedIngestions ?? [];
  const creditable = ingestions.filter((entry) => entry.recognised && entry.collectionRegistered);

  assertions.push(
    assertion(
      'the target carries at least one log the deployment recognises and can credit',
      creditable.length > 0,
      `${creditable.length} of ${ingestions.length} Settlement-shaped log(s) are recognised with a registered Collection Address`,
    ),
  );

  for (const entry of creditable) {
    const claimed = await ctx.reads.claimedLog(entry.replayKey);
    assertions.push(
      assertion(
        `replay key ${short(entry.replayKey)} for log ${entry.ordinal} (${entry.signature}) is recorded as claimed`,
        claimed,
        `claimedLog answered ${claimed}`,
      ),
    );
    const recorded = await ctx.reads.settlementRecorded(entry.replayKey);
    const boundAgent = await ctx.reads.agentOf(prepared.target.chainKey, entry.payerFromTopic1);
    const creditedRight = recorded.length === 1 && recorded[0].agent.toLowerCase() === boundAgent.toLowerCase();
    if (recorded.length === 1) creditedAgents.push(recorded[0].agent);
    assertions.push(
      assertion(
        `exactly one SettlementRecorded exists for ${short(entry.replayKey)} and credits the agent bound to topics[1] ${entry.payerFromTopic1}`,
        creditedRight,
        recorded.length === 0
          ? 'no SettlementRecorded event was found for the key'
          : `${recorded.length} event(s); the first credits ${recorded[0].agent} in Creditcoin tx ${recorded[0].creditcoinTxHash}; AgentRegistry.agentOf(topics[1]) is ${boundAgent}`,
      ),
    );
  }
  return {assertions, creditedAgents};
}

// -------------------------------------------------------------------------------------- registry

/**
 * The registry. Ten identities cover the nine requirement cases, because 27.12 has two live shapes:
 * one reachable from Mainnet history today, which proves the skip, and one that needs a Sepolia
 * Settlement carrying an anonymous log, which proves the ingestion.
 */
export const CASES: readonly LiveCase[] = [
  mutationCase(
    'forged-merkle-root',
    'Forged Merkle root',
    ['27.4'],
    ['ProofRejected', 'Error(string)'],
    'The deployment must refuse a submission whose claimed transaction-trie root the sibling path cannot reproduce. ' +
      '`ProofRejected` is the refusal the contract raises when the precompile answers false; a string revert from the ' +
      'precompile itself is the other shape this can take, and both are recorded rather than one being assumed.',
    (tx) => forgeMerkleRoot(tx),
  ),
  mutationCase(
    'tampered-encoded-transaction',
    'Tampered encoded transaction payload',
    ['27.5'],
    ['ProofRejected', 'Error(string)'],
    'The deployment must refuse a submission whose payload has been altered after the proof was built. One inverted ' +
      'byte is enough: the leaf no longer matches the sibling path, so inclusion of *these* bytes is unproven even ' +
      'though inclusion of the original bytes is a fact.',
    (tx) => tamperEncodedTransaction(tx),
  ),
  mutationCase(
    'wrong-chain-key',
    'Genuine Mainnet material submitted under the Sepolia chainKey',
    ['27.6'],
    ['UnauthorizedSourceChain', 'ProofRejected', 'Error(string)'],
    'The deployment must refuse a proof submitted under a chainKey other than the one authorising its emitter. ' +
      'Two defences stand in the way and either is a correct refusal: the precompile, whose Sepolia registry holds no ' +
      'Mainnet digest to chain the Continuity Proof to, and the verifier, which reverts `UnauthorizedSourceChain` when an ' +
      'emitter is authorised on a different chainKey. Which one answered is recorded, not assumed.',
    (tx, chainKeys) => substituteChainKey(tx, chainKeys.sepolia),
  ),
  unmutatedRefusalCase(
    'reverted-source-transaction',
    'Source Chain transaction whose receipt status is zero',
    ['27.8'],
    ['SourceTransactionReverted'],
    'A reverted Ethereum transaction is genuine history and its proof verifies, and it must still credit nothing. ' +
      'The verifier decodes `receiptStatus` before it reads a single log and reverts `SourceTransactionReverted` on ' +
      'anything but 1, so a failed payment never reduces an Open Tab.',
    'mainnet-reverted',
  ),
  unmutatedRefusalCase(
    'unregistered-recipient',
    'Genuine Transfer to a recipient no Service registered',
    ['27.9'],
    ['UnknownCollectionAddress'],
    'A verified USDC Transfer to an address no Service registered for that Asset is recognised as a Settlement shape ' +
      'and then refused by name: `UnknownCollectionAddress` carries the chainKey, the recipient, and the Asset. The ' +
      'proof is genuine and unchanged, so the refusal is attributable to the registry lookup alone.',
    'mainnet-transfer',
  ),
  unmutatedRefusalCase(
    'zero-topic-log-skipped',
    'Zero-topic log ahead of a recognised log, skipped rather than choked on',
    ['27.12'],
    ['UnknownCollectionAddress'],
    'A receipt carrying an anonymous log before a USDC Transfer. The ordinal sweep skips the log with no topics and ' +
      'carries on; reaching the Transfer is proven by the refusal coming from *its* handler, `UnknownCollectionAddress`, ' +
      'because on this deployment every Mainnet recipient is unregistered. This establishes the skip and the ' +
      'continuation; the ingestion half of 27.12 is the `zero-topic-log-ingested` case, which needs a Sepolia Settlement.',
    'mainnet-zero-topic',
  ),
  namedSettlementCase(
    'replayed-settlement',
    'Replay of an accepted replay key',
    ['27.7'],
    'refusal',
    ['AlreadyClaimed'],
    'A Settlement the deployment already accepted, submitted again with fresh proof material. The proof verifies ' +
      'again, the receipt decodes again, and the sweep reverts `AlreadyClaimed` with the packed key the moment it reaches ' +
      'the recognised log, so no Settlement can credit twice however many times it is proven.',
    {
      handoffKey: 'bindingSettlement',
      recipe: 'any Source Chain transaction the verifier has already recorded a SettlementRecorded event for',
    },
    undefined,
  ),
  namedSettlementCase(
    'payer-from-topic',
    'Transaction sender differs from the Settlement payer in topics[1]',
    ['27.10'],
    'acceptance',
    ['AlreadyClaimed'],
    'A Settlement whose transaction `from` is not the address in `topics[1]`, as with a relayer or a smart account. ' +
      'The deployment must credit the agent bound to `topics[1]` and nothing to the agent bound to `from`; the ' +
      'assertions read both histories before and after, and the SettlementRecorded event names the credited agent.',
    {
      handoffKey: 'relayedSettlement',
      recipe:
        'a Sepolia TabSettlement.settle or a USDC transfer whose transaction sender is a different address from the ' +
        'paying account, with the paying account bound in AgentRegistry',
    },
    async (ctx, prepared) => {
      const target = prepared.target;
      const before = prepared.before as unknown as CreditState;
      const {assertions, creditedAgents} = await assertIngested(ctx, prepared);
      const first = (prepared.expectedIngestions ?? []).find((entry) => entry.recognised && entry.collectionRegistered) ?? null;
      const asset = first?.asset ?? null;
      const payerAddress = target.settlementLog?.payerFromTopic1 ?? target.txFrom;
      const [payer, sender] = await Promise.all([
        snapshotAddress(ctx.reads, target.chainKey, payerAddress, asset),
        snapshotAddress(ctx.reads, target.chainKey, target.txFrom, asset),
      ]);

      assertions.push(
        assertion(
          'the transaction sender and the payer in topics[1] are different addresses',
          target.payerDiffersFromTxFrom === true,
          `from ${target.txFrom}, topics[1] ${payerAddress}`,
        ),
      );
      assertions.push(
        assertion(
          'the payer in topics[1] resolves to a bound Creditcoin agent',
          payer.bound,
          `AgentRegistry.agentOf(${target.chainKey}, ${payer.ethAddress}) is ${payer.agent}`,
        ),
      );
      assertions.push(
        assertion(
          'every credited agent is the one bound to topics[1]',
          creditedAgents.length > 0 && creditedAgents.every((agent) => agent.toLowerCase() === payer.agent.toLowerCase()),
          `credited ${creditedAgents.join(', ') || 'nobody'}; bound to topics[1] is ${payer.agent}`,
        ),
      );
      const senderHistoryUnchanged =
        !sender.bound ||
        sender.agent.toLowerCase() === payer.agent.toLowerCase() ||
        (before.sender.history !== null && sender.history !== null && before.sender.history.count === sender.history.count);
      assertions.push(
        assertion(
          'the agent bound to `from`, if any and if distinct, received no credit',
          senderHistoryUnchanged,
          sender.bound
            ? `agentOf(from) is ${sender.agent}; history count before ${before.sender.history?.count ?? 'n/a'}, after ${sender.history?.count ?? 'n/a'}`
            : `from ${sender.ethAddress} is bound to no agent, so there is nobody to have miscredited`,
        ),
      );
      if (payer.history !== null && before.payer.history !== null) {
        assertions.push(
          assertion(
            'the history of the agent bound to topics[1] grew by the number of creditable logs',
            payer.history.count - before.payer.history.count === creditedAgents.length,
            `count before ${before.payer.history.count}, after ${payer.history.count}, credited events ${creditedAgents.length}`,
          ),
        );
      }
      return assertions;
    },
  ),
  namedSettlementCase(
    'two-recognised-logs',
    'Two recognised Settlement logs in one Source Chain transaction',
    ['27.11'],
    'acceptance',
    ['AlreadyClaimed'],
    'One Source Chain transaction carrying two or more recognised Settlement logs. Every recognised log must be ' +
      'ingested under its own replay key, each key distinct in its logIndex, and one SettlementRecorded per key, so ' +
      'batching never silently loses a payment behind a replay guard.',
    {
      handoffKey: 'batchSettlement',
      recipe:
        'a Sepolia TabSettlement.settleBatch carrying at least two DISTINCT Settlement instructions from a bound ' +
        'account, or genuine Mainnet material with two real Settlements in one transaction. A single ' +
        'TabSettlement.settle does NOT qualify: it emits a Transfer and a TabSettled for one payment, and both being ' +
        'recognised is the emitter-registration defect recorded as task 10.12, not two Settlements',
    },
    async (ctx, prepared) => {
      const {assertions} = await assertIngested(ctx, prepared);
      const creditable = (prepared.expectedIngestions ?? []).filter((entry) => entry.recognised && entry.collectionRegistered);
      const keys = new Set(creditable.map((entry) => entry.replayKey));
      assertions.push(
        assertion(
          'the transaction carries at least two recognised, creditable logs',
          creditable.length >= 2,
          `${creditable.length} creditable log(s) at ordinals ${creditable.map((entry) => entry.ordinal).join(', ')}`,
        ),
      );
      assertions.push(
        assertion('every creditable log spends a distinct replay key', keys.size === creditable.length, `${keys.size} distinct key(s) for ${creditable.length} log(s)`),
      );
      return assertions;
    },
  ),
  namedSettlementCase(
    'zero-topic-log-ingested',
    'Zero-topic log beside a recognised log, with the recognised log ingested',
    ['27.12'],
    'acceptance',
    ['AlreadyClaimed'],
    'A Source Chain transaction that carries a log with no topics beside a recognised Settlement log to a registered ' +
      'Collection Address. The sweep must skip the anonymous log and ingest the recognised one, which the claim ledger ' +
      'and the SettlementRecorded event establish afterwards.',
    {
      handoffKey: 'zeroTopicSettlement',
      recipe:
        'a Sepolia transaction from a bound account that emits an anonymous (log0) event and then calls ' +
        'TabSettlement.settle in the same transaction, for instance through a tiny helper contract',
    },
    async (ctx, prepared) => {
      const {assertions} = await assertIngested(ctx, prepared);
      assertions.push(
        assertion(
          'the receipt carries at least one log with zero topics',
          prepared.target.zeroTopicLogOrdinals.length > 0,
          `zero-topic ordinals: ${prepared.target.zeroTopicLogOrdinals.join(', ') || 'none'}`,
        ),
      );
      return assertions;
    },
  ),
];
