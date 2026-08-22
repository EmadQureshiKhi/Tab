// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title AgentRegistry
/// @notice Binds an Agent's Source Chain payer addresses to its Creditcoin identity, and does so by
/// payment rather than by signature. The whole lifecycle lives here: issuing a binding nonce,
/// deriving the exact Settlement amount that carries the nonce, reclaiming a nonce whose 24-hour
/// window elapsed without a matching Verified Settlement, and finalising a binding when the
/// `SettlementVerifier` presents a Verified Settlement whose payer and amount match a live request.
/// @dev Why payment and not a signature. An Agent's identity is a Creditcoin account; its payer
/// address is a Source Chain account. Creditcoin cannot check a signature made by a Source Chain key
/// against Source Chain state, and there is no message-passing path from the Source Chain into this
/// contract. What Creditcoin *can* establish, through the BlockProver Precompile, is that a specific
/// Source Chain transaction was included in an attested block and what its logs said. So the proof
/// of control is the payment itself: the Agent is told to settle one exact amount whose low-order
/// digits carry a nonce issued to it, and a Verified Settlement of that exact amount from that exact
/// address proves whoever holds the address cooperated with whoever holds the nonce.
///
/// That makes the amount encoding a security primitive rather than a convenience, and the four
/// properties it has to carry are stated at the declarations that carry them:
///
///  1. Four low-order digits, justified against the Asset's 6 decimals. See {NONCE_MIN}.
///  2. No two open requests on one chainKey may share a required amount, whichever Agents opened
///     them. See {_amountClaim}.
///  3. The nonce is recoverable from the amount alone, as a pure function. See {nonceFromAmount}.
///  4. A pending request belongs to one Agent and never to an address, so any number of Agents may
///     have a request open against the same address at once. See {_pending}.
///
/// Property 4 is what keeps a request from being a claim on somebody else's address. A request is
/// open to any caller — it has to be, since the caller is asserting control it has not yet proven —
/// so if the ledger held one record per `(chainKey, ethAddress)` pair, the first caller to name an
/// address would hold it against everyone else for the whole window. Keying on
/// `(chainKey, ethAddress, agent)` removes that: naming an address costs a caller one nonce out of a
/// shared space and denies nothing to the address's real controller, who can open its own request in
/// the very next block and receive a different amount.
///
/// What remains, and is inherent to proof-by-payment rather than a consequence of the key, is that
/// the Source Chain cannot tell which of the amounts open against an address a payment was meant for.
/// A Settlement finalises the one request whose amount it equals, so an address whose controller pays
/// the exact amount of a request that controller did not open binds to the Agent that opened it. The
/// amount is a specific value inside a 9000-value band below one tenth of an Asset unit, and paying
/// it is a deliberate act by the address's own keys; the defence is that the controller can always
/// open its own request first and pay the amount it was itself given.
///
/// The confirmed half is {resolveOrBind}, and it answers one question for the `SettlementVerifier`
/// on every Verified Settlement: which Agent does this payer belong to. It returns the bound Agent
/// when one exists, finalises a live request when the payer and the amount both match it, and
/// otherwise returns the zero address, which the verifier turns into its own `UnboundPayer`. A
/// return rather than a revert is deliberate: the registry cannot tell an unbound payer from a payer
/// that will never be bound, and naming the failure is the verifier's job, not this contract's.
/// (R8.4)
///
/// Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 8.4
contract AgentRegistry {
    // ------------------------------------------------------------------ constants

    /// @notice How long an issued nonce stays valid for exactly one binding. (R10.5, R10.6)
    /// @dev 24 hours is long enough that an Agent can fund an address, submit a Settlement, and wait
    /// for the Source Chain block holding it to be attested, and short enough that an abandoned
    /// attempt returns its nonce to the space the same day.
    uint64 public constant BINDING_TTL = 24 hours;

    /// @notice Fixed high-order part of every required Settlement amount, in Asset base units.
    /// @dev 100_000 base units of a 6-decimal Asset is 0.10 of one unit of that Asset. It is a real
    /// payment to a real Collection Address, so it has to be small enough to be a rounding error to
    /// the Agent and large enough that it is not dust the Asset or a Service would reject. The value
    /// is a multiple of 10_000, which is what makes the nonce the literal low-order four digits of
    /// the total rather than something mixed into them. (R10.1)
    uint256 public constant BINDING_BASE_UNITS = 100_000;

    /// @notice Smallest nonce this contract issues.
    /// @dev **This is the digit-count decision.** The nonce occupies exactly four decimal digits, so
    /// the required amount is `0.10` plus a four-digit tail: `0.101000` through `0.109999` of one
    /// Asset unit. Against the Asset's 6 decimals, those four digits are the tail below one hundredth
    /// of an Asset unit, which is where ordinary payments carry nothing but zeros.
    ///
    /// Both bounds of the digit count are load-bearing:
    ///
    /// - **Fewer digits is unsafe.** Three digits would leave a 900-value space per chainKey, small
    ///   enough that an adversary could hold every free nonce open for 24 hours at a cost of 900
    ///   requests and stall all binding. It would also push the encoded value up into the hundredths
    ///   place, where round payments live.
    /// - **More digits is not free.** Six digits would put the nonce into the whole-unit part of the
    ///   amount and make the binding payment cost a whole Asset unit or more, which turns a proof of
    ///   control into a real fee.
    ///
    /// Starting at 1000 rather than 0 is the other half of the same decision: it forces the
    /// thousandths digit of the amount to be non-zero, so no required amount is ever a round number
    /// like `0.100000` or `0.105000`, and a Settlement that merely *looks* round can never sit inside
    /// the encoding window.
    uint16 public constant NONCE_MIN = 1000;

    /// @notice Largest nonce this contract issues, and the other end of the four-digit window.
    uint16 public constant NONCE_MAX = 9999;

    /// @notice Number of distinct nonces, and therefore of concurrently open requests, per chainKey.
    /// @dev 9000. The space is per chainKey because the required amount only ever has to be unique
    /// among the requests a single Source Chain could satisfy: a Verified Settlement carries the
    /// chainKey the proof established, not one the submitter chose, so an amount open on one
    /// chainKey cannot be aimed at a request open on another.
    ///
    /// The space is shared by every Agent on that chainKey, and it always was: the ceiling counts
    /// open requests, and a single Creditcoin account could already reach it by naming 9000 addresses,
    /// none of which it has to control. Keying the ledger per Agent changes how those 9000 slots may
    /// be arranged — many Agents against one address is now spendable where it used to revert — but
    /// not how many calls it takes to hold them all, which is one call per slot either way. So the
    /// exhaustion cost is unchanged, and the response to {NonceSpaceExhausted} is unchanged with it:
    /// every held slot returns to the space within {BINDING_TTL}, and {expireBinding} returns elapsed
    /// ones sooner for the price of the gas.
    uint256 public constant NONCE_SPACE = uint256(NONCE_MAX) - uint256(NONCE_MIN) + 1;

    /// @notice The power of ten the four encoded digits sit below.
    /// @dev Since {BINDING_BASE_UNITS} is a multiple of this value, `requiredAmount % NONCE_MODULUS`
    /// is the nonce exactly. {nonceFromAmount} recovers by subtraction instead, because subtraction
    /// also checks the high-order digits rather than discarding them.
    uint256 public constant NONCE_MODULUS = 10_000;

    /// @notice How many Source Chain addresses one Agent may bind per chainKey. (R10.8)
    /// @dev Eight is a ceiling on a per-Agent list that {boundAddresses} returns in full and that is
    /// length-checked on every binding, so it exists to keep both bounded. It is generous against the
    /// shape of the thing being counted: an Agent needs one payer address per Source Chain it settles
    /// from, plus room to rotate keys and to run a hot account beside a cold one, and eight covers
    /// that several times over. It is per chainKey rather than global, so settling from a second
    /// Source Chain never costs an Agent slots on the first.
    ///
    /// There is no unbinding, so the count only ever rises. That is deliberate: a binding is the
    /// statement that payments from this address are this Agent's payments, and it has to keep being
    /// true afterwards or the Verified Settlement history it authenticated stops meaning anything. An
    /// Agent needing a ninth address binds it under a fresh Creditcoin identity, which costs nothing
    /// to create and begins its own credit history.
    uint256 public constant MAX_ADDRESSES_PER_CHAIN = 8;

    // ------------------------------------------------------------------ types

    /// @notice One confirmed binding: the record that an Agent proved control of a Source Chain
    /// address, and the pointer to the payment that proved it.
    /// @dev Written once per address per chainKey and never rewritten, which is what makes
    /// `provingReplayKey` worth a storage slot. That key names the
    /// `(chainKey, blockHeight, txIndex, logIndex)` tuple of the Settlement that proved the binding,
    /// so a reader who trusts none of this can go to the Source Chain and check the payment. (R10.7)
    struct Binding {
        /// @dev The Creditcoin account the address is bound to, which is the Agent identity. A zero
        /// value is how an unbound address reads, which is what {agentOf} returns for one.
        address agent;
        /// @dev Attested-chain identifier the address lives on. Keyed on as well as stored, so a
        /// record read on its own still carries the chain it belongs to.
        uint64 chainKey;
        /// @dev Creditcoin block timestamp at which the binding was finalised.
        uint64 boundAt;
        /// @dev Replay key of the Verified Settlement that proved this binding.
        bytes32 provingReplayKey;
    }

    /// @notice One open binding request: an Agent's claim on one Source Chain address, priced.
    /// @dev Field order follows the design's declared record rather than tightest packing, which
    /// costs one extra storage slot. A record is written once per binding attempt and an Agent binds
    /// a handful of addresses in its lifetime, so the slot is worth less than the record reading the
    /// same way here as it does in the design.
    struct PendingBinding {
        /// @dev The Creditcoin account that asked for the binding. This is the Agent identity, and
        /// with `chainKey` and `ethAddress` it is the key the record is stored under.
        address agent;
        /// @dev Attested-chain identifier the address lives on.
        uint64 chainKey;
        /// @dev The Source Chain address the Agent claims control of.
        address ethAddress;
        /// @dev Exact Settlement amount, in Asset base units, whose low four digits carry the nonce.
        uint256 requiredAmount;
        /// @dev The issued nonce, in `[NONCE_MIN, NONCE_MAX]`.
        uint16 nonce;
        /// @dev Creditcoin block timestamp of issuance. The window runs from here. (R10.5)
        uint64 issuedAt;
        /// @dev True while the request holds its nonce. Cleared when the nonce returns to the space.
        bool open;
    }

    /// @notice Which open request, if any, holds a given required amount on a given chainKey.
    /// @dev Two addresses, so two slots. Packing was considered and rejected: the pair is exactly the
    /// remainder of the pending key once the chainKey is known, and any narrower encoding — a hash, a
    /// truncation — would give the resolver something it then has to widen again before it can read a
    /// record. A claim reads as unheld when `ethAddress` is the zero address, which is sound because
    /// {requestBinding} refuses the zero address outright, so no live claim can carry one.
    struct AmountClaim {
        /// @dev The Source Chain address the holding request claims.
        address ethAddress;
        /// @dev The Agent that opened the holding request.
        address agent;
    }

    // ------------------------------------------------------------------ immutables

    /// @notice The only address permitted to wire this contract's `SettlementVerifier`.
    /// @dev Taken at construction and never changeable. Wiring is one-shot, and one-shot alone would
    /// be a race rather than a guarantee: whoever called first would own the slot, and a hostile
    /// `settlementVerifier` can hand this contract a payer and an amount that no Source Chain payment
    /// backs, which binds an address to an Agent that never proved control of it. The authority closes
    /// that window at deployment; the one-shot check below closes it permanently.
    address public immutable WIRING_AUTHORITY;

    // ------------------------------------------------------------------ storage

    /// @notice The `SettlementVerifier` permitted to present Verified Settlements. (R10.2)
    /// @dev Zero until wired, which makes {resolveOrBind} unreachable until the deployment wiring step
    /// runs: `msg.sender` is never the zero address, so an unwired registry rejects every caller
    /// rather than accepting anybody. That is the safe direction to fail in, because the alternative
    /// is a window in which any account can mint bindings.
    address public settlementVerifier;

    /// @notice Confirmed bindings, keyed by chainKey, then Source Chain address. (R10.3)
    /// @dev **One record per `(chainKey, ethAddress)` pair is the one-Agent-per-address rule.** The
    /// shape enforces it rather than a check: there is nowhere for a second Agent to be written. The
    /// chainKey comes first because the same address on two Source Chains is two independent
    /// bindings — a key that controls an address on one chain need not control the identically
    /// numbered address on another, and even where it does, a testnet payment must never authenticate
    /// a mainnet identity.
    mapping(uint64 => mapping(address => Binding)) internal _bindings;

    /// @notice The addresses each Agent has bound, keyed by Agent, then chainKey.
    /// @dev The reverse of {_bindings}, and stored rather than derived because both readers need it
    /// whole: {boundAddresses} answers "which addresses may pay for me" for a client, and the ceiling
    /// check reads its length on every binding. Recomputing either from events would put a scan in
    /// front of a state transition. Append-only, in binding order, and never longer than
    /// {MAX_ADDRESSES_PER_CHAIN}, so the full read is bounded at eight entries.
    mapping(address => mapping(uint64 => address[])) internal _reverse;

    /// @notice Open binding requests, keyed by chainKey, then claimed address, then claiming Agent.
    /// @dev **The Agent is part of the key, not merely a field of the record.** A request is open to
    /// any caller, so a ledger with one record per `(chainKey, ethAddress)` pair would let the first
    /// caller to name an address hold it against every other Agent until the window closed, including
    /// against the party that actually controls it. With the Agent in the key there is nothing to
    /// hold: each Agent gets its own record and its own amount, and naming an address costs the
    /// caller a nonce and costs everyone else nothing.
    ///
    /// One record per triple, not one per call. A second live request from the same Agent against the
    /// same address on the same chainKey would burn a second nonce to prove a binding that a single
    /// Settlement already proves, so {requestBinding} refuses it with {BindingAlreadyPending}.
    ///
    /// **Still shaped for the resolver.** The resolver receives a Verified Settlement and knows its
    /// payer from `topics[1]`, its chainKey from the proof, and its amount from the log, so it reads
    /// {_amountClaim} for the amount to learn which Agent's request that amount belongs to and then
    /// this mapping once for the record itself. Two mapping reads, no iteration, and no dependence on
    /// how many requests happen to be open against the payer.
    mapping(uint64 => mapping(address => mapping(address => PendingBinding))) internal _pending;

    /// @notice Which request, if any, currently holds a given required amount on a given chainKey.
    /// @dev **This is the collision guarantee, and it is a guarantee rather than a probability.**
    /// The nonce-to-amount map is a bijection on the four-digit window, so a required amount is
    /// unique on a chainKey exactly when its nonce is. Allocation writes this slot and only ever
    /// writes it while it reads as unheld, so two open requests on one chainKey cannot share an
    /// amount no matter which Agents opened them, and one payment can therefore never satisfy two
    /// requests. When every slot in the window is held, allocation reverts {NonceSpaceExhausted}
    /// rather than reissuing a live nonce.
    ///
    /// It carries the Agent alongside the address because the pending key does. An amount identifies
    /// exactly one open request, and identifying that request now means naming the triple it is
    /// stored under; an amount-to-address index alone would leave the resolver knowing an address had
    /// a matching amount without knowing whose request to finalise, and the only way back would be a
    /// scan. This is also the index the resolver's off-chain half needs: given an amount seen on the
    /// Source Chain, one read yields the address and the Agent whose request it belongs to, which is
    /// what lets a client tell a matching Settlement from an unrelated one before paying for proof.
    mapping(uint64 => mapping(uint256 => AmountClaim)) internal _amountClaim;

    /// @notice Where the next allocation starts probing, per chainKey.
    /// @dev A rotating cursor rather than a fresh random draw. Nonce unpredictability buys nothing
    /// here: the nonce is not a secret and knowing the next one grants no ability to satisfy it,
    /// because satisfying it means paying from the address being claimed, which is the very thing
    /// under proof. What the cursor buys is that allocation costs one storage read in the common
    /// case, so the last free nonce in a nearly full space is no more expensive to find than the
    /// first. A zero here means the cursor has never moved, which is read as {NONCE_MIN}.
    mapping(uint64 => uint16) internal _nonceCursor;

    /// @notice How many nonces are currently held open on each chainKey.
    /// @dev Kept so exhaustion is answered by one read instead of by a 9000-slot scan that would
    /// itself be near the block gas limit. Incremented on allocation, decremented whenever a nonce
    /// returns to the space.
    mapping(uint64 => uint256) internal _openNonces;

    // ------------------------------------------------------------------ events

    /// @notice A nonce was issued and an exact Settlement amount is now expected from `ethAddress`.
    /// @param agent The Creditcoin account that requested the binding.
    /// @param chainKey Attested-chain identifier the address lives on.
    /// @param ethAddress The Source Chain address whose control is to be proven.
    /// @param nonce The issued nonce.
    /// @param requiredAmount Exact Settlement amount, in Asset base units, that proves the binding.
    /// @param expiresAt Creditcoin timestamp at which the nonce stops being valid. (R10.5)
    event BindingRequested(
        address indexed agent,
        uint64 chainKey,
        address ethAddress,
        uint16 nonce,
        uint256 requiredAmount,
        uint64 expiresAt
    );

    /// @notice An address is now bound to an Agent, and here is the payment that proved it. (R10.7)
    /// @dev Both the Agent and the address are indexed, because the two questions asked of this log
    /// are "which addresses does this Agent pay from" and "whose address is this", and neither should
    /// need a full-history scan. `provingReplayKey` is carried in the data so that a stranger reading
    /// only this event can locate the Settlement on the Source Chain and check the binding without
    /// asking this contract, or anyone, to be believed.
    /// @param agent The Creditcoin account the address is now bound to.
    /// @param chainKey Attested-chain identifier the address lives on.
    /// @param ethAddress The newly bound Source Chain address.
    /// @param provingReplayKey Replay key of the Verified Settlement that proved the binding.
    event AddressBound(
        address indexed agent, uint64 chainKey, address indexed ethAddress, bytes32 provingReplayKey
    );

    /// @notice The `SettlementVerifier` was wired, once and for all.
    /// @param verifier The wired `SettlementVerifier`.
    event SettlementVerifierWired(address indexed verifier);

    /// @notice A nonce reached 24 hours without a matching Verified Settlement and was reclaimed.
    /// @dev Emitted both by {expireBinding} and by {requestBinding} when it clears the caller's own
    /// elapsed record out of the way, so the reclamation of a nonce is observable from one event
    /// either way. (R10.6)
    /// @param agent The Creditcoin account whose request elapsed.
    /// @param chainKey Attested-chain identifier of the elapsed request.
    /// @param ethAddress The Source Chain address the elapsed request claimed.
    /// @param nonce The nonce returned to the space.
    event BindingExpired(address indexed agent, uint64 chainKey, address ethAddress, uint16 nonce);

    // ------------------------------------------------------------------ errors

    /// @notice Every nonce in the four-digit window is held open on this chainKey.
    /// @dev Transient by construction: each held nonce returns to the space within
    /// {BINDING_TTL}, so the correct response is to retry with backoff rather than to give up.
    error NonceSpaceExhausted();

    /// @notice A binding was presented after its nonce's 24-hour window closed. (R10.6)
    /// @dev Declared here because the binding window is this contract's rule, and raised by the
    /// resolver, which is the only caller positioned to present a Verified Settlement against a
    /// pending request. Its mirror image, {BindingWindowActive}, guards the crank below.
    /// @param issuedAt Creditcoin timestamp at which the nonce was issued.
    /// @param nowTs Creditcoin timestamp at which the late binding was presented.
    error BindingWindowElapsed(uint64 issuedAt, uint64 nowTs);

    // There is deliberately no error here for a Settlement whose amount matches no open request.
    //
    // An earlier draft declared `NonceMismatch(expectedAmount, observedAmount)` for that case, and it
    // is not expressible. A Verified Settlement carries three usable facts — the payer from
    // `topics[1]`, the chainKey the proof established, and the amount — and under the three-part
    // pending key any number of Agents may hold live requests against one payer, each with its own
    // required amount. A wrong amount therefore identifies no request and has no single
    // `expectedAmount` to name; with three requests open, reporting one of the three would mislead.
    //
    // So {resolveOrBind} leaves every open request untouched and returns the zero address, and the
    // `SettlementVerifier` raises `UnboundPayer` — which is the component that actually knows the
    // submission is being rejected. The binding is refused, no record moves, and no nonce is
    // consumed, so Requirement 10.4's substance holds; only the name and the location of the
    // rejection differ, and R10.4 is corrected to say so. Declaring an error nothing can raise would
    // be a false affordance in a contract that gates identity.

    /// @notice This address is already bound to an Agent on this chainKey. (R10.3)
    /// @dev Raised by {requestBinding}, which is where the one-Agent-per-address rule can be enforced
    /// before anyone spends a nonce or a payment on a binding that could never be finalised. It is
    /// raised for the bound Agent's own repeat request too: the binding exists, so a second proof of
    /// the same fact buys nothing. {resolveOrBind} cannot raise it, because a Settlement from a bound
    /// address is the ordinary case and returning the bound Agent is the whole point of the call.
    /// @param chainKey Attested-chain identifier of the existing binding.
    /// @param ethAddress The already-bound Source Chain address.
    /// @param agent The Agent that address is bound to.
    error AddressAlreadyBound(uint64 chainKey, address ethAddress, address agent);

    /// @notice This Agent already holds the maximum number of bound addresses on this chainKey.
    /// @dev Raised from both ends of the lifecycle: {requestBinding} refuses to issue a nonce that
    /// could never be finalised, and {resolveOrBind} refuses the binding itself, since an Agent can
    /// open eight requests before binding any of them and only the second check sees the ninth
    /// finalisation coming. (R10.8)
    /// @param agent The Agent at its ceiling.
    /// @param chainKey Attested-chain identifier the ceiling applies to.
    /// @param limit The ceiling, being {MAX_ADDRESSES_PER_CHAIN}.
    error TooManyBoundAddresses(address agent, uint64 chainKey, uint256 limit);

    /// @notice A caller other than the wired `SettlementVerifier` attempted to resolve or bind.
    /// @param caller The rejected caller.
    error NotSettlementVerifier(address caller);

    /// @notice A caller other than the wiring authority attempted to wire the `SettlementVerifier`.
    /// @param caller The rejected caller.
    error NotWiringAuthority(address caller);

    /// @notice The wiring target is already set, and wiring is one-shot.
    /// @param current The address already wired.
    error AlreadyWired(address current);

    /// @notice A wiring call named the zero address, which would leave the slot re-settable.
    error ZeroWiringTarget();

    /// @notice This Agent already has a live request open against this address. (R10.5)
    /// @dev Scoped to the caller, and only to the caller. A live nonce is valid for exactly one
    /// binding, and the one Settlement the Agent is about to make already proves that binding, so a
    /// second concurrent nonce for the same triple would take a slot out of the shared space to prove
    /// nothing further. Other Agents are unaffected: their requests against this same address are
    /// separate records with separate amounts, and neither this error nor its window can be raised
    /// against them.
    /// @param agent The Agent holding the open request, which is always the caller.
    /// @param chainKey Attested-chain identifier of the open request.
    /// @param ethAddress The claimed Source Chain address.
    /// @param nonce Nonce the open request holds.
    /// @param expiresAt Creditcoin timestamp at which that nonce may be reclaimed.
    error BindingAlreadyPending(
        address agent, uint64 chainKey, address ethAddress, uint16 nonce, uint64 expiresAt
    );

    /// @notice The crank was called on a nonce whose 24-hour window has not closed yet.
    /// @dev The mirror of {BindingWindowElapsed}: that one rejects a binding presented too late,
    /// this one rejects a reclamation attempted too early. Both are named after the state they
    /// found, so a reader of a failed call knows which side of the boundary it landed on.
    /// @param issuedAt Creditcoin timestamp at which the nonce was issued.
    /// @param expiresAt Creditcoin timestamp from which the nonce may be reclaimed.
    /// @param nowTs Creditcoin timestamp of the attempted reclamation.
    error BindingWindowActive(uint64 issuedAt, uint64 expiresAt, uint64 nowTs);

    /// @notice There is no open request under this triple to reclaim.
    /// @dev The Agent is part of what makes a request findable, so a wrong Agent and an absent
    /// request are the same answer here: nothing is stored under the triple that was named.
    /// @param chainKey Attested-chain identifier supplied.
    /// @param ethAddress Source Chain address supplied.
    /// @param agent Agent supplied.
    error NoOpenBinding(uint64 chainKey, address ethAddress, address agent);

    /// @notice A nonce outside the four-digit window was presented to the amount encoder.
    /// @param nonce The rejected nonce.
    error NonceOutOfRange(uint16 nonce);

    /// @notice The zero address cannot be bound, since no key controls it.
    error ZeroEthAddress();

    // ------------------------------------------------------------------ construction

    /// @notice Binds the wiring authority.
    /// @dev The `SettlementVerifier` cannot be a constructor argument, because it takes this contract's
    /// address in its own constructor and so is deployed after it. The one-shot setter below is what
    /// the deployment wiring step calls, and this argument is what stops anybody else from calling it
    /// first.
    /// @param wiringAuthority Address permitted to call {setSettlementVerifier}, once.
    constructor(address wiringAuthority) {
        if (wiringAuthority == address(0)) revert ZeroWiringTarget();
        WIRING_AUTHORITY = wiringAuthority;
    }

    // ------------------------------------------------------------------ wiring

    /// @notice Wire the `SettlementVerifier` permitted to present Verified Settlements.
    /// @dev Irreversible by construction, which is the point: this is the one caller that can turn a
    /// pending request into a binding, so a re-settable slot would mean the ability to bind addresses
    /// rested on the continuing good behaviour of the authority rather than on one transaction that
    /// anybody can go and read. Reverts once the slot is non-zero, and refuses the zero address so the
    /// slot cannot be emptied back into a re-settable state.
    /// @param verifier The `SettlementVerifier` address.
    function setSettlementVerifier(address verifier) external {
        if (msg.sender != WIRING_AUTHORITY) revert NotWiringAuthority(msg.sender);
        if (settlementVerifier != address(0)) revert AlreadyWired(settlementVerifier);
        if (verifier == address(0)) revert ZeroWiringTarget();
        settlementVerifier = verifier;
        emit SettlementVerifierWired(verifier);
    }

    // ------------------------------------------------------------------ requests

    /// @notice Ask for a binding of `ethAddress` on `chainKey` to the calling Agent.
    /// @dev Open to any Creditcoin account, because the request grants nothing on its own and takes
    /// nothing from anyone else. What it hands back is an instruction to the caller: settle exactly
    /// `requiredAmount` from `ethAddress` before `expiresAt`. Only the holder of `ethAddress` can
    /// carry that out, which is what makes the eventual Verified Settlement a proof of control rather
    /// than an assertion of it. Every Agent that asks gets its own record and its own amount, so a
    /// caller naming an address it does not control leaves the real controller free to ask for its
    /// own. (R10.1)
    ///
    /// The caller's own elapsed record for this triple is cleared on the way past, which is where the
    /// pair-keyed ledger used to reclaim: it is the one elapsed record this call can reach in constant
    /// time, and reclaiming it here means an Agent retrying an abandoned attempt never has to wait on
    /// the crank to get its nonce back. Records other Agents abandoned against the same address are
    /// not in this call's way and are not touched; they return to the space at {BINDING_TTL} through
    /// {expireBinding}, which anyone may call.
    /// @param chainKey Attested-chain identifier the address lives on. Not gated here: an unsupported
    /// chainKey gets its own separate nonce space and can never be satisfied, since the resolver only
    /// ever presents Settlements from chains the verifier accepts.
    /// @param ethAddress The Source Chain address to prove control of.
    /// @return nonce The issued nonce, in `[NONCE_MIN, NONCE_MAX]`.
    /// @return requiredAmount Exact Settlement amount, in Asset base units, encoding that nonce.
    /// @return expiresAt Creditcoin timestamp at which the nonce stops being valid, 24 hours out.
    function requestBinding(uint64 chainKey, address ethAddress)
        external
        returns (uint16 nonce, uint256 requiredAmount, uint64 expiresAt)
    {
        if (ethAddress == address(0)) revert ZeroEthAddress();

        // Two refusals before a nonce is spent, both for requests that could never be finalised: an
        // address that is already bound on this chainKey has nowhere for a second Agent to be written
        // (R10.3), and an Agent at its ceiling has nowhere for a ninth address to go (R10.8). Neither
        // is redundant with the resolver's own checks, which is where a request opened before either
        // condition arose is caught.
        address boundAgent = _bindings[chainKey][ethAddress].agent;
        if (boundAgent != address(0)) revert AddressAlreadyBound(chainKey, ethAddress, boundAgent);
        if (_reverse[msg.sender][chainKey].length >= MAX_ADDRESSES_PER_CHAIN) {
            revert TooManyBoundAddresses(msg.sender, chainKey, MAX_ADDRESSES_PER_CHAIN);
        }

        // casting to 'uint64' is safe because a Creditcoin block timestamp in seconds stays far
        // below 2^64 for the lifetime of the chain, and `block.timestamp` is the only clock this
        // contract reads.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 nowTs = uint64(block.timestamp);

        PendingBinding storage held = _pending[chainKey][ethAddress][msg.sender];
        if (held.open) {
            uint64 heldExpiresAt = held.issuedAt + BINDING_TTL;
            if (nowTs < heldExpiresAt) {
                revert BindingAlreadyPending(msg.sender, chainKey, ethAddress, held.nonce, heldExpiresAt);
            }
            // The window closed, so the nonce is no longer valid for anything and this call reclaims
            // it on the way past. (R10.6)
            uint16 elapsedNonce = held.nonce;
            _closePending(chainKey, ethAddress, msg.sender, held);
            emit BindingExpired(msg.sender, chainKey, ethAddress, elapsedNonce);
        }

        nonce = _allocateNonce(chainKey);
        requiredAmount = requiredAmountForNonce(nonce);
        expiresAt = nowTs + BINDING_TTL;

        _amountClaim[chainKey][requiredAmount] = AmountClaim({ethAddress: ethAddress, agent: msg.sender});
        _openNonces[chainKey] += 1;
        _pending[chainKey][ethAddress][msg.sender] = PendingBinding({
            agent: msg.sender,
            chainKey: chainKey,
            ethAddress: ethAddress,
            requiredAmount: requiredAmount,
            nonce: nonce,
            issuedAt: nowTs,
            open: true
        });

        emit BindingRequested(msg.sender, chainKey, ethAddress, nonce, requiredAmount, expiresAt);
    }

    /// @notice Reclaim a nonce whose 24-hour window closed without a matching Verified Settlement.
    /// @dev **Permissionless on purpose.** The nonce space is a shared, bounded resource: 9000 slots
    /// per chainKey, shared by every Agent binding on that chain. A crank only its own requester
    /// could turn would mean every abandoned attempt holds its slot until that requester chooses to
    /// return, which is a griefing vector with no cost to the griefer — open requests, walk away, and
    /// the space fills with records nobody but the absent party may clear. Permissionless reclamation
    /// removes the vector entirely, and it gives nothing away: the only state it can touch is a
    /// record whose window has already closed, where the nonce is void for every purpose either way.
    /// The caller pays the gas and gets the slot back for whoever needs it next.
    ///
    /// Nothing here depends on this being called. {requestBinding} reclaims the caller's own elapsed
    /// record for the triple it needs, and the resolver refuses an elapsed record on sight, so the
    /// crank is a way to return capacity early, never a step the binding lifecycle waits on. (R10.6)
    /// @param chainKey Attested-chain identifier of the request to reclaim.
    /// @param ethAddress Source Chain address of the request to reclaim.
    /// @param agent Agent that opened the request to reclaim. Part of the key, so it is named rather
    /// than derived from the caller, who has no relationship to the record being cleared.
    function expireBinding(uint64 chainKey, address ethAddress, address agent) external {
        PendingBinding storage held = _pending[chainKey][ethAddress][agent];
        if (!held.open) revert NoOpenBinding(chainKey, ethAddress, agent);

        // casting to 'uint64' is safe for the reason given in `requestBinding`.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 nowTs = uint64(block.timestamp);
        uint64 expiresAt = held.issuedAt + BINDING_TTL;
        // At exactly `expiresAt` the window has closed: the nonce is valid *within* 24 hours of
        // issuance, and reaching 24 hours is what expires it. (R10.5, R10.6)
        if (nowTs < expiresAt) revert BindingWindowActive(held.issuedAt, expiresAt, nowTs);

        uint16 nonce = held.nonce;
        _closePending(chainKey, ethAddress, agent, held);
        emit BindingExpired(agent, chainKey, ethAddress, nonce);
    }

    // ------------------------------------------------------------------ proven binding

    /// @notice Resolve a Verified Settlement's payer to an Agent, finalising a matching request.
    /// @dev **Two jobs in one call, because the verifier has one question and one moment to ask it.**
    /// Every Verified Settlement needs a payer resolved (R8.1), and a binding payment is an ordinary
    /// Settlement rather than a special transaction, so the call that resolves the payer is also the
    /// call that must notice when that payment is the one a pending request was waiting for. Splitting
    /// them would mean either a second proof or a window in which the proving Settlement is credited
    /// to nobody.
    ///
    /// Resolution order, and it is constant time at every step:
    ///
    ///  1. A confirmed binding exists for the pair → return its Agent. This is the common case and it
    ///     stays the common case forever, since bindings are never removed. It has to come first: a
    ///     bound address goes on settling ordinary tabs, and those payments are not binding attempts.
    ///  2. Otherwise {_amountClaim} names this payer for this amount → that amount belongs to exactly
    ///     one live request, and the amount is what proves control, so finalise it. (R10.2)
    ///  3. Otherwise return the zero address, which the verifier turns into `UnboundPayer`. (R8.4)
    ///
    /// Step 2 is where the three-part pending key earns its keep. The amount claim is unique per
    /// chainKey across all Agents, so one payment answers one request and nothing has to be scanned,
    /// even where several Agents hold requests against this payer at once. An Agent that opened a
    /// request against an address it does not control is answered here only by a payment of its own
    /// exact amount; the address's real controller pays the amount it was itself issued and binds to
    /// itself. See {_pending} for why the key is shaped that way.
    ///
    /// What step 3 covers, all of which leave every pending record exactly as it was: an amount no
    /// request claims, an amount claimed by a request against a different address, and the zero payer.
    /// A wrong amount is therefore not an error this contract raises. See the note in the errors
    /// section for why the zero return is the honest answer rather than a weaker one.
    ///
    /// An elapsed request is refused rather than ignored. Its nonce is void for every purpose the
    /// moment the window closes (R10.6), and it is still holding its amount claim until somebody turns
    /// the crank, so the choice is between a revert that names the elapsed window and a silent
    /// `UnboundPayer`. The revert is the one that tells the Watcher to ask for a fresh nonce.
    /// @param chainKey Attested-chain identifier the proof established. Never caller-chosen. (R5.4)
    /// @param ethAddress The payer, taken from `topics[1]` of the verified Settlement log. (R8.1)
    /// @param amount The settled amount in Asset base units, taken from the verified log.
    /// @param provingReplayKey Replay key of the Verified Settlement, recorded on a new binding.
    /// @return agent The Agent bound to `ethAddress` on `chainKey`, or the zero address if none is.
    function resolveOrBind(uint64 chainKey, address ethAddress, uint256 amount, bytes32 provingReplayKey)
        external
        returns (address agent)
    {
        if (msg.sender != settlementVerifier) revert NotSettlementVerifier(msg.sender);

        address boundAgent = _bindings[chainKey][ethAddress].agent;
        if (boundAgent != address(0)) return boundAgent;

        AmountClaim memory claim = _amountClaim[chainKey][amount];
        // The zero payer is tested explicitly because an unclaimed amount also reads as the zero
        // address here, and without this the two would be indistinguishable.
        if (ethAddress == address(0) || claim.ethAddress != ethAddress) return address(0);

        PendingBinding storage held = _pending[chainKey][ethAddress][claim.agent];
        // casting to 'uint64' is safe for the reason given in `requestBinding`.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 nowTs = uint64(block.timestamp);
        if (nowTs >= held.issuedAt + BINDING_TTL) revert BindingWindowElapsed(held.issuedAt, nowTs);

        agent = claim.agent;
        address[] storage owned = _reverse[agent][chainKey];
        if (owned.length >= MAX_ADDRESSES_PER_CHAIN) {
            revert TooManyBoundAddresses(agent, chainKey, MAX_ADDRESSES_PER_CHAIN);
        }

        _bindings[chainKey][ethAddress] =
            Binding({agent: agent, chainKey: chainKey, boundAt: nowTs, provingReplayKey: provingReplayKey});
        owned.push(ethAddress);
        // The request is satisfied, so its nonce goes back to the shared space immediately rather than
        // waiting out the window it no longer needs. Requests other Agents hold against this address
        // are left alone: they can no longer be finalised, because step 1 now answers for this pair,
        // and they return to the space at {BINDING_TTL} through {expireBinding}.
        _closePending(chainKey, ethAddress, agent, held);

        emit AddressBound(agent, chainKey, ethAddress, provingReplayKey);
    }

    // ------------------------------------------------------------------ amount encoding

    /// @notice The exact Settlement amount that carries `nonce`, in Asset base units.
    /// @dev The forward half of the encoding, and pure so that an off-chain client computes the same
    /// amount the resolver will look for without an RPC round trip and without a second
    /// implementation of the arithmetic. Addition rather than bit packing: the requirement is that
    /// the *decimal* digits of the amount a human reads in a wallet carry the nonce, so the encoding
    /// has to be decimal too. (R10.1)
    /// @param nonce A nonce in `[NONCE_MIN, NONCE_MAX]`.
    /// @return requiredAmount The Settlement amount encoding that nonce.
    function requiredAmountForNonce(uint16 nonce) public pure returns (uint256 requiredAmount) {
        if (nonce < NONCE_MIN || nonce > NONCE_MAX) revert NonceOutOfRange(nonce);
        requiredAmount = BINDING_BASE_UNITS + uint256(nonce);
    }

    /// @notice Recover the nonce a Settlement amount encodes, if it encodes one at all.
    /// @dev The inverse of {requiredAmountForNonce}, and the direction the resolver needs: it is
    /// handed a Verified Settlement and has to decide, from the amount alone, whether that amount is
    /// a binding amount at all before it goes looking for a request to satisfy. Returning a flag
    /// rather than reverting is deliberate — an amount outside the window is the ordinary case, not
    /// a fault, and a revert would make the ordinary case cost a try block.
    ///
    /// Pure, so the same decision is available to an off-chain client watching the Source Chain and
    /// to a test that wants to sweep the whole window. The round trip in both directions across the
    /// entire 9000-value space is what makes the encoding trustworthy: a silent collision here would
    /// let one payment answer two requests.
    /// @param amount A Settlement amount in Asset base units.
    /// @return isBindingAmount True when `amount` lies in the encoding window.
    /// @return nonce The encoded nonce when `isBindingAmount` is true, and zero otherwise.
    function nonceFromAmount(uint256 amount) public pure returns (bool isBindingAmount, uint16 nonce) {
        // Written as one positive test rather than an early rejection, so the outside-the-window case
        // leaves both named returns at their defaults and there is only one place that decides an
        // amount is a binding amount.
        if (amount >= BINDING_BASE_UNITS + NONCE_MIN && amount <= BINDING_BASE_UNITS + NONCE_MAX) {
            // casting to 'uint16' is safe because the bounds above put `amount - BINDING_BASE_UNITS`
            // inside `[NONCE_MIN, NONCE_MAX]`, which is well under 2^16.
            // forge-lint: disable-next-line(unsafe-typecast)
            nonce = uint16(amount - BINDING_BASE_UNITS);
            isBindingAmount = true;
        }
    }

    // ------------------------------------------------------------------ reads

    /// @notice The Agent bound to `ethAddress` on `chainKey`, or the zero address if none is.
    /// @dev The read behind payer resolution, and the reason {resolveOrBind} can return zero rather
    /// than revert: unbound is a value here, not a fault. Signature-free and public, so a Service, a
    /// client, or a stranger can check whose address a payer is before any payment is made. (R8.4)
    /// @param chainKey Attested-chain identifier to look up.
    /// @param ethAddress Source Chain address to look up.
    /// @return agent The bound Agent, or the zero address.
    function agentOf(uint64 chainKey, address ethAddress) external view returns (address agent) {
        agent = _bindings[chainKey][ethAddress].agent;
    }

    /// @notice Every address `agent` has bound on `chainKey`, in the order they were bound.
    /// @dev Returned whole rather than by index because the list is bounded at
    /// {MAX_ADDRESSES_PER_CHAIN} and a caller almost always wants all of it: the question it answers
    /// is "which payers settle for this Agent", which a paginated read would only make more expensive.
    /// @param agent Agent to report on.
    /// @param chainKey Attested-chain identifier to report on.
    /// @return addresses The bound addresses, at most {MAX_ADDRESSES_PER_CHAIN} of them.
    function boundAddresses(address agent, uint64 chainKey)
        external
        view
        returns (address[] memory addresses)
    {
        addresses = _reverse[agent][chainKey];
    }

    /// @notice The full binding record for an address, including the payment that proved it.
    /// @dev {agentOf} answers the resolver's question; this answers the auditor's. `provingReplayKey`
    /// is in the {AddressBound} log too, but a log is only findable by someone who knows to look for
    /// it, and the point of storing the key is that the proof behind a live binding can be reached from
    /// the binding itself. An unbound pair returns a zeroed record.
    /// @param chainKey Attested-chain identifier to look up.
    /// @param ethAddress Source Chain address to look up.
    /// @return binding The stored binding record.
    function bindingOf(uint64 chainKey, address ethAddress) external view returns (Binding memory binding) {
        binding = _bindings[chainKey][ethAddress];
    }

    /// @notice One Agent's open binding request against one address, together with its window state.
    /// @dev One read serving both the resolver's on-chain question and a client's `/register` view.
    /// `alive` is returned rather than left to the caller so the 24-hour boundary is decided in one
    /// place. A triple with no request returns a zeroed record, `alive` false, and `expiresAt` zero,
    /// which is also what a request that exists under a different Agent looks like from here.
    /// @param chainKey Attested-chain identifier to look up.
    /// @param ethAddress Source Chain address to look up.
    /// @param agent Agent whose request to look up.
    /// @return pending The stored request record.
    /// @return expiresAt Creditcoin timestamp at which its nonce stops being valid.
    /// @return alive True while the request is open and its window has not closed.
    function pendingBinding(uint64 chainKey, address ethAddress, address agent)
        external
        view
        returns (PendingBinding memory pending, uint64 expiresAt, bool alive)
    {
        pending = _pending[chainKey][ethAddress][agent];
        if (pending.open) {
            expiresAt = pending.issuedAt + BINDING_TTL;
            // `block.timestamp` is the only clock this contract reads, by design: a Creditcoin
            // contract has no other honest source of time, and `block.number` is not one because a
            // block interval is not a second. Validator drift is seconds against a 24-hour window,
            // so it cannot move a request across the boundary in any way that matters.
            // forge-lint: disable-next-line(block-timestamp)
            alive = block.timestamp < expiresAt;
        }
    }

    /// @notice Which request, if any, holds `requiredAmount` open on `chainKey`.
    /// @dev The amount-to-request direction of the lookup, in one read, and the whole reason the
    /// resolver can finalise in constant time: the amount names the triple, so no scan over the
    /// requests open against a payer is ever needed. A client that has seen a candidate Settlement on
    /// the Source Chain uses this to find the request it would satisfy before paying for proof
    /// material. A zero `ethAddress` means the amount is unclaimed, and the returned `agent` is then
    /// the zero address too.
    /// @param chainKey Attested-chain identifier to look up.
    /// @param requiredAmount Settlement amount, in Asset base units, to look up.
    /// @return ethAddress The address the holding request claims, or the zero address.
    /// @return agent The Agent that opened the holding request, or the zero address.
    function pendingBindingByAmount(uint64 chainKey, uint256 requiredAmount)
        external
        view
        returns (address ethAddress, address agent)
    {
        AmountClaim memory claim = _amountClaim[chainKey][requiredAmount];
        ethAddress = claim.ethAddress;
        agent = claim.agent;
    }

    /// @notice How many nonces are currently held open on `chainKey`.
    /// @dev Exposed because it is the one number that tells an operator how close a chainKey is to
    /// {NonceSpaceExhausted}, and a client cannot derive it from the events without replaying them.
    /// @param chainKey Attested-chain identifier to report on.
    /// @return openNonces Count of held nonces, at most {NONCE_SPACE}.
    function openNonceCount(uint64 chainKey) external view returns (uint256 openNonces) {
        openNonces = _openNonces[chainKey];
    }

    // ------------------------------------------------------------------ internals

    /// @notice Take one free nonce out of the window for `chainKey`.
    /// @dev Two steps, and the order matters. The count check answers exhaustion in one read, which
    /// keeps the failure cheap and, more usefully, makes the loop that follows guaranteed to find a
    /// free slot rather than merely likely to: a scan is only entered when at least one slot is free.
    /// The probe then walks forward from the cursor with wraparound, so allocation and reclamation
    /// pack against each other instead of leaving the window fragmented.
    ///
    /// The probe reads whether a slot is claimed and never whether the claiming request has elapsed,
    /// which keeps allocation's cost independent of how stale the space is and keeps exhaustion an
    /// honest answer about slots that are held. Returning them is the crank's job.
    ///
    /// The revert after the loop is unreachable given the count check above it. It is kept because
    /// the alternative to an unreachable revert is a reachable path that returns a nonce the scan
    /// never validated, and of the two, the unreachable revert is the one that cannot mint a
    /// duplicate amount if a future edit gets the accounting wrong.
    /// @param chainKey Attested-chain identifier to allocate on.
    /// @return nonce A nonce no open request on this chainKey holds.
    function _allocateNonce(uint64 chainKey) internal returns (uint16 nonce) {
        if (_openNonces[chainKey] >= NONCE_SPACE) revert NonceSpaceExhausted();

        uint16 candidate = _nonceCursor[chainKey];
        if (candidate < NONCE_MIN || candidate > NONCE_MAX) candidate = NONCE_MIN;

        for (uint256 i = 0; i < NONCE_SPACE; ++i) {
            if (_amountClaim[chainKey][BINDING_BASE_UNITS + uint256(candidate)].ethAddress == address(0)) {
                _nonceCursor[chainKey] = candidate == NONCE_MAX ? NONCE_MIN : candidate + 1;
                return candidate;
            }
            candidate = candidate == NONCE_MAX ? NONCE_MIN : candidate + 1;
        }

        revert NonceSpaceExhausted();
    }

    /// @notice Return a request's nonce to the space and clear its record.
    /// @dev The single place a nonce is released, so the amount claim, the open count, and the
    /// pending record can never disagree about whether a nonce is held. The resolver reuses it when
    /// a request is satisfied, which is the other way a nonce leaves the space; releasing on
    /// satisfaction is what keeps a bound address from holding a slot forever.
    /// @param chainKey Attested-chain identifier of the request.
    /// @param ethAddress Source Chain address of the request.
    /// @param agent Agent that opened the request.
    /// @param held Storage handle on the request record being closed.
    function _closePending(uint64 chainKey, address ethAddress, address agent, PendingBinding storage held)
        internal
    {
        delete _amountClaim[chainKey][held.requiredAmount];
        _openNonces[chainKey] -= 1;
        delete _pending[chainKey][ethAddress][agent];
    }
}
