import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UniverseRebuildCheckpointStore,
  canonicalJson,
  durableVerifiedMemoFingerprint,
  type DurableSourceReceipt,
  type DurableVerifiedMemo,
  type StartupCheckpointEnvelope,
} from "../universe-rebuild-checkpoint.js";
import {
  assertReceiptsMatchCurrentSourcePlan,
  UniverseRunIncomplete,
  probeOneFailure,
  rebuildUniverse,
  type RebuildUniverseInput,
} from "../universe-rebuild-runner.js";
import { strictEdgeCollectionFromBlock } from
  "../strict-edge-collection-policy.js";

const SOURCE = Object.freeze({
  number: 25_750_000,
  hash: "0x" + "a1".repeat(32),
  generation: 1,
});

function sealFixtureMemo(
  input: Omit<DurableVerifiedMemo, "memoFingerprint">,
): DurableVerifiedMemo {
  const unsigned = Object.freeze({ ...input, memoFingerprint: "" });
  return Object.freeze({
    ...unsigned,
    memoFingerprint: durableVerifiedMemoFingerprint(unsigned),
  });
}

function sourceReceipts(fromBlock: number): readonly DurableSourceReceipt[] {
  return Object.freeze([Object.freeze({
    sourceKey: "1".repeat(64),
    sourceKind: "startup-candidate-union" as const,
    providerIdentity: "fixture",
    queryFingerprint: "2".repeat(64),
    fromBlock,
    toBlock: SOURCE.number,
    cutoffNumber: SOURCE.number,
    cutoffHash: SOURCE.hash,
    coverageKeys: Object.freeze(["univ2|startup-universe"]),
    completedChunks: Object.freeze([Object.freeze({
      fromBlock,
      toBlock: SOURCE.number,
      resultCount: 3,
      resultHash: "3".repeat(64),
    })]),
    observationSetHash: "4".repeat(64),
    observedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
    appliedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
    retryableCount: 0 as const,
    status: "complete" as const,
  })]);
}

interface Fixture {
  readonly store: UniverseRebuildCheckpointStore;
  readonly attestCalls: Map<string, number>;
  readonly failKeys: Set<string>;
  readonly terminalKeys: Set<string>;
  readonly invalidReusableKeys: Set<string>;
  readonly builtFamilySizes: number[];
  readonly scanCalls: () => number;
  readonly maxConcurrentAttestations: () => number;
  readonly input: RebuildUniverseInput;
}

function makeFixture(
  dir: string,
  overrides?: Partial<Pick<
    RebuildUniverseInput,
    | "runId"
    | "scanSwapWindow"
    | "expectedSourcePlanFingerprints"
    | "dedupeFamilyCandidates"
    | "reverseBindOpaqueCandidates"
    | "sealDurableVerifiedMemo"
  >>,
): Fixture {
  const store = new UniverseRebuildCheckpointStore({
    path: join(dir, "checkpoint.json"),
  });
  const attestCalls = new Map<string, number>();
  const failKeys = new Set<string>();
  const terminalKeys = new Set<string>();
  const invalidReusableKeys = new Set<string>();
  const builtFamilySizes: number[] = [];
  let scanCallCount = 0;
  let activeAttestations = 0;
  let maxConcurrentAttestations = 0;
  const candidates = (ids: readonly string[]) =>
    Object.freeze(ids.map((id) => Object.freeze({ id })));
  const observations = (ids: readonly string[]) =>
    Object.freeze(ids.map((id) => Object.freeze({ id, block: SOURCE.number })));
  const input: RebuildUniverseInput = {
    store,
    runId: "run-1",
    attestationConcurrency: 2,
    freezeCanonicalHead: async () => SOURCE,
    scanSwapWindow: async (scanInput) => Object.freeze({
      observations: observations(["a", "b", "c"]),
      sourceReceipts: sourceReceipts(scanInput.fromBlock),
    }),
    familyCandidateKey: (candidate) =>
      "cand:" + String((candidate as { id: string }).id),
    requiredSourceCoverageKeys: () =>
      Object.freeze(["univ2|startup-universe"]),
    expectedSourcePlanFingerprints: () => Object.freeze({
      startup: "2".repeat(64),
      events: "5".repeat(64),
    }),
    dedupeFamilyCandidates: (obs) =>
      candidates(
        [...new Set(obs.map((o) => {
          const item = o as {
            readonly kind?: unknown;
            readonly candidate?: { readonly id?: unknown };
            readonly id?: unknown;
          };
          return String(
            item.kind === "startup-candidate"
              ? item.candidate?.id
              : item.id,
          );
        }))],
      ),
    findReusableMemo: async (input) => {
      const key = (input.candidate as { id: string }).id;
      if (invalidReusableKeys.has(key)) return null;
      const memo = input.checkpoint.verifiedMemos["cand:" + key];
      if (memo === undefined) return null;
      return memo;
    },
    attestFamilyInstanceOnce: async (input) => {
      const id = String((input.candidate as { id: string }).id);
      attestCalls.set(id, (attestCalls.get(id) ?? 0) + 1);
      activeAttestations++;
      maxConcurrentAttestations = Math.max(
        maxConcurrentAttestations,
        activeAttestations,
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeAttestations--;
      if (terminalKeys.has(id)) {
        return Object.freeze({
          status: "terminal-rejected",
          reasonCode: "identity_rejected:fixture",
          binding: Object.freeze({
            familyDefinitionHash: "family-def-" + id,
            requestFingerprint: "req-" + id,
            trustedResultsFingerprint: "results-" + id,
            authorityFingerprint: "authority-" + id,
            candidateFingerprint: "candidate-" + id,
            cutoff: Object.freeze({
              number: input.cutoff.number,
              hash: input.cutoff.hash,
            }),
          }),
        });
      }
      if (failKeys.has(id)) {
        return Object.freeze({
          status: "retryable",
          stage: "identity",
          failureCode: "rpc",
          reasonCode: "factory-child-reverse-binding:rpc",
          candidateSnapshot: Object.freeze({ id }),
        });
      }
      return Object.freeze({
        status: "verified",
        result: Object.freeze({ identity: id, candidate: input.candidate }),
      });
    },
    sealDurableVerifiedMemo: (input) => {
      const id = String((input.candidate as { id: string }).id);
      return sealFixtureMemo({
        familyCandidateKey: "cand:" + id,
        familyInstanceKey: "inst:" + id,
        familyId: "univ2",
        candidateKey: "cand:" + id,
        instanceKey: "inst:" + id,
        candidateFingerprint: "cf:" + id,
        familyDefinitionHash: "fdh",
        validity: Object.freeze({
          policy: "immutable-code",
          authorityFingerprint: "auth",
          proofSource: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
        }),
        verifiedIdentity: Object.freeze({ kind: "identity" }),
        compiledDescriptor: Object.freeze({ kind: "descriptor" }),
        staticProjection: Object.freeze({ kind: "projection" }),
        evidenceFingerprint: "ef:" + id,
        candidateSnapshot: Object.freeze({ id }),
      });
    },
    rehydrateVerifiedInstance: (input) =>
      Object.freeze({
        familyInstanceKey: input.memo.familyInstanceKey,
        familyId: input.memo.familyId,
        instanceKey: input.memo.instanceKey,
      }),
    aggregateOnceByFamily: (instances) => {
      const byFamily = new Map<string, unknown[]>();
      for (const instance of instances) {
        const familyId = String((instance as { familyId: string }).familyId);
        const familyInstances = byFamily.get(familyId);
        if (familyInstances === undefined) byFamily.set(familyId, [instance]);
        else familyInstances.push(instance);
      }
      return Object.freeze([...byFamily.entries()].map(
        ([familyId, familyInstances]) => Object.freeze({
          familyId,
          instances: Object.freeze(familyInstances),
        }),
      ));
    },
    buildGraphSnapshot: (publications) => {
      builtFamilySizes.push(...publications.map((item) => item.instances.length));
      return Object.freeze({
        edges: Object.freeze(publications.flatMap((item) =>
          item.instances.map((instance) => Object.freeze({
            familyId: item.familyId,
            instanceKey: String(
              (instance as { instanceKey?: unknown }).instanceKey ?? "",
            ),
          }))
        )),
      });
    },
    buildCoverage: ({ sourceReceipts: receipts }) => Object.freeze(
      receipts.flatMap((receipt) => receipt.coverageKeys.map((key) => {
        const separator = key.indexOf("|");
        return Object.freeze({
          familyId: key.slice(0, separator),
          sourceId: key.slice(separator + 1),
          completeThroughBlock: receipt.appliedThrough.number,
          completeThroughHash: receipt.appliedThrough.hash,
        });
      })),
    ),
    assertCanonicalHead: async () => undefined,
    ...overrides,
  };
  const scan = input.scanSwapWindow;
  const countedInput = Object.freeze({
    ...input,
    scanSwapWindow: async (scanInput: Parameters<typeof scan>[0]) => {
      scanCallCount++;
      return await scan(scanInput);
    },
  });
  return {
    store,
    attestCalls,
    failKeys,
    terminalKeys,
    invalidReusableKeys,
    builtFamilySizes,
    scanCalls: () => scanCallCount,
    maxConcurrentAttestations: () => maxConcurrentAttestations,
    input: countedInput,
  };
}

async function main(): Promise<void> {
  assert.equal(
    strictEdgeCollectionFromBlock(SOURCE.number, 100),
    SOURCE.number - 99,
    "a smoke run uses the same bounded production window calculation",
  );
  assert.throws(
    () => strictEdgeCollectionFromBlock(SOURCE.number, 14_401),
    /integer in \[1, 14400\]/,
    "a smoke override can never widen the canonical production window",
  );
  const dir = await mkdtemp(join(tmpdir(), "universe-rebuild-runner-"));
  try {
    // A: retryable counts as an accounted outcome: the verified partition is
    // published, the completed run clears, and retryable work moves to the
    // independent probe queue.
    const f = makeFixture(dir);
    f.failKeys.add("c");
    const firstReady = await rebuildUniverse(f.input);
    assert.equal(f.attestCalls.get("a"), 1);
    assert.equal(f.attestCalls.get("b"), 1);
    assert.equal(f.attestCalls.get("c"), 1);
    assert.equal(
      f.maxConcurrentAttestations(),
      2,
      "attestation must use the configured bounded worker pool",
    );
    let checkpoint: StartupCheckpointEnvelope | null = await f.store.load();
    assert.equal(
      checkpoint?.readyGeneration?.generation,
      firstReady.generation,
      "ready generation is promoted despite residual retryable",
    );
    assert.equal(
      checkpoint?.retryableAttemptsByCandidateKey["cand:c"]?.status,
      "retryable",
      "RPC failure is persisted as retryable, never as rejected",
    );
    assert.equal(
      checkpoint?.retryableAttemptsByCandidateKey["cand:c"]?.attemptCount,
      1,
    );
    assert.equal(checkpoint?.inProgressRun, null);
    assert.deepEqual(firstReady.candidateAccounting, {
      total: 3,
      verified: 2,
      terminalRejected: 0,
      retryable: 1,
      remainingUnaccounted: 0,
    });

    // A new rolling run scans a fresh partition, reuses verified memos, and
    // inherits the independent retryable without re-attesting it on startup.
    const resumedReady = await rebuildUniverse(f.input);
    assert.equal(resumedReady.generation, firstReady.generation + 1);
    assert.equal(
      f.scanCalls(),
      2,
      "a completed run must not pin startup to the old fixed window",
    );
    assert.equal(
      f.attestCalls.get("a"),
      1,
      "resume must not re-attest verified keys",
    );
    assert.equal(f.attestCalls.get("b"), 1);
    assert.equal(
      f.attestCalls.get("c"),
      1,
      "resume must preserve retryable keys without re-attesting",
    );

    // A code/family/authority change between process starts invalidates an
    // already-durable verified memo. The key is re-attested, while unchanged
    // verified siblings still skip the lifecycle.
    f.invalidReusableKeys.add("a");
    const reattestedReady = await rebuildUniverse(f.input);
    assert.equal(reattestedReady.generation, firstReady.generation + 2);
    assert.equal(f.attestCalls.get("a"), 2);
    assert.equal(f.attestCalls.get("b"), 1);
    f.invalidReusableKeys.delete("a");

    // Probe: only the target key, at the queued fixed cutoff. A repeated RPC
    // failure replaces the queue item; success later removes it.
    const stillRetryable = await probeOneFailure({
      store: f.store,
      runId: "run-1",
      familyCandidateKey: "cand:c",
      attestFamilyInstanceOnce: f.input.attestFamilyInstanceOnce,
      sealDurableVerifiedMemo: f.input.sealDurableVerifiedMemo,
      assertCanonicalHead: async () => undefined,
      decodeCandidateSnapshot: (snapshot) => snapshot as { id: string },
    });
    assert.equal(stillRetryable.status, "retryable");
    assert.equal(
      stillRetryable.status === "retryable" && stillRetryable.attemptCount,
      2,
    );
    assert.equal(
      (await f.store.load())?.retryableAttemptsByCandidateKey["cand:c"]
        ?.cutoff.number,
      SOURCE.number,
    );
    const probeBefore = f.attestCalls.get("c") ?? 0;
    f.failKeys.delete("c");
    const probed = await probeOneFailure({
      store: f.store,
      runId: "run-1",
      familyCandidateKey: "cand:c",
      attestFamilyInstanceOnce: f.input.attestFamilyInstanceOnce,
      sealDurableVerifiedMemo: f.input.sealDurableVerifiedMemo,
      assertCanonicalHead: async () => undefined,
      decodeCandidateSnapshot: (snapshot) => snapshot as { id: string },
    });
    assert.equal(probed.status, "verified");
    assert.equal(
      f.attestCalls.get("c"),
      probeBefore + 1,
      "probe must attest exactly the target key",
    );

    // Once the independent probe closes cand:c, the next rolling run reuses
    // its memo and admits the instance into the Graph.
    const aCallsBeforeFinalize = f.attestCalls.get("a");
    const finalizedReady = await rebuildUniverse(f.input);
    assert.equal(finalizedReady.generation, firstReady.generation + 3);
    assert.deepEqual(
      [...finalizedReady.activeInstanceKeys].sort(),
      ["inst:a", "inst:b", "inst:c"],
      "after the probe closed the retryable, the instance enters the Graph",
    );
    assert.deepEqual(
      [...f.builtFamilySizes].slice(-1),
      [3],
      "one family publication must retain all verified instance pools",
    );
    checkpoint = await f.store.load();
    assert.equal(checkpoint?.inProgressRun, null);
    assert.equal(
      checkpoint?.retryableAttemptsByCandidateKey["cand:c"],
      undefined,
      "the probe-closed instance leaves the independent retryable queue",
    );
    assert.equal(checkpoint?.readyGeneration?.generation, firstReady.generation + 3);
    assert.equal(
      f.attestCalls.get("a"),
      aCallsBeforeFinalize,
      "a valid durable memo must not re-attest during finalization",
    );

    // A deployed checkpoint may already have Ready while the old runtime
    // still keeps the completed run. It must migrate locally before source-
    // plan checks, then start one fresh rolling scan; it must not re-adopt the
    // old historical range as if the run were unfinished.
    const keptDir = join(dir, "already-ready-kept-run");
    const kept = makeFixture(keptDir);
    const keptReady = await rebuildUniverse(kept.input);
    const keptEnvelope = (await kept.store.load())!;
    const keptCandidates = Object.freeze(Object.fromEntries(
      ["a", "b", "c"].map((id) => [
        "cand:" + id,
        Object.freeze({ id }),
      ]),
    ));
    const legacyReady = { ...keptReady } as Record<string, unknown>;
    delete legacyReady.candidateAccounting;
    const legacyProjection = Object.freeze({
      revision: keptEnvelope.revision + 1,
      verifiedMemos: keptEnvelope.verifiedMemos,
      inProgressRun: Object.freeze({
        runId: "run-1",
        cutoff: SOURCE,
        fromBlock: SOURCE.number - 14_399,
        universeHash: keptReady.universeHash,
        candidateSetHash: createHash("sha256")
          .update("candidate-set-v1:cand:a,cand:b,cand:c")
          .digest("hex"),
        candidateCount: 3,
        candidatesByKey: keptCandidates,
        observedThrough: Object.freeze({
          number: SOURCE.number,
          hash: SOURCE.hash,
        }),
        sourceReceipts: sourceReceipts(SOURCE.number - 14_399),
        appliedThrough: null,
        outcomesByCandidateKey: Object.freeze(Object.fromEntries(
          ["a", "b", "c"].map((id) => [
            "cand:" + id,
            Object.freeze({
              status: "verified",
              familyCandidateKey: "cand:" + id,
              familyInstanceKey: "inst:" + id,
              memoFingerprint: keptEnvelope.verifiedMemos["cand:" + id]!
                .memoFingerprint,
            }),
          ]),
        )),
      }),
      readyGeneration: Object.freeze(legacyReady),
    });
    const legacyFingerprint = createHash("sha256")
      .update(canonicalJson(legacyProjection))
      .digest("hex");
    await writeFile(
      join(keptDir, "checkpoint.json"),
      JSON.stringify({
        ...legacyProjection,
        checkpointFingerprint: legacyFingerprint,
      }) + "\n",
    );
    const migrationLogs: string[] = [];
    const rolledReady = await rebuildUniverse(Object.freeze({
      ...kept.input,
      log: (message: string) => migrationLogs.push(message),
    }));
    assert.equal(rolledReady.generation, 2);
    assert.equal(kept.scanCalls(), 2);
    assert.match(migrationLogs.join("\n"), /migrated already-ready kept run/);
    assert.equal((await kept.store.load())?.inProgressRun, null);


    // B: a NEW deployment (fresh checkpoint dir) has no durable memos, so
    // every candidate is attested once; the resulting ready admits exactly
    // the verified instances (order independent — scan returns [b, a]).
    const dir2 = await mkdtemp(join(tmpdir(), "universe-rebuild-runner-"));
    const f2 = makeFixture(dir2, {
      runId: "run-2",
      scanSwapWindow: async (scanInput) => Object.freeze({
        observations: Object.freeze([
          Object.freeze({ id: "b", block: SOURCE.number }),
          Object.freeze({ id: "a", block: SOURCE.number }),
        ]),
        sourceReceipts: sourceReceipts(scanInput.fromBlock),
      }),
    });
    const ready2 = await rebuildUniverse(f2.input);
    assert.equal(ready2.generation, 1);
    assert.equal(
      f2.attestCalls.get("a"),
      1,
      "fresh deployment attests each candidate once",
    );
    assert.equal(f2.attestCalls.get("b"), 1);
    assert.deepEqual(
      [...ready2.activeInstanceKeys].sort(),
      ["inst:a", "inst:b"],
    );
    assert.notEqual(
      ready2.catalogHash,
      finalizedReady.catalogHash,
      "catalog root must bind the exact active instance set",
    );
    assert.notEqual(
      ready2.graphHash,
      finalizedReady.graphHash,
      "graph root must bind graph contents, not object stringification",
    );

    // C: a chain-proven terminal rejection is accounted for and never enters
    // the Graph. The completed run clears; a new rolling run may reuse its
    // bound outcome only through durable memo/attestation semantics.
    const terminalFixture = makeFixture(join(dir, "terminal"));
    terminalFixture.terminalKeys.add("b");
    const terminalReady = await rebuildUniverse(terminalFixture.input);
    assert.equal(terminalFixture.attestCalls.get("b"), 1);
    assert.deepEqual(
      [...terminalReady.activeInstanceKeys].sort(),
      ["inst:a", "inst:c"],
      "terminal-rejected instances never enter the Graph",
    );

    // D: an unexpected worker failure cannot discard completed siblings or
    // accidentally promote ready. The finally flush is the crash/partial-run
    // durability boundary.
    const throwFixture = makeFixture(join(dir, "worker-throw"));
    const originalAttest = throwFixture.input.attestFamilyInstanceOnce;
    await assert.rejects(
      () => rebuildUniverse(Object.freeze({
        ...throwFixture.input,
        attestationConcurrency: 1,
        attestFamilyInstanceOnce: async (
          attestInput: Parameters<typeof originalAttest>[0],
        ) => {
          if ((attestInput.candidate as { id: string }).id === "c") {
            throw new Error("fixture unexpected worker failure");
          }
          return await originalAttest(attestInput);
        },
      })),
      /unexpected worker failure/,
    );
    const afterThrow = await throwFixture.store.load();
    assert.equal(
      afterThrow?.inProgressRun?.outcomesByCandidateKey["cand:a"]?.status,
      "verified",
    );
    assert.equal(
      afterThrow?.inProgressRun?.outcomesByCandidateKey["cand:b"]?.status,
      "verified",
    );
    assert.equal(afterThrow?.readyGeneration, null);

    // E: a catalog-shaped but incomplete source set is rejected before the
    // run can attest or mint coverage. A source scan crash likewise leaves no
    // observed/applied cursor or ready envelope behind.
    const falseCoverage = makeFixture(join(dir, "false-coverage"), {
      scanSwapWindow: async (scanInput) => {
        const receipt = sourceReceipts(scanInput.fromBlock)[0]!;
        return Object.freeze({
          observations: Object.freeze([Object.freeze({
            id: "a",
            block: SOURCE.number,
          })]),
          sourceReceipts: Object.freeze([Object.freeze({
            ...receipt,
            coverageKeys: Object.freeze(["univ2|event:only-partial"]),
          })]),
        });
      },
    });
    await assert.rejects(
      () => rebuildUniverse(falseCoverage.input),
      /required source exact set/,
    );
    assert.equal(
      await falseCoverage.store.load(),
      null,
      "false source completeness must not begin a durable run",
    );
    const staleSourcePlan = makeFixture(join(dir, "stale-source-plan"));
    await assert.rejects(
      () => rebuildUniverse(Object.freeze({
        ...staleSourcePlan.input,
        expectedSourcePlanFingerprints: () => Object.freeze({
          startup: "9".repeat(64),
          events: "5".repeat(64),
        }),
      })),
      /does not match the current source plan/,
    );
    assert.equal(
      await staleSourcePlan.store.load(),
      null,
      "a receipt sealed by stale source code cannot begin a durable run",
    );
    assert.throws(
      () => assertReceiptsMatchCurrentSourcePlan(
        Object.freeze([Object.freeze({
          ...sourceReceipts(SOURCE.number - 14_399)[0]!,
          sourceKind: "unknown-source-kind" as never,
        })]),
        Object.freeze({
          startup: "2".repeat(64),
          events: "5".repeat(64),
        }),
      ),
      /source receipt kind is not bound/,
    );
    const scanCrash = makeFixture(join(dir, "source-scan-crash"), {
      scanSwapWindow: async () => {
        throw new Error("fixture source chunk failed");
      },
    });
    await assert.rejects(
      () => rebuildUniverse(scanCrash.input),
      /source chunk failed/,
    );
    assert.equal(
      await scanCrash.store.load(),
      null,
      "a partial scan cannot advance observedThrough or ready",
    );

    // F: the production API has no lookback/from override. Receipts and ready
    // bind exactly cutoff-14399..cutoff (14400-block window, 2 days at 12s);
    // old universe metadata cannot expand it.
    const fixedRange = makeFixture(join(dir, "fixed-range"));
    const fixedReady = await rebuildUniverse(fixedRange.input);
    assert.equal(fixedReady.universeRange.fromBlock, SOURCE.number - 14_399);
    assert.equal(
      fixedReady.sourceCoverage[0]?.completeThroughBlock,
      SOURCE.number,
    );

    // G-plan: durable source receipts must be sealed by the current source
    // plan (audit P0-STOP-1). A matching plan passes; any drift between the
    // sealing code and the current catalog (stale topic/decoder/capability)
    // fails closed before the run can attest or mint coverage.
    const planReceiptFixture = (
      dir: string,
      plan: string,
    ): Fixture => makeFixture(dir, {
      scanSwapWindow: async (scanInput) => {
        const receipt = sourceReceipts(scanInput.fromBlock)[0]!;
        return Object.freeze({
          observations: Object.freeze(["a", "b", "c"].map((id) =>
            Object.freeze({ id, block: SOURCE.number }),
          )),
          sourceReceipts: Object.freeze([Object.freeze({
            ...receipt,
            queryFingerprint: plan,
          })]),
        });
      },
    });
    const matchingPlan = planReceiptFixture(join(dir, "matching-plan"), "9".repeat(64));
    await rebuildUniverse(Object.freeze({
      ...matchingPlan.input,
      expectedSourcePlanFingerprints: () =>
        Object.freeze({ startup: "9".repeat(64), events: "9".repeat(64) }),
    }));
    assert.equal(
      (await matchingPlan.store.load())?.readyGeneration?.generation,
      1,
      "matching-plan receipt must permit atomic ready promotion",
    );
    const stalePlan = planReceiptFixture(join(dir, "stale-plan"), "a".repeat(64));
    await assert.rejects(
      () => rebuildUniverse(Object.freeze({
        ...stalePlan.input,
        expectedSourcePlanFingerprints: () =>
          Object.freeze({ startup: "b".repeat(64), events: "b".repeat(64) }),
      })),
      /does not match the current source plan/,
      "stale topic/capability plan must fail closed",
    );
    assert.equal(
      await stalePlan.store.load(),
      null,
      "a stale-plan receipt must not begin a durable run",
    );
    // After promotion, a changed discovery surface starts a new rolling run.
    // The durable verified-memo table is carried so unchanged Family
    // instances reuse their prior proofs and only new candidates attest.
    const resumeDrift = planReceiptFixture(join(dir, "resume-drift"), "c".repeat(64));
    const planC = () => Object.freeze({
      startup: "c".repeat(64),
      events: "c".repeat(64),
    });
    await rebuildUniverse(Object.freeze({
      ...resumeDrift.input,
      expectedSourcePlanFingerprints: planC,
    }));
    assert.equal(
      (await resumeDrift.store.load())?.readyGeneration?.generation,
      1,
      "first run seals and promotes receipts under plan c",
    );
    const driftReadopt = makeFixture(join(dir, "resume-drift"), {
      scanSwapWindow: async (scanInput) => Object.freeze({
        observations: Object.freeze(["a", "b", "c", "d"].map((id) =>
          Object.freeze({ id, block: SOURCE.number }),
        )),
        sourceReceipts: Object.freeze([Object.freeze({
          ...sourceReceipts(scanInput.fromBlock)[0]!,
          queryFingerprint: "d".repeat(64),
        })]),
      }),
      expectedSourcePlanFingerprints: () =>
        Object.freeze({ startup: "d".repeat(64), events: "d".repeat(64) }),
    });
    const readopted = await rebuildUniverse(driftReadopt.input);
    assert.equal(
      readopted.generation,
      2,
      "plan change promotes a fresh generation instead of rejecting",
    );
    assert.equal(
      driftReadopt.attestCalls.get("d"),
      1,
      "the new catalog candidate is attested fresh",
    );
    for (const id of ["a", "b", "c"]) {
      assert.equal(
        driftReadopt.attestCalls.has(id),
        false,
        "unchanged instances reuse carried memos under the new plan",
      );
    }
    const driftEnvelope = await driftReadopt.store.load();
    assert.equal(driftEnvelope?.readyGeneration?.generation, 2);
    assert.equal(driftEnvelope?.inProgressRun, null);
    assert.equal(driftEnvelope?.readyGeneration?.candidateAccounting.total, 4);
    assert.equal(
      driftEnvelope?.readyGeneration?.candidateAccounting.remainingUnaccounted,
      0,
    );

    // H: retain-channel candidates merge through the alias-collapsing dedupe.
    // A reverse-bound candidate spells the same instance under a different
    // familyCandidateKey than a retained startup entry (manager+poolId vs
    // poolId); merging by familyCandidateKey would attest the instance twice
    // and the ready promotion's instance set would contain duplicates
    // ("ready generation is not bound to completed run").
    const aliasMerge = makeFixture(join(dir, "alias-merge"), {
      scanSwapWindow: async (scanInput) => Object.freeze({
        observations: Object.freeze([Object.freeze({
          id: "a",
          block: SOURCE.number,
        })]),
        sourceReceipts: sourceReceipts(scanInput.fromBlock),
      }),
      // Simulates rebuildFamilyInstanceDedupeKey: alias spellings collapse.
      dedupeFamilyCandidates: (obs) => {
        const ids = new Set<string>();
        for (const observation of obs) {
          const item = observation as {
            kind?: unknown;
            candidate?: { id?: string; alias?: string };
            id?: string;
            alias?: string;
          };
          const candidate = item.kind === "startup-candidate"
            ? item.candidate ?? {}
            : item;
          ids.add(String(candidate.alias ?? candidate.id));
        }
        return Object.freeze([...ids].map((id) => Object.freeze({ id })));
      },
      // Reverse-bound candidate: distinct familyCandidateKey ("cand:a-rev")
      // but the same instance alias as the retained candidate.
      reverseBindOpaqueCandidates: async () => Object.freeze([
        Object.freeze({ id: "a-rev", alias: "a" }),
      ]),
      // Instance identity follows the alias, like the production memo
      // sealing: both spellings mint the SAME familyInstanceKey.
      sealDurableVerifiedMemo: (input) => {
        const item = input.candidate as { id: string; alias?: string };
        const instanceKey = "inst:" + (item.alias ?? item.id);
        return sealFixtureMemo({
          familyCandidateKey: "cand:" + item.id,
          familyInstanceKey: instanceKey,
          familyId: "univ2",
          candidateKey: "cand:" + item.id,
          instanceKey,
          candidateFingerprint: "cf:" + item.id,
          familyDefinitionHash: "fdh",
          validity: Object.freeze({
            policy: "immutable-code",
            authorityFingerprint: "auth",
            proofSource: Object.freeze({
              number: SOURCE.number,
              hash: SOURCE.hash,
            }),
          }),
          verifiedIdentity: Object.freeze({ kind: "identity" }),
          compiledDescriptor: Object.freeze({ kind: "descriptor" }),
          staticProjection: Object.freeze({ kind: "projection" }),
          evidenceFingerprint: "ef:" + item.id,
          candidateSnapshot: Object.freeze({ ...item }),
        });
      },
    });
    const aliasReady = await rebuildUniverse(aliasMerge.input);
    assert.equal(
      aliasReady.candidateAccounting.total,
      1,
      "the reverse-bound alias collapses into the retained candidate",
    );
    assert.equal(
      aliasReady.activeInstanceKeys.length,
      1,
      "the ready instance set carries the instance exactly once",
    );

    // I: two candidate keys verifying to ONE family instance (e.g. two curve
    // pools sharing one underlying) must yield exactly one verified outcome;
    // the second candidate becomes terminal-rejected "duplicate-instance" so
    // the ready promotion's instance set stays unique (it fails closed on
    // duplicates: "ready generation is not bound to completed run").
    const sharedInstance = makeFixture(join(dir, "shared-instance"), {
      scanSwapWindow: async (scanInput) => Object.freeze({
        observations: Object.freeze([
          Object.freeze({ id: "x", block: SOURCE.number }),
          Object.freeze({ id: "y", block: SOURCE.number }),
        ]),
        sourceReceipts: sourceReceipts(scanInput.fromBlock),
      }),
      sealDurableVerifiedMemo: (input) => {
        const id = String((input.candidate as { id: string }).id);
        return sealFixtureMemo({
          familyCandidateKey: "cand:" + id,
          familyInstanceKey: "inst:shared",
          familyId: "univ2",
          candidateKey: "cand:" + id,
          instanceKey: "inst:shared",
          candidateFingerprint: "cf:" + id,
          familyDefinitionHash: "fdh",
          validity: Object.freeze({
            policy: "immutable-code",
            authorityFingerprint: "auth",
            proofSource: Object.freeze({
              number: SOURCE.number,
              hash: SOURCE.hash,
            }),
          }),
          verifiedIdentity: Object.freeze({ kind: "identity" }),
          compiledDescriptor: Object.freeze({ kind: "descriptor" }),
          staticProjection: Object.freeze({ kind: "projection" }),
          evidenceFingerprint: "ef:" + id,
          candidateSnapshot: Object.freeze({ id }),
        });
      },
    });
    const sharedReady = await rebuildUniverse(sharedInstance.input);
    assert.equal(
      sharedReady.activeInstanceKeys.length,
      1,
      "one instance enters the ready set once",
    );
    const sharedStore = await sharedInstance.store.load();
    assert.equal(
      sharedStore?.readyGeneration?.candidateAccounting.verified,
      1,
    );
    assert.equal(
      sharedStore?.readyGeneration?.candidateAccounting.terminalRejected,
      1,
    );
    assert.equal(
      sharedStore?.inProgressRun,
      null,
      "the duplicate is accounted before the completed run clears",
    );
    // J: retained memos also pass through the shared instance gate. A new run
    // starts with no outcomes, reuses both memos, and still publishes only one
    // instance without re-running either lifecycle.
    const retainedDuplicateDir = await mkdtemp(
      join(tmpdir(), "universe-rebuild-retained-duplicate-"),
    );
    const retainedDuplicate = makeFixture(retainedDuplicateDir, {
      scanSwapWindow: async (scanInput) => Object.freeze({
        observations: Object.freeze([
          Object.freeze({ id: "retained-x", block: SOURCE.number }),
          Object.freeze({ id: "retained-y", block: SOURCE.number }),
        ]),
        sourceReceipts: sourceReceipts(scanInput.fromBlock),
      }),
    });
    const retainedDuplicateMemo = (id: string): DurableVerifiedMemo =>
      sealFixtureMemo({
        familyCandidateKey: "cand:" + id,
        familyInstanceKey: "inst:retained-shared",
        familyId: "univ2",
        candidateKey: "cand:" + id,
        instanceKey: "inst:retained-shared",
        candidateFingerprint: "cf:" + id,
        familyDefinitionHash: "fdh",
        validity: Object.freeze({
          policy: "immutable-code",
          authorityFingerprint: "auth",
          proofSource: Object.freeze({
            number: SOURCE.number,
            hash: SOURCE.hash,
          }),
        }),
        verifiedIdentity: Object.freeze({ kind: "identity" }),
        compiledDescriptor: Object.freeze({ kind: "descriptor" }),
        staticProjection: Object.freeze({ kind: "projection" }),
        evidenceFingerprint: "ef:" + id,
        candidateSnapshot: Object.freeze({ id }),
      });
    await retainedDuplicate.store.casUpsertMemo(
      retainedDuplicateMemo("retained-x"),
    );
    await retainedDuplicate.store.casUpsertMemo(
      retainedDuplicateMemo("retained-y"),
    );
    const retainedDuplicateReady = await rebuildUniverse(
      retainedDuplicate.input,
    );
    assert.deepEqual(retainedDuplicateReady.candidateAccounting, {
      total: 2,
      verified: 1,
      terminalRejected: 1,
      retryable: 0,
      remainingUnaccounted: 0,
    });
    assert.equal(retainedDuplicateReady.activeInstanceKeys.length, 1);
    assert.equal(retainedDuplicate.attestCalls.size, 0);
    const retainedDuplicateCheckpoint = await retainedDuplicate.store.load();
    assert.equal(retainedDuplicateCheckpoint?.inProgressRun, null);
    assert.equal(
      Object.keys(retainedDuplicateCheckpoint?.verifiedMemos ?? {}).filter(
        (key) => key === "cand:retained-x" || key === "cand:retained-y",
      ).length,
      1,
      "the duplicate retained memo is deleted by the terminal outcome",
    );
    await rm(retainedDuplicateDir, { recursive: true, force: true });
    // E: discovery is always the strict two-day range, while verified memo
    // snapshots retain pools indefinitely across rolling windows.
    const retentionDir = await mkdtemp(
      join(tmpdir(), "universe-rebuild-permanent-retention-"),
    );
    let retentionScan = 0;
    const scannedFromBlocks: number[] = [];
    const retained = makeFixture(retentionDir, {
      scanSwapWindow: async (scanInput) => {
        scannedFromBlocks.push(scanInput.fromBlock);
        const ids = retentionScan++ === 0
          ? ["a", "b", "c"]
          : ["a", "d"];
        return Object.freeze({
          observations: Object.freeze(ids.map((id) => Object.freeze({
            id,
            block: SOURCE.number,
          }))),
          sourceReceipts: sourceReceipts(scanInput.fromBlock),
        });
      },
    });
    const retainedFirst = await rebuildUniverse(retained.input);
    assert.deepEqual(
      [...retainedFirst.activeInstanceKeys].sort(),
      ["inst:a", "inst:b", "inst:c"],
    );
    const retainedSecond = await rebuildUniverse(retained.input);
    assert.deepEqual(
      [...retainedSecond.activeInstanceKeys].sort(),
      ["inst:a", "inst:b", "inst:c", "inst:d"],
      "A/D current discovery plus A/B/C memo retention yields A/B/C/D",
    );
    assert.equal(retained.attestCalls.get("b"), 1);
    assert.equal(retained.attestCalls.get("c"), 1);
    assert.equal(retained.attestCalls.get("d"), 1);
    assert.ok(
      scannedFromBlocks.every((fromBlock) =>
        fromBlock === strictEdgeCollectionFromBlock(SOURCE.number)
      ),
      "retention must never issue a 2-to-7-day source scan",
    );

    retained.invalidReusableKeys.add("b");
    await rebuildUniverse(retained.input);
    assert.equal(
      retained.attestCalls.get("b"),
      2,
      "an invalid retained memo is re-attested",
    );
    retained.terminalKeys.add("b");
    await rebuildUniverse(retained.input);
    const terminalCheckpoint = await retained.store.load();
    assert.equal(
      terminalCheckpoint?.verifiedMemos["cand:b"],
      undefined,
      "terminal rejection removes the old verified memo atomically",
    );
    const bCallsAfterTerminal = retained.attestCalls.get("b");
    const afterRemoval = await rebuildUniverse(retained.input);
    assert.deepEqual(
      [...afterRemoval.activeInstanceKeys].sort(),
      ["inst:a", "inst:c", "inst:d"],
      "a terminally invalidated memo is not retained into the next run",
    );
    assert.equal(retained.attestCalls.get("b"), bCallsAfterTerminal);
    await rm(retentionDir, { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log("universe rebuild runner PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
