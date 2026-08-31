import {
  decimalStringSchema,
  enumSchema,
  gitSha40Schema,
  hashSchema,
  nonEmptyStringSchema,
  objectSchema,
  type Hash,
} from "../../../canonical-codec/src/index.ts";

export type NativeStartupAuthorityClassV1 = "signed-release" | "advisory-observation";

export interface NativeStartupAuthorityProjectionV1 {
  readonly authorityClass: NativeStartupAuthorityClassV1;
  readonly runtimeInstanceId: Hash;
  readonly runtimeLineageRoot: Hash;
  readonly implementationCommit: string;
}

export interface NativeStartupGenerationIdentityV1 {
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly recordRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly definitionCatalogRoot: Hash;
  readonly cutoff: Readonly<{ readonly number: string }>;
  readonly observationRange: Readonly<{ readonly from: string; readonly to: string }>;
  readonly authority: NativeStartupAuthorityProjectionV1;
}

const authoritySchema = objectSchema({
  authorityClass: enumSchema(["signed-release", "advisory-observation"] as const),
  runtimeInstanceId: hashSchema,
  runtimeLineageRoot: hashSchema,
  implementationCommit: gitSha40Schema,
});

const identitySchema = objectSchema({
  generationId: nonEmptyStringSchema,
  graphRoot: hashSchema,
  recordRoot: hashSchema,
  sourceCoverageRoot: hashSchema,
  definitionCatalogRoot: hashSchema,
  cutoff: objectSchema({ number: decimalStringSchema }),
  observationRange: objectSchema({
    from: decimalStringSchema,
    to: decimalStringSchema,
  }),
  authority: authoritySchema,
});

/** Exact-decode and freeze the only identity shape admitted by the core. */
export function decodeNativeStartupGenerationIdentityV1(
  value: unknown,
): NativeStartupGenerationIdentityV1 {
  const decoded = identitySchema.decode(value, "nativeStartup.generationIdentity");
  return Object.freeze({
    ...decoded,
    cutoff: Object.freeze({ ...decoded.cutoff }),
    observationRange: Object.freeze({ ...decoded.observationRange }),
    authority: Object.freeze({ ...decoded.authority }),
  });
}

/** Opaque owner-issued handles. Adapter records stay outside this contract. */
export type NativeStartupGenerationHandleV1 = object;
export type NativeStartupPromotionRequestV1 = object;

export interface NativeStartupLoadedGenerationV1 {
  readonly handle: NativeStartupGenerationHandleV1;
  readonly identity: NativeStartupGenerationIdentityV1;
}

export interface NativeStartupGenerationBuilderV1 {
  loadOrBuildInitial(signal: AbortSignal): Promise<NativeStartupGenerationHandleV1>;
  buildNext(signal: AbortSignal): Promise<void>;
}

export interface NativeStartupPromotionBoundaryV1 {
  promote(request: NativeStartupPromotionRequestV1): Promise<NativeStartupGenerationHandleV1>;
}

/**
 * Internal adapter contract for the one native state machine. This interface
 * is not a runtime authority: only exact adapter wrappers may call the core,
 * and that import edge is enforced by the package boundary/closure policy.
 */
export interface NativeStartupOwnerPortV1<
  Observation extends object,
  Lease extends object,
  Session extends object,
> {
  readonly targetRefreshAgeBlocks: string;
  createGenerationBuilder(boundary: NativeStartupPromotionBoundaryV1): NativeStartupGenerationBuilderV1;
  promote(request: NativeStartupPromotionRequestV1): Promise<NativeStartupGenerationHandleV1>;
  findLatestReusable(): Promise<NativeStartupGenerationHandleV1 | null>;
  generationRecordRoot(handle: NativeStartupGenerationHandleV1): Hash;
  loadGeneration(handle: NativeStartupGenerationHandleV1): Promise<NativeStartupLoadedGenerationV1>;
  openProducerLease(handle: NativeStartupGenerationHandleV1): Promise<Lease>;
  releaseProducerLease(lease: Lease): void;
  openProducerSession(
    observation: Observation,
    lease: Lease,
    signal?: AbortSignal,
  ): Promise<Session>;
  closeProducerSession(session: Session): Promise<void>;
  producerSessionHeadNumber(session: Session): string;
}
