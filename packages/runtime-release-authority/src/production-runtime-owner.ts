import type {
  RuntimeReleaseBindingV1,
  RuntimeReleaseSignerPinV1,
} from "../../../specs/release-authority/src/index.ts";
import {
  assertExactKeys,
  readOwnEnumerableDataProperty,
} from "../../canonical-codec/src/index.ts";
import {
  buildRuntimeReleaseComposition,
  verifyRuntimeReleaseBindingAuthenticityV1,
  verifyAndIssueRuntimeReleaseAuthorityV1,
  type RuntimeReleaseCompositionInputV1,
  type RuntimeReleaseCompositionServicesV1,
} from "./index.ts";
import {
  issueDeploymentRuntimeInfrastructureV1,
  readDeploymentRuntimeInfrastructureV1,
  type DeploymentRuntimeInfrastructurePortsV1,
  type DeploymentRuntimeInfrastructureRequestV1,
} from "./internal/deployment-runtime-owner.ts";
import {
  issueRuntimeReleaseHttpFamilyPhysicalExecutionPortV1,
} from "./internal/http-family-physical-owner.ts";
import {
  issueRuntimeReleaseQualifiedDiscoverySourcePort,
  type RuntimeReleaseDiscoverySourceDeploymentInputV1,
} from "./internal/discovery-source-authority-owner.ts";
import {
  issueRuntimeReleaseEconomicSafetyEvaluatorCapabilityV1,
} from "./internal/economic-safety-owner.ts";
import {
  issueRuntimeReleaseRevmWorkerDeploymentPort,
} from "./internal/revm-worker-owner.ts";
import {
  issueInstalledRuntimeReleasePerformancePolicyPortV1,
  issuePreReleaseRuntimeReleasePerformancePolicyPortV1,
  type RuntimeReleasePerformancePolicyPortV1,
} from "./internal/performance-policy-owner.ts";
import {
  openInstalledRuntimeReleasePerformanceDeploymentPortV1,
} from "./internal/performance-deployment-owner.ts";
import {
  issueRuntimeReleaseTerminalObservationPortsV1,
  type RuntimeReleaseTerminalObservationInputV1,
} from "./internal/production-terminal-observation-owner.ts";

export type RuntimeReleaseInfrastructurePortV1 = object;

type RuntimeReleaseCompositionFacadeInputV1 = Omit<
  RuntimeReleaseCompositionInputV1<readonly unknown[]>,
  | "authority"
  | "attestation"
  | "candidatePartitionProofIssuer"
  | "scheduler"
  | "revm"
  | "performance"
  | "economicSafetyEvaluator"
  | "startup"
> & Readonly<{
  readonly infrastructure: RuntimeReleaseInfrastructurePortV1;
  readonly qualifiedDiscoverySource: RuntimeReleaseDiscoverySourceDeploymentInputV1;
  readonly performance:
    | Readonly<{ readonly phase: "installed-production" }>
    | Readonly<{ readonly phase: "pre-release"; readonly profileBytes: Uint8Array }>;
  readonly startup: Omit<RuntimeReleaseCompositionInputV1<readonly unknown[]>["startup"], "source">;
  readonly economicSafetyObjectiveTemplatesBytes: Uint8Array;
}>;

const RUNTIME_RELEASE_COMPOSITION_FACADE_KEYS = Object.freeze([
  "catalog", "checkpoint", "ready", "finalSimulation", "sixStep", "infrastructure",
  "qualifiedDiscoverySource", "performance", "startup", "economicSafetyObjectiveTemplatesBytes",
] as const);

function snapshotRuntimeReleaseCompositionFacadeInputV1(
  input: RuntimeReleaseCompositionFacadeInputV1,
): RuntimeReleaseCompositionFacadeInputV1 {
  assertExactKeys(input, RUNTIME_RELEASE_COMPOSITION_FACADE_KEYS, "runtimeReleaseCompositionFacade");
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of RUNTIME_RELEASE_COMPOSITION_FACADE_KEYS) {
    Object.defineProperty(snapshot, key, {
      enumerable: true,
      value: readOwnEnumerableDataProperty(input, key, "runtimeReleaseCompositionFacade"),
    });
  }
  return Object.freeze(snapshot) as RuntimeReleaseCompositionFacadeInputV1;
}

export interface VerifiedRuntimeReleaseOwnerPortV1 {
  bindInfrastructure(
    this: VerifiedRuntimeReleaseOwnerPortV1,
    input: Readonly<{
      readonly request: DeploymentRuntimeInfrastructureRequestV1;
      readonly endpoint: string;
      readonly timeoutMs: number;
    }>,
  ): RuntimeReleaseInfrastructurePortV1;
  compose(
    this: VerifiedRuntimeReleaseOwnerPortV1,
    input: RuntimeReleaseCompositionFacadeInputV1,
  ): RuntimeReleaseCompositionServicesV1<readonly unknown[]>;
  bindTerminalObservations(
    this: VerifiedRuntimeReleaseOwnerPortV1,
    input: RuntimeReleaseTerminalObservationInputV1,
  ): ReturnType<typeof issueRuntimeReleaseTerminalObservationPortsV1>;
}

/** Admission-only verification. No runtime authority or reusable capability
 * is minted until the phase owner actually opens the runtime owner port. */
export function verifyExternalRuntimeReleaseBindingV1(
  binding: RuntimeReleaseBindingV1,
  deploymentPin: RuntimeReleaseSignerPinV1,
): void {
  verifyRuntimeReleaseBindingAuthenticityV1(binding, deploymentPin);
}

/** Verify externally signed release material and expose only one receiver-
 * bound composition port. Raw authority, rotation/revocation, and individual
 * issuer constructors remain confined to this central release owner. */
export function openVerifiedRuntimeReleaseOwnerPortV1(
  binding: RuntimeReleaseBindingV1,
  deploymentPin: RuntimeReleaseSignerPinV1,
): VerifiedRuntimeReleaseOwnerPortV1 {
  const authority = verifyAndIssueRuntimeReleaseAuthorityV1(binding, deploymentPin);
  const infrastructures = new WeakMap<object, Readonly<{
    readonly external: DeploymentRuntimeInfrastructurePortsV1;
    readonly physicalExecution: ReturnType<typeof issueRuntimeReleaseHttpFamilyPhysicalExecutionPortV1>;
  }>>();
  const consumedInfrastructures = new WeakSet<object>();
  let port: VerifiedRuntimeReleaseOwnerPortV1;
  const assertReceiver = (receiver: VerifiedRuntimeReleaseOwnerPortV1): void => {
    if (receiver !== port) throw new TypeError("runtime release owner port receiver is invalid");
  };
  port = Object.freeze({
    bindInfrastructure(this: VerifiedRuntimeReleaseOwnerPortV1, input: {
      readonly request: DeploymentRuntimeInfrastructureRequestV1;
      readonly endpoint: string;
      readonly timeoutMs: number;
    }) {
      assertReceiver(this);
      const external = readDeploymentRuntimeInfrastructureV1(
        issueDeploymentRuntimeInfrastructureV1({ binding, request: input.request }),
        binding,
      );
      const physicalExecution = issueRuntimeReleaseHttpFamilyPhysicalExecutionPortV1({
        issuer: external.scheduler.issuer,
        capability: external.scheduler.capability,
        schedulerRuntime: external.scheduler.runtime,
        endpoint: input.endpoint,
        timeoutMs: input.timeoutMs,
      });
      const infrastructure = Object.freeze(Object.create(null)) as RuntimeReleaseInfrastructurePortV1;
      infrastructures.set(infrastructure, Object.freeze({ external, physicalExecution }));
      return infrastructure;
    },
    compose(this: VerifiedRuntimeReleaseOwnerPortV1, input: RuntimeReleaseCompositionFacadeInputV1) {
      assertReceiver(this);
      const snapshot = snapshotRuntimeReleaseCompositionFacadeInputV1(input);
      const infrastructurePort = snapshot.infrastructure;
      const infrastructure = infrastructures.get(infrastructurePort);
      if (infrastructure === undefined || consumedInfrastructures.has(infrastructurePort)) {
        throw new TypeError("runtime release infrastructure port is foreign, cloned, or consumed");
      }
      consumedInfrastructures.add(infrastructurePort);
      const qualifiedSource = issueRuntimeReleaseQualifiedDiscoverySourcePort(
        authority,
        snapshot.qualifiedDiscoverySource,
      );
      const performancePolicy: RuntimeReleasePerformancePolicyPortV1 = snapshot.performance.phase === "installed-production"
        ? issueInstalledRuntimeReleasePerformancePolicyPortV1({
            authority,
            deployment: openInstalledRuntimeReleasePerformanceDeploymentPortV1(authority),
          })
        : issuePreReleaseRuntimeReleasePerformancePolicyPortV1({
            authority,
            performanceProfileBytes: snapshot.performance.profileBytes,
            qualifiedSource,
          });
      const {
        infrastructure: _infrastructure,
        qualifiedDiscoverySource: _qualifiedDiscoverySource,
        performance: _performance,
        economicSafetyObjectiveTemplatesBytes,
        ...composition
      } = snapshot;
      void _infrastructure;
      void _qualifiedDiscoverySource;
      void _performance;
      return buildRuntimeReleaseComposition({
        ...composition,
        authority,
        attestation: {
          proofPort: infrastructure.external.attestationProof,
        },
        candidatePartitionProofIssuer: infrastructure.external.candidatePartitionProofIssuer,
        scheduler: Object.freeze({
          ...infrastructure.external.scheduler,
          physicalExecution: infrastructure.physicalExecution,
        }),
        revm: {
          deploymentPort: issueRuntimeReleaseRevmWorkerDeploymentPort(
            authority,
            infrastructure.external.revmDeployment,
          ),
        },
        performance: { policy: performancePolicy },
        startup: { ...composition.startup, source: qualifiedSource },
        economicSafetyEvaluator: issueRuntimeReleaseEconomicSafetyEvaluatorCapabilityV1(
          authority,
          economicSafetyObjectiveTemplatesBytes,
        ),
      });
    },
    bindTerminalObservations(this: VerifiedRuntimeReleaseOwnerPortV1, input: RuntimeReleaseTerminalObservationInputV1) {
      assertReceiver(this);
      return issueRuntimeReleaseTerminalObservationPortsV1(authority, input);
    },
  });
  return port;
}
