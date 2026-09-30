import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertReadyStageManifest, readyFamilyNeedsSupplement, runReadyFamilyMaintenance, withReadyMaintenanceLease } from "../ready-family-update-cli.js";
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
  for (const args of [[], ["other"], ["build"], ["update", "--checkpoint", checkpoint, "--checkpoint", checkpoint]]) {
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
  console.log("Ready maintenance CLI PASS: exclusive lease, error release, parent binding, option refusal; no RPC");
} finally { await rm(directory, { recursive: true, force: true }); }
