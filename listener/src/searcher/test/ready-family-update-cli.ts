import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRebuildWiring } from "../universe-rebuild-production.js";
import { canonicalJson, canonicalJsonFingerprint } from "../universe-rebuild-checkpoint.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFamilySetOnlyReadyUpdate, assertReadyStageManifest, parseReadyFamilyIds, readyFamilyNeedsSupplement,
  readyMaintenanceReviewFingerprint, runReadyFamilyMaintenance, withReadyMaintenanceLease } from "../ready-family-update-cli.js";
import type { ReadyFamilyPartition } from "../universe-rebuild-checkpoint.js";

const directory = await mkdtemp(join(tmpdir(), "ready-maintenance-test-"));
try {
  const checkpoint = join(directory, "checkpoint.json");
  await withReadyMaintenanceLease(checkpoint, async () => {
    const owner = JSON.parse(await readFile(checkpoint + ".maintenance.lock", "utf8"));
    assert.equal(owner.pid, process.pid);
    await assert.rejects(withReadyMaintenanceLease(checkpoint, async () => assert.fail("duplicate writer entered")), { code: "EEXIST" });
    const scope = ["--checkpoint", checkpoint, "--archive", directory];
    await assert.rejects(runReadyFamilyMaintenance(["update", "--force-update", ...scope]), { code: "EEXIST" });
    await assert.rejects(runReadyFamilyMaintenance(["update", "--force-retryable", ...scope]), { code: "EEXIST" });
    await assert.rejects(runReadyFamilyMaintenance(["update", "--families", "families.json", ...scope]), { code: "EEXIST" });
    await assert.rejects(runReadyFamilyMaintenance(["build", "--candidates", "candidates.json", ...scope]), { code: "EEXIST" });
    await assert.rejects(runReadyFamilyMaintenance(["build", ...scope, "--force-update"]), /requires update mode/);
    await assert.rejects(runReadyFamilyMaintenance(["build", ...scope, "--force-retryable"]), /requires update mode/);
    await assert.rejects(runReadyFamilyMaintenance(["update", ...scope, "--force-update", "--force-update"]), /invalid Ready maintenance option/);
    await assert.rejects(runReadyFamilyMaintenance(["update", ...scope, "--candidates", "--force-update"]), /invalid Ready maintenance option/);
    await assert.rejects(runReadyFamilyMaintenance(["update", ...scope, "--force-update", "--expect-update", "family-set"]), /cannot be combined/);
    await assert.rejects(runReadyFamilyMaintenance(["update", ...scope, "--force-update",
      "--revalidate-proofs", "0x" + "a".repeat(64)]), /cannot be combined/);
    for (const conflict of [["--force-update"], ["--expect-update", "family-set"],
      ["--revalidate-proofs", "0x" + "a".repeat(64)]]) {
      await assert.rejects(runReadyFamilyMaintenance(["update", ...scope, "--force-retryable", ...conflict]), /cannot be combined/);
    }
    await assert.rejects(runReadyFamilyMaintenance(["update", ...scope, "--force-retryable", "--force-retryable"]), /invalid Ready maintenance option/);
    await assert.rejects(runReadyFamilyMaintenance(["update", ...scope, "--families", "--force-retryable"]), /invalid Ready maintenance option/);
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
  assert.deepEqual(parseReadyFamilyIds(["univ4", "univ3"]), ["univ3", "univ4"]);
  assert.deepEqual(parseReadyFamilyIds([]), [], "an empty complete table means remove all, not use every installed family");
  for (const invalid of [null, {}, [""], [" univ3"], ["univ3", 3], ["univ3", "univ3"]]) {
    assert.throws(() => parseReadyFamilyIds(invalid), /Family ID/);
  }
  const reviewInputs = {
    parent: { generation: 7, universeHash: "universe", catalogHash: "catalog" },
    range: { fromBlock: 100, toBlock: 110 },
    source: { number: 110, hash: "0x" + "b".repeat(64), generation: 110 },
    definitions: [["univ3", "h3"], ["univ4", "h4"]] as const,
    executionIdentity: { executor: "executor", transactionOrigin: "origin" },
    sourcePlans: { startup: "startup", activity: "activity" },
    selection: "previous-and-discovered",
  };
  const ordinary = readyMaintenanceReviewFingerprint(reviewInputs);
  const oldFingerprint = (extra: Record<string, unknown> = {}) => createHash("sha256").update(canonicalJson({
    version: 1, parent: [7, "universe", "catalog"], range: reviewInputs.range, source: reviewInputs.source,
    definitions: reviewInputs.definitions, executionIdentity: reviewInputs.executionIdentity,
    sourcePlans: reviewInputs.sourcePlans, selection: reviewInputs.selection, ...extra,
  })).digest("hex");
  assert.equal(ordinary, oldFingerprint(), "ordinary interrupted reviews retain their original input identity");
  assert.equal(readyMaintenanceReviewFingerprint({ ...reviewInputs, forceUpdate: true }),
    oldFingerprint({ forceUpdate: true }), "legacy negative force retains its original resume identity");
  assert.equal(readyMaintenanceReviewFingerprint({ ...reviewInputs, proofRuntimeHash: "runtime" }),
    oldFingerprint({ proofRuntimeHash: "runtime" }), "proof-runtime force retains its original resume identity");
  assert.equal(readyMaintenanceReviewFingerprint({ ...reviewInputs, definitions: [...reviewInputs.definitions].reverse() }), ordinary,
    "family table order is not a membership change");
  const retryForce = readyMaintenanceReviewFingerprint({ ...reviewInputs, forceStatuses: ["retryable"] });
  assert.notEqual(retryForce, ordinary, "a selective force cannot be resumed as an ordinary run");
  assert.notEqual(retryForce, readyMaintenanceReviewFingerprint({ ...reviewInputs, forceUpdate: true }),
    "retryable-only and all-negative force must not share a run");
  assert.equal(retryForce, readyMaintenanceReviewFingerprint({ ...reviewInputs, forceStatuses: ["retryable"] }));
  for (const change of [
    { definitions: [["univ3", "changed"], ["univ4", "h4"]] as const },
    { definitions: [["univ3", "h3"]] as const },
    { definitions: [] },
    { selection: "an-exact-candidate-file-sha" },
    { source: { ...reviewInputs.source, hash: "0x" + "c".repeat(64) } },
    { executionIdentity: { ...reviewInputs.executionIdentity, executor: "other" } },
    { sourcePlans: { ...reviewInputs.sourcePlans, activity: "changed" } },
  ]) assert.notEqual(readyMaintenanceReviewFingerprint({ ...reviewInputs, ...change }), ordinary,
    "membership, candidate, definition, source and execution bindings cannot change during a review");
  console.log("Ready maintenance CLI PASS: complete family table, selective force, bound resume, lease and legacy guards; no RPC");
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
