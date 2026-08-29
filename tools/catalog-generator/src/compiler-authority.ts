import { encodeCanonicalJson } from "../../../packages/canonical-codec/src/index.ts";
import type { CatalogCompilerClosureFactV1 } from "../../../specs/catalog-compiler/src/index.ts";
import type { ReleaseQualifiedCapabilitySetV1 } from "../../../specs/capability-index/src/index.ts";
import {
  collectCatalogCompilerBoundaryProjection,
  projectCatalogCompilerClosureFacts,
  projectCatalogProposedCapabilitySet,
  type CatalogCapabilityProposalBindingV1,
  type CatalogCompilerClosureBindingV1,
} from "../../architecture-boundaries/src/index.ts";
import {
  currentCatalogCapabilityProposalSpecs,
  currentCatalogCompilerEntrypointSpecs,
  readCurrentCatalogInput,
  selectCatalogCompilerClosureCandidates,
  type CurrentCatalogInputFileV1,
} from "./current-release.ts";
import {
  CATALOG_COMPILER_OBSERVER_ENTRYPOINT,
  CATALOG_GENERATION_VERIFIER_ENTRYPOINT,
  type CatalogVerificationImplementationFactV1,
} from "./verification-receipt.ts";

export interface CurrentCatalogCompilerAuthorityObservationV1 {
  readonly scannedFileSetRoot: string;
  readonly compilerGraphRoot: string;
  readonly compilerClosures: readonly CatalogCompilerClosureFactV1[];
  readonly proposedCapabilitySet: ReleaseQualifiedCapabilitySetV1;
  readonly observerImplementation: CatalogVerificationImplementationFactV1;
  readonly verifierImplementation: CatalogVerificationImplementationFactV1;
}

function exactCandidate(
  closures: Parameters<typeof selectCatalogCompilerClosureCandidates>[0],
  spec: Parameters<typeof selectCatalogCompilerClosureCandidates>[1],
  role: "compiler" | "capability",
) {
  const candidates = selectCatalogCompilerClosureCandidates(closures, spec);
  if (candidates.length !== 1) {
    throw new TypeError(`catalog ${role} closure binding is not unique ${spec.modulePath}#${spec.exportName} (${candidates.length})`);
  }
  return candidates[0]!;
}

/**
 * Observe the current release through the same indexed TypeScript Program and
 * implementation-closure owner used by the architecture boundary.  No caller
 * supplies digests or owner refs to this operation.
 */
export function observeCurrentCatalogCompilerAuthority(
  repositoryRoot: string,
): CurrentCatalogCompilerAuthorityObservationV1 {
  const compilerSpecs = currentCatalogCompilerEntrypointSpecs();
  const capabilitySpecs = currentCatalogCapabilityProposalSpecs();
  const implementationSpecs = [
    CATALOG_COMPILER_OBSERVER_ENTRYPOINT,
    CATALOG_GENERATION_VERIFIER_ENTRYPOINT,
  ] as const;
  const receipt = collectCatalogCompilerBoundaryProjection({
    gitRoot: repositoryRoot,
    modulePaths: Object.freeze([...new Set([
      ...compilerSpecs,
      ...capabilitySpecs,
      ...implementationSpecs,
    ].map(spec => spec.modulePath))].sort()),
  });
  const compilerBindings: readonly CatalogCompilerClosureBindingV1[] = compilerSpecs.map(spec => {
    const candidate = exactCandidate(receipt.implementationClosures, spec, "compiler");
    return Object.freeze({
      modulePath: spec.modulePath,
      exportName: spec.exportName,
      entrypointId: candidate.entrypointId,
    });
  });
  const capabilityBindings: readonly CatalogCapabilityProposalBindingV1[] = capabilitySpecs.map(spec => {
    const candidate = exactCandidate(receipt.implementationClosures, spec, "capability");
    return Object.freeze({
      capabilityId: spec.capabilityId,
      version: spec.version,
      schemaHash: spec.schemaHash,
      interpreterHash: spec.interpreterHash,
      modulePath: spec.modulePath,
      exportName: spec.exportName,
      entrypointId: candidate.entrypointId,
    });
  });
  const implementationFact = (spec: typeof implementationSpecs[number]): CatalogVerificationImplementationFactV1 => {
    const candidate = exactCandidate(receipt.implementationClosures, {
      ...spec,
      preferredKind: "compiler-root" as const,
    }, "compiler");
    const facts = projectCatalogCompilerClosureFacts(receipt, [{
      modulePath: spec.modulePath,
      exportName: spec.exportName,
      entrypointId: candidate.entrypointId,
    }]);
    return facts[0]!;
  };
  return Object.freeze({
    scannedFileSetRoot: receipt.scannedFileSetRoot,
    compilerGraphRoot: receipt.compilerGraphRoot,
    compilerClosures: projectCatalogCompilerClosureFacts(receipt, compilerBindings),
    proposedCapabilitySet: projectCatalogProposedCapabilitySet(receipt, capabilityBindings),
    observerImplementation: implementationFact(CATALOG_COMPILER_OBSERVER_ENTRYPOINT),
    verifierImplementation: implementationFact(CATALOG_GENERATION_VERIFIER_ENTRYPOINT),
  });
}

/** Persisted compiler facts are evidence only after this exact owner replay. */
export function assertCatalogCompilerAuthorityExact(
  persisted: Pick<CurrentCatalogInputFileV1, "compilerClosures" | "proposedCapabilitySet">,
  observed: Pick<CurrentCatalogCompilerAuthorityObservationV1, "compilerClosures" | "proposedCapabilitySet">,
): void {
  if (encodeCanonicalJson(persisted.compilerClosures) !== encodeCanonicalJson(observed.compilerClosures)) {
    throw new TypeError("persisted catalog compiler closures do not match the current boundary observation");
  }
  if (encodeCanonicalJson(persisted.proposedCapabilitySet) !== encodeCanonicalJson(observed.proposedCapabilitySet)) {
    throw new TypeError("persisted catalog capability proposal does not match the current boundary observation");
  }
}

export function verifyCurrentCatalogCompilerAuthority(
  repositoryRoot: string,
): CurrentCatalogCompilerAuthorityObservationV1 {
  const observed = observeCurrentCatalogCompilerAuthority(repositoryRoot);
  assertCatalogCompilerAuthorityExact(readCurrentCatalogInput(repositoryRoot), observed);
  return observed;
}
