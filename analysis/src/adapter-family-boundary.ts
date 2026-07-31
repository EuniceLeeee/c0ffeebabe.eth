import { createHash } from "node:crypto";
import {
  familyOwnershipSourceSkeletonSha256,
  type FamilyOwnershipSourceKind,
  type FamilyOwnershipManifest,
} from "../../listener/src/searcher/test/family-ownership-manifest.js";

const PRODUCTION_REGISTRY =
  "listener/src/searcher/venues/production-registry.ts";
const ACTION_INDEX = "listener/src/adapters/index.ts";
const THIN_REGISTRATIONS =
  new Map<string, FamilyOwnershipSourceKind>([
  [PRODUCTION_REGISTRY, "production-registry"],
  [ACTION_INDEX, "action-index"],
]);
const TRUSTED_FAMILY_BOUNDARY_PREFIXES = Object.freeze([
  "listener/src/searcher/test/adapter-replay",
  "listener/src/searcher/test/blockscan-hunt",
  "listener/src/searcher/test/family-ownership-manifest",
  "listener/src/searcher/test/historical-replay-anchor",
  "listener/src/searcher/test/production-replay",
  "listener/src/searcher/test/route-execution-witness",
]);

export interface AdapterFamilyBoundaryInput {
  readonly baseCommit: string;
  readonly candidateCommit: string;
  readonly changedPaths: readonly string[];
  readonly baseManifest: FamilyOwnershipManifest;
  readonly candidateManifest: FamilyOwnershipManifest;
  readonly sourceAt: (commit: string, path: string) => string | null;
}

export interface AdapterFamilyBoundaryResult {
  readonly classification: "family_local" | "framework";
  readonly impactedFamilyIds: readonly string[];
  readonly runtimeChangedPaths: readonly string[];
  readonly reasons: readonly string[];
  readonly otherFamilySourceSetBaselineSha256: string;
  readonly otherFamilySourceSetCandidateSha256: string;
}

/**
 * Pure, RPC-free preflight. Family ownership comes only from the registry-
 * derived manifest; no family id or directory is hardcoded here.
 */
export function evaluateAdapterFamilyBoundary(
  input: AdapterFamilyBoundaryInput,
): AdapterFamilyBoundaryResult {
  const changedPaths = [...new Set(input.changedPaths)].sort();
  const runtimeChangedPaths = changedPaths.filter(
    (path) => path.startsWith("listener/src/") && !path.includes("/test/"),
  );
  const reasons: string[] = [];
  const baseFamilies = new Map(
    input.baseManifest.families.map((family) => [family.id, family]),
  );
  const candidateFamilies = new Map(
    input.candidateManifest.families.map((family) => [family.id, family]),
  );
  const candidateOwnedActions = new Map<string, string[]>();
  const candidateRequiredActions = new Map<string, string[]>();
  for (const family of input.candidateManifest.families) {
    for (const id of family.owned_action_adapter_ids) {
      candidateOwnedActions.set(
        id,
        [...(candidateOwnedActions.get(id) ?? []), family.id],
      );
    }
    for (const id of family.required_action_adapter_ids) {
      candidateRequiredActions.set(
        id,
        [...(candidateRequiredActions.get(id) ?? []), family.id],
      );
    }
  }
  for (const [id, owners] of candidateOwnedActions) {
    const consumers = candidateRequiredActions.get(id) ?? [];
    if (consumers.length > 0) {
      reasons.push(
        `ActionAdapter ${id} is both owned (${owners.sort().join(",")}) ` +
          `and shared infra (${consumers.sort().join(",")})`,
      );
    }
  }
  const removedFamilies = [...baseFamilies.keys()]
    .filter((id) => !candidateFamilies.has(id))
    .sort();
  if (removedFamilies.length > 0) {
    reasons.push(`family removed: ${removedFamilies.join(",")}`);
  }
  for (const [id, baseline] of baseFamilies) {
    const candidate = candidateFamilies.get(id);
    if (
      candidate &&
      (
        candidate.kind !== baseline.kind ||
        candidate.root_source !== baseline.root_source ||
        candidate.root_export !== baseline.root_export
      )
    ) {
      reasons.push(`existing family root identity changed: ${id}`);
    }
  }

  const impacted = new Set<string>();
  for (const path of runtimeChangedPaths) {
    const registrationKind = THIN_REGISTRATIONS.get(path);
    if (registrationKind) {
      const before = input.sourceAt(input.baseCommit, path);
      const after = input.sourceAt(input.candidateCommit, path);
      if (
        before === null ||
        after === null ||
        familyOwnershipSourceSkeletonSha256(registrationKind, before) !==
          familyOwnershipSourceSkeletonSha256(registrationKind, after)
      ) {
        reasons.push(`central registration behavior changed: ${path}`);
      } else {
        reasons.push(
          `central registration file changed; use a family-owned ` +
            `production entry instead: ${path}`,
        );
      }
      continue;
    }
    const owners = ownerIds(path, input.candidateManifest, input.baseManifest);
    if (owners.length === 0) {
      reasons.push(`runtime path has no family owner: ${path}`);
      continue;
    }
    if (owners.length > 1) {
      reasons.push(
        `shared family runtime changed: ${path} (${owners.join(",")})`,
      );
      continue;
    }
    const ownerId = owners[0];
    if (!inFamilyRuntimeStructure(path)) {
      reasons.push(
        `runtime source is outside the family structure: ${path}`,
      );
      continue;
    }
    const relativePath = path.slice("listener/".length);
    const baselineOwner = baseFamilies.get(ownerId);
    const candidateOwner = candidateFamilies.get(ownerId);
    const baselineOwned =
      baselineOwner?.source_files.includes(relativePath) === true;
    const existedAtBaseline =
      input.sourceAt(input.baseCommit, path) !== null;
    if (existedAtBaseline && !baselineOwned) {
      reasons.push(
        `pre-existing runtime source newly claimed by ${ownerId}: ${path}`,
      );
      continue;
    }
    if (
      !existedAtBaseline &&
      (
        !candidateOwner ||
        !allowedNewFamilyRuntimePath(path, candidateOwner)
      )
    ) {
      reasons.push(
        `new runtime source is outside the family structure: ${path}`,
      );
      continue;
    }
    impacted.add(ownerId);
  }
  if (impacted.size !== 1) {
    reasons.push(
      `family-local change must have exactly one owner; found ${impacted.size}`,
    );
  }

  const impactedFamilyIds = [...impacted].sort();
  for (const familyId of impactedFamilyIds) {
    const family = candidateFamilies.get(familyId);
    if (
      family &&
      !allowedNewFamilyRuntimePath(
        `listener/${family.root_source}`,
        family,
      )
    ) {
      reasons.push(
        `family root is outside the family structure: ` +
          `listener/${family.root_source}`,
      );
    }
  }
  const addedFamilies = [...candidateFamilies.keys()]
    .filter((id) => !baseFamilies.has(id))
    .sort();
  if (
    addedFamilies.length > 1 ||
    addedFamilies.some((id) => !impacted.has(id))
  ) {
    reasons.push(
      `new family set is outside the impacted owner: ${addedFamilies.join(",")}`,
    );
  }
  if (runtimeChangedPaths.includes(PRODUCTION_REGISTRY)) {
    const candidateExistingOrder = input.candidateManifest.registry_order
      .filter((id) => !addedFamilies.includes(id));
    if (
      stableJson(candidateExistingOrder) !==
        stableJson(input.baseManifest.registry_order)
    ) {
      reasons.push(
        "production registry reorders or replaces existing families",
      );
    }
  }
  if (runtimeChangedPaths.includes(ACTION_INDEX)) {
    const impactedActionIds = new Set(
      [...input.baseManifest.families, ...input.candidateManifest.families]
        .filter((family) => impacted.has(family.id))
        .flatMap((family) => family.owned_action_adapter_ids),
    );
    const baseCatalog = input.baseManifest.action_catalog_ids;
    const candidateCatalog = input.candidateManifest.action_catalog_ids;
    if (!Array.isArray(baseCatalog) || !Array.isArray(candidateCatalog)) {
      reasons.push("action catalog delta is unavailable");
    } else {
      const unaffectedBase = baseCatalog.filter(
        (id) => !impactedActionIds.has(id),
      );
      const unaffectedCandidate = candidateCatalog.filter(
        (id) => !impactedActionIds.has(id),
      );
      if (stableJson(unaffectedBase) !== stableJson(unaffectedCandidate)) {
        reasons.push(
          "action catalog changes IDs outside the impacted family",
        );
      }
    }
  }

  for (const path of changedPaths.filter((entry) =>
    !runtimeChangedPaths.includes(entry)
  )) {
    if (!allowedSupplementalPath(
      path,
      impactedFamilyIds,
      input.baseCommit,
      input.sourceAt,
      input.baseManifest,
      input.candidateManifest,
    )) {
      reasons.push(`repository path is outside the family boundary: ${path}`);
    }
  }

  const otherBase = otherFamilyClosure(
    input.baseManifest,
    impacted,
    input.baseCommit,
    input.sourceAt,
  );
  const otherCandidate = otherFamilyClosure(
    input.candidateManifest,
    impacted,
    input.candidateCommit,
    input.sourceAt,
  );
  for (const path of otherBase.missingPaths) {
    reasons.push(
      `manifest-owned source missing at baseline ${input.baseCommit}: ${path}`,
    );
  }
  for (const path of otherCandidate.missingPaths) {
    reasons.push(
      `manifest-owned source missing at candidate ` +
        `${input.candidateCommit}: ${path}`,
    );
  }
  if (otherBase.sha256 !== otherCandidate.sha256) {
    reasons.push("unchanged-family source closure differs");
  }
  if (runtimeChangedPaths.length === 0) {
    reasons.push("candidate changes no family-owned runtime path");
  }

  return Object.freeze({
    classification: reasons.length === 0 ? "family_local" : "framework",
    impactedFamilyIds: Object.freeze(impactedFamilyIds),
    runtimeChangedPaths: Object.freeze(runtimeChangedPaths),
    reasons: Object.freeze(reasons),
    otherFamilySourceSetBaselineSha256: otherBase.sha256,
    otherFamilySourceSetCandidateSha256: otherCandidate.sha256,
  });
}

function allowedSupplementalPath(
  path: string,
  impactedFamilyIds: readonly string[],
  baseCommit: string,
  sourceAt: AdapterFamilyBoundaryInput["sourceAt"],
  baseManifest: FamilyOwnershipManifest,
  candidateManifest: FamilyOwnershipManifest,
): boolean {
  if (trustedFamilyBoundaryPath(path)) return false;
  if (impactedFamilyIds.length !== 1) return false;
  const family = candidateManifest.families.find(
    (entry) => entry.id === impactedFamilyIds[0],
  );
  if (!family) return false;
  const baselineFamily = baseManifest.families.find(
    (entry) => entry.id === family.id,
  );
  if (!baselineFamily && sourceAt(baseCommit, path) !== null) return false;
  const tokens = familyIdTokens(baselineFamily ?? family);
  if (tokens.length === 0) return false;
  const normalizedPath = path.toLowerCase();
  if (
    path.startsWith("listener/src/searcher/test/") &&
    (
      path.endsWith(".ts") ||
      path.startsWith(
        "listener/src/searcher/test/fixtures/adapter-families/",
      )
    )
  ) {
    return tokens.some((token) => normalizedPath.includes(token));
  }
  if (
    path.startsWith("docs/research/") &&
    path.endsWith(".md") &&
    ![
      "docs/research/gates.md",
      "docs/research/HERMES.md",
      "docs/research/HISTORICAL-GAP.md",
      "docs/research/tx-gap-analysis-format.md",
    ].includes(path)
  ) {
    return tokens.some((token) => normalizedPath.includes(token));
  }
  return false;
}

function trustedFamilyBoundaryPath(path: string): boolean {
  return TRUSTED_FAMILY_BOUNDARY_PREFIXES.some((prefix) =>
    path === `${prefix}.ts` || path.startsWith(`${prefix}-`)
  );
}

function familyIdTokens(
  family: FamilyOwnershipManifest["families"][number],
): string[] {
  const ignored = new Set([
    "adapter",
    "family",
    "protocol",
    "protocols",
    "swap",
    "swaps",
    "custom",
    "index",
    "listener",
    "searcher",
    "src",
    "venues",
  ]);
  return [...new Set(
    family.id.toLowerCase().split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !ignored.has(token)),
  )].sort();
}

function allowedNewFamilyRuntimePath(
  path: string,
  family: FamilyOwnershipManifest["families"][number],
): boolean {
  if (!inFamilyRuntimeStructure(path)) return false;
  const relative = path.startsWith("listener/")
    ? path.slice("listener/".length)
    : path;
  const normalizedPath = relative.toLowerCase();
  return familyIdTokens(family).some((token) =>
    normalizedPath.includes(token)
  );
}

function inFamilyRuntimeStructure(path: string): boolean {
  const relative = path.startsWith("listener/")
    ? path.slice("listener/".length)
    : path;
  if (relative.startsWith(
    "src/searcher/venues/production-families/",
  )) {
    return /^[a-z0-9][a-z0-9-]*\.production\.ts$/.test(
      relative.slice(
        "src/searcher/venues/production-families/".length,
      ),
    );
  }
  return [
    "src/searcher/venues/swaps/",
    "src/searcher/venues/protocols/",
    "src/searcher/venues/credit/",
    "src/searcher/venues/funding/",
    "src/searcher/venues/liquidity/",
    "src/adapters/",
  ].some((prefix) => relative.startsWith(prefix));
}

function ownerIds(
  path: string,
  candidate: FamilyOwnershipManifest,
  base: FamilyOwnershipManifest,
): string[] {
  const relative = path.slice("listener/".length);
  return [...new Set([...candidate.families, ...base.families]
    .filter((family) => family.source_files.includes(relative))
    .map((family) => family.id))].sort();
}

function otherFamilyClosure(
  manifest: FamilyOwnershipManifest,
  impacted: ReadonlySet<string>,
  commit: string,
  sourceAt: AdapterFamilyBoundaryInput["sourceAt"],
): { sha256: string; missingPaths: readonly string[] } {
  const missingPaths: string[] = [];
  const entries = manifest.families
    .filter((family) => !impacted.has(family.id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((family) => ({
      familyId: family.id,
      semantics: {
        kind: family.kind,
        rootSource: family.root_source,
        rootExport: family.root_export,
        poolAdapterIds: [...family.pool_adapter_ids].sort(),
        edgeAdapterIds: [...family.edge_adapter_ids].sort(),
        ownedActionAdapterIds:
          [...family.owned_action_adapter_ids].sort(),
        requiredActionAdapterIds:
          [...family.required_action_adapter_ids].sort(),
        candidateSourceIds: [...family.candidate_source_ids].sort(),
        requiresCurrentHeadExecutionEvidence:
          family.requires_current_head_execution_evidence,
        activationSha256: family.activation_sha256,
      },
      sources: [...family.source_files].sort().map((relative) => {
        const path = `listener/${relative}`;
        const source = sourceAt(commit, path);
        if (source === null) missingPaths.push(path);
        return {
          path,
          sha256: source === null ? null : sha256(source),
        };
      }),
    }));
  return {
    sha256: sha256(stableJson(entries)),
    missingPaths: Object.freeze([...new Set(missingPaths)].sort()),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
