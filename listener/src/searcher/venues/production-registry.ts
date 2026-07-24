import { createHash } from "node:crypto";
import { AdapterFamilyRegistry } from "./adapter-family-registry.js";
import {
  PRODUCTION_IDENTITY_ADMISSION,
  type IdentityAdmissionPolicy,
} from "./admission.js";
import { fluidCreditAdapter } from "./credit/fluid.js";
import { balancerFlashFamily } from "./funding/balancer-flash.js";
import { morphoFlashFamily } from "./funding/morpho-flash.js";
import { erc4626Adapter } from "./protocols/erc4626.js";
import { erc4626SiloRedeemAdapter } from "./protocols/erc4626-silo-redeem.js";
import { goldxAdapter } from "./protocols/goldx.js";
import { metronomeHgusdcAdapter, metronomeSynthAdapter } from "./protocols/metronome.js";
import { psmAdapter } from "./protocols/psm.js";
import { eigenpieAdapter } from "./protocols/eigenpie.js";
import { rocksolidAdapter } from "./protocols/rocksolid.js";
import { wstethAdapter } from "./protocols/wsteth.js";
import { balancerV3Adapter } from "./swaps/balancer-v3.js";
import { curvePlainAdapter } from "./swaps/curve-plain.js";
import { curveUnderlyingAdapter } from "./swaps/curve-underlying.js";
import { univ2StandardAdapter } from "./swaps/univ2-standard.js";
import { univ3StandardAdapter } from "./swaps/univ3-standard.js";
import { univ4Adapter } from "./swaps/univ4.js";
import { dodoV2Adapter } from "./swaps/dodo-v2.js";
import { fluidDexAdapter } from "./swaps/fluid-dex.js";
import {
  assertIdentityResolverCoverage,
  IdentityResolverRegistry,
  type IdentityResolverDescriptor,
} from "./identity.js";
import {
  V2_LINEAGES,
  type V2LineageDescriptor,
} from "./v2-lineage.js";
export const PRODUCTION_ADAPTER_FAMILIES = new AdapterFamilyRegistry([
    univ2StandardAdapter,
    univ3StandardAdapter,
    curvePlainAdapter,
    curveUnderlyingAdapter,
    balancerV3Adapter,
    univ4Adapter,
    dodoV2Adapter,
    fluidDexAdapter,
    erc4626Adapter,
    erc4626SiloRedeemAdapter,
    goldxAdapter,
    metronomeSynthAdapter,
    metronomeHgusdcAdapter,
    psmAdapter,
    eigenpieAdapter,
    rocksolidAdapter,
    wstethAdapter,
    fluidCreditAdapter,
    balancerFlashFamily,
    morphoFlashFamily,
]);

const CODE_OWNED_IDENTITY_POLICIES: readonly IdentityResolverDescriptor[] =
  Object.freeze(
    PRODUCTION_ADAPTER_FAMILIES.routes().list().flatMap(
      (adapter) => [...adapter.identityPolicies],
    ),
  );

const dynamicProtocolIdentityResolvers = new Map(
  PRODUCTION_ADAPTER_FAMILIES.discoverableRoutes().flatMap((adapter) => {
    return adapter.poolAdapters.map((poolAdapter) => [
      poolAdapter,
      adapter.discoveryIdentityResolver,
    ] as const);
  }),
);

const codeOwnedPoolAdapters = new Set(
  CODE_OWNED_IDENTITY_POLICIES.map((descriptor) => descriptor.poolAdapter),
);

/**
 * A discovery-capable family brings its own identity resolver in the same
 * registration. Existing static families keep their code-owned seed policy;
 * the discovery registry below swaps only their dynamic admission path.
 */
const PRODUCTION_IDENTITY_POLICIES: readonly IdentityResolverDescriptor[] = [
  ...CODE_OWNED_IDENTITY_POLICIES,
  // Discovery-only families must remain untrusted in ordinary file/factory
  // intake. Their strong resolver is exposed only through the protocol
  // discovery registry after source evidence + active probe have run.
  ...[...dynamicProtocolIdentityResolvers]
    .filter(([poolAdapter]) => !codeOwnedPoolAdapters.has(poolAdapter))
    .map(([poolAdapter]) => ({
      poolAdapter,
      policy: "trusted-singleton-seed" as const,
    })),
];

/**
 * Identity admission stays independent from execution, while startup-time
 * conformance makes a newly registered route pool impossible to omit silently.
 */
export const PRODUCTION_IDENTITY_RESOLVERS = new IdentityResolverRegistry(
  PRODUCTION_IDENTITY_POLICIES,
  (poolAdapter) => PRODUCTION_ADAPTER_FAMILIES.routes().findForPool(poolAdapter) !== null,
);

const PROTOCOL_DISCOVERY_IDENTITY_POLICIES: readonly IdentityResolverDescriptor[] =
  PRODUCTION_IDENTITY_POLICIES.map((descriptor) => {
    const resolve = dynamicProtocolIdentityResolvers.get(descriptor.poolAdapter);
    return resolve
      ? {
          poolAdapter: descriptor.poolAdapter,
          policy: "onchain-resolver",
          resolve,
          registeredVenueIds: descriptor.registeredVenueIds,
          registeredIdentitySources: descriptor.registeredIdentitySources,
        }
      : descriptor;
  });

/**
 * Canonical production identity registry for adapter-owned protocol discovery.
 * It differs for every discovery-capable protocol family: candidate provenance
 * is constrained by that family's sources, and its mandatory behavior probe
 * follows identity before any edge is projected.
 */
export const PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS = new IdentityResolverRegistry(
  PROTOCOL_DISCOVERY_IDENTITY_POLICIES,
  (poolAdapter) => PRODUCTION_ADAPTER_FAMILIES.routes().findForPool(poolAdapter) !== null,
);

assertIdentityResolverCoverage(
  PRODUCTION_ADAPTER_FAMILIES.routes().list(),
  PRODUCTION_IDENTITY_RESOLVERS,
);
assertIdentityResolverCoverage(
  PRODUCTION_ADAPTER_FAMILIES.routes().list(),
  PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
);

const POOL_UNIVERSE_DISCOVERY_CONTRACT_VERSION = 1;

/**
 * Exact production semantics which can change the set admitted from historical
 * landed/factory evidence. The universe artifact persists this set and live
 * startup refuses to inherit its cursor when any item differs.
 */
export function productionPoolUniverseSourceFingerprints():
  readonly string[] {
  return poolUniverseSourceFingerprints({
    landedSourceFingerprints: PRODUCTION_ADAPTER_FAMILIES
      .landedPoolDiscovery()
      .list()
      .map((descriptor) => descriptor.sourceFingerprint),
    identityPolicies: PRODUCTION_IDENTITY_RESOLVERS.list(),
    admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    v2Lineages: V2_LINEAGES,
  });
}

export function poolUniverseSourceFingerprints(input: {
  readonly landedSourceFingerprints: readonly string[];
  readonly identityPolicies: readonly IdentityResolverDescriptor[];
  readonly admissionPolicy: IdentityAdmissionPolicy;
  readonly v2Lineages: readonly V2LineageDescriptor[];
}): readonly string[] {
  const fingerprints = [
    ...input.landedSourceFingerprints,
    `pool-universe-discovery-contract:v${POOL_UNIVERSE_DISCOVERY_CONTRACT_VERSION}`,
    `identity-admission:${fingerprintJson({
      unknownFactory: input.admissionPolicy.unknownFactory,
      unregisteredCurveUnderlying:
        input.admissionPolicy.unregisteredCurveUnderlying,
    })}`,
    `identity-policies:${fingerprintJson(
      [...input.identityPolicies]
        .sort((a, b) => a.poolAdapter.localeCompare(b.poolAdapter))
        .map(identityPolicyFingerprintInput),
    )}`,
    `v2-lineages:${fingerprintJson(
      [...input.v2Lineages]
        .map((lineage) => ({
          venue: lineage.venue,
          factory: lineage.factory.toLowerCase(),
          executionFamily: lineage.executionFamily,
          runtimeAdapter: lineage.runtimeAdapter,
          discoverable: lineage.discoverable,
          quotable: lineage.quotable,
          buildable: lineage.buildable,
          measuredFeeRule: lineage.measuredFeeRule === null
            ? null
            : {
                kind: lineage.measuredFeeRule.kind,
                feeBps: lineage.measuredFeeRule.feeBps.toString(),
                evidence: lineage.measuredFeeRule.evidence,
              },
        }))
        .sort((a, b) => a.factory.localeCompare(b.factory)),
    )}`,
  ];
  return Object.freeze([...new Set(fingerprints)].sort());
}

function identityPolicyFingerprintInput(
  descriptor: IdentityResolverDescriptor,
): Record<string, unknown> {
  return {
    poolAdapter: descriptor.poolAdapter,
    policy: descriptor.policy,
    canonicalAddress: descriptor.policy === "trusted-singleton-seed"
      ? descriptor.canonicalAddress?.toLowerCase() ?? null
      : null,
    canonicalVenueId: descriptor.policy === "trusted-singleton-seed"
      ? descriptor.canonicalVenueId ?? null
      : null,
    canonicalIdentitySource: descriptor.policy === "trusted-singleton-seed"
      ? descriptor.canonicalIdentitySource ?? null
      : null,
    registeredVenueIds: [...(descriptor.registeredVenueIds ?? [])].sort(),
    registeredIdentitySources:
      [...(descriptor.registeredIdentitySources ?? [])].sort(),
    legacyReason: descriptor.legacyReason ?? null,
    // This binds direct resolver edits. The explicit discovery-contract
    // version above remains the required bump for shared helper semantics.
    resolverSourceSha256: descriptor.policy === "onchain-resolver"
      ? createHash("sha256")
          .update(Function.prototype.toString.call(descriptor.resolve))
          .digest("hex")
      : null,
  };
}

function fingerprintJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}
