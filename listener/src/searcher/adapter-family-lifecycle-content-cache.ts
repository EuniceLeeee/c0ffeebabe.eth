import type { FamilyId } from "./venues/adapter-family-identifiers.js";
import {
  declareStaticEvidenceProgram,
  isIssuedExecutedProgram,
  isIssuedStaticEvidenceReuseProof,
  replayStaticEvidenceProgram,
  type CanonicalSource,
  type ExecutedProgram,
  type ResolvedStaticEvidenceReusePolicy,
  type StaticEvidenceProgram,
  type StaticEvidenceReuseProof,
} from "./venues/adapter-request-program.js";
import { hashCanonical, type CanonicalValue } from "./venues/canonical-value.js";

export type AdapterStaticEvidenceStage =
  | "instance-static"
  | "pricing-static";

export interface StaticEvidenceCrossSourceReuseInput {
  readonly familyId: FamilyId;
  readonly stage: AdapterStaticEvidenceStage;
  readonly subjectKey: string;
  readonly capabilityHash: string;
  readonly requestFingerprint: string;
  readonly reusePolicy: ResolvedStaticEvidenceReusePolicy;
  readonly previousProof: StaticEvidenceReuseProof;
  readonly source: CanonicalSource;
}

const reuseAuthorityBrand: unique symbol = Symbol(
  "adapter-static-evidence-reuse-authority",
);
const issuedReuseAuthorities = new WeakSet<object>();

export interface AdapterStaticEvidenceReuseAuthority {
  readonly [reuseAuthorityBrand]: true;
  proveReusable(input: StaticEvidenceCrossSourceReuseInput):
    boolean | Promise<boolean>;
}

export function createAdapterStaticEvidenceReuseAuthority(
  proveReusable: AdapterStaticEvidenceReuseAuthority["proveReusable"],
): AdapterStaticEvidenceReuseAuthority {
  if (typeof proveReusable !== "function") {
    throw new Error("static evidence reuse authority requires a proof handler");
  }
  const authority: AdapterStaticEvidenceReuseAuthority = Object.freeze({
    [reuseAuthorityBrand]: true as const,
    proveReusable: proveReusable.bind(undefined),
  });
  issuedReuseAuthorities.add(authority);
  return authority;
}

export interface AdapterFamilyLifecycleContentCacheSnapshot {
  readonly size: number;
  readonly capacity: number;
  readonly hits: number;
  readonly misses: number;
  readonly stores: number;
  readonly evictions: number;
  readonly rejectedReuse: number;
  readonly corruptEntries: number;
}

export interface AdapterStaticEvidenceCacheInput<Input, Evidence> {
  readonly familyId: FamilyId;
  readonly stage: AdapterStaticEvidenceStage;
  readonly subjectKey: string;
  readonly capabilityHash: string;
  readonly source: CanonicalSource;
  readonly program: StaticEvidenceProgram<Input, Evidence>;
  readonly programInput: Input;
}

export interface AdapterStaticEvidenceCacheHit<Evidence> {
  readonly cacheKey: string;
  readonly executed: ExecutedProgram<Evidence>;
}

const lifecycleContentCacheBrand: unique symbol = Symbol(
  "adapter-family-lifecycle-content-cache",
);
const issuedLifecycleContentCaches = new WeakSet<object>();

export interface AdapterFamilyLifecycleContentCache {
  readonly [lifecycleContentCacheBrand]: true;
  lookup<Input, Evidence>(
    input: AdapterStaticEvidenceCacheInput<Input, Evidence>,
  ): Promise<AdapterStaticEvidenceCacheHit<Evidence> | undefined>;
  store<Input, Evidence>(input: AdapterStaticEvidenceCacheInput<Input, Evidence> & {
    readonly executed: ExecutedProgram<Evidence>;
  }): boolean;
  snapshot(): AdapterFamilyLifecycleContentCacheSnapshot;
}

interface CacheEntry {
  readonly executed: ExecutedProgram<unknown>;
  readonly reusePolicy: ResolvedStaticEvidenceReusePolicy;
  readonly proof: StaticEvidenceReuseProof;
}

const DEFAULT_CAPACITY = 4_096;

export function createAdapterFamilyLifecycleContentCache(options: {
  readonly capacity?: number;
  readonly reuseAuthority?: AdapterStaticEvidenceReuseAuthority;
} = {}): AdapterFamilyLifecycleContentCache {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new Error("Adapter lifecycle content cache capacity must be positive");
  }
  if (
    options.reuseAuthority !== undefined &&
    !issuedReuseAuthorities.has(options.reuseAuthority)
  ) {
    throw new Error("static evidence reuse authority must be centrally issued");
  }

  const entries = new Map<string, CacheEntry>();
  let hits = 0;
  let misses = 0;
  let stores = 0;
  let evictions = 0;
  let rejectedReuse = 0;
  let corruptEntries = 0;

  const cache: AdapterFamilyLifecycleContentCache = Object.freeze({
    [lifecycleContentCacheBrand]: true as const,
    async lookup<Input, Evidence>(
      input: AdapterStaticEvidenceCacheInput<Input, Evidence>,
    ): Promise<AdapterStaticEvidenceCacheHit<Evidence> | undefined> {
      const address = describeAddress(input);
      const entry = entries.get(address.cacheKey);
      if (entry === undefined) {
        misses++;
        return undefined;
      }
      if (!validEntry(entry, address)) {
        entries.delete(address.cacheKey);
        misses++;
        corruptEntries++;
        return undefined;
      }
      if (!samePhysicalSource(entry.proof.source, input.source)) {
        const authority = options.reuseAuthority;
        if (
          entry.reusePolicy.kind === "source-local" ||
          authority === undefined
        ) {
          misses++;
          rejectedReuse++;
          return undefined;
        }
        let reusable = false;
        try {
          reusable = await authority.proveReusable(Object.freeze({
            familyId: input.familyId,
            stage: input.stage,
            subjectKey: input.subjectKey,
            capabilityHash: input.capabilityHash.toLowerCase(),
            requestFingerprint: address.requestFingerprint,
            reusePolicy: entry.reusePolicy,
            previousProof: entry.proof,
            source: Object.freeze({ ...input.source }),
          }));
        } catch {
          reusable = false;
        }
        if (reusable !== true) {
          misses++;
          rejectedReuse++;
          return undefined;
        }
      }

      let executed: ExecutedProgram<Evidence>;
      try {
        executed = replayStaticEvidenceProgram({
          program: input.program,
          programInput: input.programInput,
          source: input.source,
          cached: entry.executed,
        });
      } catch {
        entries.delete(address.cacheKey);
        misses++;
        corruptEntries++;
        return undefined;
      }
      entries.delete(address.cacheKey);
      entries.set(address.cacheKey, entry);
      hits++;
      return Object.freeze({ cacheKey: address.cacheKey, executed });
    },
    store<Input, Evidence>(
      input: AdapterStaticEvidenceCacheInput<Input, Evidence> & {
        readonly executed: ExecutedProgram<Evidence>;
      },
    ): boolean {
      const address = describeAddress(input);
      const executed = input.executed;
      const proof = executed.reuseProof;
      if (
        !isIssuedExecutedProgram(executed) ||
        !isIssuedStaticEvidenceReuseProof(proof) ||
        proof.policyKind !== address.reusePolicy.kind ||
        proof.requestFingerprint !== address.requestFingerprint ||
        proof.trustedResultsFingerprint !== executed.trustedResultsFingerprint ||
        !sameSource(proof.source, input.source) ||
        executed.trustedResults.some((result) =>
          !result.ok || !sameSource(result.source, input.source)
        )
      ) {
        return false;
      }
      const entry: CacheEntry = Object.freeze({
        executed: executed as ExecutedProgram<unknown>,
        reusePolicy: address.reusePolicy,
        proof,
      });
      if (entries.has(address.cacheKey)) entries.delete(address.cacheKey);
      while (entries.size >= capacity) {
        const oldest = entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        entries.delete(oldest);
        evictions++;
      }
      entries.set(address.cacheKey, entry);
      stores++;
      return true;
    },
    snapshot(): AdapterFamilyLifecycleContentCacheSnapshot {
      return Object.freeze({
        size: entries.size,
        capacity,
        hits,
        misses,
        stores,
        evictions,
        rejectedReuse,
        corruptEntries,
      });
    },
  });
  issuedLifecycleContentCaches.add(cache);
  return cache;
}

export function assertIssuedAdapterFamilyLifecycleContentCache(
  value: unknown,
): asserts value is AdapterFamilyLifecycleContentCache {
  if (
    value === null || typeof value !== "object" ||
    (value as Partial<AdapterFamilyLifecycleContentCache>)[
      lifecycleContentCacheBrand
    ] !== true ||
    !issuedLifecycleContentCaches.has(value)
  ) {
    throw new Error("Adapter lifecycle content cache must be centrally issued");
  }
}

function describeAddress<Input, Evidence>(
  input: AdapterStaticEvidenceCacheInput<Input, Evidence>,
): Readonly<{
  readonly cacheKey: string;
  readonly requestFingerprint: string;
  readonly reusePolicy: ResolvedStaticEvidenceReusePolicy;
}> {
  assertAddressInput(input);
  const declared = declareStaticEvidenceProgram({
    program: input.program,
    programInput: input.programInput,
  });
  const policy = reusePolicyValue(declared.reusePolicy);
  return Object.freeze({
    cacheKey: `adapter-static-evidence:${hashCanonical({
      namespace: "adapter-family-static-evidence-v1",
      familyId: input.familyId,
      stage: input.stage,
      subjectKey: input.subjectKey,
      capabilityHash: input.capabilityHash.toLowerCase(),
      requestFingerprint: declared.requestFingerprint,
      reusePolicy: policy,
    })}`,
    requestFingerprint: declared.requestFingerprint,
    reusePolicy: declared.reusePolicy,
  });
}

function validEntry(
  entry: CacheEntry,
  address: Readonly<{
    readonly requestFingerprint: string;
    readonly reusePolicy: ResolvedStaticEvidenceReusePolicy;
  }>,
): boolean {
  return isIssuedExecutedProgram(entry.executed) &&
    isIssuedStaticEvidenceReuseProof(entry.proof) &&
    entry.proof.requestFingerprint === address.requestFingerprint &&
    entry.proof.policyKind === address.reusePolicy.kind &&
    hashCanonical(reusePolicyValue(entry.reusePolicy)) ===
      hashCanonical(reusePolicyValue(address.reusePolicy));
}

function assertAddressInput<Input, Evidence>(
  input: AdapterStaticEvidenceCacheInput<Input, Evidence>,
): void {
  if (
    typeof input.familyId !== "string" || input.familyId.length === 0 ||
    input.familyId.trim() !== input.familyId
  ) {
    throw new Error("static evidence cache familyId must be canonical");
  }
  if (input.stage !== "instance-static" && input.stage !== "pricing-static") {
    throw new Error("static evidence cache stage must be static");
  }
  if (
    typeof input.subjectKey !== "string" || input.subjectKey.length === 0 ||
    input.subjectKey.trim() !== input.subjectKey
  ) {
    throw new Error("static evidence cache subjectKey must be canonical");
  }
  if (!/^[a-fA-F0-9]{64}$/.test(input.capabilityHash)) {
    throw new Error("static evidence cache capability hash must be SHA-256");
  }
  assertSource(input.source);
}

function reusePolicyValue(
  policy: ResolvedStaticEvidenceReusePolicy,
): CanonicalValue {
  switch (policy.kind) {
    case "source-local":
      return { kind: policy.kind };
    case "immutable-code":
      return {
        kind: policy.kind,
        codeSubjects: [...policy.codeSubjects].map((item) => item.toLowerCase())
          .sort(),
      };
    case "dependency-proof":
      return {
        kind: policy.kind,
        dependencyKeys: [...policy.dependencyKeys].sort(),
      };
  }
}

function assertSource(source: CanonicalSource): void {
  if (
    !Number.isSafeInteger(source.number) || source.number < 0 ||
    !Number.isSafeInteger(source.generation) || source.generation < 0 ||
    !/^0x[0-9a-fA-F]{64}$/.test(source.hash)
  ) {
    throw new Error("static evidence cache source must be canonical");
  }
}

function samePhysicalSource(left: CanonicalSource, right: CanonicalSource): boolean {
  return left.number === right.number &&
    left.hash.toLowerCase() === right.hash.toLowerCase();
}

function sameSource(left: CanonicalSource, right: CanonicalSource): boolean {
  return samePhysicalSource(left, right) &&
    left.generation === right.generation;
}
