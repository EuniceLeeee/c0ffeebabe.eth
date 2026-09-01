import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashDomain } from "../../canonical-codec/src/index.ts";
import { createRuntimeAuthorityDescriptorV1 } from "../../runtime-authority/src/index.ts";
import { issueRuntimeInfrastructureV1 } from "../src/internal/runtime-infrastructure-owner.ts";

test("runtime infrastructure issues neutral exact REVM authority with executor and worker binding", () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-revm-runtime-"));
  const executable = join(directory, "revm-worker");
  try {
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(executable, 0o700);
    const descriptor = createRuntimeAuthorityDescriptorV1({
      runtimeBindingId: hashDomain("test/runtime-infrastructure/binding/v1", "runtime"),
      implementationCommit: "0123456789abcdef0123456789abcdef01234567",
    });
    const infrastructure = issueRuntimeInfrastructureV1({
      runtimeAuthority: descriptor,
      processEpoch: "process-1",
      rpcEndpoint: "http://127.0.0.1:1",
      rpcTimeoutMs: 1,
      revmWorkerExecutablePath: executable,
    });

    const binding = infrastructure.revm.authority.issue();
    assert.deepEqual(
      Object.keys(binding.runtime.runtimeAuthority).sort(),
      ["authorityBindingHash", "implementationCommit"],
    );
    assert.equal(binding.runtime.runtimeAuthority.authorityBindingHash, descriptor.authorityBindingHash);
    assert.equal(binding.runtime.runtimeAuthority.implementationCommit, descriptor.implementationCommit);
    assert.equal(binding.authorityRoot, binding.runtime.executorAuthorityRoot);
    assert.equal(binding.workerEpoch, binding.runtime.workerEpoch);
    assert.equal(binding.executorSessionHash, binding.runtime.executorSessionHash);
    assert.equal(binding.runtime.engineBuildFingerprint, infrastructure.executorQualification.engineBuildFingerprint);
    assert.equal(binding.runtime.executableFingerprint, infrastructure.executorQualification.executableFingerprint);
    assert.equal(binding.runtime.qualifiedExecutorRegistryRoot, infrastructure.executorQualification.qualifiedExecutorRegistryRoot);
    assert.equal(binding.runtime.selectedExecutorLeafHash, infrastructure.executorQualification.selectedExecutorLeafHash);
    assert.equal(Object.prototype.hasOwnProperty.call(binding, "release"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(binding.runtime.runtimeAuthority, "authorityClass"), false);
    infrastructure.revm.authority.assertCurrent(binding);
    assert.throws(
      () => infrastructure.revm.authority.assertCurrent({ ...binding }),
      /stale or foreign/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
