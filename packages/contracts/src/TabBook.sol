// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IBond} from "./Bond.sol";
import {IServiceRegistry} from "./ServiceRegistry.sol";
import {LimitLib} from "./LimitLib.sol";

/// @title ITabBook
/// @notice Read and write surface of the Open Tab: metering, spending authorisations, Verified
/// Settlement application, the Provisional Clearing lifecycle, and the delinquency crank.
/// @dev Declared beside the implementation rather than under `src/interfaces/`, matching `IBond` and
/// `IServiceRegistry`. That directory holds the two precompile ABIs confirmed against the live chain
/// and is frozen; consumers depend on this type by ABI rather than by import path.
///
/// Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 13.2, 14.4, 14.5, 14.6, 14.7, 14.8, 14.11,
/// 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.8, 16.4, 18.3, 18.4
interface ITabBook {
    // ------------------------------------------------------------------ types

    /// @notice One Open Tab, per Agent, Service, and Asset triple. (R18.3)
    /// @dev Field order is the design's declaration order and is wire order for every consumer that
    /// decodes this struct.
    struct Tab {
        /// @dev Open Tab in Asset base units.
        uint128 open;
        /// @dev Non-refundable prepaid credit from excess settlement. (D11, R12.5)
        uint128 prepaid;
        /// @dev Creditcoin timestamp of the oldest unsettled delivery. Drives the Settlement Window.
        uint64 oldestUnsettledAt;
        /// @dev Creditcoin timestamp of the most recent delivery.
        uint64 lastDeliveryAt;
        /// @dev Monotonic delivery counter.
        uint32 deliveryCount;
        /// @dev Set by `markDelinquent`, cleared when the tab settles to zero. (R14.8)
        bool delinquent;
    }

    /// @notice The triple a `tabId` was derived from.
    /// @dev `tabId` is a one-way hash, so the triple has to be stored to be recoverable. Both cranks
    /// need it: `markDelinquent` takes a `tabId` and must name the Agent, the Service, and the Asset
    /// in its event and must zero the Credit Limit for that Agent and Asset.
    struct TabRef {
        /// @dev Agent the tab belongs to.
        address agent;
        /// @dev Service that meters into it.
        bytes32 serviceId;
        /// @dev Asset it is denominated in.
        address asset;
        /// @dev True once the tab has been touched by a delivery or a Settlement.
        bool exists;
    }

    /// @notice One Verified Settlement, as handed over by the `SettlementVerifier`.
    /// @dev **There is no `sourceTxHash` field here, and its absence is deliberate.** The replay key
    /// *is* the clearing identity, so nothing needs a second identifier; and the `SettlementVerifier`
    /// has no honest way to produce a Source Chain transaction hash in the first place. The bytes it
    /// holds are the Proof Builder's chunked composite, which `EvmV1Decoder.decodeReceiptFields` pulls
    /// the receipt status, gas used, logs, and logs bloom out of, so hashing them yields a value the
    /// Watcher could never match. The transaction hash lives on the {Clearing} record instead, where
    /// the Watcher supplies it at observation time. See design section 5.5.
    struct VerifiedSettlement {
        /// @dev Packed `(chainKey, blockHeight, txIndex, logIndex)`, and the clearing identity. (R4.1)
        bytes32 replayKey;
        /// @dev Originating Source Chain, stored on every entry. (R5.5)
        uint64 chainKey;
        /// @dev Source Chain block height, from the proof.
        uint64 blockHeight;
        /// @dev Transaction index within the block, from the proof.
        uint64 txIndex;
        /// @dev Log ordinal within the transaction, from the proof.
        uint64 logIndex;
        /// @dev Resolved Agent identity. (R8.5)
        address agent;
        /// @dev Ethereum address taken from `topics[1]`. (R8.5)
        address payerAddress;
        /// @dev Service resolved from the Collection Address.
        bytes32 serviceId;
        /// @dev Emitting Asset contract, part of the authenticated identity. (R2.5)
        address asset;
        /// @dev Settled amount from the log data, in Asset base units.
        uint256 amount;
        /// @dev `TabSettled.tabId` when present. Recorded for audit only, never gates crediting.
        bytes32 sourceTabId;
    }

    /// @notice Agent-set ceiling on what one Service may charge one tab. (D10)
    struct Authorisation {
        /// @dev Ceiling on total charges under this authorisation.
        uint128 maxCumulative;
        /// @dev Cumulative charged so far.
        uint128 spent;
        /// @dev Creditcoin timestamp after which no delivery may be recorded.
        uint64 expiry;
        /// @dev Distinguishes "no authorisation" from "zero ceiling".
        bool exists;
    }

    /// @notice Where a Provisional Clearing sits in its lifecycle.
    /// @dev Values match the design's numbering exactly: `None = 0` so an unwritten record is not a
    /// live clearing, and the four terminal states are distinguishable from one another so a reviewer
    /// can tell a confirmed clearing from a reversed one on chain.
    enum ClearingState {
        None,
        Applied,
        Confirmed,
        Reversed,
        Declined,
        Superseded
    }

    /// @notice One Provisional Clearing, or one confirmation that never had a provisional stage.
    struct Clearing {
        /// @dev Agent whose tab was cleared.
        address agent;
        /// @dev Service whose tab was cleared.
        bytes32 serviceId;
        /// @dev Asset of the clearing. Coverage and slashing stay inside it. (R18.5)
        address asset;
        /// @dev Amount observed on the Source Chain, and the amount pledged in `Bond`.
        uint128 amount;
        /// @dev Amount the Open Tab was actually reduced by, which is `min(open, amount)`.
        uint128 reduced;
        /// @dev Source Chain of the observed Settlement.
        uint64 chainKey;
        /// @dev Creditcoin timestamp the clearing was applied at.
        uint64 appliedAt;
        /// @dev Creditcoin timestamp from which the reversal crank may fire. (D6)
        uint64 deadline;
        /// @dev Source Chain transaction hash, surfaced on every clearing event. (R15.8)
        bytes32 sourceTxHash;
        /// @dev Block digest observed for the Settlement's block at apply time. (D8)
        bytes32 attestedDigestAtApply;
        /// @dev Lifecycle position.
        ClearingState state;
    }

    /// @notice One unfinalized Settlement the Watcher observed on a Source Chain. (R15.1)
    /// @dev A struct rather than a parameter list because the list reaches eight, which leaves the
    /// legacy code generator almost no stack for locals. One calldata pointer costs one slot.
    ///
    /// The identity is `replayKey` and nothing else. Both sides can compute it independently: the
    /// Watcher from the RPC receipt at observation, through `TabAscBase.replayKey`, which is
    /// `public pure`; and the `SettlementVerifier` from the proven height and transaction index. So no
    /// part of the identity is caller-invented, and one Settlement carries one identifier across the
    /// whole system.
    struct ProvisionalObservation {
        /// @dev Packed `(chainKey, blockHeight, txIndex, logIndex)`, and the clearing identity. (R4.1)
        bytes32 replayKey;
        /// @dev Agent whose headroom is to be restored.
        address agent;
        /// @dev Service whose Bond covers the observation.
        bytes32 serviceId;
        /// @dev Asset of the observed Settlement.
        address asset;
        /// @dev Observed Settlement amount, and the amount to pledge in `Bond`.
        uint128 amount;
        /// @dev Source Chain of the observation. Must agree with the one packed into `replayKey`.
        uint64 chainKey;
        /// @dev Source Chain transaction hash. Audit data for R15.8, and it gates nothing.
        bytes32 sourceTxHash;
        /// @dev Block digest observed for the Settlement's block at apply time. (D8)
        bytes32 attestedDigestAtApply;
    }

    /// @notice History and Bond figures a caller supplies so `LimitLib` can stay pure. (D20, R13.1)
    /// @dev Neither array is trusted. The history is folded into the same rolling hash the Settlement
    /// path writes and compared against the stored commitment, and every Bond amount is replaced with
    /// the figure read from `Bond` rather than used as supplied. See `TabBook._resolveBonds`.
    struct LimitWitness {
        /// @dev Full ordered Verified Settlement history for one Agent and Asset.
        LimitLib.SettlementRecord[] history;
        /// @dev One entry per counterparty Service appearing in that history.
        LimitLib.BondEntry[] bonds;
    }

    // ------------------------------------------------------------------ events

    /// @notice A Service metered usage into an Open Tab. (R12.1, R12.2)
    /// @param agent Agent charged.
    /// @param serviceId Service that metered.
    /// @param asset Asset the charge is denominated in.
    /// @param tool Named priced unit from the applied price list.
    /// @param units Count of priced units.
    /// @param amount Charge in Asset base units.
    /// @param timestamp Creditcoin block timestamp of the delivery.
    event DeliveryRecorded(
        address indexed agent,
        bytes32 indexed serviceId,
        address indexed asset,
        bytes32 tool,
        uint32 units,
        uint256 amount,
        uint64 timestamp
    );

    /// @notice A Verified Settlement reduced an Open Tab, or landed as prepaid credit. (R12.4, R12.5)
    /// @param replayKey Replay key of the settling log.
    /// @param agent Agent credited.
    /// @param serviceId Service paid.
    /// @param asset Asset settled in.
    /// @param applied Amount the Open Tab was reduced by.
    /// @param toPrepaid Amount recorded as prepaid credit.
    /// @param openAfter Open Tab after application.
    event SettlementApplied(
        bytes32 indexed replayKey,
        address indexed agent,
        bytes32 indexed serviceId,
        address asset,
        uint256 applied,
        uint256 toPrepaid,
        uint128 openAfter
    );

    /// @notice The rolling history commitment advanced by one Verified Settlement. (D20)
    /// @dev Carries the committed record in full, so a third party can rebuild the exact witness the
    /// commitment was computed over from logs alone, with no indexer and no privileged read. Without
    /// it the four snapshot fields this contract authors — `firstDeliveryAt`, `curated`, `bonded`, and
    /// `settledAt` — would be unrecoverable off chain, and no witness could be assembled at all.
    /// @param agent Agent the history belongs to.
    /// @param asset Asset the history is scoped to.
    /// @param root Commitment after the append.
    /// @param count Number of records the commitment now covers.
    /// @param record The appended record, exactly as folded in.
    event HistoryExtended(
        address indexed agent,
        address indexed asset,
        bytes32 root,
        uint32 count,
        LimitLib.SettlementRecord record
    );

    /// @notice A Provisional Clearing was applied against pledged Bond. (R15.1, R15.8)
    /// @param clearingId Replay key of the observed Settlement, which is the clearing's identity.
    /// @param agent Agent whose headroom was restored.
    /// @param serviceId Service whose Bond covers it.
    /// @param asset Asset of the clearing.
    /// @param amount Observed Settlement amount.
    /// @param sourceTxHash Source Chain transaction hash.
    /// @param deadline Creditcoin timestamp from which the reversal crank may fire.
    event ProvisionalClearingApplied(
        bytes32 indexed clearingId,
        address indexed agent,
        bytes32 indexed serviceId,
        address asset,
        uint128 amount,
        bytes32 sourceTxHash,
        uint64 deadline
    );

    /// @notice A Provisional Clearing became a Confirmed Clearing. (R15.4, R15.8)
    /// @param clearingId Replay key of the clearing, which the confirming proof carries too.
    /// @param agent Agent whose tab it cleared.
    /// @param serviceId Service whose Bond was returned.
    /// @param asset Asset of the clearing.
    /// @param amount Settled amount.
    /// @param sourceTxHash Source Chain transaction hash.
    event ProvisionalClearingConfirmed(
        bytes32 indexed clearingId,
        address indexed agent,
        bytes32 indexed serviceId,
        address asset,
        uint128 amount,
        bytes32 sourceTxHash
    );

    /// @notice A Provisional Clearing reached its deadline unconfirmed and was reversed. (R15.5, R15.8)
    /// @param clearingId Replay key of the clearing.
    /// @param agent Agent whose Open Tab was restored.
    /// @param serviceId Service whose Bond was slashed.
    /// @param asset Asset of the clearing.
    /// @param amount Provisionally cleared amount.
    /// @param sourceTxHash Source Chain transaction hash.
    event ProvisionalClearingReversed(
        bytes32 indexed clearingId,
        address indexed agent,
        bytes32 indexed serviceId,
        address asset,
        uint128 amount,
        bytes32 sourceTxHash
    );

    /// @notice A Provisional Clearing was declined for want of free Bond. (R15.3)
    /// @param agent Agent whose headroom was not restored.
    /// @param serviceId Service whose Bond fell short.
    /// @param asset Asset of the observation.
    /// @param amount Observed Settlement amount.
    /// @param sourceTxHash Source Chain transaction hash.
    /// @param freeBond Free Bond in that Asset at the moment of the decline.
    event ProvisionalClearingDeclined(
        address indexed agent,
        bytes32 indexed serviceId,
        address asset,
        uint128 amount,
        bytes32 sourceTxHash,
        uint128 freeBond
    );

    /// @notice A Confirmed Clearing was superseded by a Source Chain reorganisation. (R14.7)
    /// @param replayKey Replay key of the superseded Verified Settlement.
    /// @param agent Agent whose Open Tab was restored.
    /// @param serviceId Service whose Bond was slashed.
    /// @param asset Asset of the superseded Settlement.
    /// @param amount Amount restored to the Open Tab.
    /// @param observedDigest Digest observed for the block at apply time.
    /// @param attestedDigest Digest the attested chain now carries.
    event SettlementSuperseded(
        bytes32 indexed replayKey,
        address indexed agent,
        bytes32 indexed serviceId,
        address asset,
        uint128 amount,
        bytes32 observedDigest,
        bytes32 attestedDigest
    );

    /// @notice A Metered Delivery was paid for out of prepaid credit. (D11, R12.5)
    /// @dev Emitted alongside `DeliveryRecorded` rather than folded into it, so an existing decoder
    /// keeps working while the draw stays visible. Absent when a delivery drew no prepaid credit.
    /// @param agent Agent charged.
    /// @param serviceId Service that metered.
    /// @param asset Asset of the charge.
    /// @param consumed Base units taken from prepaid credit.
    /// @param prepaidAfter Prepaid credit left on the tab afterwards.
    /// @param openAdded Base units that still reached the Open Tab.
    event PrepaidConsumed(
        address indexed agent,
        bytes32 indexed serviceId,
        address indexed asset,
        uint128 consumed,
        uint128 prepaidAfter,
        uint128 openAdded
    );

    /// @notice An Open Tab passed its Settlement Window unsettled. (R14.8)
    /// @param tabId Identifier of the tab.
    /// @param agent Agent that did not settle.
    /// @param serviceId Service that metered.
    /// @param asset Asset of the tab.
    /// @param unsettled Open Tab at the moment of the crank.
    /// @param windowEnd Creditcoin timestamp the window closed at.
    event TabDelinquent(
        bytes32 indexed tabId,
        address indexed agent,
        bytes32 indexed serviceId,
        address asset,
        uint128 unsettled,
        uint64 windowEnd
    );

    /// @notice A delinquent tab settled to zero, so the Agent's credit is no longer suppressed.
    /// @dev The counterpart of {TabDelinquent}. Without it the Dashboard could show a delinquency
    /// beginning and never show it ending, and the suppression looks permanent when it is not.
    /// @param tabId Identifier of the tab.
    /// @param agent Agent whose credit is restored.
    /// @param asset Asset the suppression applied to.
    event TabDelinquencyCleared(bytes32 indexed tabId, address indexed agent, address indexed asset);

    /// @notice An Agent set or replaced a spending authorisation. (D10)
    /// @param agent Agent that set it.
    /// @param serviceId Service it applies to.
    /// @param asset Asset it applies to.
    /// @param maxCumulative Ceiling on total charges.
    /// @param expiry Creditcoin timestamp after which no delivery may be recorded.
    event AuthorisationSet(
        address indexed agent,
        bytes32 indexed serviceId,
        address indexed asset,
        uint128 maxCumulative,
        uint64 expiry
    );

    /// @notice An Agent's Credit Limit in one Asset was set to zero by delinquency. (R14.8)
    /// @param agent Agent whose credit was zeroed.
    /// @param asset Asset the zeroing applies to.
    /// @param reasonTabId Tab whose delinquency caused it.
    event CreditLimitZeroed(address indexed agent, address indexed asset, bytes32 reasonTabId);

    // ------------------------------------------------------------------ errors

    /// @notice The charge would raise the Open Tab for this Asset above the Credit Limit. (R12.3)
    /// @param agent Agent charged.
    /// @param asset Asset of the charge.
    /// @param requested Charge requested.
    /// @param headroom Headroom available.
    error LimitExceeded(address agent, address asset, uint256 requested, uint256 headroom);

    /// @notice A Settlement in one Asset was presented against a clearing in another. (R18.4)
    /// @param expected Asset the clearing is denominated in.
    /// @param provided Asset the Settlement is denominated in.
    error AssetMismatch(address expected, address provided);

    /// @notice No spending authorisation exists for this triple. (D10)
    /// @param agent Agent that would have been charged.
    /// @param serviceId Service that tried to charge.
    /// @param asset Asset of the charge.
    error AuthorisationMissing(address agent, bytes32 serviceId, address asset);

    /// @notice The spending authorisation has expired, or would expire on creation.
    /// @param expiry Creditcoin timestamp the authorisation lapses at.
    /// @param nowTs Current Creditcoin timestamp.
    error AuthorisationExpired(uint64 expiry, uint64 nowTs);

    /// @notice The charge would take cumulative spend past the authorised ceiling.
    /// @param maxCumulative Ceiling the Agent set.
    /// @param spent Cumulative charged before this call.
    /// @param requested Charge requested.
    error AuthorisationExceeded(uint128 maxCumulative, uint128 spent, uint256 requested);

    /// @notice The tab is delinquent, so no further delivery may be metered into it.
    /// @param tabId Identifier of the tab.
    error TabIsDelinquent(bytes32 tabId);

    /// @notice The supplied history does not fold to the stored commitment. (D20)
    /// @param expected Commitment stored on chain.
    /// @param provided Commitment recomputed from the witness.
    error HistoryCommitmentMismatch(bytes32 expected, bytes32 provided);

    /// @notice The supplied history carries a different number of records than the commitment covers.
    /// @dev Distinct from {HistoryCommitmentMismatch} so a caller that truncated its history is told
    /// which of the two things went wrong. The root check alone would catch it, but it would report a
    /// digest difference for what is a length error.
    /// @param expected Number of records the commitment covers.
    /// @param provided Number of records supplied.
    error HistoryLengthMismatch(uint32 expected, uint256 provided);

    /// @notice No clearing exists under this identifier.
    /// @param clearingId The identifier presented.
    error UnknownClearing(bytes32 clearingId);

    /// @notice The clearing is not in the state this transition requires.
    /// @param clearingId The identifier presented.
    /// @param state The state it is actually in.
    error ClearingNotInState(bytes32 clearingId, ClearingState state);

    /// @notice A clearing already exists under this identifier.
    /// @dev The identifier is the replay key of the Settlement log, so a second application under the
    /// same identifier is the same log observed twice. Every outcome of an application is terminal for
    /// that observation, including a decline. A replay key whose Verified Settlement already landed is
    /// caught here too, since the Settlement path writes its own record under the same word. (R15.3)
    /// @param clearingId The identifier presented.
    /// @param state The state the existing record is in.
    error ClearingAlreadyExists(bytes32 clearingId, ClearingState state);

    /// @notice The clearing has not reached its deadline yet.
    /// @param clearingId The identifier presented.
    /// @param deadline Creditcoin timestamp the crank becomes callable at.
    error ClearingNotExpired(bytes32 clearingId, uint64 deadline);

    /// @notice A caller other than the wired `SettlementVerifier` attempted a settlement call.
    /// @param caller The rejected caller.
    error NotSettlementVerifier(address caller);

    /// @notice A caller other than the wired Watcher attempted a clearing call.
    /// @param caller The rejected caller.
    error NotWatcher(address caller);

    /// @notice A caller other than the Service operator attempted to meter.
    /// @param serviceId Service whose operator was required.
    /// @param caller The rejected caller.
    error NotServiceOperator(bytes32 serviceId, address caller);

    /// @notice A caller other than the wiring authority attempted to wire a collaborator.
    /// @param caller The rejected caller.
    error NotWiringAuthority(address caller);

    /// @notice A wiring target is already set, and wiring is one-shot.
    /// @param current The address already wired.
    error AlreadyWired(address current);

    /// @notice A wiring or construction argument named the zero address.
    error ZeroAddressField();

    /// @notice The applied price list no longer agrees with the caller's quote. (D10)
    /// @param serviceId Service that quoted.
    /// @param asset Asset the quote was denominated in.
    /// @param tool Named tool that was quoted.
    /// @param quoted Unit price the caller quoted.
    /// @param applied Unit price the registry currently serves.
    error PriceListChangedMidCall(
        bytes32 serviceId, address asset, bytes32 tool, uint256 quoted, uint256 applied
    );

    /// @notice A delivery of zero priced units was offered.
    /// @dev Rejected so a metered call always moves the tab. A zero-unit delivery would advance
    /// `lastDeliveryAt` and `deliveryCount` while charging nothing, which makes the Settlement Window
    /// restartable at no cost.
    error ZeroUnits();

    /// @notice An amount is too large for the `uint128` figures the tab is kept in.
    /// @param amount The rejected amount.
    error AmountOutOfRange(uint256 amount);

    /// @notice This Verified Settlement has already been applied.
    /// @param replayKey The replay key presented.
    error SettlementAlreadyApplied(bytes32 replayKey);

    /// @notice No Verified Settlement is recorded under this replay key.
    /// @param replayKey The replay key presented.
    error UnknownSettlement(bytes32 replayKey);

    /// @notice The reorg report carries a digest that still matches the attested chain.
    /// @dev The Watcher supplies both the digest it observed at apply time and the digest the attested
    /// chain now carries. Equal digests mean no reorganisation happened, so there is nothing to
    /// supersede and nothing to slash.
    /// @param replayKey Replay key reported.
    /// @param digest The digest both sides agree on.
    error NoReorgDetected(bytes32 replayKey, bytes32 digest);

    /// @notice The reorg report names a digest other than the one recorded at apply time.
    /// @dev Only checked where a digest was recorded, which is the Provisional Clearing path. A
    /// Settlement that was never observed provisionally has no recorded digest to check against.
    /// @param expected Digest recorded when the clearing was applied.
    /// @param provided Digest the report claims was observed.
    error ObservedDigestMismatch(bytes32 expected, bytes32 provided);

    /// @notice No tab exists under this identifier.
    /// @param tabId The identifier presented.
    error UnknownTab(bytes32 tabId);

    /// @notice The tab is already delinquent.
    /// @param tabId The identifier presented.
    error AlreadyDelinquent(bytes32 tabId);

    /// @notice The tab has nothing unsettled, so the Settlement Window has not started.
    /// @param tabId The identifier presented.
    error NothingUnsettled(bytes32 tabId);

    /// @notice The Settlement Window has not closed yet.
    /// @param tabId The identifier presented.
    /// @param windowEnd Creditcoin timestamp the window closes at.
    error SettlementWindowOpen(bytes32 tabId, uint64 windowEnd);

    /// @notice The chainKey carries no Provisional Clearing deadline. (D6)
    /// @param chainKey The rejected identifier.
    error UnsupportedChainKey(uint64 chainKey);

    /// @notice The observation's `chainKey` disagrees with the one packed into its replay key.
    /// @dev The deadline is chosen from the supplied `chainKey` while the identity comes from the
    /// replay key, so the two disagreeing is the one way a Watcher could name a deadline belonging to
    /// one Source Chain while the identity says another. Sepolia's deadline is half Mainnet's, so the
    /// disagreement is worth an entire chain's difference in how long a clearing may sit unconfirmed.
    /// @param packed Source Chain the replay key names, from its top 64 bits.
    /// @param supplied Source Chain the observation named.
    error ReplayKeyChainKeyMismatch(uint64 packed, uint64 supplied);

    /// @notice The witness names the same counterparty Service twice.
    /// @dev A repeated entry would count one posted Bond twice in the cap that bounds the whole
    /// system's credit against real capital. (R13.5, R17.1)
    /// @param serviceId The repeated Service.
    error DuplicateBondEntry(bytes32 serviceId);

    /// @notice The witness names a Bond for a Service that is not a counterparty of this Agent.
    /// @dev The invariant of R17.1 is stated over the Bonds of the counterparty Services in the
    /// Agent's own history. A stranger's Bond would raise the ceiling without putting any capital
    /// behind the credit actually being extended. A Service qualifies by appearing in the committed
    /// history for the Asset, or by holding a spending authorisation the Agent itself granted.
    /// @param serviceId The Service that qualifies neither way.
    /// @param asset Asset the entry was denominated in.
    error IneligibleBondEntry(bytes32 serviceId, address asset);

    /// @notice The witness carries more Bond entries than a computation may evaluate.
    /// @param count Number supplied.
    /// @param maximum Largest number accepted.
    error TooManyBondEntries(uint256 count, uint256 maximum);

    // ------------------------------------------------------------------ metering

    /// @notice Set or replace the spending authorisation for one Service and Asset. (D10)
    /// @param serviceId Service the authorisation applies to.
    /// @param asset Asset the authorisation applies to.
    /// @param maxCumulative Ceiling on total charges under it.
    /// @param expiry Creditcoin timestamp after which no delivery may be recorded.
    function authorise(bytes32 serviceId, address asset, uint128 maxCumulative, uint64 expiry) external;

    /// @notice Meter one delivery into an Open Tab. (R12.1, R12.2, R12.3)
    /// @param agent Agent to charge.
    /// @param serviceId Service metering. Must be the caller's Service.
    /// @param asset Asset to charge in.
    /// @param tool Named priced unit from the applied price list.
    /// @param units Count of priced units.
    /// @param expectedUnitPrice Unit price the caller quoted, in Asset base units.
    /// @param witness History and Bond figures the Credit Limit is computed from.
    /// @return charged Amount added to the Open Tab.
    /// @return openAfter Open Tab after the charge.
    /// @return headroomAfter Headroom remaining for this Agent and Asset.
    function recordDelivery(
        address agent,
        bytes32 serviceId,
        address asset,
        bytes32 tool,
        uint32 units,
        uint256 expectedUnitPrice,
        LimitWitness calldata witness
    ) external returns (uint256 charged, uint128 openAfter, uint256 headroomAfter);

    // ------------------------------------------------------------------ settlement

    /// @notice Apply a Verified Settlement. (R12.4, R12.5, R15.4)
    /// @param s The Verified Settlement entry.
    function applyVerifiedSettlement(VerifiedSettlement calldata s) external;

    // ------------------------------------------------------------------ provisional clearing

    /// @notice Apply a Provisional Clearing against the Service's Bond. (R15.1, R15.2, R15.3)
    /// @dev No identifier is returned, because the caller supplied it as `o.replayKey`.
    /// @param o The observed Settlement, identified by its replay key.
    /// @return applied Whether free Bond covered the amount and the tab was reduced.
    function applyProvisionalClearing(ProvisionalObservation calldata o) external returns (bool applied);

    /// @notice Reverse a Provisional Clearing that passed its deadline unconfirmed. (R15.5)
    /// @dev Permissionless crank, so reversal liveness does not depend on the Watcher that applied it.
    /// @param clearingId Replay key of the expired clearing.
    function reverseExpiredClearing(bytes32 clearingId) external;

    /// @notice Report that a Confirmed Clearing's Source Chain block was reorganised out. (R14.7)
    /// @param replayKey Replay key of the superseded Verified Settlement.
    /// @param observedDigest Digest observed for the block at apply time.
    /// @param attestedDigest Digest the attested chain now carries for that block.
    function reportReorg(bytes32 replayKey, bytes32 observedDigest, bytes32 attestedDigest) external;

    // ------------------------------------------------------------------ delinquency

    /// @notice Mark a tab delinquent once its Settlement Window has closed unsettled. (R14.8, R16.4)
    /// @dev Permissionless crank. Touches no Bond ledger. (R14.11)
    /// @param tabId Identifier of the tab.
    function markDelinquent(bytes32 tabId) external;

    // ------------------------------------------------------------------ reads

    /// @notice Identifier of one Agent, Service, and Asset tab. (R18.3)
    /// @param agent Agent the tab belongs to.
    /// @param serviceId Service that meters into it.
    /// @param asset Asset it is denominated in.
    /// @return tabId The identifier.
    function tabIdOf(address agent, bytes32 serviceId, address asset) external pure returns (bytes32 tabId);

    /// @notice One tab record. (R12.6)
    /// @param tabId Identifier to read.
    /// @return tab The record, all-zero when no tab exists.
    function tabOf(bytes32 tabId) external view returns (Tab memory tab);

    /// @notice The triple a `tabId` was derived from. (R12.6)
    /// @param tabId Identifier to read.
    /// @return ref Agent, Service, and Asset, with `exists` false when no tab exists.
    function tabRefOf(bytes32 tabId) external view returns (TabRef memory ref);

    /// @notice Aggregate Open Tab for one Agent across every Service in one Asset. (R12.6)
    /// @param agent Agent to read.
    /// @param asset Asset to read.
    /// @return open Aggregate Open Tab in Asset base units.
    function assetOpen(address agent, address asset) external view returns (uint256 open);

    /// @notice The rolling Verified Settlement history commitment. (D20, R12.6)
    /// @param agent Agent to read.
    /// @param asset Asset to read.
    /// @return root Commitment over the ordered history.
    /// @return count Number of records it covers.
    function historyCommitment(address agent, address asset)
        external
        view
        returns (bytes32 root, uint32 count);

    /// @notice Creditcoin timestamp of the earliest Metered Delivery for one triple. (R17.3)
    /// @param agent Agent to read.
    /// @param serviceId Service to read.
    /// @param asset Asset to read.
    /// @return timestamp The earliest delivery timestamp, or zero when none was ever recorded.
    function firstDeliveryAtOf(address agent, bytes32 serviceId, address asset)
        external
        view
        returns (uint64 timestamp);

    /// @notice One spending authorisation. (R12.6)
    /// @param agent Agent that set it.
    /// @param serviceId Service it applies to.
    /// @param asset Asset it applies to.
    /// @return authorisation The record, all-zero when none was set.
    function authorisationOf(address agent, bytes32 serviceId, address asset)
        external
        view
        returns (Authorisation memory authorisation);

    /// @notice The Credit Limit an Agent holds in one Asset. (R12.6, R13.2)
    /// @param agent Agent to read.
    /// @param asset Asset to read.
    /// @param witness History and Bond figures, validated against the on-chain commitment.
    /// @return limit The Credit Limit in Asset base units.
    function creditLimit(address agent, address asset, LimitWitness calldata witness)
        external
        view
        returns (uint256 limit);

    /// @notice Headroom remaining for one Agent in one Asset. (R12.6)
    /// @param agent Agent to read.
    /// @param asset Asset to read.
    /// @param witness History and Bond figures, validated against the on-chain commitment.
    /// @return available Credit Limit less the aggregate Open Tab, floored at zero.
    function headroom(address agent, address asset, LimitWitness calldata witness)
        external
        view
        returns (uint256 available);

    /// @notice One clearing record. (R12.6)
    /// @param clearingId Identifier to read.
    /// @return clearing The record, all-zero when no clearing exists.
    function clearingOf(bytes32 clearingId) external view returns (Clearing memory clearing);

    /// @notice How many delinquent tabs are suppressing an Agent's credit in one Asset. (R14.8)
    /// @param agent Agent to read.
    /// @param asset Asset to read.
    /// @return count Number of delinquent tabs. Any non-zero count means a Credit Limit of zero.
    function delinquentTabCount(address agent, address asset) external view returns (uint32 count);
}

/// @title TabBook
/// @notice The Open Tab itself: what a Service metered, what an Agent authorised, what a Verified
/// Settlement paid off, and which Provisional Clearings are live against a Service's Bond.
/// @dev Four shapes in here carry the design's weight and each is justified at its declaration.
///
/// **Per-Asset isolation is structural rather than observed.** Every tab, every aggregate, every
/// prepaid figure, and every Credit Limit is keyed by an Asset, and nothing in this file converts
/// between Assets or sums across them. A record filtered out on Asset cannot reach a figure in
/// another Asset, because the key that would name it does not exist in scope. (R18.1, R18.2, R18.3)
///
/// **The Credit Limit is computed from a calldata witness, and the witness is not trusted.** The
/// history is folded into the same rolling hash the settlement path writes and compared against the
/// stored commitment, so a caller cannot add, drop, reorder, or edit a record. Every Bond figure is
/// replaced with the amount read from `Bond`, and each entry must name a counterparty that appears in
/// the committed history, so the cap that bounds credit against real capital cannot be inflated with
/// a stranger's stake or with a number the caller invented. (D20, R13.1, R13.5, R17.1)
///
/// **A Provisional Clearing reduces the tab once and only once.** The reduction happens when the
/// clearing is applied, on the strength of pledged Bond. Confirmation returns the pledge and moves no
/// tab figure at all; reversal restores exactly the figure the application removed and slashes the
/// pledge to the Agent. So every base unit that ever leaves an Open Tab is accounted for by exactly
/// one of a reduction, a prepaid credit, or a restoration. (R15.2, R15.4, R15.5)
///
/// **`markDelinquent` touches no Bond ledger, and the absence is checkable rather than asserted.**
/// Grep this file for `BOND.`: there are five call sites, in `_openClearing`, `_confirmProvisional`,
/// `reverseExpiredClearing`, `reportReorg`, and the two read helpers. None of them is on the
/// delinquency path, and `markDelinquent` calls nothing but the registry read that gives it the
/// Settlement Window. Agent default suppresses the Agent's own credit and does nothing else, because
/// the Service posted the Bond and extended the credit voluntarily. (R14.8, R14.11)
///
/// Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 13.2, 14.4, 14.5, 14.6, 14.7, 14.8, 14.11,
/// 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.8, 16.4, 18.3, 18.4
contract TabBook is ITabBook {
    // ------------------------------------------------------------------ constants

    /// @notice Attested-chain identifier of Ethereum Sepolia.
    uint64 internal constant CHAIN_KEY_SEPOLIA = 1;

    /// @notice Attested-chain identifier of Ethereum Mainnet.
    uint64 internal constant CHAIN_KEY_MAINNET = 3;

    /// @notice Confirmation deadline for a Mainnet Provisional Clearing. (D6, R15.5)
    /// @dev The attestation wait is roughly 13 to 15 minutes, so this sits well above it plus proof
    /// retrieval, batching, and retry margin.
    uint64 internal constant CLEARING_DEADLINE_MAINNET = 60 minutes;

    /// @notice Confirmation deadline for a Sepolia Provisional Clearing. (D6)
    uint64 internal constant CLEARING_DEADLINE_SEPOLIA = 30 minutes;

    // ------------------------------------------------------------------ immutables

    /// @notice The only address permitted to wire this contract's callers.
    /// @dev One-shot wiring alone would be a race, and the two wired addresses are the only callers
    /// that may reduce a tab or clear one. The authority closes the window; one-shot closes it
    /// permanently. Matches the pattern in `Bond` and `AgentRegistry`.
    address public immutable WIRING_AUTHORITY;

    /// @notice Registry the applied price list, tier, Settlement Window, and Bond account come from.
    IServiceRegistry public immutable REGISTRY;

    /// @notice Bond this contract pledges against, releases, and slashes.
    IBond public immutable BOND;

    /// @notice Credit granted before any history exists, in Asset base units. (D3)
    uint256 public immutable BASELINE;

    /// @notice Share of weighted history converted into growth, in basis points. (D5)
    uint256 public immutable GROWTH_FACTOR_BPS;

    // ------------------------------------------------------------------ storage

    /// @notice The `SettlementVerifier` permitted to apply Verified Settlements.
    /// @dev Zero until wired, and the gated call reverts while it is zero, because `msg.sender` is
    /// never the zero address. It does not exist at deployment time: it takes this address.
    address public settlementVerifier;

    /// @notice The Watcher permitted to apply Provisional Clearings and report reorganisations.
    address public watcher;

    /// @notice Rolling Verified Settlement history commitment, per Agent and Asset. (D20)
    mapping(address => mapping(address => bytes32)) internal _historyRoot;

    /// @notice Number of records each commitment covers.
    mapping(address => mapping(address => uint32)) internal _historyCount;

    /// @notice Tab records, keyed by `tabId`.
    mapping(bytes32 => Tab) internal _tabs;

    /// @notice The triple each `tabId` was derived from, so a crank can recover it.
    mapping(bytes32 => TabRef) internal _tabRefs;

    /// @notice Aggregate Open Tab per Agent and Asset, across every Service.
    /// @dev Maintained alongside the per-triple tabs because the Credit Limit is per Asset across all
    /// Services while a tab is per triple. Without it every headroom check would iterate the Agent's
    /// Services, which is the unbounded loop D20 forbids.
    mapping(address => mapping(address => uint256)) internal _assetOpen;

    /// @notice How many delinquent tabs are suppressing an Agent's credit in one Asset. (R14.8)
    /// @dev A count rather than a flag, because an Agent may hold several tabs in one Asset and each
    /// can go delinquent and recover independently. Credit is zero while the count is non-zero, so
    /// settling one delinquent tab does not restore credit while another is still overdue.
    mapping(address => mapping(address => uint32)) internal _delinquentTabs;

    /// @notice Spending authorisations, keyed by `authKey`, which equals `tabId`. (D10)
    /// @dev The design derives both from `keccak256(abi.encode(agent, serviceId, asset))`, so they are
    /// the same value. Kept in its own mapping rather than folded into {Tab} so an authorisation can
    /// exist before any delivery has been metered.
    mapping(bytes32 => Authorisation) internal _auths;

    /// @notice Creditcoin timestamp of the earliest Metered Delivery, keyed by `tabId`. (R17.3)
    /// @dev Written once and never rewritten. It is what makes the metered-delivery precedence rule
    /// checkable inside a pure library: the comparison is between two recorded timestamps, so both
    /// must travel with the settlement record.
    mapping(bytes32 => uint64) internal _firstDeliveryAt;

    /// @notice Clearing records, keyed by the replay key of the Settlement they clear. (R15.5)
    /// @dev **One mapping, because there is one identity.** The Watcher supplies the replay key at
    /// observation, the `SettlementVerifier` derives the same word from the proof, and both find the
    /// same record here. The two side indexes this used to need — one from replay key to a hashed
    /// clearing identifier, one Asset-blind locator to catch a Settlement in the wrong Asset — are
    /// gone: the replay key carries no Asset, so a Settlement denominated in another Asset finds this
    /// record and is rejected loudly rather than silently missing it. (R18.4)
    mapping(bytes32 => Clearing) internal _clearings;

    /// @notice Tab reduction attributable to each applied replay key, for reorg restoration.
    mapping(bytes32 => uint128) internal _settledByReplayKey;

    // ------------------------------------------------------------------ wiring events

    /// @notice The `SettlementVerifier` was wired, once and for all.
    /// @param verifier The wired `SettlementVerifier`.
    event SettlementVerifierWired(address indexed verifier);

    /// @notice The Watcher was wired, once and for all.
    /// @param watcherAddress The wired Watcher.
    event WatcherWired(address indexed watcherAddress);

    // ------------------------------------------------------------------ construction

    /// @notice Binds the wiring authority, the collaborators that already exist, and the credit
    /// parameters.
    /// @dev The registry and the Bond are immutable rather than wired, because both are deployed
    /// before this contract and neither takes this address in its constructor. The two that do — the
    /// `SettlementVerifier` and the Watcher — arrive through the one-shot setters below.
    ///
    /// Baseline and growth factor are immutable and global rather than per Asset. The launch scope is
    /// one Asset, and a per-Asset table would be governance surface with no second Asset to
    /// distinguish. Changing either is a redeployment, which is the honest description of a parameter
    /// that no address can move. (D3, D5)
    /// @param wiringAuthority Address permitted to call the two one-shot setters.
    /// @param serviceRegistry The `ServiceRegistry`.
    /// @param bond The `Bond`.
    /// @param baseline Credit granted before any history exists, in Asset base units.
    /// @param growthFactorBps Share of weighted history converted into growth, in basis points.
    constructor(
        address wiringAuthority,
        address serviceRegistry,
        address bond,
        uint256 baseline,
        uint256 growthFactorBps
    ) {
        if (wiringAuthority == address(0)) revert ZeroAddressField();
        if (serviceRegistry == address(0)) revert ZeroAddressField();
        if (bond == address(0)) revert ZeroAddressField();

        WIRING_AUTHORITY = wiringAuthority;
        REGISTRY = IServiceRegistry(serviceRegistry);
        BOND = IBond(bond);
        BASELINE = baseline;
        GROWTH_FACTOR_BPS = growthFactorBps;
    }

    // ------------------------------------------------------------------ wiring

    /// @notice Wire the `SettlementVerifier` permitted to apply Verified Settlements.
    /// @param verifier The `SettlementVerifier` address.
    function setSettlementVerifier(address verifier) external {
        _requireWiringAuthority();
        if (settlementVerifier != address(0)) revert AlreadyWired(settlementVerifier);
        if (verifier == address(0)) revert ZeroAddressField();
        settlementVerifier = verifier;
        emit SettlementVerifierWired(verifier);
    }

    /// @notice Wire the Watcher permitted to apply Provisional Clearings and report reorganisations.
    /// @param watcherAddress The Watcher address.
    function setWatcher(address watcherAddress) external {
        _requireWiringAuthority();
        if (watcher != address(0)) revert AlreadyWired(watcher);
        if (watcherAddress == address(0)) revert ZeroAddressField();
        watcher = watcherAddress;
        emit WatcherWired(watcherAddress);
    }

    // ------------------------------------------------------------------ metering

    /// @inheritdoc ITabBook
    /// @dev Replaces the authorisation wholesale, so `spent` returns to zero. An Agent raising a
    /// ceiling or extending an expiry is stating a fresh intent about what it is willing to owe, and
    /// carrying the old `spent` forward would silently make the new ceiling smaller than the number
    /// written in the call. Only the Agent can reach this, so the reset grants the Service nothing it
    /// was not just handed deliberately.
    ///
    /// A ceiling of zero is accepted and is not the same as no authorisation: it revokes metering
    /// while leaving the record in place, which is why {Authorisation} carries an `exists` flag.
    function authorise(bytes32 serviceId, address asset, uint128 maxCumulative, uint64 expiry) external {
        if (asset == address(0)) revert ZeroAddressField();
        // casting to 'uint64' is safe because a Creditcoin timestamp in seconds stays far below 2^64
        // for the lifetime of the chain.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 nowTs = uint64(block.timestamp);
        if (expiry <= nowTs) revert AuthorisationExpired(expiry, nowTs);

        _auths[tabIdOf(msg.sender, serviceId, asset)] =
            Authorisation({maxCumulative: maxCumulative, spent: 0, expiry: expiry, exists: true});

        emit AuthorisationSet(msg.sender, serviceId, asset, maxCumulative, expiry);
    }

    /// @inheritdoc ITabBook
    /// @dev Six steps in the design's order, each in its own helper. The split is not decoration: at
    /// `via_ir = false` a seven-parameter entrypoint with three named returns has very little stack
    /// left for locals, and each step needs its own working set. `ServiceRegistry.registerService`
    /// splits for the same reason.
    ///
    /// **The quote mechanism, because the spec left the caller's side of it open.** `expectedUnitPrice`
    /// is the price of one unit of `tool`, in Asset base units, that the caller quoted to the Agent
    /// before doing the work. It is compared for exact equality against the currently applied price
    /// list, which the registry already serves at its pre-change value for the whole of a queued
    /// change's 48-hour hold. So the check fires on the one thing it is meant to catch: the applied
    /// price moving between the quote and the charge. A per-unit figure rather than a total keeps the
    /// comparison independent of `units`, which means a Service cannot satisfy it by adjusting the
    /// unit count to match a total it has already committed to.
    function recordDelivery(
        address agent,
        bytes32 serviceId,
        address asset,
        bytes32 tool,
        uint32 units,
        uint256 expectedUnitPrice,
        LimitWitness calldata witness
    ) external returns (uint256 charged, uint128 openAfter, uint256 headroomAfter) {
        _requireOperator(serviceId);
        _requireNotDelinquent(agent, serviceId, asset);
        charged = _charge(serviceId, asset, tool, units, expectedUnitPrice);
        // The authorisation bounds what a Service may meter, so it is consumed by the whole charge
        // whatever funds it. Prepaid credit changes who pays, not how much was delivered.
        _consumeAuthorisation(agent, serviceId, asset, charged);
        // Credit is only consumed by what actually reaches the Open Tab. Prepaid credit is money the
        // Agent has already paid, so spending it borrows nothing and must not be tested against the
        // Credit Limit; charging it against headroom would refuse deliveries the Agent had already
        // funded. (R12.3, D11)
        headroomAfter =
            _requireHeadroom(agent, asset, _openShareOf(agent, serviceId, asset, charged), witness);
        openAfter = _recordOnTab(agent, serviceId, asset, tool, units, charged);
    }

    // ------------------------------------------------------------------ settlement

    /// @inheritdoc ITabBook
    /// @dev Three paths and one shared tail. A Settlement that matches a live Provisional Clearing
    /// converts it and moves no tab figure; anything else reduces the tab and routes the excess to
    /// prepaid credit; and both extend the rolling history commitment.
    function applyVerifiedSettlement(VerifiedSettlement calldata s) external {
        if (msg.sender != settlementVerifier) revert NotSettlementVerifier(msg.sender);
        _guardSettlement(s);
        if (!_confirmProvisional(s)) _applyOrdinarySettlement(s);
        _extendHistory(s);
    }

    // ------------------------------------------------------------------ provisional clearing

    /// @inheritdoc ITabBook
    /// @dev The record is built in memory before anything is written, so the whole clearing travels to
    /// `_openClearing` as one pointer rather than as eight stack slots.
    ///
    /// **The supplied `chainKey` is checked against the replay key it came with.** The identity is the
    /// replay key, but the deadline is chosen from the `chainKey` field, and those are two different
    /// words until this check ties them together. Without it a Watcher could name Mainnet's 60-minute
    /// deadline on an identity that says Sepolia, or the reverse.
    ///
    /// A shortfall is not an error. `Bond.reserve` returns `false` rather than reverting, and the
    /// documented response is to record the decline and leave the Open Tab exactly as it was, so the
    /// Agent waits for its Verified Settlement instead of the observation being unwound. (R15.3)
    function applyProvisionalClearing(ProvisionalObservation calldata o) external returns (bool applied) {
        if (msg.sender != watcher) revert NotWatcher(msg.sender);
        if (o.asset == address(0) || o.agent == address(0)) revert ZeroAddressField();
        _requirePackedChainKey(o.replayKey, o.chainKey);

        // casting to 'uint64' is safe because a Creditcoin timestamp in seconds stays far below 2^64.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 nowTs = uint64(block.timestamp);
        Clearing memory clearing = Clearing({
            agent: o.agent,
            serviceId: o.serviceId,
            asset: o.asset,
            amount: o.amount,
            reduced: 0,
            chainKey: o.chainKey,
            appliedAt: nowTs,
            deadline: nowTs + _deadlineFor(o.chainKey),
            sourceTxHash: o.sourceTxHash,
            attestedDigestAtApply: o.attestedDigestAtApply,
            state: ClearingState.Applied
        });

        applied = _openClearing(o.replayKey, clearing);
    }

    /// @inheritdoc ITabBook
    /// @dev Permissionless on purpose. The Watcher that applied the clearing is also the party that
    /// benefits from never reversing it, so reversal liveness must not depend on it. Anyone may crank
    /// once the deadline passes, and the Dashboard surfaces overdue clearings so an outside party can.
    ///
    /// The Open Tab is restored by the figure the application actually removed, not by the observed
    /// Settlement amount. Those differ whenever the tab held less than the observation, and restoring
    /// the larger figure would leave the Agent owing money it never owed. The slash is still taken
    /// over the full pledge, because that is what the Service put at risk. (R15.5, R14.6)
    function reverseExpiredClearing(bytes32 clearingId) external {
        Clearing storage clearing = _clearings[clearingId];
        if (clearing.state == ClearingState.None) revert UnknownClearing(clearingId);
        if (clearing.state != ClearingState.Applied) {
            revert ClearingNotInState(clearingId, clearing.state);
        }
        if (block.timestamp < clearing.deadline) {
            revert ClearingNotExpired(clearingId, clearing.deadline);
        }

        clearing.state = ClearingState.Reversed;
        _restoreTab(clearing.agent, clearing.serviceId, clearing.asset, clearing.reduced);

        // Slashed value becomes prepaid credit for the Agent inside `Bond`, in the same Asset. The
        // Agent never consented to the claim, so the party that made it is the party that pays for it.
        BOND.slashUnconfirmed(clearingId, clearing.agent);

        emit ProvisionalClearingReversed(
            clearingId,
            clearing.agent,
            clearing.serviceId,
            clearing.asset,
            clearing.amount,
            clearing.sourceTxHash
        );
    }

    /// @inheritdoc ITabBook
    /// @dev The comparison is between the digest the Watcher observed for the Settlement's block and
    /// the digest the attested chain now carries for it. Equal digests mean no reorganisation, so the
    /// call reverts rather than slashing a Service for a chain that did not move. Where the clearing
    /// recorded a digest at apply time, the reported observation must equal it, so the Watcher cannot
    /// substitute a digest it never recorded.
    ///
    /// Because attestation covers only finalized blocks this path is defence in depth rather than an
    /// expected event (D8). It exists so that a finality assumption is never load-bearing without a
    /// check.
    function reportReorg(bytes32 replayKey, bytes32 observedDigest, bytes32 attestedDigest) external {
        if (msg.sender != watcher) revert NotWatcher(msg.sender);
        if (observedDigest == attestedDigest) revert NoReorgDetected(replayKey, observedDigest);

        Clearing storage clearing = _clearings[replayKey];
        if (clearing.state == ClearingState.None) revert UnknownSettlement(replayKey);
        if (clearing.state != ClearingState.Confirmed) {
            revert ClearingNotInState(replayKey, clearing.state);
        }
        if (clearing.attestedDigestAtApply != bytes32(0) && clearing.attestedDigestAtApply != observedDigest)
        {
            revert ObservedDigestMismatch(clearing.attestedDigestAtApply, observedDigest);
        }

        clearing.state = ClearingState.Superseded;

        uint128 restored = _settledByReplayKey[replayKey];
        _restoreTab(clearing.agent, clearing.serviceId, clearing.asset, restored);

        if (clearing.amount > 0) {
            BOND.slashForReorg(
                replayKey, _partyOf(clearing.serviceId), clearing.asset, clearing.amount, clearing.agent
            );
        }

        emit SettlementSuperseded(
            replayKey,
            clearing.agent,
            clearing.serviceId,
            clearing.asset,
            restored,
            observedDigest,
            attestedDigest
        );
    }

    // ------------------------------------------------------------------ delinquency

    /// @inheritdoc ITabBook
    /// @dev **This function reaches no Bond figure, and that is a design property rather than an
    /// oversight.** R14.11 forbids a slashing path for an Agent that fails to settle, because the
    /// Service posted the Bond and extended the credit voluntarily; taking the Service's stake to
    /// compensate the Service would punish the wrong party. So delinquency does exactly three things:
    /// it flags the tab, it suppresses the Agent's Credit Limit in that Asset, and it says so in an
    /// event. The body calls one registry read and nothing else, and the accompanying test snapshots
    /// every stored Bond figure before and after and compares them field by field.
    ///
    /// Permissionless, because the Service is the party that wants the flag and the Agent is the party
    /// that does not, so neither should hold the trigger.
    ///
    /// Suppression is reversible: settling the tab to zero clears it, and credit returns once no
    /// delinquent tab remains for that Agent and Asset.
    function markDelinquent(bytes32 tabId) external {
        TabRef memory ref = _tabRefs[tabId];
        if (!ref.exists) revert UnknownTab(tabId);

        Tab storage tab = _tabs[tabId];
        if (tab.delinquent) revert AlreadyDelinquent(tabId);
        if (tab.open == 0 || tab.oldestUnsettledAt == 0) revert NothingUnsettled(tabId);

        uint64 windowEnd = tab.oldestUnsettledAt + REGISTRY.settlementWindowOf(ref.serviceId);
        if (block.timestamp < windowEnd) revert SettlementWindowOpen(tabId, windowEnd);

        tab.delinquent = true;
        _delinquentTabs[ref.agent][ref.asset] += 1;

        emit TabDelinquent(tabId, ref.agent, ref.serviceId, ref.asset, tab.open, windowEnd);
        emit CreditLimitZeroed(ref.agent, ref.asset, tabId);
    }

    // ------------------------------------------------------------------ reads

    /// @inheritdoc ITabBook
    /// @dev `public` rather than `external` so the settlement and clearing paths derive the identifier
    /// through the same expression a caller reads it from, instead of repeating the encoding.
    function tabIdOf(address agent, bytes32 serviceId, address asset) public pure returns (bytes32 tabId) {
        return keccak256(abi.encode(agent, serviceId, asset));
    }

    /// @inheritdoc ITabBook
    function tabOf(bytes32 tabId) external view returns (Tab memory tab) {
        return _tabs[tabId];
    }

    /// @inheritdoc ITabBook
    function tabRefOf(bytes32 tabId) external view returns (TabRef memory ref) {
        return _tabRefs[tabId];
    }

    /// @inheritdoc ITabBook
    function assetOpen(address agent, address asset) external view returns (uint256 open) {
        return _assetOpen[agent][asset];
    }

    /// @inheritdoc ITabBook
    function historyCommitment(address agent, address asset)
        external
        view
        returns (bytes32 root, uint32 count)
    {
        return (_historyRoot[agent][asset], _historyCount[agent][asset]);
    }

    /// @inheritdoc ITabBook
    function firstDeliveryAtOf(address agent, bytes32 serviceId, address asset)
        external
        view
        returns (uint64 timestamp)
    {
        return _firstDeliveryAt[tabIdOf(agent, serviceId, asset)];
    }

    /// @inheritdoc ITabBook
    function authorisationOf(address agent, bytes32 serviceId, address asset)
        external
        view
        returns (Authorisation memory authorisation)
    {
        return _auths[tabIdOf(agent, serviceId, asset)];
    }

    /// @inheritdoc ITabBook
    /// @dev A view with no authentication of any kind, so a Dashboard, a reproduction script, or a
    /// stranger with an RPC endpoint gets the same number the metering path enforces. (R12.6)
    function creditLimit(address agent, address asset, LimitWitness calldata witness)
        external
        view
        returns (uint256 limit)
    {
        return _limitOf(agent, asset, witness);
    }

    /// @inheritdoc ITabBook
    function headroom(address agent, address asset, LimitWitness calldata witness)
        external
        view
        returns (uint256 available)
    {
        uint256 limit = _limitOf(agent, asset, witness);
        uint256 open = _assetOpen[agent][asset];
        return limit > open ? limit - open : 0;
    }

    /// @inheritdoc ITabBook
    function clearingOf(bytes32 clearingId) external view returns (Clearing memory clearing) {
        return _clearings[clearingId];
    }

    /// @inheritdoc ITabBook
    function delinquentTabCount(address agent, address asset) external view returns (uint32 count) {
        return _delinquentTabs[agent][asset];
    }

    // ------------------------------------------------------------------ metering internals

    /// @notice Rejects any caller that does not operate the named Service.
    /// @dev The registry read reverts `UnknownService` for an unregistered identifier, so an
    /// unregistered Service cannot meter either.
    /// @param serviceId Service whose operator is required.
    function _requireOperator(bytes32 serviceId) internal view {
        address operator = REGISTRY.serviceOf(serviceId).operator;
        if (operator != msg.sender) revert NotServiceOperator(serviceId, msg.sender);
    }

    /// @notice Rejects metering into a delinquent tab.
    /// @param agent Agent that would be charged.
    /// @param serviceId Service that would charge.
    /// @param asset Asset of the charge.
    function _requireNotDelinquent(address agent, bytes32 serviceId, address asset) internal view {
        bytes32 tabId = tabIdOf(agent, serviceId, asset);
        if (_tabs[tabId].delinquent) revert TabIsDelinquent(tabId);
    }

    /// @notice Price the delivery from the applied price list and check it against the caller's quote.
    /// @dev The registry serves the previously applied price for the whole of a queued change's hold,
    /// so this comparison catches the applied price moving and nothing else. (R11.7)
    /// @param serviceId Service metering.
    /// @param asset Asset of the charge.
    /// @param tool Named priced unit.
    /// @param units Count of priced units.
    /// @param expectedUnitPrice Unit price the caller quoted.
    /// @return charged Total charge in Asset base units.
    function _charge(bytes32 serviceId, address asset, bytes32 tool, uint32 units, uint256 expectedUnitPrice)
        internal
        view
        returns (uint256 charged)
    {
        if (units == 0) revert ZeroUnits();

        uint256 applied = REGISTRY.priceOf(serviceId, asset, tool);
        if (applied != expectedUnitPrice) {
            revert PriceListChangedMidCall(serviceId, asset, tool, expectedUnitPrice, applied);
        }

        charged = uint256(units) * applied;
        if (charged > type(uint128).max) revert AmountOutOfRange(charged);
    }

    /// @notice Check the Agent's spending authorisation and consume it. (D10)
    /// @param agent Agent charged.
    /// @param serviceId Service charging.
    /// @param asset Asset of the charge.
    /// @param charged Amount being charged.
    function _consumeAuthorisation(address agent, bytes32 serviceId, address asset, uint256 charged)
        internal
    {
        Authorisation storage auth = _auths[tabIdOf(agent, serviceId, asset)];
        if (!auth.exists) revert AuthorisationMissing(agent, serviceId, asset);

        // casting to 'uint64' is safe because a Creditcoin timestamp in seconds stays far below 2^64.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 nowTs = uint64(block.timestamp);
        if (auth.expiry < nowTs) revert AuthorisationExpired(auth.expiry, nowTs);

        uint256 projected = uint256(auth.spent) + charged;
        if (projected > auth.maxCumulative) {
            revert AuthorisationExceeded(auth.maxCumulative, auth.spent, charged);
        }

        // casting to 'uint128' is safe because `projected` was just compared against a `uint128`.
        // forge-lint: disable-next-line(unsafe-typecast)
        auth.spent = uint128(projected);
    }

    /// @notice Reject a charge that would take the Agent past its Credit Limit for the Asset. (R12.3)
    /// @param agent Agent charged.
    /// @param asset Asset of the charge.
    /// @param charged Amount being charged.
    /// @param witness History and Bond figures the limit is computed from.
    /// @return headroomAfter Headroom remaining once the charge lands.
    function _requireHeadroom(address agent, address asset, uint256 charged, LimitWitness calldata witness)
        internal
        view
        returns (uint256 headroomAfter)
    {
        uint256 limit = _limitOf(agent, asset, witness);
        uint256 open = _assetOpen[agent][asset];
        uint256 projected = open + charged;
        if (projected > limit) {
            revert LimitExceeded(agent, asset, charged, limit > open ? limit - open : 0);
        }
        headroomAfter = limit - projected;
    }

    /// @notice How much of a charge will reach the Open Tab once prepaid credit is spent.
    /// @dev The read half of the split `_recordOnTab` then performs. It exists so the headroom check
    /// runs on the amount that is actually borrowed, and the two must stay in step: if this said one
    /// thing and the write said another, a delivery could pass the Credit Limit check and then exceed
    /// it, or be refused for credit it never needed.
    /// @param agent Agent charged.
    /// @param serviceId Service metering.
    /// @param asset Asset of the charge.
    /// @param charged Full amount being charged.
    /// @return toOpen Base units that will raise the Open Tab.
    function _openShareOf(address agent, bytes32 serviceId, address asset, uint256 charged)
        internal
        view
        returns (uint256 toOpen)
    {
        uint128 prepaid = _tabs[tabIdOf(agent, serviceId, asset)].prepaid;
        toOpen = charged > prepaid ? charged - prepaid : 0;
    }

    /// @notice Write the delivery onto the tab and the aggregate. (R12.1, R12.2)
    /// @param agent Agent charged.
    /// @param serviceId Service metering.
    /// @param asset Asset of the charge.
    /// @param tool Named priced unit.
    /// @param units Count of priced units.
    /// @param charged Amount charged.
    /// @return openAfter Open Tab after the charge.
    function _recordOnTab(
        address agent,
        bytes32 serviceId,
        address asset,
        bytes32 tool,
        uint32 units,
        uint256 charged
    ) internal returns (uint128 openAfter) {
        bytes32 tabId = tabIdOf(agent, serviceId, asset);
        _touchTab(tabId, agent, serviceId, asset);

        // casting to 'uint64' is safe because a Creditcoin timestamp in seconds stays far below 2^64.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 nowTs = uint64(block.timestamp);

        Tab storage tab = _tabs[tabId];

        // **Task 12.6's fix: prepaid credit is spent before the Open Tab is raised.** D11 says excess
        // settlement becomes non-refundable prepaid credit "consumable against future Metered
        // Delivery", and until this shipped nothing anywhere decremented `prepaid`, so every base unit
        // that landed there was stranded for good: already paid for, never spendable, and not
        // refundable either. Drawing it down here is what makes the "consumable" half of D11 true, and
        // it keeps Property 15's conservation invariant intact, because a base unit now leaves prepaid
        // exactly when it stops being owed.
        // casting to 'uint128' is safe because `_charge` rejected anything above the `uint128` range.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 chargedAmount = uint128(charged);
        uint128 fromPrepaid = tab.prepaid >= chargedAmount ? chargedAmount : tab.prepaid;
        uint128 toOpen = chargedAmount - fromPrepaid;

        if (fromPrepaid > 0) {
            tab.prepaid -= fromPrepaid;
            emit PrepaidConsumed(agent, serviceId, asset, fromPrepaid, tab.prepaid, toOpen);
        }

        tab.open += toOpen;
        // The Settlement Window runs from the oldest delivery that is still unsettled, so this is set
        // only when the tab was empty and is cleared again the moment it settles to zero. A delivery
        // paid entirely out of prepaid credit owes nothing, so it must not start that clock.
        if (toOpen > 0 && tab.oldestUnsettledAt == 0) tab.oldestUnsettledAt = nowTs;
        tab.lastDeliveryAt = nowTs;
        tab.deliveryCount += 1;

        _assetOpen[agent][asset] += toOpen;
        if (_firstDeliveryAt[tabId] == 0) _firstDeliveryAt[tabId] = nowTs;

        // The full charge is reported, whatever funded it. A delivery of 10,000 base units is a
        // delivery of 10,000 base units, and the funding split is `PrepaidConsumed`'s to report.
        emit DeliveryRecorded(agent, serviceId, asset, tool, units, charged, nowTs);
        openAfter = tab.open;
    }

    // ------------------------------------------------------------------ settlement internals

    /// @notice Reject a Verified Settlement that cannot be applied at all.
    /// @dev **The duplicate test is on the clearing's state, not on the record's existence.** With one
    /// mapping keyed on the replay key, a record already sitting under that key is the ordinary case
    /// rather than the exceptional one: a clearing in `Applied` is precisely the precondition for
    /// confirming it. Only the two states that already consumed this proof are duplicates —
    /// `Confirmed`, and `Superseded`, which is a `Confirmed` record that a reorganisation took back.
    ///
    /// `Declined` and `Reversed` both fall through to the ordinary path. A declined observation never
    /// touched the tab, and a reversed one had its reduction restored, so in both cases the Settlement
    /// has a real reduction left to make.
    ///
    /// Defence in depth either way. `TabAscBase` already claims each replay key exactly once before
    /// any handler runs, so the revert is unreachable through the verifier; it exists so that a future
    /// caller wired into this slot cannot double-apply one proof.
    /// @param s The Verified Settlement entry.
    function _guardSettlement(VerifiedSettlement calldata s) internal view {
        if (s.agent == address(0) || s.asset == address(0)) revert ZeroAddressField();
        if (s.amount > type(uint128).max) revert AmountOutOfRange(s.amount);

        ClearingState state = _clearings[s.replayKey].state;
        if (state == ClearingState.Confirmed || state == ClearingState.Superseded) {
            revert SettlementAlreadyApplied(s.replayKey);
        }
    }

    /// @notice Convert a live Provisional Clearing into a Confirmed Clearing. (R15.4)
    /// @dev Returns false when there is nothing to convert, which is both the case where no
    /// observation was ever made and the case where the observation was declined for want of Bond. A
    /// declined observation is terminal, so its record is left alone and the Settlement takes the
    /// ordinary path with no Bond involvement.
    ///
    /// **No second reduction, and the excess still lands.** The tab was reduced when the clearing was
    /// applied, so nothing is reduced here. What the confirmation does settle is the part of the
    /// observed amount the tab could not absorb: a Verified Settlement is the authority that makes
    /// that excess final, so it becomes prepaid credit now rather than at apply time, when it was
    /// still revocable. Every settled base unit is therefore accounted for by exactly one of the two.
    /// (R12.5, R15.4, R15.6)
    /// @param s The Verified Settlement entry.
    /// @return converted Whether a live Provisional Clearing was converted.
    function _confirmProvisional(VerifiedSettlement calldata s) internal returns (bool converted) {
        Clearing storage clearing = _clearings[s.replayKey];
        if (clearing.state == ClearingState.None) return false;

        // **The replay key carries no Asset, and that is what keeps this check reachable.** An identity
        // that included the Asset would derive a different word for a Settlement denominated in another
        // Asset, so the mismatch would silently miss the clearing instead of being caught. Looking the
        // clearing up on the Asset-blind identity and then comparing the two is what makes it loud, and
        // it is checked ahead of the state test so a mismatch is reported even against a terminal
        // record. (R18.4)
        if (clearing.asset != s.asset) revert AssetMismatch(clearing.asset, s.asset);
        if (clearing.state != ClearingState.Applied) return false;

        clearing.state = ClearingState.Confirmed;
        BOND.release(s.replayKey);

        _settledByReplayKey[s.replayKey] = clearing.reduced;

        // casting to 'uint128' is safe because `_guardSettlement` rejected anything wider.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 amount = uint128(s.amount);
        uint128 toPrepaid = amount > clearing.reduced ? amount - clearing.reduced : 0;

        bytes32 tabId = tabIdOf(s.agent, s.serviceId, s.asset);
        _touchTab(tabId, s.agent, s.serviceId, s.asset);
        if (toPrepaid > 0) _tabs[tabId].prepaid += toPrepaid;

        // The transaction hash comes off the record, where the Watcher wrote it at observation time.
        // The Verified Settlement carries none, and could not honestly produce one. (R15.8)
        emit ProvisionalClearingConfirmed(
            s.replayKey, s.agent, s.serviceId, s.asset, amount, clearing.sourceTxHash
        );
        emit SettlementApplied(s.replayKey, s.agent, s.serviceId, s.asset, 0, toPrepaid, _tabs[tabId].open);

        _clearDelinquencyIfSettled(tabId);
        return true;
    }

    /// @notice Reduce the Open Tab and route the excess to prepaid credit. (R12.4, R12.5)
    /// @param s The Verified Settlement entry.
    function _applyOrdinarySettlement(VerifiedSettlement calldata s) internal {
        bytes32 tabId = tabIdOf(s.agent, s.serviceId, s.asset);
        _touchTab(tabId, s.agent, s.serviceId, s.asset);

        Tab storage tab = _tabs[tabId];
        // casting to 'uint128' is safe because `_guardSettlement` rejected anything wider.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 amount = uint128(s.amount);
        uint128 applied = amount < tab.open ? amount : tab.open;

        if (applied > 0) {
            tab.open -= applied;
            _assetOpen[s.agent][s.asset] -= applied;
            if (tab.open == 0) tab.oldestUnsettledAt = 0;
        }

        // Excess becomes prepaid credit and is never refunded. Returning Asset value to a Source Chain
        // address requires Writability, which this system does not have, so this is a limitation
        // recorded as such rather than a solved problem. (R12.5, D11)
        uint128 toPrepaid = amount - applied;
        if (toPrepaid > 0) tab.prepaid += toPrepaid;

        // Recorded under the replay key, which is the only identity a Settlement has. Two Settlement
        // logs in one Source Chain transaction can pay the same Agent, Service, and Asset; an identity
        // derived from the transaction would collide on them, and the replay key cannot, because it
        // carries the log ordinal. (R4.1)
        _settledByReplayKey[s.replayKey] = applied;
        _writeConfirmedRecord(s, amount, applied);

        emit SettlementApplied(s.replayKey, s.agent, s.serviceId, s.asset, applied, toPrepaid, tab.open);

        _clearDelinquencyIfSettled(tabId);
    }

    /// @notice Record a confirmation that never had a provisional stage, so a reorg can supersede it.
    /// @dev **Two fields are written empty here, and it is the same reason for both.** A Verified
    /// Settlement carries no Source Chain transaction hash and no observed block digest, because
    /// nothing observed the Settlement before the proof arrived. Zero is therefore the truthful answer
    /// rather than a gap: `reportReorg` reads a zero digest as "nothing recorded to check against", and
    /// the transaction hash is audit data that gates nothing. The two are deliberately consistent.
    ///
    /// The hash a Watcher did supply survives where it matters, on the `ProvisionalClearingDeclined`
    /// and `ProvisionalClearingReversed` events that record what became of the observation. (R15.8)
    /// @param s The Verified Settlement entry.
    /// @param amount Settled amount.
    /// @param applied Tab reduction the Settlement achieved.
    function _writeConfirmedRecord(VerifiedSettlement calldata s, uint128 amount, uint128 applied) internal {
        // casting to 'uint64' is safe because a Creditcoin timestamp in seconds stays far below 2^64.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 nowTs = uint64(block.timestamp);
        _clearings[s.replayKey] = Clearing({
            agent: s.agent,
            serviceId: s.serviceId,
            asset: s.asset,
            amount: amount,
            reduced: applied,
            chainKey: s.chainKey,
            appliedAt: nowTs,
            // No deadline: this record was confirmed the moment it was written, so the reversal crank
            // has nothing to do with it and its guard rejects any state other than `Applied`.
            deadline: 0,
            // No transaction hash, because a Verified Settlement carries none and could not honestly
            // produce one. See this function's note.
            sourceTxHash: bytes32(0),
            // No digest was observed, because no observation preceded the proof. `reportReorg` treats
            // a zero here as "nothing recorded to check against".
            attestedDigestAtApply: bytes32(0),
            state: ClearingState.Confirmed
        });
    }

    /// @notice Extend the rolling Verified Settlement history commitment. (D20)
    /// @param s The Verified Settlement entry.
    function _extendHistory(VerifiedSettlement calldata s) internal {
        LimitLib.SettlementRecord memory record = _recordOf(s);

        bytes32 root = _fold(_historyRoot[s.agent][s.asset], record);
        _historyRoot[s.agent][s.asset] = root;

        uint32 count = _historyCount[s.agent][s.asset] + 1;
        _historyCount[s.agent][s.asset] = count;

        emit HistoryExtended(s.agent, s.asset, root, count, record);
    }

    /// @notice Build the committed history record for one Verified Settlement.
    /// @dev **Every field here is authored by this contract, and that is what makes the commitment
    /// worth checking.** The tier and the Bond presence are read from the registry and from `Bond` at
    /// settlement time, the delivery precedence timestamp comes from this contract's own storage, and
    /// the settlement timestamp is the block clock. A caller supplying a witness can therefore change
    /// none of them without breaking the root, which is the difference between a commitment that
    /// binds the four filters of `LimitLib` and one that binds only the amounts. (R11.5, R17.2, R17.3)
    /// @param s The Verified Settlement entry.
    /// @return record The record as it will be folded into the commitment.
    function _recordOf(VerifiedSettlement calldata s)
        internal
        view
        returns (LimitLib.SettlementRecord memory record)
    {
        IServiceRegistry.Service memory service = REGISTRY.serviceOf(s.serviceId);
        record = LimitLib.SettlementRecord({
            serviceId: s.serviceId,
            asset: s.asset,
            // casting to 'uint128' is safe because `_guardSettlement` rejected anything wider.
            // forge-lint: disable-next-line(unsafe-typecast)
            amount: uint128(s.amount),
            // casting to 'uint64' is safe because a Creditcoin timestamp stays far below 2^64.
            // forge-lint: disable-next-line(unsafe-typecast)
            settledAt: uint64(block.timestamp),
            firstDeliveryAt: _firstDeliveryAt[tabIdOf(s.agent, s.serviceId, s.asset)],
            chainKey: s.chainKey,
            curated: service.tier == IServiceRegistry.Tier.Curated,
            bonded: BOND.ledgerOf(BOND.partyOf(service.bondAccount), s.asset).staked > 0
        });
    }

    /// @notice Fold one record into the rolling commitment.
    /// @dev **The commitment covers exactly the fields the witness carries, which is a correction to
    /// the design's formula rather than a shortcut.** The design chains
    /// `(previousRoot, replayKey, serviceId, asset, amount, settledAt, chainKey)`. That cannot be
    /// recomputed from a witness at all, because a witness record carries no replay key; and worse, it
    /// leaves `firstDeliveryAt`, `curated`, and `bonded` uncommitted, so a caller could flip `curated`
    /// to true on every record and manufacture a Credit Limit from an uncurated ring. Chaining the
    /// whole record closes both: the witness is self-verifying, and all four of the filters R13.3,
    /// R17.2, and R17.3 rest on are bound by the hash. Replay uniqueness is unaffected, since it is
    /// enforced where the replay key lives, in `TabAscBase`.
    /// @param previousRoot Commitment before the append.
    /// @param record Record being appended.
    /// @return root Commitment after the append.
    function _fold(bytes32 previousRoot, LimitLib.SettlementRecord memory record)
        internal
        pure
        returns (bytes32 root)
    {
        return keccak256(
            abi.encode(
                previousRoot,
                record.serviceId,
                record.asset,
                record.amount,
                record.settledAt,
                record.firstDeliveryAt,
                record.chainKey,
                record.curated,
                record.bonded
            )
        );
    }

    // ------------------------------------------------------------------ clearing internals

    /// @notice Pledge Bond and apply, or decline and leave the tab alone. (R15.2, R15.3)
    /// @dev The replay key is passed straight through to `Bond.reserve` as the reservation identifier,
    /// so the pledge, the clearing, and the proof that later releases it all sit under one word.
    /// @param clearingId Replay key the record is written under.
    /// @param clearing The record, fully populated except for `reduced` and the declined state.
    /// @return applied Whether free Bond covered the amount.
    function _openClearing(bytes32 clearingId, Clearing memory clearing) internal returns (bool applied) {
        ClearingState existing = _clearings[clearingId].state;
        if (existing != ClearingState.None) revert ClearingAlreadyExists(clearingId, existing);
        if (clearing.amount == 0) revert AmountOutOfRange(0);

        bytes32 party = _partyOf(clearing.serviceId);

        if (!BOND.reserve(party, clearing.asset, clearing.amount, clearingId)) {
            clearing.state = ClearingState.Declined;
            _clearings[clearingId] = clearing;
            emit ProvisionalClearingDeclined(
                clearing.agent,
                clearing.serviceId,
                clearing.asset,
                clearing.amount,
                clearing.sourceTxHash,
                BOND.freeOf(party, clearing.asset)
            );
            return false;
        }

        bytes32 tabId = tabIdOf(clearing.agent, clearing.serviceId, clearing.asset);
        _touchTab(tabId, clearing.agent, clearing.serviceId, clearing.asset);

        Tab storage tab = _tabs[tabId];
        uint128 reduced = clearing.amount < tab.open ? clearing.amount : tab.open;
        if (reduced > 0) {
            tab.open -= reduced;
            _assetOpen[clearing.agent][clearing.asset] -= reduced;
            if (tab.open == 0) tab.oldestUnsettledAt = 0;
        }

        // The excess is deliberately not credited as prepaid here. A Provisional Clearing is revocable
        // for its whole life, and prepaid credit is not; the excess lands only when the Verified
        // Settlement confirms it. (R15.6)
        clearing.reduced = reduced;
        _clearings[clearingId] = clearing;

        emit ProvisionalClearingApplied(
            clearingId,
            clearing.agent,
            clearing.serviceId,
            clearing.asset,
            clearing.amount,
            clearing.sourceTxHash,
            clearing.deadline
        );
        return true;
    }

    /// @notice Restore an Open Tab by an amount a reversal or a supersession took back.
    /// @param agent Agent whose tab is restored.
    /// @param serviceId Service the tab belongs to.
    /// @param asset Asset of the tab.
    /// @param amount Amount to restore.
    function _restoreTab(address agent, bytes32 serviceId, address asset, uint128 amount) internal {
        if (amount == 0) return;

        Tab storage tab = _tabs[tabIdOf(agent, serviceId, asset)];
        tab.open += amount;
        _assetOpen[agent][asset] += amount;
        // The restored charge is unsettled again, so the Settlement Window restarts from now rather
        // than from the delivery that originally opened it. Backdating it would let a reversal make a
        // tab instantly delinquent for a Settlement the Agent did in fact make.
        if (tab.oldestUnsettledAt == 0) {
            // casting to 'uint64' is safe because a Creditcoin timestamp stays far below 2^64.
            // forge-lint: disable-next-line(unsafe-typecast)
            tab.oldestUnsettledAt = uint64(block.timestamp);
        }
    }

    /// @notice Reject an observation whose `chainKey` disagrees with its replay key's top 64 bits.
    /// @dev The chainKey is re-derived here rather than through `TabAscBase.unpackReplayKey`, because
    /// this contract does not inherit that base and the packing is one shift. The layout is the base's:
    /// bits 255 down to 192 hold the chainKey. (R4.1)
    /// @param key The packed replay key.
    /// @param supplied The chainKey the observation named.
    function _requirePackedChainKey(bytes32 key, uint64 supplied) internal pure {
        // casting to 'uint64' is a deliberate truncation to the field's width, matching the packing.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 packed = uint64(uint256(key) >> 192);
        if (packed != supplied) revert ReplayKeyChainKeyMismatch(packed, supplied);
    }

    /// @notice Confirmation deadline for one Source Chain, in seconds. (D6, R15.5)
    /// @param chainKey Source Chain of the observation.
    /// @return window Seconds from application to the reversal crank becoming callable.
    function _deadlineFor(uint64 chainKey) internal pure returns (uint64 window) {
        if (chainKey == CHAIN_KEY_MAINNET) return CLEARING_DEADLINE_MAINNET;
        if (chainKey == CHAIN_KEY_SEPOLIA) return CLEARING_DEADLINE_SEPOLIA;
        revert UnsupportedChainKey(chainKey);
    }

    // ------------------------------------------------------------------ shared internals

    /// @notice Record the triple behind a `tabId`, once.
    /// @param tabId Identifier of the tab.
    /// @param agent Agent the tab belongs to.
    /// @param serviceId Service that meters into it.
    /// @param asset Asset it is denominated in.
    function _touchTab(bytes32 tabId, address agent, bytes32 serviceId, address asset) internal {
        if (_tabRefs[tabId].exists) return;
        _tabRefs[tabId] = TabRef({agent: agent, serviceId: serviceId, asset: asset, exists: true});
    }

    /// @notice Lift the delinquency flag once a tab has settled to zero. (R14.8)
    /// @param tabId Identifier of the tab.
    function _clearDelinquencyIfSettled(bytes32 tabId) internal {
        Tab storage tab = _tabs[tabId];
        if (!tab.delinquent || tab.open != 0) return;

        tab.delinquent = false;
        TabRef memory ref = _tabRefs[tabId];
        uint32 outstanding = _delinquentTabs[ref.agent][ref.asset];
        if (outstanding > 0) _delinquentTabs[ref.agent][ref.asset] = outstanding - 1;

        emit TabDelinquencyCleared(tabId, ref.agent, ref.asset);
    }

    /// @notice The Credit Limit for one Agent and Asset, from a validated witness. (R13.2)
    /// @param agent Agent to evaluate.
    /// @param asset Asset to evaluate in.
    /// @param witness History and Bond figures.
    /// @return limit The Credit Limit in Asset base units.
    function _limitOf(address agent, address asset, LimitWitness calldata witness)
        internal
        view
        returns (uint256 limit)
    {
        _requireWitness(agent, asset, witness);

        // Delinquency in this Asset zeroes the limit outright, ahead of any arithmetic. (R14.8)
        if (_delinquentTabs[agent][asset] > 0) return 0;

        LimitLib.Params memory params = LimitLib.Params({
            asset: asset,
            baseline: BASELINE,
            growthFactorBps: GROWTH_FACTOR_BPS,
            // casting to 'uint64' is safe because a Creditcoin timestamp stays far below 2^64.
            // forge-lint: disable-next-line(unsafe-typecast)
            evaluatedAt: uint64(block.timestamp)
        });

        return LimitLib.creditLimit(witness.history, _resolveBonds(agent, witness, asset), params);
    }

    /// @notice Reject a witness whose history does not match the on-chain commitment. (D20)
    /// @param agent Agent the history belongs to.
    /// @param asset Asset the history is scoped to.
    /// @param witness History and Bond figures.
    function _requireWitness(address agent, address asset, LimitWitness calldata witness) internal view {
        uint32 count = _historyCount[agent][asset];
        if (witness.history.length != count) {
            revert HistoryLengthMismatch(count, witness.history.length);
        }

        bytes32 root;
        for (uint256 i = 0; i < witness.history.length; ++i) {
            root = _fold(root, witness.history[i]);
        }

        bytes32 stored = _historyRoot[agent][asset];
        if (root != stored) revert HistoryCommitmentMismatch(stored, root);
    }

    /// @notice Replace every supplied Bond amount with the figure `Bond` actually holds.
    /// @dev **The caller's numbers are discarded, not checked.** The bond cap is the invariant that
    /// keeps the whole system's credit strictly under the capital behind it (R13.5, R17.1), and it is
    /// computed from this array. A caller that could name its own amounts could name any Credit Limit.
    /// So each entry keeps only its Service and its Asset, and the amount is read from the ledger.
    ///
    /// Two further conditions close the ways an honest-looking array still breaks the invariant. A
    /// repeated counterparty would count one posted Bond twice. And an entry must name a Service that
    /// is actually a counterparty of this Agent, or the ceiling would rise on capital standing behind
    /// credit somebody else extended. Counterparty status is either of two things: the Service appears
    /// in the committed history for the Asset, or the Agent has granted it a spending authorisation.
    /// The second clause is what lets a first-ever delivery happen at all — a brand-new Agent has an
    /// empty history, so a history-only rule would leave it with a bond cap of zero and therefore a
    /// Credit Limit of zero forever. It cannot be gamed by a Service, because only the Agent can write
    /// an authorisation.
    ///
    /// The `staked` figure is used rather than `free`, because R13.5 speaks of the Bond posted. Stake
    /// pledged against a live clearing is still posted, and is still slashable.
    /// @param agent Agent the computation is for.
    /// @param witness History and Bond figures.
    /// @param asset Asset the computation is scoped to.
    /// @return resolved Bond entries carrying on-chain amounts.
    function _resolveBonds(address agent, LimitWitness calldata witness, address asset)
        internal
        view
        returns (LimitLib.BondEntry[] memory resolved)
    {
        uint256 n = witness.bonds.length;
        if (n > LimitLib.MAX_COUNTERPARTIES) revert TooManyBondEntries(n, LimitLib.MAX_COUNTERPARTIES);

        resolved = new LimitLib.BondEntry[](n);
        for (uint256 i = 0; i < n; ++i) {
            bytes32 serviceId = witness.bonds[i].serviceId;
            address entryAsset = witness.bonds[i].asset;

            for (uint256 j = 0; j < i; ++j) {
                if (resolved[j].serviceId == serviceId && resolved[j].asset == entryAsset) {
                    revert DuplicateBondEntry(serviceId);
                }
            }

            // Only entries in the scoped Asset reach the cap; `LimitLib` skips the rest, so requiring
            // counterparty status of an out-of-scope entry would reject a harmless one.
            if (entryAsset == asset && !_isCounterparty(agent, witness, serviceId, asset)) {
                revert IneligibleBondEntry(serviceId, asset);
            }

            resolved[i] = LimitLib.BondEntry({
                serviceId: serviceId, asset: entryAsset, amount: _stakedOf(serviceId, entryAsset)
            });
        }
    }

    /// @notice Whether a Service is a counterparty of this Agent in one Asset.
    /// @param agent Agent to check for.
    /// @param witness History and Bond figures.
    /// @param serviceId Counterparty to look for.
    /// @param asset Asset to look in.
    /// @return present Whether the Service settled with this Agent or holds its authorisation.
    function _isCounterparty(address agent, LimitWitness calldata witness, bytes32 serviceId, address asset)
        internal
        view
        returns (bool present)
    {
        if (_auths[tabIdOf(agent, serviceId, asset)].exists) return true;

        for (uint256 i = 0; i < witness.history.length; ++i) {
            if (witness.history[i].serviceId == serviceId && witness.history[i].asset == asset) {
                return true;
            }
        }
        return false;
    }

    /// @notice Stake one Service has posted in one Asset.
    /// @param serviceId Service to read.
    /// @param asset Asset to read.
    /// @return staked Posted stake in Asset base units.
    function _stakedOf(bytes32 serviceId, address asset) internal view returns (uint128 staked) {
        address bondAccount = REGISTRY.serviceOf(serviceId).bondAccount;
        return BOND.ledgerOf(BOND.partyOf(bondAccount), asset).staked;
    }

    /// @notice The `Bond` party key of one Service.
    /// @param serviceId Service to read.
    /// @return party Key its ledgers sit under.
    function _partyOf(bytes32 serviceId) internal view returns (bytes32 party) {
        return BOND.partyOf(REGISTRY.serviceOf(serviceId).bondAccount);
    }

    /// @notice Rejects any caller other than the wiring authority.
    function _requireWiringAuthority() internal view {
        if (msg.sender != WIRING_AUTHORITY) revert NotWiringAuthority(msg.sender);
    }
}
