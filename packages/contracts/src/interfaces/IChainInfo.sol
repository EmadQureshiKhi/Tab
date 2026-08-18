// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title IChainInfo
/// @notice Typed surface of the ChainInfo Precompile at
/// `0x0000000000000000000000000000000000000fd3`, which publishes the set of attested chains and the
/// attestation and checkpoint frontiers for each one.
/// @dev This declaration is the ABI confirmed by raw `eth_call` against the live precompile on
/// CC3 Testnet (chain id 102031) and cross-checked against the ChainInfo ABI shipped in the pinned
/// usc-sdk 0.18.0 package (`src/chain-info/chain_info.json`). Three properties of it are
/// load-bearing and are the reason it looks the way it does rather than the way a hand-written
/// Solidity interface normally would:
///
/// 1. Method names are `snake_case`, matching the precompile exactly. Solidity permits the names,
///    so no aliasing is used: an alias would change the 4-byte selector and every call would revert
///    with `"Unknown selector"`.
/// 2. Every non-trivial return is a struct, and **struct field order is wire order**. It was
///    established by decoding raw return data, not read off a wrapper. Reordering any field
///    silently breaks decoding while still compiling.
/// 3. `chainName` is `bytes`, not `string` — variable-length UTF-8, neither zero-padded nor
///    truncated — and `chainEncoding` is `uint8`, not a wider integer. Both types feed the selector,
///    so both are part of the integration rather than a stylistic choice.
///
/// Two semantics that constrain every reader of this precompile:
///
/// - **Attested heights are sparse.** Attestations land on a stride of source-chain blocks, so most
///   heights are never themselves an attestation endpoint. "Is this Settlement provable" must be
///   asked as "is this height covered by the attested frontier", never as "is this height an
///   attestation". A height that is attested is also not automatically a checkpoint: attestations
///   and checkpoints are separate registries.
/// - **Attestations and checkpoints do not share a registry.**
///   `get_checkpoint_for_height(chainKey, attestedTipHeight)` was observed returning
///   `{hash: 0, exists: false}` on both attested chains, so `get_checkpoint_for_height` must never
///   be used to fetch an attested digest.
///
/// There is deliberately **no** method returning the attested digest at an arbitrary height, because
/// the precompile exposes none. Reorg detection therefore runs digest-first through
/// `get_attestation_height_for_digest(chainKey, observedDigest)`, where `exists: false` is the reorg
/// signal, with `get_attestation_bounds` as the fallback when the starting point is a height.
interface IChainInfo {
    /// @notice Descriptor of one attested chain.
    /// @dev Field order is wire order.
    struct ChainInfo {
        /// @dev Attestation-side identifier of the chain, used in every other call here.
        uint64 chainKey;
        /// @dev The chain's own native chain id.
        uint64 chainId;
        /// @dev Human-readable name as variable-length UTF-8 bytes, not `string`.
        bytes chainName;
        /// @dev Encoding family of the chain's block and transaction format.
        uint8 chainEncoding;
    }

    /// @notice A chain descriptor plus a presence flag.
    /// @dev `exists` is false for an unknown `chainKey`; the descriptor is then zero-valued.
    struct ChainInfoResult {
        /// @dev The descriptor, meaningful only when `exists` is true.
        ChainInfo info;
        /// @dev Whether the queried chain is known to the precompile.
        bool exists;
    }

    /// @notice A height paired with its digest, plus the flags describing what the pair is.
    /// @dev Field order is wire order. `isAttestation` distinguishes an attestation endpoint from a
    /// checkpoint, so the same struct serves both frontier reads without ambiguity.
    struct HeightHashResult {
        /// @dev The height the result refers to.
        uint64 height;
        /// @dev Digest recorded for that height.
        bytes32 hash;
        /// @dev True when the record is an attestation, false when it is a checkpoint.
        bool isAttestation;
        /// @dev Whether any record was found at all.
        bool exists;
    }

    /// @notice A height plus a presence flag.
    /// @dev `exists: false` is the reorg signal in the digest-first check, not merely "not found".
    struct HeightResult {
        /// @dev The height the digest belongs to, meaningful only when `exists` is true.
        uint64 height;
        /// @dev Whether the digest is part of the attested chain.
        bool exists;
    }

    /// @notice A digest plus a presence flag.
    struct HashResult {
        /// @dev The digest, meaningful only when `exists` is true.
        bytes32 hash;
        /// @dev Whether a record was found.
        bool exists;
    }

    /// @notice The two attestation endpoints surrounding a height.
    /// @dev Field order is wire order and is flat rather than two nested `HeightHashResult` values,
    /// exactly as the precompile encodes it. Nesting would change the encoding. At an attested
    /// height the child fields describe that height itself, which is how a digest is recovered from
    /// a height when a digest is not already in hand.
    struct BoundsCheckResult {
        /// @dev Height of the attestation endpoint at or below the queried height.
        uint64 parentHeight;
        /// @dev Digest at `parentHeight`.
        bytes32 parentHash;
        /// @dev Whether the parent record is an attestation.
        bool parentIsAttestation;
        /// @dev Height of the attestation endpoint at or above the queried height.
        uint64 childHeight;
        /// @dev Digest at `childHeight`.
        bytes32 childHash;
        /// @dev Whether the child record is an attestation.
        bool childIsAttestation;
        /// @dev Whether the queried height falls inside the attested range.
        bool isAttested;
    }

    /// @notice Every chain the precompile currently attests.
    /// @dev Absence from this list is what makes a chain unmonitorable, so this is the read that
    /// drives Tab's supported-chain gate rather than a hardcoded list alone.
    /// @return chains Descriptors of all attested chains.
    function get_supported_chains() external view returns (ChainInfo[] memory chains);

    /// @notice Look up one chain descriptor.
    /// @param chainKey Attestation-side chain identifier.
    /// @return result The descriptor with `exists` false for an unknown `chainKey`.
    function get_chain_by_key(uint64 chainKey) external view returns (ChainInfoResult memory result);

    /// @notice The highest attestation endpoint recorded for a chain, with its digest.
    /// @dev This is the attested frontier. A Settlement above it is not yet provable.
    /// @param chainKey Attestation-side chain identifier.
    /// @return result Height, digest, and flags for the latest attestation.
    function get_latest_attestation_height_and_hash(uint64 chainKey)
        external
        view
        returns (HeightHashResult memory result);

    /// @notice The highest checkpoint recorded for a chain, with its digest.
    /// @dev Checkpoints sit on a coarser grid than attestations and returned `isAttestation: false`
    /// when observed. Do not read this as an attestation frontier.
    /// @param chainKey Attestation-side chain identifier.
    /// @return result Height, digest, and flags for the latest checkpoint.
    function get_latest_checkpoint_height_and_hash(uint64 chainKey)
        external
        view
        returns (HeightHashResult memory result);

    /// @notice The attestation endpoints surrounding a height.
    /// @dev Fallback path for recovering an attested digest when only a height is known: at an
    /// attested height the child fields carry that height and its digest with `isAttested` true.
    /// @param chainKey Attestation-side chain identifier.
    /// @param targetHeight Source Chain height to bracket.
    /// @return result Parent and child endpoints plus the `isAttested` verdict.
    function get_attestation_bounds(uint64 chainKey, uint64 targetHeight)
        external
        view
        returns (BoundsCheckResult memory result);

    /// @notice Lowest height from which attestation history exists for a chain.
    /// @dev Returns 0 both for "no configured genesis height" and for an unsupported chain, and 0
    /// was observed on chains that are in fact supported. A zero return must therefore never be
    /// treated as "chain unsupported"; use `get_supported_chains` or `get_chain_by_key` for that.
    /// @param chainKey Attestation-side chain identifier.
    /// @return genesisHeight The genesis height, or 0 when none is configured.
    function get_attestation_genesis_height(uint64 chainKey) external view returns (uint64 genesisHeight);

    /// @notice Which attested height, if any, a digest belongs to.
    /// @dev The reorg primitive. Feeding in the digest actually observed for a Settlement's block
    /// turns reorg detection into a single lookup with no need to guess a height: `exists: false`
    /// means the observed digest is no longer part of the attested chain.
    /// @param chainKey Attestation-side chain identifier.
    /// @param digest Block digest observed on the Source Chain.
    /// @return result The height carrying that digest, with `exists` false on a reorg.
    function get_attestation_height_for_digest(uint64 chainKey, bytes32 digest)
        external
        view
        returns (HeightResult memory result);

    /// @notice The checkpoint digest recorded at a height, if any.
    /// @dev Checkpoint registry only. Never use this to fetch an attested digest: it returned
    /// `{hash: 0, exists: false}` at the attested tip of both attested chains.
    /// @param chainKey Attestation-side chain identifier.
    /// @param height Source Chain height.
    /// @return result The checkpoint digest, with `exists` false when the height is not a checkpoint.
    function get_checkpoint_for_height(uint64 chainKey, uint64 height)
        external
        view
        returns (HashResult memory result);

    /// @notice Whether a height is attested.
    /// @dev **Semantics NOT YET CONFIRMED at the attested tip.** Two live raw calls one height past
    /// the frontier disagreed: `(3, tip + 1)` returned false while `(1, tip + 1)` returned true,
    /// with the frontier read reporting `tip` for both. The most likely cause is a block-tag
    /// difference between the two reads (`latest` runs ahead of `finalized` on Creditcoin) rather
    /// than differing semantics, and "covered by the attested frontier" is the reading the evidence
    /// supports — but that is an inference, not a verified fact. The function is declared here so it
    /// is callable and so its selector is pinned. Callers MUST NOT depend on its behaviour at or
    /// immediately past the attested tip. Where the answer must be trustworthy, compare against
    /// `get_latest_attestation_height_and_hash` or use `get_attestation_bounds`, both of whose
    /// semantics were confirmed directly.
    /// @param chainKey Attestation-side chain identifier.
    /// @param targetHeight Source Chain height to test.
    /// @return isAttested The precompile's verdict, subject to the caveat above.
    function is_height_attested(uint64 chainKey, uint64 targetHeight) external view returns (bool isAttested);

    /// @notice Nearest attestation endpoint strictly below a height.
    /// @dev Lower endpoint for a Continuity Proof spanning a height that is not itself attested.
    /// @param chainKey Attestation-side chain identifier.
    /// @param targetHeight Source Chain height to search below.
    /// @return result The endpoint, with `exists` false when none is recorded.
    function find_highest_attested_before(uint64 chainKey, uint64 targetHeight)
        external
        view
        returns (HeightHashResult memory result);

    /// @notice Nearest attestation endpoint strictly above a height.
    /// @dev Tells a waiting caller which attestation will first cover a Settlement's height.
    /// @param chainKey Attestation-side chain identifier.
    /// @param targetHeight Source Chain height to search above.
    /// @return result The endpoint, with `exists` false when none is recorded yet.
    function find_lowest_attested_after(uint64 chainKey, uint64 targetHeight)
        external
        view
        returns (HeightHashResult memory result);
}

/// @notice Single place where the ChainInfo Precompile address is written down.
/// @dev Every call site obtains the precompile through `chainInfo()` rather than casting a literal,
/// so the address appears exactly once in the contract tree and the call is typed.
library ChainInfoLib {
    /// @notice The ChainInfo Precompile address on Creditcoin.
    address internal constant PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000000fD3;

    /// @notice The precompile, typed.
    /// @return info `IChainInfo` bound to `PRECOMPILE_ADDRESS`.
    function chainInfo() internal pure returns (IChainInfo info) {
        info = IChainInfo(PRECOMPILE_ADDRESS);
    }
}
