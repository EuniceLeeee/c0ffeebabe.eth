import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { createSqliteDurableStore } from "../../durable-store/src/index.ts";
import {
  createSignedReleaseRuntimeAuthorityDescriptorV1,
  createUnsignedDryRunRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
} from "../../runtime-authority/src/index.ts";
import {
  bindCheckpointDurableAuthorityLayoutV1,
  checkpointDurableAuthorityLayoutV1,
} from "../src/index.ts";

const h = (label: string): Hash => hashDomain("test/checkpoint-authority-layout", label);
const signed = projectRuntimeAuthorityDescriptorV1(createSignedReleaseRuntimeAuthorityDescriptorV1({
  authorityClass: "signed-release",
  runtimeBindingId: h("signed"),
  releaseProvenanceHash: h("release"),
  implementationCommit: "1".repeat(40),
}));
const unsigned = projectRuntimeAuthorityDescriptorV1(createUnsignedDryRunRuntimeAuthorityDescriptorV1({
  authorityClass: "unsigned-dry-run",
  runtimeBindingId: h("unsigned"),
  implementationCommit: "1".repeat(40),
}));

test("checkpoint signed and unsigned layouts have distinct physical identities", () => {
  const signedLayout = checkpointDurableAuthorityLayoutV1(signed);
  const unsignedLayout = checkpointDurableAuthorityLayoutV1(unsigned);
  assert.notEqual(signedLayout.storeRole, unsignedLayout.storeRole);
  assert.notEqual(signedLayout.rootKind, unsignedLayout.rootKind);
  assert.notEqual(signedLayout.runKind, unsignedLayout.runKind);
  assert.notEqual(signedLayout.candidatePartitionAuthorityKind, unsignedLayout.candidatePartitionAuthorityKind);
  assert.notEqual(signedLayout.outcomeKind, unsignedLayout.outcomeKind);
  assert.notEqual(signedLayout.partialOutcomeKind, unsignedLayout.partialOutcomeKind);
  assert.notEqual(signedLayout.candidateIndexNamespace, unsignedLayout.candidateIndexNamespace);
  assert.notEqual(signedLayout.schemaHash, unsignedLayout.schemaHash);
});

test("a checkpoint database bound to one authority class rejects the other", () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-checkpoint-authority-layout-"));
  const path = join(directory, "checkpoint.sqlite");
  try {
    const first = createSqliteDurableStore(path);
    bindCheckpointDurableAuthorityLayoutV1(first, unsigned);
    first.close();

    const reopened = createSqliteDurableStore(path);
    assert.throws(
      () => bindCheckpointDurableAuthorityLayoutV1(reopened, signed),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "store-role-mismatch",
    );
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
