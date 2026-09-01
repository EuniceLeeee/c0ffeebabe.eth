import {
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  hashCanonicalPartition,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  decodeCanonicalCutoff,
  decodeRawEvidenceLocatorContent,
  decodeSourcePlanDiscoveryResult,
  decodeSourcePlanEvidenceReceipt,
  decodePersistedSourcePlanExecutionSet,
  sealPersistedSourcePlanExecution,
  sealPersistedSourcePlanExecutionSet,
  validatePersistedExecutionCoverage,
  decodeSourcePlanExecution,
  decodeSourcePlanRef,
  decodeCandidateNomination,
  candidatePartitionRoot,
  familyCandidateKey,
  mergeAndDedupeNominations,
  sourcePlanIdentity,
  sourcePlanDiscoveryRoot,
  type RawEvidenceLocatorContentV1,
  type CandidateNominationV1,
  type CanonicalCutoffV1,
  type SourcePlanEvidenceReceiptV1,
  type SourcePlanExecutionV1,
  type SourcePlanRefV1,
  type PersistedSourcePlanExecutionV1,
  type PersistedSourcePlanExecutionSetV1,
  type SourceCoverageCertificateV1,
} from "../../../../packages/discovery/src/index.ts";
import {
  decodeFamilySourcePlanPhysicalRequest,
  decodeFamilySourcePlanPhysicalObservation,
  assertFamilySourcePlanNominationProgram,
  type FamilySourcePlanPhysicalObservationV1,
  type FamilySourcePlanPhysicalPortV1,
  type FamilySourcePlanPhysicalRequestV1,
  type FamilySourcePlanRuntimeV1,
  type FamilySourcePlanNominationProgramV1,
  type FamilySourcePlanExecutionPredecessorV1,
} from "../../../../packages/family-sdk/runtime/index.ts";
import { issueFamilyRawEvidenceReadPort } from "../../../../packages/family-sdk/runtime/index.ts";
import {
  createDiscoveryTransport,
  createHttpJsonRpcDiscoveryPort,
  type DiscoveryProviderRef,
} from "../../../../packages/discovery-transport/src/index.ts";
import {
  decodeRuntimeAuthorityProjectionV1,
  type RuntimeAuthorityProjectionV1,
} from "../../../../packages/runtime-authority/src/index.ts";
import type { WorkScheduler } from "../../../../packages/scheduler/src/index.ts";
import type {
  BuilderCatalogV1,
  BuilderDiscoveryPort,
  BuilderNominationCapabilityV1,
  SourcePlanPredecessorClosureV1,
} from "../../../../packages/generation-builder/src/index.ts";
import type {
  RecentObservationReceiptV1,
} from "../../../../packages/observation/src/index.ts";
import { RecentObservationRpcObserver } from "../../../../packages/recent-observation-rpc/src/index.ts";
import {
  nominationEvidenceRefHash,
  sealNominationClosureV1,
  sealQualifiedSourcePlanNominationReceiptV1,
  type NominationDenominatorV1,
  type NominationClosureV1,
} from "../../../../specs/nomination-authority/src/index.ts";

export interface RuntimeSourcePlanBindingV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: `0x${string}`;
  readonly sourcePlanRef: SourcePlanRefV1;
  readonly sourcePlanLeafDigest: Hash;
  readonly sourcePlanSchemaHash: Hash;
  readonly sourcePlanClosureRoot: Hash;
  readonly runtime: FamilySourcePlanRuntimeV1;
  readonly nominationProgram: FamilySourcePlanNominationProgramV1;
  readonly nominationProgramRoot: Hash;
  readonly nominationProgramProposalLeafDigest: Hash;
}

interface IssuedSourceResultV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly sourcePlanLeafDigest: Hash;
  readonly execution: SourcePlanExecutionV1;
  readonly persistedExecution: PersistedSourcePlanExecutionV1;
  readonly sourceEvidence: SourcePlanEvidenceReceiptV1;
  readonly runtime: FamilySourcePlanRuntimeV1;
  readonly nominationProgram: FamilySourcePlanNominationProgramV1;
  readonly nominationProgramRoot: Hash;
  readonly nominationProgramProposalLeafDigest: Hash;
  readonly rawEvidenceLocators: readonly RawEvidenceLocatorContentV1[];
}

interface SelectedPredecessorV1 {
  readonly persisted: PersistedSourcePlanExecutionV1;
  readonly runtime: FamilySourcePlanExecutionPredecessorV1;
  readonly rawEvidenceLocators: readonly RawEvidenceLocatorContentV1[];
}

export interface RuntimeDiscoveryBindingV1 {
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly processEpoch: string;
}

export interface RuntimeDiscoverySourceV1 {
  readonly profile: "reth-json-rpc-v1";
  readonly endpoint: string;
  readonly chainId: string;
  readonly timeoutMs: number;
  readonly provider: DiscoveryProviderRef;
  readonly sourceAuthorityRoot: Hash;
}

interface PhysicalLedgerEntryV1 {
  readonly rawEvidenceLocator: RawEvidenceLocatorContentV1;
  readonly evidenceRef: Hash;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalJson(value: unknown, path: string): CanonicalJson {
  try {
    return decodeCanonicalJson(encodeCanonicalJson(value));
  } catch {
    throw new TypeError(`${path} is not canonical JSON`);
  }
}

function runtimeDiscoveryBinding(
  value: RuntimeDiscoveryBindingV1,
): RuntimeDiscoveryBindingV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("runtime discovery binding is required");
  }
  const keys = Reflect.ownKeys(value).map(key => {
    if (typeof key !== "string") throw new TypeError("runtime discovery binding has a symbol field");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`runtime discovery binding has an accessor field ${key}`);
    }
    return key;
  }).sort();
  if (keys.length !== 2 || keys[0] !== "processEpoch" || keys[1] !== "runtimeAuthority") {
    throw new TypeError("runtime discovery binding has non-exact fields");
  }
  if (typeof value.processEpoch !== "string" || value.processEpoch.length === 0) {
    throw new TypeError("runtime discovery process epoch is required");
  }
  return Object.freeze({
    runtimeAuthority: decodeRuntimeAuthorityProjectionV1(value.runtimeAuthority),
    processEpoch: value.processEpoch,
  });
}

function runtimeDiscoverySource(value: RuntimeDiscoverySourceV1): RuntimeDiscoverySourceV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("runtime discovery source is required");
  }
  const keys = Reflect.ownKeys(value).map(key => {
    if (typeof key !== "string") throw new TypeError("runtime discovery source has a symbol field");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`runtime discovery source has an accessor field ${key}`);
    }
    return key;
  }).sort();
  const expected = ["chainId", "endpoint", "profile", "provider", "sourceAuthorityRoot", "timeoutMs"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError("runtime discovery source has non-exact fields");
  }
  if (value.profile !== "reth-json-rpc-v1") throw new TypeError("runtime discovery source profile is invalid");
  let endpoint: URL;
  try { endpoint = new URL(value.endpoint); } catch { throw new TypeError("runtime discovery endpoint must be a URL"); }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new TypeError("runtime discovery endpoint must use HTTP(S)");
  }
  if (!/^(0|[1-9][0-9]*)$/.test(value.chainId)) throw new TypeError("runtime discovery chainId is invalid");
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 60_000) {
    throw new TypeError("runtime discovery timeoutMs is invalid");
  }
  if (value.provider === null || typeof value.provider !== "object"
    || typeof value.provider.provider !== "string" || value.provider.provider.length === 0
    || typeof value.provider.backendEpoch !== "string" || value.provider.backendEpoch.length === 0) {
    throw new TypeError("runtime discovery provider is invalid");
  }
  return Object.freeze({
    profile: value.profile,
    endpoint: endpoint.href,
    chainId: value.chainId,
    timeoutMs: value.timeoutMs,
    provider: Object.freeze({ ...value.provider }),
    sourceAuthorityRoot: value.sourceAuthorityRoot,
  });
}

function assertExactPhysicalLedger(
  completeness: SourcePlanRefV1["completeness"],
  returnedLocators: readonly RawEvidenceLocatorContentV1[],
  sourceEvidence: SourcePlanEvidenceReceiptV1,
  ledger: ReadonlyMap<Hash, PhysicalLedgerEntryV1>,
  predecessor: SelectedPredecessorV1 | null,
): readonly RawEvidenceLocatorContentV1[] {
  if (completeness === "nomination-only" && ledger.size !== 0) {
    throw new TypeError("nomination-only source plan performed a physical request");
  }
  if (completeness !== "nomination-only" && ledger.size === 0) {
    throw new TypeError("complete source plan has no physical observation");
  }
  const expectedLedger = new Map<Hash, PhysicalLedgerEntryV1>(ledger);
  if (predecessor !== null) {
    const priorRefs = new Map(predecessor.runtime.sourceEvidence.refs.map(ref => [ref.rawLocatorHash, ref]));
    for (const locator of predecessor.rawEvidenceLocators) {
      const ref = priorRefs.get(locator.rawLocatorHash);
      if (ref === undefined) throw new TypeError("predecessor raw evidence has no source evidence ref");
      const current = expectedLedger.get(locator.rawLocatorHash);
      if (current !== undefined && (!sameBytes(current.rawEvidenceLocator.bytes, locator.bytes) || current.evidenceRef !== ref.evidenceRef)) {
        throw new TypeError("predecessor/current physical evidence conflicts");
      }
      expectedLedger.set(locator.rawLocatorHash, Object.freeze({ rawEvidenceLocator: locator, evidenceRef: ref.evidenceRef }));
    }
  }
  if (!Array.isArray(returnedLocators) || returnedLocators.length !== expectedLedger.size) {
    throw new TypeError("source plan raw evidence does not match physical observations");
  }
  const decoded = returnedLocators.map((value, index) =>
    decodeRawEvidenceLocatorContent(value, `sourcePlanRuntime.rawEvidenceLocators[${index}]`));
  const returnedByHash = new Map(decoded.map(value => [value.rawLocatorHash, value]));
  if (returnedByHash.size !== decoded.length || returnedByHash.size !== expectedLedger.size) {
    throw new TypeError("source plan raw evidence contains a duplicate or omission");
  }
  for (const [hash, entry] of expectedLedger) {
    const returned = returnedByHash.get(hash);
    if (returned === undefined || !sameBytes(returned.bytes, entry.rawEvidenceLocator.bytes)) {
      throw new TypeError("source plan raw evidence bytes were not issued by the physical owner");
    }
  }
  if (sourceEvidence.rawLocatorHashes.length !== expectedLedger.size || sourceEvidence.refs.length !== expectedLedger.size) {
    throw new TypeError("source plan evidence does not cover every physical observation");
  }
  for (const ref of sourceEvidence.refs) {
    const entry = expectedLedger.get(ref.rawLocatorHash);
    if (entry === undefined || ref.evidenceRef !== entry.evidenceRef) {
      throw new TypeError("source plan evidence ref was not issued by the physical owner");
    }
  }
  const rawHashes = [...expectedLedger.keys()].sort(compareText);
  if (sourceEvidence.rawLocatorHashes.some((hash, index) => hash !== rawHashes[index])) {
    throw new TypeError("source plan evidence locator set differs from physical observations");
  }
  return Object.freeze(rawHashes.map(hash => expectedLedger.get(hash)!.rawEvidenceLocator));
}

function assertSameCutoff(left: CanonicalCutoffV1, right: CanonicalCutoffV1): void {
  if (!sameCanonical(decodeCanonicalCutoff(left), decodeCanonicalCutoff(right))) {
    throw new TypeError("source-plan-cutoff-mismatch");
  }
}

function assertExactCatalogPlans(
  catalog: BuilderCatalogV1,
  bindings: readonly RuntimeSourcePlanBindingV1[],
): void {
  if (!Array.isArray(catalog.declaredSourcePlans)) throw new TypeError("generated source plan catalog is required");
  const actual = catalog.declaredSourcePlans.map((plan, index) =>
    decodeSourcePlanRef(plan, "catalog.declaredSourcePlans[" + index + "]"))
    .sort((left, right) => sourcePlanIdentity(left).localeCompare(sourcePlanIdentity(right)));
  const expected = bindings.map(binding => binding.sourcePlanRef)
    .sort((left, right) => sourcePlanIdentity(left).localeCompare(sourcePlanIdentity(right)));
  if (
    actual.length !== expected.length
    || actual.some((plan, index) => !sameCanonical(plan, expected[index]))
  ) throw new TypeError("generated source plan catalog mismatch");
}

async function boundedMap<T, R>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      output[index] = await run(values[index]!);
    }
  });
  await Promise.all(workers);
  return Object.freeze(output);
}

/**
 * Release-owned generic orchestration. Generated bindings choose the exact
 * plans and Family interpreters; deployment supplies only physical chain
 * reads and the qualified recent observer.
 */
export function createRuntimeDiscoveryPort(input: {
  readonly bindings: readonly RuntimeSourcePlanBindingV1[];
  readonly source: RuntimeDiscoverySourceV1;
  readonly scheduler: WorkScheduler;
  readonly runtime: RuntimeDiscoveryBindingV1;
  readonly assertCurrent: () => void;
}): BuilderDiscoveryPort {
  if (!Array.isArray(input.bindings) || input.bindings.length === 0) throw new TypeError("generated source plan bindings are required");
  const source = runtimeDiscoverySource(input.source);
  const runtime = runtimeDiscoveryBinding(input.runtime);
  if (typeof input.assertCurrent !== "function") throw new TypeError("runtime fence is required");

  const sourceAuthorityRoot = source.sourceAuthorityRoot;
  const provider: DiscoveryProviderRef = source.provider;
  const transport = createDiscoveryTransport({
    scheduler: input.scheduler,
    caller: Object.freeze({
      callerId: `runtime-discovery:${runtime.runtimeAuthority.authorityBindingHash}`,
      authorityToken: sourceAuthorityRoot,
    }),
    port: createHttpJsonRpcDiscoveryPort({ endpoint: source.endpoint }),
    defaultTimeoutMs: source.timeoutMs,
  });
  const recent = new RecentObservationRpcObserver({ transport, provider });
  const observeSourceAnchor = async (
    cutoff: CanonicalCutoffV1,
    signal: AbortSignal,
  ): Promise<Hash> => {
    const request = async (method: string, params: CanonicalJson): Promise<CanonicalJson> => {
      const requestId = hashDomain("aloha/runtime-discovery-source-anchor-request/v1", {
        runtimeAuthority: runtime.runtimeAuthority,
        sourceAuthorityRoot,
        cutoff,
        method,
        params,
      });
      return canonicalJson(await transport.request({
        requestId,
        provider,
        source: cutoff,
        method,
        params,
        requestCodec: "ethereum-json-rpc-result.v1",
        target: method === "eth_getBlockByNumber" ? cutoff.number : null,
        manager: null,
        topic: null,
        lookback: null,
        chunk: null,
        phase: "source-anchor",
        workClassRef: "source-anchor-rpc",
        ownerRef: "runtime.discovery-source.v1",
        signal,
      }), "runtime discovery source anchor response");
    };
    const chainIdResult = await request("eth_chainId", Object.freeze([]));
    if (
      typeof chainIdResult !== "string"
      || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(chainIdResult)
      || BigInt(chainIdResult).toString() !== cutoff.chainId
    ) throw new TypeError("runtime discovery source chain id mismatch");
    const blockTag = `0x${BigInt(cutoff.number).toString(16)}`;
    const headerResult = await request("eth_getBlockByNumber", Object.freeze([blockTag, false]));
    if (headerResult === null || typeof headerResult !== "object" || Array.isArray(headerResult)) {
      throw new TypeError("runtime discovery cutoff header is unavailable");
    }
    const header = headerResult as Readonly<Record<string, CanonicalJson>>;
    if (
      typeof header.number !== "string"
      || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(header.number)
      || BigInt(header.number).toString() !== cutoff.number
      || header.hash !== cutoff.hash
      || header.stateRoot !== cutoff.stateRoot
    ) throw new TypeError("runtime discovery cutoff header mismatch");
    return hashDomain("aloha/runtime-discovery-source-anchor/v1", {
      runtimeAuthority: runtime.runtimeAuthority,
      sourceAuthorityRoot,
      cutoff,
      chainIdResult,
      block: Object.freeze({ number: header.number, hash: header.hash, stateRoot: header.stateRoot }),
    });
  };

  const bindings = Object.freeze(input.bindings.map((binding, index) => {
    if (binding === null || typeof binding !== "object") throw new TypeError("source plan binding " + index + " is invalid");
    const sourcePlanRef = decodeSourcePlanRef(binding.sourcePlanRef, "sourcePlanBindings[" + index + "].sourcePlanRef");
    assertFamilySourcePlanNominationProgram(binding.nominationProgram, "sourcePlanBindings[" + index + "].nominationProgram");
    if (
      binding.familyDefinitionHash !== sourcePlanRef.familyDefinitionHash
      || !/^0x[0-9a-f]{64}$/.test(binding.sourcePlanLeafDigest)
      || binding.sourcePlanSchemaHash !== binding.runtime.schemaHash
      || !/^0x[0-9a-f]{64}$/.test(binding.sourcePlanClosureRoot)
      || !/^0x[0-9a-f]{64}$/.test(binding.nominationProgramRoot)
      || !/^0x[0-9a-f]{64}$/.test(binding.nominationProgramProposalLeafDigest)
      || binding.runtime.sourcePlanId.length === 0
      || binding.runtime.completeness !== sourcePlanRef.completeness
      || binding.runtime.historyStartBlock !== sourcePlanRef.historyStartBlock
    ) throw new TypeError("source plan binding " + index + " identity mismatch");
    return Object.freeze({ ...binding, sourcePlanRef });
  }).sort((left, right) => sourcePlanIdentity(left.sourcePlanRef).localeCompare(sourcePlanIdentity(right.sourcePlanRef))));
  if (new Set(bindings.map(binding => sourcePlanIdentity(binding.sourcePlanRef))).size !== bindings.length) {
    throw new TypeError("duplicate generated source plan binding");
  }

  const selectPredecessor = (
    binding: (typeof bindings)[number],
    predecessor: SourcePlanPredecessorClosureV1 | null,
    currentCutoff: CanonicalCutoffV1,
  ): SelectedPredecessorV1 | null => {
    if (binding.sourcePlanRef.completeness !== "contiguous-history" || predecessor === null) return null;
    let executionSet: PersistedSourcePlanExecutionSetV1;
    try {
      executionSet = decodePersistedSourcePlanExecutionSet(predecessor.sourceExecutionSet);
      validatePersistedExecutionCoverage(executionSet, predecessor.sourceCoverage);
    } catch (error) {
      throw new TypeError("source plan predecessor closure is invalid", { cause: error });
    }
    if (
      executionSet.cutoff.chainId !== currentCutoff.chainId
      || BigInt(executionSet.cutoff.number) >= BigInt(currentCutoff.number)
    ) throw new TypeError("source plan predecessor cutoff is not an earlier canonical cursor");
    const persisted = executionSet.executions.find(value => sourcePlanIdentity(value.execution.plan) === sourcePlanIdentity(binding.sourcePlanRef));
    if (persisted === undefined) return null;
    if (
      !sameCanonical(persisted.execution.plan, binding.sourcePlanRef)
      || persisted.sourcePlanLeafDigest !== binding.sourcePlanLeafDigest
      || persisted.sourcePlanSchemaHash !== binding.sourcePlanSchemaHash
      || persisted.sourcePlanClosureRoot !== binding.sourcePlanClosureRoot
      || persisted.sourceAuthorityRoot !== sourceAuthorityRoot
    ) return null;
    if (
      persisted.execution.outcome !== "complete"
      || persisted.execution.through !== executionSet.cutoff.number
    ) throw new TypeError("source plan predecessor cursor has a coverage gap");
    try {
      const sourceEvidence: SourcePlanEvidenceReceiptV1 = deepFreeze({
        kind: "source-plan-evidence",
        version: 1,
        plan: persisted.execution.plan,
        cutoff: persisted.execution.cutoff,
        refs: persisted.execution.sourceEvidenceRefs,
        rawLocatorHashes: persisted.execution.rawLocatorHashes,
        evidenceRoot: persisted.execution.sourceEvidenceRoot,
      });
      decodeSourcePlanEvidenceReceipt(sourceEvidence, "sourcePlanPredecessor.sourceEvidence");
      const allRaw = new Map(predecessor.rawEvidenceLocators.map((value, index) => {
        const decoded = decodeRawEvidenceLocatorContent(value, `sourcePlanPredecessor.rawEvidenceLocators[${index}]`);
        return [decoded.rawLocatorHash, decoded] as const;
      }));
      const rawEvidenceLocators = sourceEvidence.rawLocatorHashes.map(hash => {
        const value = allRaw.get(hash);
        if (value === undefined) throw new TypeError("source plan predecessor raw evidence is incomplete");
        return value;
      });
      let latestPhysicalCount = 0;
      for (const locator of rawEvidenceLocators) {
        const observation = decodeFamilySourcePlanPhysicalObservation(locator.bytes, "sourcePlanPredecessor.physicalObservation");
        if (
          observation.sourceAuthorityRoot !== sourceAuthorityRoot
          || !sameCanonical(observation.plan, binding.sourcePlanRef)
          || observation.familyDefinitionHash !== binding.familyDefinitionHash
        ) throw new TypeError("source plan predecessor physical observation binding mismatch");
        if (sameCanonical(observation.cutoff, persisted.execution.cutoff)) {
          latestPhysicalCount += 1;
          if (
            !sameCanonical(observation.runtimeAuthority, persisted.runtimeAuthority)
            || observation.sourceAnchorRoot !== persisted.sourceAnchorRoot
          ) throw new TypeError("source plan predecessor latest physical observation lineage mismatch");
        }
      }
      if (latestPhysicalCount === 0) throw new TypeError("source plan predecessor has no physical observation at its cursor");
      const rawByHash = new Map(rawEvidenceLocators.map(value => [value.rawLocatorHash, value.bytes]));
      const rawEvidence = Object.freeze({
        read(rawLocatorHash: Hash): Uint8Array {
          const bytes = rawByHash.get(rawLocatorHash);
          if (bytes === undefined) throw new TypeError("source predecessor raw locator is outside the exact execution");
          return new Uint8Array(bytes);
        },
      });
      return Object.freeze({
        persisted,
        runtime: Object.freeze({
          persistedExecutionRoot: persisted.persistedExecutionRoot,
          execution: persisted.execution,
          sourceEvidence,
          rawEvidence,
        }),
        rawEvidenceLocators: Object.freeze(rawEvidenceLocators),
      });
    } catch (error) {
      throw new TypeError("source plan predecessor physical closure is invalid", { cause: error });
    }
  };

  let issued = new Map<string, IssuedSourceResultV1>();
  const nominationCapabilities = new WeakMap<object, Readonly<{
    readonly candidates: ReturnType<typeof mergeAndDedupeNominations>;
    readonly nominationClosure: NominationClosureV1;
  }>>();
  const port: BuilderDiscoveryPort = {
    async executeAllDeclaredPlans(
      catalog: BuilderCatalogV1,
      cutoff: CanonicalCutoffV1,
      predecessorClosure: SourcePlanPredecessorClosureV1 | null,
      signal: AbortSignal,
    ) {
      input.assertCurrent();
      assertExactCatalogPlans(catalog, bindings);
      const canonicalCutoff = decodeCanonicalCutoff(cutoff);
      if (canonicalCutoff.chainId !== source.chainId) throw new TypeError("runtime discovery chain mismatch");
      const sourceAnchorRoot = await observeSourceAnchor(canonicalCutoff, signal);
      input.assertCurrent();
      const results = await boundedMap(bindings, 8, async binding => {
        if (signal.aborted) throw signal.reason;
        const predecessor = selectPredecessor(binding, predecessorClosure, canonicalCutoff);
        const physicalLedger = new Map<Hash, PhysicalLedgerEntryV1>();
        const physicalRequestIds = new Set<Hash>();
        const physical: FamilySourcePlanPhysicalPortV1 = Object.freeze({
          async request(requestValue: FamilySourcePlanPhysicalRequestV1, requestSignal: AbortSignal) {
            input.assertCurrent();
            if (requestSignal !== signal) throw new TypeError("source plan physical request changed its run signal");
            const request = decodeFamilySourcePlanPhysicalRequest(requestValue);
            if (
              request.familyDefinitionHash !== binding.familyDefinitionHash
              || !sameCanonical(request.plan, binding.sourcePlanRef)
              || !sameCanonical(request.cutoff, canonicalCutoff)
              || request.requestSchemaHash !== binding.runtime.schemaHash
            ) throw new TypeError("source plan physical request binding mismatch");
            const requestId = hashDomain("aloha/source-plan-physical-request/v1", {
              runtimeAuthority: runtime.runtimeAuthority,
              sourceAuthorityRoot,
              sourceAnchorRoot,
              familyDefinitionHash: request.familyDefinitionHash,
              plan: request.plan,
              cutoff: request.cutoff,
              requestSchemaHash: request.requestSchemaHash,
              request: request.request,
            });
            if (physicalRequestIds.has(requestId)) throw new TypeError("duplicate source plan physical request");
            physicalRequestIds.add(requestId);
            const response = canonicalJson(await transport.request({
              requestId,
              provider,
              source: canonicalCutoff,
              method: request.request.method,
              params: request.request.params,
              requestCodec: request.requestSchemaHash,
              target: request.request.target,
              manager: request.request.manager,
              topic: request.request.topic,
              lookback: request.request.lookback,
              chunk: request.request.chunk,
              phase: "source-plan",
              workClassRef: "source-plan-rpc",
              ownerRef: request.plan.ownerRef,
              signal: requestSignal,
            }), "source plan physical response");
            input.assertCurrent();
            const observation: FamilySourcePlanPhysicalObservationV1 = deepFreeze({
              kind: "family-source-plan-physical-observation",
              version: 1,
              requestId,
              runtimeAuthority: runtime.runtimeAuthority,
              sourceAuthorityRoot,
              sourceAnchorRoot,
              provider: provider.provider,
              backendEpoch: provider.backendEpoch,
              familyDefinitionHash: request.familyDefinitionHash,
              plan: request.plan,
              cutoff: request.cutoff,
              requestSchemaHash: request.requestSchemaHash,
              request: request.request,
              response,
            });
            const bytes = encodeCanonicalBytes(observation);
            const rawLocatorHash = sha256Hex(bytes);
            const evidenceRef = hashDomain("aloha/source-plan-physical-evidence/v1", {
              runtimeAuthority: runtime.runtimeAuthority,
              sourceAuthorityRoot,
              sourceAnchorRoot,
              requestId,
              rawLocatorHash,
            });
            physicalLedger.set(rawLocatorHash, Object.freeze({
              rawEvidenceLocator: Object.freeze({
                kind: "raw-evidence-locator",
                version: 1,
                rawLocatorHash,
                bytes,
              }),
              evidenceRef,
            }));
            return Object.freeze({
              response,
              rawLocatorHash,
              evidenceRef,
              rawEvidenceLocator: Object.freeze({
                kind: "raw-evidence-locator" as const,
                version: 1 as const,
                rawLocatorHash,
                bytes: new Uint8Array(bytes),
              }),
            });
          },
        });
        const raw = await binding.runtime.execute({
          plan: binding.sourcePlanRef,
          cutoff: canonicalCutoff,
          previousAppliedThrough: predecessor?.runtime.execution.through ?? null,
          predecessor: predecessor?.runtime ?? null,
        }, physical, signal);
        input.assertCurrent();
        if (raw === null || typeof raw !== "object") throw new TypeError("source plan runtime returned an invalid result");
        const execution = decodeSourcePlanExecution(raw.execution, "sourcePlanRuntime.execution");
        if (!sameCanonical(execution.plan, binding.sourcePlanRef)) throw new TypeError("source plan runtime changed its plan binding");
        assertSameCutoff(execution.cutoff, canonicalCutoff);
        if (execution.previousAppliedThrough !== (predecessor?.runtime.execution.through ?? null)) {
          throw new TypeError("source plan runtime changed its durable predecessor watermark");
        }
        const sourceEvidence = decodeSourcePlanEvidenceReceipt(raw.sourceEvidence, "sourcePlanRuntime.sourceEvidence");
        if (
          !sameCanonical(sourceEvidence.plan, execution.plan)
          || !sameCanonical(sourceEvidence.cutoff, execution.cutoff)
          || sourceEvidence.evidenceRoot !== execution.sourceEvidenceRoot
          || !sameCanonical(sourceEvidence.refs, execution.sourceEvidenceRefs)
          || !sameCanonical(sourceEvidence.rawLocatorHashes, execution.rawLocatorHashes)
        ) throw new TypeError("source plan runtime evidence binding mismatch");
        const rawEvidenceLocators = assertExactPhysicalLedger(
          binding.sourcePlanRef.completeness,
          raw.rawEvidenceLocators,
          sourceEvidence,
          physicalLedger,
          predecessor,
        );
        const persistedExecution = sealPersistedSourcePlanExecution({
          execution,
          sourcePlanLeafDigest: binding.sourcePlanLeafDigest,
          sourcePlanSchemaHash: binding.sourcePlanSchemaHash,
          sourcePlanClosureRoot: binding.sourcePlanClosureRoot,
          sourceAuthorityRoot,
          runtimeAuthority: runtime.runtimeAuthority,
          sourceAnchorRoot,
          previousExecutionRoot: predecessor?.persisted.persistedExecutionRoot ?? null,
        });
        return Object.freeze({
          familyId: binding.familyId,
          familyDefinitionHash: binding.familyDefinitionHash,
          sourcePlanLeafDigest: binding.sourcePlanLeafDigest,
          execution,
          persistedExecution,
          sourceEvidence,
          runtime: binding.runtime,
          nominationProgram: binding.nominationProgram,
          nominationProgramRoot: binding.nominationProgramRoot,
          nominationProgramProposalLeafDigest: binding.nominationProgramProposalLeafDigest,
          rawEvidenceLocators,
        });
      });
      const executions = [...results]
        .sort((left, right) => compareText(sourcePlanIdentity(left.execution.plan), sourcePlanIdentity(right.execution.plan)))
        .map(result => result.execution);
      const evidence = [...results]
        .sort((left, right) => compareText(sourcePlanIdentity(left.execution.plan), sourcePlanIdentity(right.execution.plan)))
        .map(result => result.sourceEvidence);
      const rawByHash = new Map<string, RawEvidenceLocatorContentV1>();
      for (const result of results) {
        for (const locator of result.rawEvidenceLocators) {
          const existing = rawByHash.get(locator.rawLocatorHash);
          if (existing !== undefined && !sameBytes(existing.bytes, locator.bytes)) {
            throw new TypeError("source plan raw evidence locator bytes conflict");
          }
          rawByHash.set(locator.rawLocatorHash, locator);
        }
      }
      const rawEvidenceLocators = [...rawByHash.values()].sort((left, right) => compareText(left.rawLocatorHash, right.rawLocatorHash));
      const discovery = decodeSourcePlanDiscoveryResult({
        kind: "source-plan-discovery",
        version: 1,
        executions,
        evidence,
        rawEvidenceLocators,
        discoveryRoot: sourcePlanDiscoveryRoot({ executions, evidence, rawEvidenceLocators }),
      });
      const sourceExecutionSet = sealPersistedSourcePlanExecutionSet(
        canonicalCutoff,
        results.map(result => result.persistedExecution),
      );
      issued = new Map(results.map(result => [sourcePlanIdentity(result.execution.plan), result]));
      return Object.freeze({ discovery, sourceExecutionSet });
    },
    async scanRecentBlocks(cutoff: CanonicalCutoffV1, signal: AbortSignal) {
      input.assertCurrent();
      const canonicalCutoff = decodeCanonicalCutoff(cutoff);
      if (canonicalCutoff.chainId !== source.chainId) throw new TypeError("runtime discovery chain mismatch");
      const scan = await recent.scan(canonicalCutoff, signal);
      input.assertCurrent();
      return scan;
    },
    async nominateAll(
      catalog: BuilderCatalogV1,
      cutoff: CanonicalCutoffV1,
      sourceExecutions: readonly SourcePlanExecutionV1[],
      sourceEvidence: readonly SourcePlanEvidenceReceiptV1[],
      sourceRawEvidenceLocators: readonly RawEvidenceLocatorContentV1[],
      recent: RecentObservationReceiptV1,
      recentRawEvidenceLocators: readonly RawEvidenceLocatorContentV1[],
      sourceExecutionSetValue: PersistedSourcePlanExecutionSetV1,
      sourceCoverage: SourceCoverageCertificateV1,
      signal: AbortSignal,
    ) {
      input.assertCurrent();
      assertExactCatalogPlans(catalog, bindings);
      const canonicalCutoff = decodeCanonicalCutoff(cutoff);
      assertSameCutoff(canonicalCutoff, recent.cutoff);
      const sourceExecutionSet = decodePersistedSourcePlanExecutionSet(sourceExecutionSetValue);
      validatePersistedExecutionCoverage(sourceExecutionSet, sourceCoverage);
      assertSameCutoff(canonicalCutoff, sourceExecutionSet.cutoff);
      if (!Array.isArray(sourceExecutions) || sourceExecutions.length !== bindings.length) {
        throw new TypeError("source plan execution set is incomplete");
      }
      const normalized = sourceExecutions.map((execution, index) =>
        decodeSourcePlanExecution(execution, "sourceExecutions[" + index + "]"));
      const normalizedEvidence = sourceEvidence.map((receipt, index) =>
        decodeSourcePlanEvidenceReceipt(receipt, "sourceEvidence[" + index + "]"));
      if (normalizedEvidence.length !== normalized.length) throw new TypeError("source plan evidence set is incomplete");
      const sourceEvidenceByPlan = new Map(normalizedEvidence.map(receipt => [sourcePlanIdentity(receipt.plan), receipt]));
      if (sourceEvidenceByPlan.size !== normalizedEvidence.length) throw new TypeError("source plan evidence set contains duplicates");
      const rawByHash = new Map<string, RawEvidenceLocatorContentV1>();
      for (const locator of [...recentRawEvidenceLocators, ...sourceRawEvidenceLocators]) {
        if (rawByHash.has(locator.rawLocatorHash)) continue;
        rawByHash.set(locator.rawLocatorHash, locator);
      }
      const issuedForRun = issued;
      issued = new Map();
      const receiptsAndNominations = await boundedMap(normalized, 8, async execution => {
        const identity = sourcePlanIdentity(execution.plan);
        const result = issuedForRun.get(identity);
        if (result === undefined || !sameCanonical(result.execution, execution)) {
          throw new TypeError("source plan execution was not issued by this runtime");
        }
        const persisted = sourceExecutionSet.executions.find(value =>
          sourcePlanIdentity(value.execution.plan) === identity);
        if (persisted === undefined || !sameCanonical(persisted, result.persistedExecution)) {
          throw new TypeError("persisted source plan execution was not issued by this runtime");
        }
        const receipt = sourceEvidenceByPlan.get(identity);
        if (receipt === undefined || !sameCanonical(receipt, result.sourceEvidence)) {
          throw new TypeError("source plan evidence was not issued by this runtime");
        }
        assertSameCutoff(execution.cutoff, canonicalCutoff);
        const expectedHashes = new Set([...recent.rawLocatorHashes, ...receipt.rawLocatorHashes]);
        const familyRawEvidence = [...expectedHashes]
          .map(hash => rawByHash.get(hash))
          .filter((value): value is RawEvidenceLocatorContentV1 => value !== undefined)
          .sort((left, right) => compareText(left.rawLocatorHash, right.rawLocatorHash));
        if (familyRawEvidence.length !== expectedHashes.size) throw new TypeError("family raw evidence join is incomplete");
        const rawEvidence = issueFamilyRawEvidenceReadPort({
          values: familyRawEvidence,
          recent,
          sourceEvidence: [receipt],
        });
        const values = await result.nominationProgram.evaluate({
          execution: result.execution,
          sourceEvidence: receipt,
          recent: recent as RecentObservationReceiptV1,
          rawEvidence,
        }, signal);
        input.assertCurrent();
        if (!Array.isArray(values)) throw new TypeError("source plan nomination result must be an array");
        const nominations = values.map((value, index) =>
          decodeCandidateNomination(value, `sourcePlanNomination[${index}]`));
        const allowedEvidence = new Map<string, CandidateNominationV1["evidence"]>();
        const denominator: NominationDenominatorV1 = execution.plan.completeness === "nomination-only"
          ? (() => {
            const relevantEvidenceRefHashes = recent.evidence.map(nominationEvidenceRefHash).sort(compareText);
            for (const evidence of recent.evidence) {
              allowedEvidence.set(encodeCanonicalJson(evidence), evidence);
            }
            return Object.freeze({
              kind: "recent-observation" as const,
              recentObservationRoot: recent.observationRoot,
              relevantEvidenceRefHashes: Object.freeze(relevantEvidenceRefHashes),
              relevantEvidenceRoot: hashCanonicalPartition(
                "aloha/relevant-nomination-evidence/v1",
                relevantEvidenceRefHashes,
              ),
              relevantEvidenceCount: String(relevantEvidenceRefHashes.length),
            });
          })()
          : (() => {
            for (const evidence of receipt.refs) {
              allowedEvidence.set(encodeCanonicalJson(evidence), evidence);
            }
            return Object.freeze({
              kind: execution.plan.completeness === "point-lookup"
                ? "point-lookup" as const
                : execution.plan.completeness === "rolling-observation"
                  ? "rolling-observation" as const
                  : "complete-source-result" as const,
              persistedExecutionRoot: persisted.persistedExecutionRoot,
              resultPartitionRoot: execution.resultPartitionRoot,
            });
          })();
        const claims = nominations.map((nomination, index) => {
          if (
            nomination.familyId !== result.familyId
            || nomination.familyDefinitionHash !== result.familyDefinitionHash
          ) throw new TypeError(`source plan nomination changed Family identity at ${identity}:${index}`);
          const evidence = allowedEvidence.get(encodeCanonicalJson(nomination.evidence));
          if (evidence === undefined) {
            throw new TypeError(`source plan nomination evidence is outside its exact denominator at ${identity}:${index}`);
          }
          return Object.freeze({
            sourcePlanIdentity: identity,
            familyCandidateKey: familyCandidateKey(
              nomination.familyDefinitionHash,
              nomination.instanceNominationKey,
            ),
            instanceNominationKey: nomination.instanceNominationKey,
            evidenceRefHash: nominationEvidenceRefHash(evidence),
          });
        });
        const nominationReceipt = sealQualifiedSourcePlanNominationReceiptV1({
          cutoff: canonicalCutoff,
          familyId: result.familyId,
          familyDefinitionHash: result.familyDefinitionHash,
          sourcePlanIdentity: identity,
          sourcePlanLeafDigest: result.sourcePlanLeafDigest,
          nominationProgramRoot: result.nominationProgramRoot,
          nominationProgramProposalLeafDigest: result.nominationProgramProposalLeafDigest,
          qualificationRoot: hashDomain("aloha/runtime-nomination-program/v1", {
            runtimeAuthority: runtime.runtimeAuthority,
            nominationProgramRoot: result.nominationProgramRoot,
            nominationProgramProposalLeafDigest: result.nominationProgramProposalLeafDigest,
          }),
          denominator,
          claims,
        });
        return Object.freeze({ nominations: Object.freeze(nominations), nominationReceipt });
      });
      input.assertCurrent();
      const nominations = receiptsAndNominations.flatMap(value => value.nominations);
      const candidates = mergeAndDedupeNominations(nominations);
      const partitionRoot = candidatePartitionRoot(candidates);
      const nominationClosure = sealNominationClosureV1({
        cutoff: canonicalCutoff,
        recentObservationRoot: recent.observationRoot,
        sourceExecutionSetRoot: sourceExecutionSet.executionSetRoot,
        sourceCoverageRoot: sourceCoverage.sourceCoverageRoot,
        sourcePlanIdentities: bindings.map(binding => sourcePlanIdentity(binding.sourcePlanRef)),
        receipts: receiptsAndNominations.map(value => value.nominationReceipt),
        candidates,
        candidatePartitionRoot: partitionRoot,
      });
      const capability = Object.freeze(Object.create(null)) as BuilderNominationCapabilityV1;
      nominationCapabilities.set(capability, Object.freeze({ candidates, nominationClosure }));
      return capability;
    },
    readIssuedNomination(capability: BuilderNominationCapabilityV1) {
      input.assertCurrent();
      if (capability === null || typeof capability !== "object") {
        throw new TypeError("nomination capability was not issued by this discovery owner");
      }
      const result = nominationCapabilities.get(capability);
      if (result === undefined) {
        throw new TypeError("nomination capability was not issued by this discovery owner");
      }
      return result;
    },
  };
  return Object.freeze(port);
}
