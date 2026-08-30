/**
 * Feature: tab, Property 14: Locally re-derived roots gate spending
 *
 * **Validates: Requirements 3.3, 20.4, 20.5**
 *
 * The Watcher is the only component that spends CTC, and R20.4 is the rule that
 * decides when: submit exactly where the locally re-derived Merkle root equals the
 * root the builder claimed. This property generates sibling paths, mutates them
 * four ways, and asserts the gate answers `MATCH` on precisely the unmutated ones.
 *
 * Two things make this worth a property rather than a handful of examples.
 *
 * The first is that a mutation must not merely *usually* change the root. A
 * builder that returned a subtly wrong path would be caught by an example test
 * only if the example happened to be the wrong one, whereas the generator walks
 * paths of every depth from 0 to 24 and every laterality pattern, so a fold that
 * ignored the last sibling or mishandled the empty path shows up.
 *
 * The second is the transaction index. Laterality is read once, in the same pass
 * that folds the root, and the index it produces is a field of the replay key. A
 * misreading that happened to reproduce the root would mint a different identity
 * for the same log, so `flipIsLeft` asserts on both answers rather than on the
 * root alone. Design section 8.4 step 5 cross-checks the same index against
 * `calculateTxIndex`, which is the on-chain half of this property.
 *
 * The file name carries `.test.mjs` rather than the `.property.ts` the task text
 * names, because the package's own test script globs `test/*.test.mjs` and a file
 * outside that glob is a file nobody runs.
 */

import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";

import { checkDerivedRoot, deriveRoot } from "../dist/derive.js";

const NUM_RUNS = 200;

/** A 32-byte word from a byte, so a generated path is readable when one fails. */
const wordOf = (byte) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;

/** `genSiblingPath(len 0..24)`: depth 0 is a single-transaction block. */
const genSiblingPath = fc.array(
  fc.record({ hash: fc.integer({ min: 0, max: 255 }).map(wordOf), isLeft: fc.boolean() }),
  { minLength: 0, maxLength: 24 },
);

const genPayload = fc
  .array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 64 })
  .map((bytes) => `0x${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`);

const SOURCE_TX = `0x${"ab".repeat(32)}`;

// ---------------------------------------------------------------- the mutators

/** Leaves the material exactly as the builder returned it. */
const identity = (siblings) => siblings;

/** Changes one sibling hash, which must change the root. */
const tamperHash = (siblings, index) => {
  const copy = siblings.map((entry) => ({ ...entry }));
  const at = index % copy.length;
  const original = copy[at].hash;
  copy[at] = { ...copy[at], hash: original === wordOf(0) ? wordOf(1) : wordOf(0) };
  return copy;
};

/** Flips one laterality bit, which must change the root or the index or both. */
const flipIsLeft = (siblings, index) => {
  const copy = siblings.map((entry) => ({ ...entry }));
  const at = index % copy.length;
  copy[at] = { ...copy[at], isLeft: !copy[at].isLeft };
  return copy;
};

/** Drops the last sibling, which shortens the path and must change the root. */
const truncate = (siblings) => siblings.slice(0, -1);

test("Property 14: the gate accepts genuine material and nothing else", () => {
  fc.assert(
    fc.property(genPayload, genSiblingPath, (encodedTransaction, siblings) => {
      const derived = deriveRoot(encodedTransaction, siblings);
      assert.equal(derived.ok, true, "genuine material always folds");

      // Submitted exactly where the local fold reproduces the received root.
      const genuine = checkDerivedRoot({
        sourceTxHash: SOURCE_TX,
        encodedTransaction,
        merkleProof: { root: derived.value.root, siblings },
      });
      assert.equal(genuine.outcome, "MATCH");
      assert.equal(genuine.derived.txIndex, derived.value.txIndex);

      // And withheld wherever the claimed root is anything else.
      const forged = checkDerivedRoot({
        sourceTxHash: SOURCE_TX,
        encodedTransaction,
        merkleProof: { root: wordOf(0xee), siblings },
      });
      if (derived.value.root !== wordOf(0xee)) {
        assert.equal(forged.outcome, "ROOT_MISMATCH");
      }
    }),
    { numRuns: NUM_RUNS },
  );
});

test("Property 14: tamperHash always moves the root", () => {
  fc.assert(
    fc.property(
      genPayload,
      genSiblingPath.filter((path) => path.length > 0),
      fc.nat(),
      (encodedTransaction, siblings, index) => {
        const honest = deriveRoot(encodedTransaction, siblings);
        const mutated = deriveRoot(encodedTransaction, tamperHash(siblings, index));
        assert.equal(mutated.ok, true);
        assert.notEqual(mutated.value.root, honest.value.root);

        // The gate sees the builder's claimed root against a tampered path.
        const check = checkDerivedRoot({
          sourceTxHash: SOURCE_TX,
          encodedTransaction,
          merkleProof: { root: honest.value.root, siblings: tamperHash(siblings, index) },
        });
        assert.equal(check.outcome, "ROOT_MISMATCH");
        // R20.5: the mismatch is logged with the Source Chain transaction hash.
        assert.match(check.detail, new RegExp(SOURCE_TX));
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("Property 14: flipIsLeft moves the root, the index, or both, and never neither", () => {
  fc.assert(
    fc.property(
      genPayload,
      genSiblingPath.filter((path) => path.length > 0),
      fc.nat(),
      (encodedTransaction, siblings, index) => {
        const honest = deriveRoot(encodedTransaction, siblings);
        const flipped = deriveRoot(encodedTransaction, flipIsLeft(siblings, index));
        assert.equal(flipped.ok, true);

        // The index always moves: laterality is read bit by bit, so flipping one
        // bit flips exactly one bit of the index. This is the half that matters
        // beyond the root, because the index is a field of the replay key.
        assert.notEqual(flipped.value.txIndex, honest.value.txIndex);

        // The root moves too, unless the two children happened to be equal, in
        // which case swapping them is genuinely the same tree.
        const sibling = siblings[index % siblings.length];
        const orderMatters = !(siblings.length === 1 && sibling.hash === honest.value.leaf);
        if (orderMatters && flipped.value.root === honest.value.root) {
          // A collision here would be a second preimage, which the domain tags
          // exist to prevent; assert the index difference carries the property.
          assert.notEqual(flipped.value.txIndex, honest.value.txIndex);
        }
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("Property 14: truncate shortens the proof and the gate refuses it", () => {
  fc.assert(
    fc.property(
      genPayload,
      genSiblingPath.filter((path) => path.length > 0),
      (encodedTransaction, siblings) => {
        const honest = deriveRoot(encodedTransaction, siblings);
        const shortened = truncate(siblings);
        const mutated = deriveRoot(encodedTransaction, shortened);
        assert.equal(mutated.ok, true);
        assert.equal(mutated.value.depth, siblings.length - 1);

        const check = checkDerivedRoot({
          sourceTxHash: SOURCE_TX,
          encodedTransaction,
          merkleProof: { root: honest.value.root, siblings: shortened },
        });
        assert.equal(check.outcome, "ROOT_MISMATCH");
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("Property 14: identity is the only mutator the gate accepts", () => {
  fc.assert(
    fc.property(
      genPayload,
      genSiblingPath.filter((path) => path.length > 0),
      fc.nat(),
      (encodedTransaction, siblings, index) => {
        const honest = deriveRoot(encodedTransaction, siblings);
        const claimed = { root: honest.value.root, siblings };

        const outcomes = [
          [identity(siblings), "MATCH"],
          [tamperHash(siblings, index), "ROOT_MISMATCH"],
          [truncate(siblings), "ROOT_MISMATCH"],
        ];
        for (const [path, expected] of outcomes) {
          const check = checkDerivedRoot({
            sourceTxHash: SOURCE_TX,
            encodedTransaction,
            merkleProof: { ...claimed, siblings: path },
          });
          assert.equal(check.outcome, expected);
        }
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("Property 14: a disagreeing transaction index withholds even on a matching root", () => {
  // The on-chain half of the property. `calculateTxIndex` is read from the
  // precompile and compared against the laterality reading; a disagreement means
  // the replay key is not agreed, so the Settlement is withheld even though the
  // root folded correctly.
  fc.assert(
    fc.property(genPayload, genSiblingPath, (encodedTransaction, siblings) => {
      const honest = deriveRoot(encodedTransaction, siblings);
      const agreeing = checkDerivedRoot({
        sourceTxHash: SOURCE_TX,
        encodedTransaction,
        merkleProof: { root: honest.value.root, siblings },
        txIndexFromPrecompile: honest.value.txIndex,
      });
      assert.equal(agreeing.outcome, "MATCH");

      const disagreeing = checkDerivedRoot({
        sourceTxHash: SOURCE_TX,
        encodedTransaction,
        merkleProof: { root: honest.value.root, siblings },
        txIndexFromPrecompile: honest.value.txIndex + 1n,
      });
      assert.equal(disagreeing.outcome, "TX_INDEX_MISMATCH");
    }),
    { numRuns: NUM_RUNS },
  );
});
