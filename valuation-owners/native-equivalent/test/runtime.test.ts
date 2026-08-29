import assert from "node:assert/strict";
import test from "node:test";
import { erc20AssetReferenceV1 } from "../../../packages/asset-ref/src/index.ts";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { createNativeEquivalentValuationOwnerV1 } from "../src/runtime.ts";

const h = (value: string): Hash => hashDomain("test/native-equivalent-valuation", value);
const qualification = Object.freeze({
  implementationClosureRoot: h("closure"),
  qualificationLeafDigest: h("leaf"),
  valuationOwnerRegistryRoot: h("registry"),
  qualifiedValuationOwnerSetRoot: h("qualified-set"),
});
const source = Object.freeze({ chainId: "1", number: "10", hash: h("block"), stateRoot: h("state") });

test("mainnet WETH produces an async release-qualified current-source fact", async () => {
  const owner = createNativeEquivalentValuationOwnerV1(qualification);
  const fact = await owner.observeCurrentSource({
    generationId: "generation-1",
    source,
    asset: erc20AssetReferenceV1("1", "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"),
  });
  assert.equal(fact.numerator, "1");
  assert.equal(fact.denominator, "1");
  assert.equal(fact.valuationOwnerRegistryRoot, qualification.valuationOwnerRegistryRoot);
  assert.equal(fact.qualificationLeafDigest, qualification.qualificationLeafDigest);
  assert.match(fact.currentSourceObservationRoot, /^0x[0-9a-f]{64}$/);
});

test("foreign asset and chain fail closed", async () => {
  const owner = createNativeEquivalentValuationOwnerV1(qualification);
  await assert.rejects(() => owner.observeCurrentSource({
    generationId: "generation-1",
    source,
    asset: erc20AssetReferenceV1("1", "0x0000000000000000000000000000000000000001"),
  }), /does not support/);
  await assert.rejects(() => owner.observeCurrentSource({
    generationId: "generation-1",
    source: { ...source, chainId: "10" },
    asset: erc20AssetReferenceV1("10", "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"),
  }), /does not support/);
});
