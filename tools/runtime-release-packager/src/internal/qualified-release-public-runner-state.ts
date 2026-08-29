import { types as nodeTypes } from "node:util";
import {
  CANONICAL_LIMITS,
  assertExactKeys,
  assertPlainObject,
  decodeCanonicalJson,
  encodeCanonicalBytes,
  readOwnEnumerableDataProperty,
  sha256Hex,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import type { PredicateMaterialSourcePortV1 } from "../../../../acceptance/gate-core/src/index.ts";
import type { VerifyExternalQualificationInputV2 } from "../../../../packages/external-qualification-verifier/src/index.ts";
import type { RuntimeReleaseBindingV1, RuntimeReleaseSignerPinV1 } from "../../../../specs/release-authority/src/index.ts";
import { runtimeReleaseBindingProvenanceHash } from "../../../../specs/release-authority/src/index.ts";
import type { SignedReleaseAuthorityApprovalV3 } from "../../../../specs/qualification/src/index.ts";
import {
  assertRuntimeBindingJoinsReleaseApprovalV1,
  verifyReleaseRequirementDenominatorV1,
} from "../release-acceptance.ts";
import { verifyRuntimeReleaseBindingSignatureV1 } from "./runtime-binding-verifier.ts";
import {
  createFreshQualifiedReleaseRunnerRuntimeV1,
  type FreshQualifiedReleaseRunnerRuntimeV1,
} from "./qualified-release-runtime-entry.ts";
import type {
  InstallQualifiedReleaseAcceptanceRunnerInputV1 as FreshRunnerInstallInputV1,
  QualifiedPredicateCommonEnvelopeMaterialV1,
  QualifiedReleaseAcceptanceAdvisoryRunV1,
  QualifiedReleaseAcceptanceRunnerCapabilityV1 as InnerRunnerCapabilityV1,
} from "./qualified-release-runner-owner.ts";
import {
  issueFreshQualifiedRunnerHostV1,
  invokeFreshQualifiedRunnerHostV1,
} from "./fresh-qualified-runner-host-owner.ts";

export type QualifiedReleaseAcceptanceRunnerCapabilityV1 = object;
export type VerifiedAuthorizedQualifiedRunnerWireCapabilityV1 = object;

export interface QualifiedRunnerReleaseClosureRefV1 {
  readonly role: string;
  readonly entrypointId: string;
  readonly entrypoint: string;
  readonly modulePath: string;
  readonly exportName: string;
  readonly predicateId: string | null;
  readonly predicateSpecDigest: string | null;
  readonly predicateProgramDescriptorDigest: string | null;
  readonly oracleProgramDescriptorDigest: string | null;
  readonly adapterVersion: string | null;
  readonly oracleVersion: string | null;
  readonly compositionLeafDigest: string | null;
  readonly commonEnvelopeRoleContractVersion: string | null;
  readonly materialProviderContractDigest: string | null;
  readonly implementationExportDigest: string | null;
  readonly closureDigest: string;
  readonly programInputSetRoot: string;
}

export interface QualifiedRunnerBoundarySnapshotWireV1 {
  readonly candidateGitRoot: string;
  readonly candidateReleaseCommit: string;
  readonly releaseRoleManifestRoot: string;
  readonly qualifiedRunner: QualifiedRunnerReleaseClosureRefV1;
}

export interface AuthorizedQualifiedReleaseRunnerWireV1 {
  readonly boundary: QualifiedRunnerBoundarySnapshotWireV1;
  readonly runtimeBinding: RuntimeReleaseBindingV1;
  readonly runtimeSignerPin: RuntimeReleaseSignerPinV1;
  readonly externalQualifications: readonly VerifyExternalQualificationInputV2[];
  readonly predicateMaterials: readonly QualifiedPredicateCommonEnvelopeMaterialV1[];
}

export interface AuthorizedQualifiedRunnerBoundaryV1 {
  readonly candidateReleaseCommit: string;
  readonly runtimeBindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly releaseAuthorityApprovalId: Hash;
  readonly releaseRoleManifestRoot: string;
  readonly boundaryRunnerEntrypointId: string;
  readonly boundaryRunnerClosureDigest: Hash;
  readonly boundaryRunnerImplementationExportDigest: Hash;
}

export interface QualifiedReleaseLineageObservationV1 {
  readonly runtimeBinding: RuntimeReleaseBindingV1;
  readonly releaseAuthorityApproval: SignedReleaseAuthorityApprovalV3;
  readonly runtimeSignerPinSha256: Hash;
  readonly boundary: Readonly<{
    readonly candidateGitRoot: string;
    readonly candidateReleaseCommit: string;
    readonly releaseRoleManifestRoot: string;
    readonly qualifiedRunnerEntrypointId: string;
    readonly qualifiedRunnerClosureDigest: Hash;
    readonly qualifiedRunnerImplementationExportDigest: Hash;
  }>;
}


export interface LoadedQualifiedReleaseRunnerV1 {
  readonly runtime: FreshQualifiedReleaseRunnerRuntimeV1;
  readonly capability: InnerRunnerCapabilityV1;
}

export interface PublicQualifiedReleaseRunnerStateV1 {
  readonly loaded: Promise<LoadedQualifiedReleaseRunnerV1>;
  readonly lineage: QualifiedReleaseLineageObservationV1;
  readonly authorizedWire: AuthorizedQualifiedReleaseRunnerWireV1;
}

const states = new WeakMap<object, PublicQualifiedReleaseRunnerStateV1>();
interface VerifiedWireStateV1 {
  readonly innerInput: FreshRunnerInstallInputV1;
  readonly lineage: QualifiedReleaseLineageObservationV1;
  readonly authorizedWire: AuthorizedQualifiedReleaseRunnerWireV1;
}
const verifiedWires = new WeakMap<object, VerifiedWireStateV1>();
const consumedVerifiedWires = new WeakSet<object>();

function copyExactInputArray(value: unknown, path: string): readonly unknown[] {
  if (value !== null && typeof value === "object" && nodeTypes.isProxy(value)) throw new TypeError(`${path} must not be a Proxy`);
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
    if (item === undefined || !("value" in item) || !item.enumerable) throw new TypeError(`${path}[${index}] must be an enumerable data property`);
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
    copyExactInputArray(value, path).forEach((item, index) => preflightNestedArrays(item, `${path}[${index}]`, seen));
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor && descriptor.enumerable) preflightNestedArrays(descriptor.value, `${path}.${key}`, seen);
  }
}

function canonicalClone<T>(value: T): T {
  return decodeCanonicalJson(encodeCanonicalBytes(value)) as T;
}


function exactRuntime(value: FreshQualifiedReleaseRunnerRuntimeV1): FreshQualifiedReleaseRunnerRuntimeV1 {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) throw new TypeError("fresh qualified release runner runtime is invalid");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("install") || !keys.includes("observeAdvisory")) throw new TypeError("fresh qualified release runner runtime denominator is invalid");
  for (const key of ["install", "observeAdvisory"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable || typeof descriptor.value !== "function") {
      throw new TypeError(`fresh qualified release runner ${key} port is invalid`);
    }
  }
  return value;
}

export function registerPublicQualifiedReleaseRunnerV1(state: PublicQualifiedReleaseRunnerStateV1): QualifiedReleaseAcceptanceRunnerCapabilityV1 {
  const capability = Object.freeze(Object.create(null)) as object;
  states.set(capability, Object.freeze(state));
  return capability;
}

export function readPublicQualifiedReleaseRunnerStateV1(capability: QualifiedReleaseAcceptanceRunnerCapabilityV1): PublicQualifiedReleaseRunnerStateV1 | undefined {
  return capability !== null && typeof capability === "object" ? states.get(capability) : undefined;
}

export function verifyAuthorizedQualifiedReleaseRunnerWireV1(
  wireValue: AuthorizedQualifiedReleaseRunnerWireV1,
  authorizedBoundaryValue: AuthorizedQualifiedRunnerBoundaryV1,
): VerifiedAuthorizedQualifiedRunnerWireCapabilityV1 {
  assertPlainObject(wireValue, "authorizedQualifiedReleaseRunnerWire");
  assertExactKeys(wireValue, ["boundary", "runtimeBinding", "runtimeSignerPin", "externalQualifications", "predicateMaterials"], "authorizedQualifiedReleaseRunnerWire");
  assertPlainObject(authorizedBoundaryValue, "authorizedQualifiedRunnerBoundary");
  assertExactKeys(authorizedBoundaryValue, [
    "candidateReleaseCommit", "runtimeBindingId", "releaseProvenanceHash", "releaseAuthorityApprovalId",
    "releaseRoleManifestRoot", "boundaryRunnerEntrypointId",
    "boundaryRunnerClosureDigest", "boundaryRunnerImplementationExportDigest",
  ], "authorizedQualifiedRunnerBoundary");
  const qualificationItems = copyExactInputArray(readOwnEnumerableDataProperty(wireValue, "externalQualifications", "authorizedQualifiedReleaseRunnerWire"), "authorizedQualifiedReleaseRunnerWire.externalQualifications");
  const materialItems = copyExactInputArray(readOwnEnumerableDataProperty(wireValue, "predicateMaterials", "authorizedQualifiedReleaseRunnerWire"), "authorizedQualifiedReleaseRunnerWire.predicateMaterials");
  preflightNestedArrays(qualificationItems, "authorizedQualifiedReleaseRunnerWire.externalQualifications");
  preflightNestedArrays(materialItems, "authorizedQualifiedReleaseRunnerWire.predicateMaterials");
  const runtimeSignerPin = canonicalClone(wireValue.runtimeSignerPin);
  const runtimeBinding = verifyRuntimeReleaseBindingSignatureV1(canonicalClone(wireValue.runtimeBinding), runtimeSignerPin);
  const externalQualifications = Object.freeze(canonicalClone(qualificationItems) as readonly VerifyExternalQualificationInputV2[]);
  const denominator = verifyReleaseRequirementDenominatorV1(externalQualifications);
  assertRuntimeBindingJoinsReleaseApprovalV1(runtimeBinding, denominator.approval);
  const boundary = canonicalClone(wireValue.boundary);
  const authorizedBoundary = canonicalClone(authorizedBoundaryValue);
  if (boundary.candidateReleaseCommit !== runtimeBinding.candidateReleaseCommit
    || boundary.candidateReleaseCommit !== denominator.approval.candidateReleaseCommit
    || boundary.candidateReleaseCommit !== authorizedBoundary.candidateReleaseCommit
    || runtimeBinding.bindingId !== authorizedBoundary.runtimeBindingId
    || runtimeReleaseBindingProvenanceHash(runtimeBinding) !== authorizedBoundary.releaseProvenanceHash
    || denominator.approval.approvalId !== authorizedBoundary.releaseAuthorityApprovalId
    || boundary.releaseRoleManifestRoot !== denominator.approval.releaseRoleManifestRoot
    || boundary.releaseRoleManifestRoot !== authorizedBoundary.releaseRoleManifestRoot
    || boundary.qualifiedRunner.entrypointId !== authorizedBoundary.boundaryRunnerEntrypointId
    || boundary.qualifiedRunner.closureDigest !== authorizedBoundary.boundaryRunnerClosureDigest
    || boundary.qualifiedRunner.implementationExportDigest !== authorizedBoundary.boundaryRunnerImplementationExportDigest
    || denominator.approval.qualifiedRunnerImplementationClosureDigest !== authorizedBoundary.boundaryRunnerClosureDigest
    || denominator.approval.qualifiedRunnerImplementationExportDigest !== authorizedBoundary.boundaryRunnerImplementationExportDigest) {
    throw new TypeError("signed pre-release runner material does not exact-join its Boundary authorization");
  }
  const predicateMaterials = Object.freeze(canonicalClone(materialItems) as readonly QualifiedPredicateCommonEnvelopeMaterialV1[]);
  const innerInput: FreshRunnerInstallInputV1 = Object.freeze({ runtimeBinding, runtimeSignerPin, externalQualifications, predicateMaterials });
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
  const capability = Object.freeze(Object.create(null)) as VerifiedAuthorizedQualifiedRunnerWireCapabilityV1;
  verifiedWires.set(capability, Object.freeze({ innerInput, lineage, authorizedWire: canonicalClone(wireValue) }));
  return capability;
}

export function readVerifiedAuthorizedQualifiedRunnerWireLineageV1(
  capability: VerifiedAuthorizedQualifiedRunnerWireCapabilityV1,
): QualifiedReleaseLineageObservationV1 {
  const state = capability !== null && typeof capability === "object" ? verifiedWires.get(capability) : undefined;
  if (state === undefined) throw new TypeError("authorized qualified runner wire was not owner-verified");
  return state.lineage;
}

export function installVerifiedQualifiedReleaseRunnerWireV1(
  capability: VerifiedAuthorizedQualifiedRunnerWireCapabilityV1,
): QualifiedReleaseAcceptanceRunnerCapabilityV1 {
  const state = capability !== null && typeof capability === "object" ? verifiedWires.get(capability) : undefined;
  if (state === undefined || consumedVerifiedWires.has(capability)) {
    throw new TypeError("authorized qualified runner wire capability is foreign or consumed");
  }
  consumedVerifiedWires.add(capability);
  const host = issueFreshQualifiedRunnerHostV1();
  const runtime = exactRuntime(createFreshQualifiedReleaseRunnerRuntimeV1(host, invokeFreshQualifiedRunnerHostV1));
  const loaded = Promise.resolve(Object.freeze({ runtime, capability: runtime.install(state.innerInput) }));
  return registerPublicQualifiedReleaseRunnerV1(Object.freeze({
    loaded,
    lineage: state.lineage,
    authorizedWire: state.authorizedWire,
  }));
}

export function readAuthorizedQualifiedReleaseRunnerWireV1(capability: QualifiedReleaseAcceptanceRunnerCapabilityV1): AuthorizedQualifiedReleaseRunnerWireV1 {
  const state = readPublicQualifiedReleaseRunnerStateV1(capability);
  if (state === undefined) throw new TypeError("qualified release runner durable material was not Boundary-authorized");
  return canonicalClone(state.authorizedWire);
}

export function readQualifiedReleaseLineageObservationV1(capability: QualifiedReleaseAcceptanceRunnerCapabilityV1): QualifiedReleaseLineageObservationV1 {
  const state = readPublicQualifiedReleaseRunnerStateV1(capability);
  if (state === undefined) throw new TypeError("qualified release lineage was not packager-loader-issued");
  return state.lineage;
}

export async function observeQualifiedReleaseAcceptanceAdvisoryV1(
  capability: QualifiedReleaseAcceptanceRunnerCapabilityV1,
  source: PredicateMaterialSourcePortV1,
): Promise<QualifiedReleaseAcceptanceAdvisoryRunV1> {
  const state = readPublicQualifiedReleaseRunnerStateV1(capability);
  if (state === undefined) throw new TypeError("qualified release acceptance runner capability was not packager-loader-issued");
  const loaded = await state.loaded;
  return loaded.runtime.observeAdvisory(loaded.capability, source);
}
