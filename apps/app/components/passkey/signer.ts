/**
 * An ethers `Signer` backed by a Mera signing session.
 *
 * ## Why not `new Wallet(privateKey)`
 *
 * An ethers `Wallet` needs the private key as a string, and a string cannot
 * be zeroed. A Mera session holds the key in a buffer it owns, signs 32-byte
 * digests on request, and zeroes the buffer on `end`. Everything ethers needs
 * from a signer is a signature over a digest it has already computed, so the
 * session can stand behind an `AbstractSigner` directly: the transaction is
 * built and hashed by ethers, the hash is signed by the session, and the key
 * is never in a form this file could print.
 *
 * ## What it signs
 *
 * Transactions, personal messages and typed data, which is the full `Signer`
 * surface. `sendTransaction` is inherited: ethers populates the nonce, the fee
 * and the gas from the provider, calls `signTransaction` here, and broadcasts.
 *
 * ## After `end`
 *
 * A session that has ended throws `SESSION_ENDED` on `signDigest`. That is
 * surfaced as-is rather than caught, because a caller that reaches an ended
 * session has a lifecycle bug the message names precisely.
 */

import type { Secp256k1SigningSession } from "@category-labs/mera";
import {
  AbstractSigner,
  Signature,
  Transaction,
  TypedDataEncoder,
  assertArgument,
  copyRequest,
  getAddress,
  getBytes,
  hashMessage,
  hexlify,
  resolveAddress,
  resolveProperties,
  type Provider,
  type TransactionLike,
  type TransactionRequest,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";

export class SessionSigner extends AbstractSigner<Provider | null> {
  readonly address: string;
  readonly #session: Secp256k1SigningSession;

  constructor(session: Secp256k1SigningSession, address: string, provider: Provider | null = null) {
    super(provider);
    this.#session = session;
    this.address = getAddress(address);
  }

  async getAddress(): Promise<string> {
    return this.address;
  }

  connect(provider: Provider | null): SessionSigner {
    return new SessionSigner(this.#session, this.address, provider);
  }

  /** A 32-byte digest, signed by the session and returned in ethers' shape. */
  async signDigest(digest: string | Uint8Array): Promise<Signature> {
    const bytes = getBytes(digest);
    const { compact, recovery } = await this.#session.signDigest(bytes);
    return Signature.from({
      r: hexlify(compact.subarray(0, 32)),
      s: hexlify(compact.subarray(32, 64)),
      v: recovery === 0 ? 27 : 28,
    });
  }

  async signTransaction(tx: TransactionRequest): Promise<string> {
    const request = copyRequest(tx);

    const { to, from } = await resolveProperties({
      to: request.to ? resolveAddress(request.to, this) : undefined,
      from: request.from ? resolveAddress(request.from, this) : undefined,
    });
    if (to != null) request.to = to;
    if (from != null) request.from = from;

    if (request.from != null) {
      assertArgument(
        getAddress(request.from as string) === this.address,
        "transaction from address mismatch",
        "tx.from",
        request.from,
      );
      delete request.from;
    }

    const built = Transaction.from(request as TransactionLike<string>);
    built.signature = await this.signDigest(built.unsignedHash);
    return built.serialized;
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    return (await this.signDigest(hashMessage(message))).serialized;
  }

  async signTypedData(
    domain: TypedDataDomain,
    types: Record<string, Array<TypedDataField>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    // Monad has no name service this Dashboard would resolve, so a name in
    // the data is refused rather than looked up somewhere surprising.
    const populated = await TypedDataEncoder.resolveNames(domain, types, value, async (name: string) => {
      throw new Error(`Cannot resolve the name ${name}: this signer resolves addresses only.`);
    });
    return (await this.signDigest(TypedDataEncoder.hash(populated.domain, types, populated.value))).serialized;
  }
}
