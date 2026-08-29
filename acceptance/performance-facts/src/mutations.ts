import { encodeCanonicalJson, sha256Hex, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { PERFORMANCE_CRITICAL_MUTATION_IDS, type PerformanceCriticalMutationId } from "./spec.ts";
import type { PerformanceFactBundleV1 } from "./schema.ts";

const MUTATION_HASH = `0x${"f".repeat(64)}` as Hash;

function copy(input: PerformanceFactBundleV1): {
  profile: PerformanceFactBundleV1["profile"];
  commitment: PerformanceFactBundleV1["commitment"];
  heads: PerformanceFactBundleV1["heads"][number][];
  lineages: PerformanceFactBundleV1["lineages"][number][];
  candidateSets: PerformanceFactBundleV1["candidateSets"][number][];
  candidateTerminals: PerformanceFactBundleV1["candidateTerminals"][number][];
  metrics: PerformanceFactBundleV1["metrics"][number][];
  terminals: PerformanceFactBundleV1["terminals"][number][];
  generationSegments: PerformanceFactBundleV1["generationSegments"][number][];
  windowReceipt: PerformanceFactBundleV1["windowReceipt"];
} {
  return {
    profile: input.profile,
    commitment: input.commitment,
    heads: [...input.heads],
    lineages: [...input.lineages],
    candidateSets: [...input.candidateSets],
    candidateTerminals: [...input.candidateTerminals],
    metrics: [...input.metrics],
    terminals: [...input.terminals],
    generationSegments: [...input.generationSegments],
    windowReceipt: input.windowReceipt,
  };
}

function mutateArray<T>(values: readonly T[], index: number, change: (value: T) => T): T[] {
  const result = [...values];
  if (result[index] !== undefined) result[index] = change(result[index]!);
  return result;
}

function change<T extends object>(value: T, patch: Partial<T>): T {
  return { ...value, ...patch };
}

export interface PerformanceMutationDefinitionV1 {
  readonly id: PerformanceCriticalMutationId;
  readonly apply: (input: PerformanceFactBundleV1) => unknown;
}

const definitions: Record<PerformanceCriticalMutationId, (input: PerformanceFactBundleV1) => unknown> = {
  "budget-field-missing": (input) => {
    const next = copy(input);
    const { coarseP99Us: _omitted, ...budgets } = next.profile.budgets;
    next.profile = { ...next.profile, budgets } as never;
    return next;
  },
  "candidate-path-sample-missing": (input) => {
    const next = copy(input);
    next.metrics = mutateArray(next.metrics, 0, (metric) => change(metric, { candidatePathDurationUs: null }));
    return next;
  },
  "candidate-set-root-splice": (input) => {
    const next = copy(input);
    next.candidateSets = mutateArray(next.candidateSets, 0, (set) => change(set, { candidateSetRoot: MUTATION_HASH }));
    return next;
  },
  "cross-generation": (input) => {
    const next = copy(input);
    next.heads = mutateArray(next.heads, Math.min(20, next.heads.length - 1), (head) => change(head, { generationId: "cross-generation" }));
    return next;
  },
  "cross-log-inode": (input) => {
    const anchor = change(input.commitment.processLogAnchor, { logInode: "999999" });
    return { ...copy(input), commitment: change(input.commitment, { processLogAnchor: anchor }) };
  },
  "cross-pid": (input) => {
    const anchor = change(input.commitment.processLogAnchor, { pid: "999999" });
    return { ...copy(input), commitment: change(input.commitment, { processLogAnchor: anchor }) };
  },
  "duration-tamper": (input) => {
    const next = copy(input);
    next.metrics = mutateArray(next.metrics, 0, (metric) => change(metric, { headDurationUs: "1" }));
    return next;
  },
  "empty-denominator": (input) => ({ ...copy(input), heads: [], terminals: [], metrics: [], candidateSets: [] }),
  "excluded-head": (input) => ({ ...copy(input), windowReceipt: change(input.windowReceipt, { excludedHeads: [MUTATION_HASH] }) }),
  "generation-root-splice": (input) => {
    const next = copy(input);
    next.heads = mutateArray(next.heads, Math.min(20, next.heads.length - 1), (head) => change(head, { graphRoot: MUTATION_HASH }));
    return next;
  },
  "generation-segment-gap": (input) => {
    const next = copy(input);
    next.generationSegments = mutateArray(next.generationSegments, Math.min(1, next.generationSegments.length - 1), (segment) => change(segment, { firstHeadOrdinal: "22" }));
    return next;
  },
  "generation-segment-reorder": (input) => {
    const next = copy(input);
    next.generationSegments = [...next.generationSegments].reverse();
    if (next.generationSegments.length < 2) next.generationSegments = mutateArray(next.generationSegments, 0, segment => change(segment, { segmentOrdinal: "2" }));
    return next;
  },
  "generation-segment-rejoin": (input) => {
    const next = copy(input);
    const first = next.generationSegments[0];
    next.generationSegments = mutateArray(next.generationSegments, Math.min(1, next.generationSegments.length - 1), segment => change(segment, {
      generationId: first?.generationId ?? "rejoined-generation",
      graphRoot: first?.graphRoot ?? segment.graphRoot,
      readyRecordHash: first?.readyRecordHash ?? segment.readyRecordHash,
      generationSourceCoverageRoot: first?.generationSourceCoverageRoot ?? segment.generationSourceCoverageRoot,
    }));
    return next;
  },
  "generation-segment-root-forgery": (input) => ({ ...copy(input), windowReceipt: change(input.windowReceipt, { generationSegmentRoot: MUTATION_HASH }) }),
  "head-101": (input) => {
    const next = copy(input);
    next.heads = [...next.heads, change(next.heads[next.heads.length - 1]!, { ordinal: "101" })];
    return next;
  },
  "head-99": (input) => ({ ...copy(input), heads: input.heads.slice(0, 99) }),
  "head-ordinal-duplicate": (input) => {
    const next = copy(input);
    next.heads = mutateArray(next.heads, 1, (head) => change(head, { ordinal: next.heads[0]?.ordinal ?? "1" }));
    return next;
  },
  "head-ordinal-gap": (input) => {
    const next = copy(input);
    next.heads = mutateArray(next.heads, 1, (head) => change(head, { ordinal: "3" }));
    return next;
  },
  "head-parent-splice": (input) => {
    const next = copy(input);
    next.heads = mutateArray(next.heads, 1, (head) => change(head, { canonicalHead: change(head.canonicalHead, { parentHash: MUTATION_HASH }) }));
    return next;
  },
  "missing-head-first": (input) => ({ ...copy(input), heads: input.heads.slice(1) }),
  "missing-head-last": (input) => ({ ...copy(input), heads: input.heads.slice(0, -1) }),
  "missing-head-middle": (input) => ({ ...copy(input), heads: input.heads.filter((_, index) => index !== 49) }),
  "missing-timing": (input) => ({ ...copy(input), metrics: input.metrics.slice(0, -1) }),
  "no-op-mutator": (input) => ({ ...copy(input) }),
  "orphan-last-write": (input) => {
    const next = copy(input);
    next.lineages = [];
    if (input.lineages.length === 0) next.heads = mutateArray(next.heads, 0, (head) => change(head, { headRecordId: MUTATION_HASH }));
    return next;
  },
  "orphan-new-ordinal": (input) => {
    const next = copy(input);
    next.lineages = input.lineages.length === 0
      ? []
      : mutateArray(next.lineages, 0, (lineage) => change(lineage, { ordinal: "100" }));
    if (input.lineages.length === 0) next.heads = mutateArray(next.heads, 0, (head) => change(head, { ordinal: "2" }));
    return next;
  },
  "permit-conservation": (input) => {
    const next = copy(input);
    next.metrics = mutateArray(next.metrics, 0, (metric) => change(metric, { permitAccounting: mutateArray(metric.permitAccounting, 0, (entry) => change(entry, { active: "999" })) }));
    return next;
  },
  "percentile-interpolation": (input) => {
    const next = copy(input);
    next.metrics = mutateArray(next.metrics, 0, (metric) => change(metric, { headDurationUs: "10000001" }));
    return next;
  },
  "profile-root-splice": (input) => ({ ...copy(input), commitment: change(input.commitment, { performanceProfileHash: MUTATION_HASH }) }),
  "queue-telemetry-missing": (input) => {
    const next = copy(input);
    next.metrics = mutateArray(next.metrics, 0, (metric) => change(metric, { queueTelemetry: [] }));
    return next;
  },
  "replacement-ordinal-splice": (input) => {
    const next = copy(input);
    next.lineages = input.lineages.length === 0
      ? []
      : mutateArray(next.lineages, 0, (lineage) => change(lineage, { ordinal: "2" }));
    if (input.lineages.length === 0) next.heads = mutateArray(next.heads, 0, (head) => change(head, { ordinal: "2" }));
    return next;
  },
  "six-step-duplicate-success": (input) => {
    const next = copy(input);
    const success = next.candidateTerminals.find(candidate => candidate.sixStepCompleted);
    if (success !== undefined) next.candidateTerminals.push(success);
    return next;
  },
  "six-step-not-run-root": (input) => {
    const next = copy(input);
    next.candidateTerminals = mutateArray(next.candidateTerminals, 0, (candidate) => change(candidate, {
      sixStepCompleted: false,
    } as never));
    return next;
  },
  "six-step-correlation-splice": (input) => {
    const next = copy(input);
    next.candidateTerminals = mutateArray(next.candidateTerminals, 0, (candidate) => change(candidate, {
      correlationRoot: MUTATION_HASH,
    }));
    return next;
  },
  "six-step-rejected": (input) => {
    const next = copy(input);
    next.candidateTerminals = mutateArray(next.candidateTerminals, 0, (candidate) => change(candidate, {
      outcome: "policy-rejected",
    } as never));
    return next;
  },
  "terminal-duplicate": (input) => ({ ...copy(input), terminals: [...input.terminals, input.terminals[0]!] }),
  "timing-count-mismatch": (input) => ({ ...copy(input), metrics: input.metrics.slice(0, 99) }),
  "unknown-outcome": (input) => {
    const next = copy(input);
    next.terminals = mutateArray(next.terminals, 0, (terminal) => change(terminal, { outcome: "unknown" as never }));
    return next;
  },
  "unhealthy-filtered": (input) => {
    const next = copy(input);
    const unhealthy = input.terminals.filter((terminal) => !terminal.healthy);
    next.terminals = unhealthy.length === 0
      ? mutateArray(next.terminals, 0, (terminal) => change(terminal, { outcome: "timeout" as never }))
      : input.terminals.filter((terminal) => terminal.healthy);
    return next;
  },
  "window-start-shift": (input) => ({ ...copy(input), commitment: change(input.commitment, { committedMonotonicNs: "999999999999" }) }),
};

export const PERFORMANCE_MUTATION_REGISTRY: readonly PerformanceMutationDefinitionV1[] = Object.freeze(
  PERFORMANCE_CRITICAL_MUTATION_IDS.map((id) => Object.freeze({ id, apply: definitions[id] })),
);

export interface PerformanceMutationRunV1 {
  readonly id: PerformanceCriticalMutationId;
  readonly changed: boolean;
  readonly output: unknown;
  readonly outputHash: Hash;
}

/** Executes every declared mutator; a no-op is reported as a corpus defect. */
export function runPerformanceMutationRegistry(input: PerformanceFactBundleV1): readonly PerformanceMutationRunV1[] {
  return Object.freeze(PERFORMANCE_MUTATION_REGISTRY.map((mutation) => {
    const output = mutation.apply(input);
    const before = encodeCanonicalJson(input);
    const after = encodeCanonicalJson(output);
    return Object.freeze({
      id: mutation.id,
      changed: before !== after,
      output,
      outputHash: sha256Hex(after),
    });
  }));
}
