import { ethers } from "ethers";
import type { OrderflowEvent } from "../orderflow/manual-source.js";
import type { TokenEdge, TokenQueryBackend } from "../planner/token-graph.js";
import { PRODUCTION_STRICT_FAMILY_DECLARATIONS } from
  "../strict-production-family-declarations.js";
import type {
  ObservedSwapImpact,
  OwnedReceiptTrigger,
  PoolImpact,
  ReceiptImpactResult,
  ReceiptLogsCompleteness,
  ReceiptSwapObservationContext,
  SwapEventLog,
  SwapObservationCapability,
  VictimSourceGeneration,
} from "../venues/swap-observation.js";

export type {
  PoolImpact,
  VictimSourceGeneration,
} from "../venues/swap-observation.js";

export type PoolImpactStepOrigin =
  | "family-receipt"
  | "family-direct-call";

export interface PoolImpactStep {
  readonly sequence: number;
  readonly logIndex: number | null;
  readonly origin: PoolImpactStepOrigin;
  readonly familyId: string;
  readonly impact: PoolImpact;
}

export interface PoolMutationOnlyStep {
  readonly sequence: number;
  readonly logIndex: number;
  readonly origin: "family-receipt";
  readonly familyId: string;
  /** Address emitters use the pool address; singleton venues use logical poolId. */
  readonly poolIdentity: string;
  readonly reason: string;
}

export type PoolImpactUnresolvedReason =
  | "observer-error"
  | "observer-decode-failed"
  | "observer-produced-unadmitted-impact"
  | "ambiguous-observer-impact"
  | "unverified-swap-emitter"
  | "direct-observer-error"
  | "direct-call-decode-failed"
  | "unverified-direct-call-target"
  | "transfer-only-candidate"
  | "post-state-incomplete"
  | "receipt-fragment"
  | "source-generation-unbound"
  | "source-generation-mismatch";

export interface PoolImpactUnresolved {
  readonly reason: PoolImpactUnresolvedReason;
  readonly pool: string | null;
  readonly logIndex: number | null;
  readonly familyIds: readonly string[];
  readonly detail: string;
}

/**
 * One receipt/direct-call transition, bound to the pre-victim state generation.
 *
 * `steps` retains every admitted non-exact swap in receipt order. `impacts`
 * collapses an exact-state pool to its last exact receipt state while preserving
 * every affected pool. `mutations` retains owned state changes whose log proves
 * no directed token flow and therefore cannot honestly become a fabricated
 * PoolImpact. Hash-only replay is safe only when this transition is complete,
 * has exactly one final impact, and has no mutation-only state change.
 */
export interface PoolImpactTransition {
  readonly sourceGeneration: VictimSourceGeneration;
  readonly steps: readonly PoolImpactStep[];
  readonly mutations: readonly PoolMutationOnlyStep[];
  readonly impacts: readonly PoolImpact[];
  readonly unresolved: readonly PoolImpactUnresolved[];
  readonly complete: boolean;
  readonly hashOnlyReplayable: boolean;
}

export interface MutationOnlyTransitionDiagnostic {
  readonly reason: "mutation_only_no_direction";
  readonly mutations: readonly {
    readonly familyId: string;
    readonly poolIdentity: string;
    readonly reason: string;
  }[];
}

/**
 * A complete mutation-only transition is relevant state evidence, but it does
 * not provide an honest token direction from which to construct PoolImpact.
 */
export function mutationOnlyTransitionDiagnostic(
  transition: Pick<
    PoolImpactTransition,
    "complete" | "impacts" | "mutations"
  >,
): MutationOnlyTransitionDiagnostic | null {
  if (
    !transition.complete ||
    transition.impacts.length !== 0 ||
    transition.mutations.length === 0
  ) {
    return null;
  }
  return Object.freeze({
    reason: "mutation_only_no_direction" as const,
    mutations: Object.freeze(transition.mutations.map((mutation) =>
      Object.freeze({
        familyId: mutation.familyId,
        poolIdentity: mutation.poolIdentity,
        reason: mutation.reason,
      })
    )),
  });
}

export interface VictimSourceGenerationInput {
  readonly sourceBlock: number | null;
  readonly sourceBlockHash?: string | null;
  readonly receiptId: string;
  readonly receiptBlockNumber?: number | null;
  readonly receiptBlockHash?: string | null;
  readonly receiptParentBlockHash?: string | null;
  readonly receiptTransactionHash?: string | null;
  readonly logs: readonly SwapEventLog[];
  readonly logsCompleteness: ReceiptLogsCompleteness;
}

interface ObservationGroup {
  readonly observation: SwapObservationCapability;
  readonly familyIds: readonly string[];
  readonly edgeAdapterIds: ReadonlySet<string>;
}

interface CollapseResult {
  readonly steps: PoolImpactStep[];
  readonly impacts: PoolImpact[];
  readonly unresolved: PoolImpactUnresolved[];
}

const ERC20_TRANSFER_TOPIC = ethers.id(
  "Transfer(address,address,uint256)",
).toLowerCase();
const VICTIM_FAMILY_TIMEOUT_MS = positiveFiniteNumber(
  process.env.SEARCHER_VICTIM_FAMILY_TIMEOUT_MS,
  2_000,
);

export function createVictimSourceGeneration(
  input: VictimSourceGenerationInput,
): VictimSourceGeneration {
  if (
    input.logsCompleteness !== "complete-receipt" &&
    input.logsCompleteness !== "fragment"
  ) {
    throw new Error(`invalid receipt log completeness ${input.logsCompleteness}`);
  }
  if (
    input.sourceBlock !== null &&
    (!Number.isSafeInteger(input.sourceBlock) || input.sourceBlock < 0)
  ) {
    throw new Error(`invalid victim source block ${input.sourceBlock}`);
  }
  const sourceBlockHash = input.sourceBlockHash?.toLowerCase() ?? null;
  if (
    sourceBlockHash !== null &&
    !/^0x[0-9a-f]{64}$/.test(sourceBlockHash)
  ) {
    throw new Error(`invalid victim source block hash ${input.sourceBlockHash}`);
  }
  const receiptBlockNumber = input.receiptBlockNumber ?? null;
  if (
    receiptBlockNumber !== null &&
    (!Number.isSafeInteger(receiptBlockNumber) || receiptBlockNumber < 0)
  ) {
    throw new Error(`invalid victim receipt block ${receiptBlockNumber}`);
  }
  const receiptBlockHash = input.receiptBlockHash?.toLowerCase() ?? null;
  if (
    receiptBlockHash !== null &&
    !/^0x[0-9a-f]{64}$/.test(receiptBlockHash)
  ) {
    throw new Error(`invalid victim receipt block hash ${input.receiptBlockHash}`);
  }
  const receiptParentBlockHash =
    input.receiptParentBlockHash?.toLowerCase() ?? null;
  if (
    receiptParentBlockHash !== null &&
    !/^0x[0-9a-f]{64}$/.test(receiptParentBlockHash)
  ) {
    throw new Error(
      `invalid victim receipt parent hash ${input.receiptParentBlockHash}`,
    );
  }
  const receiptTransactionHash =
    input.receiptTransactionHash?.toLowerCase() ?? null;
  if (
    receiptTransactionHash !== null &&
    !/^0x[0-9a-f]{64}$/.test(receiptTransactionHash)
  ) {
    throw new Error(
      `invalid victim receipt transaction hash ${input.receiptTransactionHash}`,
    );
  }
  const receiptFingerprint = input.logs.map((log, logIndex) => [
    logIndex,
    log.address.toLowerCase(),
    log.topics.map((topic) => topic.toLowerCase()),
    log.data.toLowerCase(),
  ]);
  const id = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify([
    input.sourceBlock,
    sourceBlockHash,
    input.receiptId.toLowerCase(),
    receiptBlockNumber,
    receiptBlockHash,
    receiptParentBlockHash,
    receiptTransactionHash,
    input.logsCompleteness,
    receiptFingerprint,
  ])));
  return Object.freeze({
    id,
    sourceBlock: input.sourceBlock,
    sourceBlockHash,
    receiptId: input.receiptId,
    receiptBlockNumber,
    receiptBlockHash,
    receiptParentBlockHash,
    receiptTransactionHash,
    logsCompleteness: input.logsCompleteness,
  });
}

/**
 * Registry-driven receipt decoder. A topic or paired Transfer is only evidence:
 * actionable impacts must be emitted by the owning family observer and match an
 * already-admitted graph edge exactly.
 */
export async function detectImpactTransitionFromLogs(
  logs: SwapEventLog[],
  graph: TokenEdge[],
  sourceGeneration: VictimSourceGeneration,
  broadPoolAddrs?: Map<string, string> | null,
  tokenQuery?: TokenQueryBackend | null,
): Promise<PoolImpactTransition> {
  const expectedGeneration = createVictimSourceGeneration({
    sourceBlock: sourceGeneration.sourceBlock,
    sourceBlockHash: sourceGeneration.sourceBlockHash,
    receiptId: sourceGeneration.receiptId,
    receiptBlockNumber: sourceGeneration.receiptBlockNumber,
    receiptBlockHash: sourceGeneration.receiptBlockHash,
    receiptParentBlockHash: sourceGeneration.receiptParentBlockHash,
    receiptTransactionHash: sourceGeneration.receiptTransactionHash,
    logs,
    logsCompleteness: sourceGeneration.logsCompleteness,
  });
  if (expectedGeneration.id !== sourceGeneration.id) {
    return transitionFromSteps(sourceGeneration, [], [], [{
      reason: "source-generation-mismatch",
      pool: null,
      logIndex: null,
      familyIds: [],
      detail: "receipt logs do not match the supplied source generation",
    }]);
  }
  const edgesByTarget = groupEdgesByTarget(graph);
  const steps: PoolImpactStep[] = [];
  const mutations: PoolMutationOnlyStep[] = [];
  const unresolved: PoolImpactUnresolved[] = [];
  const coveredPools = new Set<string>();

  for (const group of observationGroups()) {
    const matchedOwnedTriggers = matchOwnedReceiptTriggers(
      logs,
      graph,
      group,
      sourceGeneration,
    );
    if (matchedOwnedTriggers.length === 0) continue;
    for (const trigger of matchedOwnedTriggers) {
      coveredPools.add(trigger.emitter.toLowerCase());
      const identity = observedPoolIdentity(
        group.observation,
        logs[trigger.logIndex],
      );
      if (identity) coveredPools.add(identity);
    }

    const result = await decodeReceiptObservationWithDeadline(
      group.observation,
      {
        logs,
        graph,
        edgesByTarget,
        tokenQuery,
        sourceGeneration,
        matchedOwnedTriggers,
      },
    );
    if (result.status !== "resolved") {
      const first = matchedOwnedTriggers[0];
      unresolved.push({
        reason: "observer-decode-failed",
        pool: observedPoolIdentity(
          group.observation,
          logs[first.logIndex],
        ),
        logIndex: first.logIndex,
        familyIds: group.familyIds,
        detail: result.status === "no-match"
          ? "observer returned no-match for a non-empty owned trigger set"
          : result.reason,
      });
      continue;
    }
    const triggerContractError = validateConsumedTriggerExactSet(
      result,
      matchedOwnedTriggers,
    );
    if (triggerContractError) {
      const first = matchedOwnedTriggers[0];
      unresolved.push({
        reason: "observer-error",
        pool: observedPoolIdentity(
          group.observation,
          logs[first.logIndex],
        ),
        logIndex: first.logIndex,
        familyIds: group.familyIds,
        detail: triggerContractError,
      });
      continue;
    }

    const groupUnresolved: PoolImpactUnresolved[] = [];
    const admittedByLog = new Map<number, PoolImpactStep[]>();
    const mutationByLog = new Map(
      result.mutations.map((mutation) => [mutation.logIndex, mutation] as const),
    );
    for (const candidate of result.impacts) {
      const consumed = new Set(candidate.consumedTriggerIds);
      const ownsLog = matchedOwnedTriggers.some(
        (trigger) =>
          trigger.logIndex === candidate.logIndex &&
          consumed.has(trigger.triggerId),
      );
      if (!ownsLog) {
        groupUnresolved.push({
          reason: "observer-produced-unadmitted-impact",
          pool: candidate.impact.pool,
          logIndex: candidate.logIndex,
          familyIds: group.familyIds,
          detail: "observer returned an impact for a non-owned receipt trigger",
        });
        continue;
      }
      const familyId = ownerFamilyId(group, candidate.impact.matchedAdapterId);
      if (
        familyId === null ||
        !impactMatchesAdmittedEdge(candidate.impact, graph)
      ) {
        groupUnresolved.push({
          reason: "observer-produced-unadmitted-impact",
          pool: candidate.impact.pool,
          logIndex: candidate.logIndex,
          familyIds: group.familyIds,
          detail:
            `adapter=${candidate.impact.matchedAdapterId} does not match an owned admitted edge`,
        });
        continue;
      }
      const step: PoolImpactStep = {
        sequence: candidate.logIndex,
        logIndex: candidate.logIndex,
        origin: "family-receipt",
        familyId,
        impact: candidate.impact,
      };
      const atLog = admittedByLog.get(candidate.logIndex) ?? [];
      atLog.push(step);
      admittedByLog.set(candidate.logIndex, atLog);
    }

    const groupSteps: PoolImpactStep[] = [];
    const groupMutations: PoolMutationOnlyStep[] = [];
    for (const trigger of matchedOwnedTriggers) {
      const logIndex = trigger.logIndex;
      const atLog = dedupeSameObservationSteps(
        admittedByLog.get(logIndex) ?? [],
      );
      if (atLog.length === 1) {
        groupSteps.push(atLog[0]);
        continue;
      }
      if (atLog.length > 1) {
        groupUnresolved.push({
          reason: "ambiguous-observer-impact",
          pool: observedPoolIdentity(group.observation, logs[logIndex]),
          logIndex,
          familyIds: group.familyIds,
          detail: `observer produced ${atLog.length} distinct admitted impacts`,
        });
        continue;
      }
      const mutation = mutationByLog.get(logIndex);
      if (mutation) {
        const identity = observedPoolIdentity(
          group.observation,
          logs[logIndex],
        );
        if (!identity || group.familyIds.length !== 1) {
          groupUnresolved.push({
            reason: "observer-error",
            pool: identity,
            logIndex,
            familyIds: group.familyIds,
            detail:
              "mutation-only trigger has no unique family-owned pool identity",
          });
          continue;
        }
        groupMutations.push(Object.freeze({
          sequence: mutation.logIndex,
          logIndex: mutation.logIndex,
          origin: "family-receipt" as const,
          familyId: group.familyIds[0],
          poolIdentity: identity,
          reason: mutation.reason,
        }));
        continue;
      }

      const identity = observedPoolIdentity(
        group.observation,
        logs[logIndex],
      );
      groupUnresolved.push({
        reason: "observer-decode-failed",
        pool: identity,
        logIndex,
        familyIds: group.familyIds,
        detail: "owned trigger did not produce one admitted family impact",
      });
    }
    if (groupUnresolved.length > 0) {
      unresolved.push(...groupUnresolved);
      continue;
    }
    steps.push(...groupSteps);
    mutations.push(...groupMutations);
    for (const step of groupSteps) {
      coveredPools.add(step.impact.pool.toLowerCase());
    }
  }

  unresolved.push(...transferOnlyCandidates(
    logs,
    graph,
    broadPoolAddrs,
    coveredPools,
  ));

  return transitionFromSteps(
    sourceGeneration,
    steps,
    mutations,
    unresolved,
  );
}

/** Compatibility view for existing tests and non-production analysis callers. */
export async function detectImpactFromLogs(
  logs: SwapEventLog[],
  graph: TokenEdge[],
  broadPoolAddrs?: Map<string, string> | null,
  tokenQuery?: TokenQueryBackend | null,
): Promise<PoolImpact[]> {
  const sourceGeneration = createVictimSourceGeneration({
    sourceBlock: null,
    sourceBlockHash: null,
    receiptId: "unbound-log-view",
    logs,
    logsCompleteness: "complete-receipt",
  });
  return [
    ...(await detectImpactTransitionFromLogs(
      logs,
      graph,
      sourceGeneration,
      broadPoolAddrs,
      tokenQuery,
    )).impacts,
  ];
}

export async function detectPoolImpactTransition(
  event: OrderflowEvent,
  graph: TokenEdge[],
  broadPoolAddrs?: Map<string, string> | null,
  tokenQuery?: TokenQueryBackend | null,
): Promise<PoolImpactTransition> {
  const sourceGeneration = createVictimSourceGeneration({
    sourceBlock: Math.max(0, event.blockNumber - 1),
    sourceBlockHash: event.sourceBlockHash ?? null,
    receiptId: event.txHash,
    receiptBlockNumber: event.receiptBlockNumber ?? null,
    receiptBlockHash: event.receiptBlockHash ?? null,
    receiptParentBlockHash: event.receiptParentBlockHash ?? null,
    receiptTransactionHash: event.receiptTransactionHash ?? null,
    logs: event.logs,
    logsCompleteness: event.logsCompleteness ?? "fragment",
  });
  const [direct, receipt] = await Promise.all([
    detectDirectCallSteps(event, graph, sourceGeneration),
    detectImpactTransitionFromLogs(
      event.logs,
      graph,
      sourceGeneration,
      broadPoolAddrs,
      tokenQuery,
    ),
  ]);
  const receiptPoolKeys = new Set(
    receipt.steps.map((step) => impactStateKey(step.impact)),
  );
  const directSteps = direct.steps.filter(
    (step) => !receiptPoolKeys.has(impactStateKey(step.impact)),
  );
  return transitionFromSteps(
    sourceGeneration,
    [...directSteps, ...receipt.steps],
    receipt.mutations,
    [
      ...direct.unresolved,
      ...receipt.unresolved,
      ...receiptSourceBindingIssues(
        sourceGeneration,
        event.logs,
        sourceGeneration.logsCompleteness === "complete-receipt",
      ),
    ],
  );
}

export async function detectPoolImpact(
  event: OrderflowEvent,
  graph: TokenEdge[],
  broadPoolAddrs?: Map<string, string> | null,
  tokenQuery?: TokenQueryBackend | null,
): Promise<PoolImpact[]> {
  return [
    ...(await detectPoolImpactTransition(
      event,
      graph,
      broadPoolAddrs,
      tokenQuery,
    )).impacts,
  ];
}

async function detectDirectCallSteps(
  event: OrderflowEvent,
  graph: TokenEdge[],
  sourceGeneration: VictimSourceGeneration,
): Promise<{
  readonly steps: PoolImpactStep[];
  readonly unresolved: PoolImpactUnresolved[];
}> {
  const target = event.to?.toLowerCase();
  if (!target || event.input.length < 10) {
    return { steps: [], unresolved: [] };
  }
  const selector = event.input.slice(0, 10).toLowerCase();
  const edgesByTarget = groupEdgesByTarget(graph);
  const steps: PoolImpactStep[] = [];
  const unresolved: PoolImpactUnresolved[] = [];

  for (const group of observationGroups()) {
    const observation = group.observation;
    if (
      !observation.decodeDirectCallImpacts ||
      !observation.directCallSelectors?.includes(selector)
    ) {
      continue;
    }
    if (!identityMatchesOwnedGraph(target, graph, group.edgeAdapterIds)) {
      unresolved.push({
        reason: "unverified-direct-call-target",
        pool: target,
        logIndex: null,
        familyIds: group.familyIds,
        detail: `selector=${selector} target is not an admitted family edge`,
      });
      continue;
    }

    let impacts: readonly PoolImpact[];
    try {
      impacts = await observation.decodeDirectCallImpacts({
        target,
        input: event.input,
        graph,
        edgesByTarget,
        sourceGeneration,
      });
    } catch (error) {
      unresolved.push({
        reason: "direct-observer-error",
        pool: target,
        logIndex: null,
        familyIds: group.familyIds,
        detail: errorMessage(error),
      });
      continue;
    }
    const admitted = dedupeSameObservationSteps(impacts
      .filter((impact) =>
        ownerFamilyId(group, impact.matchedAdapterId) !== null &&
        impactMatchesAdmittedEdge(impact, graph)
      )
      .map((impact) => ({
        sequence: -1,
        logIndex: null,
        origin: "family-direct-call" as const,
        familyId: ownerFamilyId(group, impact.matchedAdapterId)!,
        impact,
      })));
    if (admitted.length === 1) {
      steps.push(admitted[0]);
    } else {
      unresolved.push({
        reason: admitted.length === 0
          ? "direct-call-decode-failed"
          : "ambiguous-observer-impact",
        pool: target,
        logIndex: null,
        familyIds: group.familyIds,
        detail: admitted.length === 0
          ? `selector=${selector} did not decode to an admitted direction`
          : `direct decoder produced ${admitted.length} admitted impacts`,
      });
    }
  }
  return { steps, unresolved };
}

function transitionFromSteps(
  sourceGeneration: VictimSourceGeneration,
  rawSteps: readonly PoolImpactStep[],
  rawMutations: readonly PoolMutationOnlyStep[],
  initialUnresolved: readonly PoolImpactUnresolved[],
): PoolImpactTransition {
  const collapsed = collapseImpactSteps(rawSteps, sourceGeneration);
  const unresolved = [...initialUnresolved, ...collapsed.unresolved];
  if (sourceGeneration.logsCompleteness !== "complete-receipt") {
    unresolved.push({
      reason: "receipt-fragment",
      pool: null,
      logIndex: null,
      familyIds: [],
      detail: "the supplied logs are a hint fragment, not an attested complete receipt",
    });
  }
  if (
    sourceGeneration.sourceBlock !== null &&
    sourceGeneration.sourceBlockHash === null
  ) {
    unresolved.push({
      reason: "source-generation-unbound",
      pool: null,
      logIndex: null,
      familyIds: [],
      detail: "the pre-victim source block has no canonical hash binding",
    });
  }
  const uniqueUnresolved = dedupeUnresolved(unresolved);
  const complete = uniqueUnresolved.length === 0;
  return Object.freeze({
    sourceGeneration,
    steps: Object.freeze(collapsed.steps),
    mutations: Object.freeze(
      [...rawMutations].sort((left, right) =>
        left.sequence - right.sequence ||
        left.poolIdentity.localeCompare(right.poolIdentity)
      ),
    ),
    impacts: Object.freeze(collapsed.impacts),
    unresolved: Object.freeze(uniqueUnresolved),
    complete,
    hashOnlyReplayable:
      complete &&
      collapsed.impacts.length === 1 &&
      rawMutations.length === 0,
  });
}

function receiptSourceBindingIssues(
  sourceGeneration: VictimSourceGeneration,
  logs: readonly SwapEventLog[],
  requireBinding: boolean,
): PoolImpactUnresolved[] {
  if (!requireBinding) return [];
  const unresolved = (
    reason: PoolImpactUnresolvedReason,
    detail: string,
  ): PoolImpactUnresolved[] => [{
    reason,
    pool: null,
    logIndex: null,
    familyIds: [],
    detail,
  }];
  if (
    sourceGeneration.sourceBlock === null ||
    sourceGeneration.sourceBlockHash === null ||
    sourceGeneration.receiptBlockNumber === null ||
    sourceGeneration.receiptBlockHash === null ||
    sourceGeneration.receiptParentBlockHash === null ||
    sourceGeneration.receiptTransactionHash === null
  ) {
    return unresolved(
      "source-generation-unbound",
      "complete receipt lacks source block/hash or receipt block/hash/parent/transaction binding",
    );
  }
  if (
    sourceGeneration.receiptBlockNumber !==
      sourceGeneration.sourceBlock + 1
  ) {
    return unresolved(
      "source-generation-mismatch",
      `receipt block ${sourceGeneration.receiptBlockNumber} is not source block ` +
      `${sourceGeneration.sourceBlock} + 1`,
    );
  }
  if (
    sourceGeneration.receiptParentBlockHash !==
      sourceGeneration.sourceBlockHash
  ) {
    return unresolved(
      "source-generation-mismatch",
      "receipt block parent hash does not match the pre-victim source block hash",
    );
  }
  if (
    sourceGeneration.receiptTransactionHash.toLowerCase() !==
      sourceGeneration.receiptId.toLowerCase()
  ) {
    return unresolved(
      "source-generation-mismatch",
      "receipt transaction hash does not match receipt id",
    );
  }
  for (let logIndex = 0; logIndex < logs.length; logIndex++) {
    const log = logs[logIndex];
    if (
      log.blockNumber !== undefined &&
      log.blockNumber !== sourceGeneration.receiptBlockNumber
    ) {
      return [{
        reason: "source-generation-mismatch",
        pool: log.address.toLowerCase(),
        logIndex,
        familyIds: [],
        detail: "receipt log block number does not match receipt binding",
      }];
    }
    if (
      log.blockHash !== undefined &&
      log.blockHash.toLowerCase() !== sourceGeneration.receiptBlockHash
    ) {
      return [{
        reason: "source-generation-mismatch",
        pool: log.address.toLowerCase(),
        logIndex,
        familyIds: [],
        detail: "receipt log block hash does not match receipt binding",
      }];
    }
    if (
      log.transactionHash !== undefined &&
      log.transactionHash.toLowerCase() !==
        sourceGeneration.receiptTransactionHash
    ) {
      return [{
        reason: "source-generation-mismatch",
        pool: log.address.toLowerCase(),
        logIndex,
        familyIds: [],
        detail: "receipt log transaction hash does not match receipt binding",
      }];
    }
  }
  return [];
}

function collapseImpactSteps(
  rawSteps: readonly PoolImpactStep[],
  sourceGeneration: VictimSourceGeneration,
): CollapseResult {
  const steps = dedupeExactSameLog(rawSteps)
    .sort(compareSteps)
    .map((step) => Object.freeze({
      ...step,
      impact: {
        ...step.impact,
        sourceGeneration,
      },
    }));
  const byState = new Map<string, PoolImpactStep[]>();
  for (const step of steps) {
    const key = impactStateKey(step.impact);
    const current = byState.get(key) ?? [];
    current.push(step);
    byState.set(key, current);
  }

  const selected: PoolImpactStep[] = [];
  const unresolved: PoolImpactUnresolved[] = [];
  for (const poolSteps of byState.values()) {
    let lastExact = -1;
    for (let index = poolSteps.length - 1; index >= 0; index--) {
      if (hasExactPostState(poolSteps[index].impact)) {
        lastExact = index;
        break;
      }
    }
    if (lastExact < 0) {
      selected.push(...poolSteps);
      continue;
    }
    if (lastExact !== poolSteps.length - 1) {
      unresolved.push({
        reason: "post-state-incomplete",
        pool: poolSteps[0].impact.pool,
        logIndex: poolSteps[lastExact + 1].logIndex,
        familyIds: uniqueStrings(poolSteps.map((step) => step.familyId)),
        detail: "a later admitted swap has no exact post-state",
      });
      selected.push(...poolSteps);
      continue;
    }
    // An exact post-state is a snapshot of the whole pool after this log. Earlier
    // same-pool steps are retained in `steps` for evidence but need not be replayed.
    selected.push(poolSteps[lastExact]);
  }
  selected.sort(compareSteps);
  return {
    steps,
    impacts: selected.map((step) => step.impact),
    unresolved,
  };
}

function matchOwnedReceiptTriggers(
  logs: readonly SwapEventLog[],
  graph: readonly TokenEdge[],
  group: ObservationGroup,
  sourceGeneration: VictimSourceGeneration,
): OwnedReceiptTrigger[] {
  const topics = new Set(
    group.observation.topics.map((topic) => topic.toLowerCase()),
  );
  const anonymousLogs = group.observation.anonymousLogs ?? [];
  const triggers: OwnedReceiptTrigger[] = [];
  for (let logIndex = 0; logIndex < logs.length; logIndex++) {
    const log = logs[logIndex];
    const currentTopic = log.topics[0]?.toLowerCase() ?? "";
    const anonymousMatch = currentTopic === "" &&
      anonymousLogs.some((selector) =>
        selector.address.toLowerCase() === log.address.toLowerCase() &&
        log.topics.length === 0 &&
        /^0x(?:[0-9a-fA-F]{2})*$/.test(log.data) &&
        (log.data.length - 2) / 2 === selector.dataLengthBytes &&
        selector.identityOffsetBytes + 32 <= selector.dataLengthBytes
      );
    if (!topics.has(currentTopic) && !anonymousMatch) continue;
    const identity = observedPoolIdentity(group.observation, log);
    if (
      identity === null ||
      !identityMatchesOwnedGraph(identity, graph, group.edgeAdapterIds)
    ) {
      // Same-signature logs from unknown pools or malformed singleton
      // emitters are not family-owned triggers.
      continue;
    }
    triggers.push(Object.freeze({
      triggerId: ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify([
        sourceGeneration.id,
        group.familyIds[0],
        logIndex,
        log.address.toLowerCase(),
        currentTopic,
        identity,
      ]))),
      logIndex,
      emitter: log.address.toLowerCase(),
      topic0: currentTopic,
    }));
  }
  return triggers;
}

export async function decodeReceiptObservationWithDeadline(
  observation: SwapObservationCapability,
  input: Omit<ReceiptSwapObservationContext, "control">,
  timeoutMs: number = VICTIM_FAMILY_TIMEOUT_MS,
): Promise<ReceiptImpactResult> {
  const controller = new AbortController();
  const boundedTimeoutMs = positiveFiniteNumber(String(timeoutMs), 2_000);
  const deadlineAtMs = Date.now() + boundedTimeoutMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<ReceiptImpactResult>((resolve) => {
    timer = setTimeout(() => {
      const reason =
        `receipt decoder deadline ${boundedTimeoutMs}ms exceeded`;
      controller.abort(new Error(reason));
      resolve(Object.freeze({
        status: "unresolved" as const,
        reason,
      }));
    }, boundedTimeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() =>
        observation.decodeReceiptImpacts({
          ...input,
          control: Object.freeze({
            deadlineAtMs,
            signal: controller.signal,
          }),
        })
      ),
      timeout,
    ]);
  } catch (error) {
    return Object.freeze({
      status: "unresolved" as const,
      reason: errorMessage(error),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validateConsumedTriggerExactSet(
  result: Extract<ReceiptImpactResult, { readonly status: "resolved" }>,
  matched: readonly OwnedReceiptTrigger[],
): string | null {
  const expected = new Set(matched.map((trigger) => trigger.triggerId));
  const declared = result.consumedTriggerIds;
  if (
    declared.length !== expected.size ||
    new Set(declared).size !== declared.length ||
    declared.some((triggerId) => !expected.has(triggerId))
  ) {
    return "resolved receipt result declared a non-exact trigger set";
  }
  const triggerById = new Map(
    matched.map((trigger) => [trigger.triggerId, trigger] as const),
  );
  const consumedCounts = new Map<string, number>();
  for (const observed of [...result.impacts, ...result.mutations]) {
    if (observed.consumedTriggerIds.length === 0) {
      return "resolved impact consumed no owned trigger";
    }
    for (const triggerId of observed.consumedTriggerIds) {
      const trigger = triggerById.get(triggerId);
      if (!trigger || trigger.logIndex !== observed.logIndex) {
        return "resolved impact consumed an unknown or different-log trigger";
      }
      consumedCounts.set(
        triggerId,
        (consumedCounts.get(triggerId) ?? 0) + 1,
      );
    }
  }
  if (
    matched.some(
      (trigger) => consumedCounts.get(trigger.triggerId) !== 1,
    )
  ) {
    return "resolved impacts did not consume each owned trigger exactly once";
  }
  return null;
}

function observationGroups(): ObservationGroup[] {
  return [...PRODUCTION_STRICT_FAMILY_DECLARATIONS.swapObservationGroups];
}

function positiveFiniteNumber(
  raw: string | undefined,
  fallback: number,
): number {
  const value = raw === undefined ? fallback : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function ownerFamilyId(
  group: ObservationGroup,
  edgeAdapterId: string,
): string | null {
  if (!group.edgeAdapterIds.has(edgeAdapterId)) return null;
  return group.familyIds.length === 1 ? group.familyIds[0] : null;
}

function impactMatchesAdmittedEdge(
  impact: PoolImpact,
  graph: readonly TokenEdge[],
): boolean {
  return graph.some((edge) =>
    edge.adapterId === impact.matchedAdapterId &&
    sameAddress(edge.target, impact.pool) &&
    sameAddress(edge.tokenIn, impact.tokenIn) &&
    sameAddress(edge.tokenOut, impact.tokenOut) &&
    (edge.poolId?.toLowerCase() ?? null) ===
      (impact.poolId?.toLowerCase() ?? null)
  );
}

function identityMatchesOwnedGraph(
  identity: string,
  graph: readonly TokenEdge[],
  ownedEdgeIds: ReadonlySet<string>,
): boolean {
  const normalized = identity.toLowerCase();
  return graph.some((edge) =>
    ownedEdgeIds.has(edge.adapterId) &&
    (
      edge.target.toLowerCase() === normalized ||
      edge.poolId?.toLowerCase() === normalized
    )
  );
}

function observedPoolIdentity(
  observation: SwapObservationCapability,
  log: SwapEventLog,
): string | null {
  try {
    return observation.observedPoolIdentity(log)?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function unresolvedForLog(
  reason: PoolImpactUnresolvedReason,
  log: SwapEventLog,
  logIndex: number,
  group: ObservationGroup,
  detail: string,
): PoolImpactUnresolved {
  return {
    reason,
    pool: observedPoolIdentity(group.observation, log),
    logIndex,
    familyIds: group.familyIds,
    detail,
  };
}

function transferOnlyCandidates(
  logs: readonly SwapEventLog[],
  graph: readonly TokenEdge[],
  _broadPoolAddrs: Map<string, string> | null | undefined,
  coveredPools: ReadonlySet<string>,
): PoolImpactUnresolved[] {
  // Transfer evidence never claims family ownership. Only a touch of an
  // already-admitted graph target blocks hash-only replay; broad-map/unknown
  // addresses remain non-actionable diagnostics and cannot poison the receipt.
  const candidates = new Set<string>(
    graph.map((edge) => edge.target.toLowerCase()),
  );
  const touches = new Map<
    string,
    { ins: Set<string>; outs: Set<string>; firstLog: number }
  >();
  for (let logIndex = 0; logIndex < logs.length; logIndex++) {
    const log = logs[logIndex];
    if (
      log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC ||
      log.topics.length < 3
    ) {
      continue;
    }
    const from = indexedTopicAddress(log.topics[1]);
    const to = indexedTopicAddress(log.topics[2]);
    if (!from || !to) continue;
    const token = log.address.toLowerCase();
    if (candidates.has(to)) {
      const entry = touches.get(to) ?? {
        ins: new Set<string>(),
        outs: new Set<string>(),
        firstLog: logIndex,
      };
      entry.ins.add(token);
      touches.set(to, entry);
    }
    if (candidates.has(from)) {
      const entry = touches.get(from) ?? {
        ins: new Set<string>(),
        outs: new Set<string>(),
        firstLog: logIndex,
      };
      entry.outs.add(token);
      touches.set(from, entry);
    }
  }

  const unresolved: PoolImpactUnresolved[] = [];
  for (const [pool, touch] of touches) {
    if (coveredPools.has(pool)) continue;
    if (
      ![...touch.ins].some((tokenIn) =>
        [...touch.outs].some((tokenOut) => tokenOut !== tokenIn)
      )
    ) {
      continue;
    }
    unresolved.push({
      reason: "transfer-only-candidate",
      pool,
      logIndex: touch.firstLog,
      familyIds: [],
      detail:
        "paired Transfers nominate a candidate but do not prove a swap family/direction",
    });
  }
  return unresolved;
}

function dedupeSameObservationSteps(
  steps: readonly PoolImpactStep[],
): PoolImpactStep[] {
  const byKey = new Map<string, PoolImpactStep>();
  for (const step of steps) {
    const key = semanticImpactKey(step.impact);
    const existing = byKey.get(key);
    if (
      !existing ||
      hasExactPostState(step.impact) ||
      !hasExactPostState(existing.impact)
    ) {
      byKey.set(key, step);
    }
  }
  return [...byKey.values()];
}

function dedupeExactSameLog(
  steps: readonly PoolImpactStep[],
): PoolImpactStep[] {
  const byKey = new Map<string, PoolImpactStep>();
  for (const step of steps) {
    const key = [
      step.origin,
      step.logIndex ?? "direct",
      semanticImpactKey(step.impact),
    ].join("|");
    const existing = byKey.get(key);
    if (
      !existing ||
      hasExactPostState(step.impact) ||
      !hasExactPostState(existing.impact)
    ) {
      byKey.set(key, step);
    }
  }
  return [...byKey.values()];
}

function groupEdgesByTarget(
  graph: readonly TokenEdge[],
): Map<string, readonly TokenEdge[]> {
  const mutable = new Map<string, TokenEdge[]>();
  for (const edge of graph) {
    const key = edge.target.toLowerCase();
    const edges = mutable.get(key) ?? [];
    edges.push(edge);
    mutable.set(key, edges);
  }
  return new Map(mutable);
}

function impactStateKey(impact: PoolImpact): string {
  return [
    impact.pool.toLowerCase(),
    impact.poolId?.toLowerCase() ?? "",
  ].join("|");
}

function semanticImpactKey(impact: PoolImpact): string {
  return [
    impactStateKey(impact),
    impact.tokenIn.toLowerCase(),
    impact.tokenOut.toLowerCase(),
    impact.amountIn.toString(),
    impact.matchedAdapterId,
  ].join("|");
}

function hasExactPostState(impact: PoolImpact): boolean {
  return Boolean(
    impact.v2PostState ||
      impact.v3PostState ||
      impact.v4PostState,
  );
}

function compareSteps(left: PoolImpactStep, right: PoolImpactStep): number {
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  return (left.logIndex ?? -1) - (right.logIndex ?? -1);
}

function indexedTopicAddress(topic: string | undefined): string | null {
  if (!topic || topic.length !== 66) return null;
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function dedupeUnresolved(
  values: readonly PoolImpactUnresolved[],
): PoolImpactUnresolved[] {
  const unique = new Map<string, PoolImpactUnresolved>();
  for (const value of values) {
    const key = [
      value.reason,
      value.pool?.toLowerCase() ?? "",
      value.logIndex ?? "",
      [...value.familyIds].sort().join(","),
      value.detail,
    ].join("|");
    unique.set(key, value);
  }
  return [...unique.values()];
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .slice(0, 240);
}
