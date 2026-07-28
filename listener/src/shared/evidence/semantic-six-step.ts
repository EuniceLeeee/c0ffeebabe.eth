import { createHash } from "node:crypto";

export const SEMANTIC_SIX_STEP_SCHEMA_VERSION = 4 as const;
export const SEMANTIC_SIX_STEP_READ_SCHEMA_VERSIONS =
  Object.freeze([1, 2, 3, SEMANTIC_SIX_STEP_SCHEMA_VERSION] as const);

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
  readonly schema_version: typeof SEMANTIC_SIX_STEP_READ_SCHEMA_VERSIONS[number];
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
  const schemaVersion = Number(item.schema_version);
  if (!Number.isInteger(schemaVersion) ||
    schemaVersion < 1 || schemaVersion > SEMANTIC_SIX_STEP_SCHEMA_VERSION) {
    errors.push(
      `six-step schema_version must be one of ${SEMANTIC_SIX_STEP_READ_SCHEMA_VERSIONS.join(",")}`,
    );
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
      schemaVersion,
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

/**
 * Verifies that six individually valid production records are one causal run,
 * rather than six compatible-looking records spliced from different runs.
 */
export function semanticProductionRouteChainError(
  evidence: readonly SemanticSixStepEvidence[],
): string | null {
  const sequenceError = semanticSixStepSequenceError(evidence);
  if (sequenceError) return sequenceError;
  if (evidence.length !== 6) {
    return "production route chain must contain all six stages";
  }
  if (evidence.some((item) =>
    item.schema_version !== SEMANTIC_SIX_STEP_SCHEMA_VERSION
  )) {
    return `production route chain requires current schema v${SEMANTIC_SIX_STEP_SCHEMA_VERSION}`;
  }
  if (evidence.some((item) => item.profile !== "production_route_stage")) {
    return "production route chain requires production_route_stage records";
  }

  const outputs = evidence.map((item) => item.output);
  const [first] = outputs;
  for (const [index, output] of outputs.entries()) {
    for (const key of [
      "run_id",
      "state_anchor_sha256",
      "target_route_sha256",
    ] as const) {
      if (output[key] !== first[key]) {
        return `production route chain ${key} differs at step ${index + 1}`;
      }
    }
  }

  const targetRoute = first.target_route_sha256;
  return ([
    [
      outputs[1].target_route_membership_proof_sha256 !==
        semanticRouteMembershipProofSha256(outputs[1]),
      "step 2 target route membership proof does not bind the route set",
    ],
    [outputs[2].route_sha256 !== targetRoute,
      "step 3 quote route does not equal target_route_sha256"],
    [
      outputs[2].selected_exact_quote_sha256 !==
        semanticExactQuoteCommitmentSha256(outputs[2]),
      "step 3 selected exact quote commitment does not bind quote output",
    ],
    [outputs[3].route_sha256 !== targetRoute,
      "step 4 plan route does not equal target_route_sha256"],
    [
      outputs[3].input_exact_quote_sha256 !==
        outputs[2].selected_exact_quote_sha256,
      "step 4 does not consume the selected step 3 exact quote",
    ],
    [
      outputs[4].input_resolved_plan_sha256 !== outputs[3].resolved_plan_sha256,
      "step 5 does not execute the resolved step 4 plan",
    ],
    [
      outputs[4].final_sim_sha256 !==
        semanticFinalSimCommitmentSha256(outputs[4]),
      "step 5 final sim commitment does not bind execution output",
    ],
    [outputs[5].input_final_sim_sha256 !== outputs[4].final_sim_sha256,
      "step 6 does not evaluate the step 5 final sim"],
  ] as const).find(([failed]) => failed)?.[1] ?? null;
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

export function semanticRouteMembershipProofSha256(
  output: Readonly<Record<string, SemanticJson>>,
): string {
  return semanticOutputCommitment(output, [
    "run_id",
    "state_anchor_sha256",
    "route_set_sha256",
    "target_route_sha256",
  ]);
}

export function semanticExactQuoteCommitmentSha256(
  output: Readonly<Record<string, SemanticJson>>,
): string {
  return semanticOutputCommitment(output, [
    "run_id",
    "state_anchor_sha256",
    "target_route_sha256",
    "source_block",
    "quote_status",
    "probe_amount_in",
    "quoted_amount_out",
    "leg_quotes",
  ]);
}

export function semanticFinalSimCommitmentSha256(
  output: Readonly<Record<string, SemanticJson>>,
): string {
  return semanticOutputCommitment(output, [
    "run_id",
    "state_anchor_sha256",
    "target_route_sha256",
    "input_resolved_plan_sha256",
    "success",
    "profit_token",
    "gross_profit",
    "net_profit",
    "gas_used",
    "calldata_sha256",
    "repayment_and_conservation",
    "leaves_standing_position",
  ]);
}

function semanticOutputCommitment(
  output: Readonly<Record<string, SemanticJson>>,
  keys: readonly string[],
): string {
  return semanticJsonSha256(
    Object.fromEntries(keys.map((key) => [key, output[key] ?? null])),
  );
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
    ["edge_set_size", isPositiveInteger, "a positive integer"],
    ["target_membership", isPresentMembership, "the string present"],
  ],
  2: [
    ["route_set_sha256", isSha256, "a lowercase SHA-256 digest"],
    ["route_set_size", isPositiveInteger, "a positive integer"],
    ["target_present", isTrue, "true"],
  ],
  3: [
    ["source_block", isBlockNumber, "a non-negative integer block number"],
    ["route_sha256", isSha256, "a lowercase SHA-256 digest"],
    ["quote_status", isAvailableQuoteStatus, "available or positive"],
    ["probe_amount_in", isPositiveDecimalString, "a positive decimal integer string"],
    ["quoted_amount_out", isPositiveDecimalString, "a positive decimal integer string"],
    ["leg_quotes", isNonEmptyJsonArray, "a non-empty JSON array"],
  ],
  4: [
    ["route_sha256", isSha256, "a lowercase SHA-256 digest"],
    ["selected_by_solve_policy", isTrue, "true"],
    ["solve_succeeded", isTrue, "true"],
    ["solver_selected_amount", isPositiveDecimalString, "a positive decimal integer string"],
    ["resolved_plan_sha256", isSha256, "a lowercase SHA-256 digest"],
    ["hop_amounts", isNonEmptyJsonArray, "a non-empty JSON array"],
  ],
  5: [
    ["success", isTrue, "true"],
    ["profit_token", isNonEmptyString, "a non-empty string"],
    ["gross_profit", isPositiveDecimalString, "a positive decimal integer string"],
    ["net_profit", isDecimalString, "a decimal integer string"],
    ["gas_used", isNonNegativeDecimalString, "a non-negative decimal integer string"],
    ["calldata_sha256", isSha256, "a lowercase SHA-256 digest"],
    [
      "repayment_and_conservation",
      isConservationResult,
      "true or the string pass",
    ],
    ["leaves_standing_position", isFalse, "false"],
  ],
  6: [
    ["execution_status", isPassExecutionStatus, "the string pass"],
    ["decision", isEvDecision, "allow or reject"],
    [
      "decision_reason",
      isStableDecisionReason,
      "a non-empty stable snake_case string",
    ],
    ["net_ev_wei", isDecimalString, "a signed decimal integer string"],
    ["gas_cost_eth", isDecimalNumberString, "a decimal number string"],
    ["bid_eth", isDecimalNumberString, "a decimal number string"],
    ["valuation_available", isTrue, "true"],
    ["gas_measurement_available", isTrue, "true"],
    ["fee_state_available", isTrue, "true"],
  ],
});

const CURRENT_PRODUCTION_COMMON_REQUIREMENTS:
  readonly OutputRequirement[] = Object.freeze([
    ["run_id", isSha256, "a lowercase SHA-256 digest"],
    ["state_anchor_sha256", isSha256, "a lowercase SHA-256 digest"],
    ["target_route_sha256", isSha256, "a lowercase SHA-256 digest"],
  ]);

const CURRENT_PRODUCTION_HASH_FIELDS = Object.freeze({
  1: [],
  2: ["target_route_membership_proof_sha256"],
  3: ["selected_exact_quote_sha256"],
  4: ["input_exact_quote_sha256"],
  5: ["input_resolved_plan_sha256", "final_sim_sha256"],
  6: ["input_final_sim_sha256"],
} satisfies Record<SemanticSixStepEvidence["step"], readonly string[]>);

const FAMILY_BYPASS_REQUIREMENTS: Readonly<
  Partial<Record<SemanticSixStepEvidence["step"], readonly OutputRequirement[]>>
> = Object.freeze({
  1: [
    ["mode", isRoutePinnedMode, "the string route_pinned"],
    ["state_anchor", isNonEmptyJsonObject, "a non-empty JSON object"],
    ["execution_family_id", isNonEmptyString, "a non-empty string"],
  ],
  2: [
    ["mode", isRoutePinnedMode, "the string route_pinned"],
    ["fixture_route_sha256", isSha256, "a lowercase SHA-256 digest"],
    ["route_leg_count", isPositiveInteger, "a positive integer"],
  ],
});

function validateStatusOutput(
  schemaVersion: number,
  profile: SemanticSixStepProfile,
  step: SemanticSixStepEvidence["step"],
  status: SemanticSixStepStatus,
  output: Readonly<Record<string, SemanticJson>>,
  reasonCode: string | null | undefined,
): string[] {
  if (status === "pass") {
    const requirements = schemaVersion === 1 && step === 6
      ? LEGACY_STEP_SIX_PASS_OUTPUT_REQUIREMENTS
      : PASS_OUTPUT_REQUIREMENTS[step];
    const errors = validateOutputRequirements(
      output,
      requirements,
      `${profile} step ${step} pass`,
    );
    if (
      schemaVersion === SEMANTIC_SIX_STEP_SCHEMA_VERSION &&
      profile === "production_route_stage"
    ) {
      errors.push(
        ...validateOutputRequirements(
          output,
          CURRENT_PRODUCTION_COMMON_REQUIREMENTS,
          `${profile} step ${step} pass`,
        ),
        ...validateOutputRequirements(
          output,
          CURRENT_PRODUCTION_HASH_FIELDS[step].map((key) =>
            [key, isSha256, "a lowercase SHA-256 digest"] as const
          ),
          `${profile} step ${step} pass`,
        ),
      );
      if (step === 1) {
        errors.push(...validateOutputRequirements(output, [
          ["materialized_graph", isMaterializedGraphEvidence,
            "all-materialized-edge evidence with no target injection or graph reduction"],
          ["shard_completeness", isSelectedShardCompletenessEvidence,
            "selected-route shard evidence with every required shard complete"],
        ], `${profile} step ${step} pass`));
      }
      if (
        step === 1 &&
        isSemanticJsonObject(output.materialized_graph) &&
        (
          output.edge_set_sha256 !== output.materialized_graph.sha256 ||
          output.edge_set_size !== output.materialized_graph.edge_count
        )
      ) {
        errors.push(
          "six-step production_route_stage step 1 edge-set aliases must bind materialized_graph",
        );
      }
      if (
        step === 1 &&
        isSemanticJsonObject(output.materialized_graph) &&
        isSemanticJsonObject(output.shard_completeness)
      ) {
        const bindingError = materializedGraphShardBindingError(
          output.materialized_graph,
          output.shard_completeness,
        );
        if (bindingError) errors.push(bindingError);
      }
    }
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
    const errors = validateOutputRequirements(
      output,
      FAMILY_BYPASS_REQUIREMENTS[step] ?? [],
      `family_execution step ${step} bypassed`,
    );
    if (reasonCode === null || reasonCode === undefined || reasonCode === "") {
      errors.push("six-step bypassed reason_code must be non-null");
    }
    return errors;
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

const LEGACY_STEP_SIX_PASS_OUTPUT_REQUIREMENTS:
  readonly OutputRequirement[] = Object.freeze([
    ["decision", isLegacyAllowDecision, "the string allow"],
    ["net_ev_wei", isPositiveDecimalString, "a positive decimal integer string"],
    ["gas_cost_eth", isDecimalNumberString, "a decimal number string"],
    ["bid_eth", isDecimalNumberString, "a decimal number string"],
    ["valuation_available", isTrue, "true"],
    ["gas_measurement_available", isTrue, "true"],
    ["fee_state_available", isTrue, "true"],
  ]);

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

function isTrue(value: SemanticJson): boolean {
  return value === true;
}

function isFalse(value: SemanticJson): boolean {
  return value === false;
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

function isPresentMembership(value: SemanticJson): boolean {
  return value === "present";
}

function isAvailableQuoteStatus(value: SemanticJson): boolean {
  return value === "available" || value === "positive";
}

function isPassExecutionStatus(value: SemanticJson): boolean {
  return value === "pass";
}

function isEvDecision(value: SemanticJson): boolean {
  return value === "allow" || value === "reject";
}

function isLegacyAllowDecision(value: SemanticJson): boolean {
  return value === "allow";
}

function isStableDecisionReason(value: SemanticJson): boolean {
  return typeof value === "string" &&
    /^[a-z][a-z0-9_]{0,95}$/.test(value);
}

function isRoutePinnedMode(value: SemanticJson): boolean {
  return value === "route_pinned";
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

function isMaterializedGraphEvidence(value: SemanticJson): boolean {
  if (!isSemanticJsonObject(value)) return false;
  const families = objectArray(value.family_edges);
  return value.scope === "all_materialized_edges" &&
    isPositiveInteger(value.edge_count) &&
    isSha256(value.sha256) &&
    value.target_injected === false &&
    value.graph_reduced === false &&
    value.cap_mode === "production_config" &&
    families.length > 0 &&
    uniqueStrings(families.map((family) => family.family_id)) !== null &&
    families.every((family) =>
      isNonEmptyString(family.family_id) &&
      isPositiveInteger(family.edge_count) &&
      isSha256(family.sha256)
    ) &&
    families.reduce((sum, family) => sum + Number(family.edge_count), 0) ===
      value.edge_count;
}

function isSelectedShardCompletenessEvidence(value: SemanticJson): boolean {
  if (!isSemanticJsonObject(value)) return false;
  const required = uniqueStrings(value.required_family_ids);
  const isolated = uniqueStrings(value.isolated_incomplete_family_ids);
  const families = objectArray(value.family_shards);
  const dex = value.dex_shard;
  const cache = value.cache_reuse;
  if (!isSemanticJsonObject(dex) || !isSemanticJsonObject(cache) ||
    required === null || isolated === null ||
    value.schema_version !== 1 || value.selection !== "selected" ||
    value.required_complete !== true ||
    dex.shard_id !== "dex-universe" || dex.source_kind !== "dex-universe" ||
    dex.status !== "complete" || dex.required !== true ||
    !isPositiveInteger(dex.edge_count) || !isSha256(dex.sha256) ||
    !Array.isArray(dex.issues) || dex.issues.length !== 0 ||
    cache.status !== "not_measured" || cache.claimed_hit !== false) {
    return false;
  }
  const byId = new Map<string, Readonly<Record<string, SemanticJson>>>();
  for (const family of families) {
    const id = family.family_id;
    if (typeof id !== "string" || id.length === 0 || byId.has(id) ||
      family.shard_id !== `family:${id}` ||
      !["complete", "incomplete"].includes(String(family.status)) ||
      typeof family.required !== "boolean" ||
      !isNonNegativeInteger(family.edge_count) || !isSha256(family.sha256) ||
      !Array.isArray(family.source_coverage) ||
      !Array.isArray(family.issues)) return false;
    byId.set(id, family);
  }
  const requiredSet = new Set(required);
  const isolatedSet = new Set(isolated);
  return required.every((id) => {
    const family = byId.get(id);
    return family?.required === true && family.status === "complete" &&
      family.disposition === "required" &&
      isPositiveInteger(family.edge_count);
  }) && isolated.every((id) => {
    const family = byId.get(id);
    return family?.required === false && family.status === "incomplete" &&
      family.disposition === "isolated_non_blocking";
  }) && [...byId].every(([id, family]) =>
    family.required === requiredSet.has(id) &&
    isolatedSet.has(id) === (family.disposition === "isolated_non_blocking") &&
    (requiredSet.has(id) ||
      family.disposition ===
        (family.status === "complete" ? "not_required" : "isolated_non_blocking"))
  );
}

function materializedGraphShardBindingError(
  materialized: Readonly<Record<string, SemanticJson>>,
  completeness: Readonly<Record<string, SemanticJson>>,
): string | null {
  const graphFamilies = keyedObjects(materialized.family_edges, "family_id");
  const shardFamilies = keyedObjects(completeness.family_shards, "family_id");
  if (!graphFamilies || !shardFamilies) return null;
  for (const [familyId, graph] of graphFamilies) {
    const shard = shardFamilies.get(familyId);
    if (!shard || shard.edge_count !== graph.edge_count ||
      shard.sha256 !== graph.sha256) {
      return `six-step step 1 shard ${familyId} does not bind materialized graph`;
    }
  }
  for (const [familyId, shard] of shardFamilies) {
    if (Number(shard.edge_count) > 0 && !graphFamilies.has(familyId)) {
      return `six-step step 1 shard ${familyId} claims unmaterialized edges`;
    }
  }
  return null;
}

function objectArray(
  value: SemanticJson | undefined,
): Readonly<Record<string, SemanticJson>>[] {
  return Array.isArray(value) && value.every(isSemanticJsonObject)
    ? value
    : [];
}

function uniqueStrings(value: SemanticJson | undefined): string[] | null {
  if (!Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.length > 0)) {
    return null;
  }
  const values = value as string[];
  return new Set(values).size === values.length ? values : null;
}

function keyedObjects(
  value: SemanticJson | undefined,
  key: string,
): Map<string, Readonly<Record<string, SemanticJson>>> | null {
  const entries = objectArray(value);
  const map = new Map<string, Readonly<Record<string, SemanticJson>>>();
  for (const entry of entries) {
    const id = entry[key];
    if (typeof id !== "string" || map.has(id)) return null;
    map.set(id, entry);
  }
  return map;
}
