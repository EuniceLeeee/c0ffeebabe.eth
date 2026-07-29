import { ethers } from "ethers";
import type { TokenEdge } from "./planner/token-graph.js";
import type {
  ExecutionFamilyId,
  PendingExecutionEvidence,
  PendingTransactionEvidenceCapability,
  PendingTransactionEvidenceHead,
} from "./venues/route-leg-adapter.js";

export interface BlockScanPendingEvidenceTrigger {
  readonly txHash: string;
  readonly head: PendingTransactionEvidenceHead;
  /** When the pending notification first entered intake. */
  readonly observedAtMs: number;
  readonly observedAtMonotonicMs: number;
  /** When family observation and canonical validation finished. */
  readonly evidenceReadyAtMs: number;
  readonly evidenceReadyAtMonotonicMs: number;
  readonly evidence: readonly PendingExecutionEvidence[];
}

export type BlockScanExecutionPassMode =
  | "periodic"
  | "combined"
  | "evidence-only";

const FAMILY_WIDE_ACTIVATION_SCOPE = "family-wide";

export function pendingEvidenceEdgeScopeKey(
  capability: PendingTransactionEvidenceCapability,
  edge: TokenEdge,
): string | null {
  const scope = capability.routeActivationScope;
  if (capability.routeActivation !== "current-head-block-scan" || !scope) {
    return null;
  }
  return scope.kind === "family"
    ? FAMILY_WIDE_ACTIVATION_SCOPE
    : scope.edgeScopeKey(edge);
}

export function pendingEvidenceScopeKeys(
  capability: PendingTransactionEvidenceCapability,
  evidence: PendingExecutionEvidence,
): readonly string[] {
  const scope = capability.routeActivationScope;
  if (capability.routeActivation !== "current-head-block-scan" || !scope) {
    return Object.freeze([]);
  }
  return scope.kind === "family"
    ? Object.freeze([FAMILY_WIDE_ACTIVATION_SCOPE])
    : scope.evidenceScopeKeys(evidence);
}

export function createBlockScanExecutionAvailability(input: {
  readonly mode: BlockScanExecutionPassMode;
  readonly evidence: readonly PendingExecutionEvidence[];
  readonly familyForEdge: (
    edgeAdapterId: string,
  ) => ExecutionFamilyId | null;
  readonly edgeScopeKey: (edge: TokenEdge) => string | null;
  readonly evidenceScopeKeys: (
    evidence: PendingExecutionEvidence,
  ) => readonly string[];
}): {
  readonly edgeEligible: (edge: TokenEdge) => boolean;
  readonly routeEligible: (edges: readonly TokenEdge[]) => boolean;
} {
  const scopeKeysByFamily = new Map<ExecutionFamilyId, ReadonlySet<string>>();
  for (const evidence of input.evidence) {
    try {
      const keys = input.evidenceScopeKeys(evidence);
      if (
        keys.length === 0 ||
        keys.some((key) => typeof key !== "string" || key.length === 0)
      ) {
        continue;
      }
      scopeKeysByFamily.set(evidence.familyId, new Set(keys));
    } catch {
      // A broken family projection quarantines only that family for this pass.
    }
  }
  const edgeAvailable = (edge: TokenEdge): boolean => {
    const familyId = input.familyForEdge(edge.adapterId);
    if (familyId === null) return true;
    const scopes = scopeKeysByFamily.get(familyId);
    if (!scopes) return false;
    try {
      const key = input.edgeScopeKey(edge);
      return key !== null && scopes.has(key);
    } catch {
      return false;
    }
  };
  return Object.freeze({
    edgeEligible(edge: TokenEdge): boolean {
      return edgeAvailable(edge);
    },
    routeEligible(edges: readonly TokenEdge[]): boolean {
      const requiredCount = edges.filter(
        (edge) => input.familyForEdge(edge.adapterId) !== null,
      ).length;
      if (input.mode === "periodic") return requiredCount === 0;
      if (input.mode === "evidence-only" && requiredCount === 0) {
        return false;
      }
      return edges.every(edgeAvailable);
    },
  });
}

export function validateBlockScanPendingEvidenceTrigger(
  trigger: BlockScanPendingEvidenceTrigger,
): void {
  if (
    !ethers.isHexString(trigger.txHash, 32) ||
    !Number.isSafeInteger(trigger.head.number) ||
    trigger.head.number < 0 ||
    !ethers.isHexString(trigger.head.hash, 32) ||
    !Number.isFinite(trigger.observedAtMs) ||
    !Number.isFinite(trigger.observedAtMonotonicMs) ||
    !Number.isFinite(trigger.evidenceReadyAtMs) ||
    !Number.isFinite(trigger.evidenceReadyAtMonotonicMs) ||
    trigger.evidenceReadyAtMs < trigger.observedAtMs ||
    trigger.evidenceReadyAtMonotonicMs < trigger.observedAtMonotonicMs ||
    trigger.evidence.length === 0
  ) {
    throw new Error("invalid block-scan pending evidence trigger");
  }
  const families = new Set<ExecutionFamilyId>();
  for (const item of trigger.evidence) {
    if (
      families.has(item.familyId) ||
      item.txHash.toLowerCase() !== trigger.txHash.toLowerCase() ||
      item.headBlockNumber !== trigger.head.number ||
      item.headHash.toLowerCase() !== trigger.head.hash.toLowerCase() ||
      ethers.keccak256(item.canonicalPayload).toLowerCase() !==
        item.payloadHash.toLowerCase()
    ) {
      throw new Error("block-scan pending evidence binding mismatch");
    }
    families.add(item.familyId);
    const expectedEvidenceHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "bytes32", "uint256", "bytes32", "bytes32"],
        [
          item.familyId,
          item.txHash,
          item.headBlockNumber,
          item.headHash,
          item.payloadHash,
        ],
      ),
    );
    if (
      expectedEvidenceHash.toLowerCase() !== item.evidenceHash.toLowerCase()
    ) {
      throw new Error("block-scan pending evidence hash mismatch");
    }
  }
}
