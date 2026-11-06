import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, Interface, ZeroAddress, ZeroHash, getAddress, keccak256 } from "ethers";
import definition from "../venues/swaps/angstrom-v4-family/angstrom-v4.json" with { type: "json" };
import sample from "./fixtures/adapter-families/angstrom-signed-tx85-call.json" with { type: "json" };
import { compileDeclarativeSwap } from "../venues/declarative-swap.js";
import { defineSwapFamily } from "../venues/adapter-family-plugin.js";
import { compileSignedBlockEvidence } from "../venues/declarative-runtime-evidence.js";
import { compileDeclarativeValues } from "../venues/declarative-values.js";

const plugin = defineSwapFamily(compileDeclarativeSwap(definition));
const module = definition.modules.signedBlockEvidence;
const values = compileDeclarativeValues({ abi: definition.standard.abi, constants: {}, expressions: {} });
const signed = compileSignedBlockEvidence(plugin.manifest.familyId, module, values);
const observation = { kind: "call" as const, transactionHash: sample.transactionHash, target: sample.target,
  data: sample.data, sender: sample.from, source: sample.source };
const input = { observation, source: sample.source };
const iface = new Interface([module.call.signature]);
const actual = iface.decodeFunctionData("swap", sample.data).toArray(true);
const atBlock = actual[4].find((row: [bigint, string]) => row[0] === BigInt(sample.source.number));
const hook = module.proof.domain.verifyingContract;
const validators = new Interface(definition.standard.abi.hook);
const reverse = new Interface(definition.standard.abi.controller);
const aggregate = new Interface(definition.standard.abi.multicall);

function withBundle(rows: readonly [bigint, string][]) {
  return { ...input, observation: { ...observation,
    data: iface.encodeFunctionData("swap", actual.map((v, i) => i === 4 ? rows : v)) } };
}
function authority(reversed: string, member: bigint) {
  const controller = "0x1746484EA5e11C75e009252c102C8C33e0315fD4";
  const calls: string[] = [];
  const check = async ({ to, data }: { to: string; data: string }) => {
    calls.push(getAddress(to));
    if (getAddress(to) === getAddress(hook)) {
      assert.deepEqual([...validators.decodeFunctionData("extsload", data)], [0n]);
      return validators.encodeFunctionResult("extsload", [BigInt(controller)]);
    }
    if (getAddress(to) === getAddress(controller)) {
      assert.equal(reverse.decodeFunctionData("ANGSTROM", data).length, 0);
      return reverse.encodeFunctionResult("ANGSTROM", [reversed]);
    }
    const items = aggregate.decodeFunctionData("aggregate3", data)[0];
    const slot = BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [atBlock[1].slice(0,42), 1n])));
    assert.equal(items.length, 1);
    assert.equal(getAddress(items[0].target), getAddress(hook));
    assert.equal(validators.decodeFunctionData("extsload", items[0].callData)[0], slot);
    return aggregate.encodeFunctionResult("aggregate3", [[[true, validators.encodeFunctionResult("extsload", [member])]]]);
  };
  return { check, calls };
}

test("real TX85 EIP-712 attestation is source and instance bound", () => {
  const evidence = plugin.discovery!.runtimeEvidenceFromObservation!(input);
  assert.equal(evidence.length, 1);
  const e = evidence[0]!;
  assert.equal(e.txHash, sample.transactionHash);
  assert.equal(keccak256(e.sealedPayloadRef), "0xb14f571101c45db8782912ac66e03f679270b2307c4a2880835273b46b755058");
  const descriptor = { instanceKey: e.instanceKey! };
  assert.equal(signed.authenticate({ source: input.source, runtimeEvidence: evidence, descriptor })?.items.length, 1);
  for (const source of [{ ...input.source, hash: ZeroHash }, { ...input.source, number: input.source.number + 1 }]) {
    assert.throws(() => signed.authenticate({ source, runtimeEvidence: evidence, descriptor }));
  }
  assert.throws(() => signed.authenticate({ source: input.source, runtimeEvidence: evidence, descriptor: {instanceKey: "another-pool"} }));
  assert.throws(() => signed.authenticate({ source: input.source, runtimeEvidence: [{...e, evidenceHash: ZeroHash}], descriptor }));
  assert.deepEqual(plugin.discovery!.runtimeEvidenceFromObservation!(withBundle([[BigInt(input.source.number + 1), atBlock[1]]])), []);
  assert.deepEqual(plugin.discovery!.runtimeEvidenceFromObservation!(withBundle([[BigInt(input.source.number), "0x"+"12".repeat(85)]])), []);
  assert.deepEqual(plugin.discovery!.runtimeEvidenceFromObservation!({...input,observation:{...observation,target:ZeroAddress}}), []);
});

test("pending evidence also requires the scoped controller reverse lookup and current validator set", async () => {
  const accepted = authority(hook, 1n);
  const enabled = await plugin.discovery!.pendingRuntimeEvidenceFromObservation!({ ...input, call: accepted.check });
  assert.equal(enabled.length, 1);
  assert.equal(accepted.calls.length, 3);
  assert.equal(enabled[0]!.instanceKey, undefined);
  assert.equal(keccak256(enabled[0]!.sealedPayloadRef), "0xb14f571101c45db8782912ac66e03f679270b2307c4a2880835273b46b755058");
  assert.deepEqual(await plugin.discovery!.pendingRuntimeEvidenceFromObservation!({ ...input, call: authority(hook,0n).check }), []);
  await assert.rejects(plugin.discovery!.pendingRuntimeEvidenceFromObservation!({ ...input, call: authority(ZeroAddress,1n).check }));
});

test("changing signed authority after Exact method selection fails before issuing a request", () => {
  const c = plugin.discovery!.decodeCandidate({observation, matchedPatternId:"angstrom-v4-adapter-swap-call"}) as any;
  assert(c);
  const poolKey = {currency0:c.currency0,currency1:c.currency1,fee:c.fee,tickSpacing:c.tickSpacing,hooks:c.hooks};
  const evidence = plugin.discovery!.runtimeEvidenceFromObservation!(input);
  const descriptor: any = {familyId:plugin.manifest.familyId,lineageId:plugin.manifest.supportedLineages[0],
    instanceKey:evidence[0]!.instanceKey,poolId:c.poolId,poolKey,runtimeRequirements:[],provenance:[],
    immutableBinding:{manager:c.manager,adapter:module.call.target,hook:c.hooks,quoter:"0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203"}};
  const route = plugin.routes!.project({descriptor})[0]!;
  const signedInput = {descriptor,route,source:sample.source,executor:c.currency0,amountIn:1n,runtimeEvidence:evidence};
  const empty = {...signedInput, runtimeEvidence:[]};
  const signedMethod = plugin.exact!.methods(signedInput).find(m => m.kind === "request-program")!;
  const unsignedMethod = plugin.exact!.methods(empty).find(m => m.kind === "request-program")!;
  assert.equal(signedMethod.id,"tx-bound-quoter");
  assert.equal(unsignedMethod.id,"source-unlocked-quoter");
  assert.throws(()=>signedMethod.program.buildRequests(empty), /authority/);
  assert.throws(()=>unsignedMethod.program.buildRequests(signedInput), /authority/);
});

test("TX85 landed hook receipt binds its pool, preserves exact post-state and never infers net output", async () => {
  const c = plugin.discovery!.decodeCandidate({ observation, matchedPatternId: "angstrom-v4-adapter-swap-call" }) as any;
  const evidence = plugin.discovery!.runtimeEvidenceFromObservation!(input);
  const descriptor: any = {
    familyId: plugin.manifest.familyId, lineageId: plugin.manifest.supportedLineages[0],
    instanceKey: evidence[0]!.instanceKey, poolId: c.poolId, runtimeRequirements: [], provenance: [],
    poolKey: { currency0: c.currency0, currency1: c.currency1, fee: c.fee, tickSpacing: c.tickSpacing, hooks: c.hooks },
    immutableBinding: { manager: c.manager, adapter: module.call.target, hook: c.hooks, quoter: "0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203" },
  };
  const routes = plugin.routes!.project({ descriptor });
  const graph = routes.map(route => ({ ...route, target: module.call.target, adapterId: "angstrom-v4-swap" }));
  const log = { ...sample.swapLog, blockNumber: sample.source.number };
  const generation = {
    sourceBlock: sample.source.number, sourceBlockHash: sample.source.hash, receiptBlockNumber: sample.source.number,
    receiptBlockHash: sample.source.hash, receiptParentBlockHash: sample.parentHash, receiptTransactionHash: sample.transactionHash,
    logsCompleteness: "complete-receipt",
  };
  const ctx: any = {
    logs: [log], graph, edgesByTarget: new Map(), sourceGeneration: generation,
    resolveBinding: () => ({ familyId: descriptor.familyId, descriptor }),
    matchedOwnedTriggers: [{ triggerId: "landed-swap", logIndex: 0, emitter: log.address, topic0: log.topics[0] }],
    control: { signal: new AbortController().signal, deadlineAtMs: Date.now() + 10_000 },
  };
  const observed = await plugin.swap!.receiptObservation!.decodeReceiptImpacts(ctx);
  assert.equal(observed.status, "resolved");
  assert.equal(observed.impacts.length, 1);
  const landed = observed.impacts[0]!.impact;
  const decoded = new Interface([definition.swap.events[0]!.signature]).decodeEventLog("Swap", log.data, log.topics);
  assert.equal(landed.amountIn, -decoded.amount0);
  assert.equal(landed.poolId, log.topics[1]);
  assert.equal(landed.amountOut, undefined);
  assert.equal(getAddress(landed.pool), getAddress(log.address));
  const impact = { ...landed, exactPostState: landed.v4PostState };
  const route = plugin.swap!.replay!.bind({ descriptor, routes, impact } as any);
  assert.equal(route?.routeKey, routes[0]!.routeKey);
  const replay: any = { descriptor, route, impact, source: sample.source };
  const post: any = plugin.swap!.replay!.exactPostState!(replay);
  assert.equal(getAddress(post.poolManager), getAddress(log.address));
  assert.equal(post.poolId, log.topics[1]);
  assert.equal(post.sqrtPriceX96, decoded.sqrtPriceX96);
  assert.equal(post.blockNumber, sample.source.number);
  assert.equal(plugin.swap!.replay!.applyLocal({ ...replay, impact: { ...impact, amountOut: decoded.amount1 } }), null);
  assert.equal(plugin.swap!.replay!.buildOverlay(replay), null);
  for (const method of ["applyLocal", "buildOverlay", "exactPostState"] as const) {
    assert.throws(() => plugin.swap!.replay![method]!({ ...replay, route: routes[1]! }));
  }
  const foreign = await plugin.swap!.receiptObservation!.decodeReceiptImpacts({
    ...ctx, resolveBinding: () => ({ familyId: descriptor.familyId, descriptor: { ...descriptor, poolId: ZeroHash } }),
  });
  assert.equal(foreign.status, "resolved");
  assert.equal(foreign.impacts.length, 0);
});

