import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { normalizeEffectTransportDeclaration } from "../../../packages/execution-program/src/index.ts";
import { ASTRA_ACTION_OWNER_ID } from "./manifest.ts";
import { compileAstraExecution } from "./execution.ts";
import type { AstraActionV1, AstraExactV1, AstraRouteV1 } from "./types.ts";

export const ASTRA_ACTION_OWNER = Object.freeze({ ownerId: ASTRA_ACTION_OWNER_ID, actionKind: "protocol-convert", implementationHash: hashDomain("aloha/astra-multitoken/action/v1", ASTRA_ACTION_OWNER_ID) });

export function buildAstraAction(input: { readonly route: AstraRouteV1; readonly exact: AstraExactV1; readonly amountIn: bigint; readonly minAmountOut: bigint }): AstraActionV1 {
  const execution = compileAstraExecution(input);
  const effectTransport = normalizeEffectTransportDeclaration({
    caller: execution.program.caller,
    preCalls: execution.program.preCalls,
    observeTokenBalances: execution.program.observeTokenBalances,
    observeLogs: execution.program.observeLogs,
  });
  return Object.freeze({ target: input.route.target, tokenIn: input.route.tokenIn, tokenOut: input.route.tokenOut, amountIn: input.amountIn, minAmountOut: input.minAmountOut, calldata: execution.program.data, actionHash: hashDomain("aloha/astra-multitoken/action-envelope/v1", { ownerId: ASTRA_ACTION_OWNER_ID, executionHash: execution.programHash, target: input.route.target }), effectTransport });
}
