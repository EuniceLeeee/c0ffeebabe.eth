import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/olympus.production.js";
import { definedFamilyPluginContractSummary } from "../../../adapter-family-plugin.js";
import type {
  ExactQuoteSemantics,
  ExecutionSemantics,
  InstanceSemantics,
  RouteProjectionSemantics,
} from "../../../adapter-family-plugin.js";
import type { AdapterRequestResult } from "../../../adapter-request-program.js";
import { OLYMPUS_ERC20_INTERFACE, OLYMPUS_INTERFACE, OLYMPUS_INDEX_SCALE,
  OLYMPUS_UNSTAKE_SELECTOR, olympusQuote } from "../codec.js";
import { olympusFamilyOwnedAction } from "../action.js";
import { olympusExact } from "../exact.js";
import { olympusExecution } from "../execution.js";
import { olympusIdentity } from "../identity.js";
import { olympusInstance } from "../instance.js";
import { OLYMPUS_FAMILY_ID, OLYMPUS_LINEAGE_ID } from "../manifest.js";
import { olympusRoutes } from "../routes.js";
import type {
  OlympusDescriptor,
  OlympusExactEvidence,
  OlympusIdentity,
  OlympusIdentityEvidence,
  OlympusRoute,
} from "../types.js";

// Landed sample 0x28c9e5f8b41db8e2a0b5653b0a48520307bcafe95d1edf993f6f15e1ea904696
// at block 26184922: 1997321805946478 gOHM wei -> 537755943 OHM wei with
// staking.index() = 269238508004.
const SAMPLE_GOHM = 1997321805946478n;
const SAMPLE_OHM = 537755943n;
const SAMPLE_INDEX = 269238508004n;
const staking = "0xb63cac384247597756545b500253ff8e607a8020";
const gOHM = "0x0ab87046fbb341d058f17cbc4c1133f25a20a52f";
const OHM = "0x64aa3364f17a4d01c6f1751fd97c2bd3d7e7f1d5";
const executor = "0xE08D97e151473A848C3d9CA3f323Cb720472D015";
const source = { number: 26184922, hash: ethers.id("olympus-proof-fixture"), generation: 26184922 };
const response = (id: string, data: string): Extract<AdapterRequestResult, { ok: true }> => ({
  id, data, source, ok: true, completion: "returned",
  provenance: { kind: "fixture", fingerprint: "not-chain-evidence" },
});

const identity: OlympusIdentity = Object.freeze({
  familyId: OLYMPUS_FAMILY_ID,
  lineageId: OLYMPUS_LINEAGE_ID,
  subject: staking,
  provenance: Object.freeze([]),
  gOHM,
  OHM,
  gOhmDecimals: 18n,
  ohmDecimals: 9n,
});
const instance: InstanceSemantics<OlympusIdentity, OlympusDescriptor> = olympusInstance;
const routes: RouteProjectionSemantics<OlympusDescriptor, OlympusRoute> = olympusRoutes;
const exact: ExactQuoteSemantics<OlympusDescriptor, OlympusRoute, OlympusExactEvidence> = olympusExact;
const execution: ExecutionSemantics<OlympusDescriptor, OlympusRoute, OlympusExactEvidence> = olympusExecution;
const descriptor: OlympusDescriptor = instance.finalizeDescriptor({
  identity,
  draft: instance.compileDraft(identity),
  sharedBindings: [],
});
const route = routes.project({ descriptor })[0];

test("olympus family definition is valid", () => {
  definedFamilyPluginContractSummary(plugin);
  assert.equal(plugin.manifest.familyId, "protocol:olympus");
  assert.deepEqual([...plugin.manifest.ownedActionAdapterIds], ["olympus-unstake"]);
  assert.deepEqual([...plugin.manifest.requiredInfraActionAdapterIds], []);
  assert.deepEqual(plugin.actionAdapters.map(a => a.id), ["olympus-unstake"]);
  assert.equal(plugin.protocol.activeBehaviorProof, "required");
  const call = plugin.discovery.callPatterns?.[0];
  assert.equal(call?.selector, OLYMPUS_UNSTAKE_SELECTOR);
});

test("olympus index conversion reproduces the landed gOHM->OHM amount", () => {
  assert.equal(OLYMPUS_INDEX_SCALE, 10n ** 18n);
  assert.equal(olympusQuote(SAMPLE_GOHM, SAMPLE_INDEX), SAMPLE_OHM);
  assert.equal(olympusQuote(1n, SAMPLE_INDEX), 0n);
  assert.equal(olympusQuote(10n ** 18n, SAMPLE_INDEX), SAMPLE_INDEX);
  assert.throws(() => olympusQuote(1n, 0n), /index/);
  assert.throws(() => olympusQuote(-1n, SAMPLE_INDEX), /negative/);
  assert.throws(() => olympusQuote(1n << 255n, 1n << 255n), /overflow/);
});

test("olympus route is the single gOHM->OHM protocol convert", () => {
  const projected = routes.project({ descriptor });
  assert.equal(projected.length, 1);
  assert.equal(route.tokenIn, ethers.getAddress(gOHM));
  assert.equal(route.tokenOut, ethers.getAddress(OHM));
  assert.deepEqual(route.taxonomy, { slotKind: "protocol", protocolAction: "convert" });
  assert.equal(route.adapterId, "olympus-unstake");
  assert.equal(route.direction, "unstake");
  const graph = routes.projectGraph({ descriptor, route });
  assert.equal(graph.routeActionAdapterId, "olympus-unstake");
  assert.equal(graph.executionTarget, ethers.getAddress(staking));
});

test("olympus exact reads index() and quotes the floor", () => {
  const input = {
    descriptor, route, amountIn: SAMPLE_GOHM, source,
    executor, runtimeEvidence: [],
  };
  const method = exact.methods(input).find(m => m.kind === "request-program");
  assert(method && method.kind === "request-program");
  const requests = method.program.buildRequests(input);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].id, "exact-index");
  assert.equal(requests[0].kind, "eth-call");
  const decoded = method.program.decode({
    programInput: input,
    initialResults: [response("exact-index",
      OLYMPUS_INTERFACE.encodeFunctionResult("index", [SAMPLE_INDEX]))],
    dependentEvidence: [],
  });
  assert.equal(decoded.amountOut, SAMPLE_OHM);
  assert.equal(decoded.evidence.index, SAMPLE_INDEX);
  assert.equal(decoded.evidence.kind, "olympus-index-unstake");
  assert.equal(decoded.evidence.bindingFingerprint, route.bindingRef.fingerprint);
});

test("olympus quoted fragment encodes unstake(executor,amount,false,false) without approval", () => {
  const fragment = execution.buildFragment({
    descriptor, route, amountIn: SAMPLE_GOHM, quotedAmountOut: SAMPLE_OHM,
    minAmountOut: 0n, executor, runtimeEvidence: [],
    exactEvidence: {
      kind: "olympus-index-unstake", source, staking, gOHM, OHM,
      amountIn: SAMPLE_GOHM, amountOut: SAMPLE_OHM, index: SAMPLE_INDEX,
      bindingFingerprint: route.bindingRef.fingerprint,
    },
  });
  assert.equal(fragment.requirements.length, 0);
  assert.equal(fragment.nodes.length, 1);
  const node = fragment.nodes[0];
  assert.equal(node.adapterId, "olympus-unstake");
  assert.equal(node.amount, SAMPLE_GOHM);
  assert.equal(node.params.index, SAMPLE_INDEX);
  // ActionAdapters emit a BotVM CALL program: [0x00][target:20][len:3][payload].
  const program = olympusFamilyOwnedAction.encode(
    node as never, executor, new Uint8Array(),
  );
  assert.equal(program[0], 0x00);
  assert.equal(ethers.getAddress(ethers.hexlify(program.slice(1, 21))),
    ethers.getAddress(staking));
  const calldata = ethers.hexlify(program.slice(24));
  const parsed = OLYMPUS_INTERFACE.parseTransaction({ data: calldata })!;
  assert.equal(parsed.name, "unstake");
  assert.equal(ethers.getAddress(String(parsed.args[0])), ethers.getAddress(executor));
  assert.equal(parsed.args[1], SAMPLE_GOHM);
  assert.equal(parsed.args[2], false);
  assert.equal(parsed.args[3], false);
});

test("olympus execution rejects mismatched exact evidence", () => {
  assert.throws(() => execution.buildFragment({
    descriptor, route, amountIn: SAMPLE_GOHM, quotedAmountOut: SAMPLE_OHM - 1n,
    minAmountOut: 0n, executor, runtimeEvidence: [],
    exactEvidence: {
      kind: "olympus-index-unstake", source, staking, gOHM, OHM,
      amountIn: SAMPLE_GOHM, amountOut: SAMPLE_OHM, index: SAMPLE_INDEX,
      bindingFingerprint: route.bindingRef.fingerprint,
    },
  }), /incompatible/);
});

test("olympus runtime leg is receipt-driven and direct-output", () => {
  const buildRuntimeLeg = execution.buildRuntimeLeg;
  assert(buildRuntimeLeg);
  const leg = buildRuntimeLeg({
    descriptor, route, executor, runtimeEvidence: [], source,
    settlement: { kind: "direct-output", recipient: executor },
  });
  assert(leg);
  assert.equal(leg.actionAdapterId, "olympus-unstake");
  assert.match(leg.program, /^0x01(?:[a-fA-F0-9]{2})+$/);
  assert.deepEqual(leg.settlement, { directOutput: true });
  assert.equal(leg.settlementRequest?.kind, "direct-output");
});

test("olympus identity rejects unrelated runtime/token code", () => {
  const variant = olympusIdentity.variants[0];
  const candidate = { candidateKind: "olympus-staking" as const, target: staking };
  const first = variant.buildRequests({ candidate, step: 0 });
  assert.deepEqual(first.map(r => r.id),
    ["olympus-staking-code", "olympus-ohm", "olympus-gohm"]);
  const surface = variant.decode({
    step: { candidate, step: 0 },
    results: [
      response("olympus-staking-code", "0x6000"),
      response("olympus-ohm", OLYMPUS_INTERFACE.encodeFunctionResult("OHM", [OHM])),
      response("olympus-gohm", OLYMPUS_INTERFACE.encodeFunctionResult("gOHM", [gOHM])),
    ],
  }) as OlympusIdentityEvidence;
  assert.equal(surface.phase, "surface");
  const next = variant.buildRequests({ candidate, evidence: surface, step: 1 });
  assert.deepEqual(next.map(r => r.id),
    ["olympus-gohm-code", "olympus-ohm-code", "olympus-gohm-decimals", "olympus-ohm-decimals"]);
  const complete = variant.decode({
    step: { candidate, evidence: surface, step: 1 },
    results: [
      response("olympus-gohm-code", "0x6001"),
      response("olympus-ohm-code", "0x6002"),
      response("olympus-gohm-decimals",
        OLYMPUS_ERC20_INTERFACE.encodeFunctionResult("decimals", [18n])),
      response("olympus-ohm-decimals",
        OLYMPUS_ERC20_INTERFACE.encodeFunctionResult("decimals", [9n])),
    ],
  });
  const decision = variant.decide({ candidate, evidence: complete, step: 2 });
  assert.equal(decision.status, "chain-proven-rejected");
  assert.equal(decision.reasonCode, "olympus_staking_code_not_matched");
});
