import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, RequestRequirements } from "../../adapter-request-program.js";
import { runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { buildSubscriptCalldata } from "../../../../shared/executor/botvm-program-entry.js";
import { returnedResult } from "../../protocols/standard-family/common.js";
import { PAIR, SWAP_EVENT, address, amount } from "./codec.js";
import { swapProgram } from "./runtime.js";
import type { Descriptor, Route } from "./types.js";

export const SIMULATION_ID = "ammalgam-pair-swap";

export const simulationRequirements: RequestRequirements = {
  transports: ["effect-delta-simulation"],
  caller: "executor",
  effects: ["return-data", "revert-data", "token-delta", "native-delta", "total-supply-delta", "logs"],
};

export interface SimulationInput {
  readonly descriptor: Descriptor;
  readonly route: Route;
  readonly amountIn: bigint;
  readonly executor: string;
  readonly recipient: string;
}

/**
 * Same-state execution of the family runtime program through the strict
 * `effect-delta-simulation` transport. This is the exact quote: the program
 * derives the output from pair state and the pair's own K check accepts it.
 */
export function simulationRequest(input: SimulationInput): AdapterRequest {
  const caller = { kind: "executor" as const } as const;
  const program = swapProgram({
    pair: input.descriptor.pair,
    tokenX: input.descriptor.tokenX,
    tokenY: input.descriptor.tokenY,
    xForY: input.route.xForY,
    executor: input.executor,
    recipient: input.recipient,
    minimum: 1n,
  });
  return {
    id: SIMULATION_ID,
    kind: "effect-delta-simulation",
    call: {
      caller,
      executionMode: "executor-program",
      to: ethers.getAddress(input.executor),
      data: buildSubscriptCalldata(runtimeProgramScript(program.bytes(), input.amountIn)),
    },
    overrideIntent: {
      caller,
      tokenBalances: [{ token: input.route.tokenIn, amount: input.amountIn }],
    },
    observeTokenBalances: [input.route.tokenIn, input.route.tokenOut].flatMap(token => [
      { token, account: caller },
      { token, account: input.descriptor.pair },
    ]),
    observeTotalSupplies: [input.route.tokenIn, input.route.tokenOut],
    observe: simulationRequirements.effects!,
  };
}

export interface DecodedSwapLog {
  readonly sender: string;
  readonly to: string;
  readonly amountXIn: bigint;
  readonly amountYIn: bigint;
  readonly amountXOut: bigint;
  readonly amountYOut: bigint;
}

export function decodeSwapLog(log: { readonly topics: readonly string[]; readonly data: string }): DecodedSwapLog | null {
  try {
    if (log.topics.length !== 3 || log.topics[0].toLowerCase() !== SWAP_EVENT.topicHash.toLowerCase()) return null;
    const value = PAIR.decodeEventLog("Swap", log.data, [...log.topics]);
    const encoded = PAIR.encodeEventLog(SWAP_EVENT, value);
    if (encoded.data.toLowerCase() !== log.data.toLowerCase() ||
        encoded.topics.length !== log.topics.length ||
        encoded.topics.some((topic, index) => topic.toLowerCase() !== log.topics[index].toLowerCase())) return null;
    return {
      sender: address(value[0] as string),
      amountXIn: value[1] as bigint,
      amountYIn: value[2] as bigint,
      amountXOut: value[3] as bigint,
      amountYOut: value[4] as bigint,
      to: address(value[5] as string),
    };
  } catch {
    return null;
  }
}

/**
 * Read the exact output the pair delivered in the isolated simulation and
 * require the complete debit/credit, supply, native and Swap-event shape.
 * Nothing here trusts a quote: the pair's own state change is the evidence.
 */
export function decodeReceipt(
  results: readonly AdapterRequestResult[],
  descriptor: Descriptor,
  route: Route,
  amountIn: bigint,
  executor: string,
): bigint {
  const result = returnedResult(results, SIMULATION_ID);
  const effects = result.effects;
  if (!effects || effects.tokenDeltas?.length !== 4 || effects.totalSupplyDeltas?.length !== 2 ||
      effects.nativeDeltas?.length !== 1) {
    throw new Error("ammalgam missing effect scope");
  }
  const actor = address(executor);
  const pair = address(descriptor.pair);
  const delta = (token: string, account: string) => {
    const found = effects.tokenDeltas!.filter(item => address(item.token) === token && address(item.account) === account);
    if (found.length !== 1) throw new Error("ammalgam duplicate or missing balance delta");
    return found[0].delta;
  };
  const tokenIn = address(route.tokenIn), tokenOut = address(route.tokenOut);
  const output = amount(delta(tokenOut, actor));
  if (delta(tokenIn, actor) !== -amountIn || delta(tokenIn, pair) !== amountIn ||
      delta(tokenOut, pair) !== -output) {
    throw new Error("ammalgam debit/credit mismatch");
  }
  for (const token of [tokenIn, tokenOut]) {
    const supplies = effects.totalSupplyDeltas!.filter(item => address(item.token) === token && item.delta === 0n);
    if (supplies.length !== 1) throw new Error("ammalgam total supply movement");
  }
  if (address(effects.nativeDeltas![0].account) !== actor || effects.nativeDeltas![0].delta !== 0n) {
    throw new Error("ammalgam native balance movement");
  }
  const logs = (effects.logs ?? [])
    .filter(log => address(log.address) === pair)
    .map(log => decodeSwapLog(log))
    .filter((log): log is DecodedSwapLog => log !== null);
  if (logs.length !== 1) throw new Error("ammalgam swap event missing");
  const swap = logs[0];
  if (swap.sender !== actor || swap.to !== actor || swap.amountXOut + swap.amountYOut !== output) {
    throw new Error("ammalgam swap event mismatch");
  }
  if (route.xForY) {
    if (swap.amountXIn !== amountIn || swap.amountYIn !== 0n || swap.amountYOut !== output) {
      throw new Error("ammalgam swap event amounts");
    }
  } else if (swap.amountYIn !== amountIn || swap.amountXIn !== 0n || swap.amountXOut !== output) {
    throw new Error("ammalgam swap event amounts");
  }
  return output;
}
