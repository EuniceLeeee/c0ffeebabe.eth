import type {
  RevmSimClient,
} from "./revm-sim-client.js";
import type {
  StrictSimulationTransport,
} from "./strict-central-adapter-runtime.js";
import type {
  AdapterRequest,
  CallerRef,
} from "./venues/adapter-request-program.js";

/**
 * Revm-backed strict simulation transport. Quote-driven: resolves the
 * caller reference to an address, executes pre-calls sequentially, then
 * quotes the main call. Effect observation and funded-caller state
 * overrides are not expressible in the quote request, so requests that
 * need them fail closed with resource-limited instead of fabricating
 * results.
 */
export function createRevmStrictSimulationTransport(input: {
  readonly client: Pick<RevmSimClient, "quote">;
  readonly executor: string;
  readonly observedSender?: string;
}): StrictSimulationTransport {
  return Object.freeze({
    async simulate(simInput: {
      readonly request: Extract<
        AdapterRequest,
        {
          readonly kind:
            | "state-override-simulation"
            | "effect-delta-simulation";
        }
      >;
      readonly source: { readonly number: number };
    }): Promise<{ readonly data: string }> {
      const { request } = simInput;
      if (request.observe.length > 0) {
        throw new Error(
          "revm strict transport cannot observe effects via quote",
        );
      }
      if (
        request.overrideIntent.nativeBalanceWei !== undefined ||
        (request.overrideIntent.tokenBalances?.length ?? 0) > 0
      ) {
        throw new Error(
          "revm strict transport cannot fund callers via quote",
        );
      }
      const from = resolveCaller(
        request.call.caller,
        input.executor,
        input.observedSender,
      );
      for (const preCall of request.preCalls ?? []) {
        const preFrom = resolveCaller(
          preCall.caller,
          input.executor,
          input.observedSender,
        );
        const preResp = await input.client.quote({
          from: preFrom,
          to: preCall.to,
          data: preCall.data,
        });
        if (!preResp.ok || !preResp.success) {
          throw new Error(
            preResp.revertReason ?? preResp.error ?? "revm pre-call failed",
          );
        }
      }
      const resp = await input.client.quote({
        from,
        to: request.call.to,
        data: request.call.data,
      });
      if (!resp.ok || !resp.success) {
        throw new Error(
          resp.revertReason ?? resp.error ?? "revm simulation failed",
        );
      }
      return Object.freeze({ data: resp.output ?? "0x" });
    },
  });
}

function resolveCaller(
  caller: CallerRef,
  executor: string,
  observedSender: string | undefined,
): string {
  if (caller.kind === "executor") return executor;
  if (caller.kind === "none") return `0x${"0".repeat(40)}`;
  if (caller.kind === "observed-sender") {
    if (observedSender === undefined) {
      throw new Error(
        "revm strict transport has no observed sender binding",
      );
    }
    return observedSender;
  }
  throw new Error(
    "revm strict transport cannot resolve verified-actor caller",
  );
}
