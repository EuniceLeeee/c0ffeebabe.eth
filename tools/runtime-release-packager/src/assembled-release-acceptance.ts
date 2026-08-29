import { types as nodeTypes } from "node:util";
import {
  CANONICAL_LIMITS,
  assertExactKeys,
  assertPlainObject,
  decodeCanonicalJson,
  encodeCanonicalBytes,
  sha256Hex,
  type Hash,
  readOwnEnumerableDataProperty,
} from "../../../packages/canonical-codec/src/index.ts";
import type { PredicateMaterialSourcePortV1 } from "../../../acceptance/gate-core/src/index.ts";
import type { VerifyExternalQualificationInputV2 } from "../../../packages/external-qualification-verifier/src/index.ts";
import type {
  RuntimeReleaseBindingV1,
  RuntimeReleaseSignerPinV1,
} from "../../../specs/release-authority/src/index.ts";
import type { SignedReleaseAuthorityApprovalV3 } from "../../../specs/qualification/src/index.ts";
import {
  assertQualifiedRunnerApprovalJoinsBoundaryReceiptV1,
  type BoundaryReceipt,
  type QualifiedRunnerBoundarySnapshotV1,
} from "../../architecture-boundaries/src/index.ts";
import {
  assertRuntimeBindingJoinsReleaseApprovalV1,
  verifyReleaseRequirementDenominatorV1,
} from "./release-acceptance.ts";
import { verifyRuntimeReleaseBindingSignatureV1 } from "./internal/runtime-binding-verifier.ts";
import type {
  InstallQualifiedReleaseAcceptanceRunnerInputV1 as FreshRunnerInstallInputV1,
  QualifiedPredicateCommonEnvelopeMaterialV1,
  QualifiedReleaseAcceptanceAdvisoryRunV1,
  QualifiedReleaseAcceptanceRunnerCapabilityV1 as FreshRunnerCapabilityV1,
} from "./internal/qualified-release-runner-owner.ts";
import type {
  FreshQualifiedReleaseRunnerRuntimeV1,
} from "./internal/qualified-release-runtime-entry.ts";
import { createFreshQualifiedReleaseRunnerRuntimeV1 } from "./internal/qualified-release-runtime-entry.ts";
import {
  issueFreshQualifiedRunnerHostV1,
  invokeFreshQualifiedRunnerHostV1,
  type FreshQualifiedRunnerHostCapabilityV1,
} from "./internal/fresh-qualified-runner-host-owner.ts";
import {
  readAuthorizedQualifiedReleaseRunnerWireV1,
  readQualifiedReleaseLineageObservationV1,
  registerPublicQualifiedReleaseRunnerV1,
  observeQualifiedReleaseAcceptanceAdvisoryV1,
  type AuthorizedQualifiedReleaseRunnerWireV1,
  type AuthorizedQualifiedRunnerBoundaryV1,
  type QualifiedReleaseAcceptanceRunnerCapabilityV1,
  type QualifiedReleaseLineageObservationV1,
} from "./internal/qualified-release-public-runner-state.ts";

export interface InstallQualifiedReleaseAcceptanceRunnerInputV1 {
  readonly boundaryReceipt: BoundaryReceipt;
  readonly runtimeBinding: RuntimeReleaseBindingV1;
  readonly runtimeSignerPin: RuntimeReleaseSignerPinV1;
  readonly externalQualifications: readonly VerifyExternalQualificationInputV2[];
  readonly predicateMaterials: readonly QualifiedPredicateCommonEnvelopeMaterialV1[];
}

/**
 * Immutable projection of facts already verified by the packager-owned
 * runner install.  It is deliberately readable only through the exact
 * process-local runner capability; a caller-authored object cannot obtain
 * this projection or substitute a self-consistent release signature.
 */
function copyExactInputArray(value: unknown, path: string): readonly unknown[] {
  if (value !== null && typeof value === "object" && nodeTypes.isProxy(value)) {
    throw new TypeError(`${path} must not be a Proxy`);
  }
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  const descriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (descriptor === undefined || !("value" in descriptor)
    || typeof descriptor.value !== "number" || !Number.isSafeInteger(descriptor.value)
    || descriptor.value < 0 || descriptor.value > CANONICAL_LIMITS.maxArrayItems) {
    throw new TypeError(`${path} array length invalid`);
  }
  const length = descriptor.value;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1
    || keys.some(key => key !== "length" && (typeof key !== "string"
      || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) {
    throw new TypeError(`${path} must be a dense exact array`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (item === undefined || !("value" in item) || !item.enumerable) {
      throw new TypeError(`${path}[${index}] must be an enumerable data property`);
    }
    result.push(item.value);
  }
  return Object.freeze(result);
}

function preflightNestedArrays(value: unknown, path: string, seen: WeakSet<object> = new WeakSet()): void {
  if (value === null || typeof value !== "object") return;
  if (nodeTypes.isProxy(value)) throw new TypeError(`${path} must not be a Proxy`);
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    const copy = copyExactInputArray(value, path);
    copy.forEach((item, index) => preflightNestedArrays(item, `${path}[${index}]`, seen));
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor && descriptor.enumerable) {
      preflightNestedArrays(descriptor.value, `${path}.${key}`, seen);
    }
  }
}

function canonicalClone<T>(value: T): T {
  return decodeCanonicalJson(encodeCanonicalBytes(value)) as T;
}

function exactRuntime(value: FreshQualifiedReleaseRunnerRuntimeV1): FreshQualifiedReleaseRunnerRuntimeV1 {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) {
    throw new TypeError("fresh qualified release runner runtime is invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("install") || !keys.includes("observeAdvisory")) {
    throw new TypeError("fresh qualified release runner runtime denominator is invalid");
  }
  for (const key of ["install", "observeAdvisory"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable
      || typeof descriptor.value !== "function") {
      throw new TypeError(`fresh qualified release runner ${key} port is invalid`);
    }
  }
  return value;
}

/**
 * Boundary qualifies the exact pushed candidate before any runner/evaluator
 * module is imported. The runner then executes only from that commit's blob
 * snapshot; checkout source and the ambient ESM cache are never authority.
 */
export function installQualifiedReleaseAcceptanceRunnerV1(
  input: InstallQualifiedReleaseAcceptanceRunnerInputV1,
): QualifiedReleaseAcceptanceRunnerCapabilityV1 {
  assertPlainObject(input, "qualifiedReleaseAcceptanceRunner");
  assertExactKeys(input, [
    "boundaryReceipt",
    "runtimeBinding",
    "runtimeSignerPin",
    "externalQualifications",
    "predicateMaterials",
  ], "qualifiedReleaseAcceptanceRunner");
  const boundaryReceipt = readOwnEnumerableDataProperty(
    input, "boundaryReceipt", "qualifiedReleaseAcceptanceRunner",
  ) as BoundaryReceipt;
  const runtimeBindingValue = readOwnEnumerableDataProperty(
    input, "runtimeBinding", "qualifiedReleaseAcceptanceRunner",
  ) as RuntimeReleaseBindingV1;
  const runtimeSignerPinValue = readOwnEnumerableDataProperty(
    input, "runtimeSignerPin", "qualifiedReleaseAcceptanceRunner",
  ) as RuntimeReleaseSignerPinV1;
  const qualificationItems = copyExactInputArray(readOwnEnumerableDataProperty(
    input, "externalQualifications", "qualifiedReleaseAcceptanceRunner",
  ), "qualifiedReleaseAcceptanceRunner.externalQualifications");
  const materialItems = copyExactInputArray(readOwnEnumerableDataProperty(
    input, "predicateMaterials", "qualifiedReleaseAcceptanceRunner",
  ), "qualifiedReleaseAcceptanceRunner.predicateMaterials");
  preflightNestedArrays(qualificationItems, "qualifiedReleaseAcceptanceRunner.externalQualifications");
  preflightNestedArrays(materialItems, "qualifiedReleaseAcceptanceRunner.predicateMaterials");

  const runtimeBinding = verifyRuntimeReleaseBindingSignatureV1(
    canonicalClone(runtimeBindingValue),
    canonicalClone(runtimeSignerPinValue),
  );
  const externalQualifications = Object.freeze(
    canonicalClone(qualificationItems) as readonly VerifyExternalQualificationInputV2[],
  );
  const denominator = verifyReleaseRequirementDenominatorV1(externalQualifications);
  assertRuntimeBindingJoinsReleaseApprovalV1(runtimeBinding, denominator.approval);
  const boundary = assertQualifiedRunnerApprovalJoinsBoundaryReceiptV1(
    boundaryReceipt,
    denominator.approval,
    externalQualifications,
  );
  const predicateMaterials = Object.freeze(
    canonicalClone(materialItems) as readonly QualifiedPredicateCommonEnvelopeMaterialV1[],
  );
  const runtimeSignerPin = canonicalClone(runtimeSignerPinValue);
  const innerInput: FreshRunnerInstallInputV1 = Object.freeze({
    runtimeBinding,
    runtimeSignerPin,
    externalQualifications,
    predicateMaterials,
  });
  const host = issueFreshQualifiedRunnerHostV1();
  const runtime = exactRuntime(createFreshQualifiedReleaseRunnerRuntimeV1(
    host,
    invokeFreshQualifiedRunnerHostV1,
  ));
  const loaded = Promise.resolve(Object.freeze({
    runtime,
    capability: runtime.install(innerInput),
  }));
  const lineage: QualifiedReleaseLineageObservationV1 = Object.freeze({
    runtimeBinding,
    releaseAuthorityApproval: denominator.approval,
    runtimeSignerPinSha256: sha256Hex(encodeCanonicalBytes(runtimeSignerPin)),
    boundary: Object.freeze({
      candidateGitRoot: boundary.candidateGitRoot,
      candidateReleaseCommit: boundary.candidateReleaseCommit,
      releaseRoleManifestRoot: boundary.releaseRoleManifestRoot,
      qualifiedRunnerEntrypointId: boundary.qualifiedRunner.entrypointId,
      qualifiedRunnerClosureDigest: boundary.qualifiedRunner.closureDigest as Hash,
      qualifiedRunnerImplementationExportDigest: boundary.qualifiedRunner.implementationExportDigest as Hash,
    }),
  });
  const authorizedWire: AuthorizedQualifiedReleaseRunnerWireV1 = Object.freeze({
    boundary: canonicalClone(boundary),
    runtimeBinding,
    runtimeSignerPin,
    externalQualifications,
    predicateMaterials,
  });
  return registerPublicQualifiedReleaseRunnerV1(Object.freeze({ loaded, lineage, authorizedWire }));
}

export {
  readAuthorizedQualifiedReleaseRunnerWireV1,
  readQualifiedReleaseLineageObservationV1,
  observeQualifiedReleaseAcceptanceAdvisoryV1,
};

export type {
  AuthorizedQualifiedReleaseRunnerWireV1,
  AuthorizedQualifiedRunnerBoundaryV1,
  QualifiedPredicateCommonEnvelopeMaterialV1,
  QualifiedReleaseAcceptanceAdvisoryRunV1,
  QualifiedReleaseAcceptanceRunnerCapabilityV1,
  QualifiedReleaseLineageObservationV1,
};
