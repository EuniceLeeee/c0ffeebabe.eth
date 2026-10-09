// Offline only: real production lifecycle/default limits with synthetic replies.
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { executeAdapterFamilyLifecycleBatch } from "../venues/adapter-family-runtime.js";
import { capabilityManifestHash, FAMILY_CAPABILITY_NAMES, FamilyCapabilityCatalog } from "../venues/family-capability-catalog.js";
import { defineProtocolFamily, definedFamilyPluginContractSummary } from "../venues/adapter-family-plugin.js";
import { plugin } from "../venues/production-families/erc4626.production.js";
import { erc4626Identity } from "../venues/protocols/erc4626-family/identity.js";
import { ERC4626_INTERFACE, ERC4626_ERC20_INTERFACE, ERC4626_PROBE_ACTOR } from "../venues/protocols/erc4626-family/abi.js";
import { CACHED_BYTECODE } from "../venues/protocols/erc4626-family/test/custodian-bytecode.js";

const vault = "0x1111111111111111111111111111111111111111";
const asset = "0x2222222222222222222222222222222222222222";
const implementation = "0x3333333333333333333333333333333333333333";
const source = { number: 25778225, hash: ethers.id("erc4626-default-identity-budget"), generation: 1 };
const word = (amount: bigint) => ethers.toBeHex(amount, 32);
const erc = new ethers.Interface([...ERC4626_INTERFACE.fragments, ...ERC4626_ERC20_INTERFACE.fragments]);

// Define a separate test Family without mutating the installed frozen slots.
// Opaque runtime objects/functions stay intact; branded actions are not cloned.
function mutableFixtureSlots<T>(value: T): T {
  if (Array.isArray(value)) return value.map(mutableFixtureSlots) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mutableFixtureSlots(child)])) as T;
  }
  return value;
}

async function proxyCase(extraRound: boolean, limit?: number) {
  const selected = extraRound ? defineProtocolFamily({
    manifest: plugin.manifest, capture: { ...plugin.capture }, discovery: { ...plugin.discovery },
    identity: { ...erc4626Identity, variants: erc4626Identity.variants.map((variant, index) => index === 0 ? {
      ...variant,
      decide(input) {
        const decision = variant.decide(input);
        // Fixture asks for an unnecessary sixth round. The production ceiling
        // must stop before it can declare or execute a sixth batch.
        return input.step === 5 && decision.status === "verified" ? { status: "continue" as const } : decision;
      },
    } : { ...variant }) },
    instance: { ...plugin.instance }, routes: { ...plugin.routes }, pricing: mutableFixtureSlots(plugin.pricing),
    exact: { ...plugin.exact }, execution: { ...plugin.execution }, protocol: { ...plugin.protocol },
    actionAdapters: plugin.actionAdapters,
  }) : plugin;
  const entries = FAMILY_CAPABILITY_NAMES.map(capability => ({ familyId: selected.manifest.familyId, capability,
    contractVersion: "erc4626-budget-fixture", contentHash: ethers.id(`fixture:${capability}`).slice(2),
    semanticDependencies: [`contract:${capability}`], provenanceCommit: null }));
  const catalog = new FamilyCapabilityCatalog({ modules: [{ plugin: selected, sourceFile: "fixture/erc4626.production.ts",
    definitionBoundaryHash: definedFamilyPluginContractSummary(selected).definitionBoundaryHash }],
    generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) } });
  const calls: string[] = [];
  const runtime = createStrictCentralAdapterRuntime({ executor: "0x1000000000000000000000000000000000000002",
    verifiedActors: { "erc4626-probe-actor": ERC4626_PROBE_ACTOR },
    generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); } },
    provider: {
      async getCode(address, block) { assert.equal(block, source.number); return address.toLowerCase() === vault ? CACHED_BYTECODE.proxy : "0x6002"; },
      async getStorage(_address, _slot, block) { assert.equal(block, source.number); return word(BigInt(implementation)); },
      async call(tx, block) {
        assert.equal(block, source.number);
        const call = erc.parseTransaction({ data: tx.data });
        if (!call) throw Object.assign(new Error("fixture unknown standard view"), { data: "0x" });
        const value = call.name === "asset" ? asset : call.name === "decimals" ? 18
          : call.name === "balanceOf" ? 0n : call.name === "totalSupply" ? 10n ** 22n
          : call.name === "totalAssets" ? 2n * 10n ** 22n
          : call.name === "previewDeposit" || call.name === "convertToShares" ? BigInt(call.args[0]) / 2n
          : call.name === "previewRedeem" || call.name === "convertToAssets" ? BigInt(call.args[0]) * 2n : null;
        assert(value !== null, `unexpected fixture method ${call.name}`);
        return erc.encodeFunctionResult(call.name, [value]);
      },
    },
    simulator: { async simulate({ request }) {
      calls.push(request.id);
      const call = ERC4626_INTERFACE.parseTransaction({ data: request.call.data })!;
      const amount = BigInt(call.args[0]), deposit = call.name === "deposit";
      if (deposit && amount === 10n ** 6n) throw Object.assign(new Error("fixture deposit reverted: minimum amount"), { code: "CALL_EXCEPTION", data: "0x12345678" });
      const assets = deposit ? amount : amount * 2n, shares = deposit ? amount / 2n : amount;
      const event = ERC4626_INTERFACE.encodeEventLog(ERC4626_INTERFACE.getEvent(deposit ? "Deposit" : "Withdraw")!, deposit
        ? [ERC4626_PROBE_ACTOR, ERC4626_PROBE_ACTOR, assets, shares]
        : [ERC4626_PROBE_ACTOR, ERC4626_PROBE_ACTOR, ERC4626_PROBE_ACTOR, assets, shares]);
      return { data: word(deposit ? shares : assets), effects: {
        tokenDeltas: [{ token: asset, account: ERC4626_PROBE_ACTOR, delta: deposit ? -assets : assets },
          { token: vault, account: ERC4626_PROBE_ACTOR, delta: deposit ? shares : -shares }],
        totalSupplyDeltas: [{ token: vault, delta: deposit ? shares : -shares }],
        logs: [{ address: vault, ...event }],
      } };
    } },
  });
  const observation = { kind: "call" as const, source, target: vault,
    data: ERC4626_INTERFACE.encodeFunctionData("deposit", [10n ** 6n, ERC4626_PROBE_ACTOR]) };
  const matches = catalog.matches(observation).map(match => ({ matchedPatternId: match.patternId, observation }));
  assert(matches.length > 0);
  const result = await executeAdapterFamilyLifecycleBatch({ family: catalog.forFamily(selected.manifest.familyId),
    source, generation: source.generation, runtime, matches, publisher: { publish() {} },
    ...(limit === undefined ? {} : { limits: { maxIdentityStepsPerVariant: limit } }),
  });
  return { result, calls };
}

const full = await proxyCase(false);
assert.equal(full.result.publication?.instances.length, 1, JSON.stringify(full.result.outcomes));
assert.deepEqual(full.result.publication!.instances[0]!.routes.map(route => route.taxonomy.protocolAction).sort(), ["redeem", "wrap"]);
assert.deepEqual(full.calls, ["active-deposit", "active-redeem", "fallback-deposit"]);
for (const [extra, limit] of [[true, undefined], [false, 4]] as const) {
  const bounded = await proxyCase(extra, limit);
  assert.equal(bounded.result.publication?.instances.length ?? 0, 0);
  assert(bounded.result.outcomes.some(outcome => outcome.stage === "identity" && outcome.status === "unresolved" &&
    outcome.reasonCode.includes("identity-step-budget-exhausted")), JSON.stringify(bounded.result.outcomes));
  assert.deepEqual(bounded.calls, limit === 4 ? ["active-deposit", "active-redeem"] : full.calls);
}
console.log("erc4626-deposit-lifecycle PASS (default five rounds, sixth blocked, explicit four honored)");
