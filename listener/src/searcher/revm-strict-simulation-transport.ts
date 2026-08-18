import type {
  OverlayPreCall,
  OverlayTokenDeal,
  RevmSimClient,
} from "./revm-sim-client.js";
import type {
  StrictSimulationTransport,
} from "./strict-central-adapter-runtime.js";
import { canonicalAddress } from "./venues/protocols/standard-family/common.js";
import type {
  AdapterRequest,
  CallerRef,
} from "./venues/adapter-request-program.js";

/**
 * Revm-backed strict simulation transport. Runs the request as one isolated
 * effect-delta simulation against the canonical source block: resolves every
 * caller (including verified actors), funds token balances, executes
 * pre-calls then the main call, and returns return-data plus observed
 * token/totalSupply deltas and logs. Unsupported caller/override bindings
 * fail closed instead of fabricating results.
 */
export function createRevmStrictSimulationTransport(input: {
  readonly client: Pick<RevmSimClient, "strictSimulate">;
  readonly executor: string;
  readonly observedSender?: string;
  readonly verifiedActors?: Readonly<Record<string, string>>;
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
    }): Promise<{
      readonly data: string;
      readonly effects?: {
        readonly tokenDeltas?: readonly {
          readonly token: string;
          readonly account: string;
          readonly delta: bigint;
        }[];
        readonly totalSupplyDeltas?: readonly {
          readonly token: string;
          readonly delta: bigint;
        }[];
        readonly logs?: readonly {
          readonly address: string;
          readonly topics: readonly string[];
          readonly data: string;
        }[];
      };
    }> {
      const { request } = simInput;
      if (request.overrideIntent.nativeBalanceWei !== undefined) {
        throw new Error(
          "revm strict transport cannot fund native balances",
        );
      }
      const from = resolveCaller(
        request.call.caller,
        input.executor,
        input.observedSender,
        input.verifiedActors,
      );
      const observeTokenBalances = request.observeTokenBalances ?? [];
      const materializedObservations = observeTokenBalances.map(
        (entry) => Object.freeze({
          token: canonicalAddress(entry.token),
          account: typeof entry.account === "string"
            ? canonicalAddress(entry.account)
            : resolveCaller(
                entry.account,
                input.executor,
                input.observedSender,
                input.verifiedActors,
              ),
        }),
      );
      // Exact scope wins; otherwise observe the resolved caller for every
      // funded/override token (legacy default).
      const observeTokens = materializedObservations.length > 0
        ? unique(materializedObservations.map((observation) => observation.token))
        : unique([
            ...(request.overrideIntent.tokenBalances ?? []).map(
              (deal) => deal.token,
            ),
            request.call.to,
          ]);
      const observeAccounts = materializedObservations.length > 0
        ? unique(materializedObservations.map((observation) => observation.account))
        : [from];
      const callerMode = request.call.executionMode ?? "top-level";
      const preCalls: OverlayPreCall[] = (request.preCalls ?? []).map(
        (call) => Object.freeze({
          from: resolveCaller(
            call.caller,
            input.executor,
            input.observedSender,
            input.verifiedActors,
          ),
          to: call.to,
          calldata: call.data,
        }),
      );
      const tokenDeals: OverlayTokenDeal[] = (
        request.overrideIntent.tokenBalances ?? []
      ).map((deal) => Object.freeze({
        token: deal.token,
        to: from,
        amount: deal.amount.toString(),
      }));

      const observeTotalSupply = request.observe.includes("total-supply-delta")
        ? [request.call.to]
        : [];
      const observeLogs = request.observe.includes("logs");
      const resp = await input.client.strictSimulate({
        blockNumber: simInput.source.number,
        from,
        to: request.call.to,
        data: request.call.data,
        preCalls,
        tokenDeals,
        observeTokens,
        observeTotalSupply,
        observeLogs,
        observeAccounts,
        callerMode,
      });
      if (resp.success !== true) {
        // A simulated revert is chain-proven negative evidence (the pool's
        // execution at the fixed cutoff reverts deterministically), never a
        // resource failure. Mark it as a CALL_EXCEPTION with the revert
        // payload so the central runtime classifies it reverted-as-declared.
        const reason = resp.revertReason ?? "0x";
        const error = new Error(
          `revm strict simulation reverted: ${reason}`,
        );
        (error as { code?: string }).code = "CALL_EXCEPTION";
        (error as { data?: string }).data = reason;
        throw error;
      }
      const effects = resp.strict;
      if (effects === undefined) {
        throw new Error("revm strict simulation returned no effects");
      }
      return Object.freeze({
        data: resp.output ?? "0x",
        effects: Object.freeze({
          tokenDeltas: Object.freeze(effects.tokenDeltas.map((delta) =>
            Object.freeze({
              token: delta.token,
              account: delta.account,
              delta: BigInt(delta.delta),
            })
          )),
          totalSupplyDeltas: Object.freeze(
            effects.totalSupplyDeltas.map((delta) => Object.freeze({
              token: delta.token,
              delta: BigInt(delta.delta),
            })),
          ),
          logs: Object.freeze(effects.logs.map((log) => Object.freeze({
            address: log.address,
            topics: Object.freeze([...log.topics]),
            data: log.data,
          }))),
        }),
      });
    },
  });
}

function resolveCaller(
  caller: CallerRef,
  executor: string,
  observedSender: string | undefined,
  verifiedActors: Readonly<Record<string, string>> | undefined,
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
  if (caller.kind === "verified-actor") {
    const actor = verifiedActors?.[caller.evidenceId];
    if (actor === undefined) {
      throw new Error(
        `verified actor evidence ${caller.evidenceId} is absent from ` +
          "the strict transport",
      );
    }
    return actor;
  }
  throw new Error("revm strict transport cannot resolve unknown caller");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.toLowerCase()))];
}
