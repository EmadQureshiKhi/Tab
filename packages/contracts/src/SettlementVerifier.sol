// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {TabAscBase} from "./asc/TabAscBase.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {IBond} from "./Bond.sol";
import {IServiceRegistry} from "./ServiceRegistry.sol";
import {ITabBook} from "./TabBook.sol";

/// @title IAgentRegistry
/// @notice The one question the `SettlementVerifier` asks the `AgentRegistry` on every Verified
/// Settlement: which Agent does this payer belong to.
/// @dev Declared here rather than under `src/interfaces/`, which holds the two precompile ABIs
/// confirmed against the live chain and is frozen, and rather than beside `AgentRegistry` itself,
/// which declares no interface of its own. The dependency is by ABI, not by import path, and the
/// suite deploys the real `AgentRegistry` behind this type so a signature that drifted would fail
/// there rather than pass silently.
interface IAgentRegistry {
    /// @notice Resolve a Verified Settlement's payer to an Agent, finalising a matching request.
    /// @param chainKey Attested-chain identifier the proof established.
    /// @param ethAddress The payer, taken from `topics[1]` of the verified Settlement log. (R8.1)
    /// @param amount The settled amount in Asset base units, taken from the verified log.
    /// @param provingReplayKey Replay key of the Verified Settlement, recorded on a new binding.
    /// @return agent The bound Agent, or the zero address when the payer is bound to nobody.
    function resolveOrBind(uint64 chainKey, address ethAddress, uint256 amount, bytes32 provingReplayKey)
        external
        returns (address agent);
}

/// @title SettlementVerifier
/// @notice The business half of Settlement ingestion. `TabAscBase` establishes that a Source Chain
/// transaction was included in an attested block and hands over each of its logs; this contract
/// decides which of those logs is a Settlement, whose Settlement it is, and what it settles.
/// @dev Everything here derives from the verified log and the registry, and from nothing a caller
/// supplied. Three shapes carry the weight of the file and each is argued at its declaration:
///
///  1. Authentication is on the `(chainKey, emitterAddress)` pair. An emitter authorised on a
///     different chain is an attack and reverts; an emitter authorised nowhere is somebody else's
///     event and is skipped. See {_isRecognised}.
///  2. The payer is `topics[1]` of the Settlement log, and the transaction's own `from` field is
///     never read on the crediting path. See {_handleErc20Transfer} and {_credit}.
///  3. Handler selection reads the log's emitter kind and its `topics[0]`. There is no caller-
///     supplied action byte, handler, or selector anywhere in the entrypoints, which are inherited
///     unchanged from `TabAscBase`. See {_handleRecognisedLog}.
///
/// Both Settlement shapes put the payer in `topics[1]` — ERC-20 `Transfer` by the standard, and
/// `TabSettled` because `TabSettlement` emits `msg.sender` there — so one payer-resolution rule
/// serves both handlers, and it is the rule in {_credit}.
///
/// A fourth shape was added by task 10.11 and belongs in the same list, because it is the same
/// discipline applied one step further. The recipient's `CollectionKind` decides whether a Verified
/// Settlement reduces an Open Tab or credits Bond stake, and that kind is read off the registry record
/// the proof's own recipient resolved to. See {_credit} and {_creditBond}.
///
/// Requirements: 2.1, 2.3, 2.4, 2.5, 3.5, 4.7, 5.1, 5.3, 5.4, 5.6, 6.1, 6.3, 6.4, 6.5, 8.1, 8.2,
/// 8.3, 8.4, 8.5, 14.1, 14.2, 18.4, 18.6
contract SettlementVerifier is TabAscBase {
    // ------------------------------------------------------------------ constants

    /// @notice Signature topic of the ERC-20 `Transfer` event, which is the Settlement on a chain
    /// where Tab deploys nothing. (R2.1)
    /// @dev `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`. `topics[1]` is the
    /// sender, so it is the payer, and `topics[2]` is the recipient, so it is the Collection Address.
    bytes32 public constant ERC20_TRANSFER_SIG = keccak256("Transfer(address,address,uint256)");

    /// @notice Signature topic of `TabSettlement.TabSettled`, the Settlement on chainKey 1.
    /// @dev `0xc3e17b180e5476ffcdf33da27a6f1d1bdff18cbee72e58913e2a2c1c73c64015`, measured from the
    /// compiled artefact of the Source Chain contract. This constant and the topic layout behind it
    /// are the cross-chain ABI agreement between the two contracts: three indexed parameters plus the
    /// signature give `topics.length == 4`, and `amount` alone in the data gives `data.length == 32`,
    /// which is exactly the arity {_handleTabSettled} checks. Moving `amount` into the topics would
    /// leave this hash identical while `abi.decode(logEntry.data, (uint256))` decoded nothing.
    bytes32 public constant TAB_SETTLED_SIG = keccak256("TabSettled(address,address,uint256,bytes32)");

    /// @notice Attested-chain identifier of Ethereum Sepolia, the chain carrying `TabSettlement`.
    uint64 public constant CHAIN_KEY_SEPOLIA = 1;

    /// @notice Attested-chain identifier of Ethereum Mainnet, where Tab deploys nothing. (R2.1)
    uint64 public constant CHAIN_KEY_MAINNET = 3;

    // ------------------------------------------------------------------ immutables

    /// @notice Registry the emitter authorisations and Collection Address resolutions come from.
    IServiceRegistry public immutable SERVICES;

    /// @notice Registry that turns a Source Chain payer address into an Agent identity.
    IAgentRegistry public immutable AGENTS;

    /// @notice Book the Verified Settlement is applied to.
    ITabBook public immutable TAB_BOOK;

    /// @notice Bond a proven deposit to a Bond Collection Address credits stake in. (R14.1, R18.6)
    /// @dev Stake is denominated in the Settlement Asset and the Asset lives on a Source Chain, so the
    /// only way stake can exist is a proven deposit arriving through this contract. Without this
    /// collaborator every ledger stays at zero, every bond cap is zero, and therefore every Credit
    /// Limit is zero, so no delivery can be metered and no tab can open on a fresh deployment.
    IBond public immutable BOND;

    // ------------------------------------------------------------------ events

    /// @notice One event per ingested Settlement log. (R4.7)
    /// @param replayKey Packed `(chainKey, blockHeight, txIndex, logIndex)` of the ingested log.
    /// @param chainKey Attested-chain identifier the proof established.
    /// @param blockHeight Source Chain block height of the verified transaction.
    /// @param txIndex Index of the transaction within its block, recovered from the proof.
    /// @param logIndex Ordinal of the log within that transaction's own receipt logs.
    /// @param agent Agent credited, resolved from `topics[1]`.
    /// @param serviceId Service resolved from the Collection Address named by the log.
    /// @param asset Asset the Settlement is denominated in.
    /// @param amount Settled amount in Asset base units.
    /// @param payerAddress Source Chain address taken from `topics[1]`.
    /// @param sourceTabId `TabSettled.tabId` when the log carried one, and zero otherwise.
    event SettlementRecorded(
        bytes32 indexed replayKey,
        uint64 chainKey,
        uint64 blockHeight,
        uint64 txIndex,
        uint64 logIndex,
        address indexed agent,
        bytes32 indexed serviceId,
        address asset,
        uint256 amount,
        address payerAddress,
        bytes32 sourceTabId
    );

    /// @notice One event per ingested proven Bond deposit. (R14.1, R18.6)
    /// @dev Deliberately not {SettlementRecorded}. The two are different economic facts: one reduces
    /// an Agent's Open Tab, the other creates Service stake that backs credit, and no reader should
    /// have to infer which happened by looking the recipient up in the registry after the fact.
    /// Reusing one event would also make every naive total wrong, because summing settled amounts per
    /// Service would count collateral as revenue. The coordinates are carried in the same order and
    /// with the same meanings, so an indexer handles both with one decoder and one branch.
    ///
    /// `party` is the Bond party key, which is the Service's `bondAccount` embedded as `bytes32`, so a
    /// reader can join this event to `BondFunded` without reading the registry.
    /// @param replayKey Packed `(chainKey, blockHeight, txIndex, logIndex)` of the ingested log.
    /// @param chainKey Attested-chain identifier the proof established.
    /// @param blockHeight Source Chain block height of the verified transaction.
    /// @param txIndex Index of the transaction within its block, recovered from the proof.
    /// @param logIndex Ordinal of the log within that transaction's own receipt logs.
    /// @param depositor Identity the payer resolved to, which is the account that bound the payer.
    /// @param serviceId Service whose Bond Collection Address the log named.
    /// @param asset Asset the stake is denominated in.
    /// @param amount Deposited amount in Asset base units.
    /// @param payerAddress Source Chain address taken from `topics[1]`.
    /// @param party Bond party key the stake was credited under.
    event BondDepositRecorded(
        bytes32 indexed replayKey,
        uint64 chainKey,
        uint64 blockHeight,
        uint64 txIndex,
        uint64 logIndex,
        address indexed depositor,
        bytes32 indexed serviceId,
        address asset,
        uint256 amount,
        address payerAddress,
        bytes32 party
    );

    // ------------------------------------------------------------------ errors

    /// @notice The Settlement named a recipient no Service has claimed on this chain. (R2.4)
    /// @param chainKey Attested-chain identifier of the Settlement.
    /// @param recipient The unclaimed recipient address.
    /// @param asset Asset the Settlement is denominated in, or zero where the log did not name one.
    error UnknownCollectionAddress(uint64 chainKey, address recipient, address asset);

    /// @notice The emitter is an authorised Settlement emitter, but on a different chain. (R5.3)
    /// @dev Distinct from being skipped, and the distinction is the whole point of pair
    /// authentication. An emitter authorised nowhere is an unrelated contract and its log is somebody
    /// else's event, so the sweep skips it and carries on. An emitter authorised *elsewhere* is a
    /// Settlement emitter presented under the wrong chain, which is the shape of a testnet
    /// deployment manufacturing mainnet credit, so the submission reverts and says where the emitter
    /// really is authorised.
    /// @param submittedChainKey Attested-chain identifier the proof established.
    /// @param emitter Address that emitted the log.
    /// @param authorisedMask Bit `i` set means the pair `(i, emitter)` is authorised.
    error UnauthorizedSourceChain(uint64 submittedChainKey, address emitter, uint64 authorisedMask);

    /// @notice `topics[1]` names a Source Chain address bound to no Agent. (R8.4)
    /// @param chainKey Attested-chain identifier of the Settlement.
    /// @param payerAddress The unbound payer, taken from `topics[1]`.
    error UnboundPayer(uint64 chainKey, address payerAddress);

    /// @notice The emitting Asset disagrees with the Asset the Collection Address collects. (R18.4)
    /// @param logAsset Asset that emitted the log.
    /// @param collectionAsset Asset the recipient is registered to collect.
    error AssetMismatch(address logAsset, address collectionAsset);

    /// @notice A recognised Settlement log does not carry the topic and data arity its shape fixes.
    /// @dev Recognition matches on the signature topic alone, and a signature hash covers the
    /// parameter *types* rather than which of them are indexed. So a log can match `TabSettled` and
    /// still carry its amount in the topics, where `abi.decode(logEntry.data, (uint256))` would
    /// decode nothing and credit zero. Checking the arity is what turns that into a revert.
    /// @param signature The matched signature topic.
    /// @param topicCount Topics the log actually carried.
    /// @param dataLength Data bytes the log actually carried.
    error MalformedSettlementLog(bytes32 signature, uint256 topicCount, uint256 dataLength);

    /// @notice A proven Bond deposit is too large for the `uint128` figures a Bond ledger is kept in.
    /// @dev The same bound `TabBook` applies to a Verified Settlement, applied on the branch that does
    /// not go through `TabBook`, so the two crediting paths agree on what an amount may be. A silent
    /// narrowing here would credit a wrapped remainder as stake.
    /// @param amount The rejected amount.
    error BondDepositOutOfRange(uint256 amount);

    /// @notice A constructor argument named the zero address.
    error ZeroAddressField();

    // ------------------------------------------------------------------ construction

    /// @notice Binds the four collaborators, and through `TabAscBase` the BlockProver Precompile.
    /// @dev All four are constructor immutables rather than one-shot wired slots, because all four
    /// are deployed before this contract and none of them takes this address in its constructor. That
    /// is strictly stronger than a one-shot setter: there is no window in which the registry a
    /// Settlement authenticates against, or the book it credits, is unset or settable.
    ///
    /// The other direction *is* wired, because `AgentRegistry`, `TabBook`, and `Bond` each take this
    /// address after the fact through their own authority-gated one-shot setters.
    /// @param services Registry of emitters, Collection Addresses, prices, and tiers.
    /// @param agents Registry that resolves a Source Chain payer to an Agent.
    /// @param tabBook Book the Verified Settlement is applied to.
    /// @param bond Bond a proven deposit to a Bond Collection Address credits stake in.
    constructor(IServiceRegistry services, IAgentRegistry agents, ITabBook tabBook, IBond bond) {
        if (address(services) == address(0)) revert ZeroAddressField();
        if (address(agents) == address(0)) revert ZeroAddressField();
        if (address(tabBook) == address(0)) revert ZeroAddressField();
        if (address(bond) == address(0)) revert ZeroAddressField();

        SERVICES = services;
        AGENTS = agents;
        TAB_BOOK = tabBook;
        BOND = bond;
    }

    // ------------------------------------------------------------------ hooks

    /// @inheritdoc TabAscBase
    /// @dev Two chains, and every other identifier reverts `UnsupportedChainKey` in the base before
    /// any external call is made. (R5.6)
    function _isSupportedChainKey(uint64 chainKey) internal pure override returns (bool supported) {
        supported = chainKey == CHAIN_KEY_SEPOLIA || chainKey == CHAIN_KEY_MAINNET;
    }

    /// @inheritdoc TabAscBase
    /// @dev **Authentication is on the pair, and the two negative answers are different answers.**
    /// The registry is asked about `(chainKey, emitter)`. When that pair is not authorised there are
    /// two cases and conflating them is how a chain-blind check would look:
    ///
    ///  - the emitter is authorised on some *other* chain, which means a Settlement emitter has been
    ///    presented under a chainKey it was never authorised for. That reverts, and the revert
    ///    carries the mask so the reader can see where it really is authorised. (R5.3)
    ///  - the emitter is authorised nowhere, which means the log belongs to a contract Tab has never
    ///    heard of. That returns false, so the sweep skips this log and keeps going: an unrelated
    ///    event in the same transaction must not strand the Settlements beside it. (R4.5)
    ///
    /// Recognition is then kind-scoped, so a signature alone is never enough. `Transfer` counts only
    /// from an Asset contract, and `TabSettled` only from a Tab-authored settlement contract on
    /// chainKey 1. The chainKey test on the second is what R6.5 asks for in as many words, and it is
    /// tighter than the emitter kind alone: a settlement contract authorised on Mainnet would
    /// otherwise have its `TabSettled` credited there, on a chain where Tab deploys nothing and the
    /// only Settlement shape is a plain `Transfer`. (R6.1, R6.4, R6.5)
    function _isRecognised(uint64 chainKey, EvmV1Decoder.LogEntry memory logEntry)
        internal
        view
        override
        returns (bool recognised)
    {
        IServiceRegistry.EmitterRecord memory emitter = SERVICES.emitterFor(chainKey, logEntry.address_);

        if (!emitter.authorised) {
            uint64 mask = SERVICES.emitterChainMask(logEntry.address_);
            if (mask != 0) revert UnauthorizedSourceChain(chainKey, logEntry.address_, mask);
            return false;
        }

        bytes32 signature = logEntry.topics[0];
        if (signature == ERC20_TRANSFER_SIG && emitter.kind == IServiceRegistry.EmitterKind.Asset) {
            return true;
        }
        if (
            signature == TAB_SETTLED_SIG && chainKey == CHAIN_KEY_SEPOLIA
                && emitter.kind == IServiceRegistry.EmitterKind.SettlementContract
        ) {
            return true;
        }
        recognised = false;
    }

    /// @inheritdoc TabAscBase
    /// @dev **Correction 3 lands here.** The branch reads the verified log's `topics[0]` and nothing
    /// else. There is no action byte to consult, because the entrypoints accept none. (R6.1, R6.3)
    ///
    /// The coordinate fields of the entry are filled in before the branch and the entry travels on as
    /// one memory pointer. That is a shape decision rather than a style one: the handlers and the
    /// crediting step would otherwise carry ten separate arguments each, which is the parameter count
    /// task 1.3 measured exhausting the legacy code generator's addressable stack. One pointer costs
    /// one slot, and the product project compiles at `via_ir = false` because that is what gets
    /// deployed.
    function _handleRecognisedLog(
        uint64 chainKey,
        uint64 blockHeight,
        uint64 txIndex,
        uint64 logIndex,
        bytes32 key,
        EvmV1Decoder.LogEntry memory logEntry
    ) internal override {
        ITabBook.VerifiedSettlement memory settlement;
        settlement.replayKey = key;
        settlement.chainKey = chainKey;
        settlement.blockHeight = blockHeight;
        settlement.txIndex = txIndex;
        settlement.logIndex = logIndex;

        if (logEntry.topics[0] == ERC20_TRANSFER_SIG) {
            _handleErc20Transfer(settlement, logEntry);
        } else {
            _handleTabSettled(settlement, logEntry);
        }
    }

    /// @inheritdoc TabAscBase
    /// @dev The second, independent reading of the receipt that the base checks the ordinal sweep
    /// against: one signature-filter pass per registered Settlement signature, each counted through
    /// the same recognition rule the sweep used. Two readings of one receipt must agree on how many
    /// Settlement logs it holds. (R3.5)
    function _filteredRecognisedCount(uint64 chainKey, EvmV1Decoder.ReceiptFields memory receipt)
        internal
        view
        override
        returns (uint256 count)
    {
        EvmV1Decoder.LogEntry[] memory transfers =
            EvmV1Decoder.getLogsByEventSignature(receipt, ERC20_TRANSFER_SIG);
        EvmV1Decoder.LogEntry[] memory settled =
            EvmV1Decoder.getLogsByEventSignature(receipt, TAB_SETTLED_SIG);

        for (uint256 i = 0; i < settled.length; ++i) {
            if (_isRecognised(chainKey, settled[i])) ++count;
        }

        // A `Transfer` that a `TabSettled` in the same receipt already accounts for is not counted
        // here either, because the sweep does not ingest it. The two readings reach that number by
        // different traversals, which is what makes their agreement worth checking: the sweep walks
        // receipt ordinals, and this pass walks the signature-filtered arrays.
        for (uint256 i = 0; i < transfers.length; ++i) {
            if (!_isRecognised(chainKey, transfers[i])) continue;
            if (_supersededAmongFiltered(chainKey, transfers, settled, i)) continue;
            ++count;
        }
    }

    /// @inheritdoc TabAscBase
    /// @dev **Task 10.12's fix, and the reason it lives in the sweep rather than in recognition.**
    /// `TabSettlement.settle` pulls the Asset with `safeTransferFrom`, which emits an ERC-20 `Transfer`
    /// to the Collection Address, and then emits its own `TabSettled` naming the same payer, the same
    /// recipient, and the same amount. On chainKey 1 both emitters are authorised, because the
    /// settlement contract must be for Requirement 1 and the Asset must be for the Bond funding path
    /// task 10.11 added, so both logs are recognised and one payment was credited twice. Measured on
    /// the live network before this shipped: a keyless preflight of a real `settle` transaction
    /// returned `ingestedLogs = 2` for a single payment.
    ///
    /// **`TabSettled` is the statement of intent and the `Transfer` is its mechanical side effect**, so
    /// the `Transfer` is the one suppressed. It is matched on the `(payer, recipient, amount)` triple,
    /// which both events carry in the same positions: `topics[1]`, `topics[2]`, and the sole data word.
    ///
    /// **Matching is by count, not by existence, so a genuine payment can never be suppressed.** A
    /// `Transfer` is skipped only while the number of matching `Transfer` logs at or before it does not
    /// exceed the number of matching `TabSettled` logs in the receipt. One `settle` yields one of each
    /// and the `Transfer` is skipped. A `settleBatch` of two identical instructions yields two of each
    /// and both `Transfer` logs are skipped, leaving two Settlements for two payments. And a `settle`
    /// accompanied in the same transaction by a genuine direct `Transfer` of the identical amount to
    /// the identical recipient yields two `Transfer` logs against one `TabSettled`, so exactly one is
    /// skipped and both payments are still credited. Existence matching would have lost the second.
    function _isSupersededInReceipt(
        uint64 chainKey,
        EvmV1Decoder.ReceiptFields memory receipt,
        uint256 ordinal
    ) internal view override returns (bool superseded) {
        EvmV1Decoder.LogEntry memory candidate = receipt.receiptLogs[ordinal];
        if (candidate.topics[0] != ERC20_TRANSFER_SIG) return false;
        if (candidate.topics.length != 3 || candidate.data.length != 32) return false;

        uint256 statements = _matchingSettledCount(
            chainKey, EvmV1Decoder.getLogsByEventSignature(receipt, TAB_SETTLED_SIG), candidate
        );
        if (statements == 0) return false;

        uint256 earlier = 0;
        for (uint256 i = 0; i < ordinal; ++i) {
            EvmV1Decoder.LogEntry memory prior = receipt.receiptLogs[i];
            if (!_isTransferNaming(prior, candidate)) continue;
            if (_isRecognised(chainKey, prior)) ++earlier;
        }
        superseded = earlier < statements;
    }

    /// @notice The superseded test again, over the signature-filtered arrays.
    /// @dev Deliberately a second traversal rather than a shared one. Requirement 3.5 asks the sweep
    /// and the filter to be independent readings of one receipt, so the adjustment each applies has to
    /// be reached independently too; a single shared walk would make them agree by construction and
    /// check nothing.
    /// @param chainKey Attested-chain identifier of the verified transaction.
    /// @param transfers Signature-filtered `Transfer` logs, in receipt order.
    /// @param settled Signature-filtered `TabSettled` logs.
    /// @param index Position within `transfers` of the log being considered.
    /// @return superseded True when that `Transfer` is a duplicate representation.
    function _supersededAmongFiltered(
        uint64 chainKey,
        EvmV1Decoder.LogEntry[] memory transfers,
        EvmV1Decoder.LogEntry[] memory settled,
        uint256 index
    ) private view returns (bool superseded) {
        EvmV1Decoder.LogEntry memory candidate = transfers[index];
        if (candidate.topics.length != 3 || candidate.data.length != 32) return false;

        uint256 statements = _matchingSettledCount(chainKey, settled, candidate);
        if (statements == 0) return false;

        uint256 earlier = 0;
        for (uint256 i = 0; i < index; ++i) {
            if (!_isTransferNaming(transfers[i], candidate)) continue;
            if (_isRecognised(chainKey, transfers[i])) ++earlier;
        }
        superseded = earlier < statements;
    }

    /// @notice How many recognised `TabSettled` logs name the same payment as a candidate `Transfer`.
    /// @param chainKey Attested-chain identifier of the verified transaction.
    /// @param settled Signature-filtered `TabSettled` logs.
    /// @param candidate The `Transfer` under consideration.
    /// @return statements Count of recognised settlement events naming that payment.
    function _matchingSettledCount(
        uint64 chainKey,
        EvmV1Decoder.LogEntry[] memory settled,
        EvmV1Decoder.LogEntry memory candidate
    ) private view returns (uint256 statements) {
        for (uint256 i = 0; i < settled.length; ++i) {
            EvmV1Decoder.LogEntry memory entry = settled[i];
            if (entry.topics.length != 4 || entry.data.length != 32) continue;
            if (entry.topics[1] != candidate.topics[1]) continue;
            if (entry.topics[2] != candidate.topics[2]) continue;
            if (keccak256(entry.data) != keccak256(candidate.data)) continue;
            if (_isRecognised(chainKey, entry)) ++statements;
        }
    }

    /// @notice Whether a log is a `Transfer` naming the same payment as a candidate.
    /// @dev Arity and signature are checked before the triple, so a malformed log can never match.
    /// @param entry The log to test.
    /// @param candidate The `Transfer` under consideration.
    /// @return naming True when `entry` is a well-formed `Transfer` carrying the same triple.
    function _isTransferNaming(EvmV1Decoder.LogEntry memory entry, EvmV1Decoder.LogEntry memory candidate)
        private
        pure
        returns (bool naming)
    {
        if (entry.topics.length != 3 || entry.data.length != 32) return false;
        if (entry.topics[0] != ERC20_TRANSFER_SIG) return false;
        if (entry.topics[1] != candidate.topics[1]) return false;
        if (entry.topics[2] != candidate.topics[2]) return false;
        naming = keccak256(entry.data) == keccak256(candidate.data);
    }

    // ------------------------------------------------------------------ handlers

    /// @notice Credit a plain ERC-20 `Transfer` to the Service that owns the recipient. (R2.1, R2.3)
    /// @dev Layout: `topics[1]` is the sender and therefore the payer, `topics[2]` is the recipient,
    /// and the data is the amount. The emitting Asset contract is part of the authenticated identity
    /// of the Settlement, which is why it is compared against the Asset the recipient is registered
    /// to collect rather than taken on trust. (R2.5, R18.4)
    /// @param settlement The entry, with its Source Chain coordinates already filled in.
    /// @param logEntry The verified log.
    function _handleErc20Transfer(
        ITabBook.VerifiedSettlement memory settlement,
        EvmV1Decoder.LogEntry memory logEntry
    ) private {
        if (logEntry.topics.length != 3 || logEntry.data.length != 32) {
            revert MalformedSettlementLog(ERC20_TRANSFER_SIG, logEntry.topics.length, logEntry.data.length);
        }

        address asset = logEntry.address_;
        // casting to 'address' is the standard topic decoding: an indexed address occupies the low 20
        // bytes of its topic word.
        // forge-lint: disable-next-line(unsafe-typecast)
        address recipient = address(uint160(uint256(logEntry.topics[2])));

        IServiceRegistry.CollectionRecord memory collection =
            SERVICES.collectionFor(settlement.chainKey, recipient);
        if (!collection.exists) {
            revert UnknownCollectionAddress(settlement.chainKey, recipient, asset);
        }
        if (collection.asset != asset) revert AssetMismatch(asset, collection.asset);

        settlement.asset = asset;
        settlement.serviceId = collection.serviceId;
        // forge-lint: disable-next-line(unsafe-typecast)
        settlement.payerAddress = address(uint160(uint256(logEntry.topics[1])));
        settlement.amount = abi.decode(logEntry.data, (uint256));
        settlement.sourceTabId = bytes32(0);

        _credit(settlement, collection.kind);
    }

    /// @notice Credit a `TabSettled` log from the Source Chain settlement contract on chainKey 1.
    /// @dev Layout: `topics[1]` is the Agent and therefore the payer, `topics[2]` is the Service
    /// Collection Address, `topics[3]` is the Agent's own `tabId`, and the data is the amount.
    ///
    /// The Asset comes from the Collection Address rather than from the log, because a Collection
    /// Address collects exactly one Asset per chain across the whole registry, so the recipient
    /// determines the Asset uniquely.
    ///
    /// `tabId` is recorded and never gated on. The Source Chain funds have already moved by the time
    /// a proof exists, so an Agent that mislabels its own `tabId` must still be credited for the
    /// Service, Asset, and amount the proof establishes.
    /// @param settlement The entry, with its Source Chain coordinates already filled in.
    /// @param logEntry The verified log.
    function _handleTabSettled(
        ITabBook.VerifiedSettlement memory settlement,
        EvmV1Decoder.LogEntry memory logEntry
    ) private {
        if (logEntry.topics.length != 4 || logEntry.data.length != 32) {
            revert MalformedSettlementLog(TAB_SETTLED_SIG, logEntry.topics.length, logEntry.data.length);
        }

        // forge-lint: disable-next-line(unsafe-typecast)
        address recipient = address(uint160(uint256(logEntry.topics[2])));

        IServiceRegistry.CollectionRecord memory collection =
            SERVICES.collectionFor(settlement.chainKey, recipient);
        if (!collection.exists) {
            revert UnknownCollectionAddress(settlement.chainKey, recipient, collection.asset);
        }

        settlement.asset = collection.asset;
        settlement.serviceId = collection.serviceId;
        // forge-lint: disable-next-line(unsafe-typecast)
        settlement.payerAddress = address(uint160(uint256(logEntry.topics[1])));
        settlement.amount = abi.decode(logEntry.data, (uint256));
        settlement.sourceTabId = logEntry.topics[3];

        _credit(settlement, collection.kind);
    }

    // ------------------------------------------------------------------ crediting

    /// @notice Resolve the payer to an Agent and apply the Verified Settlement.
    /// @dev **The single most important line in this contract is the one that is not here.** The
    /// payer is `settlement.payerAddress`, which both handlers took from `topics[1]`, and
    /// `EvmV1Decoder.decodeCommonTxFields(...).from` is never consulted on this path or on any other.
    /// Task 1.3 measured a live Mainnet transaction in which the two were different addresses and
    /// opposite parties, so resolving from `from` would credit the recipient of the money rather than
    /// the party that sent it. The divergence is routine, not exotic: a relayer paying gas, a smart
    /// account, an account-abstraction bundler, or any contract settling on an Agent's behalf all
    /// produce it, and in every one of those cases `topics[1]` is the account whose balance and
    /// allowance authorised the transfer. (R8.1, R8.2, R8.3)
    ///
    /// An unbound payer is a return value rather than a revert one level down, because the registry
    /// cannot tell an address that is not yet bound from one that never will be. Naming the failure
    /// is this contract's job. (R8.4)
    ///
    /// `chainKey` is threaded into the binding call and onto the entry, so every downstream record of
    /// a tab reduction, of credit history, and of Bond coverage carries the chain the proof
    /// established. (R5.4, R5.5, R8.5)
    ///
    /// **The recipient's kind decides which of two meanings a Settlement has, and it is the only thing
    /// that decides.** A protocol Bond deposit and an ordinary tab payment are the same shape of
    /// `Transfer` to a registered address, so without the kind on the collection record a deposit would
    /// resolve to whichever Service claimed that address and land on that Service's own tab as prepaid
    /// credit. The kind is read off the registry record the proof's own recipient resolved to and never
    /// off anything the submitter supplied, so Correction 3 holds on the branch as it does on the
    /// dispatch above it. (R14.1, R18.6)
    ///
    /// **Payer resolution runs before the branch, not inside one arm of it.** A Service funds its Bond
    /// from an address it has bound, exactly as an Agent settles from one, so an unbound payer is
    /// rejected on both paths. Skipping it on the Bond path would let anybody's transfer to a published
    /// Bond Collection Address credit that Service's stake, which is a fine thing to be true of a
    /// donation and a bad thing to be true of collateral whose provenance the slashing path assumes.
    /// @param settlement The entry, complete but for the resolved Agent.
    /// @param kind What the resolved recipient collects for: an Open Tab, or the Service's Bond.
    function _credit(ITabBook.VerifiedSettlement memory settlement, IServiceRegistry.CollectionKind kind)
        private
    {
        address agent = AGENTS.resolveOrBind(
            settlement.chainKey, settlement.payerAddress, settlement.amount, settlement.replayKey
        );
        if (agent == address(0)) revert UnboundPayer(settlement.chainKey, settlement.payerAddress);
        settlement.agent = agent;

        if (kind == IServiceRegistry.CollectionKind.Bond) {
            _creditBond(settlement);
            return;
        }

        TAB_BOOK.applyVerifiedSettlement(settlement);

        emit SettlementRecorded(
            settlement.replayKey,
            settlement.chainKey,
            settlement.blockHeight,
            settlement.txIndex,
            settlement.logIndex,
            agent,
            settlement.serviceId,
            settlement.asset,
            settlement.amount,
            settlement.payerAddress,
            settlement.sourceTabId
        );
    }

    /// @notice Credit a proven deposit as Service stake rather than as a tab reduction. (R14.1, R18.6)
    /// @dev This is the call that was missing. `Bond.fundFromVerifiedSettlement` is gated on this
    /// contract's address and has been since it was written, so stake could only ever be created from a
    /// proof — but nothing called it, so stake could not be created at all, and a bond cap of zero makes
    /// every Credit Limit zero and every delivery unmeterable. Nothing about `Bond` changes to fix that:
    /// its entrypoint, its gate, and its replay-key argument were already right.
    ///
    /// The party key is the Service's `bondAccount` read from the registry and embedded by `Bond`, which
    /// is the same derivation `TabBook` uses for reserving, releasing, and slashing. Deriving it here
    /// instead would put the embedding in two contracts and let the funded ledger and the reserved
    /// ledger drift apart.
    ///
    /// No conversion happens on this path and none could: the Asset the deposit was denominated in is
    /// the Asset the stake is credited in, taken from the same authenticated record. (R18.6)
    /// @param settlement The entry, complete, with its Agent already resolved.
    function _creditBond(ITabBook.VerifiedSettlement memory settlement) private {
        if (settlement.amount > type(uint128).max) revert BondDepositOutOfRange(settlement.amount);

        bytes32 party = BOND.partyOf(SERVICES.serviceOf(settlement.serviceId).bondAccount);

        // casting to 'uint128' is safe because the bound above rejected every wider amount.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 amount = uint128(settlement.amount);
        BOND.fundFromVerifiedSettlement(party, settlement.asset, amount, settlement.replayKey);

        emit BondDepositRecorded(
            settlement.replayKey,
            settlement.chainKey,
            settlement.blockHeight,
            settlement.txIndex,
            settlement.logIndex,
            settlement.agent,
            settlement.serviceId,
            settlement.asset,
            settlement.amount,
            settlement.payerAddress,
            party
        );
    }
}
