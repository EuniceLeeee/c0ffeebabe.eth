import assert from "node:assert/strict";
import test from "node:test";
import { Interface, ZeroAddress, getAddress, toBeHex } from "ethers";
import { compileDeclarativeDiscovery, type DeclarativeMappedDiscovery } from
  "../venues/declarative-discovery.js";

// Activation is fixed when the production catalog loads. These overrides
// belong only to this isolated test process, never to production defaults.
process.env.SEARCHER_FAMILY_ALGEBRA_INTEGRAL_ENABLED = "1";
process.env.SEARCHER_FAMILY_KYBERSWAP_ELASTIC_ENABLED = "1";
const {
  candidateFingerprint, candidatesFromCall, candidatesFromLog,
  createRebuildWiring, rebuildCandidateCoverage, rebuildFamilyCandidateKey,
} = await import("../universe-rebuild-production.js");
const { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: catalog } =
  await import("../venues/production-family-composition.js");

const pool = getAddress("0x" + "ab".repeat(20));
const other = getAddress("0x" + "cd".repeat(20));
const token0 = toBeHex(1, 20), token1 = toBeHex(2, 20);
const manager = getAddress("0x000000000004444c5dc75cb358380d2e3de08a90");
const blockHash = toBeHex(100, 32), poolId = toBeHex(200, 32);
const concentrated = ["univ3-standard", "swap:algebra-integral", "kyberswap-elastic"];

function coverage(row: Readonly<Record<string, unknown>>) {
  const result = rebuildCandidateCoverage(row);
  assert(result, "complete declared candidate has coverage");
  return result;
}

test("real V3/Kyber log and V3/Algebra call candidates share one task, not one durable identity", () => {
  const abi = new Interface([
    "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
    "function swap(address,bool,int256,uint160,bytes)",
  ]);
  const event = abi.encodeEventLog(abi.getEvent("Swap")!, [token0, token1, 100n, -90n, 1n << 96n, 1000n, 0]);
  const logs = candidatesFromLog({ address: pool, ...event, blockNumber: 100, blockHash },
    ["univ3-standard", "kyberswap-elastic"]);
  assert.deepEqual(new Set(logs.map(row => row.familyId)), new Set(["univ3-standard", "kyberswap-elastic"]));
  const calls = candidatesFromCall({ kind: "call", target: pool, sender: token0,
    data: abi.encodeFunctionData("swap", [token0, true, 100n, 1n << 96n, "0x"]),
    transactionHash: toBeHex(300, 32), blockNumber: 100, blockHash, traceAddress: [],
  }, ["univ3-standard", "swap:algebra-integral"]);
  assert.deepEqual(new Set(calls.map(row => row.familyId)), new Set(["univ3-standard", "swap:algebra-integral"]));
  const bindings = [...logs, ...calls].map(coverage);
  assert.equal(new Set(bindings.map(row => row.key)).size, 1);
  assert.equal(new Set(logs.map(rebuildFamilyCandidateKey)).size, 2);
  assert.notEqual(bindings[0]!.fingerprint, bindings[1]!.fingerprint, "each Family retains its own rule binding");
  assert.notEqual(coverage({ ...logs[0], pool: other, address: other }).key, bindings[0]!.key);
  assert.equal(bindings[0]!.candidateFingerprint, candidateFingerprint(logs[0]!));
  const newEvidence = { ...logs[0], logIndex: 999 };
  assert.equal(coverage(newEvidence).key, bindings[0]!.key);
  assert.notEqual(coverage(newEvidence).fingerprint, bindings[0]!.fingerprint, "coverage binds the full candidate evidence snapshot");
});

test("V4 replacement scope includes both manager and pool ID; partial nominations cannot claim coverage", () => {
  const row = { familyId: "univ4", candidateKind: "univ4-pool-key", address: pool, manager: pool, poolId };
  const original = coverage(row), feeHook = coverage({ ...row, familyId: "univ4-fee-hook" });
  assert.equal(original.key, feeHook.key);
  assert.notEqual(original.fingerprint, feeHook.fingerprint);
  assert.notEqual(original.key, coverage({ ...row, poolId: toBeHex(201, 32) }).key);
  assert.notEqual(original.key, coverage({ ...row, manager: other, address: other }).key);
  assert.equal(original.key, coverage({ ...row, manager: undefined }).key, "retained address envelope supplies the declared manager field");
  assert.equal(rebuildCandidateCoverage({ ...row, poolId: undefined }), null);
  assert.equal(rebuildCandidateCoverage({ ...row, candidateKind: "other-capability" }), null);
  assert.equal(rebuildCandidateCoverage({ ...row, familyId: "custom-swap:angstrom-v4" }), null,
    "signed execution capability is not replaced by this group");
});

test("independent capabilities at the same address do not inherit coverage", () => {
  for (const familyId of ["curve-plain", "curve-underlying", "protocol:erc4626", "protocol:erc4626-silo-redeem",
    "protocol:staked-usdat", "flash-loan:balancer-v2", "flash-loan:morpho"]) {
    assert.equal(rebuildCandidateCoverage({ familyId, address: pool, pool, vault: pool, poolId }), null, familyId);
  }
  const wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: ["univ4"] });
  assert.equal(wiring.candidateCoverage!({ familyId: "univ4-fee-hook", address: pool, manager: pool, poolId }), null,
    "out-of-scope Family never supplies a winner or loser binding");
  assert(wiring.candidateCoverage!({ familyId: "univ4", address: pool, manager: pool, poolId }),
    "coverage projection is synchronous local work, with no reachable RPC");
});

test("all enabled replacement-group members project both directions of the same swap task", () => {
  const source = { number: 100, hash: blockHash, generation: 1 };
  for (const familyId of [...concentrated, "univ4", "univ4-fee-hook"]) {
    const plugin = catalog.forFamily(familyId as never).plugin;
    const singleton = familyId === "univ4" || familyId === "univ4-fee-hook";
    const descriptor: any = {
      familyId, lineageId: plugin.manifest.supportedLineages[0],
      instanceKey: singleton ? manager.toLowerCase() + "\u001f" + poolId : pool.toLowerCase(),
      provenance: [], runtimeRequirements: [], pool, token0, token1, fee: 3000, tickSpacing: 60,
      feeUnits: 3000, tickDistance: 60, factoryBinding: { factory: other, reversePool: pool },
      swapAccess: { kind: "public", codeHash: blockHash },
      quoterBinding: { quoter: other, router: other, provenance: [] },
      executedFee: { kind: "global-state-last-fee", fee: 3000n, plugin: ZeroAddress, pluginConfig: 0 },
      poolId, poolKey: { currency0: token0, currency1: token1, fee: 3000, tickSpacing: 60,
        hooks: familyId === "univ4-fee-hook" ? other : ZeroAddress },
      graphToken0: token0, graphToken1: token1,
      managerBinding: { manager, stateView: other, quoter: other, managerCodeHash: blockHash },
      hookPolicy: familyId === "univ4-fee-hook" ? "fee-hook" : "no-hook", hook: other,
    };
    const routes = plugin.routes.project({ descriptor, source } as never);
    assert.equal(routes.length, 2, familyId);
    assert.deepEqual(new Set(routes.map(route => `${route.tokenIn.toLowerCase()}:${route.tokenOut.toLowerCase()}`)),
      new Set([`${token0}:${token1}`, `${token1}:${token0}`]), familyId);
    assert(routes.every(route => route.taxonomy.slotKind === "swap"), familyId);
    for (const route of routes) {
      assert.equal(plugin.routes.projectGraph!({ descriptor, route } as never).executionTarget.toLowerCase(),
        (singleton ? manager : pool).toLowerCase(), familyId);
    }
  }
});

function definition(): DeclarativeMappedDiscovery {
  return {
    version: 2, sources: ["observed-call"], candidateSources: [], labels: ["coverage-fixture"], nomination: "tx-evidence",
    candidate: { kind: "coverage-fixture", addressField: "manager", fields: { manager: "address", poolId: "bytes32" },
      key: ["manager", "poolId"], coverage: { group: "fixture-swap-v1", key: ["manager", "poolId"] } },
    calls: [{ id: "read", signature: "read(bytes32)", fields: { manager: { from: "target" }, poolId: { from: "argument", index: 0 } } }], events: [],
  };
}

test("coverage is explicit, validated and scoped by a declaration rather than an address heuristic", () => {
  const first = compileDeclarativeDiscovery(definition());
  const secondSpec = definition(); (secondSpec.candidate.coverage as any).group = "independent-capability-v1";
  const second = compileDeclarativeDiscovery(secondSpec);
  const row = { manager: pool, poolId };
  assert.notEqual(first.candidateCoverageKey!(row), second.candidateCoverageKey!(row));
  const omitted = definition(); delete (omitted.candidate as any).coverage;
  assert.equal(compileDeclarativeDiscovery(omitted).candidateCoverageKey, undefined);
  for (const invalid of [null, {}, { group: "", key: ["manager"] }, { group: "g", key: ["poolId"] },
    { group: "g", key: ["manager", "missing"] }, { group: "g", key: ["manager", "manager"] }]) {
    const spec = definition(); (spec.candidate as any).coverage = invalid;
    assert.throws(() => compileDeclarativeDiscovery(spec), /coverage/);
  }
  for (const value of [null, [], {}, { manager: "bad", poolId }, { manager: pool, poolId: "0x" }]) {
    assert.equal(first.candidateCoverageKey!(value), null);
  }
});
