/**
 * Tab spike 1.2 — ChainInfo Precompile attestation liveness probe.
 *
 * Read-only. No private key, no funded account, no transactions.
 *
 * Purpose:
 *   1. Discover the *real* ABI of the ChainInfo Precompile at 0x...0fd3 via the
 *      authoritative `@gluwa/usc-sdk` chain-info provider.
 *   2. Independently probe the raw precompile with the function signatures the Tab
 *      design assumed, and record whether each one exists (a negative result is a
 *      finding, not a failure).
 *   3. Measure attestation liveness per chainKey: latest attested height, the head
 *      height of the corresponding Source Chain from a public RPC, and the gap.
 *   4. Take two attested-height reads spaced apart so the attestation interval can
 *      be inferred.
 *
 * Output: spike/chaininfo-transcript.json
 *
 * Run: pnpm tsx spike/chaininfo-probe.ts
 * Env overrides:
 *   CREDITCOIN_RPC_URL   default https://rpc.cc3-testnet.creditcoin.network
 *   PROVER_URL           default https://prover.cc3-testnet.creditcoin.network
 *   INTERVAL_SAMPLE_MS   default 150000 (gap between the two attested-height reads)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve as resolvePath } from 'node:path';

import { chainInfo } from '@gluwa/usc-sdk';
import { FunctionFragment, Interface, JsonRpcProvider } from 'ethers';

const CREDITCOIN_RPC_URL = process.env.CREDITCOIN_RPC_URL ?? 'https://rpc.cc3-testnet.creditcoin.network';
const PROVER_URL = process.env.PROVER_URL ?? 'https://prover.cc3-testnet.creditcoin.network';
const INTERVAL_SAMPLE_MS = Number(process.env.INTERVAL_SAMPLE_MS ?? 150_000);
const CHAIN_INFO_PRECOMPILE = chainInfo.CHAIN_INFO_PRECOMPILE_ADDRESS;

const SPIKE_DIR =
  basename(process.cwd()) === 'spike' ? process.cwd() : resolvePath(process.cwd(), 'spike');
const OUT_PATH = resolvePath(SPIKE_DIR, 'chaininfo-transcript.json');

/** Public read-only RPC endpoints keyed by the Source Chain's native chainId. */
const PUBLIC_SOURCE_RPCS: Record<number, { name: string; urls: string[] }> = {
  1: { name: 'Ethereum Mainnet', urls: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com'] },
  11155111: {
    name: 'Ethereum Sepolia',
    urls: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://rpc.sepolia.org'],
  },
  56: { name: 'BNB Smart Chain', urls: ['https://bsc-rpc.publicnode.com'] },
  137: { name: 'Polygon PoS', urls: ['https://polygon-bor-rpc.publicnode.com'] },
};

/**
 * Function signatures the Tab design document *assumed* the precompile exposes.
 * Each is probed raw against the precompile so a wrong assumption is proven wrong
 * rather than argued about.
 */
const ASSUMED_SIGNATURES = [
  { signature: 'supportedChains() returns (uint64[])', args: [] as unknown[] },
  { signature: 'latestAttestedHeight(uint64) returns (uint64)', args: [1] as unknown[] },
  { signature: 'attestedBlockDigest(uint64,uint64) returns (bytes32)', args: [1, 1] as unknown[] },
];

type Json = Record<string, unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** Raw eth_call against the precompile with an arbitrary human-readable signature. */
async function rawProbe(
  provider: JsonRpcProvider,
  signature: string,
  args: unknown[],
): Promise<Json> {
  const fragment = FunctionFragment.from(signature);
  const iface = new Interface([fragment]);
  const data = iface.encodeFunctionData(fragment, args);
  const record: Json = { signature, selector: data.slice(0, 10), calldata: data };
  try {
    const raw = await provider.call({ to: CHAIN_INFO_PRECOMPILE, data });
    record.rawReturnData = raw;
    record.reverted = false;
    record.emptyReturn = raw === '0x';
    try {
      record.decoded = JSON.parse(
        JSON.stringify(iface.decodeFunctionResult(fragment, raw), (_k, v) =>
          typeof v === 'bigint' ? v.toString() : v,
        ),
      );
      record.decodeSucceeded = true;
    } catch (e) {
      record.decodeSucceeded = false;
      record.decodeError = errText(e);
    }
    record.exists = raw !== '0x' && record.decodeSucceeded === true;
  } catch (e) {
    record.reverted = true;
    record.exists = false;
    record.error = errText(e);
  }
  return record;
}

/** eth_blockNumber against the first public endpoint that answers. */
async function sourceChainHead(chainId: number): Promise<Json> {
  const entry = PUBLIC_SOURCE_RPCS[chainId];
  if (!entry) {
    return { reachable: false, reason: `no public RPC configured for chainId ${chainId}` };
  }
  const attempts: Json[] = [];
  for (const url of entry.urls) {
    try {
      const p = new JsonRpcProvider(url, undefined, { staticNetwork: true });
      const [head, net] = await Promise.all([p.getBlockNumber(), p.getNetwork()]);
      p.destroy();
      return {
        reachable: true,
        endpoint: url,
        reportedChainId: Number(net.chainId),
        headHeight: head,
        failedEndpoints: attempts,
      };
    } catch (e) {
      attempts.push({ endpoint: url, error: errText(e) });
    }
  }
  return { reachable: false, reason: 'all configured public endpoints failed', failedEndpoints: attempts };
}

/** The Proof Builder's own attested-height view, for cross-checking the precompile. */
async function proverAttestedHeight(chainKey: number): Promise<Json> {
  const url = `${PROVER_URL}/api/v1/attested-height/${chainKey}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const body = await res.text();
    return { url, httpStatus: res.status, body: body.slice(0, 2000) };
  } catch (e) {
    return { url, reachable: false, error: errText(e) };
  }
}

function decodeChainName(raw: unknown): Json {
  const hex = typeof raw === 'string' ? raw : null;
  if (!hex) return { raw: String(raw), utf8: null, allZero: null };
  const bytes = Buffer.from(hex.replace(/^0x/, ''), 'hex');
  return {
    raw: hex,
    byteLength: bytes.length,
    utf8: bytes.toString('utf8'),
    allZero: bytes.length > 0 && bytes.every((b) => b === 0),
  };
}

async function main(): Promise<void> {
  const transcript: Json = {
    probedAt: new Date().toISOString(),
    task: 'tab 1.2 — verify attestation liveness through the ChainInfo Precompile',
    endpoints: {
      creditcoinRpc: CREDITCOIN_RPC_URL,
      proofBuilder: PROVER_URL,
      chainInfoPrecompile: CHAIN_INFO_PRECOMPILE,
      publicSourceRpcs: PUBLIC_SOURCE_RPCS,
    },
    intervalSampleMs: INTERVAL_SAMPLE_MS,
  };

  const provider = new JsonRpcProvider(CREDITCOIN_RPC_URL, undefined, { staticNetwork: true });

  // --- Creditcoin node reachability ---------------------------------------
  try {
    const [net, latest, finalized] = await Promise.all([
      provider.getNetwork(),
      provider.getBlockNumber(),
      provider.getBlock('finalized'),
    ]);
    transcript.creditcoin = {
      reachable: true,
      chainId: Number(net.chainId),
      latestBlock: latest,
      finalizedBlock: finalized ? finalized.number : null,
      finalizedBlockTimestampIso: finalized ? new Date(finalized.timestamp * 1000).toISOString() : null,
    };
  } catch (e) {
    transcript.creditcoin = { reachable: false, error: errText(e) };
    writeTranscript(transcript);
    console.error('Creditcoin RPC unreachable. Transcript written; nothing further could be probed.');
    process.exitCode = 1;
    return;
  }

  // --- SDK path: the authoritative ABI ------------------------------------
  const cip = new chainInfo.PrecompileChainInfoProvider(provider);
  let chains: chainInfo.ChainInfo[] = [];
  try {
    chains = await cip.getSupportedChains();
    transcript.sdkGetSupportedChains = { ok: true, count: chains.length };
  } catch (e) {
    transcript.sdkGetSupportedChains = { ok: false, error: errText(e) };
  }

  // --- Raw probe of the real get_supported_chains, to see the wire shape ---
  transcript.verifiedAbiProbes = {
    get_supported_chains: await rawProbe(
      provider,
      'get_supported_chains() returns ((uint64,uint64,bytes,uint8)[])',
      [],
    ),
    get_latest_attestation_height_and_hash_chainKey1: await rawProbe(
      provider,
      'get_latest_attestation_height_and_hash(uint64) returns ((uint64,bytes32,bool,bool))',
      [1],
    ),
    is_height_attested_chainKey1_height1: await rawProbe(
      provider,
      'is_height_attested(uint64,uint64) returns (bool)',
      [1, 1],
    ),
  };

  // --- Raw probe of the signatures the design assumed ---------------------
  const assumed: Json = {};
  for (const { signature, args } of ASSUMED_SIGNATURES) {
    assumed[signature] = await rawProbe(provider, signature, args);
  }
  transcript.designAssumedSignatureProbes = assumed;

  // --- Per-chain liveness, first sample ----------------------------------
  const firstSampleAt = new Date().toISOString();
  const perChain: Json[] = [];
  for (const c of chains) {
    const entry: Json = {
      chainKey: c.chainKey,
      chainId: c.chainId,
      chainName: decodeChainName(c.chainName),
      chainEncoding: c.chainEncoding,
      knownAs: PUBLIC_SOURCE_RPCS[c.chainId]?.name ?? `unmapped chainId ${c.chainId}`,
    };

    try {
      entry.latestAttestation = await cip.getLatestAttestedHeightAndHash(c.chainKey);
    } catch (e) {
      entry.latestAttestation = { error: errText(e) };
    }
    try {
      entry.latestCheckpointRaw = await rawProbe(
        provider,
        'get_latest_checkpoint_height_and_hash(uint64) returns ((uint64,bytes32,bool,bool))',
        [c.chainKey],
      );
    } catch (e) {
      entry.latestCheckpointRaw = { error: errText(e) };
    }
    try {
      entry.attestationGenesisHeight = await cip.getAttestationGenesisHeight(c.chainKey);
    } catch (e) {
      entry.attestationGenesisHeight = { error: errText(e) };
    }

    entry.sourceChainHead = await sourceChainHead(c.chainId);
    entry.proofBuilderAttestedHeight = await proverAttestedHeight(c.chainKey);

    const attHeight = (entry.latestAttestation as { height?: number } | undefined)?.height;
    const head = (entry.sourceChainHead as { headHeight?: number }).headHeight;
    entry.attestedHeightGap =
      typeof attHeight === 'number' && typeof head === 'number' ? head - attHeight : null;

    // Continuity bounds at the attested tip — proves the height is usable for proofs.
    if (typeof attHeight === 'number' && attHeight > 0) {
      try {
        entry.continuityBoundsAtAttestedTip = await cip.getContinuityBounds(c.chainKey, attHeight);
      } catch (e) {
        entry.continuityBoundsAtAttestedTip = { error: errText(e) };
      }

      // The design assumed a direct `attestedBlockDigest(chainKey, height)`. That selector does
      // not exist, so establish which real methods answer "what digest is attested at height H?"
      const digest = (entry.latestAttestation as { hash?: string }).hash;
      const digestPath: Json = {};
      try {
        digestPath.getCheckpointForHeight_atAttestedTip = await cip.getCheckpointForHeight(
          c.chainKey,
          attHeight,
        );
      } catch (e) {
        digestPath.getCheckpointForHeight_atAttestedTip = { error: errText(e) };
      }
      if (digest) {
        try {
          digestPath.getAttestationHeightForDigest_roundTrip = await cip.getAttestationHeightForDigest(
            c.chainKey,
            digest,
          );
        } catch (e) {
          digestPath.getAttestationHeightForDigest_roundTrip = { error: errText(e) };
        }
      }
      digestPath.isHeightAttested_atAttestedTip = await rawProbe(
        provider,
        'is_height_attested(uint64,uint64) returns (bool)',
        [c.chainKey, attHeight],
      );
      digestPath.isHeightAttested_oneAboveAttestedTip = await rawProbe(
        provider,
        'is_height_attested(uint64,uint64) returns (bool)',
        [c.chainKey, attHeight + 1],
      );
      digestPath.findHighestAttestedBefore_atAttestedTip = await rawProbe(
        provider,
        'find_highest_attested_before(uint64,uint64) returns ((uint64,bytes32,bool,bool))',
        [c.chainKey, attHeight],
      );
      digestPath.findLowestAttestedAfter_atAttestedTip = await rawProbe(
        provider,
        'find_lowest_attested_after(uint64,uint64) returns ((uint64,bytes32,bool,bool))',
        [c.chainKey, attHeight],
      );
      entry.digestAtHeightProbes = digestPath;
    }

    perChain.push(entry);
  }

  // --- Second sample, spaced apart, to infer the attestation interval -----
  console.log(`First sample complete. Waiting ${INTERVAL_SAMPLE_MS}ms for the second sample...`);
  await sleep(INTERVAL_SAMPLE_MS);
  const secondSampleAt = new Date().toISOString();
  const elapsedMs = Date.parse(secondSampleAt) - Date.parse(firstSampleAt);

  for (const entry of perChain) {
    const key = entry.chainKey as number;
    let second: Json;
    try {
      second = { ...(await cip.getLatestAttestedHeightAndHash(key)) } as Json;
    } catch (e) {
      second = { error: errText(e) };
    }
    entry.latestAttestationSecondSample = second;

    const h1 = (entry.latestAttestation as { height?: number }).height;
    const h2 = (second as { height?: number }).height;
    if (typeof h1 === 'number' && typeof h2 === 'number') {
      const advancedBy = h2 - h1;
      entry.attestationInterval = {
        elapsedMs,
        heightsAdvancedBy: advancedBy,
        advanced: advancedBy > 0,
        note:
          advancedBy > 0
            ? `attested tip advanced ${advancedBy} source-chain blocks over ${Math.round(elapsedMs / 1000)}s`
            : `attested tip did NOT advance over ${Math.round(elapsedMs / 1000)}s — either the attestation interval is longer than the sample window, or the chain is not attesting`,
      };
    }
  }

  transcript.samples = { firstSampleAt, secondSampleAt, elapsedMs };
  transcript.chains = perChain;

  // --- Verdict for the two chainKeys the Tab design depends on -----------
  const verdictFor = (key: number): Json => {
    const e = perChain.find((x) => x.chainKey === key);
    if (!e) return { chainKey: key, present: false, attesting: false, evidence: 'not reported by get_supported_chains' };
    const att = e.latestAttestation as { height?: number; exists?: boolean; hash?: string } | undefined;
    const interval = e.attestationInterval as { advanced?: boolean } | undefined;
    return {
      chainKey: key,
      present: true,
      chainId: e.chainId,
      knownAs: e.knownAs,
      attestationExists: att?.exists ?? null,
      latestAttestedHeight: att?.height ?? null,
      latestAttestedDigest: att?.hash ?? null,
      sourceChainHead: (e.sourceChainHead as Json).headHeight ?? null,
      attestedHeightGap: e.attestedHeightGap,
      advancedDuringProbe: interval?.advanced ?? null,
      attesting: Boolean(att?.exists) && (interval?.advanced ?? false),
    };
  };
  transcript.verdict = {
    chainKey1: verdictFor(1),
    chainKey3: verdictFor(3),
    note: '"attesting" requires both an existing attestation and an observed advance of the attested tip during the probe window.',
  };

  writeTranscript(transcript);
  console.log(JSON.stringify(transcript.verdict, null, 2));
  console.log(`\nTranscript written to ${OUT_PATH}`);
}

function writeTranscript(transcript: Json): void {
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(
    OUT_PATH,
    JSON.stringify(transcript, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n',
    'utf8',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
