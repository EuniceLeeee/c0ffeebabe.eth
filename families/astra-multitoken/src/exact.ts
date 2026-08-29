import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
import { validateAstraExchange, type TokenDelta } from "../kernel/effects.ts";
import { ASTRA_CHANGE_TOPIC, ASTRA_EFFECT_OBLIGATIONS } from "./manifest.ts";
import { assertAstraRoute } from "./routes.ts";
import { quoteAstra } from "./pricing.ts";
import { validateAstraEffectSimulationProgram, type AstraEffectSimulationProgramV1 } from "./execution.ts";
import type { Address, AstraExactV1, AstraIdentityV1, AstraRouteV1, SourceAnchorV1 } from "./types.ts";

export interface AstraEffectObservationV1 {
  readonly caller: Address;
  /** The complete Family-owned declaration must survive the transport seam. */
  readonly program: AstraEffectSimulationProgramV1;
  readonly tokenDeltas: readonly TokenDelta[];
  readonly logs: readonly { readonly address: string; readonly topic0: string }[];
}

export function evaluateAstraExact(input: { readonly identity: AstraIdentityV1; readonly route: AstraRouteV1; readonly source: SourceAnchorV1; readonly amountIn: bigint; readonly minAmountOut: bigint; readonly observation: AstraEffectObservationV1 }): AstraExactV1 {
  assertAstraRoute(input.route, { familyId: "astra-multitoken", instanceKey: input.identity.instanceKey, target: input.identity.target, identity: input.identity, runtimeRequirements: [] });
  validateAstraEffectSimulationProgram(input.observation.program, { route: input.route, amountIn: input.amountIn, minAmountOut: input.minAmountOut });
  if (input.observation.caller.toLowerCase() !== input.identity.actor.toLowerCase()) throw new TypeError("astra observed caller does not match candidate actor");
  const amountOut = validateAstraExchange({ tokenDeltas: input.observation.tokenDeltas, caller: input.observation.caller, target: input.identity.target, tokenIn: input.route.tokenIn, tokenOut: input.route.tokenOut, amountIn: input.amountIn, amountOut: input.identity.activeQuote });
  if (!input.observation.logs.some(log => log.address.toLowerCase() === input.identity.target.toLowerCase() && log.topic0.toLowerCase() === ASTRA_CHANGE_TOPIC.toLowerCase())) throw new Error("astra-change-log-obligation-missing");
  const quote = quoteAstra({ identity: input.identity, route: input.route, source: input.source, amountIn: input.amountIn, amountOut });
  return Object.freeze({ ...quote, effectHash: hashDomain("aloha/astra-multitoken/effects/v1", {
    caller: input.observation.caller,
    tokenDeltas: input.observation.tokenDeltas.map(delta => ({ token: delta.token, account: delta.account, delta: delta.delta.toString() })),
    logs: input.observation.logs,
  }), obligations: ASTRA_EFFECT_OBLIGATIONS });
}
