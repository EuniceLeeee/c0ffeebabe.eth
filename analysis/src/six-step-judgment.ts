import { createHash } from "node:crypto";
import {
  semanticJsonSha256,
  semanticProductionRouteChainError,
  type SemanticJson,
  type SemanticSixStepEvidence,
} from "../../listener/src/shared/evidence/semantic-six-step.js";
import {
  evaluateFamilyExecutionPromotion,
} from "./family-execution-evidence.js";

export const SIX_STEP_JUDGMENT_SCHEMA_VERSION = 1 as const;
export const SIX_STEP_JUDGMENT_GATE = "six-step-judgment" as const;

export interface SixStepJudgmentResult {
  readonly schema_version: typeof SIX_STEP_JUDGMENT_SCHEMA_VERSION;
  readonly gate: typeof SIX_STEP_JUDGMENT_GATE;
  readonly trust_boundary: "preauthenticated_receipts";
  readonly claim: "adapter_merge" | "production_gap" | null;
  readonly verdict: "pass" | "fail";
  readonly assessed: {
    readonly adapter: boolean;
    readonly production_gap: boolean;
  };
  readonly adapter_fixed: boolean;
  readonly adapter_merge_ready: boolean;
  readonly production_gap_fixed: boolean;
  readonly errors: readonly string[];
}

/**
 * Pure architecture-independent result judgment. Evidence production,
 * authentication, Git, deployment and cleanup remain outside this layer.
 */
export function evaluateSixStepJudgment(
  value: unknown,
): SixStepJudgmentResult {
  if (!record(value)) {
    return result(null, false, false, false, [
      "judgment input must be an object",
    ]);
  }
  const common = [
    ...(value.schema_version === SIX_STEP_JUDGMENT_SCHEMA_VERSION
      ? [] : [`schema_version must be ${SIX_STEP_JUDGMENT_SCHEMA_VERSION}`]),
    ...(value.gate === SIX_STEP_JUDGMENT_GATE
      ? [] : [`gate must be ${SIX_STEP_JUDGMENT_GATE}`]),
  ];
  if (value.claim === "adapter_merge") {
    const family = evaluateFamilyExecutionPromotion(
      value.promotion_receipt,
    );
    const adapterErrors = [
      ...common,
      ...family.adapterErrors,
      ...promotionBindingErrors(value),
    ];
    const adapterFixed = adapterErrors.length === 0;
    const mergeErrors = [
      ...adapterErrors,
      ...family.mergeErrors,
      ...boundaryErrors(value),
    ];
    return result(
      "adapter_merge",
      adapterFixed,
      adapterFixed && mergeErrors.length === 0,
      false,
      mergeErrors,
    );
  }
  if (value.claim === "production_gap") {
    const errors = [...common, ...productionGapErrors(value)];
    return result(
      "production_gap",
      false,
      false,
      errors.length === 0,
      errors,
    );
  }
  return result(null, false, false, false, [
    ...common,
    "claim must be adapter_merge or production_gap",
  ]);
}

function promotionBindingErrors(
  value: Record<string, unknown>,
): string[] {
  const receipt = record(value.promotion_receipt)
    ? value.promotion_receipt
    : null;
  if (!receipt) return [];
  return (
    SHA256.test(text(value.promotion_receipt_sha256)) &&
    value.promotion_receipt_sha256 === promotionReceiptSha256(receipt)
  ) ? [] : [
    "promotion_receipt_sha256 does not bind the native receipt",
  ];
}

function boundaryErrors(value: Record<string, unknown>): string[] {
  const boundary = record(value.family_boundary) ? value.family_boundary : null;
  const promotion = record(value.promotion_receipt)
    ? value.promotion_receipt
    : {};
  if (!boundary) return ["family_boundary must be an object"];
  const artifacts = Array.isArray(promotion.family_execution_artifacts)
    ? promotion.family_execution_artifacts
    : [];
  const families = strings(artifacts.map((artifact) =>
    record(artifact) ? artifact.execution_family_id : null
  ));
  const closure = text(boundary.other_family_source_set_baseline_sha256);
  const errors: string[] = [];
  if (
    boundary.schema_version !== 1 ||
    boundary.gate !== "adapter-family-boundary" ||
    boundary.baseline_commit !== promotion.base_commit ||
    boundary.candidate_commit !== promotion.challenger_commit ||
    boundary.classification !== "family_local" ||
    !Array.isArray(boundary.reasons) ||
    boundary.reasons.length !== 0 ||
    !sameStrings(strings(boundary.impacted_family_ids), families) ||
    !SHA256.test(closure) ||
    boundary.other_family_source_set_candidate_sha256 !== closure
  ) {
    errors.push("family_boundary is not an exact clean family_local receipt");
  }
  const {
    receipt_sha256: boundaryReceiptSha256,
    ...boundaryPayload
  } = boundary;
  if (
    !SHA256.test(text(boundaryReceiptSha256)) ||
    boundaryReceiptSha256 !== semanticJsonSha256(
      boundaryPayload as unknown as SemanticJson,
    )
  ) {
    errors.push("family_boundary.receipt_sha256 does not bind the receipt");
  }
  return errors;
}

function productionGapErrors(value: Record<string, unknown>): string[] {
  const producer = record(value.producer_contract)
    ? value.producer_contract
    : {};
  const scan = record(value.natural_scan) ? value.natural_scan : {};
  const evidence = Array.isArray(value.production_route_stage)
    ? value.production_route_stage as SemanticSixStepEvidence[]
    : [];
  const errors: string[] = [];
  const chainError = semanticProductionRouteChainError(evidence);
  if (chainError) errors.push(chainError);
  const first = evidence[0]?.output ?? {};
  if (
    !SHA40.test(text(value.candidate_commit)) ||
    producer.candidate_commit !== value.candidate_commit ||
    producer.target_blind !== true ||
    producer.explicit_route_injected !== false ||
    producer.explicit_amount_injected !== false ||
    producer.amount_source !== "solver" ||
    producer.run_id !== first.run_id ||
    producer.state_anchor_sha256 !== first.state_anchor_sha256 ||
    !SHA256.test(text(producer.frozen_output_sha256)) ||
    !SHA256.test(text(producer.target_late_verifier_sha256))
  ) {
    errors.push(
      "producer contract is not commit-bound, target-blind and target-late",
    );
  }
  if (
    scan.outcome !== "ran" ||
    scan.rank_complete !== true ||
    scan.refinement_deadline_exceeded !== false ||
    scan.evaluation_complete !== true ||
    scan.forced_selection_count !== 0 ||
    scan.run_id !== first.run_id ||
    scan.state_anchor_sha256 !== first.state_anchor_sha256 ||
    scan.target_route_sha256 !== first.target_route_sha256 ||
    scan.route_set_sha256 !== evidence[1]?.output.route_set_sha256
  ) {
    errors.push(
      "natural scan is incomplete, forced or not bound to the six-step run",
    );
  }
  const ev = evidence[5]?.output;
  if (
    !chainError &&
    (
      evidence.some((stage) => stage.status !== "pass") ||
      ev?.decision !== "allow" ||
      !positiveInteger(ev?.net_ev_wei)
    )
  ) {
    errors.push("production route did not finish with positive allowed EV");
  }
  return errors;
}

function result(
  claim: SixStepJudgmentResult["claim"],
  adapterFixed: boolean,
  adapterMergeReady: boolean,
  productionGapFixed: boolean,
  rawErrors: readonly string[],
): SixStepJudgmentResult {
  const errors = Object.freeze([...new Set(rawErrors)]);
  return Object.freeze({
    schema_version: SIX_STEP_JUDGMENT_SCHEMA_VERSION,
    gate: SIX_STEP_JUDGMENT_GATE,
    trust_boundary: "preauthenticated_receipts",
    claim,
    verdict: errors.length === 0 ? "pass" : "fail",
    assessed: Object.freeze({
      adapter: claim === "adapter_merge",
      production_gap: claim === "production_gap",
    }),
    adapter_fixed: adapterFixed,
    adapter_merge_ready: adapterMergeReady,
    production_gap_fixed: productionGapFixed,
    errors,
  });
}

function promotionReceiptSha256(receipt: Record<string, unknown>): string {
  const {
    closed_at: _closedAt,
    merge_commit: _mergeCommit,
    ...promotion
  } = receipt;
  return createHash("sha256")
    .update(`${JSON.stringify(promotion)}\n`)
    .digest("hex");
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "string" && /^[0-9]+$/.test(value) &&
    BigInt(value) > 0n;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string =>
      typeof item === "string"
    ))].sort()
    : [];
}

const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
