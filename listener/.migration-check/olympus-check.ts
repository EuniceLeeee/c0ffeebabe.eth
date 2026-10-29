import assert from "node:assert/strict";
import { ethers } from "ethers";
import { loadFamily, response, sourceAt, cleanup } from "./helper.js";

const staking = "0xb63cac384247597756545b500253ff8e607a8020";
const gOHM = "0x0ab87046fbb341d058f17cbc4c1133f25a20a52f";
const OHM = "0x64aa3364f17a4d01c6f1751fd97c2bd3d7e7f1d5";
const executor = "0xE08D97e151473A848C3d9CA3f323Cb720472D015";
const source = sourceAt(26184922);
const sampleGohm = 1997321805946478n;
const sampleOhm = 537755943n;
const sampleIndex = 269238508004n;
const stakingCodeHash = "0x6c1ff3d80434554eea4896f01540b4f810e10ef4e5e68de15de530672bb9176a";
const gohmCodeHash = "0x09cabd71e420dac57ffa1cc568893a32b683d2f98076570c1756e1ec14d13bb9";
const ohmCodeHash = "0xbbfa9eba3c06791a338705ffc5b6566e8b1cc70a570fc7ab798d71af4dc8bcdd";

const iface = new ethers.Interface([
  "function unstake(address recipient,uint256 amount,bool trigger,bool rebasing)",
  "function index() view returns (uint256)",
  "function OHM() view returns (address)",
  "function gOHM() view returns (address)",
]);
const erc20 = new ethers.Interface(["function decimals() view returns (uint8)"]);

try {
  const { plugin, runtime, document, renderedSource } = await loadFamily("olympus");
  assert.equal(plugin.manifest.familyId, "protocol:olympus");
  assert.deepEqual([...plugin.manifest.ownedActionAdapterIds], ["olympus-unstake"]);
  assert.deepEqual([...plugin.manifest.requiredInfraActionAdapterIds], []);
  assert.deepEqual([...plugin.manifest.supportedLineages], ["olympus:staking-v3-gohm-unstake"]);
  assert.equal(plugin.protocol.activeBehaviorProof, "required");
  assert.equal(plugin.manifest.requiresProtocolEdgesFlag, true);
  assert.equal(plugin.actionAdapters.length, 1);
  assert.equal(plugin.actionAdapters[0].id, "olympus-unstake");
  assert.match(renderedSource, /compileDeclarativeProtocol\(definition, \[\]\)/);
  assert.equal(document.version, 2);

  const callPattern = plugin.discovery.callPatterns.find((p: any) => p.id === "olympus-unstake-call");
  assert.equal(callPattern.selector, iface.getFunction("unstake")!.selector);
  {
    const candidate = plugin.discovery.decodeCandidate({
      observation: { kind: "call", target: staking, sender: executor,
        data: iface.encodeFunctionData("unstake", [executor, 1n, false, false]) },
      matchedPatternId: "olympus-unstake-call",
    });
    assert.equal(candidate.candidateKind, "olympus-staking");
    assert.equal(candidate.target, ethers.getAddress(staking));
    const surface = plugin.discovery.decodeCandidate({
      observation: { kind: "address-surface", address: staking, opaque: {},
        interfaceFingerprints: ["olympus-staking-v3-unstake-v1"] },
      matchedPatternId: "olympus-staking-surface",
    });
    assert.equal(surface?.target, ethers.getAddress(staking));
  }

  const variant = plugin.identity.variants[0];
  const candidate = { candidateKind: "olympus-staking", target: staking };
  const first = variant.buildRequests({ candidate, step: 0 });
  assert.deepEqual(first.map((r: any) => r.id), ["olympus-staking-code", "olympus-ohm", "olympus-gohm"]);
  const surfaceEvidence = variant.decode({
    step: { candidate, step: 0 },
    results: [
      response("olympus-staking-code", "0x6000", source),
      response("olympus-ohm", iface.encodeFunctionResult("OHM", [OHM]), source),
      response("olympus-gohm", iface.encodeFunctionResult("gOHM", [gOHM]), source),
    ],
  });
  assert.equal(surfaceEvidence.phase, "surface");
  assert.equal(surfaceEvidence.gOHM, ethers.getAddress(gOHM));
  assert.equal(surfaceEvidence.OHM, ethers.getAddress(OHM));
  const second = variant.buildRequests({ candidate, evidence: surfaceEvidence, step: 1 });
  assert.deepEqual(second.map((r: any) => r.id), [
    "olympus-gohm-code", "olympus-ohm-code", "olympus-gohm-decimals", "olympus-ohm-decimals",
  ]);
  const completeEvidence = variant.decode({
    step: { candidate, evidence: surfaceEvidence, step: 1 },
    results: [
      response("olympus-gohm-code", "0x6001", source),
      response("olympus-ohm-code", "0x6002", source),
      response("olympus-gohm-decimals", erc20.encodeFunctionResult("decimals", [18n]), source),
      response("olympus-ohm-decimals", erc20.encodeFunctionResult("decimals", [9n]), source),
    ],
  });
  assert.equal(completeEvidence.phase, "complete");
  assert.equal(completeEvidence.gOhmDecimals, 18n);
  assert.equal(completeEvidence.ohmDecimals, 9n);
  const rejected = variant.decide({ candidate, evidence: completeEvidence, step: 2 });
  assert.equal(rejected.status, "chain-proven-rejected");
  assert.equal(rejected.reasonCode, "olympus_staking_code_not_matched");

  // Decide consumes the typed complete evidence, so the pinned positive path
  // can be exercised without fabricating runtime-code preimages.
  const pinnedEvidence = {
    phase: "complete", source, staking: ethers.getAddress(staking),
    stakingCodeHash, gOHM: ethers.getAddress(gOHM), OHM: ethers.getAddress(OHM),
    gOhmCodeHash: gohmCodeHash, ohmCodeHash,
    gOhmDecimals: 18n, ohmDecimals: 9n,
  };
  const verified = variant.decide({ candidate, evidence: pinnedEvidence, step: 2 });
  assert.equal(verified.status, "verified");
  assert.equal(verified.identity.subject, ethers.getAddress(staking));
  assert.equal(verified.identity.gOHM, ethers.getAddress(gOHM));
  assert.equal(verified.identity.OHM, ethers.getAddress(OHM));
  assert.equal(verified.identity.provenance.length, 1);
  assert.equal(variant.decide({ candidate, step: 0 }).status, "continue");
  const aliased = variant.decide({ candidate, evidence: { ...pinnedEvidence, OHM: ethers.getAddress(gOHM) }, step: 2 });
  assert.equal(aliased.reasonCode, "olympus_token_surface_alias");
  const wrongDecimals = variant.decide({ candidate, evidence: { ...pinnedEvidence, ohmDecimals: 18n }, step: 2 });
  assert.equal(wrongDecimals.reasonCode, "olympus_token_decimals_not_matched");

  const identity = verified.identity;
  const descriptorDraft = plugin.instance.compileDraft(identity);
  const descriptor = plugin.instance.finalizeDescriptor({ identity, draft: descriptorDraft, sharedBindings: [] });
  assert.equal(descriptor.staking, ethers.getAddress(staking));
  assert.equal(descriptor.gOHM, ethers.getAddress(gOHM));
  assert.equal(descriptor.OHM, ethers.getAddress(OHM));
  assert.equal(descriptor.gOhmDecimals, 18n);
  assert.equal(descriptor.ohmDecimals, 9n);
  const routes = plugin.routes.project({ descriptor });
  assert.equal(routes.length, 1);
  const route = routes[0];
  assert.equal(route.adapterId, "olympus-unstake");
  assert.equal(route.direction, "unstake");
  assert.equal(route.tokenIn, ethers.getAddress(gOHM));
  assert.equal(route.tokenOut, ethers.getAddress(OHM));
  assert.deepEqual(route.taxonomy, { slotKind: "protocol", protocolAction: "convert" });
  const graph = plugin.routes.projectGraph({ descriptor, route });
  assert.equal(graph.routeActionAdapterId, "olympus-unstake");
  assert.equal(graph.executionTarget, ethers.getAddress(staking));

  const pricingDraft = plugin.pricing.compileDraft({ descriptor, stateKey: descriptor.instanceKey, routes });
  assert.equal(pricingDraft.staking, ethers.getAddress(staking));
  const pricingRequests = plugin.pricing.current.buildRequests({ descriptor: pricingDraft, routes, state: {} });
  assert.deepEqual(pricingRequests.map((r: any) => r.id), ["current:unstake"]);
  assert.equal(plugin.pricing.stateKey(route), descriptor.instanceKey);
  assert.deepEqual(plugin.pricing.dependencies({ descriptor: pricingDraft }), [
    staking, gOHM, OHM,
  ].sort());
  const snapshot = plugin.pricing.current.decodeSnapshot({
    descriptor: pricingDraft,
    initialResults: [response("current:unstake", iface.encodeFunctionResult("index", [sampleIndex]), source)],
    dependentEvidence: [],
  });
  assert.equal(snapshot.index, sampleIndex);
  assert.equal(snapshot.quotes[route.routeKey].amountIn, 10n ** 18n);
  assert.equal(snapshot.quotes[route.routeKey].amountOut, sampleIndex);
  const mids = plugin.pricing.current.deriveMids({ descriptor: pricingDraft, snapshot, routes });
  assert.equal(mids.size, 1);
  assert.equal(mids.get(route.routeKey).mid, Number(sampleIndex));

  const exactInput = {
    descriptor, route, amountIn: sampleGohm, source, executor,
    runtimeEvidence: [], trialState: undefined, prefix: [],
  };
  const methods = plugin.exact.methods(exactInput);
  assert.deepEqual(methods.map((m: any) => m.id), ["local-zero", "olympus-index"]);
  const method = methods.find((m: any) => m.kind === "request-program");
  const requests = method.program.buildRequests(exactInput);
  assert.deepEqual(requests.map((r: any) => r.id), ["exact-index"]);
  const decoded = method.program.decode({
    programInput: exactInput,
    initialResults: [response("exact-index", iface.encodeFunctionResult("index", [sampleIndex]), source)],
    dependentEvidence: [],
  });
  assert.equal(decoded.amountOut, sampleOhm);
  assert.equal(decoded.evidence.kind, "olympus-index-unstake");
  assert.equal(decoded.evidence.amountIn, sampleGohm);
  assert.equal(decoded.evidence.amountOut, sampleOhm);
  assert.equal(decoded.evidence.bindingFingerprint, route.bindingRef.fingerprint);
  assert.equal(decoded.evidence.staking, ethers.getAddress(staking));
  const zero = method.program.decode({ programInput: { ...exactInput, amountIn: 0n }, initialResults: [], dependentEvidence: [] });
  assert.equal(zero.amountOut, 0n);
  assert.throws(() => method.program.buildRequests({ ...exactInput, trialState: {} }), /sequential|unproven|state transition/i);
  assert.throws(() => method.program.buildRequests({ ...exactInput, amountIn: 1n << 255n, prefix: [{ stepId: "x", results: [] }] }), /state transition|unproven/i);

  const fragment = plugin.execution.buildFragment({
    descriptor, route, amountIn: sampleGohm, quotedAmountOut: sampleOhm,
    minAmountOut: 0n, exactEvidence: decoded.evidence, executor, runtimeEvidence: [],
  });
  assert.equal(fragment.requirements.length, 0);
  assert.equal(fragment.nodes.length, 1);
  assert.equal(fragment.nodes[0].adapterId, "olympus-unstake");
  assert.equal(fragment.nodes[0].target, ethers.getAddress(staking));
  assert.equal(fragment.nodes[0].amount, sampleGohm);
  assert(fragment.nodes[0].params.runtimeAmountProgram.startsWith("0x"));
  const encoded = plugin.actionAdapters[0].encode(fragment.nodes[0], executor, new Uint8Array());
  assert.equal(encoded[0], 0x01);
  assert.equal(plugin.actionAdapters[0].matchTrace(staking, iface.getFunction("unstake")!.selector), true);
  assert.equal(plugin.actionAdapters[0].matchTrace(staking, iface.getFunction("index")!.selector), false);
  assert.throws(() => plugin.execution.buildFragment({
    descriptor, route, amountIn: sampleGohm, quotedAmountOut: sampleOhm - 1n,
    minAmountOut: 0n, exactEvidence: decoded.evidence, executor, runtimeEvidence: [],
  }), /incompatible exact evidence/);

  const leg = plugin.execution.buildRuntimeLeg({
    descriptor, route, executor, runtimeEvidence: [], source,
    settlement: { kind: "direct-output", recipient: executor },
  });
  assert(leg);
  assert.equal(leg.actionAdapterId, "olympus-unstake");
  assert.match(leg.program, /^0x01(?:[a-fA-F0-9]{2})+$/);
  assert.deepEqual(leg.settlement, { directOutput: true });
  assert.equal(leg.settlementRequest?.kind, "direct-output");

  // In-memory gap checks: retained read evidence must be expressible for the
  // local index quote; it is deliberately off because the execution program
  // re-reads index() in the same frame.
  assert.equal(document.modules.executionMath.entries.olympusIndexRuntime.model, "olympus:index-unstake-runtime");
  assert.equal(runtime.moduleCoverage[0].modules.find((m: any) => m.key === "executionMath").state, "compiled");
  console.log("olympus checks passed");
} finally {
  cleanup();
}
