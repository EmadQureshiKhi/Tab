/**
 * The metering delegate's key: made here, kept in one file, and never shown.
 *
 * ## Why this plugin holds a key at all
 *
 * The Agent's key is MetaMask's and never leaves the host, and the host lends
 * a plugin a transaction executor and nothing that signs a message. A metering
 * gateway on the open internet takes a metered call only when it is signed, so
 * `mm tab call` has no signature of its own to give. `MeteringDelegates` is the
 * bridge: the wallet submits one transaction naming this key, and this key
 * signs each call's metering claim from then on.
 *
 * What this key can do is exactly what a metering claim can: ask a Service to
 * meter a call to the Agent's Open Tab. It can never move funds, because no
 * Settlement path reads `MeteringDelegates`, and every charge it causes still
 * passes the Agent's own `TabBook.authorise` ceiling and expiry for that
 * Service and Asset. It lapses at the expiry the Agent set, and the Agent
 * revokes it with `mm tab delegate --revoke --broadcast`.
 *
 * ## Where it lives
 *
 * The host offers a plugin no storage of its own, so the key is a file:
 * `~/.config/tab/delegates/<chainId>-<agent>.json`, created `0600` inside a
 * `0700` directory, one per Agent per network. Nothing in this package prints
 * it, logs it, or sends it anywhere; only its address leaves this module. A
 * file another user can read is refused rather than used, the way `ssh` treats
 * a private key.
 */

import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Address, Result } from "@tabai/sdk";
import { causeOf, err, ok } from "@tabai/sdk";
import { Wallet } from "ethers";

/** The default directory, one file per Agent per network. */
export const defaultDelegateDirectory = (): string => join(homedir(), ".config", "tab", "delegates");

/** A delegate key loaded from, or just written to, its file. */
export interface DelegateKey {
  readonly address: Address;
  /** Signs the metering digest. Never serialised by anything in this package. */
  readonly signer: Wallet;
  readonly path: string;
  /** True when this run generated the key. */
  readonly created: boolean;
}

interface DelegateFile {
  readonly version: 1;
  readonly chainId: number;
  readonly agent: string;
  readonly address: string;
  readonly privateKey: string;
  readonly createdAt: string;
}

export interface DelegateKeyStore {
  readonly directory: string;
  /** The file for one Agent on one network, whether or not it exists. */
  pathFor(chainId: number, agent: Address): string;
  /** The stored key, or undefined when none has been made. */
  load(chainId: number, agent: Address): Result<DelegateKey | undefined>;
  /** The stored key, or a new one written now. */
  loadOrCreate(chainId: number, agent: Address): Result<DelegateKey>;
}

const keyError = (code: string, message: string, path: string, error?: unknown): Result<never> =>
  err({
    category: "VALIDATION",
    code,
    message,
    retryable: false,
    details: { path },
    ...(error === undefined ? {} : { cause: causeOf(error) }),
  });

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";

export function createDelegateKeyStore(directory: string = defaultDelegateDirectory()): DelegateKeyStore {
  const pathFor = (chainId: number, agent: Address): string => join(directory, `${chainId}-${agent.toLowerCase()}.json`);

  const load = (chainId: number, agent: Address): Result<DelegateKey | undefined> => {
    const path = pathFor(chainId, agent);
    let mode: number;
    try {
      mode = statSync(path).mode;
    } catch (error) {
      if (isMissing(error)) return ok(undefined);
      return keyError("DELEGATE_KEY_UNREADABLE", `the metering delegate key file at ${path} could not be read`, path, error);
    }
    // Permission bits mean nothing on Windows, where the check would refuse every file.
    if (process.platform !== "win32" && (mode & 0o077) !== 0) {
      return keyError(
        "DELEGATE_KEY_EXPOSED",
        `the metering delegate key file at ${path} is readable by other users (mode ${(mode & 0o777).toString(8)}); restrict it with \`chmod 600 ${path}\` before it is used`,
        path,
      );
    }
    let parsed: DelegateFile;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as DelegateFile;
    } catch (error) {
      return keyError("DELEGATE_KEY_CORRUPT", `the metering delegate key file at ${path} is not readable JSON`, path, error);
    }
    let signer: Wallet;
    try {
      signer = new Wallet(parsed.privateKey);
    } catch {
      // The cause is deliberately dropped: ethers quotes the value it could not parse.
      return keyError("DELEGATE_KEY_CORRUPT", `the metering delegate key file at ${path} holds no usable key`, path);
    }
    const address = signer.address.toLowerCase() as Address;
    if (
      parsed.version !== 1 ||
      parsed.chainId !== chainId ||
      typeof parsed.agent !== "string" ||
      parsed.agent.toLowerCase() !== agent.toLowerCase() ||
      typeof parsed.address !== "string" ||
      parsed.address.toLowerCase() !== address
    ) {
      return keyError(
        "DELEGATE_KEY_CORRUPT",
        `the metering delegate key file at ${path} does not describe a delegate of ${agent} on chain ${chainId}`,
        path,
      );
    }
    return ok({ address, signer, path, created: false });
  };

  const loadOrCreate = (chainId: number, agent: Address): Result<DelegateKey> => {
    const existing = load(chainId, agent);
    if (!existing.ok) return existing;
    if (existing.value !== undefined) return ok(existing.value);

    const path = pathFor(chainId, agent);
    const signer = new Wallet(Wallet.createRandom().privateKey);
    const address = signer.address.toLowerCase() as Address;
    const file: DelegateFile = {
      version: 1,
      chainId,
      agent: agent.toLowerCase(),
      address,
      privateKey: signer.privateKey,
      createdAt: new Date().toISOString(),
    };
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      // `wx` refuses to replace a file another process wrote a moment ago.
      writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      // The mode on create is filtered by the umask, which can only narrow it; set it exactly anyway.
      if (process.platform !== "win32") chmodSync(path, 0o600);
    } catch (error) {
      return keyError("DELEGATE_KEY_UNWRITABLE", `a metering delegate key could not be written to ${path}`, path, error);
    }
    return ok({ address, signer, path, created: true });
  };

  return { directory, pathFor, load, loadOrCreate };
}
