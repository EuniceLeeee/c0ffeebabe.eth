import { getAddress, keccak256, ZeroAddress } from "ethers";
import { snapshotCentralCallerAuthority, type AdapterWorkControl } from "./adapter-work-intent.js";
import { RevmStrictError, type ExecutorRuntimeCode } from "./revm-sim-client.js";
import type { StrictSimulationTransport } from "./strict-central-adapter-runtime.js";
import type { CanonicalSource } from "./venues/adapter-request-program.js";

interface SourceSimulation {
  readonly transport: StrictSimulationTransport;
  closeAndDrain(reason?: Error): Promise<void>;
}

/** Ready's historical identity probes may use a declared verified actor. Their
 * node frame needs its own source-owned executor capability; it must not change
 * the production executor or the authority used for actual route execution. */
export function createReadyProofSimulation(input: {
  readonly source: CanonicalSource;
  readonly executor: string;
  readonly transactionOrigin: string;
  readonly verifiedActors: Readonly<Record<string, string>>;
  readonly primary: SourceSimulation;
  readonly executorRuntimeCode?: ExecutorRuntimeCode;
  readonly readCode: (actor: string, source: CanonicalSource) => Promise<string>;
  readonly createProof: (actor: string, runtimeCode: ExecutorRuntimeCode, allowCodeOverride: boolean) => SourceSimulation;
  readonly assertOpen: () => void;
}): SourceSimulation {
  const source = Object.freeze({ ...input.source, hash: input.source.hash.toLowerCase() });
  const executor = getAddress(input.executor).toLowerCase(), origin = getAddress(input.transactionOrigin).toLowerCase();
  const actors = Object.freeze(Object.fromEntries(Object.entries(input.verifiedActors)
    .map(([key, value]) => [key, getAddress(value).toLowerCase()])));
  const code = input.executorRuntimeCode && Object.freeze({ ...input.executorRuntimeCode });
  if (code && (!/^0x(?:[0-9a-f]{2})+$/i.test(code.code) || keccak256(code.code) !== code.keccak256))
    throw new RevmStrictError("validation", "Ready proof executor code/hash mismatch");
  const contexts = new Set<SourceSimulation>([input.primary]);
  const pending = new Map<string, Promise<SourceSimulation>>();
  let closed = false, drain: Promise<void> | undefined;
  const assertOpen = (control?: AdapterWorkControl): void => {
    input.assertOpen();
    if (closed || control?.signal?.aborted) throw new RevmStrictError("execution", "Ready proof simulation closed or cancelled");
    if (control?.deadlineAtMs !== undefined && Date.now() >= control.deadlineAtMs)
      throw new RevmStrictError("execution", "Ready proof simulation deadline reached");
  };
  const transport: StrictSimulationTransport = Object.freeze({
    ...input.primary.transport,
    async forRequest(invocation: Parameters<StrictSimulationTransport["simulate"]>[0]) {
      assertOpen(invocation.control);
      if (invocation.source.number !== source.number || invocation.source.hash.toLowerCase() !== source.hash ||
          invocation.source.generation !== source.generation)
        throw new RevmStrictError("validation", "Ready proof simulation source mismatch");
      const authority = snapshotCentralCallerAuthority(invocation.callerAuthority);
      if (authority.executor?.toLowerCase() !== executor || authority.transactionOrigin?.toLowerCase() !== origin)
        throw new RevmStrictError("validation", "Ready proof simulation execution authority mismatch");
      const { caller, executionMode } = invocation.request.call;
      if (caller.kind !== "verified-actor" || executionMode !== "impersonated-call-frame") return input.primary.transport;
      const actor = Object.hasOwn(actors, caller.evidenceId) ? actors[caller.evidenceId] : undefined;
      if (!actor || authority.verifiedActors?.[caller.evidenceId]?.toLowerCase() !== actor || actor === ZeroAddress || actor === origin)
        throw new RevmStrictError("validation", "Ready proof actor is not bound by the source owner");
      if (actor === executor) return input.primary.transport;
      let selected = pending.get(actor);
      if (!selected) {
        selected = Promise.resolve().then(async () => {
          assertOpen();
          if (!code) throw new RevmStrictError("validation", "Ready proof actor requires trusted executor runtime code");
          const actorCode = await input.readCode(actor, source);
          assertOpen();
          if (typeof actorCode !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(actorCode))
            throw new RevmStrictError("validation", "Ready proof actor code observation is invalid");
          if (actorCode !== "0x" && actorCode.toLowerCase() !== code.code.toLowerCase())
            throw new RevmStrictError("validation", "Ready proof actor has different deployed code at source");
          return input.createProof(actor, code, actorCode === "0x");
        })
          .then(context => { contexts.add(context); return context; });
        pending.set(actor, selected);
      }
      const context = await selected;
      assertOpen(invocation.control);
      return context.transport;
    },
  });
  return Object.freeze({ transport,
    closeAndDrain(reason?: Error): Promise<void> {
      closed = true;
      return drain ??= (async () => {
        await Promise.allSettled(pending.values());
        const results = await Promise.allSettled([...contexts].map(context => context.closeAndDrain(reason)));
        const failure = results.find(result => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      })();
    },
  });
}
