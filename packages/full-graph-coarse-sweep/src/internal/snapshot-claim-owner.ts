import { assertHash, type Hash } from "../../../canonical-codec/src/index.ts";

export type FullGraphSweepSnapshotClaimV1 = object;

type SnapshotStateV1 = "in-flight" | "completed";

interface ClaimStateV1 {
  readonly snapshots: Map<Hash, SnapshotStateV1>;
  readonly key: Hash;
}

const authoritySnapshots = new WeakMap<object, Map<Hash, SnapshotStateV1>>();
const claims = new WeakMap<object, ClaimStateV1>();

/** Claim one exact snapshot without marking it complete. */
export function claimFullGraphSweepSnapshotV1(
  authority: object,
  keyInput: Hash,
): FullGraphSweepSnapshotClaimV1 {
  if (authority === null || typeof authority !== "object") {
    throw new TypeError("full-Graph sweep canonical authority is invalid");
  }
  const key = assertHash(keyInput, "fullGraphSweep.snapshotKey");
  let snapshots = authoritySnapshots.get(authority);
  if (snapshots === undefined) {
    snapshots = new Map<Hash, SnapshotStateV1>();
    authoritySnapshots.set(authority, snapshots);
  }
  const existing = snapshots.get(key);
  if (existing === "in-flight") throw new TypeError("full-Graph sweep is already in flight for this exact Ready/current-source snapshot");
  if (existing === "completed") throw new TypeError("full-Graph sweep already ran for this exact Ready/current-source snapshot");
  snapshots.set(key, "in-flight");
  const claim = Object.freeze(Object.create(null)) as FullGraphSweepSnapshotClaimV1;
  claims.set(claim, Object.freeze({ snapshots, key }));
  return claim;
}

/** Commit only after the complete denominator and final fences pass. */
export function commitFullGraphSweepSnapshotV1(claim: FullGraphSweepSnapshotClaimV1): void {
  const state = claims.get(claim);
  if (state === undefined || state.snapshots.get(state.key) !== "in-flight") {
    throw new TypeError("full-Graph sweep snapshot claim is invalid");
  }
  state.snapshots.set(state.key, "completed");
  claims.delete(claim);
}

/** Abort only this in-flight attempt; a later attempt may re-observe the same facts. */
export function abortFullGraphSweepSnapshotV1(claim: FullGraphSweepSnapshotClaimV1): void {
  const state = claims.get(claim);
  if (state === undefined || state.snapshots.get(state.key) !== "in-flight") {
    throw new TypeError("full-Graph sweep snapshot claim is invalid");
  }
  state.snapshots.delete(state.key);
  claims.delete(claim);
}
