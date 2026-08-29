import type {
  FullGraphCoarseSweepCapabilityV1,
  FullGraphCoarseSweepEntryChunkV1,
  FullGraphCoarseSweepInvocationCapabilityV1,
  FullGraphCoarseSweepManifestV1,
} from "../../../full-graph-coarse-sweep/src/index.ts";
import {
  issueFullGraphCoarseSweepCapabilityV1,
  readIssuedFullGraphCoarseSweepEntryChunkV1,
  readIssuedFullGraphCoarseSweepManifestV1,
} from "../../../full-graph-coarse-sweep/src/internal/sweep-owner.ts";
import type { FamilyRuntimeCompositionV1 } from "../../../family-composition/src/index.ts";
import { runtimeReleaseBindingProvenanceHash } from "../../../../specs/release-authority/src/index.ts";
import type { RuntimeReleaseAuthorityV1 } from "../index.ts";
import { assertActiveRuntimeReleaseAuthorityState } from "./state.ts";

export interface RuntimeReleaseFullGraphCoarseSweepServiceV1 {
  readonly run: (
    invocation: FullGraphCoarseSweepInvocationCapabilityV1,
    options?: Readonly<{ readonly signal?: AbortSignal; readonly deadlineAtMs?: number }>,
  ) => Promise<FullGraphCoarseSweepCapabilityV1>;
}

interface FamilyRuntimePortV1 {
  readonly openComposition: () => FamilyRuntimeCompositionV1;
}

interface ServiceStateV1 {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly version: bigint;
  readonly runtimeBindingId: `0x${string}`;
  readonly releaseProvenanceHash: `0x${string}`;
  readonly candidateReleaseCommit: string;
  readonly releaseMembershipRoot: `0x${string}`;
  readonly familyRuntime: FamilyRuntimePortV1;
}

interface ResultStateV1 extends ServiceStateV1 {
  readonly capability: FullGraphCoarseSweepCapabilityV1;
}

const serviceStates = new WeakMap<object, ServiceStateV1>();
const resultStates = new WeakMap<object, ResultStateV1>();

function assertCurrent(state: ServiceStateV1): void {
  const current = assertActiveRuntimeReleaseAuthorityState(state.authority);
  if (current.version !== state.version
    || current.binding.bindingId !== state.runtimeBindingId
    || runtimeReleaseBindingProvenanceHash(current.binding) !== state.releaseProvenanceHash
    || current.binding.candidateReleaseCommit !== state.candidateReleaseCommit
    || current.binding.qualifiedCapabilityRefsRoot !== state.releaseMembershipRoot) {
    throw new TypeError("runtime-release full-Graph coarse sweep is stale after rotation");
  }
}

export function issueRuntimeReleaseFullGraphCoarseSweepServiceV1(input: {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly familyRuntime: FamilyRuntimePortV1;
}): RuntimeReleaseFullGraphCoarseSweepServiceV1 {
  const current = assertActiveRuntimeReleaseAuthorityState(input.authority);
  const state: ServiceStateV1 = Object.freeze({
    authority: input.authority,
    version: current.version,
    runtimeBindingId: current.binding.bindingId,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(current.binding),
    candidateReleaseCommit: current.binding.candidateReleaseCommit,
    releaseMembershipRoot: current.binding.qualifiedCapabilityRefsRoot,
    familyRuntime: input.familyRuntime,
  });
  let service: RuntimeReleaseFullGraphCoarseSweepServiceV1;
  service = Object.freeze({
    async run(
      invocation: FullGraphCoarseSweepInvocationCapabilityV1,
      options: Readonly<{ readonly signal?: AbortSignal; readonly deadlineAtMs?: number }> = {},
    ): Promise<FullGraphCoarseSweepCapabilityV1> {
      const issued = serviceStates.get(service);
      if (issued === undefined) throw new TypeError("runtime-release full-Graph coarse sweep service is not owner-issued");
      assertCurrent(issued);
      const capability = await issueFullGraphCoarseSweepCapabilityV1({
        invocation,
        composition: issued.familyRuntime.openComposition(),
        release: {
          runtimeBindingId: issued.runtimeBindingId,
          releaseProvenanceHash: issued.releaseProvenanceHash,
          candidateReleaseCommit: issued.candidateReleaseCommit,
          releaseMembershipRoot: issued.releaseMembershipRoot,
        },
        assertReleaseCurrent: () => assertCurrent(issued),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.deadlineAtMs === undefined ? {} : { deadlineAtMs: options.deadlineAtMs }),
      });
      assertCurrent(issued);
      resultStates.set(capability, Object.freeze({ ...issued, capability }));
      return capability;
    },
  });
  serviceStates.set(service, state);
  return service;
}

export function readRuntimeReleaseFullGraphCoarseSweepManifestCapabilityV1(
  capability: FullGraphCoarseSweepCapabilityV1,
): FullGraphCoarseSweepManifestV1 {
  if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) {
    throw new TypeError("runtime-release full-Graph coarse sweep capability is invalid");
  }
  const state = resultStates.get(capability);
  if (state === undefined) throw new TypeError("runtime-release full-Graph coarse sweep capability was not issued");
  assertCurrent(state);
  return readIssuedFullGraphCoarseSweepManifestV1(state.capability);
}

export function readRuntimeReleaseFullGraphCoarseSweepEntryChunkCapabilityV1(
  capability: FullGraphCoarseSweepCapabilityV1,
  chunkOrdinal: string,
): FullGraphCoarseSweepEntryChunkV1 {
  if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) {
    throw new TypeError("runtime-release full-Graph coarse sweep capability is invalid");
  }
  const state = resultStates.get(capability);
  if (state === undefined) throw new TypeError("runtime-release full-Graph coarse sweep capability was not issued");
  assertCurrent(state);
  return readIssuedFullGraphCoarseSweepEntryChunkV1(state.capability, chunkOrdinal);
}

export function assertIssuedRuntimeReleaseFullGraphCoarseSweepServiceV1(
  value: unknown,
): asserts value is RuntimeReleaseFullGraphCoarseSweepServiceV1 {
  if (value === null || typeof value !== "object" || !serviceStates.has(value)) {
    throw new TypeError("runtime-release full-Graph coarse sweep service is not owner-issued");
  }
  assertCurrent(serviceStates.get(value)!);
}
