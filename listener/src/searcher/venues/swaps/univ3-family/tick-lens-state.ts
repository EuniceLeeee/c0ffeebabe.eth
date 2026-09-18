import { bindRequestResultRound, collectRequestProgramResults, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { UNIV3_POOL_INTERFACE, UNIV3_TICK_LENS, UNIV3_TICK_LENS_INTERFACE } from "../univ3-abi.js";
import { MAX_TICK, MIN_TICK, type V3PoolState } from "../../../solver/v3-math.js";
import { requireSuccessfulResult } from "./codec.js";
import type { UniV3Descriptor, UniV3Route, UniV3ExactEvidence } from "./types.js";
import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";

type Program = ExactRequestProgram<UniV3Descriptor, UniV3Route, UniV3ExactEvidence>;
const WORD_PREFIX = "local-tick-word:";
function atSource(results: readonly AdapterRequestResult[], id: string, source: CanonicalSource) {
  const result = requireSuccessfulResult(results, id);
  if (result.source.number !== source.number || result.source.hash.toLowerCase() !== source.hash.toLowerCase() ||
      result.source.generation !== source.generation) throw new Error("univ3 exact quote came from a foreign source");
  return result;
}
function words(tick: number, spacing: number) {
  if (!Number.isSafeInteger(tick) || tick < MIN_TICK || tick > MAX_TICK ||
      !Number.isSafeInteger(spacing) || spacing <= 0) throw new Error("univ3 invalid tick/spacing");
  const center = Math.floor(tick / spacing) >> 8;
  return Array.from({ length: 49 }, (_, i) => center - 24 + i);
}

// Original factory-agnostic state reads retained for variants without a proven
// aggregate reader. No automatic transport-failure fallback or alternate math.
export function tickLensStateRequests(descriptor: UniV3Descriptor) {
  return ["slot0", "liquidity"].map(name => Object.freeze({
    id: `local-${name}`, kind: "eth-call" as const, to: descriptor.pool,
    data: UNIV3_POOL_INTERFACE.encodeFunctionData(name), completion: "return-data" as const,
  }));
}
export const tickLensDependentProgram: NonNullable<Program["buildDependentProgram"]> = input => {
  if (input.completedRound !== 0 || input.programInput.amountIn <= 0n) return null;
  const { descriptor, source } = input.programInput;
  const results = collectRequestProgramResults(input.initialResults, input.priorEvidence);
  const slot = UNIV3_POOL_INTERFACE.decodeFunctionResult("slot0", atSource(results, "local-slot0", source).data);
  atSource(results, "local-liquidity", source);
  if (BigInt(slot[0]) === 0n) return null;
  const requests = words(Number(slot[1]), descriptor.tickSpacing).map(word => Object.freeze({
    id: WORD_PREFIX + word, kind: "eth-call" as const, to: UNIV3_TICK_LENS,
    data: UNIV3_TICK_LENS_INTERFACE.encodeFunctionData("getPopulatedTicksInWord", [descriptor.pool, word]),
    completion: "return-data" as const,
  }));
  return bindRequestResultRound({ transports: ["eth-call"] }, requests);
};
export function readTickLensState(input: Parameters<Program["decode"]>[0]): V3PoolState {
  const { descriptor, source } = input.programInput;
  const results = collectRequestProgramResults(input.initialResults, input.dependentEvidence);
  const slot = UNIV3_POOL_INTERFACE.decodeFunctionResult("slot0", atSource(results, "local-slot0", source).data);
  const sqrtPriceX96 = BigInt(slot[0]), tick = Number(slot[1]), tickSpacing = descriptor.tickSpacing;
  const liquidity = BigInt(UNIV3_POOL_INTERFACE.decodeFunctionResult("liquidity", atSource(results, "local-liquidity", source).data)[0]);
  const tickBitmap = new Map<number, bigint>(), ticks = new Map<number, bigint>();
  const state = { sqrtPriceX96, tick, liquidity, fee: descriptor.fee, tickSpacing, tickBitmap, ticks };
  if (sqrtPriceX96 === 0n) return state;
  const requested = words(tick, tickSpacing), wordResults = results.filter(r => r.id.startsWith(WORD_PREFIX));
  if (wordResults.length !== requested.length || new Set(wordResults.map(r => r.id)).size !== requested.length) {
    throw new Error("univ3 incomplete or duplicate tick window");
  }
  for (const word of requested) {
    const result = atSource(wordResults, WORD_PREFIX + word, source);
    const populated = UNIV3_TICK_LENS_INTERFACE.decodeFunctionResult("getPopulatedTicksInWord", result.data)[0];
    if (UNIV3_TICK_LENS_INTERFACE.encodeFunctionResult("getPopulatedTicksInWord", [populated]).toLowerCase() !== result.data.toLowerCase()) {
      throw new Error("univ3 non-canonical tick word");
    }
    tickBitmap.set(word, 0n);
    for (const entry of populated) {
      const tk = Number(entry.tick), compressed = Math.floor(tk / tickSpacing);
      const net = BigInt(entry.liquidityNet), gross = BigInt(entry.liquidityGross);
      if (tk < MIN_TICK || tk > MAX_TICK || tk % tickSpacing !== 0 || (compressed >> 8) !== word ||
          ticks.has(tk) || gross <= 0n || net > gross || -net > gross) throw new Error("univ3 invalid initialized tick");
      ticks.set(tk, net);
      tickBitmap.set(word, (tickBitmap.get(word) ?? 0n) | (1n << BigInt(((compressed % 256) + 256) % 256)));
    }
  }
  return state;
}
