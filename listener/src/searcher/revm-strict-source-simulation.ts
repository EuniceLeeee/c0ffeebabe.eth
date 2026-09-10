import { RevmFatalError, type RevmFatalReason, type RevmRequestControl } from "./revm-sim-client.js";
import { RevmStrictSourceOwner, type RevmStrictSourceIdentity,
  type RevmStrictSourceLease } from "./revm-strict-source-owner.js";
import { createRevmStrictSimulationTransport } from "./revm-strict-simulation-transport.js";

/** One existing work slot's immutable source context. This is not a scheduler:
 * the caller creates it once per admitted pass/attempt and joins closeAndDrain
 * at that work slot's settle boundary. Quotes never create or replace it.
 */
export function createRevmStrictSourceSimulation(input: {
  readonly identity: RevmStrictSourceIdentity;
  readonly control?: RevmRequestControl;
  readonly executionGasLimit: number;
  readonly createClient: ConstructorParameters<typeof RevmStrictSourceOwner>[0]["createClient"];
  readonly onFatal: (reason: RevmFatalReason) => void;
}) {
  const identity = Object.freeze({ ...input.identity,
    source: Object.freeze({ ...input.identity.source }) });
  const control = input.control === undefined ? undefined : Object.freeze({ ...input.control });
  const onFatal = input.onFatal;
  let fatal: RevmFatalError | undefined;
  let closed = false;
  let lease: Promise<RevmStrictSourceLease> | undefined;
  const reportFatal = (reason: RevmFatalReason): void => {
    if (fatal) return;
    fatal = new RevmFatalError(reason);
    // The owner fences every queued/in-flight operation before user callbacks.
    // Observing its drain here must not detach the caller's mandatory join.
    void owner.shutdown(fatal).catch(() => {});
    onFatal(reason);
  };
  const owner = new RevmStrictSourceOwner({ createClient: input.createClient, onFatal: reportFatal });
  const transport = createRevmStrictSimulationTransport({
    rpcUrl: identity.rpcUrl,
    executionGasLimit: input.executionGasLimit,
    onFatal: reportFatal,
    leaseFor(source) {
      if (fatal) throw fatal;
      if (closed) throw new Error("strict source work slot closed");
      if (source.number !== identity.source.number || source.generation !== identity.source.generation ||
          source.hash.toLowerCase() !== identity.source.hash.toLowerCase()) {
        throw new RevmFatalError({ kind: "source-fault" });
      }
      // Keep rejected admission too: no same-generation retry, even if no
      // physical daemon request was dispatched before cancellation.
      return lease ??= owner.acquire(identity, control);
    },
  });
  return Object.freeze({
    transport,
    closeAndDrain(reason = new Error("strict source work slot settled")): Promise<void> {
      closed = true;
      return owner.shutdown(reason);
    },
  });
}
