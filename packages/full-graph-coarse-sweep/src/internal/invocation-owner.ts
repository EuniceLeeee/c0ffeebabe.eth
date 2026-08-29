import { assertExactKeys, assertHash, assertNonEmptyString } from "../../../canonical-codec/src/index.ts";
import {
  readIssuedProducerCurrentSourceSessionCapabilityV1,
  type ProducerSessionV1,
} from "../../../canonical-source/src/index.ts";
import type { StartupProducerLeaseV1 } from "../../../startup-runtime/src/index.ts";
import type {
  FullGraphCoarseSweepInvocationCapabilityV1,
  FullGraphCoarseSweepSourceReadCapabilityV1,
} from "../index.ts";
import {
  consumeFullGraphCoarseSweepSourceReadCapabilityV1,
  readFullGraphCoarseSweepSourceReadCapabilityV1,
} from "./source-read-owner.ts";

export interface FullGraphCoarseSweepAmountSeedV1 {
  readonly amountIn: string;
  readonly recipient: string;
}

export interface FullGraphCoarseSweepInvocationStateV1 {
  readonly session: ProducerSessionV1<StartupProducerLeaseV1>;
  readonly canonicalSourceAuthority: object;
  readonly sourceRead: ReturnType<typeof consumeFullGraphCoarseSweepSourceReadCapabilityV1>["port"];
  readonly amountSeed: FullGraphCoarseSweepAmountSeedV1;
}

const states = new WeakMap<object, FullGraphCoarseSweepInvocationStateV1>();
const consumedSessions = new WeakSet<object>();

function sameSource(
  left: Readonly<{ readonly chainId: string; readonly number: string; readonly hash: string; readonly stateRoot: string }>,
  right: Readonly<{ readonly chainId: string; readonly number: string; readonly hash: string; readonly stateRoot: string }>,
): boolean {
  return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

/** Application owner issues exactly one invocation from one authentic
 * CanonicalSource session and one Reth-owned audit read capability. */
export function issueFullGraphCoarseSweepInvocationCapabilityV1(input: {
  readonly session: ProducerSessionV1<StartupProducerLeaseV1>;
  readonly sourceRead: FullGraphCoarseSweepSourceReadCapabilityV1;
  readonly amountSeed: FullGraphCoarseSweepAmountSeedV1;
}): FullGraphCoarseSweepInvocationCapabilityV1 {
  assertExactKeys(input, ["session", "sourceRead", "amountSeed"], "fullGraphSweepInvocation");
  if (input.session === null || typeof input.session !== "object") throw new TypeError("full-Graph sweep producer session is required");
  if (consumedSessions.has(input.session.currentSourceCapability)) throw new TypeError("full-Graph sweep invocation already issued for current-source session");
  const current = readIssuedProducerCurrentSourceSessionCapabilityV1(input.session.currentSourceCapability);
  assertExactKeys(input.amountSeed, ["amountIn", "recipient"], "fullGraphSweepInvocation.amountSeed");
  if (!/^[1-9][0-9]*$/.test(input.amountSeed.amountIn)) throw new TypeError("full-Graph sweep amountIn must be positive decimal");
  assertNonEmptyString(input.amountSeed.recipient, "fullGraphSweepInvocation.amountSeed.recipient");
  const sourceRead = readFullGraphCoarseSweepSourceReadCapabilityV1(input.sourceRead);
  if (current.sessionId !== input.session.sessionId
    || current.generationId !== input.session.generationId
    || input.session.lease !== input.session.graphView
    || input.session.lease.binding.generationId !== current.generation.generationId
    || input.session.lease.binding.readyRecordHash !== current.generation.readyRecordHash
    || input.session.lease.binding.graphRoot !== current.generation.graphRoot
    || input.session.lease.binding.releaseProvenanceHash !== current.generation.releaseProvenanceHash
    || sourceRead.binding.sessionId !== current.sessionId
    || !sameSource(sourceRead.binding.source, current.source)) {
    throw new TypeError("full-Graph sweep invocation session/source/Graph binding mismatch");
  }
  assertHash(current.generation.graphRoot, "fullGraphSweepInvocation.graphRoot");
  const consumedSourceRead = consumeFullGraphCoarseSweepSourceReadCapabilityV1(input.sourceRead);
  if (consumedSourceRead !== sourceRead) throw new TypeError("full-Graph sweep source read capability changed during issuance");
  const capability = Object.freeze(Object.create(null)) as FullGraphCoarseSweepInvocationCapabilityV1;
  // The session and source port are process-local capabilities with private
  // mutable lifecycle state. Freeze only this holder, never their internals.
  states.set(capability, Object.freeze({
    session: input.session,
    canonicalSourceAuthority: current.canonicalSourceAuthority,
    sourceRead: consumedSourceRead.port,
    amountSeed: Object.freeze({ ...input.amountSeed }),
  }));
  consumedSessions.add(input.session.currentSourceCapability);
  return capability;
}

export function consumeFullGraphCoarseSweepInvocationCapabilityV1(
  capability: FullGraphCoarseSweepInvocationCapabilityV1,
): FullGraphCoarseSweepInvocationStateV1 {
  if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) {
    throw new TypeError("full-Graph sweep invocation capability is invalid");
  }
  const state = states.get(capability);
  if (state === undefined) throw new TypeError("full-Graph sweep invocation capability was not issued or was consumed");
  states.delete(capability);
  return state;
}
