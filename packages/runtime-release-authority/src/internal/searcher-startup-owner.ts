import type { Hash } from "../../../../packages/canonical-codec/src/index.ts";
import {
  assertIssuedStartupRuntime,
  type StartupReadyPortV1,
  type StartupRuntimeV1,
} from "../../../../packages/startup-runtime/src/index.ts";
import { assertIssuedStartupReadyPort } from "../../../../packages/startup-runtime/src/internal/ready-owner.ts";
import { runtimeReleaseBindingProvenanceHash } from "../../../../specs/release-authority/src/index.ts";
import type { RuntimeReleaseAuthorityV1 } from "../index.ts";
import { assertActiveRuntimeReleaseAuthorityState } from "./state.ts";
import {
  projectRuntimeAuthorityDescriptorV1,
  type RuntimeAuthorityProjectionV1,
} from "../../../runtime-authority/src/index.ts";

export interface RuntimeReleaseSearcherStartupServiceV1 {
  readonly startStartup: (signal?: AbortSignal) => Promise<StartupRuntimeV1>;
  readonly release: Readonly<{
    readonly bindingId: Hash;
    readonly releaseProvenanceHash: Hash;
    readonly candidateReleaseCommit: `${string}`;
  }>;
}

interface StartupServiceStateV1 {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly version: bigint;
  readonly bindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly candidateReleaseCommit: `${string}`;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly ready: StartupReadyPortV1;
}

const issued = new WeakMap<object, StartupServiceStateV1>();

function current(value: RuntimeReleaseSearcherStartupServiceV1): StartupServiceStateV1 {
  const state = issued.get(value);
  if (state === undefined) throw new TypeError("runtime-release searcher startup service is not owner-issued");
  const authority = assertActiveRuntimeReleaseAuthorityState(state.authority);
  if (authority.version !== state.version
    || authority.binding.bindingId !== state.bindingId
    || runtimeReleaseBindingProvenanceHash(authority.binding) !== state.releaseProvenanceHash) {
    throw new TypeError("runtime-release searcher startup service is stale");
  }
  assertIssuedStartupReadyPort(state.ready);
  return state;
}

/** Issued only by the release bootstrap after the real Ready owner is bound. */
export function issueRuntimeReleaseSearcherStartupService(input: {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly ready: StartupReadyPortV1;
  readonly start: (signal?: AbortSignal) => Promise<StartupRuntimeV1>;
}): RuntimeReleaseSearcherStartupServiceV1 {
  const authority = assertActiveRuntimeReleaseAuthorityState(input.authority);
  assertIssuedStartupReadyPort(input.ready);
  if (typeof input.start !== "function") throw new TypeError("runtime-release startup operation is required");
  const release = Object.freeze({
    bindingId: authority.binding.bindingId,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(authority.binding),
    candidateReleaseCommit: authority.binding.candidateReleaseCommit,
  });
  const runtimeAuthority = projectRuntimeAuthorityDescriptorV1(authority.descriptor);
  let service: RuntimeReleaseSearcherStartupServiceV1;
  service = Object.freeze({
    release,
    async startStartup(signal?: AbortSignal): Promise<StartupRuntimeV1> {
      const state = current(service);
      const startup = await input.start(signal);
      assertIssuedStartupRuntime(startup);
      if (startup.runtimeAuthority.authorityClass !== state.runtimeAuthority.authorityClass
        || startup.runtimeAuthority.authorityBindingHash !== state.runtimeAuthority.authorityBindingHash
        || startup.runtimeAuthority.implementationCommit !== state.runtimeAuthority.implementationCommit
        || startup.ready.releaseProvenanceHash !== state.releaseProvenanceHash) {
        throw new TypeError("runtime-release startup result identity mismatch");
      }
      current(service);
      return startup;
    },
  });
  issued.set(service, {
    authority: input.authority,
    version: authority.version,
    bindingId: release.bindingId,
    releaseProvenanceHash: release.releaseProvenanceHash,
    candidateReleaseCommit: release.candidateReleaseCommit,
    runtimeAuthority,
    ready: input.ready,
  });
  return service;
}

export function assertIssuedRuntimeReleaseSearcherStartupService(
  value: unknown,
): asserts value is RuntimeReleaseSearcherStartupServiceV1 {
  if (value === null || typeof value !== "object") throw new TypeError("runtime-release searcher startup service is not owner-issued");
  current(value as RuntimeReleaseSearcherStartupServiceV1);
}
