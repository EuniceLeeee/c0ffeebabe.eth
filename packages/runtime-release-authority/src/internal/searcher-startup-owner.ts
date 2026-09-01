import {
  assertIssuedStartupRuntime,
  type StartupReadyPortV1,
  type StartupRuntimeV1,
} from "../../../../packages/startup-runtime/src/index.ts";
import { assertIssuedStartupReadyPort } from "../../../../packages/startup-runtime/src/internal/ready-owner.ts";
import type { RuntimeAuthorityV1 } from "../index.ts";
import { assertActiveRuntimeAuthorityState } from "./state.ts";
import {
  projectRuntimeAuthorityDescriptorV1,
  type RuntimeAuthorityProjectionV1,
} from "../../../runtime-authority/src/index.ts";

export interface RuntimeReleaseSearcherStartupServiceV1 {
  readonly startStartup: (signal?: AbortSignal) => Promise<StartupRuntimeV1>;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
}

interface StartupServiceStateV1 {
  readonly authority: RuntimeAuthorityV1;
  readonly version: bigint;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly ready: StartupReadyPortV1;
}

const issued = new WeakMap<object, StartupServiceStateV1>();

function current(value: RuntimeReleaseSearcherStartupServiceV1): StartupServiceStateV1 {
  const state = issued.get(value);
  if (state === undefined) throw new TypeError("runtime-release searcher startup service is not owner-issued");
  const authority = assertActiveRuntimeAuthorityState(state.authority);
  const runtimeAuthority = projectRuntimeAuthorityDescriptorV1(authority.descriptor);
  if (authority.version !== state.version
    || runtimeAuthority.authorityBindingHash !== state.runtimeAuthority.authorityBindingHash
    || runtimeAuthority.implementationCommit !== state.runtimeAuthority.implementationCommit) {
    throw new TypeError("runtime searcher startup service is stale");
  }
  assertIssuedStartupReadyPort(state.ready);
  return state;
}

/** Issued only by the release bootstrap after the real Ready owner is bound. */
export function issueRuntimeReleaseSearcherStartupService(input: {
  readonly authority: RuntimeAuthorityV1;
  readonly ready: StartupReadyPortV1;
  readonly start: (signal?: AbortSignal) => Promise<StartupRuntimeV1>;
}): RuntimeReleaseSearcherStartupServiceV1 {
  const authority = assertActiveRuntimeAuthorityState(input.authority);
  assertIssuedStartupReadyPort(input.ready);
  if (typeof input.start !== "function") throw new TypeError("runtime startup operation is required");
  const runtimeAuthority = projectRuntimeAuthorityDescriptorV1(authority.descriptor);
  let service: RuntimeReleaseSearcherStartupServiceV1;
  service = Object.freeze({
    runtimeAuthority,
    async startStartup(signal?: AbortSignal): Promise<StartupRuntimeV1> {
      const state = current(service);
      const startup = await input.start(signal);
      assertIssuedStartupRuntime(startup);
      if (startup.runtimeAuthority.authorityBindingHash !== state.runtimeAuthority.authorityBindingHash
        || startup.runtimeAuthority.implementationCommit !== state.runtimeAuthority.implementationCommit) {
        throw new TypeError("runtime startup result identity mismatch");
      }
      current(service);
      return startup;
    },
  });
  issued.set(service, {
    authority: input.authority,
    version: authority.version,
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
