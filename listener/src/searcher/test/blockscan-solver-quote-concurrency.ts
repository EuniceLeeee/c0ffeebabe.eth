import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AnvilSolver,
  type ResolvedPlan,
  type SolverTiming,
} from "../solver/solver.js";
import type { CandidatePlan } from "../planner/planner.js";
import type { TokenEdge } from "../planner/token-graph.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { StrictProductionRuntimeSession } from
  "../strict-production-runtime-session.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";

export const EXECUTOR = "0x00000000000000000000000000000000000000ee";
const TOKEN_A = "0x00000000000000000000000000000000000000a1";
const TOKEN_B = "0x00000000000000000000000000000000000000b1";
const PLAN_COUNT = 24;
const EXPECTED_EXACT_CALLS_PER_PLAN = 16; // 4 grid + 4 GSS, two hops; no finalist reissuance.

interface ExactBinding {
  readonly edge: TokenEdge;
  readonly amountIn: bigint;
  readonly creditDebtBps: bigint;
}

export type FixtureExactInput = Parameters<StrictProductionRuntimeSession["issueExact"]>[0];
export type FixtureExactHandle = Awaited<ReturnType<StrictProductionRuntimeSession["issueExact"]>>;
interface SessionOptions {
  readonly debtBps?: readonly bigint[];
  readonly safetyBps?: bigint;
  readonly quote?: (input: FixtureExactInput, leg: number) => Promise<bigint>;
  readonly onBuild?: () => void;
  readonly onExact?: (input: FixtureExactInput, handle: FixtureExactHandle) => void;
  readonly onBuildExecution?: (input: Parameters<StrictProductionRuntimeSession["buildExecution"]>[0]) => void;
}

interface SharedSessionFixture {
  readonly session: StrictProductionRuntimeSession;
  readonly stats: {
    calls: number;
    peakActivePlans: number;
  };
}

interface SolvedCandidate {
  readonly planIndex: number;
  readonly candidateIndex: number;
  readonly resolved: ResolvedPlan;
}

function address(value: number): string {
  return `0x${value.toString(16).padStart(40, "0")}`;
}

export function makePlans(count: number): CandidatePlan[] {
  return Array.from({ length: count }, (_, index) => {
    const first: TokenEdge = {
      adapterId: "univ2-swap",
      target: address(index * 2 + 1),
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      slotKind: "swap",
      ...deriveEdgeTaxonomy("swap"),
    };
    const second: TokenEdge = {
      adapterId: "univ2-swap",
      target: address(index * 2 + 2),
      tokenIn: TOKEN_B,
      tokenOut: TOKEN_A,
      slotKind: "swap",
      ...deriveEdgeTaxonomy("swap"),
    };
    const center = 1_024n + BigInt(index * 32);
    return {
      templateName: "flash-swap-repay",
      root: {} as CandidatePlan["root"],
      opportunity: {
        kind: "block-scan-arb",
        sourceBlock: 1,
        stateBlock: 1,
        cycleId: `quote-concurrency-${index}`,
        cycleFingerprint: `quote-concurrency-${index}`,
        seedEdges: [first, second],
        flashToken: TOKEN_A,
        startToken: TOKEN_A,
        profitToken: TOKEN_A,
        victimAmountIn: center,
        searchSeed: {
          startToken: TOKEN_A,
          searchCenter: center,
          maxInput: center * 4n,
        },
        leavesStandingPosition: false,
        hints: {},
        affectedPools: [first.target, second.target],
        affectedTokens: [TOKEN_A, TOKEN_B],
      },
      tokenPath: { edges: [first, second] },
      flashAdapterIds: ["morpho-flash"],
      flashAdapterId: "morpho-flash",
    };
  });
}

export function sharedSession(
  plans: readonly CandidatePlan[],
  options: SessionOptions = {},
): SharedSessionFixture {
  type ExactInput = Parameters<
    StrictProductionRuntimeSession["issueExact"]
  >[0];
  type ExactHandle = Awaited<ReturnType<
    StrictProductionRuntimeSession["issueExact"]
  >>;

  const planByTarget = new Map<string, { planIndex: number; leg: number }>();
  for (let planIndex = 0; planIndex < plans.length; planIndex++) {
    for (let leg = 0; leg < plans[planIndex]!.tokenPath.edges.length; leg++) {
      planByTarget.set(
        plans[planIndex]!.tokenPath.edges[leg]!.target.toLowerCase(),
        { planIndex, leg },
      );
    }
  }

  const issued = new WeakMap<object, ExactBinding>();
  const activeByPlan = new Map<number, number>();
  // A second hop must consume an output already returned by its first hop.
  // Distinct amount probes in the same plan may progress independently.
  const completedOutputs = new Map<string, number>();
  const stats = { calls: 0, peakActivePlans: 0 };
  const session = Object.freeze({
    edges: Object.freeze(plans.flatMap((plan) => plan.tokenPath.edges)),
    blocksPrefixInversion: () => options.debtBps !== undefined,
    creditDebtBpsCandidates: () => options.debtBps ?? Object.freeze([0n]),
    fundingActionIds: () => Object.freeze(["morpho-flash"]),
    async issueExact(input: ExactInput): Promise<ExactHandle> {
      const location = planByTarget.get(input.edge.target.toLowerCase());
      assert.ok(location, `unknown exact target ${input.edge.target}`);
      const outputKey = (amount: bigint): string =>
        `${location.planIndex}:${input.creditDebtBps ?? 0n}:${amount}`;
      if (location.leg > 0) {
        const key = outputKey(input.amountIn);
        const available = completedOutputs.get(key) ?? 0;
        assert.ok(available > 0,
          `plan ${location.planIndex} issued a dependent hop before its input was returned`);
        completedOutputs.set(key, available - 1);
      }
      activeByPlan.set(location.planIndex, (activeByPlan.get(location.planIndex) ?? 0) + 1);
      stats.calls++;
      stats.peakActivePlans = Math.max(
        stats.peakActivePlans,
        activeByPlan.size,
      );
      try {
        const amountOut = options.quote
          ? await options.quote(input, location.leg)
          : await new Promise<bigint>((resolve) => setImmediate(() => resolve(
              location.leg === 0 ? input.amountIn * 2n : (input.amountIn * 3n) / 5n,
            )));
        if (location.leg === 0) {
          const key = outputKey(amountOut * (options.safetyBps ?? 10000n) / 10000n);
          completedOutputs.set(key, (completedOutputs.get(key) ?? 0) + 1);
        }
        const handle = Object.freeze({ amountOut }) as ExactHandle;
        issued.set(handle as object, {
          edge: input.edge,
          amountIn: input.amountIn,
          creditDebtBps: input.creditDebtBps ?? 0n,
        });
        options.onExact?.(input, handle);
        return handle;
      } finally {
        const remaining = activeByPlan.get(location.planIndex)! - 1;
        if (remaining === 0) activeByPlan.delete(location.planIndex);
        else activeByPlan.set(location.planIndex, remaining);
      }
    },
    buildExecution(input: Parameters<
      StrictProductionRuntimeSession["buildExecution"]
    >[0]) {
      options.onBuild?.();
      const binding = issued.get(input.exact as object);
      assert.ok(binding, "execution used a foreign exact handle");
      assert.equal(binding.edge, input.edge, "execution changed the quoted edge");
      options.onBuildExecution?.(input);
      return Object.freeze({
        status: "resolved" as const,
        fragment: Object.freeze({
          requirements: Object.freeze([]),
          nodes: Object.freeze([Object.freeze({
            adapterId: input.edge.adapterId,
            target: input.edge.target,
            tokenIn: input.edge.tokenIn,
            tokenOut: input.edge.tokenOut,
            amount: binding.amountIn,
            params: Object.freeze({
              minAmountOut: input.minAmountOut,
              creditDebtBps: binding.creditDebtBps,
            }),
            children: Object.freeze([]),
          })]),
        }),
      });
    },
    buildFundingRoot(input: Parameters<
      StrictProductionRuntimeSession["buildFundingRoot"]
    >[0]) {
      options.onBuild?.();
      return Object.freeze({
        adapterId: input.actionAdapterId,
        target: input.asset,
        tokenIn: input.asset,
        tokenOut: input.asset,
        amount: input.amount,
        params: Object.freeze({ minProfit: input.minProfit }),
        children: Object.freeze([...input.children]),
      });
    },
  }) as unknown as StrictProductionRuntimeSession;
  return { session, stats };
}

async function solveWithConcurrency(
  plans: readonly CandidatePlan[],
  concurrency: number,
): Promise<{
  readonly candidates: readonly SolvedCandidate[];
  readonly exactCalls: number;
  readonly peakActivePlans: number;
}> {
  const fixture = sharedSession(plans);
  const queue = plans.map((plan, planIndex) => ({ plan, planIndex }));
  const candidates: SolvedCandidate[] = [];
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, queue.length) },
    () => new AnvilSolver(),
  );
  const probe = Object.freeze({
    executor: EXECUTOR,
    async simulate() {
      throw new Error("quote-only solver invoked phase-2 simulation");
    },
  });

  await Promise.all(workers.map(async (solver) => {
    for (;;) {
      const queued = queue[cursor++];
      if (!queued) return;
      const timing: SolverTiming = {
        quoteMs: 0,
        planBuildMs: 0,
        simMs: 0,
        amountPoints: 0,
        gssPoints: 0,
        hopExactCalls: 0,
      };
      let deferred: readonly ResolvedPlan[] = [];
      const returned = await solver.solve(
        queued.plan,
        {} as StateBackend,
        probe,
        {
          deferPhase2Sim: true,
          finalSimTopN: 3,
          gridHalfWidth: 2,
          gssMaxTries: 4,
          quoteSafetyBps: 10_000n,
          quoteProfitFloorBps: 0n,
          strictSession: fixture.session,
          onDeferredCandidates: (resolved) => {
            deferred = resolved;
          },
          timing,
        },
      );
      const resolved = deferred.length > 0 ? deferred : [returned];
      assert.equal(resolved.length, 3, "solver lost top-3 fallback candidates");
      assert.equal(timing.amountPoints, 8, "solver changed the 4+4 search budget");
      assert.equal(timing.gssPoints, 4, "solver changed the GSS budget");
      assert.equal(
        timing.hopExactCalls,
        EXPECTED_EXACT_CALLS_PER_PLAN,
        "solver changed exact propagation count",
      );
      assert.equal(timing.simMs, 0, "quote-only solver ran phase-2 simulation");
      for (let candidateIndex = 0; candidateIndex < resolved.length; candidateIndex++) {
        candidates.push({
          planIndex: queued.planIndex,
          candidateIndex,
          resolved: resolved[candidateIndex]!,
        });
      }
    }
  }));

  candidates.sort((a, b) =>
    a.planIndex - b.planIndex || a.candidateIndex - b.candidateIndex
  );
  return {
    candidates: Object.freeze(candidates),
    exactCalls: fixture.stats.calls,
    peakActivePlans: fixture.stats.peakActivePlans,
  };
}

export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? `${item}n` : item
  );
}

async function main(): Promise<void> {
  const plans = makePlans(PLAN_COUNT);
  const originalLog = console.log;
  let serial: Awaited<ReturnType<typeof solveWithConcurrency>>;
  let four: Awaited<ReturnType<typeof solveWithConcurrency>>;
  let sixteen: Awaited<ReturnType<typeof solveWithConcurrency>>;
  try {
    console.log = () => undefined;
    serial = await solveWithConcurrency(plans, 1);
    four = await solveWithConcurrency(plans, 4);
    sixteen = await solveWithConcurrency(plans, 16);
  } finally {
    console.log = originalLog;
  }

  assert.equal(canonical(four.candidates), canonical(serial.candidates));
  assert.equal(canonical(sixteen.candidates), canonical(serial.candidates));
  const expectedCalls = PLAN_COUNT * EXPECTED_EXACT_CALLS_PER_PLAN;
  assert.equal(serial.exactCalls, expectedCalls);
  assert.equal(four.exactCalls, expectedCalls);
  assert.equal(sixteen.exactCalls, expectedCalls);
  assert.equal(serial.peakActivePlans, 1);
  assert.equal(four.peakActivePlans, 4);
  assert.equal(sixteen.peakActivePlans, 16);

  console.log(
    "blockscan-solver-quote-concurrency PASS " +
      `(plans=${PLAN_COUNT}, candidates=${serial.candidates.length}, ` +
      `exactCalls=${expectedCalls}, peaks=1/4/16)`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
