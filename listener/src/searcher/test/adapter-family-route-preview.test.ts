import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { CentralAdapterRuntime, CentralAdapterScheduler } from "../adapter-work-intent.js";
import { createBoundedRequestExecutor, type AdapterRequest, type CanonicalSource } from "../venues/adapter-request-program.js";
import { defineProtocolFamily, definedFamilyPluginContractSummary, explicitReverseBindingUnsupported } from "../venues/adapter-family-plugin.js";
import { familyId, instanceKey, lineageId, routeKey } from "../venues/adapter-family-identifiers.js";
import { assertIssuedPreparedFamilyInstance, previewFamilyCandidateRoutes, recheckFamilyInstanceMemoBinding } from "../venues/adapter-family-runtime.js";
import { asPricedFamily, capabilityManifestHash, FAMILY_CAPABILITY_NAMES, FamilyCapabilityCatalog } from "../venues/family-capability-catalog.js";
import { bindFamilyOwnedAction } from "../venues/family-owned-action.js";
import { hashCanonical } from "../venues/canonical-value.js";

const POOL = `0x${"11".repeat(20)}`, INPUT = `0x${"22".repeat(20)}`, OUTPUT = `0x${"33".repeat(20)}`;
const SOURCE: CanonicalSource = Object.freeze({ number: 123, hash: `0x${"44".repeat(32)}`, generation: 7 });
let sequence = 0;
interface Options {
  readonly identityAccepted?: boolean;
  readonly invalidRoute?: "foreign-instance" | "fingerprint" | "taxonomy" | "empty";
  readonly memoRecheck?: boolean;
  readonly wrongReceiptSource?: boolean;
  readonly failedStaticEvidence?: boolean;
  readonly onRequest?: (request: AdapterRequest) => void;
  readonly afterProjection?: () => void;
}

/** A strict catalog-issued Family with real central request execution. Its
 * pricing entry points all throw, so the preview cannot accidentally achieve
 * apparent success by publishing a hand-built or unpriced instance. */
function fixture(options: Options = {}) {
  const id = familyId(`protocol:route-preview-${++sequence}`), lineage = lineageId(`${id}:fixture`), actionId = `${id}:convert`;
  const requestIds: string[] = [], stages: string[] = [];
  let stale = false, pricingCalls = 0, routeCalls = 0;
  const noPricing = (): never => { pricingCalls++; throw new Error("preview entered pricing"); };
  const read = (requestId: string): AdapterRequest => ({ id: requestId, kind: "eth-call", to: POOL, data: "0x12345678", completion: "return-data" });
  const resultData = (results: readonly any[]): string => {
    assert.equal(results.length, 1); assert.equal(results[0].ok, true); return results[0].data;
  };
  const plugin = defineProtocolFamily({
    manifest: { familyId: id, domain: "protocol", ownedActionAdapterIds: [actionId], requiredInfraActionAdapterIds: [],
      allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }], supportedLineages: [lineage] },
    discovery: { sources: ["observed-call"], evidenceChannel: "tx-evidence",
      reverseBinding: explicitReverseBindingUnsupported("fixture has no retained nomination channel"),
      callPatterns: [{ id: "known-call", selector: "0x12345678", signature: "convert(uint256)", candidateAddress: { from: "call-target" } }],
      decodeCandidate: ({ observation }: any) => ({ candidateKind: "observed-call", pool: observation.target }),
      candidateKey: (candidate: any) => candidate.pool },
    identity: { ...(options.memoRecheck ? { memoReuse: "recheck-identity" } : {}),
      identityKey: (identity: any) => identity.subject,
      variants: [{ id: "chain-proof", kind: "standalone-contract", lineageId: lineage, applies: () => true,
        requirements: () => ({ transports: ["eth-call"] }), buildRequests: () => [read("identity")],
        decode: ({ results }: any) => resultData(results) === "0x01",
        decide: ({ candidate, evidence }: any) => evidence === undefined ? { status: "continue" }
          : evidence ? { status: "verified", identity: { familyId: id, lineageId: lineage, subject: candidate.pool,
            provenance: [{ kind: "active-probe", subject: candidate.pool }] } }
          : { status: "chain-proven-rejected", reasonCode: "negative-chain-proof", evidenceRequestIds: ["identity"] } }] },
    instance: {
      instanceKey: (identity: any) => instanceKey(identity.subject),
      compileDraft: (identity: any) => ({ familyId: id, lineageId: lineage, instanceKey: instanceKey(identity.subject),
        provenance: identity.provenance, runtimeRequirements: [], target: identity.subject }),
      staticEvidence: { reusePolicy: { kind: "source-local" }, requirements: () => ({ transports: ["get-code"] }),
        buildRequests: (draft: any) => [{ id: "instance-static", kind: "get-code", address: draft.target }],
        decode: ({ results }: any) => { const code = resultData(results); assert.notEqual(code, "0x"); return { code }; } },
      finalizeDescriptor: ({ draft, staticEvidence, sharedBindings }: any) => ({ ...draft, code: staticEvidence.code, sharedBindings: [...sharedBindings] }),
      staticBindingProjection: (descriptor: any) => descriptor,
    },
    sharedBindings: {
      references: () => [{ bindingKind: "fixture-binding", bindingKey: INPUT }],
      program: { requirements: () => ({ transports: ["eth-call"] }), buildRequests: () => [read("shared-binding")],
        decode: ({ results }: any) => ({ word: resultData(results) }) },
      canonicalProjection: (evidence: any) => evidence,
    },
    routes: {
      project: ({ descriptor }: any) => {
        routeCalls++;
        const route = { familyId: id, lineageId: lineage,
          instanceKey: options.invalidRoute === "foreign-instance" ? instanceKey(OUTPUT) : descriptor.instanceKey,
          routeKey: routeKey(`${id}:${descriptor.target}:forward`), tokenIn: INPUT, tokenOut: OUTPUT,
          taxonomy: { slotKind: "protocol", protocolAction: options.invalidRoute === "taxonomy" ? "deposit" : "convert" },
          bindingRef: { bindingKey: descriptor.target, fingerprint: options.invalidRoute === "fingerprint" ? "unbound" : hashCanonical(descriptor) },
          runtimeRequirements: [], target: descriptor.target, adapterId: actionId };
        options.afterProjection?.();
        return options.invalidRoute === "empty" ? [] : [route];
      },
      projectGraph: () => { throw new Error("preview entered Graph projection"); },
    },
    pricing: { stateKey: noPricing, staticBindingProjection: noPricing, snapshotCompatibilityProjection: noPricing,
      compileDraft: noPricing, finalizePricingDescriptor: noPricing, dependencies: noPricing,
      current: { requirements: noPricing, buildRequests: noPricing, decodeSnapshot: noPricing, deriveMids: noPricing } },
    exact: { methods: () => [], cacheCompatibilityProjection: () => ({}) },
    execution: { runtimeProjection: () => ({}), buildFragment: () => { throw new Error("preview entered execution"); }, expectedEffects: () => [] },
    protocol: { candidateKinds: ["observed-call"], activeBehaviorProof: "required" },
    actionAdapters: [bindFamilyOwnedAction({ action: { id: actionId, isWrapper: false, field2Offset: null,
      encode: () => new Uint8Array(), matchTrace: () => false }, descriptor: { adapterId: actionId, lineage: `custom-protocol:${actionId}`,
      edgeKind: "protocol", action: "convert", canSendValue: false, leavesStandingPositionDefault: false } })],
  } as any);
  const entries = FAMILY_CAPABILITY_NAMES.map(capability => ({ familyId: id, capability, contractVersion: "fixture-v1",
    contentHash: createHash("sha256").update(`${id}/${capability}`).digest("hex"), semanticDependencies: [`contract:${capability}`], provenanceCommit: null }));
  const catalog = new FamilyCapabilityCatalog({ modules: [{ sourceFile: `${id}.production.ts`, plugin,
    definitionBoundaryHash: definedFamilyPluginContractSummary(plugin).definitionBoundaryHash }],
    generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) } });
  const family = asPricedFamily(catalog.forFamily(id));
  const scheduler: CentralAdapterScheduler = {
    issueExecutor: issued => ({
      executor: createBoundedRequestExecutor({
        assertSupported: requirements => assert.deepEqual(requirements, issued.requirements),
        assertCallerBinding() {}, assertWithinBudget() {},
        execute: async ({ requests, source }) => requests.map(request => {
          assert(["identity", "instance-static", "shared-binding"].includes(request.id));
          requestIds.push(request.id); options.onRequest?.(request);
          return { id: request.id, ok: true as const, completion: "returned" as const,
            source: options.wrongReceiptSource ? { ...source, hash: `0x${"99".repeat(32)}` } : source,
            provenance: { kind: "preview-fixture", fingerprint: `observed:${request.id}` },
            data: request.id === "identity" ? options.identityAccepted === false ? "0x00" : "0x01"
              : request.id === "instance-static" ? options.failedStaticEvidence ? "0x" : "0x6001" : "0x02" };
        }),
        sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
      }),
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    }),
  };
  let time = 1_000;
  const runtime: CentralAdapterRuntime = {
    clock: { nowMs: () => time++ },
    generationFence: { assertCurrent(generation, source) {
      assert.deepEqual(source, SOURCE); assert.equal(generation, SOURCE.generation);
      if (stale) throw new Error("preview source was superseded");
    } },
    callerAuthority: { bind: () => ({}) }, budgets: { assertAdmitted() {} }, scheduler,
    policy: { bind(input) { stages.push(input.stage); return { lane: "critical-proof", deadlineAtMs: 99_999,
      maxAttempts: 1, transportPool: "state-read", fairnessKey: input.subjectKey }; } },
  };
  const candidate = { candidateKind: "observed-call", pool: POOL };
  return { family, runtime, candidate, requestIds, stages, markStale: () => { stale = true; },
    counts: () => ({ pricingCalls, routeCalls }),
    input: { family, runtime, candidate, source: SOURCE, generation: SOURCE.generation } };
}

test("pre-Graph preview verifies identity, static evidence and shared bindings without pricing or admission", async () => {
  const f = fixture(), result = await previewFamilyCandidateRoutes(f.input), preview = result.preview;
  assert(preview); assert.equal(preview.kind, "family-candidate-route-preview");
  assert.equal(preview.instanceKey, POOL); assert.equal(preview.routes.length, 1);
  assert.deepEqual(preview.source, SOURCE); assert.equal(preview.generation, SOURCE.generation);
  assert.match(preview.staticBindingFingerprint, /^[0-9a-f]{64}$/);
  assert.match(preview.staticEvidenceFingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(f.requestIds, ["identity", "instance-static", "shared-binding"]);
  assert.deepEqual(f.counts(), { pricingCalls: 0, routeCalls: 1 });
  assert(!f.stages.some(stage => stage.startsWith("pricing")));
  assert(preview.evidenceRefs.some(ref => ref.startsWith("shared-binding:")));
  assert.equal(preview.outcomes, result.outcomes);
  assert.deepEqual(result.outcomes.map(row => [row.stage, row.status]), [
    ["discovery", "candidate"], ["identity", "verified"], ["instance-compile", "verified"], ["route-projection", "verified"],
  ]);
  for (const key of ["routeHandles", "pricingInstances", "publication", "ready"]) assert(!Object.hasOwn(preview, key));
  assert(Object.isFrozen(preview) && Object.isFrozen(preview.descriptor) && Object.isFrozen(preview.routes[0]!.bindingRef));
  assert.throws(() => assertIssuedPreparedFamilyInstance({ family: f.family, instance: preview as never,
    source: SOURCE, generation: SOURCE.generation }), /lifecycle-issued/);
});

test("negative chain identity yields no route preview or static/pricing work", async () => {
  const f = fixture({ identityAccepted: false }), result = await previewFamilyCandidateRoutes(f.input);
  assert.equal(result.preview, null); assert.deepEqual(f.requestIds, ["identity"]);
  assert(result.outcomes.some(row => row.stage === "identity" && row.status === "rejected"));
  assert.deepEqual(f.counts(), { pricingCalls: 0, routeCalls: 0 });
});

for (const invalidRoute of ["foreign-instance", "fingerprint", "taxonomy", "empty"] as const) {
  test(`pre-Graph preview preserves route validation: ${invalidRoute}`, async () => {
    const f = fixture({ invalidRoute }), result = await previewFamilyCandidateRoutes(f.input);
    assert.equal(result.preview, null);
    assert(result.outcomes.some(row => row.stage === "route-projection" && ["failed", "rejected"].includes(row.status)));
    assert.equal(f.counts().pricingCalls, 0);
  });
}

test("failed instance evidence and wrong-source identity receipts cannot produce a preview", async () => {
  for (const options of [{ failedStaticEvidence: true }, { wrongReceiptSource: true }]) {
    const f = fixture(options), result = await previewFamilyCandidateRoutes(f.input);
    assert.equal(result.preview, null); assert.deepEqual(f.counts(), { pricingCalls: 0, routeCalls: 0 });
    assert(result.outcomes.some(row => ["failed", "unresolved"].includes(row.status)));
  }
});

test("preview validates the initial source and rejects a fence superseded during route projection", async () => {
  const f = fixture();
  await assert.rejects(previewFamilyCandidateRoutes({ ...f.input, generation: SOURCE.generation + 1 }), /canonical/);
  assert.deepEqual(f.requestIds, []);
  const initial = fixture(); initial.markStale();
  await assert.rejects(previewFamilyCandidateRoutes(initial.input), /superseded/); assert.deepEqual(initial.requestIds, []);
  let later: ReturnType<typeof fixture>;
  later = fixture({ afterProjection: () => later.markStale() });
  await assert.rejects(previewFamilyCandidateRoutes(later.input), /superseded/);
  assert.deepEqual(later.counts(), { pricingCalls: 0, routeCalls: 1 });
});

test("preview snapshots its candidate and source before awaiting identity transport", async () => {
  const candidate = { candidateKind: "observed-call", pool: POOL }, source = { ...SOURCE };
  const f = fixture({ onRequest: () => { candidate.pool = OUTPUT; source.number = 999; } });
  const result = await previewFamilyCandidateRoutes({ ...f.input, candidate, source });
  assert(result.preview); assert.equal(result.preview.instanceKey, POOL); assert.deepEqual(result.preview.source, SOURCE);
});

test("preview requires an issued Family and central shared bindings, and respects identity limits", async () => {
  const f = fixture();
  await assert.rejects(previewFamilyCandidateRoutes({ ...f.input, sharedBindings: [] } as any), /caller-provided shared bindings/);
  await assert.rejects(previewFamilyCandidateRoutes({ ...f.input, family: { ...f.family } }), /catalog-issued|issued|catalog/);
  const limited = await previewFamilyCandidateRoutes({ ...f.input, limits: { maxIdentityStepsPerVariant: 0 } });
  assert.equal(limited.preview, null); assert.deepEqual(f.requestIds, []);
  assert(limited.outcomes.some(row => row.reasonCode.includes("budget-exhausted")));
});

test("memo binding-only opt-in and its stop-before-routes behavior are unchanged", async () => {
  const ordinary = fixture();
  await assert.rejects(recheckFamilyInstanceMemoBinding(ordinary.input), /not opted into/);
  const opted = fixture({ memoRecheck: true }), binding = await recheckFamilyInstanceMemoBinding(opted.input);
  assert(binding); assert.equal(binding.instanceKey, POOL);
  assert.deepEqual(opted.requestIds, ["identity", "instance-static", "shared-binding"]);
  assert.deepEqual(opted.counts(), { pricingCalls: 0, routeCalls: 0 });
  assert(!Object.hasOwn(binding, "routes") && !Object.hasOwn(binding, "descriptor"));
});
