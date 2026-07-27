import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  AdapterRuntimeCoordinator,
} from "../adapter-runtime-coordinator.js";
import {
  BlockScanStateCoordinator,
  type BlockScanStateReadBackend,
} from "../blockscan-state-coordinator.js";
import { AdapterFamilyRegistry } from "../venues/adapter-family-registry.js";
import {
  createVerifiedGraphView,
  type BlockSource,
  type StateRead,
  type StateReadResult,
} from "../venues/blockscan-state-capability.js";
import { balancerFlashFamily } from "../venues/funding/balancer-flash.js";
import {
  createErc20BalanceFlashFundingCapability,
} from "../venues/funding/flash-loan-framework.js";
import { morphoFlashFamily } from "../venues/funding/morpho-flash.js";
import {
  fundingLineageId,
  fundingProviderId,
  registerFundingFamily,
  type FundingCapability,
  type FundingLineageId,
  type RegisteredFundingFamily,
} from "../venues/funding/funding-capability.js";
import type {
  FlashLoanAdapterFamily,
  FlashLoanExecutionFamilyId,
} from "../venues/route-leg-adapter.js";

const HASH_A = `0x${"aa".repeat(32)}`;
const HASH_B = `0x${"bb".repeat(32)}`;
const TOKEN_A = "0x1111111111111111111111111111111111111111";
const TOKEN_B = "0x2222222222222222222222222222222222222222";
const ERC20 = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
]);

async function exactFundingResultContract(): Promise<void> {
  const registry = fundingRegistry();
  const funding = new FundingReadBackend();
  const coordinator = runtimeCoordinator(registry, funding);

  const first = await coordinator.prepare({
    graph: graph(1, 101, HASH_A),
    fundingTokens: [TOKEN_B, TOKEN_A, TOKEN_A],
    deadlineAtMs: Date.now() + 10_000,
  });
  assert.equal(first.status, "complete");
  if (first.status !== "complete") throw new Error("expected complete runtime");
  assert(first.timing, "production coordinator must emit split preparation timing");
  assert(
    [
      first.timing.wallMs,
      first.timing.pricingMs,
      first.timing.fundingMs,
      first.timing.executionMs,
      first.timing.finalCanonicalCasMs,
    ].every((value) => Number.isFinite(value) && value >= 0),
    "runtime preparation timings must be monotonic and non-negative",
  );
  const published = first.snapshot;
  assert.equal(coordinator.latestSnapshot(), published);
  assert.equal(published.sourceBlock, 101);
  assert.equal(published.sourceBlockHash, HASH_A);
  assert.equal(published.funding.sourceBlock, 101);
  assert.equal(published.funding.sourceBlockHash, HASH_A);
  assert.equal(published.funding.coverage.expectedKeys.length, 4);
  assert.equal(published.funding.coverage.unresolvedKeys.length, 0);
  assert.equal(
    published.funding.source(TOKEN_A)?.adapterId,
    morphoFlashFamily.funding.actionAdapterId,
  );
  assert.equal(published.funding.borrowable(TOKEN_A), 200n);
  assert.equal(funding.controls.length, 2, "funding reads isolate each family");
  assert.deepEqual(funding.controls[0], {
    sourceBlock: 101,
    sourceBlockHash: HASH_A,
  });

  let lastPublished = published;
  for (const [generation, mode] of [
    [2, "unexpected"],
    [3, "duplicate"],
    [4, "missing"],
    [5, "malformed"],
    [6, "stale"],
  ] as const) {
    funding.mode = mode;
    const failed = await coordinator.prepare({
      graph: graph(generation, 100 + generation, HASH_B),
      fundingTokens: [TOKEN_A, TOKEN_B],
      deadlineAtMs: Date.now() + 10_000,
    });
    assert.equal(failed.status, "degraded", `${mode} isolates the bad funding family`);
    if (failed.status !== "degraded") throw new Error("expected degraded runtime");
    const expectedResolved = mode === "malformed" ? 3 : 2;
    assert.equal(
      failed.fundingCoverage.resolvedKeys.length,
      expectedResolved,
      `${mode} must preserve the healthy funding family`,
    );
    assert.equal(
      failed.fundingCoverage.unresolvedKeys.length,
      4 - expectedResolved,
    );
    assert.equal(
      failed.snapshot.funding.source(TOKEN_A)?.adapterId,
      balancerFlashFamily.funding.actionAdapterId,
      `${mode} must select the healthy provider`,
    );
    assert.equal(coordinator.latestSnapshot(), failed.snapshot);
    lastPublished = failed.snapshot;
  }

  funding.mode = "exact";
  const executionFailed = await coordinator.prepare({
    graph: graph(7, 107, HASH_B),
    fundingTokens: [TOKEN_A, TOKEN_B],
    deadlineAtMs: Date.now() + 10_000,
    prepareExecution: async () => {
      throw new Error("isolated final-sim fork failed");
    },
  });
  assert.equal(executionFailed.status, "incomplete");
  assert.match(
    executionFailed.issues.map((issue) => issue.message).join("\n"),
    /execution preparation failed/,
  );
  assert.equal(coordinator.latestSnapshot(), lastPublished);

  const pricingFailed = await coordinator.prepare({
    graph: graph(8, 108, HASH_B, 107),
    fundingTokens: [TOKEN_A, TOKEN_B],
    deadlineAtMs: Date.now() + 10_000,
  });
  assert.equal(pricingFailed.status, "degraded");
  if (pricingFailed.status !== "degraded") {
    throw new Error("expected source-owner degradation");
  }
  assert.ok(
    pricingFailed.issues.some((issue) => issue.kind === "graph-incomplete"),
  );
  assert.deepEqual(pricingFailed.snapshot.pricing.incompleteFamilyIds, ["fixture"]);
  assert.equal(coordinator.latestSnapshot(), pricingFailed.snapshot);
  lastPublished = pricingFailed.snapshot;

  const recovered = await coordinator.prepare({
    graph: graph(9, 109, HASH_B),
    fundingTokens: [TOKEN_A, TOKEN_B],
    deadlineAtMs: Date.now() + 10_000,
  });
  assert.equal(recovered.status, "complete");
  if (recovered.status !== "complete") throw new Error("expected recovered runtime");
  assert.equal(coordinator.latestSnapshot(), recovered.snapshot);
  assert.equal(recovered.snapshot.sourceBlock, 109);

  await coordinator.resetDynamicStateForReplay();
  assert.equal(
    coordinator.latestSnapshot(),
    null,
    "trusted replay reset drops the published source generation",
  );
  const replayed = await coordinator.prepare({
    graph: graph(9, 109, HASH_B),
    fundingTokens: [TOKEN_A, TOKEN_B],
    deadlineAtMs: Date.now() + 10_000,
  });
  assert.equal(
    replayed.status,
    "complete",
    "the same frozen source/generation may be rebuilt after reset",
  );
}

async function preparationRunsConcurrently(): Promise<void> {
  const registry = fundingRegistry();
  const fundingGate = deferred<void>();
  const executionGate = deferred<void>();
  let fundingStarted = false;
  let executionStarted = false;
  let executionInput:
    | {
        generation: number;
        sourceBlock: number;
        sourceBlockHash: string;
      }
    | undefined;
  const reads = {
    async readPinned(
      pending: readonly StateRead[],
      control: {
        sourceBlock: number;
        sourceBlockHash: string;
        sourceGeneration: number;
        deadlineAtMs: number;
        signal: AbortSignal;
      },
    ): Promise<readonly StateReadResult[]> {
      fundingStarted = true;
      assert.equal(control.sourceBlock, 201);
      assert.equal(control.sourceBlockHash, HASH_A);
      for (const read of pending) {
        assert.equal(read.sourceBlock, control.sourceBlock);
        assert.equal(read.sourceBlockHash, control.sourceBlockHash);
      }
      await fundingGate.promise;
      return exactFundingResults(
        pending,
        control.sourceBlock,
        control.sourceBlockHash,
        control.sourceGeneration,
      );
    },
  };
  const coordinator = runtimeCoordinator(registry, reads);
  const preparing = coordinator.prepare({
    graph: graph(1, 201, HASH_A),
    fundingTokens: [TOKEN_A],
    deadlineAtMs: Date.now() + 10_000,
    prepareExecution: async (input) => {
      executionStarted = true;
      executionInput = {
        generation: input.generation,
        sourceBlock: input.sourceBlock,
        sourceBlockHash: input.sourceBlockHash,
      };
      await executionGate.promise;
    },
  });

  await waitUntil(() => fundingStarted && executionStarted);
  assert.equal(fundingStarted, true);
  assert.equal(executionStarted, true);
  assert.deepEqual(executionInput, {
    generation: 1,
    sourceBlock: 201,
    sourceBlockHash: HASH_A,
  });
  assert.equal(coordinator.latestSnapshot(), null);

  fundingGate.resolve();
  await Promise.resolve();
  assert.equal(coordinator.latestSnapshot(), null);
  executionGate.resolve();
  const result = await preparing;
  assert.equal(result.status, "complete");
  assert.notEqual(coordinator.latestSnapshot(), null);
}

async function finalCanonicalCasFailureDoesNotPublish(): Promise<void> {
  const funding = new FundingReadBackend();
  let rejectCanonicalSource = false;
  const coordinator = runtimeCoordinator(fundingRegistry(), {
    readPinned: funding.readPinned.bind(funding),
    async verifyCanonicalSource(source) {
      assert.equal(source.number, rejectCanonicalSource ? 242 : 241);
      if (rejectCanonicalSource) {
        throw new Error("fixture source was reorged before runtime publication");
      }
    },
  });
  const baseline = await coordinator.prepare({
    graph: graph(1, 241, HASH_A),
    fundingTokens: [TOKEN_A, TOKEN_B],
    deadlineAtMs: Date.now() + 10_000,
  });
  assert.equal(baseline.status, "complete");
  if (baseline.status !== "complete") throw new Error("expected baseline");
  const published = baseline.snapshot;

  rejectCanonicalSource = true;
  const reorged = await coordinator.prepare({
    graph: graph(2, 242, HASH_B),
    fundingTokens: [TOKEN_A, TOKEN_B],
    deadlineAtMs: Date.now() + 10_000,
  });
  assert.equal(reorged.status, "incomplete");
  assert.equal(
    coordinator.latestSnapshot(),
    published,
    "a final source-CAS failure must preserve the prior runtime generation",
  );
  assert.match(
    reorged.issues.map((issue) => issue.message).join("\n"),
    /final canonical CAS failed.*reorged/,
  );
}

async function fundingFamilyFailuresAreIsolated(): Promise<void> {
  const cases = [
    {
      label: "describeSources",
      wrap(base: RegisteredFundingFamily): RegisteredFundingFamily {
        return Object.freeze({
          ...base,
          describeSources() {
            throw new Error("isolated describeSources failure");
          },
        });
      },
    },
    {
      label: "prepare",
      wrap(base: RegisteredFundingFamily): RegisteredFundingFamily {
        return Object.freeze({
          ...base,
          async prepare() {
            throw new Error("isolated prepare failure");
          },
        });
      },
    },
  ] as const;

  for (const [index, testCase] of cases.entries()) {
    const fixtureLabel = testCase.label.toLowerCase();
    const broken = flashFamilyFixture(
      `flash-loan:isolated-${fixtureLabel}`,
      `isolated-${fixtureLabel}-flash`,
      testCase.wrap,
    );
    const coordinator = runtimeCoordinator(
      new AdapterFamilyRegistry([morphoFlashFamily, broken]),
      new FundingReadBackend(),
    );
    const result = await coordinator.prepare({
      graph: graph(index + 1, 210 + index, HASH_A),
      fundingTokens: [TOKEN_A],
      deadlineAtMs: Date.now() + 1_000,
    });
    assert.equal(
      result.status,
      "degraded",
      `${testCase.label} failure must degrade only its family`,
    );
    if (result.status !== "degraded") {
      throw new Error(`expected ${testCase.label} degradation`);
    }
    assert.equal(
      result.snapshot.funding.source(TOKEN_A)?.adapterId,
      morphoFlashFamily.funding.actionAdapterId,
      `${testCase.label} failure must preserve the healthy sibling`,
    );
    assert.ok(
      result.issues.some((issue) => issue.familyId === broken.id),
      `${testCase.label} failure must retain family attribution`,
    );
  }
}

async function hungFundingPrepareIsDeadlineBoundAndLateFenced(): Promise<void> {
  const release = deferred<void>();
  let hang = false;
  let sawAbort = false;
  let latePrepareSettled = false;
  let lateDecodeCalls = 0;
  const blocked = flashFamilyFixture(
    "flash-loan:hung-prepare",
    "hung-prepare-flash",
    (base) => Object.freeze({
      ...base,
      async prepare(
        input: Parameters<RegisteredFundingFamily["prepare"]>[0],
      ) {
        if (!hang) return base.prepare(input);
        input.control.signal?.addEventListener("abort", () => {
          sawAbort = true;
        }, { once: true });
        await release.promise;
        const prepared = await base.prepare(input);
        latePrepareSettled = true;
        return Object.freeze({
          ...prepared,
          decodeAndDerive(results: readonly StateReadResult[]) {
            lateDecodeCalls++;
            return prepared.decodeAndDerive(results);
          },
        });
      },
    }),
  );
  const backend = new FundingReadBackend();
  let healthySiblingRead = false;
  let finalCasSawAbortedSignal = false;
  const reads = {
    async readPinned(
      pending: readonly StateRead[],
      control: {
        sourceBlock: number;
        sourceBlockHash: string;
        sourceGeneration: number;
        deadlineAtMs: number;
        signal: AbortSignal;
      },
    ): Promise<readonly StateReadResult[]> {
      if (pending.some((read) => read.id.startsWith(morphoFlashFamily.id))) {
        healthySiblingRead = true;
      }
      return backend.readPinned(pending, control);
    },
    async verifyCanonicalSource(
      _source: BlockSource,
      signal: AbortSignal,
    ): Promise<void> {
      finalCasSawAbortedSignal = signal.aborted;
    },
  };
  const coordinator = runtimeCoordinator(
    new AdapterFamilyRegistry([morphoFlashFamily, blocked]),
    reads,
  );
  const baseline = await coordinator.prepare({
    graph: graph(1, 220, HASH_A),
    fundingTokens: [TOKEN_A],
    deadlineAtMs: Date.now() + 1_000,
  });
  assert.equal(baseline.status, "complete");
  if (baseline.status !== "complete") throw new Error("expected funding baseline");
  const published = baseline.snapshot;

  hang = true;
  healthySiblingRead = false;
  const startedAt = Date.now();
  const timedOut = await coordinator.prepare({
    graph: graph(2, 221, HASH_B),
    fundingTokens: [TOKEN_A],
    preparationSettleDeadlineAtMs: startedAt + 25,
    deadlineAtMs: startedAt + 500,
  });
  assert.equal(timedOut.status, "degraded");
  if (timedOut.status !== "degraded") {
    throw new Error("expected family-local funding degradation");
  }
  assert.equal(sawAbort, true, "hung family must receive runtime cancellation");
  assert.equal(
    healthySiblingRead,
    true,
    "hung family prepare must not stop a healthy sibling from completing",
  );
  assert.ok(
    Date.now() - startedAt < 1_000,
    "hung family prepare must be hard-bounded by the preparation deadline",
  );
  assert.equal(
    timedOut.snapshot.funding.source(TOKEN_A)?.adapterId,
    morphoFlashFamily.funding.actionAdapterId,
    "the healthy current-N lender must publish",
  );
  assert.equal(
    finalCasSawAbortedSignal,
    false,
    "family settlement must leave the outer controller alive for final CAS",
  );
  assert.notEqual(coordinator.latestSnapshot(), published);
  const degraded = timedOut.snapshot;

  release.resolve();
  await waitUntil(() => latePrepareSettled);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    lateDecodeCalls,
    0,
    "a prepare result arriving after abort must not enter decode/publication",
  );
  assert.equal(coordinator.latestSnapshot(), degraded);
}

async function hungExecutionIsDeadlineBound(): Promise<void> {
  const coordinator = runtimeCoordinator(fundingRegistry(), new FundingReadBackend());
  const startedAt = Date.now();
  let executionSawAbort = false;
  const result = await coordinator.prepare({
    graph: graph(1, 301, HASH_A),
    fundingTokens: [TOKEN_A],
    preparationSettleDeadlineAtMs: startedAt + 25,
    deadlineAtMs: startedAt + 500,
    prepareExecution: async ({ deadlineAtMs, signal }) => {
      assert.equal(deadlineAtMs, startedAt + 25);
      signal.addEventListener("abort", () => {
        executionSawAbort = true;
      }, { once: true });
      await new Promise<void>(() => {
        // Deliberately never settles: the coordinator must own the deadline.
      });
    },
  });
  assert.equal(result.status, "incomplete");
  assert.equal(executionSawAbort, true);
  assert.ok(
    result.issues.some((issue) => issue.kind === "deadline"),
    "runtime deadline must produce a terminal deadline issue",
  );
  assert.ok(
    Date.now() - startedAt < 1_000,
    "hung execution preparation must not hold the runtime indefinitely",
  );
  assert.equal(coordinator.latestSnapshot(), null);
}

async function timedOutGenerationCannotOverlapNextPreparation(): Promise<void> {
  const coordinator = runtimeCoordinator(fundingRegistry(), new FundingReadBackend());
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  const secondStarted = deferred<void>();
  const events: string[] = [];
  let resourceOwner: number | null = null;

  const firstPreparing = coordinator.prepare({
    graph: graph(1, 401, HASH_A),
    fundingTokens: [TOKEN_A],
    preparationSettleDeadlineAtMs: Date.now() + 25,
    deadlineAtMs: Date.now() + 1_000,
    prepareExecution: async ({ generation, signal }) => {
      assert.equal(generation, 1);
      assert.equal(resourceOwner, null);
      resourceOwner = generation;
      events.push("generation-1-start");
      firstStarted.resolve();
      await releaseFirst.promise;
      assert.equal(signal.aborted, true);
      resourceOwner = null;
      events.push("generation-1-settled");
    },
  });
  await firstStarted.promise;
  const first = await firstPreparing;
  assert.equal(first.status, "incomplete");
  assert.ok(first.issues.some((issue) => issue.kind === "deadline"));

  const secondPreparing = coordinator.prepare({
    graph: graph(2, 402, HASH_B),
    fundingTokens: [TOKEN_A],
    deadlineAtMs: Date.now() + 1_000,
    prepareExecution: async ({ generation }) => {
      assert.equal(generation, 2);
      assert.equal(
        resourceOwner,
        null,
        "a later generation must not reuse execution resources before the prior callback settles",
      );
      resourceOwner = generation;
      events.push("generation-2-start");
      secondStarted.resolve();
      resourceOwner = null;
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(
    events,
    ["generation-1-start"],
    "terminal deadline must not release the execution-resource settle barrier",
  );

  releaseFirst.resolve();
  await secondStarted.promise;
  const second = await secondPreparing;
  assert.equal(second.status, "complete");
  assert.deepEqual(events, [
    "generation-1-start",
    "generation-1-settled",
    "generation-2-start",
  ]);
  assert.equal(coordinator.latestSnapshot(), second.snapshot);
}

async function fundingDerivationIsSynchronousAndIoFree(): Promise<void> {
  const source = Object.freeze({
    number: 501,
    hash: HASH_A,
    generation: 1,
  });
  for (const adapterFamily of [balancerFlashFamily, morphoFlashFamily]) {
    const family = adapterFamily.funding;
    const prepared = await family.prepare({
      assets: [TOKEN_A],
      source,
      control: {
        deadlineAtMs: Date.now() + 10_000,
        signal: new AbortController().signal,
      },
    });
    const exact = exactFundingResults(
      prepared.reads,
      source.number,
      source.hash,
      source.generation,
    );
    const originalFetch = globalThis.fetch;
    let ambientIoCalls = 0;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: (..._args: Parameters<typeof fetch>) => {
        ambientIoCalls++;
        throw new Error("funding derive attempted ambient I/O");
      },
    });
    try {
      const derived = prepared.decodeAndDerive(exact);
      assert.equal(
        typeof (derived as { then?: unknown }).then,
        "undefined",
        `${family.familyId} decode/derive must be synchronous`,
      );
      assert.equal(ambientIoCalls, 0, `${family.familyId} derive must not perform I/O`);
    } finally {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
    }
  }

  const asyncDerive = registerFundingFamily(
    fundingProviderId("flash-loan:async-derive-test"),
    {
      actionAdapterId: "async-derive-test-flash",
      lineage: fundingLineageId("balancer-flash"),
      target: TOKEN_A,
      liquidityHolder: TOKEN_A,
      repayment: "transfer",
      paramShape: "none",
      planningPriority: 1,
      liquidityPriority: 1,
      sources: () => [{
        fundingId: "async-derive-test",
        instanceKey: "async-derive-test",
        provider: TOKEN_A,
        stateKey: "async-derive-test",
        asset: TOKEN_A,
        requiredReadKeys: [],
      }],
      compileStaticSchema: () => null,
      buildCurrentBlockReadPlans: () => [],
      decodeCurrentBlockState: () => ({
        snapshot: null,
        coverageByReadKey: new Map(),
      }),
      deriveOffers: (() => Promise.resolve({
        offers: new Map(),
        coverageByFundingId: new Map(),
      })) as unknown as FundingCapability<null, null>["deriveOffers"],
      buildBorrowFragment: () => {
        throw new Error("not used");
      },
      buildRepaymentFragment: () => {
        throw new Error("not used");
      },
    } satisfies FundingCapability<null, null>,
  );
  const invalid = await asyncDerive.prepare({
    assets: [TOKEN_A],
    source,
    control: {
      deadlineAtMs: Date.now() + 10_000,
      signal: new AbortController().signal,
    },
  });
  assert.throws(
    () => invalid.decodeAndDerive([]),
    /deriveOffers must be synchronous and pure/,
  );
}

function fundingProviderIdsArePluginExtensible(): void {
  const thirdProviderId = fundingProviderId("flash-loan:fixture-third");
  const third = flashFamilyFixture(
    thirdProviderId,
    "fixture-third-flash",
    (base) => base,
    fundingLineageId("fixture-third-flash"),
  );
  const registry = new AdapterFamilyRegistry([
    balancerFlashFamily,
    morphoFlashFamily,
    third,
  ]);
  assert.equal(
    registry.findFundingByAction("fixture-third-flash")?.funding.familyId,
    thirdProviderId,
    "third provider must register without extending a central union",
  );
  assert.equal(
    registry.findFundingByAction("fixture-third-flash")?.funding.lineage,
    "fixture-third-flash",
  );
  assert.throws(() => fundingProviderId("fixture-third"));
  assert.throws(() => fundingProviderId("flash-loan:"));
  assert.throws(() => fundingLineageId("Fixture Third"));
  assert.throws(
    () =>
      new AdapterFamilyRegistry([{
        ...third,
        id: "flash-loan:fixture-mismatched",
      }]),
    /funding provider identity mismatch/,
    "provider identity must stay bound to the owning family",
  );
}

class FundingReadBackend {
  mode:
    | "exact"
    | "unexpected"
    | "duplicate"
    | "missing"
    | "malformed"
    | "stale" =
    "exact";
  readonly controls: Array<{
    sourceBlock: number;
    sourceBlockHash: string;
  }> = [];

  async readPinned(
    reads: readonly StateRead[],
    control: {
      sourceBlock: number;
      sourceBlockHash: string;
      sourceGeneration: number;
      deadlineAtMs: number;
      signal: AbortSignal;
    },
  ): Promise<readonly StateReadResult[]> {
    this.controls.push({
      sourceBlock: control.sourceBlock,
      sourceBlockHash: control.sourceBlockHash,
    });
    for (const read of reads) {
      assert.equal(read.sourceBlock, control.sourceBlock);
      assert.equal(read.sourceBlockHash, control.sourceBlockHash);
    }
    const exact = [...exactFundingResults(
      reads,
      control.sourceBlock,
      control.sourceBlockHash,
      control.sourceGeneration,
    )];
    if (
      this.mode !== "exact" &&
      !reads[0]?.id.startsWith(morphoFlashFamily.id)
    ) {
      return Object.freeze(exact);
    }
    switch (this.mode) {
      case "exact":
        return Object.freeze(exact);
      case "unexpected":
        return Object.freeze([
          ...exact,
          Object.freeze({
            ...exact[0],
            id: "unexpected-funding-result",
          }),
        ]);
      case "duplicate":
        return Object.freeze([...exact, exact[0]]);
      case "missing":
        return Object.freeze(exact.slice(1));
      case "malformed":
        return Object.freeze([
          Object.freeze({ ...exact[0], data: "0x" }),
          ...exact.slice(1),
        ]);
      case "stale":
        return Object.freeze(exact.map((result) => Object.freeze({
          ...result,
          sourceBlock: control.sourceBlock - 1,
          sourceBlockHash: HASH_A,
        })));
    }
  }
}

function runtimeCoordinator(
  registry: AdapterFamilyRegistry,
  reads: {
    readPinned(
      reads: readonly StateRead[],
      control: {
        sourceBlock: number;
        sourceBlockHash: string;
        sourceGeneration: number;
        deadlineAtMs: number;
        signal: AbortSignal;
      },
    ): Promise<readonly StateReadResult[]>;
    verifyCanonicalSource?(
      source: BlockSource,
      signal: AbortSignal,
    ): Promise<void>;
  },
): AdapterRuntimeCoordinator {
  const pricingBackend: BlockScanStateReadBackend = {
    async readBatch(): Promise<readonly StateReadResult[]> {
      throw new Error("empty pricing graph must not issue reads");
    },
    async verifyCanonicalSource() {},
  };
  return new AdapterRuntimeCoordinator(
    registry,
    new BlockScanStateCoordinator(pricingBackend),
    {
      readPinned: reads.readPinned.bind(reads),
      verifyCanonicalSource:
        reads.verifyCanonicalSource?.bind(reads) ?? (async () => {}),
    },
  );
}

function fundingRegistry(): AdapterFamilyRegistry {
  return new AdapterFamilyRegistry([
    balancerFlashFamily,
    morphoFlashFamily,
  ]);
}

function flashFamilyFixture(
  id: FlashLoanExecutionFamilyId,
  actionAdapterId: string,
  wrap: (base: RegisteredFundingFamily) => RegisteredFundingFamily,
  lineage: FundingLineageId = fundingLineageId("balancer-flash"),
): FlashLoanAdapterFamily {
  const base = createErc20BalanceFlashFundingCapability({
    familyId: fundingProviderId(id),
    actionAdapterId,
    lineage,
    target: TOKEN_B,
    liquidityHolder: TOKEN_B,
    repayment: "transfer",
    paramShape: "tokens-and-amounts",
    planningPriority: 10,
    liquidityPriority: 10,
  });
  return Object.freeze({
    id,
    kind: "flash-loan" as const,
    ownedActionAdapterIds: Object.freeze([actionAdapterId]),
    requiredInfraActionAdapterIds: Object.freeze([
      "assert-balance",
      "erc20-transfer",
    ]),
    funding: wrap(base),
  });
}

function graph(
  generation: number,
  sourceBlock: number,
  sourceBlockHash: string,
  completenessWatermark = sourceBlock,
) {
  return createVerifiedGraphView({
    id: `runtime-${generation}`,
    generation,
    sourceBlock,
    sourceBlockHash,
    completenessWatermark,
    perSourceCoverage: [{
      familyId: "fixture",
      sourceId: "test",
      sourceFingerprint: "runtime-test",
      completeThroughBlock: completenessWatermark,
      completeThroughHash: sourceBlockHash,
    }],
    edges: [],
  });
}

function exactFundingResults(
  reads: readonly StateRead[],
  sourceBlock: number,
  sourceBlockHash: string,
  sourceGeneration: number,
): readonly StateReadResult[] {
  return Object.freeze(reads.map((read) => Object.freeze({
    id: read.id,
    ok: true as const,
    sourceBlock,
    sourceBlockHash,
    provenance: Object.freeze({
      kind: "eip1898" as const,
      source: Object.freeze({
        number: sourceBlock,
        hash: sourceBlockHash,
        generation: sourceGeneration,
      }),
      requireCanonical: true as const,
    }),
    data: ERC20.encodeFunctionResult("balanceOf", [
      read.id.startsWith(morphoFlashFamily.id) ? 200n : 100n,
    ]),
  })));
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value?: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve(value?: T) {
      resolve(value as T);
    },
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("timed out waiting for concurrent preparation");
}

await exactFundingResultContract();
await preparationRunsConcurrently();
await finalCanonicalCasFailureDoesNotPublish();
await fundingFamilyFailuresAreIsolated();
await hungFundingPrepareIsDeadlineBoundAndLateFenced();
await hungExecutionIsDeadlineBound();
await timedOutGenerationCannotOverlapNextPreparation();
await fundingDerivationIsSynchronousAndIoFree();
fundingProviderIdsArePluginExtensible();

console.log("[adapter-runtime-coordinator] atomic current-N runtime: PASS");
