import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { createSqliteDurableStore } from "../../durable-store/src/index.ts";
import {
  createRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
} from "../../runtime-authority/src/index.ts";
import {
  bindCheckpointDurableAuthorityLayoutV1,
  checkpointDurableAuthorityLayoutV1,
} from "../src/index.ts";

const h = (label: string): Hash => hashDomain("test/checkpoint-authority-layout", label);
const runtimeAuthority = projectRuntimeAuthorityDescriptorV1(createRuntimeAuthorityDescriptorV1({
  runtimeBindingId: h("runtime"),
  implementationCommit: "1".repeat(40),
}));

test("checkpoint exposes one content-commitment layout", () => {
  const layout = checkpointDurableAuthorityLayoutV1(runtimeAuthority);
  assert.equal(layout.storeRole, "checkpoint-runtime");
  assert.equal(layout.candidatePartitionAuthorityKind, "aloha/candidate-partition-commitment/v1");
  assert.equal(layout.outcomeKind, "aloha/candidate-final-outcome/v1");
  assert.equal(layout.partialOutcomeKind, "aloha/attestation-partial-outcome/v1");
  assert.throws(
    () => checkpointDurableAuthorityLayoutV1({ ...runtimeAuthority, runtimeBindingId: h("extra") } as never),
    /unknown field/i,
  );
});

test("a checkpoint database reopens under the same exact authority layout", () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-checkpoint-authority-layout-"));
  const path = join(directory, "checkpoint.sqlite");
  try {
    const first = createSqliteDurableStore(path);
    bindCheckpointDurableAuthorityLayoutV1(first, runtimeAuthority);
    first.close();

    const reopened = createSqliteDurableStore(path);
    assert.deepEqual(bindCheckpointDurableAuthorityLayoutV1(reopened, runtimeAuthority), checkpointDurableAuthorityLayoutV1(runtimeAuthority));
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
