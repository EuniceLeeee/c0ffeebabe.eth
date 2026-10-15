import { ethers } from "ethers";
import { runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { buildSubscriptCalldata } from "../../../../shared/executor/botvm-program-entry.js";
import { executionNativeSides } from "../../../execution-asset-boundary.js";
import type { ExactQuoteInput, ExactRequestProgram } from "../../adapter-family-plugin.js";
import { returnedResult, assertSource } from "../../protocols/standard-family/common.js";
import { poolKeyFingerprint, sameAddress } from "../univ4-family/codec.js";
import { univ4FeeHookExecution } from "./execution.js";
import type { FeeHookDescriptor, FeeHookRoute, FeeHookExactEvidence } from "./types.js";
type Input = ExactQuoteInput<FeeHookDescriptor, FeeHookRoute>;
const ID = "tiered-executor-receipt";
const effects = ["return-data", "revert-data", "token-delta", "native-delta"] as const;
export function tieredActorContext(i: Pick<Input, "executor" | "transactionOrigin">) {
  if (!i.transactionOrigin) throw new Error("tiered exact requires production transaction origin");
  const executor = ethers.getAddress(i.executor).toLowerCase(), transactionOrigin = ethers.getAddress(i.transactionOrigin).toLowerCase();
  if (executor === ethers.ZeroAddress || transactionOrigin === executor || BigInt(transactionOrigin) <= 2n)
    throw new Error("tiered exact invalid executor/origin or quote-only origin");
  return { executor, transactionOrigin };
}
function validate(i: Input) {
  tieredActorContext(i);
  if (i.descriptor.hookModel === "sat1" || i.prefix?.length || i.amountIn <= 0n || i.amountIn >= (1n << 127n))
    throw new Error("tiered executor quote requires positive int128 input and no unsupported prefix");
}
/** The hook hashes the real swap sender, amount and historical environment.
 * Standard Quoter executes another sender and can hit a quote-only fee bypass.
 * Reuse the Family's actual guarded program through central source-pinned REVM;
 * neither a local fee approximation nor quoted output funds this request. */
export const tieredExecutorProgram: ExactRequestProgram<FeeHookDescriptor, FeeHookRoute, FeeHookExactEvidence> = {
  requirements: i => { validate(i); return { transports: ["effect-delta-simulation"], caller: "executor", effects }; },
  buildRequests(i) {
    validate(i); const actor = tieredActorContext(i).executor, caller = { kind: "executor" as const };
    const leg = univ4FeeHookExecution.buildRuntimeLeg({ ...i });
    if (!leg) throw new Error("tiered runtime program unavailable");
    const native = executionNativeSides(i.route);
    return [{ id: ID, kind: "effect-delta-simulation", call: { caller, executionMode: "executor-program", to: actor,
      data: buildSubscriptCalldata(runtimeProgramScript(ethers.getBytes(leg.program), i.amountIn)) },
      overrideIntent: { caller, tokenBalances: [{ token: i.route.tokenIn, amount: i.amountIn }] },
      observeTokenBalances: [i.route.tokenIn, i.route.tokenOut].map(token => ({ token, account: caller })),
      observe: effects,
      ...(native ? { executionAssetBoundary: { tokenIn: i.route.tokenIn, tokenOut: i.route.tokenOut,
        executionAssets: i.route.executionAssets!, amountIn: i.amountIn, minimum: 1n } } : {}),
    }];
  },
  decode({ programInput: i, initialResults, dependentEvidence }) {
    validate(i); if (dependentEvidence.length || initialResults.length !== 1) throw new Error("tiered unexpected quote rounds");
    const result = returnedResult(initialResults, ID); assertSource(result.source, i.source);
    if (result.data !== "0x") throw new Error("tiered executor returned unexpected data");
    const actor = tieredActorContext(i), deltas = result.effects?.tokenDeltas;
    if (deltas?.length !== 2) throw new Error("tiered exact requires two actual token deltas");
    const delta = (token: string) => {
      const rows = deltas.filter(r => sameAddress(r.token, token) && sameAddress(r.account, actor.executor));
      if (rows.length !== 1) throw new Error("tiered missing/ambiguous actor token delta");
      return rows[0]!.delta;
    };
    if (delta(i.route.tokenIn) !== -i.amountIn) throw new Error("tiered actual input debit differs from requested input");
    const amountOut = delta(i.route.tokenOut);
    if (amountOut <= 0n || amountOut > ethers.MaxUint256) throw new Error("tiered output is not actual positive uint256 receipt");
    const native = result.effects?.nativeDeltas;
    if (native?.length !== 1 || !sameAddress(native[0]!.account, actor.executor) || native[0]!.delta !== 0n)
      throw new Error("tiered native inventory changed");
    return { amountOut, evidence: { kind: "tiered-executor-receipt", source: i.source,
      poolId: i.descriptor.poolId, poolKeyFingerprint: poolKeyFingerprint(i.descriptor.poolKey),
      quoter: i.descriptor.managerBinding.quoter, tokenIn: i.route.tokenIn, tokenOut: i.route.tokenOut,
      amountIn: i.amountIn, amountOut, gasEstimate: 0n, hookData: "0x", ...actor } };
  },
};
