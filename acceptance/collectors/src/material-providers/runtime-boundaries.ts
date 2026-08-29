import { types as nodeTypes } from "node:util";
import {
  CANONICAL_LIMITS,
  assertExactKeys,
  assertGitSha40,
  assertHash,
  assertPlainObject,
  fieldArray,
  fieldString,
  readOwnEnumerableDataProperty,
  sha256Hex,
} from "../../../../packages/canonical-codec/src/index.ts";
import { decodeReadOnlyArtifactRef } from "../../../../specs/core-envelope/src/index.ts";
import {
  decodeArtifactResolutionClaim,
  decodeRetentionLeaseReceipt,
} from "../../../../specs/artifact-resolution/src/index.ts";
import type { ObservedContentArtifactV1 } from "../content-addressed-sink.ts";
import { readProductionPredicateMaterialSourceStateV1 } from "../internal/predicate-material-source-owner.ts";
import {
  productionRuntimeBoundaryMaterialEvidenceRootV1,
  type ProductionRuntimeBoundaryMaterialObservationV1,
} from "../internal/runtime-boundary-material-owner.ts";
import { available, defineProvider, unavailable } from "./shared.ts";

function fieldArtifact(value: unknown, path: string): ObservedContentArtifactV1 {
  assertExactKeys(value, ["contentSha256", "bytes", "ref", "claim", "lease"], path);
  const contentSha256 = assertHash(
    readOwnEnumerableDataProperty(value, "contentSha256", path),
    `${path}.contentSha256`,
  );
  const rawBytes = readOwnEnumerableDataProperty(value, "bytes", path);
  if (
    rawBytes === null
    || typeof rawBytes !== "object"
    || nodeTypes.isProxy(rawBytes)
    || !ArrayBuffer.isView(rawBytes)
    || Object.getPrototypeOf(rawBytes) !== Uint8Array.prototype
  ) {
    throw new TypeError(`${path}.bytes must be a concrete Uint8Array`);
  }
  const bytes = Uint8Array.from(rawBytes as Uint8Array);
  if (sha256Hex(bytes) !== contentSha256) {
    throw new TypeError(`${path}.bytes do not match contentSha256`);
  }
  const refValue = readOwnEnumerableDataProperty(value, "ref", path);
  const claimValue = readOwnEnumerableDataProperty(value, "claim", path);
  const leaseValue = readOwnEnumerableDataProperty(value, "lease", path);
  assertPlainObject(refValue, `${path}.ref`);
  assertPlainObject(claimValue, `${path}.claim`);
  assertPlainObject(leaseValue, `${path}.lease`);
  const ref = decodeReadOnlyArtifactRef(refValue);
  const claim = decodeArtifactResolutionClaim(claimValue);
  const lease = decodeRetentionLeaseReceipt(leaseValue);
  if (ref.contentSha256 !== contentSha256 || ref.byteLength !== String(bytes.byteLength)) {
    throw new TypeError(`${path}.ref does not bind exact artifact bytes`);
  }
  return Object.freeze({ contentSha256, bytes, ref, claim, lease });
}

function fieldArtifacts(value: unknown, path: string): readonly ObservedContentArtifactV1[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) throw new TypeError(`${path} must be a concrete array`);
  if (value.length > CANONICAL_LIMITS.maxArrayItems) throw new TypeError(`${path} exceeds array policy`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1
    || keys.some(key => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) {
    throw new TypeError(`${path} must be a dense exact array`);
  }
  const artifacts: ObservedContentArtifactV1[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${path}[${index}] must be an enumerable data property`);
    }
    artifacts.push(fieldArtifact(descriptor.value, `${path}[${index}]`));
  }
  return Object.freeze(artifacts);
}

function decodeBoundaryObservation(value: unknown): ProductionRuntimeBoundaryMaterialObservationV1 {
  const path = "productionRuntimeBoundaryMaterialObservation";
  const status = readOwnEnumerableDataProperty(value, "status", path);
  if (status === "missing" || status === "invalid") {
    assertExactKeys(value, ["status", "reasons", "evidenceRoot"], path);
    return Object.freeze({
      status,
      reasons: fieldArray(
        readOwnEnumerableDataProperty(value, "reasons", path),
        (reason, reasonPath) => fieldString(reason, reasonPath),
        `${path}.reasons`,
      ),
      evidenceRoot: assertHash(
        readOwnEnumerableDataProperty(value, "evidenceRoot", path),
        `${path}.evidenceRoot`,
      ),
    });
  }
  if (status !== "available") throw new TypeError(`${path}.status is not recognized`);
  assertExactKeys(value, ["status", "candidateReleaseCommit", "artifacts", "predicateFacts", "evidenceRoot"], path);
  return Object.freeze({
    status,
    candidateReleaseCommit: assertGitSha40(
      readOwnEnumerableDataProperty(value, "candidateReleaseCommit", path),
      `${path}.candidateReleaseCommit`,
    ),
    artifacts: fieldArtifacts(
      readOwnEnumerableDataProperty(value, "artifacts", path),
      `${path}.artifacts`,
    ),
    predicateFacts: fieldArray(
      readOwnEnumerableDataProperty(value, "predicateFacts", path),
      fact => fact,
      `${path}.predicateFacts`,
    ),
    evidenceRoot: assertHash(
      readOwnEnumerableDataProperty(value, "evidenceRoot", path),
      `${path}.evidenceRoot`,
    ),
  });
}

function boundaryProvider(
  predicateId: string,
  select: (state: ReturnType<typeof readProductionPredicateMaterialSourceStateV1>) => (() => Promise<unknown>) | null,
) {
  return defineProvider(predicateId, async source => {
    const state = readProductionPredicateMaterialSourceStateV1(source);
    const observe = select(state);
    if (observe === null) return unavailable(predicateId, "missing", "owner-port-missing", "durable-boundary-observer");
    let observed: ProductionRuntimeBoundaryMaterialObservationV1;
    try {
      observed = decodeBoundaryObservation(await observe());
    } catch (error) {
      return unavailable(predicateId, "invalid", "owner-material-invalid", error instanceof Error ? error.message : "durable-boundary-observer");
    }
    if (observed.status !== "available") {
      return unavailable(
        predicateId,
        observed.status,
        observed.status === "missing" ? "owner-material-missing" : "owner-material-invalid",
        { evidenceRoot: observed.evidenceRoot, reasons: observed.reasons },
      );
    }
    try {
      const expectedEvidenceRoot = productionRuntimeBoundaryMaterialEvidenceRootV1({
        predicateId,
        candidateReleaseCommit: observed.candidateReleaseCommit,
        artifacts: observed.artifacts,
        predicateFacts: observed.predicateFacts,
      });
      if (observed.evidenceRoot !== expectedEvidenceRoot) {
        return unavailable(predicateId, "invalid", "owner-material-invalid", "evidence-root-mismatch");
      }
      return available(
        predicateId,
        observed.candidateReleaseCommit,
        observed.artifacts,
        [state.sink.resolverPolicy],
        observed.predicateFacts,
      );
    } catch (error) {
      return unavailable(predicateId, "invalid", "owner-material-invalid", error instanceof Error ? error.message : "durable-boundary-material");
    }
  });
}

export const LEGACY_SHAPED_AUTHORITY_ZERO_MATERIAL_PROVIDER = boundaryProvider(
  "aloha.legacy-shaped-authority-zero",
  state => state.readLegacyAuthorityClosureBoundary,
);

export const RUNTIME_RESTART_MATERIAL_PROVIDER = boundaryProvider(
  "aloha.runtime-restart.facts",
  state => state.readRuntimeRestartBoundary,
);

export const SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_MATERIAL_PROVIDER = boundaryProvider(
  "aloha.source-repository-production-closure-zero",
  state => state.readSourceRepositoryClosureBoundary,
);
