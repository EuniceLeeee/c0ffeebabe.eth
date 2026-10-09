import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { VAULT, assertRouterQuoteCompatible } from "../codec.js";
import { classifyStableSurgeCode, classifyStableSurgePoolCode, stableSurgeFlags } from "../stable-surge.js";
import { STABLE_SURGE_TEMPLATES } from "../stable-surge-templates.js";
import { syntheticStableSurgeCode, syntheticStableSurgePoolCode } from "./stable-surge-fixture.js";
import { STABLE_SURGE_POOL_TEMPLATES } from "../stable-surge-pool-template.js";
import { classifyBalancerPoolCode } from "../local-model.js";

const HOOK = "0x1000000000000000000000000000000000000042";
const FLAGS = Array.from({ length: 10 }, (_, i) => [3, 7, 9].includes(i));
for (const template of STABLE_SURGE_TEMPLATES) {
  test(`${template.model}: full runtime, both Vault bindings, self auth and bounded defaults`, () => {
    const code = syntheticStableSurgeCode(template.model, HOOK);
    assert.equal(classifyStableSurgeCode(code, VAULT, HOOK), template.model);
    assert.equal(classifyStableSurgeCode(code, VAULT, ethers.ZeroAddress), null);
    assert.equal(classifyStableSurgeCode(code, HOOK, HOOK), null);
    assert.equal(classifyStableSurgeCode(code, VAULT, "0x1000000000000000000000000000000000000043"), null);
    for (const overrides of [{ _vault: 1n }, { _actionIdDisambiguator: BigInt(VAULT) },
      { _defaultMaxSurgeFeePercentage: 10n ** 18n + 1n }, { _defaultSurgeThresholdPercentage: 10n ** 18n + 1n }]) {
      assert.equal(classifyStableSurgeCode(syntheticStableSurgeCode(template.model, HOOK, overrides), VAULT, HOOK), null);
    }
    for (const value of [0n, 10n ** 18n]) {
      assert.equal(classifyStableSurgeCode(syntheticStableSurgeCode(template.model, HOOK,
        { _defaultMaxSurgeFeePercentage: value, _defaultSurgeThresholdPercentage: value }), VAULT, HOOK), template.model);
    }
    if (template.model === "stable-surge-v1") {
      for (const value of [0n, 1n << 160n]) assert.equal(classifyStableSurgeCode(
        syntheticStableSurgeCode(template.model, HOOK, { _allowedPoolFactory: value }), VAULT, HOOK), null);
      assert.equal(classifyStableSurgeCode(syntheticStableSurgeCode(template.model, HOOK,
        { _allowedPoolFactory: 987654n }), VAULT, HOOK), template.model, "no factory-address allowlist");
    }
    const bytes = Buffer.from(code.slice(2), "hex"); bytes[0] ^= 1;
    assert.equal(classifyStableSurgeCode("0x" + bytes.toString("hex"), VAULT, HOOK), null, "changed instruction");
    for (const immutable of template.immutableReferences.filter(i => i.offsets.length > 1)) {
      const bytes = Buffer.from(code.slice(2), "hex"); bytes[immutable.offsets[1] + 31] ^= 1;
      assert.equal(classifyStableSurgeCode("0x" + bytes.toString("hex"), VAULT, HOOK), null, "inconsistent immutable copies");
    }
    assert.equal(classifyStableSurgeCode(code + "00", VAULT, HOOK), null);
    assert.equal(classifyStableSurgeCode("0x6000", VAULT, HOOK), null);
    const hook = { flags: FLAGS, stableSurgeModel: template.model };
    for (const pool of ["stable-v1", "stable-v2", "stable-v3", ...STABLE_SURGE_POOL_TEMPLATES.map(t => t.model)]) {
      assert.doesNotThrow(() => assertRouterQuoteCompatible(hook, pool));
    }
    for (const pool of [null, "weighted-v1", "custom"]) assert.throws(() => assertRouterQuoteCompatible(hook, pool), /unsupported-swap-hook/);
  });
}
test("unproven or modified Hook flags never gain Router compatibility", () => {
  assert(stableSurgeFlags(FLAGS));
  assert.throws(() => assertRouterQuoteCompatible({ flags: FLAGS }, "stable-v2"), /unsupported-swap-hook/);
  for (let index = 0; index < 10; index++) {
    const flags = FLAGS.map((flag, i) => i === index ? !flag : flag);
    assert.equal(stableSurgeFlags(flags), false);
    if (flags[0] || flags[3] || flags[4] || flags[5]) assert.throws(() => assertRouterQuoteCompatible(
      { flags, stableSurgeModel: "stable-surge-v2" }, "stable-v2"), /unsupported-swap-hook/);
  }
});

for (const template of STABLE_SURGE_POOL_TEMPLATES) test(`${template.model}: behavior proof, not a local pricing model`, () => {
  const pool = "0x1000000000000000000000000000000000000051";
  const code = syntheticStableSurgePoolCode(pool, {}, template.model);
  assert.equal(classifyStableSurgePoolCode(code, VAULT, pool), template.model);
  assert.equal(classifyBalancerPoolCode(code), null);
  for (const overrides of [{ _vault: 1n }, { _actionIdDisambiguator: 0n }, { _actionIdDisambiguator: 1n << 160n },
    { _cachedThis: 1n }, { _cachedChainId: 2n }]) assert.equal(classifyStableSurgePoolCode(
      syntheticStableSurgePoolCode(pool, overrides, template.model), VAULT, pool), null);
  for (const immutable of template.immutableReferences.filter(i => i.offsets.length > 1)) {
    const bytes = Buffer.from(code.slice(2), "hex"); bytes[immutable.offsets[1] + 31] ^= 1;
    assert.equal(classifyStableSurgePoolCode("0x" + bytes.toString("hex"), VAULT, pool), null);
  }
  const bytes = Buffer.from(code.slice(2), "hex"); bytes[0] ^= 1;
  assert.equal(classifyStableSurgePoolCode("0x" + bytes.toString("hex"), VAULT, pool), null);
  assert.equal(classifyStableSurgePoolCode(code + "00", VAULT, pool), null);
});
