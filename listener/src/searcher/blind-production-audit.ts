import { createHash } from "node:crypto";
import type {
  BlindProductionArtifactDocuments,
  BlindProductionArtifactReceipts,
} from "./blind-production-artifacts.js";

export const BLIND_PRODUCTION_RAW_PROFILE =
  "adapter-family-production-raw-v2" as const;
export const BLIND_PRODUCTION_CONTROL_PREFIX = "BLIND_PRODUCTION_CONTROL=";
export const BLIND_PRODUCTION_CONTROL_FAILURE_PREFIX =
  "BLIND_PRODUCTION_CONTROL_FAILURE=";
export const BLIND_PRODUCTION_READY_PREFIX = "BLIND_PRODUCTION_READY=";
export const BLIND_PRODUCTION_RAW_PREFIX = "BLIND_PRODUCTION_RAW=";

export interface BlindProductionBlockAnchor {
  readonly number: number;
  readonly hash: string;
  readonly stateRoot: string;
}

export interface BlindProductionPrepareControl {
  readonly type: "prepare";
  readonly profile: typeof BLIND_PRODUCTION_RAW_PROFILE;
  readonly attemptNonce: string;
  readonly base: BlindProductionBlockAnchor;
}

export interface BlindProductionSourceHeadControl {
  readonly type: "source_head";
  readonly profile: typeof BLIND_PRODUCTION_RAW_PROFILE;
  readonly attemptNonce: string;
  readonly source: BlindProductionBlockAnchor;
}

export type BlindProductionControl =
  | BlindProductionPrepareControl
  | BlindProductionSourceHeadControl;

export interface BlindProductionControlFailureRecord {
  readonly type: "control_failure";
  readonly profile: typeof BLIND_PRODUCTION_RAW_PROFILE;
  readonly controlType: BlindProductionControl["type"];
  readonly attemptNonce: string;
  readonly message: string;
}

export interface BlindProductionReadyRecord {
  readonly type: "ready";
  readonly profile: typeof BLIND_PRODUCTION_RAW_PROFILE;
  readonly attemptNonce: string;
  readonly base: BlindProductionBlockAnchor;
  readonly artifacts: Omit<BlindProductionArtifactReceipts, "sourceDelta">;
  readonly artifactDocuments:
    Omit<BlindProductionArtifactDocuments, "sourceDelta">;
}

export interface BlindProductionRouteStep {
  readonly familyId: string;
  readonly adapterId: string;
  readonly target: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly executionVariantKey: string;
}

export interface BlindProductionGraphEvidence {
  readonly orderedEdgeIds: readonly string[];
  readonly orderedEdgeHash: string;
}

export interface BlindProductionPricingCoverageEvidence {
  readonly expectedStateKeys: readonly string[];
  readonly resolvedStateKeys: readonly string[];
  readonly expectedStateKeyHash: string;
  readonly resolvedStateKeyHash: string;
  readonly expectedPricedEdgeIds: readonly string[];
  readonly resolvedPricedEdgeIds: readonly string[];
  readonly expectedPricedEdgeHash: string;
  readonly resolvedPricedEdgeHash: string;
}

export interface BlindProductionOpportunityEvidence {
  readonly rank: number;
  readonly route: readonly BlindProductionRouteStep[];
  readonly refined: boolean;
  readonly planCount: number;
  readonly simulation: {
    readonly executed: boolean;
    readonly success: boolean;
    readonly profitRaw: string;
    readonly gasUsed: string;
    readonly calldataSha256: string;
    readonly standingPosition: boolean;
  };
  readonly ev: {
    readonly executionStatus: "pass" | "not_run";
    readonly decision: "allow" | "reject";
    readonly reason: string;
  };
}

export const BLIND_PRODUCTION_STAGE_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const BLIND_PRODUCTION_STAGE_NAMES = Object.freeze([
  "state_ready",
  "enumeration_done",
  "exact_refine_done",
  "planner_solver_done",
  "final_sim_done",
  "ev_decision",
] as const);

export type BlindProductionStageName =
  typeof BLIND_PRODUCTION_STAGE_NAMES[number];

interface BlindProductionStageArtifactBase<
  Name extends BlindProductionStageName,
> {
  readonly schemaVersion:
    typeof BLIND_PRODUCTION_STAGE_ARTIFACT_SCHEMA_VERSION;
  readonly name: Name;
  readonly previousArtifactSha256: string | null;
}

export interface BlindProductionStateStageArtifact
  extends BlindProductionStageArtifactBase<"state_ready"> {
  readonly graph: BlindProductionGraphEvidence;
  readonly pricingCoverage: BlindProductionPricingCoverageEvidence;
}

export interface BlindProductionEnumerationStageOpportunity {
  readonly rank: number;
  readonly route: readonly BlindProductionRouteStep[];
}

export interface BlindProductionRefineStageOpportunity
  extends BlindProductionEnumerationStageOpportunity {
  readonly refined: boolean;
}

export interface BlindProductionPlannerStageOpportunity
  extends BlindProductionRefineStageOpportunity {
  readonly planCount: number;
}

export interface BlindProductionFinalSimStageOpportunity
  extends BlindProductionPlannerStageOpportunity {
  readonly simulation: BlindProductionOpportunityEvidence["simulation"];
}

export interface BlindProductionEvStageOpportunity
  extends BlindProductionFinalSimStageOpportunity {
  readonly ev: BlindProductionOpportunityEvidence["ev"];
}

export interface BlindProductionEnumerationStageArtifact
  extends BlindProductionStageArtifactBase<"enumeration_done"> {
  readonly opportunities:
    readonly BlindProductionEnumerationStageOpportunity[];
}

export interface BlindProductionRefineStageArtifact
  extends BlindProductionStageArtifactBase<"exact_refine_done"> {
  readonly opportunities: readonly BlindProductionRefineStageOpportunity[];
}

export interface BlindProductionPlannerStageArtifact
  extends BlindProductionStageArtifactBase<"planner_solver_done"> {
  readonly opportunities: readonly BlindProductionPlannerStageOpportunity[];
}

export interface BlindProductionFinalSimStageArtifact
  extends BlindProductionStageArtifactBase<"final_sim_done"> {
  readonly opportunities: readonly BlindProductionFinalSimStageOpportunity[];
}

export interface BlindProductionEvStageArtifact
  extends BlindProductionStageArtifactBase<"ev_decision"> {
  readonly opportunities: readonly BlindProductionEvStageOpportunity[];
}

export type BlindProductionStageArtifact =
  | BlindProductionStateStageArtifact
  | BlindProductionEnumerationStageArtifact
  | BlindProductionRefineStageArtifact
  | BlindProductionPlannerStageArtifact
  | BlindProductionFinalSimStageArtifact
  | BlindProductionEvStageArtifact;

export interface BlindProductionStageEvidence {
  readonly name: BlindProductionStageName;
  readonly status: "pass" | "fail" | "not_run" | "bypassed";
  readonly artifact: BlindProductionStageArtifact;
  readonly artifactSha256: string;
  readonly stageMs: number;
  readonly cumulativeMs: number;
}

export interface BlindProductionStageSealInput {
  readonly graph: BlindProductionGraphEvidence;
  readonly pricingCoverage: BlindProductionPricingCoverageEvidence;
  readonly opportunities: readonly BlindProductionOpportunityEvidence[];
}

/**
 * Raw output from the unchanged production closure. It contains all naturally
 * produced opportunities and never contains an expected route or target.
 */
export interface BlindProductionPassRecord {
  readonly type: "pass";
  readonly profile: typeof BLIND_PRODUCTION_RAW_PROFILE;
  readonly attemptNonce: string;
  readonly base: BlindProductionBlockAnchor;
  readonly source: BlindProductionBlockAnchor;
  readonly artifacts: BlindProductionArtifactReceipts;
  readonly artifactDocuments: BlindProductionArtifactDocuments;
  readonly selectionMode: "production";
  readonly forcedSelectionCount: number;
  readonly stages: readonly BlindProductionStageEvidence[];
  readonly graph: BlindProductionGraphEvidence;
  readonly pricingCoverage: BlindProductionPricingCoverageEvidence;
  readonly telemetry: {
    readonly dynamicCacheGeneration: number;
    readonly dynamicCacheReset: boolean;
    readonly sourceDeltaApplied: boolean;
    readonly freshReadCount: number;
    readonly batchCount: number;
    readonly incompleteFamilyIds: readonly string[];
  };
  readonly opportunities: readonly BlindProductionOpportunityEvidence[];
}

export function blindProductionAuditHash(value: unknown): string {
  return createHash("sha256").update(blindProductionCanonicalJson(value)).digest("hex");
}

export function sealBlindProductionStageArtifact(
  name: BlindProductionStageName,
  previousArtifactSha256: string | null,
  input: BlindProductionStageSealInput,
): Readonly<{
  artifact: BlindProductionStageArtifact;
  artifactSha256: string;
}> {
  if (
    previousArtifactSha256 !== null &&
    !/^[0-9a-f]{64}$/.test(previousArtifactSha256)
  ) {
    throw new Error("blind production previous stage artifact hash");
  }
  const common = {
    schemaVersion: BLIND_PRODUCTION_STAGE_ARTIFACT_SCHEMA_VERSION,
    name,
    previousArtifactSha256,
  };
  const opportunities = input.opportunities.map((opportunity) => {
    const enumeration = {
      rank: opportunity.rank,
      route: opportunity.route,
    };
    switch (name) {
      case "enumeration_done":
        return enumeration;
      case "exact_refine_done":
        return {
          ...enumeration,
          refined: opportunity.refined,
        };
      case "planner_solver_done":
        return {
          ...enumeration,
          refined: opportunity.refined,
          planCount: opportunity.planCount,
        };
      case "final_sim_done":
        return {
          ...enumeration,
          refined: opportunity.refined,
          planCount: opportunity.planCount,
          simulation: opportunity.simulation,
        };
      case "ev_decision":
        return {
          ...enumeration,
          refined: opportunity.refined,
          planCount: opportunity.planCount,
          simulation: opportunity.simulation,
          ev: opportunity.ev,
        };
      case "state_ready":
        return enumeration;
    }
  });
  const artifact = blindProductionDeepSeal(
    name === "state_ready"
      ? {
          ...common,
          graph: input.graph,
          pricingCoverage: input.pricingCoverage,
        }
      : {
          ...common,
          opportunities,
        },
  ) as BlindProductionStageArtifact;
  return Object.freeze({
    artifact,
    artifactSha256: blindProductionStageArtifactSha256(artifact),
  });
}

export function blindProductionStageArtifactSha256(
  artifact: BlindProductionStageArtifact,
): string {
  return blindProductionAuditHash(artifact);
}

export function blindProductionDeepSeal<T>(value: T): T {
  return deepFreeze(canonicalize(value) as T);
}

/** SHA-256 of the actual calldata bytes, not of its JSON/hex rendering. */
export function blindProductionCalldataSha256(calldata: string): string {
  if (!/^0x(?:[0-9a-f]{2})*$/i.test(calldata)) {
    throw new Error("blind production calldata must be even-length hex bytes");
  }
  return createHash("sha256")
    .update(Buffer.from(calldata.slice(2), "hex"))
    .digest("hex");
}

export function blindProductionCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function validateBlindProductionControl(
  value: unknown,
): BlindProductionControl {
  if (!value || typeof value !== "object") {
    throw new Error("blind production control must be an object");
  }
  const control = value as Partial<BlindProductionControl>;
  if (control.profile !== BLIND_PRODUCTION_RAW_PROFILE) {
    throw new Error("blind production control profile mismatch");
  }
  if (!/^[0-9a-f]{64}$/.test(String(control.attemptNonce ?? ""))) {
    throw new Error("blind production control nonce");
  }
  if (control.type === "prepare") {
    assertExactKeys(
      control,
      ["attemptNonce", "base", "profile", "type"],
      "blind prepare",
    );
    validateAnchor(control.base, "blind prepare base");
    return control as BlindProductionPrepareControl;
  }
  if (control.type === "source_head") {
    assertExactKeys(
      control,
      ["attemptNonce", "profile", "source", "type"],
      "blind source head",
    );
    validateAnchor(control.source, "blind source head");
    return control as BlindProductionSourceHeadControl;
  }
  throw new Error("blind production control type");
}

export function blindProductionControlFailureRecord(
  control: BlindProductionControl,
  error: unknown,
): BlindProductionControlFailureRecord {
  const message = error instanceof Error ? error.message : String(error);
  return Object.freeze({
    type: "control_failure",
    profile: BLIND_PRODUCTION_RAW_PROFILE,
    controlType: control.type,
    attemptNonce: control.attemptNonce,
    message: message.slice(0, 2_000) || "unknown control failure",
  });
}

export function validateBlindProductionControlFailureRecord(
  value: unknown,
  expected: BlindProductionControl,
): BlindProductionControlFailureRecord {
  if (!value || typeof value !== "object") {
    throw new Error("blind production control failure must be an object");
  }
  const failure = value as Partial<BlindProductionControlFailureRecord>;
  assertExactKeys(
    failure,
    ["attemptNonce", "controlType", "message", "profile", "type"],
    "blind production control failure",
  );
  if (
    failure.type !== "control_failure" ||
    failure.profile !== BLIND_PRODUCTION_RAW_PROFILE ||
    failure.controlType !== expected.type ||
    failure.attemptNonce !== expected.attemptNonce ||
    typeof failure.message !== "string" ||
    failure.message.length === 0 ||
    failure.message.length > 2_000
  ) {
    throw new Error("blind production control failure mismatch");
  }
  return failure as BlindProductionControlFailureRecord;
}

function validateAnchor(
  anchor: BlindProductionBlockAnchor | undefined,
  label: string,
): void {
  if (
    !anchor ||
    !Number.isSafeInteger(anchor.number) ||
    anchor.number < 0 ||
    !/^(?:0x)?[0-9a-f]{64}$/i.test(anchor.hash) ||
    !/^(?:0x)?[0-9a-f]{64}$/i.test(anchor.stateRoot)
  ) {
    throw new Error(`${label} is invalid`);
  }
  assertExactKeys(
    anchor,
    ["hash", "number", "stateRoot"],
    label,
  );
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} contains unexpected or missing fields`);
  }
}

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("blind canonical JSON rejects non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => {
          if (item === undefined) {
            throw new Error(`blind canonical JSON rejects undefined at ${key}`);
          }
          return [key, canonicalize(item)];
        }),
    );
  }
  throw new Error(`blind canonical JSON rejects ${typeof value}`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
