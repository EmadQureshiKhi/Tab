// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title IBond
/// @notice Consumer surface of the Bond: the Service-posted stake that makes a Provisional Clearing
/// safe to apply before its Settlement is provable.
/// @dev The surface is complete: proven funding, the pledge and its return, the two slashing
/// transitions, and withdrawal. The slashing and withdrawal transitions added nothing to the ledger
/// shape below — they move value between the same four stored figures over the same per-clearing
/// pledge record — which is why they extend this interface rather than reshape it.
///
/// **Two slashing causes and no third.** `slashUnconfirmed` fires when a Provisional Clearing passes
/// its deadline with no Verified Settlement (R14.6); `slashForReorg` fires when the attested digest
/// comparison shows the observed Source Chain block was reorganised out (R14.7). There is no third
/// entrypoint, and in particular none for an Agent that fails to settle an Open Tab (R14.8, R14.11).
///
/// Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.9, 14.11, 18.5
interface IBond {
    /// @notice Lifecycle of the Bond amount pledged against one Provisional Clearing.
    enum ReservationState {
        // No reservation has ever been created for this clearing identifier.
        None,
        // Bond is pledged and is excluded from `free`. (R14.4)
        Reserved,
        // The clearing was confirmed and the pledge returned to `free`. (R14.5)
        Released,
        // The clearing reached its deadline unconfirmed and the pledge was slashed. Terminal, and
        // written only by `slashUnconfirmed`. (R14.6)
        Slashed
    }

    /// @notice Bond figures for one party in one Asset. (R14.3, R18.5)
    /// @dev Four figures are stored and the fifth is derived. See `Bond.freeOf` for the identity.
    struct Ledger {
        /// @dev Total pledged into this Asset by proven deposit. Monotonic.
        uint128 staked;
        /// @dev Currently covering Provisional Clearings in the `Reserved` state. (R14.3, R14.4)
        uint128 reserved;
        /// @dev Cumulative slashed value, monotonic. Written only by the slashing transitions.
        uint128 slashed;
        /// @dev Withdrawal-eligible value, awaiting Writability. Written only by withdrawal.
        uint128 released;
    }

    /// @notice The pledge covering one Provisional Clearing.
    /// @dev Party, Asset, and amount live in one record rather than in parallel mappings, so a
    /// release or a slash names its Asset by naming its clearing and cannot be aimed elsewhere.
    struct Reservation {
        /// @dev Bonded party key, the Service's `bondAccount`.
        bytes32 party;
        /// @dev Asset the pledge is denominated in. (R18.5)
        address asset;
        /// @dev Where this pledge sits in its lifecycle.
        ReservationState state;
        /// @dev Pledged amount in Asset base units.
        uint128 amount;
    }

    /// @notice Stake arrived by proven deposit and was credited to one Asset ledger. (R14.1)
    /// @param party Bonded party credited.
    /// @param asset Asset the stake is denominated in.
    /// @param amount Credited amount in Asset base units.
    /// @param replayKey Verified Settlement that proved the deposit.
    event BondFunded(bytes32 indexed party, address indexed asset, uint128 amount, bytes32 replayKey);

    /// @notice Bond was pledged against a Provisional Clearing. (R14.4)
    /// @param clearingId Clearing the pledge covers.
    /// @param party Bonded party whose stake is pledged.
    /// @param asset Asset of the clearing and of the pledge.
    /// @param amount Pledged amount in Asset base units.
    event BondReserved(
        bytes32 indexed clearingId, bytes32 indexed party, address indexed asset, uint128 amount
    );

    /// @notice A pledge returned to free Bond because its clearing was confirmed. (R14.5)
    /// @param clearingId Clearing that was confirmed.
    /// @param party Bonded party whose pledge returned.
    /// @param asset Asset of the clearing and of the pledge.
    /// @param amount Amount returned to free Bond.
    event BondReleased(
        bytes32 indexed clearingId, bytes32 indexed party, address indexed asset, uint128 amount
    );

    /// @notice A pledge was slashed because its clearing reached its deadline unconfirmed. (R14.6)
    /// @param clearingId Clearing that expired.
    /// @param party Bonded party slashed.
    /// @param asset Asset of the clearing and of the slash.
    /// @param amount Slashed amount in Asset base units.
    /// @param beneficiary Agent credited with the slashed value as prepaid credit.
    event SlashedForUnconfirmedClearing(
        bytes32 indexed clearingId,
        bytes32 indexed party,
        address indexed asset,
        uint128 amount,
        address beneficiary
    );

    /// @notice Stake was slashed because a Verified Settlement was superseded by a reorganisation.
    /// (R14.7)
    /// @param replayKey Replay key of the superseded Verified Settlement.
    /// @param party Bonded party slashed.
    /// @param asset Asset of the superseded Settlement and of the slash.
    /// @param amount Slashed amount in Asset base units, which is capped at the free amount.
    /// @param beneficiary Agent credited with the slashed value as prepaid credit.
    event SlashedForReorg(
        bytes32 indexed replayKey,
        bytes32 indexed party,
        address indexed asset,
        uint128 amount,
        address beneficiary
    );

    /// @notice A reorg slash could not be taken in full because free Bond ran out.
    /// @dev Emitted alongside `SlashedForReorg`, never instead of it, so the uncovered remainder is a
    /// matter of public record rather than a silent difference between the Settlement amount and the
    /// slashed amount.
    /// @param replayKey Replay key of the superseded Verified Settlement.
    /// @param party Bonded party slashed.
    /// @param asset Asset of the slash.
    /// @param requested Amount the superseded Settlement called for.
    /// @param slashed Amount free Bond actually covered.
    event ReorgSlashShortfall(
        bytes32 indexed replayKey,
        bytes32 indexed party,
        address indexed asset,
        uint128 requested,
        uint128 slashed
    );

    /// @notice Free stake was moved to the withdrawal-eligible figure. (R14.9)
    /// @param party Bonded party withdrawing.
    /// @param asset Asset withdrawn from.
    /// @param amount Amount moved, which is at most the free amount.
    event WithdrawalReleased(bytes32 indexed party, address indexed asset, uint128 amount);

    /// @notice A caller other than the wired `TabBook` attempted a clearing-lifecycle call.
    /// @param caller The rejected caller.
    error NotTabBook(address caller);

    /// @notice A caller other than the wired `SettlementVerifier` attempted to credit stake.
    /// @param caller The rejected caller.
    error NotSettlementVerifier(address caller);

    /// @notice A caller other than the wiring authority attempted to wire a collaborator.
    /// @param caller The rejected caller.
    error NotWiringAuthority(address caller);

    /// @notice A wiring target is already set, and wiring is one-shot.
    /// @param current The address already wired.
    error AlreadyWired(address current);

    /// @notice A wiring call named the zero address, which would leave the slot re-settable.
    error ZeroWiringTarget();

    /// @notice The named Asset cannot hold stake.
    /// @param asset The rejected Asset address.
    error AssetNotRegistered(address asset);

    /// @notice A zero-amount credit or pledge was requested, which would move no value.
    error ZeroAmount();

    /// @notice This clearing identifier already carries a pledge that has left the `Reserved` state.
    /// @param clearingId The clearing identifier presented.
    error ClearingAlreadyResolved(bytes32 clearingId);

    /// @notice This clearing identifier carries no pledge at all.
    /// @param clearingId The clearing identifier presented.
    error ReservationUnknown(bytes32 clearingId);

    /// @notice A slash named the zero address as the Agent to credit, which would burn the value.
    error ZeroBeneficiary();

    /// @notice This Verified Settlement has already been slashed as superseded.
    /// @param replayKey The replay key presented.
    error ReorgAlreadySlashed(bytes32 replayKey);

    /// @notice A withdrawal was requested against an Asset holding no free stake at all.
    /// @param party Bonded party that requested it.
    /// @param asset Asset requested.
    /// @param requested Amount requested.
    /// @param free Free amount in that Asset, which is zero whenever this reverts.
    error InsufficientFreeBond(bytes32 party, address asset, uint128 requested, uint128 free);

    /// @notice Credit proven stake to one party in one Asset.
    /// @param party Bonded party to credit.
    /// @param asset Asset the stake is denominated in.
    /// @param amount Amount in Asset base units.
    /// @param replayKey Verified Settlement that proved the deposit.
    function fundFromVerifiedSettlement(bytes32 party, address asset, uint128 amount, bytes32 replayKey)
        external;

    /// @notice Pledge Bond against a Provisional Clearing about to be applied.
    /// @param party Bonded party whose stake covers the clearing.
    /// @param asset Asset of the clearing.
    /// @param amount Provisionally cleared amount.
    /// @param clearingId Identifier of the clearing.
    /// @return reserved Whether free Bond in that Asset covered the amount.
    function reserve(bytes32 party, address asset, uint128 amount, bytes32 clearingId)
        external
        returns (bool reserved);

    /// @notice Return a pledge to free Bond because its clearing became a Confirmed Clearing.
    /// @param clearingId Identifier of the confirmed clearing.
    function release(bytes32 clearingId) external;

    /// @notice Slash the pledge of a Provisional Clearing that reached its deadline unconfirmed.
    /// (R14.6)
    /// @param clearingId Identifier of the expired clearing.
    /// @param beneficiary Agent to credit with the slashed value as prepaid credit.
    /// @return amount Slashed amount in Asset base units.
    function slashUnconfirmed(bytes32 clearingId, address beneficiary) external returns (uint128 amount);

    /// @notice Slash stake for a Verified Settlement superseded by a Source Chain reorganisation.
    /// (R14.7)
    /// @param replayKey Replay key of the superseded Verified Settlement.
    /// @param party Bonded party whose stake covered the superseded Settlement.
    /// @param asset Asset of the superseded Settlement.
    /// @param requested Amount of the superseded Settlement.
    /// @param beneficiary Agent to credit with the slashed value as prepaid credit.
    /// @return amount Amount actually slashed, which is `requested` capped at the free amount.
    function slashForReorg(
        bytes32 replayKey,
        bytes32 party,
        address asset,
        uint128 requested,
        address beneficiary
    ) external returns (uint128 amount);

    /// @notice Move free stake to the withdrawal-eligible figure, up to the free amount. (R14.9)
    /// @param asset Asset to withdraw from.
    /// @param amount Amount requested.
    /// @return released Amount actually moved, which is `amount` capped at the free amount.
    function requestWithdrawal(address asset, uint128 amount) external returns (uint128 released);

    /// @notice Free Bond for one party in one Asset.
    /// @param party Bonded party.
    /// @param asset Asset queried.
    /// @return free Amount available to cover a further Provisional Clearing in that Asset.
    function freeOf(bytes32 party, address asset) external view returns (uint128 free);

    /// @notice Every stored figure for one party in one Asset.
    /// @param party Bonded party.
    /// @param asset Asset queried.
    /// @return ledger The four stored figures.
    function ledgerOf(bytes32 party, address asset) external view returns (Ledger memory ledger);

    /// @notice The pledge record for one clearing.
    /// @param clearingId Identifier of the clearing.
    /// @return reservation Party, Asset, state, and amount of the pledge.
    function reservationOf(bytes32 clearingId) external view returns (Reservation memory reservation);

    /// @notice Prepaid credit an Agent has accrued from slashed Bond in one Asset. (R14.6, R14.7)
    /// @param beneficiary Agent queried.
    /// @param asset Asset queried.
    /// @return credit Accrued prepaid credit in Asset base units.
    function prepaidCreditOf(address beneficiary, address asset) external view returns (uint128 credit);

    /// @notice Whether a Verified Settlement has already been slashed as superseded.
    /// @param replayKey Replay key queried.
    /// @return slashed Whether a reorg slash has been taken for that replay key.
    function reorgSlashedFor(bytes32 replayKey) external view returns (bool slashed);

    /// @notice The party key of a bonded account.
    /// @param account The Service's `bondAccount`.
    /// @return party Key under which that account's ledgers are held.
    function partyOf(address account) external pure returns (bytes32 party);
}

/// @title Bond
/// @notice Isolated per-Asset Bond ledgers, funded by proven deposit, pledged when a Provisional
/// Clearing is applied and returned when it is confirmed.
/// @dev **Who posts the Bond, and why that is the asymmetry it looks like.** The Bond is posted by
/// the *Service*, never by the Agent. A Provisional Clearing restores an Agent's headroom before the
/// Settlement is provable, on the word of the Service's own Watcher; if the proof never arrives, the
/// Service's pledged stake is slashed and becomes prepaid credit for the Agent. The party that
/// benefits from fast headroom is therefore the party with capital at risk. That is deliberate: the
/// Agent never consented to the claim, so it must not fund it.
///
/// **There is deliberately no Slashing path for an Agent failing to settle an Open Tab, and none may
/// be added here.** Agent default is handled entirely in `TabBook.markDelinquent`, which marks the
/// tab delinquent and zeroes the Agent's Credit Limit for that Asset while touching no figure in this
/// contract. Slashing on Agent default would take value from the Service to compensate the Service
/// for credit it extended voluntarily, which punishes the wrong party. This contract slashes only for
/// claims the Service's own infrastructure asserted: a Provisional Clearing that reached its deadline
/// unconfirmed, and a Verified Settlement superseded by a Source Chain reorganisation. (R14.8, R14.11)
///
/// The absence is checkable rather than asserted, and a reviewer checks it in three steps:
///
///  1. `slashed` is written on exactly two lines in this file, one in `slashUnconfirmed` and one in
///     `slashForReorg`. Grep the field name; there is no third writer, and no other figure is ever
///     moved into it.
///  2. Each of those two entrypoints is keyed on an artefact only the Service's own infrastructure
///     can produce: a pledge this contract itself recorded when the Service's Watcher applied a
///     Provisional Clearing, and the replay key of a Verified Settlement whose block was
///     reorganised out. Neither takes an Open Tab, a Settlement Window, a delinquency flag, or an
///     elapsed-without-payment condition, so neither can be aimed at an Agent that simply did not
///     pay.
///  3. No entrypoint anywhere in this file accepts an Agent as the party whose stake moves. An Agent
///     address enters this contract in exactly one position, `beneficiary`, and value only ever
///     flows *towards* it. An Agent therefore cannot be the subject of a slash even by a caller that
///     wanted to.
///
/// Slashed value becomes prepaid credit for the affected Agent in the same Asset, tracked here in
/// `_prepaidCredit`. It is not burned, and it is not returned to an Ethereum address: sending Asset
/// value from Creditcoin to a Source Chain address would require Writability, which this system does
/// not have. That is a **limitation, recorded as such**, not a solved problem — the Agent is made
/// whole in accounting terms against the Service that took its money, and no further.
///
/// **Funding is by proven deposit, not by transfer into this contract.** The Asset lives on a Source
/// Chain, so there is nothing to transfer here. A Service funds its Bond exactly as an Agent settles:
/// it pays the Asset on the Source Chain to the registered Bond Collection Address, and the resulting
/// Verified Settlement credits the ledger through `fundFromVerifiedSettlement`. That entrypoint is
/// therefore gated on the `SettlementVerifier` rather than open, and no code path here mints stake
/// from anything other than a proof. (R14.1)
///
/// Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 18.5
contract Bond is IBond {
    // ------------------------------------------------------------------ immutables

    /// @notice The only address permitted to wire this contract's collaborators.
    /// @dev Taken as a constructor argument and never changeable. Wiring is one-shot, but one-shot
    /// alone would be a race: whoever called first would own the slot, and a hostile
    /// `settlementVerifier` can credit stake that no Source Chain payment backs, which is credit
    /// manufactured from nothing. The authority closes that window; one-shot closes it permanently.
    address public immutable WIRING_AUTHORITY;

    // ------------------------------------------------------------------ storage

    /// @notice The `TabBook` permitted to drive the clearing lifecycle here.
    /// @dev Zero until wired, and every gated call reverts while it is zero, because `msg.sender` is
    /// never the zero address.
    address public tabBook;

    /// @notice The `SettlementVerifier` permitted to credit proven deposits.
    address public settlementVerifier;

    /// @notice Bond figures, keyed by `keccak256(party, asset)`. (R14.2, R18.5)
    /// @dev **This is where per-Asset isolation is made structural rather than merely observed.**
    /// There is no mapping anywhere in this contract keyed by party alone, and no figure that spans
    /// Assets. A ledger cannot be named without naming its Asset, so no operation is able to read or
    /// write a second Asset's figures even by mistake: the key it would need does not exist in scope.
    /// Coverage checks compare a pledge against the free amount of one derived key and of nothing
    /// else.
    mapping(bytes32 => Ledger) internal _ledgers;

    /// @notice Pledges, keyed by clearing identifier.
    /// @dev The party and the Asset are stored on the pledge, so `release` (and later the slashing
    /// transitions) recover both from the clearing rather than accepting them from the caller. A
    /// caller cannot release Asset B's stake by presenting a clearing on Asset A.
    mapping(bytes32 => Reservation) internal _reservations;

    /// @notice Prepaid credit accrued by an Agent from slashed Bond, keyed by
    /// `keccak256(beneficiary, asset)`.
    /// @dev Per Asset for the same structural reason the ledgers are: the key does not exist without
    /// the Asset, so a slash in one Asset cannot credit an Agent in another. (R14.2, R18.5)
    mapping(bytes32 => uint128) internal _prepaidCredit;

    /// @notice Replay keys already slashed as superseded by a reorganisation.
    /// @dev A reorg slash spends free Bond rather than a pledge, so it has no reservation record to
    /// consume and needs its own single-use guard. Without it one reorganised Settlement could be
    /// slashed repeatedly. (R14.7)
    mapping(bytes32 => bool) internal _reorgSlashed;

    // ------------------------------------------------------------------ events

    /// @notice The `TabBook` was wired, once and for all.
    /// @param book The wired `TabBook`.
    event TabBookWired(address indexed book);

    /// @notice The `SettlementVerifier` was wired, once and for all.
    /// @param verifier The wired `SettlementVerifier`.
    event SettlementVerifierWired(address indexed verifier);

    // ------------------------------------------------------------------ construction

    /// @notice Binds the wiring authority.
    /// @dev Neither collaborator exists at deployment time: the `SettlementVerifier` is deployed
    /// after this contract because it takes this address, and the `TabBook` likewise. Both are
    /// supplied later through the one-shot setters below, which is what the deployment wiring step
    /// calls.
    /// @param wiringAuthority Address permitted to call `setTabBook` and `setSettlementVerifier`.
    constructor(address wiringAuthority) {
        if (wiringAuthority == address(0)) revert ZeroWiringTarget();
        WIRING_AUTHORITY = wiringAuthority;
    }

    // ------------------------------------------------------------------ wiring

    /// @notice Wire the `TabBook` permitted to drive the clearing lifecycle.
    /// @dev Reverts once the target is non-zero, so the collaborator set is fixed after deployment
    /// and needs no ongoing trust in the authority.
    /// @param book The `TabBook` address.
    function setTabBook(address book) external {
        _requireWiringAuthority();
        if (tabBook != address(0)) revert AlreadyWired(tabBook);
        if (book == address(0)) revert ZeroWiringTarget();
        tabBook = book;
        emit TabBookWired(book);
    }

    /// @notice Wire the `SettlementVerifier` permitted to credit proven deposits.
    /// @param verifier The `SettlementVerifier` address.
    function setSettlementVerifier(address verifier) external {
        _requireWiringAuthority();
        if (settlementVerifier != address(0)) revert AlreadyWired(settlementVerifier);
        if (verifier == address(0)) revert ZeroWiringTarget();
        settlementVerifier = verifier;
        emit SettlementVerifierWired(verifier);
    }

    // ------------------------------------------------------------------ funding

    /// @inheritdoc IBond
    /// @dev Adds to `staked` only. The checked addition is the overflow guard: `staked` is the total
    /// of every proven deposit in one Asset, and a total that wrapped would present as free Bond that
    /// no payment backs.
    function fundFromVerifiedSettlement(bytes32 party, address asset, uint128 amount, bytes32 replayKey)
        external
    {
        if (msg.sender != settlementVerifier) revert NotSettlementVerifier(msg.sender);
        if (asset == address(0)) revert AssetNotRegistered(asset);
        if (amount == 0) revert ZeroAmount();

        _ledgers[_ledgerKey(party, asset)].staked += amount;
        emit BondFunded(party, asset, amount, replayKey);
    }

    // ------------------------------------------------------------------ clearing lifecycle

    /// @inheritdoc IBond
    /// @dev **Shortfall returns `false`; it does not revert.** The caller's correct response to
    /// insufficient free Bond is to emit `ProvisionalClearingDeclined` and leave the Open Tab
    /// unchanged, not to unwind the submission that observed the Settlement. A revert would force
    /// `TabBook` to pre-check `freeOf` and only then call `reserve`, which puts the coverage rule in
    /// two contracts at once and lets the guard and the pledge disagree if either changes. Returning
    /// a boolean keeps the check and the pledge in one call over one ledger read, so the decision and
    /// the state change cannot diverge. The declined observation is not an error condition at all: it
    /// is one of the two documented outcomes of applying a Provisional Clearing. (R15.2, R15.3)
    ///
    /// A repeated `clearingId` does revert, because that is a caller fault rather than a business
    /// outcome: a clearing identifier is derived from the Source Chain transaction and the tab, so a
    /// second pledge under the same identifier would double-count one observation.
    function reserve(bytes32 party, address asset, uint128 amount, bytes32 clearingId)
        external
        returns (bool reserved)
    {
        if (msg.sender != tabBook) revert NotTabBook(msg.sender);
        if (asset == address(0)) revert AssetNotRegistered(asset);
        if (amount == 0) revert ZeroAmount();

        Reservation storage pledge = _reservations[clearingId];
        if (pledge.state != ReservationState.None) revert ClearingAlreadyResolved(clearingId);

        // Coverage is checked against the free amount of this Asset and of no other. (R18.5)
        Ledger storage ledger = _ledgers[_ledgerKey(party, asset)];
        if (_free(ledger) < amount) return false;

        ledger.reserved += amount;
        pledge.party = party;
        pledge.asset = asset;
        pledge.state = ReservationState.Reserved;
        pledge.amount = amount;

        emit BondReserved(clearingId, party, asset, amount);
        return true;
    }

    /// @inheritdoc IBond
    /// @dev Moves the pledge out of `reserved`, which returns it to `free`. It deliberately does
    /// **not** touch the `released` figure: despite the name, `released` is withdrawal-eligible value
    /// awaiting Writability and is written only by the withdrawal path. Confirming a clearing frees
    /// stake for further clearings; it does not make stake withdrawable.
    function release(bytes32 clearingId) external {
        if (msg.sender != tabBook) revert NotTabBook(msg.sender);

        Reservation storage pledge = _reservations[clearingId];
        if (pledge.state == ReservationState.None) revert ReservationUnknown(clearingId);
        if (pledge.state != ReservationState.Reserved) revert ClearingAlreadyResolved(clearingId);

        pledge.state = ReservationState.Released;

        // The Asset comes from the pledge, so this reads and writes the same ledger `reserve` wrote.
        Ledger storage ledger = _ledgers[_ledgerKey(pledge.party, pledge.asset)];
        ledger.reserved -= pledge.amount;

        emit BondReleased(clearingId, pledge.party, pledge.asset, pledge.amount);
    }

    /// @inheritdoc IBond
    /// @dev Value moves `reserved -> slashed`, so the free amount does not change: the stake was
    /// already committed to this clearing and the slash makes that commitment permanent rather than
    /// releasing it. `staked` is untouched, so the identity still balances and the ledger keeps a
    /// record of the loss instead of erasing it.
    ///
    /// The amount, the party, and the Asset all come off the pledge this contract wrote when the
    /// clearing was applied. The caller supplies the clearing identifier and the Agent to credit and
    /// nothing else, so it cannot slash an amount the clearing never covered, and cannot aim the slash
    /// at another party's ledger or another Asset.
    ///
    /// The state transition happens before any figure moves, and `Slashed` is terminal, so a second
    /// call on the same clearing reverts `ClearingAlreadyResolved` and the same expiry cannot be
    /// charged twice.
    function slashUnconfirmed(bytes32 clearingId, address beneficiary) external returns (uint128 amount) {
        if (msg.sender != tabBook) revert NotTabBook(msg.sender);
        if (beneficiary == address(0)) revert ZeroBeneficiary();

        Reservation storage pledge = _reservations[clearingId];
        if (pledge.state == ReservationState.None) revert ReservationUnknown(clearingId);
        if (pledge.state != ReservationState.Reserved) revert ClearingAlreadyResolved(clearingId);

        pledge.state = ReservationState.Slashed;
        amount = pledge.amount;

        Ledger storage ledger = _ledgers[_ledgerKey(pledge.party, pledge.asset)];
        ledger.reserved -= amount;
        ledger.slashed += amount;

        // The Agent is made whole in the Asset it paid in, because it cannot be made whole on the
        // Source Chain without Writability.
        _prepaidCredit[_creditKey(beneficiary, pledge.asset)] += amount;

        emit SlashedForUnconfirmedClearing(clearingId, pledge.party, pledge.asset, amount, beneficiary);
    }

    /// @inheritdoc IBond
    /// @dev **Why this one takes its figures from the caller.** A superseded Settlement was
    /// *confirmed*: its pledge was returned to free Bond by `release` and its reservation record is
    /// terminal, so there is nothing left here to read the amount from. The party, Asset, and amount
    /// therefore arrive from the `TabBook` that holds the Verified Settlement entry, and `replayKey`
    /// is the single-use guard in place of the consumed reservation.
    ///
    /// **Why it caps rather than reverts.** The slash comes out of free Bond, and free Bond can be
    /// smaller than the superseded amount — the Service may have pledged the rest against other live
    /// clearings, or been slashed already. Reverting would take `TabBook.reportReorg` down with it,
    /// leaving a Settlement that provably no longer exists still crediting a tab, which is a worse
    /// outcome than an under-collateralised slash. So it takes what is there, emits
    /// `ReorgSlashShortfall` for the remainder, and lets the reorg be recorded. The checked
    /// subtraction in `_free` guarantees the cap keeps the identity intact.
    function slashForReorg(
        bytes32 replayKey,
        bytes32 party,
        address asset,
        uint128 requested,
        address beneficiary
    ) external returns (uint128 amount) {
        if (msg.sender != tabBook) revert NotTabBook(msg.sender);
        if (asset == address(0)) revert AssetNotRegistered(asset);
        if (requested == 0) revert ZeroAmount();
        if (beneficiary == address(0)) revert ZeroBeneficiary();
        if (_reorgSlashed[replayKey]) revert ReorgAlreadySlashed(replayKey);

        _reorgSlashed[replayKey] = true;

        Ledger storage ledger = _ledgers[_ledgerKey(party, asset)];
        uint128 available = _free(ledger);
        amount = requested > available ? available : requested;

        ledger.slashed += amount;
        _prepaidCredit[_creditKey(beneficiary, asset)] += amount;

        if (amount < requested) emit ReorgSlashShortfall(replayKey, party, asset, requested, amount);
        emit SlashedForReorg(replayKey, party, asset, amount, beneficiary);
    }

    // ------------------------------------------------------------------ withdrawal

    /// @inheritdoc IBond
    /// @dev **"At most the free amount" is read as a cap, not as a precondition** (R14.9). A request
    /// wider than free Bond releases the free amount and reports it in the return value and in the
    /// event; it does not revert. Reverting would make the correct request unknowable, because free
    /// Bond moves whenever a clearing is applied, confirmed, or slashed: a bonded party would have to
    /// read `freeOf` and land its withdrawal in the same block to avoid a revert, and would lose the
    /// race to its own Watcher. Capping makes the request order-insensitive — the worst outcome of
    /// asking for too much is receiving what is available.
    ///
    /// The one case that does revert is a request against an Asset with **zero** free stake, which
    /// would move no value at all and emit an event saying so. That is the same reasoning behind
    /// `ZeroAmount` on the funding path: a call that cannot move value is a caller fault, not an
    /// outcome.
    ///
    /// **What "released" means here, and what it does not.** The figure is withdrawal-eligible value,
    /// nothing more. The Asset lives on a Source Chain, so paying it out needs Writability, which is
    /// out of scope; this contract can only stop counting the stake as cover and record the claim.
    /// The stake is authenticated by `msg.sender` alone, so no authority and no collaborator can move
    /// a bonded party's stake towards withdrawal on its behalf.
    function requestWithdrawal(address asset, uint128 amount) external returns (uint128 released) {
        if (asset == address(0)) revert AssetNotRegistered(asset);
        if (amount == 0) revert ZeroAmount();

        bytes32 party = _partyOf(msg.sender);
        Ledger storage ledger = _ledgers[_ledgerKey(party, asset)];
        uint128 available = _free(ledger);
        if (available == 0) revert InsufficientFreeBond(party, asset, amount, 0);

        released = amount > available ? available : amount;
        ledger.released += released;

        emit WithdrawalReleased(party, asset, released);
    }

    // ------------------------------------------------------------------ reads

    /// @inheritdoc IBond
    /// @dev **The consistency identity, and why `free` is derived.**
    ///
    ///     free = staked - reserved - slashed - released
    ///     staked == reserved + slashed + released + free        (equivalently)
    ///
    /// Four figures are stored; `free` is computed on every read. Storing it as a fifth would create
    /// two figures that must agree, and every mutating path would have to update both in step for
    /// the pair to stay truthful. Deriving it makes the identity hold by construction: a pledge moves
    /// value from the derived side to `reserved` in one write, a release moves it back in one write,
    /// and a deposit raises `staked` and the derived side together.
    ///
    /// The subtraction is also a canary. `reserved + slashed + released <= staked` is an invariant of
    /// every path here, so if some future transition ever broke it, this checked subtraction reverts
    /// rather than reporting a wrapped free amount that would let a clearing be covered by stake that
    /// does not exist.
    function freeOf(bytes32 party, address asset) external view returns (uint128 free) {
        return _free(_ledgers[_ledgerKey(party, asset)]);
    }

    /// @inheritdoc IBond
    function ledgerOf(bytes32 party, address asset) external view returns (Ledger memory ledger) {
        return _ledgers[_ledgerKey(party, asset)];
    }

    /// @inheritdoc IBond
    function reservationOf(bytes32 clearingId) external view returns (Reservation memory reservation) {
        return _reservations[clearingId];
    }

    /// @inheritdoc IBond
    function prepaidCreditOf(address beneficiary, address asset) external view returns (uint128 credit) {
        return _prepaidCredit[_creditKey(beneficiary, asset)];
    }

    /// @inheritdoc IBond
    function reorgSlashedFor(bytes32 replayKey) external view returns (bool slashed) {
        return _reorgSlashed[replayKey];
    }

    /// @inheritdoc IBond
    /// @dev Exposed so that whoever holds a Service's `bondAccount` address can derive the key its
    /// ledgers sit under without reimplementing the embedding, and so that `requestWithdrawal` and
    /// every other caller agree on it by construction.
    function partyOf(address account) external pure returns (bytes32 party) {
        return _partyOf(account);
    }

    // ------------------------------------------------------------------ internals

    /// @notice The one and only way a ledger is addressed.
    /// @dev Every mutating and reading path routes through this, so the Asset is part of every
    /// storage address by construction. (R14.2)
    /// @param party Bonded party key.
    /// @param asset Asset the ledger is denominated in.
    /// @return key Storage key of that party's ledger in that Asset.
    function _ledgerKey(bytes32 party, address asset) internal pure returns (bytes32 key) {
        return keccak256(abi.encode(party, asset));
    }

    /// @notice The one and only way an Agent's prepaid credit is addressed.
    /// @dev Same discipline as `_ledgerKey`: the Asset is part of the key, so slashed value credited
    /// in one Asset is unreachable from another. (R14.2)
    /// @param beneficiary Agent credited.
    /// @param asset Asset the credit is denominated in.
    /// @return key Storage key of that Agent's prepaid credit in that Asset.
    function _creditKey(address beneficiary, address asset) internal pure returns (bytes32 key) {
        return keccak256(abi.encode(beneficiary, asset));
    }

    /// @notice Embeds a bonded account address in the party key space.
    /// @dev An injective widening rather than a hash, so the party key of an account is derivable in
    /// both directions by inspection, which is what makes a withdrawal authenticated by `msg.sender`
    /// verifiably the same party the Service registered as its `bondAccount`.
    /// @param account The Service's `bondAccount`.
    /// @return party Key under which that account's ledgers are held.
    function _partyOf(address account) internal pure returns (bytes32 party) {
        return bytes32(uint256(uint160(account)));
    }

    /// @notice Derives the free amount from the four stored figures.
    /// @param ledger The ledger to read.
    /// @return free Amount available to cover a further Provisional Clearing in that Asset.
    function _free(Ledger storage ledger) internal view returns (uint128 free) {
        return ledger.staked - ledger.reserved - ledger.slashed - ledger.released;
    }

    /// @notice Rejects any caller other than the wiring authority.
    function _requireWiringAuthority() internal view {
        if (msg.sender != WIRING_AUTHORITY) revert NotWiringAuthority(msg.sender);
    }
}
