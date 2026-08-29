import {
  assertGeneratedStrategyRuntimeComposition,
  createGeneratedStrategyRuntimeComposition,
  sealGeneratedStrategyRuntimeDescriptor,
  type GeneratedStrategyRuntimeDescriptorV1,
  type StrategyRuntimeCompositionV1,
} from "../index.ts";
import type { StrategyPlanningProblemIssuerV1 } from "../../../strategy-sdk/src/index.ts";
import { assertHash, hashDomain, type Hash } from "../../../canonical-codec/src/index.ts";
import { issueGeneratedStrategyRuntimeCompositionCapability } from "./runtime-composition-authority.ts";

declare const generatedStrategyRuntimeAuthorityCapabilityBrand: unique symbol;

/** A release-owned capability; callers cannot construct an equivalent value. */
export interface GeneratedStrategyRuntimeAuthorityCapabilityV1 {
  readonly [generatedStrategyRuntimeAuthorityCapabilityBrand]: never;
}

export interface GeneratedStrategyRuntimeAssemblyV1 {
  readonly descriptor: GeneratedStrategyRuntimeDescriptorV1;
  /** Exact named issuer imports closed over by generated output. */
  readonly issuers: readonly StrategyPlanningProblemIssuerV1[];
}

export type GeneratedStrategyRuntimeFactoryV1 = (
  capability: GeneratedStrategyRuntimeAuthorityCapabilityV1,
) => StrategyRuntimeCompositionV1;

export interface GeneratedStrategyRuntimeFactoryMetadataV1 {
  readonly releaseIntentRoot: Hash;
  readonly definitionCatalogRoot: Hash;
  readonly strategyCatalogRoot: Hash;
  readonly proposedCapabilitySetRoot: Hash;
  readonly descriptorRoot: Hash;
  readonly strategies: readonly Readonly<{
    readonly strategyId: string;
    readonly strategyDefinitionHash: Hash;
    readonly issuerModulePath: string;
    readonly issuerExportName: string;
    readonly issuerClosureRoot: Hash;
    readonly planningTemplateHash: Hash;
    readonly leafDigest: Hash;
  }>[];
}

interface IssuedAuthorityStateV1 {
  readonly factory: GeneratedStrategyRuntimeFactoryV1;
  readonly releaseProvenanceHash: Hash;
  readonly assertCurrent: () => void;
}

const issuedAuthorities = new WeakMap<object, IssuedAuthorityStateV1>();
const generatedFactories = new WeakSet<object>();
const generatedFactoryMetadata = new WeakMap<object, GeneratedStrategyRuntimeFactoryMetadataV1>();

export function assertGeneratedStrategyRuntimeFactory(
  value: unknown,
): asserts value is GeneratedStrategyRuntimeFactoryV1 {
  if (typeof value !== "function" || !generatedFactories.has(value)) {
    throw new TypeError("Strategy runtime factory is not generated and release-authenticated");
  }
}

export function readGeneratedStrategyRuntimeFactoryMetadata(
  value: unknown,
): GeneratedStrategyRuntimeFactoryMetadataV1 {
  assertGeneratedStrategyRuntimeFactory(value);
  const metadata = generatedFactoryMetadata.get(value);
  if (metadata === undefined) throw new TypeError("generated Strategy runtime factory metadata is unavailable");
  return metadata;
}

function authorityFor(
  factory: GeneratedStrategyRuntimeFactoryV1,
  capability: GeneratedStrategyRuntimeAuthorityCapabilityV1,
): IssuedAuthorityStateV1 {
  if (capability === null || typeof capability !== "object") {
    throw new TypeError("Strategy runtime production authority is unavailable");
  }
  const state = issuedAuthorities.get(capability);
  if (state === undefined) throw new TypeError("Strategy runtime production authority is unavailable");
  if (state.factory !== factory) throw new TypeError("Strategy runtime production authority is bound to another generated factory");
  state.assertCurrent();
  return state;
}

/** Owner-only hand-off from runtime-release-authority. */
export function issueGeneratedStrategyRuntimeAuthorityCapability(input: {
  readonly factory: GeneratedStrategyRuntimeFactoryV1;
  readonly qualifiedCapabilityRefsRoot: Hash;
  /** Signed runtime-release provenance that owns this generated factory. */
  readonly releaseProvenanceHash: Hash;
  readonly assertCurrent: () => void;
}): GeneratedStrategyRuntimeAuthorityCapabilityV1 {
  if (input === null || typeof input !== "object" || typeof input.assertCurrent !== "function") {
    throw new TypeError("Strategy runtime production authority is unavailable");
  }
  assertGeneratedStrategyRuntimeFactory(input.factory);
  const metadata = generatedFactoryMetadata.get(input.factory);
  if (metadata === undefined) throw new TypeError("generated Strategy runtime factory metadata is unavailable");
  assertHash(input.qualifiedCapabilityRefsRoot, "qualifiedCapabilityRefsRoot");
  assertHash(input.releaseProvenanceHash, "releaseProvenanceHash");
  if (metadata.proposedCapabilitySetRoot !== input.qualifiedCapabilityRefsRoot) {
    throw new TypeError("Strategy runtime factory is not bound to this release capability set");
  }
  input.assertCurrent();
  const capability = Object.freeze(Object.create(null)) as GeneratedStrategyRuntimeAuthorityCapabilityV1;
  issuedAuthorities.set(capability, Object.freeze({
    factory: input.factory,
    releaseProvenanceHash: input.releaseProvenanceHash,
    assertCurrent: input.assertCurrent,
  }));
  return capability;
}

/**
 * Called only by generated runtime output. The descriptor and exact issuer
 * imports are closed over here; application consumers receive only the
 * generated factory and an opaque release capability.
 */
export function createGeneratedStrategyRuntimeFactory(
  assembly: GeneratedStrategyRuntimeAssemblyV1,
): GeneratedStrategyRuntimeFactoryV1 {
  if (assembly === null || typeof assembly !== "object") throw new TypeError("generated Strategy runtime assembly is required");
  const descriptor = sealGeneratedStrategyRuntimeDescriptor({
    schemaVersion: assembly.descriptor.schemaVersion,
    releaseIntentRoot: assembly.descriptor.releaseIntentRoot,
    definitionCatalogRoot: assembly.descriptor.definitionCatalogRoot,
    proposedCapabilitySetRoot: assembly.descriptor.proposedCapabilitySetRoot,
    strategies: assembly.descriptor.strategies,
  });
  if (descriptor.descriptorRoot !== assembly.descriptor.descriptorRoot) {
    throw new TypeError("generated Strategy runtime descriptor root mismatch");
  }
  if (!Array.isArray(assembly.issuers) || assembly.issuers.length !== descriptor.strategies.length) {
    throw new TypeError("generated Strategy issuer set is incomplete");
  }
  const issuers = descriptor.strategies.map((entry, index) => {
    const issuer = assembly.issuers[index];
    if (
      issuer === null
      || typeof issuer !== "object"
      || typeof issuer.issue !== "function"
      || issuer.strategyId !== entry.catalogEntry.strategyId
      || issuer.version !== entry.catalogEntry.strategyVersion
      || issuer.planningTemplateHash !== entry.planningTemplateHash
    ) throw new TypeError("generated Strategy issuer identity mismatch");
    return Object.freeze({
      strategyId: issuer.strategyId,
      version: issuer.version,
      planningTemplateHash: issuer.planningTemplateHash,
      issue: issuer.issue,
    });
  });
  const compositions = new WeakMap<object, StrategyRuntimeCompositionV1>();
  const factory: GeneratedStrategyRuntimeFactoryV1 = capability => {
    const authority = authorityFor(factory, capability);
    const existing = compositions.get(capability as object);
    if (existing !== undefined) return existing;
    const compositionCapability = issueGeneratedStrategyRuntimeCompositionCapability({
      descriptor,
      issuers,
      releaseProvenanceHash: authority.releaseProvenanceHash,
      assertCurrent: authority.assertCurrent,
    });
    const composition = createGeneratedStrategyRuntimeComposition(compositionCapability);
    assertGeneratedStrategyRuntimeComposition(composition);
    compositions.set(capability as object, composition);
    return composition;
  };
  generatedFactories.add(factory);
  generatedFactoryMetadata.set(factory, Object.freeze({
    releaseIntentRoot: descriptor.releaseIntentRoot,
    definitionCatalogRoot: descriptor.definitionCatalogRoot,
    strategyCatalogRoot: hashDomain(
      "aloha/strategy-definition-catalog/v1",
      descriptor.strategies.map(entry => entry.catalogEntry.definitionCatalogLeafDigest).sort(),
    ),
    proposedCapabilitySetRoot: descriptor.proposedCapabilitySetRoot,
    descriptorRoot: descriptor.descriptorRoot,
    strategies: Object.freeze(descriptor.strategies.map(entry => Object.freeze({
      strategyId: entry.catalogEntry.strategyId,
      strategyDefinitionHash: entry.catalogEntry.strategyDefinitionHash,
      issuerModulePath: entry.issuerModulePath,
      issuerExportName: entry.issuerExportName,
      issuerClosureRoot: entry.issuerClosureRoot,
      planningTemplateHash: entry.planningTemplateHash,
      leafDigest: entry.leafDigest,
    }))),
  }));
  return factory;
}
