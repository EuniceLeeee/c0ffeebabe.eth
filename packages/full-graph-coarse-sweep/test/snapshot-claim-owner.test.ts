import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain } from "../../canonical-codec/src/index.ts";
import {
  abortFullGraphSweepSnapshotV1,
  claimFullGraphSweepSnapshotV1,
  commitFullGraphSweepSnapshotV1,
} from "../src/internal/snapshot-claim-owner.ts";

const key = hashDomain("test/full-graph-snapshot-claim", "snapshot");

test("snapshot claim aborts failed attempts, rejects concurrency, and seals success", () => {
  const authority = Object.freeze(Object.create(null));
  const failed = claimFullGraphSweepSnapshotV1(authority, key);
  assert.throws(() => claimFullGraphSweepSnapshotV1(authority, key), /already in flight/);
  abortFullGraphSweepSnapshotV1(failed);
  assert.throws(() => abortFullGraphSweepSnapshotV1(failed), /claim is invalid/);

  const retry = claimFullGraphSweepSnapshotV1(authority, key);
  commitFullGraphSweepSnapshotV1(retry);
  assert.throws(() => commitFullGraphSweepSnapshotV1(retry), /claim is invalid/);
  assert.throws(() => claimFullGraphSweepSnapshotV1(authority, key), /already ran/);

  const otherAuthority = Object.freeze(Object.create(null));
  assert.doesNotThrow(() => abortFullGraphSweepSnapshotV1(
    claimFullGraphSweepSnapshotV1(otherAuthority, key),
  ));
});
