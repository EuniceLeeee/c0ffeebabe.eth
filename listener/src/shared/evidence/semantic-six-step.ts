import { createHash } from "node:crypto";

export const SEMANTIC_SIX_STEP_SCHEMA_VERSION = 1 as const;

export const SEMANTIC_SIX_STEP_PROFILES = Object.freeze([
  "production_route_stage",
  "family_execution",
] as const);

export type SemanticSixStepProfile =
  typeof SEMANTIC_SIX_STEP_PROFILES[number];

export const SEMANTIC_SIX_STEP_STAGE_IDS = Object.freeze([
  "discovery_admission_graph",
  "route_enumeration",
  "exact_quote_refine",
  "plan_and_size",
  "fork_final_sim",
  "production_ev",
] as const);

export type SemanticSixStepStageId =
  typeof SEMANTIC_SIX_STEP_STAGE_IDS[number];

export type SemanticSixStepStatus =
  | "pass"
  | "fail"
  | "reject"
  | "bypassed"
  | "not_reached";

export type SemanticJson =
  | null
  | boolean
  | number
  | string
  | readonly SemanticJson[]
  | { readonly [key: string]: SemanticJson };

export interface SemanticSixStepEvidence {
  readonly schema_version: typeof SEMANTIC_SIX_STEP_SCHEMA_VERSION;
  readonly profile: SemanticSixStepProfile;
  readonly step: 1 | 2 | 3 | 4 | 5 | 6;
  readonly stage_id: SemanticSixStepStageId;
  readonly status: SemanticSixStepStatus;
  /**
   * Stable domain output. It describes route-search semantics, never source
   * files, function names, log prose, or the current module layout.
   */
  readonly output: Readonly<Record<string, SemanticJson>>;
  readonly output_sha256: string;
  /** Stable machine code such as route_absent or final_sim_revert. */
  readonly reason_code: string | null;
  /** Timing/cardinality observations; excluded from semantic equivalence. */
  readonly metrics: Readonly<Record<string, SemanticJson>>;
  /** Family-owned diagnostics; unknown keys are forward-compatible. */
  readonly extensions: Readonly<Record<string, SemanticJson>>;
}

export function semanticSixStepStageId(
  step: SemanticSixStepEvidence["step"],
): SemanticSixStepStageId {
  return SEMANTIC_SIX_STEP_STAGE_IDS[step - 1];
}

export function createSemanticSixStepEvidence(input: {
  profile: SemanticSixStepProfile;
  step: SemanticSixStepEvidence["step"];
  status: SemanticSixStepStatus;
  output: Readonly<Record<string, SemanticJson>>;
  reasonCode?: string | null;
  metrics?: Readonly<Record<string, SemanticJson>>;
  extensions?: Readonly<Record<string, SemanticJson>>;
}): SemanticSixStepEvidence {
  const output = freezeJsonObject(input.output);
  return Object.freeze({
    schema_version: SEMANTIC_SIX_STEP_SCHEMA_VERSION,
    profile: input.profile,
    step: input.step,
    stage_id: semanticSixStepStageId(input.step),
    status: input.status,
    output,
    output_sha256: semanticJsonSha256(output),
    reason_code: input.reasonCode ?? null,
    metrics: freezeJsonObject(input.metrics ?? {}),
    extensions: freezeJsonObject(input.extensions ?? {}),
  });
}

export function validateSemanticSixStepEvidence(
  value: unknown,
): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["six-step evidence must be an object"];
  }
  const item = value as Partial<SemanticSixStepEvidence>;
  if (item.schema_version !== SEMANTIC_SIX_STEP_SCHEMA_VERSION) {
    errors.push(`six-step schema_version must be ${SEMANTIC_SIX_STEP_SCHEMA_VERSION}`);
  }
  if (!SEMANTIC_SIX_STEP_PROFILES.includes(item.profile as SemanticSixStepProfile)) {
    errors.push("six-step profile is invalid");
  }
  if (!Number.isInteger(item.step) || Number(item.step) < 1 || Number(item.step) > 6) {
    errors.push("six-step step must be 1..6");
  } else if (item.stage_id !== semanticSixStepStageId(
    item.step as SemanticSixStepEvidence["step"],
  )) {
    errors.push("six-step stage_id does not match its semantic step");
  }
  if (!["pass", "fail", "reject", "bypassed", "not_reached"].includes(
    String(item.status),
  )) {
    errors.push("six-step status is invalid");
  }
  for (const field of ["output", "metrics", "extensions"] as const) {
    if (!isSemanticJsonObject(item[field])) {
      errors.push(`six-step ${field} must be a JSON object`);
    }
  }
  if (!/^[a-f0-9]{64}$/.test(String(item.output_sha256 ?? ""))) {
    errors.push("six-step output_sha256 must be a lowercase SHA-256 digest");
  } else if (
    isSemanticJsonObject(item.output) &&
    semanticJsonSha256(item.output) !== item.output_sha256
  ) {
    errors.push("six-step output_sha256 does not bind output");
  }
  if (
    item.reason_code !== null &&
    (typeof item.reason_code !== "string" ||
      !/^[a-z][a-z0-9_]{0,95}$/.test(item.reason_code))
  ) {
    errors.push("six-step reason_code must be null or a stable snake_case code");
  }
  if (
    SEMANTIC_SIX_STEP_PROFILES.includes(item.profile as SemanticSixStepProfile) &&
    Number.isInteger(item.step) &&
    Number(item.step) >= 1 &&
    Number(item.step) <= 6 &&
    isSemanticJsonObject(item.output) &&
    ["pass", "fail", "reject", "bypassed", "not_reached"].includes(
      String(item.status),
    )
  ) {
    errors.push(...validateStatusOutput(
      item.profile as SemanticSixStepProfile,
      item.step as SemanticSixStepEvidence["step"],
      item.status as SemanticSixStepStatus,
      item.output,
      item.reason_code,
    ));
  }
  return errors;
}

export function semanticSixStepSequenceError(
  evidence: readonly SemanticSixStepEvidence[],
): string | null {
  if (evidence.length === 0) return "six-step evidence is empty";
  let profile: SemanticSixStepProfile | null = null;
  let terminalStep: number | null = null;
  for (const [index, item] of evidence.entries()) {
    const errors = validateSemanticSixStepEvidence(item);
    if (errors.length > 0) {
      return `six-step evidence ${index + 1} invalid: ${errors.join("; ")}`;
    }
    if (item.step !== index + 1) {
      return "six-step evidence must be one ordered prefix starting at step 1";
    }
    if (profile === null) profile = item.profile;
    if (item.profile !== profile) {
      return "six-step evidence must use one profile";
    }
    if (terminalStep !== null) {
      return `six-step evidence must terminate after step ${terminalStep}`;
    }
    if (isTerminalStatus(item.status)) terminalStep = item.step;
  }
  return null;
}

export function semanticSixStepEquivalenceError(
  baseline: readonly SemanticSixStepEvidence[],
  challenger: readonly SemanticSixStepEvidence[],
): string | null {
  const baselineError = semanticSixStepSequenceError(baseline);
  if (baselineError) return `baseline ${baselineError}`;
  const challengerError = semanticSixStepSequenceError(challenger);
  if (challengerError) return `challenger ${challengerError}`;
  if (baseline.length !== challenger.length) {
    return "six-step evidence length differs";
  }
  if (baseline[0]?.profile !== challenger[0]?.profile) {
    return "six-step evidence profile differs";
  }
  for (const [index, left] of baseline.entries()) {
    const right = challenger[index];
    if (
      left.stage_id !== right.stage_id ||
      left.status !== right.status ||
      left.reason_code !== right.reason_code ||
      left.output_sha256 !== right.output_sha256
    ) {
      return `six-step semantic output differs at step ${left.step} (${left.stage_id})`;
    }
  }
  return null;
}

export function semanticJsonSha256(value: SemanticJson): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: SemanticJson): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isSemanticJsonObject(
  value: unknown,
): value is Readonly<Record<string, SemanticJson>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    isSemanticJson(value);
}

function isSemanticJson(value: unknown): value is SemanticJson {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isSemanticJson);
  return typeof value === "object" &&
    Object.values(value as Record<string, unknown>).every(isSemanticJson);
}

function freezeJsonObject(
  value: Readonly<Record<string, SemanticJson>>,
): Readonly<Record<string, SemanticJson>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, freezeJson(entry)]),
  ));
}

function freezeJson(value: SemanticJson): SemanticJson {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJson));
  if (value !== null && typeof value === "object") {
    return freezeJsonObject(
      value as Readonly<Record<string, SemanticJson>>,
    );
  }
  return value;
}

type OutputRequirement = readonly [
  key: string,
  predicate: (value: SemanticJson) => boolean,
  expectation: string,
];

const PASS_OUTPUT_REQUIREMENTS: Readonly<
  Record<SemanticSixStepEvidence["step"], readonly OutputRequirement[]>
> = Object.freeze({
  1: [
    ["source_block", isBlockNumber, "a non-negative integer block number"],
    ["edge_set_sha256", isSha256, "a lowercase SHA-256 digest"],
    ["edge_set_size", isNonNegativeInteger, "a non-negative integer"],
    ["target_membership", isTargetMembership, "present, missing, or ambiguous"],
  ],
  2: [
    ["route_set_sha256", isSha256, "a lowercase SHA-256 digest"],
    ["route_set_size", isNonNegativeInteger, "a non-negative integer"],
    ["target_present", isBoolean, "a boolean"],
  ],
  3: [
    ["source_block", isBlockNumber, "a non-negative integer block number"],
    ["route_sha256", isSha256, "a lowercase SHA-256 digest"],
    ["quote_status", isNonEmptyString, "a non-empty string"],
    ["probe_amount_in", isPositiveDecimalString, "a positive decimal integer string"],
    ["quoted_amount_out", isNonNegativeDecimalString, "a non-negative decimal integer string"],
    ["leg_quotes", isNonEmptyJsonArray, "a non-empty JSON array"],
  ],
  4: [
    ["route_sha256", isSha256, "a lowercase SHA-256 digest"],
    ["selected_by_solve_policy", isBoolean, "a boolean"],
    ["solve_succeeded", isBoolean, "a boolean"],
    ["solver_selected_amount", isPositiveDecimalString, "a positive decimal integer string"],
    ["resolved_plan_sha256", isSha256, "a lowercase SHA-256 digest"],
    ["hop_amounts", isNonEmptyJsonArray, "a non-empty JSON array"],
  ],
  5: [
    ["success", isBoolean, "a boolean"],
    ["profit_token", isNonEmptyString, "a non-empty string"],
    ["gross_profit", isDecimalString, "a decimal integer string"],
    ["net_profit", isDecimalString, "a decimal integer string"],
    ["gas_used", isNonNegativeDecimalString, "a non-negative decimal integer string"],
    ["calldata_sha256", isSha256, "a lowercase SHA-256 digest"],
    [
      "repayment_and_conservation",
      isConservationResult,
      "true or the string pass",
    ],
    ["leaves_standing_position", isBoolean, "a boolean"],
  ],
  6: [
    ["decision", isNonEmptyString, "a non-empty string"],
    ["net_ev_wei", isDecimalString, "a decimal integer string"],
    ["gas_cost_eth", isDecimalNumberString, "a decimal number string"],
    ["bid_eth", isDecimalNumberString, "a decimal number string"],
    ["valuation_available", isBoolean, "a boolean"],
    ["gas_measurement_available", isBoolean, "a boolean"],
    ["fee_state_available", isBoolean, "a boolean"],
  ],
});

const FAMILY_BYPASS_REQUIREMENTS: Readonly<
  Partial<Record<SemanticSixStepEvidence["step"], readonly OutputRequirement[]>>
> = Object.freeze({
  1: [
    ["mode", isNonEmptyString, "a non-empty string"],
    ["state_anchor", isNonEmptyJsonObject, "a non-empty JSON object"],
    ["execution_family_id", isNonEmptyString, "a non-empty string"],
  ],
  2: [
    ["mode", isNonEmptyString, "a non-empty string"],
    ["fixture_route_sha256", isSha256, "a lowercase SHA-256 digest"],
    ["route_leg_count", isPositiveInteger, "a positive integer"],
  ],
});

function validateStatusOutput(
  profile: SemanticSixStepProfile,
  step: SemanticSixStepEvidence["step"],
  status: SemanticSixStepStatus,
  output: Readonly<Record<string, SemanticJson>>,
  reasonCode: string | null | undefined,
): string[] {
  if (status === "pass") {
    const errors = validateOutputRequirements(
      output,
      PASS_OUTPUT_REQUIREMENTS[step],
      `${profile} step ${step} pass`,
    );
    if (reasonCode !== null) {
      errors.push("six-step pass reason_code must be null");
    }
    return errors;
  }
  if (status === "bypassed") {
    if (profile !== "family_execution" || (step !== 1 && step !== 2)) {
      return [
        "six-step bypassed is allowed only for family_execution steps 1 and 2",
      ];
    }
    return validateOutputRequirements(
      output,
      FAMILY_BYPASS_REQUIREMENTS[step] ?? [],
      `family_execution step ${step} bypassed`,
    );
  }
  const errors: string[] = [];
  if (Object.keys(output).length === 0) {
    errors.push(`six-step ${status} output must be non-empty`);
  }
  if (reasonCode === null || reasonCode === undefined || reasonCode === "") {
    errors.push(`six-step ${status} reason_code must be non-null`);
  }
  return errors;
}

function validateOutputRequirements(
  output: Readonly<Record<string, SemanticJson>>,
  requirements: readonly OutputRequirement[],
  context: string,
): string[] {
  const errors: string[] = [];
  for (const [key, predicate, expectation] of requirements) {
    if (!Object.hasOwn(output, key)) {
      errors.push(`six-step ${context} output missing ${key}`);
    } else if (!predicate(output[key])) {
      errors.push(
        `six-step ${context} output ${key} must be ${expectation}`,
      );
    }
  }
  return errors;
}

function isTerminalStatus(status: SemanticSixStepStatus): boolean {
  return status === "fail" || status === "reject" || status === "not_reached";
}

function isBoolean(value: SemanticJson): boolean {
  return typeof value === "boolean";
}

function isNonEmptyString(value: SemanticJson): boolean {
  return typeof value === "string" && value.length > 0;
}

function isSha256(value: SemanticJson): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isNonNegativeInteger(value: SemanticJson): boolean {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0;
}

function isPositiveInteger(value: SemanticJson): boolean {
  return isNonNegativeInteger(value) && Number(value) > 0;
}

function isBlockNumber(value: SemanticJson): boolean {
  return isNonNegativeInteger(value) ||
    isNonNegativeDecimalString(value);
}

function isDecimalString(value: SemanticJson): boolean {
  return typeof value === "string" && /^-?[0-9]+$/.test(value);
}

function isNonNegativeDecimalString(value: SemanticJson): boolean {
  return typeof value === "string" && /^[0-9]+$/.test(value);
}

function isPositiveDecimalString(value: SemanticJson): boolean {
  return typeof value === "string" &&
    /^[0-9]+$/.test(value) &&
    BigInt(value) > 0n;
}

function isDecimalNumberString(value: SemanticJson): boolean {
  return typeof value === "string" && /^-?[0-9]+(?:\.[0-9]+)?$/.test(value);
}

function isTargetMembership(value: SemanticJson): boolean {
  return value === "present" || value === "missing" || value === "ambiguous";
}

function isNonEmptyJsonArray(value: SemanticJson): boolean {
  return Array.isArray(value) && value.length > 0;
}

function isNonEmptyJsonObject(value: SemanticJson): boolean {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0;
}

function isConservationResult(value: SemanticJson): boolean {
  return value === true || value === "pass";
}
