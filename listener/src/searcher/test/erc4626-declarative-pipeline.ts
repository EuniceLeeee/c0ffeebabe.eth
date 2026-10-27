import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { inspectRuntime } from "./runtime-program-testkit.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { runStrictFamilyLifecycle } from "../strict-family-lifecycle-runner.js";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../venues/production-family-composition.js";
import { PRODUCTION_STRICT_VERIFIED_ACTORS } from "../venues/production-verified-actors.js";
import { buildFamilyExecutionFragment, buildFamilyRuntimeAmountLeg, executeFamilyExactQuote } from "../venues/adapter-family-runtime.js";
import type { UnifiedObservation } from "../venues/adapter-family-plugin.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";
import { ERC4626_FAMILY_ID } from "../venues/protocols/erc4626-family/manifest.js";
import { ERC4626_INTERFACE as vaultAbi, ERC4626_ERC20_INTERFACE as tokenAbi, ERC4626_PROBE_ACTOR as actor } from "../venues/protocols/erc4626-family/abi.js";
import { INFINIFI_GATEWAY, INFINIFI_ABI } from "../venues/protocols/erc4626-family/infinifi.js";
import type { Erc4626Descriptor } from "../venues/protocols/erc4626-family/types.js";
import definition from "../venues/protocols/erc4626-family/erc4626.json";

// Synthetic transport only: catalog, discovery, identity, scheduling,
// publication, Graph projection and execution builders are production code.
// This is not historical Ready, EVM execution or performance evidence.
const VAULT = "0x1111111111111111111111111111111111111111";
const ASSET = "0x2222222222222222222222222222222222222222";
const EXECUTOR = "0x3333333333333333333333333333333333333333";
const RECIPIENT = "0x4444444444444444444444444444444444444444";
const SOURCE: CanonicalSource = Object.freeze({ number: 25_778_225, hash: `0x${"ab".repeat(32)}`, generation: 1 });
const family = catalog.forFamily(ERC4626_FAMILY_ID);
type Direction = "deposit" | "redeem";
type ProofMode = "valid" | "revert" | "zero-debit";
const observation: UnifiedObservation = {
  kind: "call", source: SOURCE, target: VAULT,
  data: vaultAbi.encodeFunctionData("deposit", [1_000_000n, actor]),
};

function fixture(options: { deposit?: ProofMode; redeem?: ProofMode; missingActor?: boolean } = {}) {
  const calls: { name: string; amount?: bigint }[] = [];
  const probes: { direction: Direction; amount: bigint }[] = [];
  const unexpected: string[] = [];
  let transportCount = 0;
  function pinned(block?: number) {
    transportCount++;
    assert.equal(block, SOURCE.number);
  }
  const runtime = createStrictCentralAdapterRuntime({
    executor: EXECUTOR,
    verifiedActors: options.missingActor ? {} : PRODUCTION_STRICT_VERIFIED_ACTORS,
    generationFence: { assertCurrent(generation, source) {
      assert.equal(generation, SOURCE.generation);
      assert.deepEqual(source, SOURCE);
    } },
    provider: {
      async getCode(address, block) {
        pinned(block);
        if (address.toLowerCase() === VAULT) return "0x6001";
        if (address.toLowerCase() === ASSET) return "0x6002";
        if (address.toLowerCase() === INFINIFI_GATEWAY.toLowerCase()) return "0x";
        unexpected.push(`code:${address}`);
        throw new Error("unexpected fixture code request");
      },
      async getStorage(address, _slot, block) {
        pinned(block);
        unexpected.push(`storage:${address}`);
        throw new Error("standard fixture has no proxy storage");
      },
      async call(tx, block) {
        pinned(block ?? tx.blockTag);
        // The retained InfiniFi variant must independently prove a nonmatch.
        if (tx.to.toLowerCase() === INFINIFI_GATEWAY.toLowerCase()) {
          assert.equal(INFINIFI_ABI.parseTransaction({ data: tx.data })?.name, "getAddress");
          return "0x";
        }
        const abi = tokenAbi.getFunction(tx.data.slice(0, 10)) ? tokenAbi : vaultAbi;
        const parsed = abi.parseTransaction({ data: tx.data });
        assert(parsed);
        const name = parsed.name, amount = parsed.args.length ? BigInt(parsed.args[0]) : undefined;
        calls.push({ name, amount });
        assert([VAULT, ASSET].includes(tx.to.toLowerCase()));
        if (name === "decimals") return abi.encodeFunctionResult(name, [18]);
        if (name === "balanceOf") return abi.encodeFunctionResult(name, [0n]);
        assert.equal(tx.to.toLowerCase(), VAULT);
        if (name === "asset") return abi.encodeFunctionResult(name, [ASSET]);
        if (name === "totalAssets") return abi.encodeFunctionResult(name, [2n * 10n ** 24n]);
        if (name === "totalSupply") return abi.encodeFunctionResult(name, [10n ** 24n]);
        if (["convertToShares", "previewDeposit"].includes(name)) return abi.encodeFunctionResult(name, [amount! / 2n]);
        if (["convertToAssets", "previewRedeem"].includes(name)) return abi.encodeFunctionResult(name, [amount! * 2n]);
        unexpected.push(`call:${name}`);
        throw new Error("unexpected fixture call");
      },
    },
    simulator: { async simulate({ request, source, callerAuthority }) {
      transportCount++;
      assert.deepEqual(source, SOURCE);
      assert.equal(callerAuthority.verifiedActors?.["erc4626-probe-actor"], actor.toLowerCase());
      assert.equal(request.call.to.toLowerCase(), VAULT);
      const parsed = vaultAbi.parseTransaction({ data: request.call.data });
      assert(parsed?.name === "deposit" || parsed?.name === "redeem");
      const direction = parsed.name, amount = BigInt(parsed.args[0]), deposit = direction === "deposit";
      assert.equal(String(parsed.args[1]).toLowerCase(), actor.toLowerCase());
      if (!deposit) assert.equal(String(parsed.args[2]).toLowerCase(), actor.toLowerCase());
      probes.push({ direction, amount });
      if (options[direction] === "revert") throw Object.assign(new Error("fixture completed revert"), { code: "CALL_EXCEPTION", data: "0x" });
      const output = deposit ? amount / 2n : amount * 2n;
      const event = vaultAbi.encodeEventLog(vaultAbi.getEvent(deposit ? "Deposit" : "Withdraw")!,
        deposit ? [actor, actor, amount, output] : [actor, actor, actor, output, amount]);
      return { data: vaultAbi.encodeFunctionResult(direction, [output]), effects: {
        tokenDeltas: [
          { token: deposit ? ASSET : VAULT, account: actor, delta: options[direction] === "zero-debit" ? 0n : -amount },
          { token: deposit ? VAULT : ASSET, account: actor, delta: output },
        ],
        totalSupplyDeltas: [{ token: VAULT, delta: deposit ? output : -amount }],
        logs: [{ address: VAULT, topics: event.topics, data: event.data }],
      } };
    } },
  });
  return { runtime, calls, probes, unexpected, transportCount: () => transportCount,
    publish: () => runStrictFamilyLifecycle({ catalog, familyId: ERC4626_FAMILY_ID, source: SOURCE, observations: [observation], runtime }) };
}

// Inspect the actual emitted program with a different runtime input from the
// preceding Exact quote. This synthetic host checks ABI wiring, not EVM behavior.
function assertRuntimeEncoding(program: string, direction: Direction, recipient: string) {
  const amount = 91n, deposit = direction === "deposit", output = deposit ? 45n : 182n;
  const inputToken = deposit ? ASSET : VAULT, outputToken = deposit ? VAULT : ASSET;
  const key = (token: string, account: string) => `${token.toLowerCase()}:${account.toLowerCase()}`;
  const balances = new Map<string, bigint>([
    [key(inputToken, EXECUTOR), amount + 101n], [key(outputToken, EXECUTOR), 103n],
    [key(inputToken, RECIPIENT), 107n], [key(outputToken, RECIPIENT), 109n],
  ]);
  const get = (token: string, account: string) => balances.get(key(token, account)) ?? 0n;
  const before = get(outputToken, recipient);
  let operations = 0;
  inspectRuntime(program, amount, { nativeBalance: () => 11n, call(call) {
    const parsed = tokenAbi.parseTransaction({ data: call.data }) ?? vaultAbi.parseTransaction({ data: call.data });
    assert(parsed);
    if (parsed.name === "balanceOf") return ethers.toBeHex(get(call.target, String(parsed.args[0])), 32);
    assert.equal(parsed.name, direction);
    assert.equal(call.target.toLowerCase(), VAULT);
    assert.equal(call.static, false);
    assert.equal(call.value, 0n);
    assert.equal(parsed.args[0], amount);
    assert.equal(String(parsed.args[1]).toLowerCase(), recipient);
    if (!deposit) assert.equal(String(parsed.args[2]).toLowerCase(), EXECUTOR);
    operations++;
    balances.set(key(inputToken, EXECUTOR), get(inputToken, EXECUTOR) - amount);
    balances.set(key(outputToken, recipient), get(outputToken, recipient) + output);
    return ethers.toBeHex(output, 32);
  }, allowance(grant) {
    assert.equal(grant.token.toLowerCase(), inputToken);
    assert.equal(grant.spender.toLowerCase(), VAULT);
    assert.equal(grant.minimum, amount);
  } });
  assert.equal(operations, 1);
  assert.equal(get(inputToken, EXECUTOR), 101n);
  assert.equal(get(outputToken, recipient), before + output);
}

test("production catalog consumes the JSON call, log and surface definitions", () => {
  const abi = new ethers.Interface(definition.identity.definition.abi.vault);
  for (const call of definition.discovery.definition.calls) {
    assert(catalog.matches({ ...observation, kind: "call", target: VAULT, data: abi.getFunction(call.signature)!.selector })
      .some(match => match.familyId === ERC4626_FAMILY_ID && match.patternId === call.id));
  }
  for (const event of definition.discovery.definition.events) {
    assert(catalog.matches({ kind: "log", source: SOURCE, address: VAULT, topics: [abi.getEvent(event.signature)!.topicHash], data: "0x" })
      .some(match => match.familyId === ERC4626_FAMILY_ID && match.patternId === event.id));
  }
  assert(catalog.matches({ kind: "address-surface", source: SOURCE, address: VAULT,
    codeHash: ethers.keccak256("0x6001"), implementationWord: ethers.ZeroHash,
    interfaceFingerprints: [definition.discovery.definition.surface.fingerprint] })
    .some(match => match.familyId === ERC4626_FAMILY_ID && match.patternId === definition.discovery.definition.surface.id));
});

test("JSON admission publishes priced issuer routes consumed by Graph, quoted and runtime builders", async () => {
  const f = fixture(), publication = await f.publish();
  assert.equal(publication.instances.length, 1);
  const instance = publication.instances[0]!;
  assert.equal(instance.routes.length, 2);
  const descriptor = instance.descriptor as Erc4626Descriptor;
  assert.deepEqual([descriptor.vault, descriptor.asset, descriptor.share].map(value => value.toLowerCase()), [VAULT, ASSET, VAULT]);
  assert.equal(instance.pricingInstances.flatMap(state => [...state.mids]).length, 2);
  assert.deepEqual(f.probes.map(probe => probe.direction).sort(), ["deposit", "redeem"]);
  assert.equal(f.probes.find(probe => probe.direction === "deposit")!.amount, BigInt(definition.identity.definition.parameters.constants.samples[0]!));
  const inputs = instance.routes.map(route => ({ family, descriptor: instance.descriptor, route,
    handle: instance.routeHandles.find(handle => handle.routeKey === route.routeKey)! }));
  const graph = buildFamilyRouteGraphView({ routes: inputs });
  assert.equal(graph.edges.length, 2);
  assert.deepEqual(graph.edges.map(edge => [edge.adapterId, edge.target.toLowerCase(), edge.tokenIn.toLowerCase(), edge.tokenOut.toLowerCase()]).sort(), [
    ["erc4626-deposit", VAULT, ASSET, VAULT],
    ["erc4626-redeem", VAULT, VAULT, ASSET],
  ]);
  for (const input of inputs) {
    const { route, handle } = input, amountIn = 37n;
    assert([...graph.handleByCanonicalEdgeId.values()].includes(handle));
    const exact = await executeFamilyExactQuote({ family, route: handle, amountIn, executor: EXECUTOR,
      runtimeEvidence: [], source: SOURCE, generation: SOURCE.generation, runtime: f.runtime, requireChainAmountQuote: true, actionOwnership: catalog });
    assert.equal(exact.status, "resolved", JSON.stringify(exact, (_key, value) => typeof value === "bigint" ? String(value) : value));
    if (exact.status !== "resolved") throw new Error("unresolved fixture quote");
    assert.equal(exact.amountIn, amountIn);
    assert.equal(exact.amountOut, route.tokenIn.toLowerCase() === ASSET ? 18n : 74n);
    assert.equal(f.calls.at(-1)?.amount, amountIn, "request input must not be reduced for rounding");
    const before = f.transportCount();
    const execution = buildFamilyExecutionFragment({ family, actionOwnership: catalog, route: handle, exact,
      minAmountOut: exact.amountOut, quoteToleranceRawUnits: 0n, executor: EXECUTOR, runtimeEvidence: [] });
    assert.equal(execution.status, "resolved");
    if (execution.status === "resolved") assert.equal(execution.fragment.nodes[0]!.amount, amountIn);
    const runtimeInput = { family, actionOwnership: catalog, route: handle, source: SOURCE, runtime: f.runtime, executor: EXECUTOR, runtimeEvidence: [] };
    for (const settlement of [undefined, { kind: "direct-output" as const, recipient: RECIPIENT }]) {
      const leg = buildFamilyRuntimeAmountLeg({ ...runtimeInput, ...(settlement ? { settlement } : {}) });
      assert(leg);
      assert.match(leg.program, /^0x01/);
      assert.deepEqual(leg.settlementRequest, settlement);
      assertRuntimeEncoding(leg.program, route.tokenIn.toLowerCase() === ASSET ? "deposit" : "redeem", settlement?.recipient ?? EXECUTOR);
    }
    assert.equal(f.transportCount(), before, "quoted/runtime construction performs no quote or transport fallback");
    assert.throws(() => buildFamilyRouteGraphView({ routes: [{ ...input, handle: { ...handle } }] }), /handle|issued|authority/i);
    assert.throws(() => buildFamilyRuntimeAmountLeg({ ...runtimeInput, source: { ...SOURCE, hash: `0x${"cd".repeat(32)}` } }), /source/i);
  }
  assert.deepEqual(f.unexpected, []);
});

for (const rejected of ["deposit", "redeem"] as const) {
  test(`a completed ${rejected} revert publishes only the independently proven direction`, async () => {
    const f = fixture({ [rejected]: "revert" }), publication = await f.publish();
    const instance = publication.instances[0]!;
    assert.equal(instance.routes.length, 1);
    const graph = buildFamilyRouteGraphView({ routes: [{ family, descriptor: instance.descriptor,
      route: instance.routes[0]!, handle: instance.routeHandles[0]! }] });
    assert.equal(graph.edges[0]!.adapterId, `erc4626-${rejected === "deposit" ? "redeem" : "deposit"}`);
    assert.deepEqual(f.unexpected, []);
  });
}

for (const mode of ["revert", "zero-debit"] as const) {
  test(`${mode} on both directions cannot acquire publication authority`, async () => {
    const f = fixture({ deposit: mode, redeem: mode });
    // The runner includes failed/unresolved reasons; no-outcome means all
    // candidates were terminally rejected, rather than queued for RPC retry.
    await assert.rejects(f.publish, /^Error: strict Family lifecycle did not publish for protocol:erc4626: no-outcome$/);
    assert(f.probes.some(probe => probe.direction === "deposit"));
    assert(f.probes.some(probe => probe.direction === "redeem"));
    assert.deepEqual(f.unexpected, []);
  });
}

test("missing actor cannot bypass the central caller boundary", async () => {
  const f = fixture({ missingActor: true });
  await assert.rejects(f.publish, /did not publish/);
  assert.equal(f.probes.length, 0);
});

test("an unrelated selector cannot reach the transport", async () => {
  const f = fixture();
  await assert.rejects(() => runStrictFamilyLifecycle({ catalog, familyId: ERC4626_FAMILY_ID, source: SOURCE,
    observations: [{ kind: "call", source: SOURCE, target: VAULT, data: "0x00000000" }], runtime: f.runtime }), /no matched observation/);
  assert.equal(f.transportCount(), 0);
});
