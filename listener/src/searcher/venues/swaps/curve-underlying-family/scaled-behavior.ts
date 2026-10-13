import type { AdapterRequest, AdapterRequestResult } from "../../adapter-request-program.js";
import { CURVE_BEHAVIOR_PROBE_AMOUNTS, CURVE_METAREGISTRY, CURVE_UNDERLYING_META_INTERFACE,
  CURVE_UNDERLYING_POOL_INTERFACE, assertSameSource, decodeGetDy, decodeUnderlyingBalances,
  requireSuccessfulResult } from "./codec.js";
import type { CurveUnderlyingIdentityEvidence, CurveUnderlyingVerifiedDirection } from "./types.js";

type Proof = Extract<CurveUnderlyingIdentityEvidence, { readonly phase: "behavior-proof" }>;
const BALANCES = "behavior-scale-underlying-balances";
const withoutScale = ({ scaleProbe: _scale, ...proof }: Proof): Proof => Object.freeze(proof);

/** Only the newly bound legacy plain implementation needs this additional path.
 * Zero from small probes describes amount granularity, not ABI capability.
 * Existing proven directions and all other identity variants keep their cost. */
export function scheduleScaledBehavior(proof: Proof, results: readonly AdapterRequestResult[]): Proof {
  if (!proof.legacyPlain || !proof.handlers.length || proof.registryBinding) return proof;
  const directions: { i: number; j: number }[] = [];
  for (let i = 0; i < proof.coins.length; i++) for (let j = 0; j < proof.coins.length; j++) {
    if (i === j || proof.verifiedDirections.some(d => d.i === i && d.j === j)) continue;
    if (CURVE_BEHAVIOR_PROBE_AMOUNTS.every((_, probe) => {
      const read = results.find(r => r.id === `behavior-get-dy:${i}:${j}:${probe}`);
      return read?.ok && read.completion === "returned" && decodeGetDy(read.data) === 0n;
    })) directions.push({ i, j });
  }
  return directions.length ? Object.freeze({ ...proof, scaleProbe: { directions } }) : proof;
}
export function scaledBehaviorRequests(proof: Proof): readonly AdapterRequest[] {
  const scale = proof.scaleProbe;
  if (!scale) return [];
  if (!scale.amounts) return [{ id: BALANCES, kind: "eth-call", to: CURVE_METAREGISTRY,
    data: CURVE_UNDERLYING_META_INTERFACE.encodeFunctionData("get_underlying_balances", [proof.pool]),
    completion: "return-or-revert-data" }];
  return scale.amounts.map(({ i, j, amountIn }, index) => ({
    id: `behavior-scaled-quote:${index}`, kind: "eth-call", to: proof.pool,
    data: CURVE_UNDERLYING_POOL_INTERFACE.encodeFunctionData("get_dy_underlying", [i, j, amountIn]),
    completion: "return-or-revert-data",
  }));
}
export function decodeScaledBehavior(proof: Proof, results: readonly AdapterRequestResult[]): Proof {
  const scale = proof.scaleProbe;
  if (!scale) throw new Error("curve-underlying missing scale probe");
  if (!scale.amounts) {
    const result = results.find(r => r.id === BALANCES);
    if (!result || !result.ok) throw new Error("curve-underlying unresolved scale balances");
    if (result.completion === "reverted-as-declared") return withoutScale(proof);
    const read = requireSuccessfulResult(results, BALANCES);
    const balances = decodeUnderlyingBalances(read.data);
    const amounts = scale.directions.flatMap(({ i, j }) => {
      const balance = balances[i];
      if (balance === undefined || balance < 0n) throw new Error("curve-underlying invalid scaled balance");
      const values = [1_000_000n, 100_000n, 10_000n, 1_000n, 100n].map(divisor => balance / divisor);
      return [...new Set(values)].filter(amountIn => amountIn > 0n &&
        !CURVE_BEHAVIOR_PROBE_AMOUNTS.includes(amountIn)).map(amountIn => ({ i, j, amountIn }));
    });
    if (!amounts.length) return withoutScale(proof);
    if (amounts.length > 60) throw new Error("curve-underlying scale probe budget exceeded");
    return Object.freeze({ ...proof, scaleProbe: { ...scale, amounts, source: read.source } });
  }
  if (!scale.source) throw new Error("curve-underlying scaled source missing");
  const verifiedDirections: CurveUnderlyingVerifiedDirection[] = [...proof.verifiedDirections];
  const reads: Extract<AdapterRequestResult, { readonly ok: true }>[] = [];
  for (const [index, { i, j, amountIn }] of scale.amounts.entries()) {
    const read = results.find(r => r.id === `behavior-scaled-quote:${index}`);
    if (!read || !read.ok) throw new Error("curve-underlying unresolved scaled quote");
    reads.push(read);
    if (read.source.number !== scale.source.number || read.source.generation !== scale.source.generation ||
      read.source.hash.toLowerCase() !== scale.source.hash.toLowerCase())
      throw new Error("curve-underlying scaled quote foreign source");
    if (read.completion === "reverted-as-declared") continue;
    const amountOut = decodeGetDy(read.data);
    if (amountOut > 0n && !verifiedDirections.some(d => d.i === i && d.j === j)) {
      verifiedDirections.push({ i, j, tokenIn: proof.coins[i], tokenOut: proof.coins[j],
        behaviorProbeAmountIn: amountIn, behaviorProbeAmountOut: amountOut });
    }
  }
  assertSameSource(reads);
  return Object.freeze({ ...withoutScale(proof), verifiedDirections: Object.freeze(verifiedDirections) });
}
