// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {INativeQueryVerifier, NativeQueryVerifierLib} from "../interfaces/INativeQueryVerifier.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";

/// @title TabAscBase
/// @notice Verification and ingestion machinery for Source Chain Settlements. This contract proves,
/// through the BlockProver Precompile, that a Source Chain transaction was included in an attested
/// block; decodes its receipt; and hands every recognised Settlement log to a business hook exactly
/// once. It holds the replay ledger and the batch bounds, and nothing else.
/// @dev Abstract on purpose. Recognition and handling are declared here as hooks and supplied by
/// `SettlementVerifier`, so that this contract carries no registry lookup, no payer resolution, no
/// tab accounting, and no Bond logic. Verification is generic; interpretation is not.
///
/// Three shapes in here are deliberate and each prevents a specific failure mode. They are marked
/// `Correction 1`, `Correction 2`, and `Correction 3` at the declarations that carry them:
///
///  1. The replay ledger is keyed per **log**, not per transaction.
///  2. `chainKey` is threaded into every business hook.
///  3. Handler selection reads the verified log only; no entrypoint parameter steers dispatch.
///
/// Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.2, 4.3, 4.4, 4.5, 4.6, 5.6, 6.2, 7.1, 7.2,
/// 7.3, 9.1, 9.2, 9.3, 9.4, 9.5
abstract contract TabAscBase {
    // ------------------------------------------------------------------ constants

    /// @notice Largest number of Merkle Proofs one batch submission may carry. (R9.1, R9.3)
    /// @dev Bounded because each entry costs one `verifyAndEmit` call plus one receipt decode, and
    /// an unbounded batch would let a single submission exceed the block gas limit and become
    /// permanently unminable rather than merely expensive.
    uint256 internal constant MAX_BATCH_PROOFS = 10;

    /// @notice Widest Source Chain block-height span one batch submission may cover.
    /// @dev Not a proof-sharing bound. Each member carries its own Continuity Proof, so nothing here
    /// is shared. The span is bounded because a Continuity Proof is a gapless digest chain from an
    /// attested endpoint down to the proved block, and building ten of them across widely separated
    /// heights means ten long chains rather than ten short ones — the calldata, and so the gas, grows
    /// with the distance. Capping the span keeps a batch's cost predictable from its size alone.
    ///
    /// It is also the bound the off-chain batch planner has to respect alongside proof availability:
    /// the SDK refuses to merge proofs whose attestation windows do not touch, so proximity, not
    /// only this ceiling, decides what may travel together. (R9.4)
    uint64 internal constant MAX_BATCH_SPAN_BLOCKS = 1000;

    /// @notice `receiptStatus` value that denotes a successful Source Chain transaction. (R7.1)
    uint8 internal constant RECEIPT_STATUS_SUCCESS = 1;

    // ------------------------------------------------------------------ immutables

    /// @notice The BlockProver Precompile this contract verifies against. (R3.1)
    /// @dev Immutable and set from the address library rather than from a constructor argument, so
    /// no deployment or upgrade path can aim verification at a contract that merely returns `true`.
    INativeQueryVerifier public immutable VERIFIER;

    // ------------------------------------------------------------------ storage

    /// @notice Replay ledger: has this Settlement log already been ingested?
    /// @dev **Correction 1 — the replay key is log-scoped.** The key is the tuple
    /// `(chainKey, blockHeight, txIndex, logIndex)`. A transaction-scoped key would let the first
    /// recognised log in a transaction consume the transaction's only identity, after which every
    /// further Settlement log in that same transaction is permanently unclaimable: the Agent's money
    /// moved on the Source Chain and its remaining tabs stay open, with no recovery path. Batching
    /// several Settlements into one Source Chain transaction is a first-class feature, so that
    /// failure mode would be routine rather than exotic. (R4.1, R4.3)
    mapping(bytes32 => bool) public claimedLog;

    /// @notice Creditcoin block number in which each replay key was ingested.
    /// @dev Recorded for audit and for off-chain reconciliation after a crash between recording a
    /// submission and broadcasting it. It is never read as a gate.
    mapping(bytes32 => uint64) public ingestedAt;

    // ------------------------------------------------------------------ inputs

    /// @notice One Source Chain transaction together with its inclusion proof.
    /// @dev **Correction 3 — every field here is proof material or Source Chain data.** There is no
    /// action byte, handler address, or selector, and no transaction index: the index is recovered
    /// from the proof. A caller-supplied dispatch field sits outside the proof, which means a valid
    /// proof of a benign transaction could be aimed at the wrong interpretation of the same bytes on
    /// the code path that moves accounting value. (R6.2, R6.3, R3.3)
    struct SourceTx {
        /// @dev Attested-chain identifier the transaction belongs to.
        uint64 chainKey;
        /// @dev Source Chain block height holding the transaction.
        uint64 blockHeight;
        /// @dev The transaction as published on the Source Chain.
        bytes encodedTransaction;
        /// @dev Inclusion proof of that transaction against its block's transaction-trie root.
        INativeQueryVerifier.MerkleProof merkleProof;
        /// @dev Link from an attested endpoint down to the block holding this transaction.
        ///
        /// **The Continuity Proof belongs to the transaction, not to the batch.** The precompile
        /// treats the proof's first root as the transaction-trie root of the height under proof, so a
        /// proof built to span a batch verifies only the batch's lowest height and reverts
        /// `"Merkle root mismatch"` at every other one. That was measured on the live network, not
        /// assumed: over ten Settlements a keyless preflight verified 10 of 10 against their own
        /// proofs and 1 of 10 against a shared proof, and the failed submission is on chain. Carrying
        /// the proof inside this struct is what makes the wrong pairing unexpressible. (R9.1, R9.7)
        INativeQueryVerifier.ContinuityProof continuityProof;
    }

    // ------------------------------------------------------------------ events

    /// @notice One event per verified Source Chain transaction that yielded at least one Settlement.
    /// @dev Per-log accounting events are emitted by the business hook; this one records that the
    /// proof gate was passed and how many logs the sweep ingested, which is what an indexer needs to
    /// reconcile a submission against its receipt.
    /// @param chainKey Attested-chain identifier of the verified transaction.
    /// @param blockHeight Source Chain block height of the verified transaction.
    /// @param txIndex Index of the transaction within its block, recovered from the proof.
    /// @param recognisedLogs Number of logs ingested from this transaction.
    event SourceTxVerified(uint64 chainKey, uint64 blockHeight, uint64 txIndex, uint256 recognisedLogs);

    // ------------------------------------------------------------------ errors

    /// @notice A batch submission carried no Merkle Proof. (R9.1)
    error EmptyBatch();

    /// @notice A batch submission carried more Merkle Proofs than one submission may hold. (R9.3)
    /// @param provided Number of Merkle Proofs submitted.
    /// @param maximum Largest number accepted.
    error BatchTooLarge(uint256 provided, uint256 maximum);

    /// @notice The block heights in a batch are too far apart for one submission.
    /// @param lowestHeight Lowest Source Chain block height in the batch.
    /// @param highestHeight Highest Source Chain block height in the batch.
    /// @param maximumSpan Widest span accepted. (R9.4)
    error BatchRangeExceeded(uint64 lowestHeight, uint64 highestHeight, uint64 maximumSpan);

    /// @notice The submitted `chainKey` is not a Source Chain this contract settles from. (R5.6)
    /// @param chainKey The rejected attested-chain identifier.
    error UnsupportedChainKey(uint64 chainKey);

    /// @notice The BlockProver Precompile did not prove inclusion of the submitted transaction.
    /// @dev Raised when `verifyAndEmit` returns `false`. A `false` return is treated exactly like a
    /// revert: the submission unwinds and no storage location this contract or its hooks own is left
    /// written. (R3.2)
    /// @param chainKey Attested-chain identifier submitted.
    /// @param blockHeight Source Chain block height submitted.
    /// @param merkleRoot Transaction-trie root the rejected proof claimed.
    error ProofRejected(uint64 chainKey, uint64 blockHeight, bytes32 merkleRoot);

    /// @notice The verified transaction is not an EVM transaction type the decoder handles. (R3.6)
    /// @param txType The rejected transaction type byte.
    error UnsupportedTransactionType(uint8 txType);

    /// @notice The verified transaction's receipt reports failure, so it moved no value. (R7.2)
    /// @param chainKey Attested-chain identifier of the transaction.
    /// @param blockHeight Source Chain block height of the transaction.
    /// @param txIndex Index of the transaction within its block.
    error SourceTransactionReverted(uint64 chainKey, uint64 blockHeight, uint64 txIndex);

    /// @notice The verified transaction carried no recognised Settlement log. (R4.6)
    /// @param chainKey Attested-chain identifier of the transaction.
    /// @param blockHeight Source Chain block height of the transaction.
    /// @param txIndex Index of the transaction within its block.
    error NoRecognisedSettlement(uint64 chainKey, uint64 blockHeight, uint64 txIndex);

    /// @notice This Settlement log has already been ingested. (R4.2)
    /// @dev The parameter is named `key` rather than `replayKey` so it does not shadow the public
    /// `replayKey` function. Parameter names carry no weight in the error selector, so the ABI is
    /// unchanged either way.
    /// @param key The packed `(chainKey, blockHeight, txIndex, logIndex)` key already claimed.
    error AlreadyClaimed(bytes32 key);

    /// @notice The indexed sweep and the signature filter disagree about the receipt. (R3.5)
    /// @dev A disagreement is a decode-level fault, not a business outcome, so the submission
    /// reverts rather than crediting the smaller of two answers.
    /// @param sweepCount Number of logs the ordinal sweep ingested.
    /// @param filterCount Number of logs the signature filter recognised.
    error LogCountMismatch(uint256 sweepCount, uint256 filterCount);

    // ------------------------------------------------------------------ construction

    /// @notice Binds the BlockProver Precompile.
    constructor() {
        VERIFIER = NativeQueryVerifierLib.getVerifier();
    }

    // ------------------------------------------------------------------ entrypoints

    /// @notice Submit one proved Source Chain transaction for ingestion.
    /// @dev **Correction 3.** The parameter list is proof material and Source Chain data only: no
    /// handler, no action, no selector. Dispatch is derived inside `_handleRecognisedLog` from the
    /// verified log's emitter and its `topics[0]`, and from nothing else. (R6.1, R6.2)
    /// @param sourceTx The Source Chain transaction, its inclusion proof, and its Continuity Proof.
    /// One argument, so a proof cannot be paired with a transaction it was not built for.
    /// @return ingestedLogs Number of Settlement logs ingested from this transaction.
    function submitSettlement(SourceTx calldata sourceTx) external returns (uint256 ingestedLogs) {
        ingestedLogs = _verifyAndIngest(sourceTx);
    }

    /// @notice Submit 1 to 10 proved Source Chain transactions, each with its own Continuity Proof.
    /// @dev Shape and rationale:
    ///
    /// - **Sequential, not array-shaped.** The precompile publishes array-shaped verification
    ///   overloads, and this contract deliberately does not call them. A batch here is N sequential
    ///   single-transaction `verifyAndEmit` calls. That keeps a verification failure attributable to
    ///   one named Settlement instead of to an opaque batch, and it runs every ingestion through the
    ///   identical code path as a lone submission, so batching adds no second implementation of the
    ///   thing that must never be wrong. Measured on the live network, the sequential shape costs
    ///   557,718 gas for ten Settlements against 525,448 for the array shape — 5.8 percent more, of a
    ///   submission that occupies 0.74 percent of a 75,000,000 gas block. (R9.2, R9.7)
    /// - **A Continuity Proof per member, never one shared.** Not a preference. A shared proof
    ///   verifies only the batch's lowest height and reverts `"Merkle root mismatch"` at every other
    ///   one, because the precompile reads the proof's first root as the root of the height under
    ///   proof. So there is no proof parameter beside the array: each proof travels inside its own
    ///   `SourceTx`, which makes the broken pairing unexpressible rather than merely discouraged.
    ///   (R9.1)
    /// - **All-or-nothing.** Any rejected proof, duplicate replay key, or failed receipt reverts the
    ///   whole call, so a partially applied batch is not a reachable state. (R9.5)
    ///
    /// @param sourceTxs The Source Chain transactions, each with its own inclusion proof and its own
    /// Continuity Proof.
    /// @return ingestedLogs Total Settlement logs ingested across the batch.
    function submitSettlementBatch(SourceTx[] calldata sourceTxs) external returns (uint256 ingestedLogs) {
        uint256 n = sourceTxs.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_BATCH_PROOFS) revert BatchTooLarge(n, MAX_BATCH_PROOFS);

        // Bound the span before verifying anything, so an ill-formed batch costs no proof calls.
        uint64 lowest = type(uint64).max;
        uint64 highest = 0;
        for (uint256 i = 0; i < n; ++i) {
            uint64 h = sourceTxs[i].blockHeight;
            if (h < lowest) lowest = h;
            if (h > highest) highest = h;
        }
        if (highest - lowest > MAX_BATCH_SPAN_BLOCKS) {
            revert BatchRangeExceeded(lowest, highest, MAX_BATCH_SPAN_BLOCKS);
        }

        for (uint256 i = 0; i < n; ++i) {
            ingestedLogs += _verifyAndIngest(sourceTxs[i]);
        }
    }

    // ------------------------------------------------------------------ core

    /// @notice Prove one Source Chain transaction and ingest every recognised Settlement log in it.
    /// @dev The order of the six steps below is fixed and load-bearing. Reading it top to bottom:
    /// nothing is decoded before inclusion is proved, no index is trusted from the caller, no field
    /// is read before the transaction type is accepted, and no log is ingested before the receipt is
    /// known to have succeeded. The first write to any storage location happens inside step 5, after
    /// the proof gate in step 1 has returned `true`, which is what makes a `false` return from the
    /// precompile indistinguishable from a revert as far as state is concerned. (R3.7, R7.3)
    /// @param sourceTx The Source Chain transaction, its inclusion proof, and its Continuity Proof.
    /// @return ingestedLogs Number of Settlement logs ingested from this transaction.
    function _verifyAndIngest(SourceTx calldata sourceTx) internal returns (uint256 ingestedLogs) {
        // 0. Source Chain gate. Cheapest rejection, and it runs before any external call. (R5.6)
        if (!_isSupportedChainKey(sourceTx.chainKey)) revert UnsupportedChainKey(sourceTx.chainKey);

        // 1. Proof first. Nothing this contract or its hooks own is written before this returns
        //    true, and a false return unwinds the submission exactly as a revert would. (R3.1, R3.2)
        bool verified = VERIFIER.verifyAndEmit(
            sourceTx.chainKey,
            sourceTx.blockHeight,
            sourceTx.encodedTransaction,
            sourceTx.merkleProof,
            sourceTx.continuityProof
        );
        if (!verified) {
            revert ProofRejected(sourceTx.chainKey, sourceTx.blockHeight, sourceTx.merkleProof.root);
        }

        // 2. The transaction index is recovered from the proof's sibling laterality, never accepted
        //    from the caller. It is one of the four fields of the replay key, so a caller-supplied
        //    index would let the same log be claimed under many identities. (R3.3)
        uint64 txIndex = VERIFIER.calculateTxIndex(sourceTx.merkleProof);

        // 3. Transaction type gate before any field decoding. (R3.4, R3.6)
        uint8 txType = EvmV1Decoder.getTransactionType(sourceTx.encodedTransaction);
        if (!EvmV1Decoder.isValidTransactionType(txType)) revert UnsupportedTransactionType(txType);

        // 4. Receipt status gate before any log is ingested. A reverted Source Chain transaction
        //    moved no value, so its logs must credit nothing. (R7.1, R7.2, R7.3)
        EvmV1Decoder.ReceiptFields memory receipt =
            EvmV1Decoder.decodeReceiptFields(sourceTx.encodedTransaction);
        if (receipt.receiptStatus != RECEIPT_STATUS_SUCCESS) {
            revert SourceTransactionReverted(sourceTx.chainKey, sourceTx.blockHeight, txIndex);
        }

        // 5. Ordinal sweep over every log in the receipt. The loop counter *is* the receipt-wide
        //    `logIndex` that the replay key needs, which is why the sweep walks the array rather
        //    than taking the first signature match and assuming there is only one.
        uint256 logCount = receipt.receiptLogs.length;
        for (uint256 i = 0; i < logCount; ++i) {
            EvmV1Decoder.LogEntry memory logEntry = receipt.receiptLogs[i];

            // A log with no topics carries no event signature, so it can match nothing. Skip it and
            // keep going: an unrelated log must not strand the Settlements beside it. (R4.4)
            if (logEntry.topics.length == 0) continue;

            // An `(emitter, topics[0])` pair that matches nothing registered is somebody else's
            // event. Skip it and keep going. (R4.5)
            //
            // **Correction 2.** `chainKey` is passed in rather than dropped, because the same
            // address can exist on more than one Source Chain and a deployer controls its own
            // testnet addresses. Authorising on the emitter alone would let a testnet deployment at
            // a matching address manufacture mainnet credit.
            if (!_isRecognised(sourceTx.chainKey, logEntry)) continue;

            // A recognised log that is another recognised log's mechanical side effect is skipped, so
            // one payment is credited once however many shapes it takes on the wire. Skipped rather
            // than reverted, for the same reason an unrecognised log is skipped: a duplicate
            // representation must not strand the Settlements beside it. The replay key is deliberately
            // left unclaimed, because the log was never ingested and the key names a Settlement that
            // this deployment did not credit. (R4.3)
            if (_isSupersededInReceipt(sourceTx.chainKey, receipt, i)) continue;

            // casting to 'uint64' is safe because `i` indexes an in-memory array decoded from one
            // Source Chain receipt, so it is bounded by that receipt's log count and cannot approach
            // 2^64 within any block gas limit.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint64 logIndex = uint64(i);
            bytes32 key = replayKey(sourceTx.chainKey, sourceTx.blockHeight, txIndex, logIndex);

            // Claim before handling. A duplicate makes the whole submission a replay attempt, so it
            // reverts rather than being skipped: skipping would let a caller mix fresh and replayed
            // logs in one call and have the fresh ones credited. (R4.2)
            if (claimedLog[key]) revert AlreadyClaimed(key);
            claimedLog[key] = true;
            // casting to 'uint64' is safe because this is audit metadata, never a gate, and a
            // Creditcoin block number stays far below 2^64 for the lifetime of the chain.
            // forge-lint: disable-next-line(unsafe-typecast)
            ingestedAt[key] = uint64(block.number);

            _handleRecognisedLog(sourceTx.chainKey, sourceTx.blockHeight, txIndex, logIndex, key, logEntry);
            ++ingestedLogs;
        }

        // 6. Cross-check the sweep against signature filtering over the same receipt. Two
        //    independent readings of one receipt must agree on how many Settlement logs it carries;
        //    if they do not, the receipt has been decoded two different ways and neither answer is
        //    safe to credit. (R3.5)
        uint256 filterCount = _filteredRecognisedCount(sourceTx.chainKey, receipt);
        if (filterCount != ingestedLogs) revert LogCountMismatch(ingestedLogs, filterCount);

        // A transaction with nothing recognised is not a Settlement at all. (R4.6)
        if (ingestedLogs == 0) {
            revert NoRecognisedSettlement(sourceTx.chainKey, sourceTx.blockHeight, txIndex);
        }

        emit SourceTxVerified(sourceTx.chainKey, sourceTx.blockHeight, txIndex, ingestedLogs);
    }

    // ------------------------------------------------------------------ replay key

    /// @notice Packs the identity of one ingested Settlement log into a single word.
    /// @dev Four fixed-width `uint64` fields fill exactly one 32-byte word, so the map from tuple to
    /// key is injective by construction and no hash is needed:
    ///
    ///  bits 255..192 : chainKey
    ///  bits 191..128 : blockHeight
    ///  bits 127..64  : txIndex
    ///  bits  63..0   : logIndex
    ///
    /// The off-chain half of this packing lives in `packages/shared/src/replay-key.ts` and the bit
    /// offsets above are the agreement between the two. The agreement is checked by executing both
    /// implementations over one generated tuple set: `tools/replay-key-fixture.mjs` runs the
    /// off-chain function and records its output, and `test/property/ReplayKeyDifferential.t.sol`
    /// runs this function over the same tuples and compares. (R4.1)
    ///
    /// `public` rather than `internal`: the Watcher records a replay key before broadcasting, and an
    /// indexer reading `claimedLog` needs to compute the same key from Source Chain coordinates, so
    /// both halves of the packing are part of this contract's read surface. It stays `pure`, so
    /// exposing it grants no authority over anything.
    /// @param chainKey Attested-chain identifier of the Settlement.
    /// @param blockHeight Source Chain block height of the Settlement.
    /// @param txIndex Index of the transaction within its block.
    /// @param logIndex Receipt-wide ordinal of the log within that transaction.
    /// @return key The packed replay key.
    function replayKey(uint64 chainKey, uint64 blockHeight, uint64 txIndex, uint64 logIndex)
        public
        pure
        returns (bytes32 key)
    {
        key = bytes32(
            (uint256(chainKey) << 192) | (uint256(blockHeight) << 128) | (uint256(txIndex) << 64)
                | uint256(logIndex)
        );
    }

    /// @notice The inverse of {replayKey}: recovers the four fields from a packed key.
    /// @dev Every one of the `2^256` words is a well-formed key, because the four `uint64` fields
    /// fill the word exactly and leave no reserved bits, so this function has no rejection case. The
    /// off-chain inverse does reject its input, but only because it takes a string and must first
    /// establish that the string is a 32-byte word at all; that check has no on-chain counterpart.
    ///
    /// Each `uint64` cast keeps the low 64 bits of the shifted word, which is exactly the field the
    /// off-chain implementation extracts with `& (2^64 - 1)`.
    /// @param key The packed replay key.
    /// @return chainKey Attested-chain identifier of the Settlement.
    /// @return blockHeight Source Chain block height of the Settlement.
    /// @return txIndex Index of the transaction within its block.
    /// @return logIndex Receipt-wide ordinal of the log within that transaction.
    function unpackReplayKey(bytes32 key)
        public
        pure
        returns (uint64 chainKey, uint64 blockHeight, uint64 txIndex, uint64 logIndex)
    {
        uint256 word = uint256(key);
        // Each cast is a deliberate truncation to the field's 64-bit width, not an assumption about
        // magnitude, so the lint's unsafe-cast warning does not apply to any of the four.
        // forge-lint: disable-next-line(unsafe-typecast)
        chainKey = uint64(word >> 192);
        // forge-lint: disable-next-line(unsafe-typecast)
        blockHeight = uint64(word >> 128);
        // forge-lint: disable-next-line(unsafe-typecast)
        txIndex = uint64(word >> 64);
        // forge-lint: disable-next-line(unsafe-typecast)
        logIndex = uint64(word);
    }

    // ------------------------------------------------------------------ hooks

    /// @notice Is this attested chain one the implementation settles from?
    /// @dev Declared rather than decided here: which Source Chains are in play is a business fact.
    /// @param chainKey Attested-chain identifier submitted with the proof.
    /// @return supported True when Settlements from this chain are accepted.
    function _isSupportedChainKey(uint64 chainKey) internal view virtual returns (bool supported);

    /// @notice Is this verified log a Settlement the implementation recognises?
    /// @dev **Correction 2 and Correction 3 both land on this signature.** `chainKey` is threaded in
    /// so authorisation is on the `(chainKey, emitter)` pair, and the only other input is the
    /// verified log itself, so recognition can read nothing the proof did not establish. (R5.1,
    /// R6.1)
    /// @param chainKey Attested-chain identifier of the verified transaction.
    /// @param logEntry The verified log, as decoded from the receipt.
    /// @return recognised True when the log is a Settlement to ingest.
    function _isRecognised(uint64 chainKey, EvmV1Decoder.LogEntry memory logEntry)
        internal
        view
        virtual
        returns (bool recognised);

    /// @notice Apply the business meaning of one recognised Settlement log.
    /// @dev Called exactly once per replay key, after that key has been claimed. Handler selection
    /// inside the implementation must branch on the emitter and `topics[0]` of `logEntry` only.
    /// @param chainKey Attested-chain identifier of the verified transaction.
    /// @param blockHeight Source Chain block height of the verified transaction.
    /// @param txIndex Index of the transaction within its block, recovered from the proof.
    /// @param logIndex Receipt-wide ordinal of this log within that transaction.
    /// @param key The replay key just claimed for this log.
    /// @param logEntry The verified log, as decoded from the receipt.
    function _handleRecognisedLog(
        uint64 chainKey,
        uint64 blockHeight,
        uint64 txIndex,
        uint64 logIndex,
        bytes32 key,
        EvmV1Decoder.LogEntry memory logEntry
    ) internal virtual;

    /// @notice Count the recognised Settlement logs in a receipt by signature filtering.
    /// @dev The second, independent reading of the receipt that step 6 of `_verifyAndIngest` checks
    /// the ordinal sweep against. Implementations filter with `getLogsByEventSignature` once per
    /// registered Settlement signature and total the results. It is a hook rather than base logic
    /// because only the implementation knows which signatures are registered. (R3.5)
    /// @param chainKey Attested-chain identifier of the verified transaction.
    /// @param receipt The decoded receipt of the verified transaction.
    /// @return count Number of recognised Settlement logs the filter finds.
    function _filteredRecognisedCount(uint64 chainKey, EvmV1Decoder.ReceiptFields memory receipt)
        internal
        view
        virtual
        returns (uint256 count);

    /// @notice Whether a recognised log is another recognised log's mechanical side effect.
    /// @dev **The de-duplication hook, added because recognition alone cannot see it.** One payment can
    /// produce two recognised logs. A Source Chain settlement contract that pulls an Asset with
    /// `safeTransferFrom` emits an ERC-20 `Transfer`, and then emits its own settlement event naming
    /// the same payer, recipient, and amount. Both are genuine logs of one payment, and crediting both
    /// pays a Service twice for money that moved once.
    ///
    /// `_isRecognised` cannot make that judgement: it is handed one log at a time and holds no
    /// transaction context, so it cannot know whether a sibling log in the same receipt already
    /// accounts for the same movement. This hook is handed the whole receipt and the ordinal, which is
    /// exactly what the judgement needs.
    ///
    /// The base returns false, so a chain with a single Settlement shape carries no cost and no
    /// behaviour change. Requirement 4.3 is untouched by this: two *genuinely distinct* Settlements in
    /// one transaction must still both be ingested, and only a duplicate representation of one
    /// payment is suppressed.
    /// @param chainKey Attested-chain identifier of the verified transaction.
    /// @param receipt The decoded receipt of the verified transaction.
    /// @param ordinal Receipt-wide index of the log being considered.
    /// @return superseded True when the log must be skipped as a duplicate representation.
    function _isSupersededInReceipt(
        uint64 chainKey,
        EvmV1Decoder.ReceiptFields memory receipt,
        uint256 ordinal
    ) internal view virtual returns (bool superseded) {
        chainKey;
        receipt;
        ordinal;
        superseded = false;
    }
}
