import {
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalJson,
} from "../../../canonical-codec/src/index.ts";
import {
  assertIssuedRevmWorkerAuthorityIssuer,
} from "../../../../runtime/revm-workers/src/internal/authority.ts";
import type { RevmWorkerAuthorityIssuer } from "../../../../runtime/revm-workers/src/lifecycle.ts";
import type { QualifiedFinalSimulationExecutorStateFactV1 } from "../index.ts";

/** Opaque process-local capability; the snapshot fields are deliberately not on its public shape. */
export interface QualifiedFinalSimulationExecutorStateSnapshotCapabilityV1 {
  readonly __qualifiedFinalSimulationExecutorStateSnapshotCapability: unique symbol;
}

const states = new WeakMap<object, QualifiedFinalSimulationExecutorStateFactV1>();

export interface QualifiedFinalSimulationExecutorStateSnapshotIssuerV1 {
  readonly issue: () => QualifiedFinalSimulationExecutorStateSnapshotCapabilityV1;
}

/**
 * Internal release/state-owner seam.  It is intentionally not re-exported by
 * @aloha/final-sim; a future Reth/state authority must supply this capability.
 */
export function createQualifiedFinalSimulationExecutorStateSnapshotIssuer(input: {
  readonly fact: QualifiedFinalSimulationExecutorStateFactV1;
  readonly authority: RevmWorkerAuthorityIssuer;
}): QualifiedFinalSimulationExecutorStateSnapshotIssuerV1 {
  if (input === null || typeof input !== "object" || input.fact === null || typeof input.fact !== "object") {
    throw new TypeError("qualified executor state fact is required");
  }
  const authority = assertIssuedRevmWorkerAuthorityIssuer(input.authority);
  authority.assertCurrent(input.fact.authorityBinding);
  if (input.fact.kind !== "aloha.qualified-final-simulation-executor-state-v1") throw new TypeError("qualified executor state fact kind is unsupported");
  const snapshot = deepFreeze(decodeCanonicalJson(encodeCanonicalJson(input.fact))) as unknown as QualifiedFinalSimulationExecutorStateFactV1;
  return Object.freeze({
    issue(): QualifiedFinalSimulationExecutorStateSnapshotCapabilityV1 {
      authority.assertCurrent(snapshot.authorityBinding);
      const capability = Object.freeze(Object.create(null)) as QualifiedFinalSimulationExecutorStateSnapshotCapabilityV1;
      states.set(capability, snapshot);
      return capability;
    },
  });
}

export function readQualifiedFinalSimulationExecutorStateSnapshot(
  value: unknown,
): QualifiedFinalSimulationExecutorStateFactV1 {
  if (value === null || typeof value !== "object") throw new TypeError("qualified executor state snapshot capability is required");
  const snapshot = states.get(value);
  if (snapshot === undefined) throw new TypeError("qualified executor state snapshot capability is not issuer-issued");
  return snapshot;
}
