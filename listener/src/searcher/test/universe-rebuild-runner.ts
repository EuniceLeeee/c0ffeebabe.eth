import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UniverseRebuildCheckpointStore,
  type DurableVerifiedMemo,
  type StartupCheckpointEnvelope,
} from "../universe-rebuild-checkpoint.js";
import {
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
  overrides?: Partial<Pick<RebuildUniverseInput, "runId" | "scanSwapWindow">>,
): Fixture {
  const store = new UniverseRebuildCheckpointStore({
    path: join(dir, "checkpoint.json"),
  });
  const attestCalls = new Map<string, number>();
  const failKeys = new Set<string>(["c"]);
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
    lookbackBlocks: 14_400,
    attestationConcurrency: 2,
    freezeCanonicalHead: async () => SOURCE,
    scanSwapWindow: async () => observations(["a", "b", "c"]),
    familyCandidateKey: (candidate) =>
      "cand:" + String((candidate as { id: string }).id),
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
    buildCoverage: ({ cutoff }) => Object.freeze([Object.freeze({
      familyId: "univ2",
      sourceId: "startup-universe",
      completeThroughBlock: cutoff.number,
      completeThroughHash: cutoff.hash,
    })]),
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
    // A: retryable blocks ready; resume verifies only the diff.
    const f = makeFixture(dir);
    await assert.rejects(
      () => rebuildUniverse(f.input),
      (error: unknown) =>
        error instanceof UniverseRunIncomplete &&
        error.retryableCount === 1,
      "retryable must block the ready generation",
    );
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

    // Resume: verified keys are skipped (no identity RPC), only the diff runs.
    await assert.rejects(
      () => rebuildUniverse(f.input),
      UniverseRunIncomplete,
    );
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
    assert.equal(f.attestCalls.get("c"), 2, "retryable key is re-attested");

    // A code/family/authority change between process starts invalidates an
    // already-durable verified memo. The key is re-attested, while unchanged
    // verified siblings still skip the lifecycle.
    f.invalidReusableKeys.add("a");
    await assert.rejects(
      () => rebuildUniverse(f.input),
      UniverseRunIncomplete,
    );
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

    // After the last retryable closes, the run finalizes into ready.
    const aCallsBeforeFinalize = f.attestCalls.get("a");
    const ready = await rebuildUniverse(f.input);
    assert.equal(ready.generation, 1);
    assert.deepEqual(
      [...ready.activeInstanceKeys].sort(),
      ["inst:a", "inst:b", "inst:c"],
    );
    assert.deepEqual(
      f.builtFamilySizes,
      [3],
      "one family publication must retain all three instance pools",
    );
    checkpoint = await f.store.load();
    assert.equal(checkpoint?.inProgressRun, null);
    assert.equal(checkpoint?.readyGeneration?.generation, 1);
    assert.equal(
      f.attestCalls.get("a"),
      aCallsBeforeFinalize,
      "a valid durable memo must not re-attest during finalization",
    );

    // B: a NEW run reuses verified memos across rebuilds (order independent).
    // Shuffled candidate order; scan returns [b, a] (order changed).
    const f2 = makeFixture(dir, {
      runId: "run-2",
      scanSwapWindow: async () =>
        Object.freeze([
          Object.freeze({ id: "b", block: SOURCE.number }),
          Object.freeze({ id: "a", block: SOURCE.number }),
        ]),
    });
    const ready2 = await rebuildUniverse(f2.input);
    assert.equal(ready2.generation, 2);
    assert.equal(
      f2.attestCalls.size,
      0,
      "cross-rebuild memo reuse must skip identity RPC entirely",
    );
    assert.deepEqual(
      [...ready2.activeInstanceKeys].sort(),
      ["inst:a", "inst:b"],
    );
    assert.notEqual(
      ready2.catalogHash,
      ready.catalogHash,
      "catalog root must bind the exact active instance set",
    );
    assert.notEqual(
      ready2.graphHash,
      ready.graphHash,
      "graph root must bind graph contents, not object stringification",
    );

    // C: a chain-proven terminal rejection is already accounted for. A
    // restart of the same incomplete run retries only retryable keys.
    const terminalFixture = makeFixture(join(dir, "terminal"));
    terminalFixture.terminalKeys.add("b");
    await assert.rejects(
      () => rebuildUniverse(terminalFixture.input),
      UniverseRunIncomplete,
    );
    assert.equal(terminalFixture.attestCalls.get("b"), 1);
    await assert.rejects(
      () => rebuildUniverse(terminalFixture.input),
      UniverseRunIncomplete,
    );
    assert.equal(
      terminalFixture.attestCalls.get("b"),
      1,
      "resume must preserve a chain-proven terminal rejection",
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log("universe rebuild runner PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
