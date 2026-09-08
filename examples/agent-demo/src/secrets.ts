/**
 * Keys, kept in one place and read as late as possible.
 *
 * A read-only pass never touches this file's values, which is the point: the
 * whole demo can be watched, and every claim it makes checked, by somebody
 * holding no key at all. Only `--broadcast` reaches for one, and it reaches for
 * exactly the one role that act needs rather than loading them all at start-up.
 *
 * Nothing here is ever logged, formatted, or placed in an act's `detail`. The
 * accessors return the key itself; every diagnostic returns the **role** whose
 * key is absent.
 */

import type { Result } from "@tabai/shared";
import { err, ok } from "@tabai/shared";

/** The roles this demo can sign as. */
export type DemoRole =
  | "agent-one-creditcoin"
  | "agent-one-ethereum"
  | "agent-two-creditcoin"
  | "agent-two-ethereum"
  | "service-operator";

/** The environment variable each role's key is declared under. */
export const ROLE_ENV_NAME: Readonly<Record<DemoRole, string>> = {
  "agent-one-creditcoin": "AGENT_CREDITCOIN_PRIVATE_KEY",
  "agent-one-ethereum": "AGENT_ETHEREUM_PRIVATE_KEY",
  "agent-two-creditcoin": "DEMO_AGENT_TWO_CREDITCOIN_PRIVATE_KEY",
  "agent-two-ethereum": "DEMO_AGENT_TWO_ETHEREUM_PRIVATE_KEY",
  "service-operator": "GATEWAY_PRIVATE_KEY",
};

export interface DemoSecrets {
  /** The key for a role, or a refusal naming the variable that is not set. */
  keyFor(role: DemoRole): Result<string>;
  /** Whether a role's key is present, without returning it. */
  has(role: DemoRole): boolean;
}

/** Builds the accessor over a record of raw values. Pure, so tests need no environment. */
export function createSecrets(values: Readonly<Record<string, string | undefined>>): DemoSecrets {
  const lookup = (role: DemoRole): string | undefined => {
    const raw = values[ROLE_ENV_NAME[role]];
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    return trimmed === "" ? undefined : trimmed;
  };
  return {
    has: (role) => lookup(role) !== undefined,
    keyFor: (role): Result<string> => {
      const key = lookup(role);
      if (key === undefined) {
        return err({
          category: "VALIDATION",
          code: "DEMO_KEY_ABSENT",
          message: `this act signs as ${role} and ${ROLE_ENV_NAME[role]} is not set`,
          retryable: false,
        });
      }
      if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
        return err({
          category: "VALIDATION",
          code: "DEMO_KEY_MALFORMED",
          message: `${ROLE_ENV_NAME[role]} is not a 32-byte 0x private key`,
          retryable: false,
        });
      }
      return ok(key);
    },
  };
}

/** The single point where this package reads a key from the environment. */
export function processDemoSecrets(): DemoSecrets {
  return createSecrets({
    AGENT_CREDITCOIN_PRIVATE_KEY: process.env.AGENT_CREDITCOIN_PRIVATE_KEY,
    AGENT_ETHEREUM_PRIVATE_KEY: process.env.AGENT_ETHEREUM_PRIVATE_KEY,
    DEMO_AGENT_TWO_CREDITCOIN_PRIVATE_KEY: process.env.DEMO_AGENT_TWO_CREDITCOIN_PRIVATE_KEY,
    DEMO_AGENT_TWO_ETHEREUM_PRIVATE_KEY: process.env.DEMO_AGENT_TWO_ETHEREUM_PRIVATE_KEY,
    GATEWAY_PRIVATE_KEY: process.env.GATEWAY_PRIVATE_KEY,
  });
}

/** The Creditcoin signing role for an Agent at a given index in the cast. */
export const creditcoinRoleFor = (index: number): DemoRole =>
  index === 0 ? "agent-one-creditcoin" : "agent-two-creditcoin";

/** The Source Chain signing role for an Agent at a given index in the cast. */
export const ethereumRoleFor = (index: number): DemoRole =>
  index === 0 ? "agent-one-ethereum" : "agent-two-ethereum";
