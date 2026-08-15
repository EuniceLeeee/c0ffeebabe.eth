import { ethers } from "ethers";
import {
  exercisedStage,
} from "./architecture-migration-capture.js";
import type {
  RawFamilyMigrationCaseCapture,
  RawMigrationSemanticItem,
  RawMigrationStageCapture,
} from "./architecture-migration-parity-runner.js";
import { projectFamilyRouteGraph } from "./adapter-family-graph-runtime.js";
import {
  buildFundingBorrowFragment,
  buildFundingRepaymentFragment,
  executeFundingFamilyLiquidity,
  type PreparedFundingOffer,
} from "./adapter-funding-runtime.js";
import {
  buildCreditExecutionFragment,
  executeCreditRiskQuote,
  issueCreditExecutionHandle,
  prepareCreditFamilyRoutes,
  projectCreditRouteGraph,
} from "./adapter-credit-runtime.js";
import type { CentralAdapterRuntime } from "./adapter-work-intent.js";
import { runStrictFamilyLifecycle } from
  "./strict-family-lifecycle-runner.js";
import {
  buildFamilyExecutionFragment,
  executeCreditFamilyInstanceLifecycle,
  executeFamilyExactQuote,
  type AdapterFamilyPublication,
  type PreparedFamilyInstance,
} from "./venues/adapter-family-runtime.js";
import type {
  CaptureObservationIntent,
  CreditCaptureVector,
  FamilyCaptureDescriptor,
  FamilyCaptureVector,
  FundingCaptureVector,
  RouteCaptureVector,
  UnifiedObservation,
} from "./venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import {
  hashCanonical,
  type CanonicalValue,
} from "./venues/canonical-value.js";
import {
  definedFamilyPluginContractSummary,
} from "./venues/adapter-family-plugin.js";
import type {
  FamilyCapabilityCatalog,
  LoadedFamilyBox,
  LoadedFamilyPlugin,
} from "./venues/family-capability-catalog.js";
import type { PlanFragment } from "./venues/route-leg-adapter.js";

export interface GenericCaptureProvider {
  call(
    transaction: { readonly to: string; readonly data: string },
    blockTag?: number,
  ): Promise<string>;
  getCode(address: string, blockTag?: number): Promise<string>;
  getStorage(
    address: string,
    slot: string,
    blockTag?: number,
  ): Promise<string>;
  getLogs(filter: {
    readonly address?: string;
    readonly fromBlock?: number;
    readonly toBlock?: number;
    readonly topics?: (string | null)[];
  }): Promise<readonly {
    readonly address: string;
    readonly topics: readonly string[];
    readonly data: string;
    readonly transactionHash?: string;
  }[]>;
  getTransactionReceipt(transactionHash: string): Promise<{
    readonly logs: readonly {
      readonly index?: number;
      readonly logIndex?: number;
      readonly address: string;
      readonly topics: readonly string[];
      readonly data: string;
      readonly transactionHash?: string;
    }[];
  } | null>;
  send(method: string, params: readonly unknown[]): Promise<unknown>;
}

export type GenericCaptureFinalSimulationInput =
  | {
      readonly kind: "route";
      readonly family: LoadedFamilyPlugin;
      readonly source: CanonicalSource;
      readonly vector: RouteCaptureVector;
      readonly routeFragment: PlanFragment;
      readonly funding: GenericCaptureFundingPlan;
      readonly semanticId: string;
    }
  | {
      readonly kind: "funding";
      readonly family: LoadedFamilyBox;
      readonly source: CanonicalSource;
      readonly vector: FundingCaptureVector;
      readonly funding: GenericCaptureFundingPlan;
      readonly semanticId: string;
    }
  | {
      readonly kind: "credit";
      readonly family: LoadedFamilyBox;
      readonly source: CanonicalSource;
      readonly vector: CreditCaptureVector;
      readonly routeFragment: PlanFragment;
      readonly funding: GenericCaptureFundingPlan;
      readonly semanticId: string;
    };

export interface GenericCaptureFundingPlan {
  readonly family: LoadedFamilyBox;
  readonly offer: PreparedFundingOffer;
  readonly amount: bigint;
  readonly minProfit: bigint;
  readonly borrowFragment: PlanFragment;
  readonly repaymentFragment: PlanFragment;
}

export type GenericCaptureFundingPlanFactory = (input: {
  readonly assets: readonly string[];
  readonly amount: bigint;
  readonly minProfit: bigint;
  readonly source: CanonicalSource;
}) => Promise<GenericCaptureFundingPlan>;

/**
 * The capture core never infers success from expected effects. A composition
 * root must execute the exact fragment/closed plan with the mandatory reserved
 * final-sim runtime and return its machine result here.
 */
export interface GenericCaptureFinalSimulation {
  simulate(
    input: GenericCaptureFinalSimulationInput,
  ): Promise<CanonicalValue>;
}

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const GENERIC_LOG_QUERY_BLOCK_SPAN = 100_000;

export async function runGenericCaptureWorkItem<T>(input: {
  readonly id: string;
  readonly timeoutMs: number;
  readonly run: () => Promise<T>;
  readonly cancel: () => void;
}): Promise<T> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("generic capture work-item timeout must be positive");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      input.run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          input.cancel();
          reject(new Error(`${input.id} exceeded ${input.timeoutMs}ms`));
        }, input.timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runGenericCaptureBatch<T>(input: {
  readonly items: readonly {
    readonly id: string;
    readonly timeoutMs: number;
    readonly run: () => Promise<T>;
    readonly cancel: () => void;
  }[];
  readonly onFailure: (id: string, error: unknown) => void;
}): Promise<readonly T[]> {
  const completed: T[] = [];
  for (const item of input.items) {
    try {
      completed.push(await runGenericCaptureWorkItem(item));
    } catch (error) {
      input.onFailure(item.id, error);
    }
  }
  return Object.freeze(completed);
}

export async function executeCaptureObservationIntents(input: {
  readonly family: LoadedFamilyBox;
  readonly source: CanonicalSource;
  readonly intents: readonly CaptureObservationIntent[];
  readonly provider: GenericCaptureProvider;
}): Promise<readonly UnifiedObservation[]> {
  const observations: UnifiedObservation[] = [];
  for (const intent of input.intents) {
    observations.push(await executeObservationIntent({
      ...input,
      intent,
    }));
  }
  return Object.freeze(observations);
}

async function executeObservationIntent(input: {
  readonly family: LoadedFamilyBox;
  readonly source: CanonicalSource;
  readonly intent: CaptureObservationIntent;
  readonly provider: GenericCaptureProvider;
}): Promise<UnifiedObservation> {
  const { intent } = input;
  if (intent.kind === "provided-observation") {
    assertObservationSource(intent.observation, input.source);
    return intent.observation;
  }
  if (intent.kind === "address-surface") {
    const address = ethers.getAddress(intent.address).toLowerCase();
    const [code, implementationWord] = await Promise.all([
      input.provider.getCode(address, input.source.number),
      input.provider.getStorage(
        address,
        EIP1967_IMPLEMENTATION_SLOT,
        input.source.number,
      ),
    ]);
    if (!ethers.isHexString(code) || code === "0x") {
      throw new Error("capture address surface has no deployed code");
    }
    return Object.freeze({
      kind: "address-surface" as const,
      source: input.source,
      address,
      codeHash: ethers.keccak256(code),
      implementationWord: ethers.zeroPadValue(implementationWord, 32)
        .toLowerCase(),
      interfaceFingerprints: intent.interfaceFingerprints,
    });
  }
  if (intent.kind === "declared-log") {
    const discovery = requireDiscovery(input.family);
    const pattern = discovery.logPatterns?.find((candidate) =>
      candidate.id === intent.patternId
    );
    const emitter = pattern?.emitter;
    if (
      pattern === undefined ||
      emitter === undefined ||
      emitter.mode === "address"
    ) {
      throw new Error("capture declared-log has no singleton declaration");
    }
    const identityTopic = emitter.mode === "singleton-indexed-address"
      ? ethers.zeroPadValue(
          ethers.getAddress(intent.candidateIdentity),
          32,
        ).toLowerCase()
      : normalizeWord(intent.candidateIdentity, "capture log identity");
    const topics: (string | null)[] = [pattern.topic.toLowerCase()];
    while (topics.length < emitter.topicIndex) topics.push(null);
    topics.push(identityTopic);
    const log = await findLatestDeclaredLog({
      provider: input.provider,
      address: emitter.address,
      fromBlock: emitter.fromBlock,
      toBlock: input.source.number,
      topics,
    });
    if (log === null) {
      throw new Error("capture declared singleton log was not found");
    }
    return Object.freeze({
      kind: "log" as const,
      source: input.source,
      address: ethers.getAddress(log.address).toLowerCase(),
      topics: Object.freeze(log.topics.map((topic) => topic.toLowerCase())),
      data: log.data.toLowerCase(),
      ...(log.transactionHash === undefined
        ? {}
        : { transactionHash: log.transactionHash.toLowerCase() }),
    });
  }
  if (intent.kind === "observed-log") {
    const receipt = await input.provider.getTransactionReceipt(
      intent.transactionHash,
    );
    const log = receipt?.logs.find((candidate, index) =>
      (candidate.index ?? candidate.logIndex ?? index) === intent.logIndex
    );
    if (log === undefined) {
      throw new Error("capture observed log is absent from its receipt");
    }
    return Object.freeze({
      kind: "log" as const,
      source: input.source,
      address: ethers.getAddress(log.address).toLowerCase(),
      topics: Object.freeze(log.topics.map((topic) => topic.toLowerCase())),
      data: log.data.toLowerCase(),
      transactionHash: intent.transactionHash.toLowerCase(),
    });
  }
  const trace = await input.provider.send("debug_traceTransaction", [
    intent.transactionHash,
    { tracer: "callTracer" },
  ]);
  const call = traceCallAt(trace, intent.traceAddress);
  return Object.freeze({
    kind: "call" as const,
    source: input.source,
    target: ethers.getAddress(call.to).toLowerCase(),
    sender: ethers.getAddress(call.from).toLowerCase(),
    data: normalizeData(call.input, "capture observed call input"),
    transactionHash: intent.transactionHash.toLowerCase(),
  });
}

async function findLatestDeclaredLog(input: {
  readonly provider: GenericCaptureProvider;
  readonly address: string;
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly topics: readonly (string | null)[];
}): Promise<Awaited<ReturnType<GenericCaptureProvider["getLogs"]>>[number] | null> {
  let toBlock = input.toBlock;
  while (toBlock >= input.fromBlock) {
    const fromBlock = Math.max(
      input.fromBlock,
      toBlock - GENERIC_LOG_QUERY_BLOCK_SPAN + 1,
    );
    const logs = await input.provider.getLogs({
      address: input.address,
      fromBlock,
      toBlock,
      topics: [...input.topics],
    });
    const latest = logs.at(-1);
    if (latest !== undefined) return latest;
    toBlock = fromBlock - 1;
  }
  return null;
}

export async function captureFamilyGenerically(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly descriptor: FamilyCaptureDescriptor;
  readonly provider: GenericCaptureProvider;
  readonly runtime: CentralAdapterRuntime;
  readonly finalSimulation: GenericCaptureFinalSimulation;
  readonly fundingPlan?: GenericCaptureFundingPlan;
  readonly fundingPlanFactory?: GenericCaptureFundingPlanFactory;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const family = input.catalog.forStrictFamily(input.descriptor.familyId);
  if (family.plugin.capture === undefined) {
    throw new Error("catalog Family has no capture materialization");
  }
  const vector = family.plugin.capture.materialize(input.descriptor);
  const evidenceRefs = captureEvidenceRefs(input.descriptor);
  const stages = vector.kind === "funding"
    ? await captureFunding({ ...input, family, vector, evidenceRefs })
    : vector.kind === "credit"
      ? await captureCredit({
          ...input,
          family,
          vector,
          evidenceRefs,
          fundingPlanFactory: requireFundingPlanFactory(input),
        })
      : await captureRoute({
          ...input,
          family: input.catalog.forFamily(input.descriptor.familyId),
          vector,
          evidenceRefs,
          fundingPlanFactory: requireFundingPlanFactory(input),
        });
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: input.descriptor.familyId,
    caseId: input.caseId ??
      `${input.descriptor.familyId}:${input.descriptor.candidateIdentity}:` +
        `${input.descriptor.source.number}`,
    inputFingerprint: hashCanonical(input.descriptor as unknown as CanonicalValue),
    stateAnchorNumber: input.descriptor.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages,
  });
}

async function captureRoute(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly descriptor: FamilyCaptureDescriptor;
  readonly provider: GenericCaptureProvider;
  readonly runtime: CentralAdapterRuntime;
  readonly finalSimulation: GenericCaptureFinalSimulation;
  readonly family: LoadedFamilyPlugin;
  readonly vector: RouteCaptureVector;
  readonly evidenceRefs: readonly string[];
  readonly fundingPlanFactory: GenericCaptureFundingPlanFactory;
}): Promise<RawFamilyMigrationCaseCapture["stages"]> {
  const observations = await executeCaptureObservationIntents({
    family: input.family,
    source: input.descriptor.source,
    intents: input.vector.observations,
    provider: input.provider,
  });
  const publication = await runStrictFamilyLifecycle({
    catalog: input.catalog,
    familyId: input.descriptor.familyId,
    source: input.descriptor.source,
    observations,
    runtime: input.runtime,
  });
  const graph = routeGraphItems(input.family, publication);
  const exactItems: RawMigrationSemanticItem[] = [];
  const executionItems: RawMigrationSemanticItem[] = [];
  const simulationItems: RawMigrationSemanticItem[] = [];
  for (const instance of publication.instances) {
    for (const route of [...instance.routeHandles].sort((left, right) =>
      left.routeKey.localeCompare(right.routeKey)
    )) {
      // Capture amount normalization (central tooling, no protocol
      // semantics): the descriptor amount is a raw integer and cannot be
      // scaled correctly for every token (a 1e18 raw amount is 1 token of
      // an 18-decimal asset but a quadrillion units of a 6-decimal one).
      // Normalize per route to one unit of the route input token via the
      // universal ERC20 decimals() read (fallback to the descriptor amount
      // on unreadable tokens), so exact quotes and the funding plan match
      // the real borrowable surface regardless of decimals.
      const routeDescriptor = instance.routes.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (routeDescriptor === undefined) {
        throw new Error("capture route descriptor missing");
      }
      const amountIn = await normalizedCaptureAmount({
        provider: input.provider,
        tokenIn: routeDescriptor.tokenIn,
        source: input.descriptor.source,
        fallback: input.vector.amountIn,
      });
      const exact = await executeFamilyExactQuote({
        family: input.family,
        route,
        amountIn,
        executor: input.vector.executor,
        runtimeEvidence: input.vector.runtimeEvidence,
        source: input.descriptor.source,
        generation: input.descriptor.source.generation,
        runtime: input.runtime,
      });
      if (exact.status !== "resolved") {
        throw new Error(`capture exact failed: ${exact.outcome.reasonCode}`);
      }
      const semanticId = `${route.routeKey}\u001f${amountIn}`;
      exactItems.push(semanticItem(`${semanticId}:exact`, {
        routeKey: route.routeKey,
        amountIn: exact.amountIn.toString(),
        amountOut: exact.amountOut.toString(),
        methodId: exact.methodId,
        evidenceRefs: exact.evidenceRefs,
      }));
      const execution = buildFamilyExecutionFragment({
        family: input.family,
        actionOwnership: input.catalog,
        route,
        exact,
        minAmountOut: input.vector.minAmountOut,
        executor: input.vector.executor,
        runtimeEvidence: input.vector.runtimeEvidence,
      });
      if (execution.status !== "resolved") {
        throw new Error(`capture execution failed: ${execution.outcome.reasonCode}`);
      }
      executionItems.push(fragmentItem(`${semanticId}:execution`, execution.fragment));
      const routeRoot = execution.fragment.nodes[0];
      if (routeRoot === undefined) {
        throw new Error("capture execution fragment has no route root");
      }
      // The funding plan is decided by the route's input vector, not by
      // the execution fragment root: fragment nodes may carry placeholder
      // token fields (take/settle/wrap), which would make the funding
      // asset address invalid and the plan fail closed.
      const funding = await input.fundingPlanFactory({
        assets: Object.freeze([routeDescriptor.tokenIn]),
        amount: amountIn,
        minProfit: input.vector.minAmountOut,
        source: input.descriptor.source,
      });
      const simulation = await input.finalSimulation.simulate({
        kind: "route",
        family: input.family,
        source: input.descriptor.source,
        vector: input.vector,
        routeFragment: execution.fragment,
        funding,
        semanticId,
      });
      simulationItems.push(semanticItem(`${semanticId}:final-sim`, simulation));
    }
  }
  return routeStages(publication, graph, exactItems, executionItems,
    simulationItems, input.evidenceRefs);
}


async function normalizedCaptureAmount(input: {
  readonly provider: GenericCaptureProvider;
  readonly tokenIn: string;
  readonly source: CanonicalSource;
  readonly fallback: bigint;
}): Promise<bigint> {
  const ERC20 = new ethers.Interface([
    "function decimals() view returns (uint8)",
  ]);
  try {
    const raw = await input.provider.call(
      { to: input.tokenIn, data: ERC20.encodeFunctionData("decimals") },
      input.source.number,
    );
    if (!ethers.isHexString(raw) || ethers.dataLength(raw) !== 32) {
      return input.fallback;
    }
    const decoded = ERC20.decodeFunctionResult("decimals", raw) as unknown;
    const decimals = Number(
      (decoded as { readonly [index: number]: unknown })[0] ?? "",
    );
    if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 77) {
      return input.fallback;
    }
    return 10n ** BigInt(decimals);
  } catch {
    return input.fallback;
  }
}
async function captureFunding(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly descriptor: FamilyCaptureDescriptor;
  readonly runtime: CentralAdapterRuntime;
  readonly finalSimulation: GenericCaptureFinalSimulation;
  readonly family: LoadedFamilyBox;
  readonly vector: FundingCaptureVector;
  readonly evidenceRefs: readonly string[];
}): Promise<RawFamilyMigrationCaseCapture["stages"]> {
  let publication: import("./adapter-funding-runtime.js").FundingFamilyPublication |
    null = null;
  const result = await executeFundingFamilyLiquidity({
    family: input.family,
    assets: input.vector.assets,
    source: input.descriptor.source,
    generation: input.descriptor.source.generation,
    runtime: input.runtime,
    publisher: { publish: (value) => { publication = value; } },
  });
  if (publication === null || result.publication === null) {
    throw new Error("capture Funding Family did not publish");
  }
  const instances: RawMigrationSemanticItem[] = [];
  const executions: RawMigrationSemanticItem[] = [];
  const simulations: RawMigrationSemanticItem[] = [];
  for (const offer of result.offers) {
    if (input.vector.amount > offer.maxBorrow) continue;
    const semanticId = `${offer.fundingId}\u001f${input.vector.amount}`;
    instances.push(semanticItem(offer.fundingId, {
      familyId: offer.familyId,
      fundingId: offer.fundingId,
      asset: offer.asset,
      maxBorrow: offer.maxBorrow.toString(),
      fee: offer.fee.toString(),
    }));
    const fragment = buildFundingBorrowFragment({
      family: input.family,
      offer,
      source: input.descriptor.source,
      generation: input.descriptor.source.generation,
      amount: input.vector.amount,
      minProfit: input.vector.minProfit,
      children: Object.freeze([]),
    });
    const repaymentFragment = buildFundingRepaymentFragment({
      family: input.family,
      offer,
      source: input.descriptor.source,
      generation: input.descriptor.source.generation,
      amount: input.vector.amount,
    });
    const funding = Object.freeze({
      family: input.family,
      offer,
      amount: input.vector.amount,
      minProfit: input.vector.minProfit,
      borrowFragment: fragment,
      repaymentFragment,
    });
    executions.push(fragmentItem(`${semanticId}:execution`, fragment));
    simulations.push(semanticItem(
      `${semanticId}:final-sim`,
      await input.finalSimulation.simulate({
        kind: "funding",
        family: input.family,
        source: input.descriptor.source,
        vector: input.vector,
        funding,
        semanticId,
      }),
    ));
  }
  if (instances.length === 0) {
    throw new Error("capture Funding Family has no executable offer");
  }
  return Object.freeze({
    instances: exercisedStage(instances, input.evidenceRefs),
    edges: declaredAbsent(input.evidenceRefs),
    stateCoverage: declaredAbsent(input.evidenceRefs),
    pricedEdges: declaredAbsent(input.evidenceRefs),
    prices: declaredAbsent(input.evidenceRefs),
    failures: exercisedStage([], input.evidenceRefs),
    enumeratedRoutes: declaredAbsent(input.evidenceRefs),
    exactQuotes: declaredAbsent(input.evidenceRefs),
    executionFragments: exercisedStage(executions, input.evidenceRefs),
    finalSimulations: exercisedStage(simulations, input.evidenceRefs),
  });
}

async function captureCredit(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly descriptor: FamilyCaptureDescriptor;
  readonly provider: GenericCaptureProvider;
  readonly runtime: CentralAdapterRuntime;
  readonly finalSimulation: GenericCaptureFinalSimulation;
  readonly family: LoadedFamilyBox;
  readonly vector: CreditCaptureVector;
  readonly evidenceRefs: readonly string[];
  readonly fundingPlanFactory: GenericCaptureFundingPlanFactory;
}): Promise<RawFamilyMigrationCaseCapture["stages"]> {
  const observations = await executeCaptureObservationIntents({
    family: input.family,
    source: input.descriptor.source,
    intents: input.vector.observations,
    provider: input.provider,
  });
  const matches = observations.flatMap((observation) =>
    input.catalog.matches(observation)
      .filter((match) => match.familyId === input.descriptor.familyId)
      .map((match) => ({ observation, matchedPatternId: match.patternId }))
  );
  if (matches.length === 0) throw new Error("capture Credit has no match");
  const instances: PreparedFamilyInstance[] = [];
  for (const match of matches) {
    const result = await executeCreditFamilyInstanceLifecycle({
      family: input.family,
      match,
      source: input.descriptor.source,
      generation: input.descriptor.source.generation,
      runtime: input.runtime,
    });
    if (result.instance !== null) instances.push(result.instance);
  }
  if (instances.length === 0) {
    throw new Error("capture Credit Family did not issue an instance");
  }
  const edges: RawMigrationSemanticItem[] = [];
  const exacts: RawMigrationSemanticItem[] = [];
  const executions: RawMigrationSemanticItem[] = [];
  const simulations: RawMigrationSemanticItem[] = [];
  for (const instance of instances) {
    const routes = prepareCreditFamilyRoutes({
      family: input.family,
      instance,
      source: input.descriptor.source,
      generation: input.descriptor.source.generation,
    });
    for (const route of routes.routes) {
      const projected = projectCreditRouteGraph({ family: input.family, route });
      edges.push(semanticItem(projected.edge.canonicalEdgeId, {
        routeKey: route.routeKey,
        tokenIn: projected.edge.tokenIn,
        tokenOut: projected.edge.tokenOut,
      }));
      const risk = await executeCreditRiskQuote({
        family: input.family,
        route,
        collateralAmount: input.vector.collateralAmount,
        debtBps: input.vector.debtBps,
        executor: input.vector.executor,
        runtimeEvidence: input.vector.runtimeEvidence,
        source: input.descriptor.source,
        generation: input.descriptor.source.generation,
        runtime: input.runtime,
      });
      if (risk.status !== "resolved") {
        throw new Error(`capture Credit risk failed: ${risk.reasonCode}`);
      }
      const semanticId = `${route.routeKey}\u001f${input.vector.collateralAmount}`;
      exacts.push(semanticItem(`${semanticId}:risk`, {
        routeKey: route.routeKey,
        collateralAmount: risk.collateralAmount.toString(),
        amountOut: risk.amountOut.toString(),
        debtBps: risk.debtBps.toString(),
        evidenceRefs: risk.evidenceRefs,
      }));
      const handle = issueCreditExecutionHandle({
        family: input.family,
        route,
        risk,
        minAmountOut: input.vector.minAmountOut,
        executor: input.vector.executor,
        runtimeEvidence: input.vector.runtimeEvidence,
        source: input.descriptor.source,
        generation: input.descriptor.source.generation,
      });
      const execution = buildCreditExecutionFragment({
        family: input.family,
        actionOwnership: input.catalog,
        handle,
      });
      if (execution.status !== "resolved") {
        throw new Error(`capture Credit execution failed: ${execution.reasonCode}`);
      }
      executions.push(fragmentItem(`${semanticId}:execution`, execution.fragment));
      const funding = await input.fundingPlanFactory({
        assets: Object.freeze([projected.edge.tokenIn]),
        amount: input.vector.collateralAmount,
        minProfit: input.vector.minAmountOut,
        source: input.descriptor.source,
      });
      simulations.push(semanticItem(
        `${semanticId}:final-sim`,
        await input.finalSimulation.simulate({
          kind: "credit",
          family: input.family,
          source: input.descriptor.source,
          vector: input.vector,
          routeFragment: execution.fragment,
          funding,
          semanticId,
        }),
      ));
    }
  }
  const instanceItems = instances.map((instance) => semanticItem(
    instance.instanceKey,
    {
      familyId: instance.familyId,
      instanceKey: instance.instanceKey,
      staticBindingFingerprint: instance.staticBindingFingerprint,
    },
  ));
  return Object.freeze({
    instances: exercisedStage(instanceItems, input.evidenceRefs),
    edges: exercisedStage(edges, input.evidenceRefs),
    stateCoverage: declaredAbsent(input.evidenceRefs),
    pricedEdges: declaredAbsent(input.evidenceRefs),
    prices: declaredAbsent(input.evidenceRefs),
    failures: exercisedStage([], input.evidenceRefs),
    enumeratedRoutes: exercisedStage(orderedRoutes(edges), input.evidenceRefs),
    exactQuotes: declaredAbsent(input.evidenceRefs),
    executionFragments: exercisedStage(executions, input.evidenceRefs),
    finalSimulations: exercisedStage(simulations, input.evidenceRefs),
  });
}

function routeStages(
  publication: AdapterFamilyPublication,
  graph: ReturnType<typeof routeGraphItems>,
  exactItems: readonly RawMigrationSemanticItem[],
  executionItems: readonly RawMigrationSemanticItem[],
  simulationItems: readonly RawMigrationSemanticItem[],
  evidenceRefs: readonly string[],
): RawFamilyMigrationCaseCapture["stages"] {
  return Object.freeze({
    instances: instanceStage(publication.instances, evidenceRefs),
    edges: exercisedStage(graph.edges, evidenceRefs),
    stateCoverage: exercisedStage(graph.coverage, evidenceRefs),
    pricedEdges: exercisedStage(graph.pricedEdges, evidenceRefs),
    prices: exercisedStage(graph.prices, evidenceRefs),
    failures: exercisedStage([], evidenceRefs),
    enumeratedRoutes: exercisedStage(orderedRoutes(graph.edges), evidenceRefs),
    exactQuotes: exercisedStage(exactItems, evidenceRefs),
    executionFragments: exercisedStage(executionItems, evidenceRefs),
    finalSimulations: exercisedStage(simulationItems, evidenceRefs),
  });
}

function routeGraphItems(
  family: LoadedFamilyPlugin,
  publication: AdapterFamilyPublication,
): {
  readonly edges: readonly RawMigrationSemanticItem[];
  readonly coverage: readonly RawMigrationSemanticItem[];
  readonly pricedEdges: readonly RawMigrationSemanticItem[];
  readonly prices: readonly RawMigrationSemanticItem[];
} {
  const edges: RawMigrationSemanticItem[] = [];
  const coverage: RawMigrationSemanticItem[] = [];
  const pricedEdges: RawMigrationSemanticItem[] = [];
  const prices: RawMigrationSemanticItem[] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) throw new Error("capture route handle missing");
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(semanticItem(projected.edge.canonicalEdgeId, {
        routeKey: route.routeKey,
        tokenIn: route.tokenIn,
        tokenOut: route.tokenOut,
        canonicalEdgeId: projected.edge.canonicalEdgeId,
      }));
    }
    const routes = new Map(instance.routes.map((route) => [route.routeKey, route]));
    for (const pricing of instance.pricingInstances) {
      coverage.push(semanticItem(pricing.stateKey, {
        instanceKey: instance.instanceKey,
        stateKey: pricing.stateKey,
      }));
      for (const [routeKey, mid] of pricing.mids) {
        const route = routes.get(routeKey);
        if (route === undefined) throw new Error("capture pricing route missing");
        const id = `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
          route.tokenOut.toLowerCase();
        prices.push(semanticItem(id, {
          stateKey: pricing.stateKey,
          mid: mid as unknown as CanonicalValue,
        }));
        pricedEdges.push(semanticItem(id, { routeKey, stateKey: pricing.stateKey }));
      }
    }
  }
  return Object.freeze({
    edges: Object.freeze(edges),
    coverage: Object.freeze(coverage),
    pricedEdges: Object.freeze(pricedEdges),
    prices: Object.freeze(prices),
  });
}

function instanceStage(
  instances: readonly PreparedFamilyInstance[],
  evidenceRefs: readonly string[],
): RawMigrationStageCapture {
  return exercisedStage(instances.map((instance) => semanticItem(
    instance.instanceKey,
    {
      familyId: instance.familyId,
      instanceKey: instance.instanceKey,
      staticBindingFingerprint: instance.staticBindingFingerprint,
    },
  )), evidenceRefs);
}

function orderedRoutes(
  edges: readonly RawMigrationSemanticItem[],
): readonly RawMigrationSemanticItem[] {
  return [...edges].sort((left, right) => left.id.localeCompare(right.id))
    .map((edge, order) => semanticItem(edge.id, {
      edgeId: edge.id,
      order,
    }));
}

function fragmentItem(id: string, fragment: PlanFragment): RawMigrationSemanticItem {
  return semanticItem(id, {
    fragmentHash: hashCanonical(fragment as unknown as CanonicalValue),
    fragment: fragment as unknown as CanonicalValue,
  });
}

function semanticItem(id: string, value: CanonicalValue): RawMigrationSemanticItem {
  hashCanonical(value);
  return Object.freeze({ id, value });
}

function declaredAbsent(evidenceRefs: readonly string[]): RawMigrationStageCapture {
  return Object.freeze({
    status: "declared-absent" as const,
    items: Object.freeze([]),
    evidenceRefs: Object.freeze([...evidenceRefs]),
    blocker: null,
  });
}

function captureEvidenceRefs(
  descriptor: FamilyCaptureDescriptor,
): readonly string[] {
  return Object.freeze([
    `onchain:1:${descriptor.source.hash}:catalog-capture:` +
      `${descriptor.familyId}:${descriptor.candidateIdentity.toLowerCase()}`,
  ]);
}

function requireFundingPlanFactory(input: {
  readonly fundingPlan?: GenericCaptureFundingPlan;
  readonly fundingPlanFactory?: GenericCaptureFundingPlanFactory;
}): GenericCaptureFundingPlanFactory {
  if (input.fundingPlanFactory !== undefined) return input.fundingPlanFactory;
  if (input.fundingPlan === undefined) {
    throw new Error("generic route capture requires a catalog-issued Funding plan");
  }
  return async () => input.fundingPlan!;
}

/**
 * Domain-generic Funding selection for a complete capture plan. The central
 * path only enumerates catalog capabilities and policy ranks; it knows no
 * Funding family, singleton, ABI or protocol identifier.
 */
export async function materializeGenericCaptureFundingPlan(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly assets: readonly string[];
  readonly amount: bigint;
  readonly minProfit: bigint;
  readonly source: CanonicalSource;
  readonly runtime: CentralAdapterRuntime;
}): Promise<GenericCaptureFundingPlan> {
  const candidates: GenericCaptureFundingPlan[] = [];
  const fundingOutcomes = new Map<string, readonly string[]>();
  for (const family of input.catalog.listAll()) {
    if (family.plugin.manifest.domain !== "funding") continue;
    const result = await executeFundingFamilyLiquidity({
      family,
      assets: input.assets,
      source: input.source,
      generation: input.source.generation,
      runtime: input.runtime,
      publisher: { publish() {} },
    });
    fundingOutcomes.set(
      family.plugin.manifest.familyId,
      Object.freeze(result.outcomes.map((outcome) =>
        `${outcome.status}:${outcome.reasonCode ?? "no-reason"}`,
      )),
    );
    for (const offer of result.offers) {
      if (offer.maxBorrow < input.amount) continue;
      const repaymentFragment = buildFundingRepaymentFragment({
        family,
        offer,
        source: input.source,
        generation: input.source.generation,
        amount: input.amount,
      });
      const borrowFragment = buildFundingBorrowFragment({
        family,
        offer,
        source: input.source,
        generation: input.source.generation,
        amount: input.amount,
        minProfit: input.minProfit,
        children: Object.freeze([]),
      });
      candidates.push(Object.freeze({
        family,
        offer,
        amount: input.amount,
        minProfit: input.minProfit,
        borrowFragment,
        repaymentFragment,
      }));
    }
  }
  candidates.sort((left, right) =>
    left.offer.planningPriority - right.offer.planningPriority ||
    left.offer.fundingId.localeCompare(right.offer.fundingId)
  );
  const selected = candidates[0];
  if (selected === undefined) {
    throw new Error(
      "generic capture has no executable catalog Funding offer; " +
        `funding outcomes=${JSON.stringify([...fundingOutcomes])}`,
    );
  }
  return selected;
}

function requireDiscovery(family: LoadedFamilyBox) {
  if (!("discovery" in family.plugin)) {
    throw new Error("capture observation requires discovery semantics");
  }
  return family.plugin.discovery;
}

function assertObservationSource(
  observation: UnifiedObservation,
  source: CanonicalSource,
): void {
  if (
    observation.source.number !== source.number ||
    observation.source.generation !== source.generation ||
    observation.source.hash.toLowerCase() !== source.hash.toLowerCase()
  ) {
    throw new Error("capture observation source mismatch");
  }
}

function normalizeWord(value: string, label: string): string {
  if (!ethers.isHexString(value, 32)) throw new Error(`${label} must be bytes32`);
  return value.toLowerCase();
}

function normalizeData(value: unknown, label: string): string {
  if (typeof value !== "string" || !ethers.isHexString(value)) {
    throw new Error(`${label} must be hex data`);
  }
  return value.toLowerCase();
}

function traceCallAt(
  trace: unknown,
  traceAddress: readonly number[],
): { readonly to: string; readonly from: string; readonly input: string } {
  let current = trace;
  for (const index of traceAddress) {
    if (
      current === null || typeof current !== "object" ||
      !Array.isArray((current as { calls?: unknown }).calls)
    ) {
      throw new Error("capture traceAddress has no call frame");
    }
    current = (current as { calls: readonly unknown[] }).calls[index];
  }
  if (current === null || typeof current !== "object") {
    throw new Error("capture trace frame is absent");
  }
  const frame = current as { to?: unknown; from?: unknown; input?: unknown };
  if (
    typeof frame.to !== "string" || typeof frame.from !== "string" ||
    typeof frame.input !== "string"
  ) {
    throw new Error("capture trace frame lacks from/to/input");
  }
  return { to: frame.to, from: frame.from, input: frame.input };
}
