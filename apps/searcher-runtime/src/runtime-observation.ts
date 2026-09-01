import {
  decodeCanonicalBytes,
  deepFreeze,
  encodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  createSqliteDurableStore,
  type SQLiteDurableStore,
} from "../../../packages/durable-store/src/index.ts";
import {
  readIssuedProducerHeadFactsCapabilityV1,
  readIssuedProducerHeadTerminalCapabilityV1,
  readIssuedProducerLaneCandidateTerminalObservationsV1,
  readIssuedProducerLanePlannerEnumerationV1,
  readIssuedProducerLaneSearchTerminalCapabilityV1,
  type CanonicalHead,
  type ProducerEligibleHeadInputV1,
  type ProducerHeadFactsCapabilityV1,
  type ProducerHeadTerminalCapabilityV1,
  type ProducerPerformancePortV1,
  type ProducerSessionV1,
  type ProducerTerminalPortV1,
} from "../../../packages/producer/src/index.ts";
import {
  issueProducerPerformancePortV1,
  issueProducerTerminalPortV1,
  readIssuedProducerLaneCoarseTimingV1,
} from "../../../packages/producer/src/internal/owners.ts";
import {
  readIssuedNativeFullFamilyAuditChunkBytesV1,
  readIssuedNativeFullFamilyAuditManifestV1,
  readIssuedSearchTerminalCapabilityV1,
  readIssuedSearchTerminalNativeFullFamilyAuditCapabilityV1,
  readIssuedSearchTerminalSixStepTraceV1,
  type NativeFullFamilyAuditChunkRefV1,
  type NativeFullFamilyAuditManifestV1,
} from "../../../packages/search-pipeline/src/index.ts";
import {
  decodeRuntimeAuthorityProjectionV1,
  type RuntimeAuthorityProjectionV1,
} from "../../../packages/runtime-authority/src/index.ts";
import {
  assertIssuedStartupRuntime,
  type StartupRuntimeV1,
} from "../../../packages/startup-runtime/src/index.ts";

const STORE_ROLE = "searcher-runtime-observation-v1";
const STARTUP_NAMESPACE = "runtime/startup/v1";
const HEAD_NAMESPACE = "runtime/head/v1";
const AUDIT_CHUNK_NAMESPACE = "runtime/native-audit-chunk/v1";

type ProducerObservationPortsV1 = Readonly<{
  readonly performance: ProducerPerformancePortV1<unknown>;
  readonly terminal: ProducerTerminalPortV1;
}>;

export interface RuntimeObservationOwnerV1 {
  readonly bindServing: (startup: StartupRuntimeV1) => ProducerObservationPortsV1;
  readonly close: () => void;
}

type AdmissionStateV1 = {
  readonly admissionId: Hash;
  readonly ordinal: string;
  readonly head: CanonicalHead;
  readonly revision: string;
  generationId: string | null;
  facts: ProducerHeadFactsCapabilityV1 | null;
  terminal: ProducerHeadTerminalCapabilityV1 | null;
  appended: boolean;
};

const issuedOwners = new WeakSet<object>();

function sameRuntimeAuthority(
  left: RuntimeAuthorityProjectionV1,
  right: RuntimeAuthorityProjectionV1,
): boolean {
  return left.authorityBindingHash === right.authorityBindingHash
    && left.implementationCommit === right.implementationCommit;
}

function nextSequence(store: SQLiteDurableStore, namespace: string): bigint {
  const rows = store.readAppendLog(namespace);
  return rows.length === 0 ? 0n : BigInt(rows.at(-1)!.sequence) + 1n;
}

function appendCanonical(
  store: SQLiteDurableStore,
  sequences: Map<string, bigint>,
  namespace: string,
  domain: string,
  value: CanonicalJson,
): void {
  const sequence = sequences.get(namespace) ?? nextSequence(store, namespace);
  const bytes = encodeCanonicalBytes(value);
  const contentSha256 = sha256Hex(bytes);
  store.appendFsyncMonotonicCapability({
    namespace,
    sequence: sequence.toString(),
    eventId: hashDomain(domain, { sequence: sequence.toString(), contentSha256 }),
    contentSha256,
    bytes,
  });
  sequences.set(namespace, sequence + 1n);
}

function appendAuditChunks(
  store: SQLiteDurableStore,
  sequences: Map<string, bigint>,
  manifest: NativeFullFamilyAuditManifestV1,
  capability: ReturnType<typeof readIssuedSearchTerminalNativeFullFamilyAuditCapabilityV1>,
): void {
  for (const section of manifest.sections) {
    let ref: NativeFullFamilyAuditChunkRefV1 | null = section.firstChunkRef;
    let count = 0n;
    while (ref !== null) {
      const bytes = readIssuedNativeFullFamilyAuditChunkBytesV1(capability, ref);
      const chunk = decodeCanonicalBytes(bytes) as unknown as {
        readonly nextChunkRef: NativeFullFamilyAuditChunkRefV1 | null;
      };
      const sequence = sequences.get(AUDIT_CHUNK_NAMESPACE)
        ?? nextSequence(store, AUDIT_CHUNK_NAMESPACE);
      store.appendFsyncMonotonicCapability({
        namespace: AUDIT_CHUNK_NAMESPACE,
        sequence: sequence.toString(),
        eventId: hashDomain("aloha/runtime-native-audit-chunk-observation/v1", {
          auditRoot: manifest.auditRoot,
          section: section.section,
          contentSha256: ref.contentSha256,
        }),
        contentSha256: ref.contentSha256,
        bytes,
      });
      sequences.set(AUDIT_CHUNK_NAMESPACE, sequence + 1n);
      ref = chunk.nextChunkRef;
      count += 1n;
      if (count > BigInt(section.chunkCount)) {
        throw new TypeError("runtime native audit chunk chain exceeds its manifest");
      }
    }
    if (count !== BigInt(section.chunkCount)) {
      throw new TypeError("runtime native audit chunk count mismatch");
    }
  }
}

/**
 * Advisory persistence for the exact canonical Producer invocation. It reads
 * only owner-issued terminal capabilities and the native audit retained by
 * that invocation; it never reruns discovery, pricing, planning, exact, or
 * final simulation and cannot issue a qualification/pass verdict.
 */
export function issueRuntimeObservationOwnerV1(input: Readonly<{
  readonly databasePath: string;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
}>): RuntimeObservationOwnerV1 {
  if (typeof input.databasePath !== "string" || !input.databasePath.startsWith("/")) {
    throw new TypeError("runtime observation database path must be absolute");
  }
  const runtimeAuthority = decodeRuntimeAuthorityProjectionV1(input.runtimeAuthority);
  const store = createSqliteDurableStore(input.databasePath);
  store.bindStoreRole(STORE_ROLE);
  const sequences = new Map<string, bigint>();
  let closed = false;
  let bound = false;
  let ordinal = BigInt(store.readAppendLog(HEAD_NAMESPACE).length);
  const admissions = new WeakMap<object, AdmissionStateV1>();
  const admissionsById = new Map<Hash, AdmissionStateV1>();

  const assertOpen = (): void => {
    if (closed) throw new TypeError("runtime observation owner is closed");
  };

  const owner: RuntimeObservationOwnerV1 = Object.freeze({
    bindServing(startup: StartupRuntimeV1): ProducerObservationPortsV1 {
      assertOpen();
      assertIssuedStartupRuntime(startup);
      if (bound) throw new TypeError("runtime observation owner is already bound");
      if (!sameRuntimeAuthority(startup.runtimeAuthority, runtimeAuthority)) {
        throw new TypeError("runtime observation startup authority mismatch");
      }
      bound = true;
      appendCanonical(store, sequences, STARTUP_NAMESPACE, "aloha/runtime-startup-observation/v1", deepFreeze({
        kind: "aloha.runtime-startup-observation-v1",
        runtimeAuthority,
        ready: startup.ready,
      }) as unknown as CanonicalJson);

      const performance = issueProducerPerformancePortV1<unknown>({
        acceptEligibleHead(headInput: ProducerEligibleHeadInputV1) {
          assertOpen();
          ordinal += 1n;
          const admissionId = hashDomain("aloha/runtime-producer-admission-observation/v1", {
            runtimeAuthority,
            ordinal: ordinal.toString(),
            head: headInput.head,
            revision: headInput.revision,
          });
          const state: AdmissionStateV1 = {
            admissionId,
            ordinal: ordinal.toString(),
            head: headInput.head,
            revision: headInput.revision,
            generationId: null,
            facts: null,
            terminal: null,
            appended: false,
          };
          const handle = Object.freeze(Object.create(null));
          admissions.set(handle, state);
          admissionsById.set(admissionId, state);
          return handle;
        },
        readEligibleHeadBinding(handle: unknown) {
          const state = handle !== null && typeof handle === "object" ? admissions.get(handle) : undefined;
          if (state === undefined) throw new TypeError("runtime admitted head is not owner-issued");
          return Object.freeze({
            admissionId: state.admissionId,
            ordinal: state.ordinal,
            headHash: state.head.hash,
            revision: state.revision,
          });
        },
        bindEligibleHeadSession({ eligibleHead, session }: { readonly eligibleHead: unknown; readonly session: ProducerSessionV1 }) {
          const state = eligibleHead !== null && typeof eligibleHead === "object" ? admissions.get(eligibleHead) : undefined;
          if (state === undefined) throw new TypeError("runtime admitted head is not owner-issued");
          const serving = startup.readProducerSessionGeneration(session);
          state.generationId = serving.generationId;
          return eligibleHead;
        },
        bindEligibleHeadFacts({ eligibleHead, facts }: { readonly eligibleHead: unknown; readonly facts: ProducerHeadFactsCapabilityV1 }) {
          const state = eligibleHead !== null && typeof eligibleHead === "object" ? admissions.get(eligibleHead) : undefined;
          if (state === undefined) throw new TypeError("runtime admitted head is not owner-issued");
          const observed = readIssuedProducerHeadFactsCapabilityV1(facts);
          if (observed.headHash !== state.head.hash || observed.generationId !== state.generationId) {
            throw new TypeError("runtime head facts admission mismatch");
          }
          state.facts = facts;
          return eligibleHead;
        },
        sealHeadTerminal({ eligibleHead, terminal }: { readonly eligibleHead: unknown; readonly terminal: ProducerHeadTerminalCapabilityV1 }) {
          const state = eligibleHead !== null && typeof eligibleHead === "object" ? admissions.get(eligibleHead) : undefined;
          if (state === undefined) throw new TypeError("runtime admitted head is not owner-issued");
          const evidence = readIssuedProducerHeadTerminalCapabilityV1(terminal);
          if (evidence.terminal.acceptedId !== state.admissionId
            || evidence.terminal.ordinal !== state.ordinal
            || evidence.terminal.head.hash !== state.head.hash
            || evidence.terminal.revision !== state.revision) {
            throw new TypeError("runtime terminal admission mismatch");
          }
          state.terminal = terminal;
        },
      });

      const terminal = issueProducerTerminalPortV1({
        appendTerminal({ terminal: terminalCapability }) {
          assertOpen();
          const evidence = readIssuedProducerHeadTerminalCapabilityV1(terminalCapability);
          const state = admissionsById.get(evidence.terminal.acceptedId);
          if (state === undefined || state.appended) {
            throw new TypeError("runtime terminal admission is missing or already appended");
          }
          if (state.terminal !== null && state.terminal !== terminalCapability) {
            throw new TypeError("runtime terminal capability changed after seal");
          }
          const facts = evidence.facts === null
            ? null
            : readIssuedProducerHeadFactsCapabilityV1(evidence.facts);
          const lanes = facts?.laneFacts.map(lane => {
            const terminalCapability = readIssuedProducerLaneSearchTerminalCapabilityV1(lane);
            if (terminalCapability === null) {
              return deepFreeze({
                lane,
                planner: null,
                coarseTiming: null,
                candidates: [],
                searchTerminal: null,
                nativeAuditManifest: null,
                successTrace: null,
              });
            }
            const auditCapability = readIssuedSearchTerminalNativeFullFamilyAuditCapabilityV1(terminalCapability);
            const nativeAuditManifest = readIssuedNativeFullFamilyAuditManifestV1(auditCapability);
            appendAuditChunks(store, sequences, nativeAuditManifest, auditCapability);
            const searchTerminal = readIssuedSearchTerminalCapabilityV1(terminalCapability);
            return deepFreeze({
              lane,
              planner: readIssuedProducerLanePlannerEnumerationV1(lane),
              coarseTiming: readIssuedProducerLaneCoarseTimingV1(lane),
              candidates: readIssuedProducerLaneCandidateTerminalObservationsV1(lane),
              searchTerminal,
              nativeAuditManifest,
              successTrace: searchTerminal.kind === "dry-run"
                ? readIssuedSearchTerminalSixStepTraceV1(terminalCapability)
                : null,
            });
          }) ?? [];
          appendCanonical(store, sequences, HEAD_NAMESPACE, "aloha/runtime-head-observation/v1", deepFreeze({
            kind: "aloha.runtime-head-observation-v1",
            runtimeAuthority,
            terminal: evidence.terminal,
            headFacts: facts === null ? null : {
              kind: facts.kind,
              headHash: facts.headHash,
              generationId: facts.generationId,
              graphRoot: facts.graphRoot,
              sourceCoverageRoot: facts.sourceCoverageRoot,
              complete: facts.complete,
              currentSourcePhysical: facts.currentSourcePhysical,
              laneFailureObservations: facts.laneFailureObservations,
              candidateRefs: facts.candidateRefs,
            },
            lanes,
          }) as unknown as CanonicalJson);
          state.appended = true;
        },
      });
      return Object.freeze({ performance, terminal });
    },
    close() {
      if (closed) return;
      closed = true;
      store.close();
    },
  });
  issuedOwners.add(owner);
  return owner;
}

export function assertIssuedRuntimeObservationOwnerV1(
  value: unknown,
): asserts value is RuntimeObservationOwnerV1 {
  if (value === null || typeof value !== "object" || !issuedOwners.has(value)) {
    throw new TypeError("runtime observation owner is not owner-issued");
  }
}
