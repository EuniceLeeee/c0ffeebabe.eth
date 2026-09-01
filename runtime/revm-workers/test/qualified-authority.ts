import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  createRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
} from "../../../packages/runtime-authority/src/index.ts";
import type {
  RevmWorkerAuthorityBindingV1,
  RevmWorkerRuntimeLeaseV1,
} from "../src/protocol.ts";
import type { RevmWorkerAuthorityIssuer } from "../src/lifecycle.ts";
import { issueRevmWorkerAuthorityIssuer } from "../src/internal/authority.ts";

const h = (value: string): Hash => hashDomain("test/revm-runtime", value);
const executor = {
  executorKind: "revm",
  engineBuildFingerprint: h("engine"),
  executableFingerprint: h("executable"),
  closureFingerprint: h("closure"),
  protocolFingerprint: h("protocol"),
  schemaFingerprint: h("schema"),
} as const;

export function createTestRevmAuthorityIssuer(epochs: readonly string[] = ["epoch-1", "epoch-2", "epoch-3"]): RevmWorkerAuthorityIssuer {
  const runtimeAuthority = projectRuntimeAuthorityDescriptorV1(createRuntimeAuthorityDescriptorV1({
    runtimeBindingId: h("runtime-binding"),
    implementationCommit: "0123456789abcdef0123456789abcdef01234567",
  }));
  const qualifiedExecutorRegistryRoot = h("qualified-executor-registry");
  const selectedExecutorLeafHash = h("selected-executor-leaf");
  const executorAuthorityRoot = hashDomain("aloha/runtime/executor-authority/v1", {
    runtimeAuthority,
    qualifiedExecutorRegistryRoot,
    selectedExecutorLeafHash,
  });
  let index = 0;
  let sequence = 0;
  const issued = new WeakSet<object>();
  const issue = (): RevmWorkerAuthorityBindingV1 => {
    const workerEpoch = epochs[index++ % epochs.length]!;
    sequence += 1;
    const executorSessionHash = hashDomain("aloha/runtime/revm-worker-session/v1", {
      executorAuthorityRoot,
      workerEpoch,
      sequence: sequence.toString(),
    });
    const runtime: RevmWorkerRuntimeLeaseV1 = Object.freeze({
      runtimeAuthority,
      executorAuthorityRoot,
      qualifiedExecutorRegistryRoot,
      selectedExecutorLeafHash,
      ...executor,
      workerEpoch,
      executorSessionHash,
    });
    const binding: RevmWorkerAuthorityBindingV1 = Object.freeze({
      runtime,
      authorityRoot: executorAuthorityRoot,
      workerEpoch,
      executorSessionHash,
    });
    issued.add(binding);
    return binding;
  };
  return issueRevmWorkerAuthorityIssuer({
    issue,
    assertCurrent(binding: RevmWorkerAuthorityBindingV1): void {
      if (!issued.has(binding)) throw new Error("worker authority is stale");
    },
  });
}

export function authorityFor(epoch: string): RevmWorkerAuthorityBindingV1 {
  return createTestRevmAuthorityIssuer([epoch]).issue();
}
