import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UniverseRebuildCheckpointStore,
  canonicalJson,
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

const SOURCE = Object.freeze({
  number: 25_750_000,
  hash: "0x" + "a1".repeat(32),
  generation: 1,
});

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
        [...new Set(obs.map((o) => String((o as { id: string }).id)))],
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
      return Object.freeze({
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
        memoFingerprint: "memo:" + id,
      }) as DurableVerifiedMemo;
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
  const dir = await mkdtemp(join(tmpdir(), "universe-rebuild-runner-"));
  try {
    // A: retryable does NOT block ready: the verified partition is published,
    // residual retryable outcomes stay durable in the kept run and are closed
    // later by the probe. Resume skips verified keys and preserves retryable.
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
      checkpoint?.inProgressRun?.outcomesByCandidateKey["cand:c"]?.status,
      "retryable",
      "RPC failure is persisted as retryable, never as rejected",
    );
    assert.equal(
      checkpoint?.inProgressRun?.outcomesByCandidateKey["cand:c"]
        ?.status === "retryable" &&
        (checkpoint?.inProgressRun?.outcomesByCandidateKey["cand:c"] as {
          attemptCount: number;
        }).attemptCount,
      1,
    );

    // Resume: verified keys are skipped (no identity RPC), retryable keys are
    // preserved (not re-attested) so startup never blocks on them.
    const resumedReady = await rebuildUniverse(f.input);
    assert.equal(resumedReady.generation, firstReady.generation + 1);
    assert.equal(
      f.scanCalls(),
      1,
      "resume must use the durable exact candidate partition without rescanning",
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

    // Probe: only the target key, at the fixed cutoff.
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

    // The residual retryable ("cand:c") stays out of the Graph: the ready
    // generation admits only verified instances, and the run is kept so the
    // probe can close the retryable later.
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
    assert.notEqual(checkpoint?.inProgressRun, null);
    assert.equal(
      checkpoint?.inProgressRun?.outcomesByCandidateKey["cand:c"]?.status,
      "verified",
      "the probe-closed instance stays durable in the kept run",
    );
    assert.equal(checkpoint?.readyGeneration?.generation, firstReady.generation + 3);
    assert.equal(
      f.attestCalls.get("a"),
      aCallsBeforeFinalize,
      "a valid durable memo must not re-attest during finalization",
    );


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
    // Resume drift: receipts were durable under plan X; the catalog changed
    // (same pattern ids, new implementation) so plan Y must reject the old
    // receipts instead of silently attesting the old partition to ready.
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
    await assert.rejects(
      () => rebuildUniverse(Object.freeze({
        ...resumeDrift.input,
        expectedSourcePlanFingerprints: () =>
          Object.freeze({ startup: "d".repeat(64), events: "d".repeat(64) }),
      })),
      /does not match the current source plan/,
      "resume must reject receipts sealed by a different code version",
    );

    // G: the deployed pre-receipt fixed checkpoint is upgraded in place.
    // The runner replays the original fixed range, requires the exact same
    // candidate partition, attaches receipts, and preserves runId/cutoff.
    const legacy = makeFixture(join(dir, "legacy-source-receipt"));
    const legacyCandidates = Object.freeze({
      "cand:a": Object.freeze({ id: "a" }),
      "cand:b": Object.freeze({ id: "b" }),
      "cand:c": Object.freeze({ id: "c" }),
    });
    const digest = (value: string): string =>
      createHash("sha256").update(value).digest("hex");
    await legacy.store.beginOrResumeRun({
      expectedRevision: 0,
      runId: "run-1",
      cutoff: SOURCE,
      fromBlock: SOURCE.number - 14_399,
      universeHash: digest(
        "universe-candidate-partition-v1:" + canonicalJson(legacyCandidates),
      ),
      candidateSetHash: digest(
        "candidate-set-v1:cand:a,cand:b,cand:c",
      ),
      candidateCount: 3,
      candidatesByKey: legacyCandidates,
      observedThrough: Object.freeze({
        number: SOURCE.number,
        hash: SOURCE.hash,
      }),
    });
    await rebuildUniverse(legacy.input);
    const migrated = await legacy.store.load();
    assert.notEqual(migrated?.inProgressRun, null);
    assert.equal(
      migrated?.readyGeneration?.universeRange.fromBlock,
      SOURCE.number - 14_399,
      "the incumbent legacy range is preserved and promoted",
    );
    assert.equal(
      legacy.scanCalls(),
      1,
      "legacy receipt backfill scans once and resumes the incumbent run",
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
        return Object.freeze({
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
          memoFingerprint: "memo:" + item.id,
        }) as DurableVerifiedMemo;
      },
    });
    const aliasReady = await rebuildUniverse(aliasMerge.input);
    assert.equal(
      (await aliasMerge.store.load())?.inProgressRun?.candidateCount,
      1,
      "the reverse-bound alias collapses into the retained candidate",
    );
    assert.equal(
      aliasReady.activeInstanceKeys.length,
      1,
      "the ready instance set carries the instance exactly once",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log("universe rebuild runner PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
