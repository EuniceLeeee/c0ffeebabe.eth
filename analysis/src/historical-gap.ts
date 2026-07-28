import path from "node:path";

export type HistoricalChangeComponent =
  | "analysis-tool"
  | "classifier"
  | "gate"
  | "family-execution"
  | "adapter"
  | "venue-identity"
  | "graph"
  | "scanner"
  | "detector"
  | "planner"
  | "quote"
  | "execution"
  | "flow-admission"
  | "latency"
  | "candidate-ranking";

export type HistoricalValidationTrack =
  | "direct-main"
  | "family-execution"
  | "historical-replay"
  | "hermes-ab";
export type HistoricalStrategyKind = "block-scan" | "backrun";
export type HistoricalTriggerKind = "standing-state" | "victim-swap" | "oracle-update";
export type HistoricalRouteScope = "dex-dex" | "dex-permissionless-protocol";
export type HistoricalGatePhase = "classify" | "promote" | "close";
export type HistoricalAuditKind =
  | "git-ref"
  | "worktree"
  | "origin-main-reports"
  | "origin-main-resolutions"
  | "worktree-evidence";

export interface HistoricalGapSample {
  tx_hash: string;
  block_number: number;
  expected_net_profit_usd: number;
  strategy_kind: HistoricalStrategyKind;
  trigger_kind: HistoricalTriggerKind;
  route_scope: HistoricalRouteScope;
  position_conserving: boolean;
  victim_tx_hash?: string;
  evidence: string;
  candidate_report?: string;
  adapter_replay_fixture?: string;
  adapter_replay_fixture_sha256?: string;
  adapter_replay_evidence?: string;
  adapter_replay_evidence_sha256?: string;
  posture: {
    keeper: boolean;
    inventory: boolean;
    private_path: boolean;
    credit: boolean;
    sandwich: boolean;
    jit_lp: boolean;
  };
}

export interface HistoricalBranchAuditMatch {
  ref: string;
  kind: HistoricalAuditKind;
  fingerprint: string;
  disposition: "reusable" | "superseded" | "unrelated" | "unresolved";
  reused_commit?: string;
  evidence: string;
}

export interface HistoricalAuditInventoryEntry {
  ref: string;
  kind: HistoricalAuditKind;
  fingerprint: string;
}

export interface HistoricalAuditInventory {
  schema_version: 1;
  refs_sha256: string;
  refs: HistoricalAuditInventoryEntry[];
}

export interface HistoricalGapRecord {
  schema_version: 1;
  gap_id: string;
  branch: string;
  author: string;
  base_commit: string;
  challenger_commit: string;
  hypothesis: string;
  components: HistoricalChangeComponent[];
  branch_audit?: {
    origin_main_commit: string;
    refs_sha256: string;
    prepare_receipt_sha256: string;
    matches: HistoricalBranchAuditMatch[];
    outcome: "no_prior_fix" | "reuse_prior_fix" | "prior_fix_insufficient";
    evidence: string;
  };
  samples: HistoricalGapSample[];
  validation: {
    build: HistoricalCheck;
    tests: HistoricalCheck;
    toolchain_sha256: string;
    review: {
      reviewer: string;
      verdict: "pass" | "fail";
      live_distribution_verdict?: "none" | "requires_hermes";
      base_commit: string;
      challenger_commit: string;
      diff_sha256: string;
      artifact: string;
      artifact_sha256: string;
      reviewed_at: string;
      evidence: string;
    };
    replay_environment?: {
      universe_sha256: string;
      universe_provenance_artifact: string;
      universe_provenance_sha256: string;
      pool_universe_top_n: number;
    };
    smoke?: {
      mode: "trusted-local-dry-run";
      duration_seconds: number;
    };
  };
  decision: {
    status: "promote" | "route_to_hermes" | "implemented_not_validated" | "reject" | "closed";
    claim: "fixed" | "implemented_not_validated";
    branch_action: "pending_merge" | "retained" | "merged_deleted" | "not_applicable";
    evidence: string;
    merge_commit?: string;
    promotion_artifact_commit?: string;
    promotion_receipt_sha256?: string;
  };
}

export const HISTORICAL_PRODUCTION_INSTANCE_ID = "i-0ff908dedeec9ebc6";

export interface HistoricalProductionUniverseAttestation {
  schema_version: 1;
  kind: "production-pool-universe";
  instance_id: string;
  runtime_commit: string;
  universe_path: string;
  universe_sha256: string;
  pool_universe_top_n: number;
  observed_at: string;
  command_id: string;
}

export interface HistoricalUniverseProvenance {
  schema_version: 1;
  kind: "production-pool-universe";
  instance_id: string;
  runtime_commit: string;
  source_path: string;
  universe_sha256: string;
  pool_universe_top_n: number;
  captured_at: string;
}

export interface HistoricalCheck {
  exit_code: number;
  evidence: string;
}

export interface HistoricalSmokePlan {
  mode: "trusted-local-dry-run";
  duration_seconds: number;
}

const DIRECT_MAIN_COMPONENTS = new Set<HistoricalChangeComponent>([
  "analysis-tool", "classifier", "gate",
]);
const FAMILY_EXECUTION_COMPONENTS = new Set<HistoricalChangeComponent>([
  "family-execution",
]);
const HISTORICAL_REPLAY_COMPONENTS = new Set<HistoricalChangeComponent>([
  "adapter", "venue-identity", "graph", "detector", "planner", "quote", "execution",
]);
const HERMES_COMPONENTS = new Set<HistoricalChangeComponent>([
  // Scanner changes alter cross-opportunity admission/cardinality. A single pinned transaction cannot
  // prove their live distribution, so they belong to cohort-based Hermes A/B rather than route replay.
  "scanner", "flow-admission", "latency", "candidate-ranking",
]);
const SHA40_RE = /^[a-f0-9]{40}$/i;
const SHA64_RE = /^[a-f0-9]{64}$/i;
const TX_RE = /^0x[a-f0-9]{64}$/i;
const GAP_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
const AB_BRANCH_RE = /^ab\/[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
const HISTORICAL_REPORTS_ROOT = "docs/research/reports/";
const DIRECT_MAIN_TRUSTED_REPLAY_GATES = new Set([
  "listener/src/searcher/test/blockscan-hunt.ts",
  "listener/src/searcher/test/backrun-hunt.ts",
]);

export function normalizeHistoricalReportArtifactPath(
  value: string,
  allowedExtensions: readonly string[] = [".md", ".json"],
): string | null {
  if (!value?.trim() || path.posix.isAbsolute(value) || value.includes("\\")) return null;
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  const normalized = path.posix.normalize(value);
  if (normalized !== value || !normalized.startsWith(HISTORICAL_REPORTS_ROOT)) return null;
  if (!allowedExtensions.some((extension) => normalized.endsWith(extension))) return null;
  return normalized;
}

export function historicalValidationTrack(components: HistoricalChangeComponent[]): HistoricalValidationTrack | null {
  const tracks = new Set<HistoricalValidationTrack>();
  for (const component of components) {
    if (DIRECT_MAIN_COMPONENTS.has(component)) tracks.add("direct-main");
    else if (FAMILY_EXECUTION_COMPONENTS.has(component)) tracks.add("family-execution");
    else if (HISTORICAL_REPLAY_COMPONENTS.has(component)) tracks.add("historical-replay");
    else if (HERMES_COMPONENTS.has(component)) tracks.add("hermes-ab");
    else return null;
  }
  return tracks.size === 1 ? [...tracks][0] : null;
}

export function parseHistoricalGap(md: string): HistoricalGapRecord {
  const match = md.match(/```historical_gap\s*\n([\s\S]*?)\n```/);
  if (!match) throw new Error("missing ```historical_gap JSON block");
  try {
    return JSON.parse(match[1]) as HistoricalGapRecord;
  } catch (error) {
    throw new Error(`invalid historical_gap JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateHistoricalGap(
  record: HistoricalGapRecord,
  phase: HistoricalGatePhase,
): string[] {
  const errors: string[] = [];
  if (!record || typeof record !== "object") return ["historical_gap must be an object"];
  if (record.schema_version !== 1) errors.push("schema_version must be 1");
  if ((record as HistoricalGapRecord & { evidence_commit?: unknown }).evidence_commit !== undefined) {
    errors.push("historical_gap must not contain evidence_commit; bind the report externally with --artifact-ref");
  }
  if (!GAP_RE.test(record.gap_id ?? "")) errors.push("gap_id must be a stable non-placeholder identifier");
  if (!nonEmpty(record.author)) errors.push("author is required");
  if (!nonEmpty(record.hypothesis)) errors.push("hypothesis is required");
  if (!SHA40_RE.test(record.base_commit ?? "")) errors.push("base_commit must be a full SHA");
  if (!SHA40_RE.test(record.challenger_commit ?? "")) errors.push("challenger_commit must be a full SHA");
  if (!Array.isArray(record.components) || record.components.length === 0) {
    errors.push("components must contain at least one change component");
  }
  const track = historicalValidationTrack(record.components ?? []);
  if (track === null) {
    errors.push(
      "one historical record may contain only one validation track: "
        + "direct-main, family-execution, historical-replay, or hermes-ab",
    );
  }

  if (track !== "direct-main" && (!record.branch_audit || typeof record.branch_audit !== "object")) {
    errors.push("branch_audit is required before creating a new searcher gap branch");
  } else if (record.branch_audit) {
    if (record.branch_audit.origin_main_commit !== record.base_commit) {
      errors.push("branch_audit.origin_main_commit must equal base_commit");
    }
    if (!SHA64_RE.test(record.branch_audit.refs_sha256 ?? "")) {
      errors.push("branch_audit.refs_sha256 must be a SHA-256 digest");
    }
    if (!SHA64_RE.test(record.branch_audit.prepare_receipt_sha256 ?? "")) {
      errors.push("branch_audit.prepare_receipt_sha256 must bind the trusted pre-branch inventory receipt");
    }
    if (!isAuditOutcome(record.branch_audit.outcome)) {
      errors.push("branch_audit.outcome must be no_prior_fix|reuse_prior_fix|prior_fix_insufficient");
    }
    if (!nonEmpty(record.branch_audit.evidence)) errors.push("branch_audit.evidence is required");
    if (!Array.isArray(record.branch_audit.matches)) errors.push("branch_audit.matches must be an array");
    for (const [index, match] of (record.branch_audit.matches ?? []).entries()) {
      if (!nonEmpty(match.ref) || !isAuditKind(match.kind) || !SHA64_RE.test(match.fingerprint ?? "")
          || !isAuditDisposition(match.disposition) || !nonEmpty(match.evidence)) {
        errors.push(
          `branch_audit.matches[${index}] requires ref, kind, SHA-256 fingerprint, `
            + "disposition reusable|superseded|unrelated|unresolved, and evidence",
        );
      }
      if (match.disposition === "reusable" && !SHA40_RE.test(match.reused_commit ?? "")) {
        errors.push(`branch_audit.matches[${index}].reusable requires reused_commit`);
      }
      if (match.disposition !== "reusable" && match.reused_commit !== undefined) {
        errors.push(`branch_audit.matches[${index}].reused_commit is valid only for reusable prior work`);
      }
    }
  }

  if (track === "direct-main") {
    if (record.branch.startsWith("ab/")) errors.push("analysis/classifier/gate work must not occupy an ab/* challenger branch");
  } else if (track !== null && !AB_BRANCH_RE.test(record.branch ?? "")) {
    errors.push("searcher behavior work must use a literal ab/* branch for lifecycle enforcement");
  }

  if ((track === "family-execution" || track === "historical-replay")
      && (!Array.isArray(record.samples) || record.samples.length === 0)) {
    errors.push(`${track} requires at least one real +EV historical sample`);
  }
  for (const [index, sample] of (record.samples ?? []).entries()) {
    errors.push(...validateSample(sample).map((error) => `samples[${index}]: ${error}`));
    if (track === "family-execution") {
      errors.push(...validateFamilyExecutionSample(sample)
        .map((error) => `samples[${index}]: ${error}`));
    }
  }

  if (phase !== "classify") {
    if (record.validation?.build?.exit_code !== 0 || !nonEmpty(record.validation?.build?.evidence)) {
      errors.push("promotion requires a successful build with evidence");
    }
    if (record.validation?.tests?.exit_code !== 0 || !nonEmpty(record.validation?.tests?.evidence)) {
      errors.push("promotion requires successful tests with evidence");
    }
    if (!SHA64_RE.test(record.validation?.toolchain_sha256 ?? "")) {
      errors.push("promotion requires the independently reviewed toolchain SHA-256");
    }
    const review = record.validation?.review;
    if (!review || review.verdict !== "pass" || !nonEmpty(review.reviewer) || !nonEmpty(review.evidence)) {
      errors.push("promotion requires a passing fresh non-author review");
    } else if (review.reviewer.trim().toLowerCase() === record.author.trim().toLowerCase()) {
      errors.push("reviewer must differ from author");
    }
    if (review?.base_commit !== record.base_commit || review?.challenger_commit !== record.challenger_commit
        || !SHA64_RE.test(review?.diff_sha256 ?? "")) {
      errors.push("fresh review must bind the exact base_commit, challenger_commit, and diff_sha256");
    }
    if (!normalizeHistoricalReportArtifactPath(review?.artifact ?? "") || !SHA64_RE.test(review?.artifact_sha256 ?? "")
        || !validIsoDate(review?.reviewed_at)) {
      errors.push("fresh review requires a committed report artifact, SHA-256, and reviewed_at timestamp");
    }
    if ((track === "family-execution" || track === "historical-replay")
        && review?.live_distribution_verdict !== "none") {
      errors.push(`${track} requires the fresh reviewer to attest no cross-opportunity live-distribution change`);
    }
    if (track === "historical-replay") {
      const environment = record.validation?.replay_environment;
      if (!environment || !SHA64_RE.test(environment.universe_sha256 ?? "")
          || !normalizeHistoricalReportArtifactPath(environment.universe_provenance_artifact ?? "", [".json"])
          || !SHA64_RE.test(environment.universe_provenance_sha256 ?? "")
          || !Number.isSafeInteger(environment.pool_universe_top_n)
          || environment.pool_universe_top_n <= 0) {
        errors.push("historical replay requires a hash-bound production universe provenance artifact and top-N");
      }
    }
  }

  if (phase === "promote") {
    if (track === "direct-main") {
      requireDecision(record, errors, "promote", "fixed", "pending_merge");
    } else if (track === "family-execution") {
      requireDecision(record, errors, "promote", "fixed", "pending_merge");
    } else if (track === "historical-replay") {
      if (!record.validation?.smoke) errors.push("deterministic searcher promotion requires a trusted short-smoke plan");
      else errors.push(...validateHistoricalSmokePlan(record.validation.smoke));
      for (const [index, sample] of record.samples.entries()) {
        if (!normalizeHistoricalReportArtifactPath(sample.candidate_report ?? "", [".md"])) {
          errors.push(`samples[${index}].candidate_report must be a committed docs/research/reports/*.md path`);
        }
      }
      requireDecision(record, errors, "promote", "fixed", "pending_merge");
    } else if (track === "hermes-ab") {
      requireDecision(record, errors, "route_to_hermes", "implemented_not_validated", "retained");
    }
  }

  if (phase === "close") {
    if (track === "hermes-ab") {
      errors.push("live-distribution changes close through the Hermes A/B gate, not historical-gap-gate");
    } else {
      requireDecision(record, errors, "closed", "fixed", "merged_deleted");
      if (!SHA40_RE.test(record.decision?.merge_commit ?? "")) errors.push("close requires decision.merge_commit");
      if (!SHA40_RE.test(record.decision?.promotion_artifact_commit ?? "")
          || !SHA64_RE.test(record.decision?.promotion_receipt_sha256 ?? "")) {
        errors.push("close requires the exact promotion artifact commit and trusted promotion receipt SHA-256");
      }
    }
  }
  return errors;
}

export function validateHistoricalSmokePlan(plan: HistoricalSmokePlan): string[] {
  const errors: string[] = [];
  if (!plan || typeof plan !== "object") return ["smoke plan must be an object"];
  if (plan.mode !== "trusted-local-dry-run") errors.push("smoke must use the trusted local dry-run runner");
  if (!Number.isSafeInteger(plan.duration_seconds) || plan.duration_seconds < 600) {
    errors.push("smoke must cover at least 600 seconds");
  }
  return errors;
}

export function validateHistoricalSmokeOutput(
  output: string,
  actualSeconds: number,
  requestedSeconds: number,
): string[] {
  const errors: string[] = [];
  if (actualSeconds < requestedSeconds) errors.push("smoke did not cover the full requested wall-clock duration");
  if (/\b(?:fatal|uncaught exception|unhandled rejection)\b/i.test(output)) {
    errors.push("smoke contains a fatal process error");
  }
  return errors;
}

export function validateHistoricalArtifactCommit(
  available: boolean,
  descendsFromChallenger: boolean,
  changedFiles: string[],
): string[] {
  const errors: string[] = [];
  if (!available) errors.push("artifact_ref is not available locally");
  if (available && !descendsFromChallenger) errors.push("artifact_ref must descend from challenger_commit");
  const invalid = changedFiles.filter((file) => !file.startsWith("docs/research/reports/"));
  if (invalid.length > 0) errors.push(`artifact_ref may change reports only: ${invalid.join(",")}`);
  return errors;
}

export function resolveHistoricalReportArtifactPath(
  reportPath: string,
  artifactPath: string,
): string | null {
  if (!normalizeHistoricalReportArtifactPath(reportPath, [".md"])
      || !artifactPath?.trim()
      || path.posix.isAbsolute(artifactPath)
      || artifactPath.includes("\\")) return null;
  const segments = artifactPath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(reportPath), artifactPath));
  return normalizeHistoricalReportArtifactPath(resolved, [".json"]);
}

export function isHistoricalCandidateWorktree(
  worktree: { branch: string; head: string },
  branch: string,
  challengerCommit: string,
  artifactCommit: string,
  descendantOutsideMain = false,
): boolean {
  return worktree.branch === `refs/heads/${branch}`
    || worktree.head === challengerCommit
    || worktree.head === artifactCommit
    || descendantOutsideMain;
}

export function validateHistoricalReplayRootEntries(entries: string[]): string[] {
  return entries.includes(".env")
    ? ["replay worktree root must not contain .env; trusted replay owns the complete environment"]
    : [];
}

export function validateHistoricalMergeTree(mergeTree: string, challengerTree: string): string[] {
  return mergeTree === challengerTree
    ? []
    : ["merge_commit tree must exactly equal the frozen challenger tree"];
}

export function trustedSsmTunnelReady(output: string, localPort: number): boolean {
  if (!Number.isSafeInteger(localPort) || localPort <= 0 || localPort > 65_535) return false;
  const escapedPort = String(localPort).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`Port\\s+${escapedPort}\\s+opened\\s+for\\s+sessionId`, "i").test(output)
    && /Waiting\s+for\s+connections/i.test(output);
}

export function validateDirectMainPackageManifest(baseSource: string, challengerSource: string): string[] {
  let base: Record<string, unknown>;
  let challenger: Record<string, unknown>;
  try {
    base = JSON.parse(baseSource) as Record<string, unknown>;
    challenger = JSON.parse(challengerSource) as Record<string, unknown>;
  } catch {
    return ["direct-main analysis/package.json must remain valid JSON"];
  }
  const baseWithoutScripts = { ...base, scripts: undefined };
  const challengerWithoutScripts = { ...challenger, scripts: undefined };
  if (canonicalJson(baseWithoutScripts) !== canonicalJson(challengerWithoutScripts)) {
    return ["direct-main analysis/package.json may change scripts only; dependencies and package metadata require normal review outside this gate"];
  }
  const baseScripts = base.scripts;
  const scripts = challenger.scripts;
  if (!baseScripts || typeof baseScripts !== "object" || Array.isArray(baseScripts)
      || !scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    return ["direct-main analysis/package.json scripts must remain an object"];
  }
  for (const [name, command] of Object.entries(baseScripts as Record<string, unknown>)) {
    if ((scripts as Record<string, unknown>)[name] !== command) {
      return [`direct-main analysis/package.json may add scripts but must not modify or remove existing script ${name}`];
    }
  }
  const forbiddenLifecycle = new Set([
    "preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishonly", "publish", "postpublish",
  ]);
  for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9:_-]+$/.test(name) || forbiddenLifecycle.has(name.toLowerCase())) {
      return [`direct-main analysis/package.json contains forbidden lifecycle or malformed script ${name}`];
    }
    if (typeof command !== "string" || command.trim().length === 0) {
      return [`direct-main analysis/package.json script ${name} must be a non-empty string`];
    }
  }
  return [];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function validateHistoricalDiffScope(
  changed: string[],
  track: HistoricalValidationTrack,
  patch = "",
): string[] {
  const errors: string[] = [];
  if (changed.length === 0) return ["base..challenger diff is empty"];
  const productionFiles = changed.filter(isApprovedProductionRuntimeFile);
  if (track === "direct-main") {
    if (productionFiles.length > 0) {
      errors.push(`direct-main tooling track modifies production searcher files: ${productionFiles.join(",")}`);
    }
    const outsideTooling = changed.filter((file) => !isDirectMainToolingFile(file));
    if (outsideTooling.length > 0) {
      errors.push(`direct-main tooling track contains non-tooling changes: ${outsideTooling.join(",")}`);
    }
    if (!changed.some(isDirectMainToolingImplementationFile)) {
      errors.push("direct-main tooling track requires an analysis/tool/classifier/gate implementation change; docs/tests alone cannot promote");
    }
    errors.push(...directMainTestPairErrors(changed));
  } else {
    if (productionFiles.length === 0) {
      errors.push("searcher behavior track must modify at least one production searcher file");
    }
    const unapproved = changed.filter((file) => !isApprovedProductionRuntimeFile(file));
    if (unapproved.length > 0) {
      errors.push(`searcher challenger contains non-runtime, test, fixture, dependency, or runner changes: ${unapproved.join(",")}`);
    }
    if (track === "family-execution") {
      const outsideFamily = changed.filter((file) => !isFamilyExecutionFile(file));
      if (outsideFamily.length > 0) {
        errors.push(
          "family execution may modify only family-owned implementations and thin production registration: "
            + outsideFamily.join(","),
        );
      }
      if (!changed.some(isFamilyExecutionOwnedImplementationFile)) {
        errors.push(
          "family execution requires a family-owned implementation change; "
            + "registry-only graph expansion cannot use this track",
        );
      }
    } else if (track === "historical-replay") {
      const ambiguous = changed.filter((file) => !isHistoricalReplayDeterministicFile(file));
      if (ambiguous.length > 0) {
        errors.push(
          "historical replay may modify deterministic-only runtime owners; mixed/live owners route to Hermes A/B: "
            + ambiguous.join(","),
        );
      }
      const liveSensitive = inferLiveSensitiveDiff(changed, patch);
      if (liveSensitive.length > 0) {
        errors.push(`historical replay cannot promote live-distribution behavior; route to Hermes A/B: ${liveSensitive.join(";")}`);
      }
    }
  }
  return errors;
}

export function inferLiveSensitiveDiff(changed: string[], patch: string): string[] {
  const reasons = new Set<string>();
  for (const file of changed) {
    if (ALWAYS_LIVE_DISTRIBUTION_FILES.has(file)
        || ALWAYS_LIVE_DISTRIBUTION_PREFIXES.some((prefix) => file.startsWith(prefix))) {
      reasons.add(`live-path:${file}`);
    }
  }
  const semanticLines = patch.split(/\r?\n/)
    .filter((line) => (/^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line)))
    .map((line) => line.slice(1));
  for (const line of semanticLines) {
    const token = LIVE_DISTRIBUTION_TOKENS.find((entry) => entry.re.test(line));
    if (token) reasons.add(`live-token:${token.name}`);
  }
  return [...reasons].sort();
}

export function validateHistoricalBranchAuditCoverage(
  audit: NonNullable<HistoricalGapRecord["branch_audit"]>,
  inventory: HistoricalAuditInventory,
  sameGapRefs: string[],
  runtimeOverlapRefs: string[] = [],
): string[] {
  const errors: string[] = [];
  if (inventory.refs_sha256 !== audit.refs_sha256) {
    errors.push("branch audit is stale: current prior-ref inventory hash differs");
  }
  const reported = new Map<string, HistoricalBranchAuditMatch>();
  for (const match of audit.matches) {
    if (!isAuditDisposition(match.disposition)) {
      errors.push(`branch audit has invalid disposition for ${match.ref}`);
    }
    if (match.disposition === "reusable" && !SHA40_RE.test(match.reused_commit ?? "")) {
      errors.push(`branch audit reusable source ${match.ref} requires reused_commit`);
    }
    if (reported.has(match.ref)) errors.push(`branch audit duplicates inventory ref ${match.ref}`);
    reported.set(match.ref, match);
  }
  const current = new Map(inventory.refs.map((entry) => [entry.ref, entry]));
  for (const entry of inventory.refs) {
    const match = reported.get(entry.ref);
    if (!match) errors.push(`branch audit omitted inventory ref ${entry.ref}`);
    else if (match.kind !== entry.kind || match.fingerprint !== entry.fingerprint) {
      errors.push(`branch audit fingerprint drift for ${entry.ref}`);
    }
  }
  for (const ref of reported.keys()) {
    if (!current.has(ref)) errors.push(`branch audit contains stale or unknown ref ${ref}`);
  }
  for (const match of audit.matches.filter((entry) => entry.disposition === "unresolved")) {
    errors.push(`branch audit must resolve every inventoried source before branching: ${match.ref}`);
  }
  for (const ref of sameGapRefs) {
    const match = reported.get(ref);
    if (!match || match.disposition === "unrelated" || match.disposition === "unresolved") {
      errors.push(`branch audit must reuse or explicitly supersede prior same-gap evidence ${ref}`);
    }
  }
  for (const ref of runtimeOverlapRefs) {
    const match = reported.get(ref);
    if (!match || match.disposition === "unrelated" || match.disposition === "unresolved") {
      errors.push(`branch audit must reuse or explicitly supersede prior runtime-overlap work ${ref}`);
    }
  }
  const reusable = audit.matches.filter((match) => match.disposition === "reusable");
  const insufficient = audit.matches.filter((match) => match.disposition === "superseded");
  if (audit.outcome === "reuse_prior_fix" && reusable.length === 0) {
    errors.push("reuse_prior_fix requires a reusable prior branch match");
  }
  if (audit.outcome === "no_prior_fix" && audit.matches.some((match) => match.disposition !== "unrelated")) {
    errors.push("no_prior_fix requires every inventoried source to be adjudicated unrelated");
  }
  if (audit.outcome === "prior_fix_insufficient" && insufficient.length === 0) {
    errors.push("prior_fix_insufficient requires an explicitly superseded prior source");
  }
  return errors;
}

export function validateHistoricalUniverseBinding(
  baseCommit: string,
  declared: NonNullable<HistoricalGapRecord["validation"]["replay_environment"]>,
  provenance: HistoricalUniverseProvenance,
  attestation: HistoricalProductionUniverseAttestation,
  localUniverseSha256: string,
): string[] {
  const errors: string[] = [];
  const expectedPath = `/opt/MEV-runtime/universe/active-pools-${localUniverseSha256}.json`;
  if (attestation.schema_version !== 1 || attestation.kind !== "production-pool-universe"
      || attestation.instance_id !== HISTORICAL_PRODUCTION_INSTANCE_ID) {
    errors.push("production universe attestation has the wrong trusted node identity");
  }
  if (attestation.runtime_commit !== baseCommit) {
    errors.push("production champion runtime commit does not equal the tested base");
  }
  if (attestation.universe_sha256 !== localUniverseSha256
      || declared.universe_sha256 !== localUniverseSha256
      || attestation.universe_path !== expectedPath) {
    errors.push("local replay universe is not the champion's content-addressed runtime universe");
  }
  if (!Number.isSafeInteger(attestation.pool_universe_top_n)
      || attestation.pool_universe_top_n <= 0
      || declared.pool_universe_top_n !== attestation.pool_universe_top_n) {
    errors.push("replay top-N does not equal the champion runtime top-N");
  }
  if (!validIsoDate(attestation.observed_at) || !nonEmpty(attestation.command_id)) {
    errors.push("production universe attestation lacks fresh SSM observation evidence");
  }
  if (provenance.schema_version !== 1 || provenance.kind !== "production-pool-universe"
      || provenance.instance_id !== attestation.instance_id
      || provenance.runtime_commit !== attestation.runtime_commit
      || provenance.source_path !== attestation.universe_path
      || provenance.universe_sha256 !== attestation.universe_sha256
      || provenance.pool_universe_top_n !== attestation.pool_universe_top_n
      || !validIsoDate(provenance.captured_at)) {
    errors.push("committed universe provenance does not match the live champion attestation");
  }
  return errors;
}

function validateSample(sample: HistoricalGapSample): string[] {
  const errors: string[] = [];
  if (!TX_RE.test(sample?.tx_hash ?? "")) errors.push("tx_hash must be a full transaction hash");
  if (!Number.isSafeInteger(sample?.block_number) || sample.block_number <= 0) errors.push("block_number must be positive");
  if (!Number.isFinite(sample?.expected_net_profit_usd) || sample.expected_net_profit_usd <= 0) {
    errors.push("expected_net_profit_usd must be > 0");
  }
  if (sample?.strategy_kind !== "block-scan" && sample?.strategy_kind !== "backrun") {
    errors.push("strategy_kind must be block-scan|backrun");
  }
  if (sample?.strategy_kind === "block-scan" && sample.trigger_kind !== "standing-state") {
    errors.push("block-scan requires standing-state trigger");
  }
  if (sample?.strategy_kind === "backrun") {
    if (sample.trigger_kind !== "victim-swap" && sample.trigger_kind !== "oracle-update") {
      errors.push("backrun requires victim-swap|oracle-update trigger");
    }
    if (!TX_RE.test(sample.victim_tx_hash ?? "")) errors.push("backrun requires victim_tx_hash");
  }
  if (sample?.route_scope !== "dex-dex" && sample?.route_scope !== "dex-permissionless-protocol") {
    errors.push("route_scope must be dex-dex|dex-permissionless-protocol");
  }
  if (sample?.position_conserving !== true) errors.push("sample must be position-conserving");
  for (const key of ["keeper", "inventory", "private_path", "credit", "sandwich", "jit_lp"] as const) {
    if (sample?.posture?.[key] !== false) errors.push(`posture.${key} must be false`);
  }
  if (!nonEmpty(sample?.evidence)) errors.push("evidence is required");
  return errors;
}

function validateFamilyExecutionSample(sample: HistoricalGapSample): string[] {
  const errors: string[] = [];
  if (!normalizeHistoricalReportArtifactPath(sample?.adapter_replay_fixture ?? "", [".json"])) {
    errors.push("adapter_replay_fixture must be a committed docs/research/reports/*.json path");
  }
  if (!SHA64_RE.test(sample?.adapter_replay_fixture_sha256 ?? "")) {
    errors.push("adapter_replay_fixture_sha256 must bind the exact fixture bytes");
  }
  if (!normalizeHistoricalReportArtifactPath(sample?.adapter_replay_evidence ?? "", [".md", ".json"])) {
    errors.push("adapter_replay_evidence must be a committed docs/research/reports/*.md|*.json path");
  }
  if (!SHA64_RE.test(sample?.adapter_replay_evidence_sha256 ?? "")) {
    errors.push("adapter_replay_evidence_sha256 must bind the exact landed evidence bytes");
  }
  return errors;
}

function requireDecision(
  record: HistoricalGapRecord,
  errors: string[],
  status: HistoricalGapRecord["decision"]["status"],
  claim: HistoricalGapRecord["decision"]["claim"],
  branchAction: HistoricalGapRecord["decision"]["branch_action"],
): void {
  if (record.decision?.status !== status) errors.push(`decision.status must be ${status}`);
  if (record.decision?.claim !== claim) errors.push(`decision.claim must be ${claim}`);
  if (record.decision?.branch_action !== branchAction) errors.push(`decision.branch_action must be ${branchAction}`);
  if (!nonEmpty(record.decision?.evidence)) errors.push("decision.evidence is required");
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/[<>]/.test(value);
}

function validIsoDate(value: unknown): boolean {
  return typeof value === "string" && value.includes("T") && Number.isFinite(Date.parse(value));
}

function isAuditKind(value: unknown): value is HistoricalAuditKind {
  return value === "git-ref" || value === "worktree" || value === "origin-main-reports"
    || value === "origin-main-resolutions" || value === "worktree-evidence";
}

function isAuditDisposition(value: unknown): value is HistoricalBranchAuditMatch["disposition"] {
  return value === "reusable" || value === "superseded" || value === "unrelated" || value === "unresolved";
}

function isAuditOutcome(value: unknown): value is NonNullable<HistoricalGapRecord["branch_audit"]>["outcome"] {
  return value === "no_prior_fix" || value === "reuse_prior_fix" || value === "prior_fix_insufficient";
}

function isApprovedProductionRuntimeFile(file: string): boolean {
  if (!file.endsWith(".ts")) return false;
  const normalized = file.toLowerCase();
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (/(?:^|\/)(?:node_modules|dependenc(?:y|ies)|fixtures?|tests?|__tests__|mocks?|stubs?)(?:\/|$)/.test(normalized)
      || /(?:^|[-_.])(?:fixture|test|runner|harness|mock|stub|helper)(?:[-_.]|$)/.test(basename)
      || /(?:^|\/)(?:package(?:-lock)?\.json|tsconfig(?:\.[^/]*)?\.json)(?:\/|$)/.test(normalized)) {
    return false;
  }
  if (/\.(test|spec)\.[cm]?[jt]s$/.test(normalized)) return false;
  if (file === "listener/package.json" || file === "listener/package-lock.json"
      || file === "listener/tsconfig.json" || file.startsWith("listener/revm-sim/")) return false;
  if (file.startsWith("listener/src/shared/state/")) return false;
  return file.startsWith("listener/src/searcher/")
    || file.startsWith("listener/src/shared/")
    || file.startsWith("listener/src/adapters/")
    || file === "listener/src/submitter.ts"
    || file === "listener/src/compiler.ts"
    || file === "listener/src/encoder.ts"
    || file === "listener/src/types.ts";
}

function isDirectMainToolingFile(file: string): boolean {
  if (DIRECT_MAIN_TRUSTED_REPLAY_GATES.has(file)) return true;
  if (file === "analysis/package.json") return true;
  if (file.startsWith(HISTORICAL_REPORTS_ROOT)) return true;
  if (!file.startsWith("analysis/src/") || isAnalysisFixtureOrDependency(file)) return false;
  return true;
}

function isDirectMainToolingImplementationFile(file: string): boolean {
  if (DIRECT_MAIN_TRUSTED_REPLAY_GATES.has(file)) return true;
  if (isAnalysisTest(file) || isAnalysisFixtureOrDependency(file)) return false;
  return file.startsWith("analysis/src/");
}

function isAnalysisTest(file: string): boolean {
  return file.startsWith("analysis/src/test/") || file.startsWith("analysis/src/tests/")
    || /\.(?:test|spec)\.[cm]?[jt]s$/.test(file);
}

function isAnalysisFixtureOrDependency(file: string): boolean {
  const normalized = file.toLowerCase();
  return /\/(?:fixtures?|__fixtures__|mocks?|stubs?|dependencies|node_modules)\//.test(normalized)
    || /(?:^|[-_.])(?:fixture|mock|stub|dependency)(?:[-_.]|$)/.test(path.posix.basename(normalized))
    || normalized.endsWith("package-lock.json")
    || /\/tsconfig(?:\.[^/]*)?\.json$/.test(normalized);
}

function directMainTestPairErrors(changed: string[]): string[] {
  const implementationBasenames = new Set(changed
    .filter(isDirectMainToolingImplementationFile)
    .filter((file) => file.startsWith("analysis/src/"))
    .map((file) => path.posix.basename(file)));
  return changed.filter(isAnalysisTest).flatMap((file) => {
    const testBasename = path.posix.basename(file).replace(/\.(?:test|spec)(?=\.[cm]?[jt]s$)/, "");
    return implementationBasenames.has(testBasename)
      ? []
      : [`direct-main analysis test has no same-named implementation change: ${file}`];
  });
}

const FAMILY_EXECUTION_REGISTRATION_FILES = new Set([
  "listener/src/adapters/index.ts",
  "listener/src/searcher/venues/production-registry.ts",
]);

const FAMILY_EXECUTION_SHARED_FILES = new Set([
  "listener/src/adapters/assert-balance.ts",
  "listener/src/adapters/erc20.ts",
  "listener/src/adapters/protocol-legs.ts",
  "listener/src/adapters/wrap.ts",
  "listener/src/searcher/venues/funding/flash-loan-framework.ts",
  "listener/src/searcher/venues/funding/funding-capability.ts",
  "listener/src/searcher/venues/protocols/protocol-plan.ts",
  "listener/src/searcher/venues/protocols/protocol-quote.ts",
  "listener/src/searcher/venues/protocols/protocol-state-framework.ts",
  "listener/src/searcher/venues/protocols/receipt-deposit-framework.ts",
  "listener/src/searcher/venues/swaps/adaptive-view-quote-blockscan-state.ts",
  "listener/src/searcher/venues/swaps/blockscan-state-shared.ts",
  "listener/src/searcher/venues/swaps/view-quote-blockscan-state.ts",
]);

const FAMILY_EXECUTION_OWNED_PREFIXES = [
  "listener/src/adapters/",
  "listener/src/searcher/venues/credit/",
  "listener/src/searcher/venues/funding/",
  "listener/src/searcher/venues/liquidity/",
  "listener/src/searcher/venues/protocols/",
  "listener/src/searcher/venues/swaps/",
];

function isFamilyExecutionOwnedImplementationFile(file: string): boolean {
  if (!file.endsWith(".ts")
      || FAMILY_EXECUTION_REGISTRATION_FILES.has(file)
      || FAMILY_EXECUTION_SHARED_FILES.has(file)
      || file.endsWith("-discovery.ts")) return false;
  if (file === "listener/src/adapters/registry.ts"
      || file === "listener/src/adapters/adapter-descriptors.ts") return false;
  return FAMILY_EXECUTION_OWNED_PREFIXES.some((prefix) => file.startsWith(prefix));
}

function isFamilyExecutionFile(file: string): boolean {
  return FAMILY_EXECUTION_REGISTRATION_FILES.has(file)
    || isFamilyExecutionOwnedImplementationFile(file);
}

const ALWAYS_LIVE_DISTRIBUTION_FILES = new Set([
  "listener/src/searcher/active-pool-discovery.ts",
  "listener/src/searcher/detector/blockscan-scanner.ts",
  "listener/src/searcher/main.ts",
  "listener/src/searcher/hot-path.ts",
  "listener/src/searcher/detector/victim-source-quality.ts",
  "listener/src/searcher/execution/inclusion-tracker.ts",
  "listener/src/searcher/execution/submission-coordinator.ts",
  "listener/src/searcher/build-active-pool-universe.ts",
  "listener/src/searcher/planner/planner.ts",
  "listener/src/searcher/planner/token-graph.ts",
  "listener/src/searcher/pool-universe.ts",
  "listener/src/searcher/pool-universe-arb-relevance.ts",
  "listener/src/searcher/strategy-views.ts",
]);
const ALWAYS_LIVE_DISTRIBUTION_PREFIXES = [
  "listener/src/searcher/orderflow/",
];

const HISTORICAL_REPLAY_DETERMINISTIC_PREFIXES = [
  "listener/src/adapters/",
  "listener/src/shared/adapters/",
  "listener/src/shared/compiler/",
  "listener/src/shared/constants/",
  "listener/src/shared/executor/",
  "listener/src/shared/types/",
  "listener/src/searcher/templates/",
  "listener/src/searcher/venues/",
];

const HISTORICAL_REPLAY_DETERMINISTIC_FILES = new Set([
  "listener/src/compiler.ts",
  "listener/src/encoder.ts",
  "listener/src/types.ts",
  "listener/src/searcher/detector/cycle-fingerprint.ts",
  "listener/src/searcher/detector/pool-impact.ts",
  "listener/src/searcher/detector/victim-effect.ts",
  "listener/src/searcher/revm-sim-client.ts",
  "listener/src/searcher/simulator/botvm-simulator.ts",
  "listener/src/searcher/solver/amount-bounds.ts",
  "listener/src/searcher/solver/amount-propagation.ts",
  "listener/src/searcher/solver/balance-slots.ts",
  "listener/src/searcher/solver/curve-math.ts",
  "listener/src/searcher/solver/final-verify-gate.ts",
  "listener/src/searcher/solver/flash-liquidity.ts",
  "listener/src/searcher/solver/plan-builder.ts",
  "listener/src/searcher/solver/post-impact-overrides.ts",
  "listener/src/searcher/solver/quoter.ts",
  "listener/src/searcher/solver/v2-fee.ts",
  "listener/src/searcher/solver/v3-math.ts",
  "listener/src/searcher/solver/v4-math.ts",
  "listener/src/searcher/solver/victim-apply.ts",
  "listener/src/searcher/standing-guard.ts",
  "listener/src/searcher/strategy-taxonomy.ts",
]);

function isHistoricalReplayDeterministicFile(file: string): boolean {
  return HISTORICAL_REPLAY_DETERMINISTIC_FILES.has(file)
    || HISTORICAL_REPLAY_DETERMINISTIC_PREFIXES.some((prefix) => file.startsWith(prefix));
}
const LIVE_DISTRIBUTION_TOKENS = [
  { name: "admission", re: /\badmission\b/i },
  { name: "budget", re: /\bbudget(?:Ms)?\b/i },
  { name: "candidate-cap", re: /\bmaxCandidates\b|\bcandidate(?:Cap|Limit)\b/i },
  { name: "candidate-ranking", re: /\brank(?:ing)?\b|\bpriority\b|\bscore\b/i },
  { name: "collection-filter", re: /\.filter\s*\(|\breturn\s+\[\s*\]/i },
  { name: "collection-order", re: /\.(?:sort|toSorted|reverse|toReversed|slice|splice)\s*\(/i },
  { name: "concurrency", re: /\bconcurr(?:ency|ent)\b/i },
  { name: "deadline", re: /\bdeadline(?:Ms)?\b/i },
  { name: "latency", re: /\blatency\b|\bperformance\.now\b/i },
  { name: "mempool-intake", re: /\benableMempool\b|\bsubscribe\b|\bsubscription\b/i },
  { name: "resource-attempts", re: /\b(?:max|min)?(?:Tries|Attempts|Retries|Iterations)\b/i },
  { name: "spread-threshold", re: /\bminSpread(?:Bps)?\b/i },
  { name: "generic-flow-limit", re: /\b(?:seen|processed|count|iterations?)\b.*[<>]=?|\b(?:candidate|opportunit|route|path)[A-Za-z0-9_]*\b.*\b(?:limit|cap|quota|floor|threshold)\b|\b(?:limit|cap|quota|floor|threshold)\b/i },
  { name: "flow-control-break", re: /\b(?:break|continue)\b/i },
  { name: "mutable-counter", re: /(?:\+\+|--)/ },
  { name: "timeout", re: /\btimeout(?:Ms)?\b|\bset(?:Timeout|Interval)\b/i },
  { name: "top-n", re: /\btopN\b|\btop_n\b/i },
  { name: "victim-source", re: /\bvictimSource\b|\benableBackrun\b/i },
];
