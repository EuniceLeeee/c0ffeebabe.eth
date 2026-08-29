import {
  installQualifiedReleaseAcceptanceRunnerV1,
  observeQualifiedReleaseAcceptanceAdvisoryV1,
  prepareQualifiedReleaseAcceptanceV1,
  type InstallQualifiedReleaseAcceptanceRunnerInputV1,
  type QualifiedReleaseAcceptanceAdvisoryRunV1,
  type QualifiedReleaseAcceptancePreparedRunV1,
  type QualifiedReleaseAcceptanceRunnerCapabilityV1,
} from "./qualified-release-runner-owner.ts";
import type { PredicateMaterialSourcePortV1 } from "../../../../acceptance/gate-core/src/index.ts";
import {
  assertExactKeys,
  assertPlainObject,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  issueBridgedPredicateMaterialSourcePortV1,
  type BridgedPredicateMaterialReaderNameV1,
} from "../../../../acceptance/collectors/src/internal/predicate-material-source-bridge-issuer.ts";
import type {
  FreshQualifiedRunnerHostCapabilityV1,
  FreshQualifiedRunnerHostPortV1,
  FreshQualifiedRunnerHostRequestV1,
  FreshQualifiedRunnerSourceSessionCapabilityV1,
  FreshQualifiedRunnerSourceSessionV1,
} from "./fresh-qualified-runner-host-owner.ts";

export type FreshQualifiedRunnerHostInvokeV1 = (
  host: FreshQualifiedRunnerHostCapabilityV1,
  request: FreshQualifiedRunnerHostRequestV1,
) => FreshQualifiedRunnerHostPortV1;

export interface FreshQualifiedReleaseRunnerRuntimeV1 {
  readonly install: (
    input: InstallQualifiedReleaseAcceptanceRunnerInputV1,
  ) => QualifiedReleaseAcceptanceRunnerCapabilityV1;
  readonly observeAdvisory: (
    capability: QualifiedReleaseAcceptanceRunnerCapabilityV1,
    source: PredicateMaterialSourcePortV1,
  ) => Promise<QualifiedReleaseAcceptanceAdvisoryRunV1>;
  readonly prepareRelease: (
    capability: QualifiedReleaseAcceptanceRunnerCapabilityV1,
    source: PredicateMaterialSourcePortV1,
  ) => Promise<QualifiedReleaseAcceptancePreparedRunV1>;
}

/** Exact-commit advisory bundle entry. It contains no result-to-authority bridge. */
export function createFreshQualifiedReleaseRunnerRuntimeV1(
  host: FreshQualifiedRunnerHostCapabilityV1,
  invokeHost: FreshQualifiedRunnerHostInvokeV1,
): FreshQualifiedReleaseRunnerRuntimeV1 {
  if (host === null || typeof host !== "object" || typeof invokeHost !== "function") {
    throw new TypeError("fresh qualified release runner host bridge is unavailable");
  }
  const port = invokeHost(host, Object.freeze({ kind: "open-host" }));
  if (typeof port !== "function"
    || port(Object.freeze({ kind: "assert-port", self: port })) !== port) {
    throw new TypeError("fresh qualified release runner host port is invalid");
  }
  const bridgeSource = (source: PredicateMaterialSourcePortV1): PredicateMaterialSourcePortV1 => {
    const opened = port(Object.freeze({
      kind: "open-source",
      self: port,
      source,
    }));
    if (opened === null || typeof opened !== "object" || opened instanceof Promise) {
      throw new TypeError("fresh qualified release runner source session is invalid");
    }
    assertPlainObject(opened, "freshQualifiedRunnerSourceSession");
    assertExactKeys(opened, ["capability", "readers", "resolverPolicy"], "freshQualifiedRunnerSourceSession");
    const session = opened as unknown as FreshQualifiedRunnerSourceSessionV1;
    if (session.capability === null || typeof session.capability !== "object") {
      throw new TypeError("fresh qualified release runner source session capability is invalid");
    }
    const sessionCapability = session.capability as FreshQualifiedRunnerSourceSessionCapabilityV1;
    return issueBridgedPredicateMaterialSourcePortV1(Object.freeze({
      resolverPolicy: session.resolverPolicy,
      readers: session.readers,
      read: (reader: BridgedPredicateMaterialReaderNameV1) => port(Object.freeze({
        kind: "read-source",
        self: port,
        session: sessionCapability,
        reader,
      })),
      write: async input => await port(Object.freeze({
        kind: "write-artifact",
        self: port,
        session: sessionCapability,
        input,
      })) as never,
    }));
  };
  return Object.freeze({
    install: (input: InstallQualifiedReleaseAcceptanceRunnerInputV1) =>
      installQualifiedReleaseAcceptanceRunnerV1(input),
    async observeAdvisory(
      capability: QualifiedReleaseAcceptanceRunnerCapabilityV1,
      source: PredicateMaterialSourcePortV1,
    ): Promise<QualifiedReleaseAcceptanceAdvisoryRunV1> {
      return observeQualifiedReleaseAcceptanceAdvisoryV1(capability, bridgeSource(source));
    },
    async prepareRelease(
      capability: QualifiedReleaseAcceptanceRunnerCapabilityV1,
      source: PredicateMaterialSourcePortV1,
    ): Promise<QualifiedReleaseAcceptancePreparedRunV1> {
      return prepareQualifiedReleaseAcceptanceV1(capability, bridgeSource(source));
    },
  });
}
