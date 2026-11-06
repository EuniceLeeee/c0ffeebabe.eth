import { readFileSync } from "node:fs";
import { createRebuildWiring } from "../universe-rebuild-production.js";
import { canonicalJsonFingerprint } from "../universe-rebuild-checkpoint.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFamilySetOnlyReadyUpdate, assertReadyStageManifest, readyFamilyNeedsSupplement, runReadyFamilyMaintenance, withReadyMaintenanceLease } from "../ready-family-update-cli.js";
import type { ReadyFamilyPartition } from "../universe-rebuild-checkpoint.js";

const directory = await mkdtemp(join(tmpdir(), "ready-maintenance-test-"));
try {
  const checkpoint = join(directory, "checkpoint.json");
  await withReadyMaintenanceLease(checkpoint, async () => {
    const owner = JSON.parse(await readFile(checkpoint + ".maintenance.lock", "utf8"));
    assert.equal(owner.pid, process.pid);
    await assert.rejects(withReadyMaintenanceLease(checkpoint, async () => assert.fail("duplicate writer entered")), { code: "EEXIST" });
  });
  await assert.rejects(stat(checkpoint + ".maintenance.lock"), { code: "ENOENT" });
  await assert.rejects(withReadyMaintenanceLease(checkpoint, async () => { throw new Error("fixture failure"); }), /fixture failure/);
  await assert.rejects(stat(checkpoint + ".maintenance.lock"), { code: "ENOENT" });
  const manifest = join(directory, "parent.json");
  await assertReadyStageManifest(manifest, "parent-a");
  await assertReadyStageManifest(manifest, "parent-a");
  await assert.rejects(assertReadyStageManifest(manifest, "parent-b"), /parent manifest mismatch/);
  assert.equal(await readFile(manifest, "utf8"), "parent-a");
  for (const args of [[], ["other"], ["build"], ["build", "--expect-update", "family-set"], ["update", "--expect-update", "unknown"],
    ["update", "--revalidate-proofs", "invalid"], ["build", "--revalidate-proofs", "0x" + "a".repeat(64)],
    ["update", "--revalidate-proofs", "0x" + "a".repeat(64), "--expect-update", "family-set"],
    ["update", "--checkpoint", checkpoint, "--checkpoint", checkpoint]]) {
    await assert.rejects(runReadyFamilyMaintenance(args));
  }
  const selection = { discoveryDefinitionHash: "discovery-v1", familyDefinitionHash: "definition-v2", isVerifiedMemoCurrent: () => true };
  assert(readyFamilyNeedsSupplement({ ...selection, partition: undefined }));
  const partition = { discoveryDefinitionHash: "discovery-v1", outcomesByCandidateKey: {
    rejected: { status: "terminal-rejected", familyCandidateKey: "rejected", familyDefinitionHash: "definition-v1" },
  } } as unknown as ReadyFamilyPartition;
  assert(readyFamilyNeedsSupplement({ ...selection, partition }), "terminal-only Family must be retried after probe code change");
  assert.equal(readyFamilyNeedsSupplement({ ...selection, familyDefinitionHash: "definition-v1", partition }), false);
  assert(readyFamilyNeedsSupplement({ ...selection, familyDefinitionHash: "definition-v1", discoveryDefinitionHash: "discovery-v2", partition }));
  const verified = { ...partition, outcomesByCandidateKey: { verified: { status: "verified", familyCandidateKey: "verified" } } } as unknown as ReadyFamilyPartition;
  assert.equal(readyFamilyNeedsSupplement({ ...selection, partition: verified }), false);
  assert(readyFamilyNeedsSupplement({ ...selection, partition: verified, isVerifiedMemoCurrent: () => false }));
  assert(readyFamilyNeedsSupplement({ ...selection, partition: { ...partition,
    familyDefinitionHash: "old-definition", outcomesByCandidateKey: {} } }));
  const oldRows = { x: { address: "one", source: "receipt" } };
  const active = { old: { ...partition, enabled: true,
    candidateSetHash: canonicalJsonFingerprint(oldRows, "universe-candidate-partition-v1:") } };
  const two = { ...active, removed: active.old };
  assert(isFamilySetOnlyReadyUpdate(active, ["old","new"], ["new"]));
  assert(isFamilySetOnlyReadyUpdate(two, ["old"], []));
  assert(isFamilySetOnlyReadyUpdate(two, ["old","new"], ["new"], new Map([["old",oldRows]])));
  assert(!isFamilySetOnlyReadyUpdate(two, ["old","new"], ["new"], new Map([["old",{ x: { address: "one", source: "changed" }}]])));
  assert(!isFamilySetOnlyReadyUpdate(two, ["old","new"], ["old","new"]));
  assert(!isFamilySetOnlyReadyUpdate(active, ["old"], []));
  console.log("Ready maintenance CLI PASS: exclusive lease, error release, parent binding, option refusal; no RPC");
} finally { await rm(directory, { recursive: true, force: true }); }

// These same-block observations can spell one Family instance with two durable
// keys. The exact selection still owns the original evidence and transaction.
{
  const recorded = JSON.parse(readFileSync(new URL("./fixtures/ready-selected-univ4-aliases.json", import.meta.url), "utf8")) as {
    source: { number: number; hash: string };
    pairs: { selected: Record<string, unknown>; activity: Record<string, unknown> }[];
  };
  const w = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: ["univ4", "univ4-fee-hook"] });
  assert.equal(recorded.pairs.length, 12);
  const asNomination = (candidate: Record<string, unknown>) => ({ kind: "startup-candidate", candidate });
  for (const { selected, activity } of recorded.pairs) {
    assert.equal(selected.familyId, "univ4");
    assert.equal(selected.poolId, activity.poolId);
    for (const c of [selected,activity]) {
      assert.equal(c.blockNumber,recorded.source.number); assert.equal(c.blockHash,recorded.source.hash);
    }
    const key = w.familyCandidateKey(selected), alternate = w.familyCandidateKey(activity);
    assert.notEqual(key, alternate);
    const inputs = [asNomination(selected), asNomination(activity)];
    assert.deepEqual(w.dedupeFamilyCandidates(inputs), [activity], "unscoped discovery retains its normal representative");
    for (const ordered of [inputs, [...inputs].reverse()]) {
      assert.deepEqual(w.dedupeFamilyCandidates(ordered, new Set([key])), [selected]);
      assert.deepEqual(w.dedupeFamilyCandidates(ordered, new Set([alternate])), [activity]);
      assert.throws(() => w.dedupeFamilyCandidates(ordered, new Set([key, alternate])), /two durable keys for one Family instance/);
    }
    const otherFamily = { ...selected, familyId: "univ4-fee-hook", adapter: "univ4-fee-hook" };
    const both = w.dedupeFamilyCandidates([...inputs, asNomination(otherFamily)], new Set([key, w.familyCandidateKey(otherFamily)]));
    assert.deepEqual(both, [selected, otherFamily], "Family ownership remains independent");
  }
}
