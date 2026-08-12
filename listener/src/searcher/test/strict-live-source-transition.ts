import assert from "node:assert/strict";
import {
  resolveCanonicalSourceTransition,
} from "../live-discovery-coordinator.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

function fixtureBlock(
  number: number,
  hash: string,
  parentHash: string,
): {
  readonly number: number;
  readonly hash: string;
  readonly parentHash: string;
} {
  return Object.freeze({ number, hash, parentHash });
}

function fixtureProvider(
  blocks: ReadonlyMap<number, {
    readonly number: number;
    readonly hash: string;
    readonly parentHash: string;
  }>,
) {
  return Object.freeze({
    getBlock: async (id: string | number) => {
      if (typeof id === "number") return blocks.get(id) ?? null;
      for (const block of blocks.values()) {
        if (block.hash === id) return block;
      }
      return null;
    },
  });
}

function source(number: number, hash: string): CanonicalSource {
  return Object.freeze({ number, hash, generation: 0 });
}

const h = (byte: string, count = 32) =>
  `0x${byte.repeat(count)}`;
const blocks = new Map([
  [100, fixtureBlock(100, h("aa"), h("99"))],
  [101, fixtureBlock(101, h("bb"), h("aa"))],
  [102, fixtureBlock(102, h("cc"), h("bb"))],
  [103, fixtureBlock(103, h("dd"), h("cc"))],
]);
const provider = fixtureProvider(blocks) as never;

assert.equal(
  await resolveCanonicalSourceTransition(
    provider,
    source(100, h("aa")),
    source(101, h("bb")),
  ),
  "canonical-descendant",
  "adjacent canonical child must resolve as descendant",
);
assert.equal(
  await resolveCanonicalSourceTransition(
    provider,
    source(101, h("bb")),
    source(103, h("dd")),
  ),
  "canonical-descendant",
  "a multi-block canonical jump must still resolve as descendant",
);
assert.equal(
  await resolveCanonicalSourceTransition(
    provider,
    source(102, h("cc")),
    source(103, h("dd")),
  ),
  "canonical-descendant",
  "direct parent must resolve as descendant",
);
assert.equal(
  await resolveCanonicalSourceTransition(
    provider,
    source(101, h("ee")),
    source(103, h("dd")),
  ),
  "unresolved",
  "a hash not on the current canonical chain must not resolve",
);
assert.equal(
  await resolveCanonicalSourceTransition(
    provider,
    source(103, h("dd")),
    source(100, h("aa")),
  ),
  "unresolved",
  "a non-ascending source pair must not resolve",
);
assert.equal(
  await resolveCanonicalSourceTransition(
    provider,
    source(100, h("aa")),
    source(103, h("dd")),
    2,
  ),
  "unresolved",
  "the bounded ancestor walk must fail closed beyond maxDepth",
);

console.log("strict-live-source-transition PASS");
