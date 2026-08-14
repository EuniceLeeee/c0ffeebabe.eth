import { ethers } from "ethers";
import type {
  DiscoverySemantics,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  CURVE_METAREGISTRY,
  CURVE_UNDERLYING_I128_SELECTOR,
  CURVE_UNDERLYING_I128_SWAP_TOPIC,
  CURVE_UNDERLYING_UINT_SELECTOR,
  CURVE_UNDERLYING_UINT_SWAP_TOPIC,
  decodeUnderlyingIndicesFromCall,
  lowerAddress,
} from "./codec.js";
import type { CurveUnderlyingCandidate } from "./types.js";
import { createTxEvidenceNomination } from "../../tx-evidence-nomination.js";

export const CURVE_UNDERLYING_I128_LOG_PATTERN_ID =
  "curve-underlying-i128-log";
export const CURVE_UNDERLYING_UINT_LOG_PATTERN_ID =
  "curve-underlying-uint-log";
export const CURVE_UNDERLYING_I128_CALL_PATTERN_ID =
  "curve-underlying-i128-call";
export const CURVE_UNDERLYING_UINT_CALL_PATTERN_ID =
  "curve-underlying-uint-call";

export const curveUnderlyingDiscovery = {
  evidenceChannel: "nominate" as const,
  sources: ["landed-log", "observed-call"],
  callPatterns: [{
    id: CURVE_UNDERLYING_I128_CALL_PATTERN_ID,
    selector: CURVE_UNDERLYING_I128_SELECTOR,
    signature: "exchange_underlying(int128,int128,uint256,uint256)",
    candidateAddress: { from: "call-target" },
  }, {
    id: CURVE_UNDERLYING_UINT_CALL_PATTERN_ID,
    selector: CURVE_UNDERLYING_UINT_SELECTOR,
    signature: "exchange_underlying(uint256,uint256,uint256,uint256)",
    candidateAddress: { from: "call-target" },
  }],
  logPatterns: [{
    id: CURVE_UNDERLYING_I128_LOG_PATTERN_ID,
    topic: CURVE_UNDERLYING_I128_SWAP_TOPIC as `0x${string}`,
    signature:
      "TokenExchangeUnderlying(address,int128,uint256,int128,uint256)",
  }, {
    id: CURVE_UNDERLYING_UINT_LOG_PATTERN_ID,
    topic: CURVE_UNDERLYING_UINT_SWAP_TOPIC as `0x${string}`,
    signature:
      "TokenExchangeUnderlying(address,uint256,uint256,uint256,uint256)",
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      return decodeCandidate(observation, matchedPatternId);
    } catch {
      return null;
    }
  },
  candidateKey: (candidate) => lowerAddress(candidate.pool),
  nominate: createTxEvidenceNomination({
    opaqueLabels: Object.freeze(["curve-underlying"]),
    logPatterns: Object.freeze([{
      id: "curve-underlying-i128-swap-log",
      topic: CURVE_UNDERLYING_I128_SWAP_TOPIC as `0x${string}`,
      signature: "TokenExchange(address,int128,uint256,int128,uint256)",
    }]),
    callPatterns: Object.freeze([{
      id: "curve-underlying-i128-swap-call",
      selector: CURVE_UNDERLYING_I128_SELECTOR as `0x${string}`,
      signature: "exchange(int128,int128,uint256,uint256)",
      candidateAddress: Object.freeze({ from: "call-target" as const }),
    }]),
  }),
  factoryEnumeration: { enumerate: enumerateCurveMetaregistry },
} satisfies DiscoverySemantics<CurveUnderlyingCandidate>;

const CURVE_ENUM_INTERFACE = new ethers.Interface([
  "function pool_count() view returns (uint256)",
  "function pool_list(uint256) view returns (address)",
]);

/**
 * Full Curve Metaregistry enumeration (pool_count + pool_list). The
 * metaregistry is the infrastructure singleton the family already uses
 * for reverse identity; enumeration is provenance, admission stays on
 * reverse verification.
 */
async function enumerateCurveMetaregistry(input: {
  readonly provider: {
    call(req: { readonly to: string; readonly data: string }, blockTag?: number): Promise<string>;
  };
}): Promise<readonly { readonly address: string; readonly adapter: string }[]> {
  const rawLen = await input.provider.call({
    to: CURVE_METAREGISTRY,
    data: CURVE_ENUM_INTERFACE.encodeFunctionData("pool_count"),
  });
  const count = Number(CURVE_ENUM_INTERFACE.decodeFunctionResult(
    "pool_count",
    rawLen,
  )[0]);
  if (!Number.isSafeInteger(count) || count <= 0 || count > 100_000) {
    throw new Error(`curve metaregistry enumeration rejected invalid count ${count}`);
  }
  const out: { address: string; adapter: string }[] = [];
  const CHUNK = 64;
  for (let start = 0; start < count; start += CHUNK) {
    const size = Math.min(CHUNK, count - start);
    const raw = await Promise.all(
      Array.from({ length: size }, (_, i) => input.provider.call({
        to: CURVE_METAREGISTRY,
        data: CURVE_ENUM_INTERFACE.encodeFunctionData(
          "pool_list",
          [BigInt(start + i)],
        ),
      })),
    );
    for (const result of raw) {
      out.push(Object.freeze({
        address: ethers.getAddress("0x" + result.slice(26)).toLowerCase(),
        adapter: "curve-underlying",
      }));
    }
  }
  return out;
}

function decodeCandidate(
  observation: UnifiedObservation,
  matchedPatternId: string,
): CurveUnderlyingCandidate | null {
  if (
    observation.kind === "call" &&
    (matchedPatternId === CURVE_UNDERLYING_I128_CALL_PATTERN_ID ||
      matchedPatternId === CURVE_UNDERLYING_UINT_CALL_PATTERN_ID)
  ) {
    const indices = decodeUnderlyingIndicesFromCall(observation.data);
    if (indices === null) return null;
    return Object.freeze({
      candidateKind: "curve-underlying-pool" as const,
      pool: canonicalAddress(observation.target),
      sourceKind: "exchange-underlying-call" as const,
      hintedI: indices.i,
      hintedJ: indices.j,
    });
  }
  if (
    observation.kind !== "log" ||
    (matchedPatternId !== CURVE_UNDERLYING_I128_LOG_PATTERN_ID &&
      matchedPatternId !== CURVE_UNDERLYING_UINT_LOG_PATTERN_ID)
  ) {
    return null;
  }
  const [soldId, , boughtId] = ethers.AbiCoder.defaultAbiCoder().decode(
    ["uint256", "uint256", "uint256", "uint256"],
    observation.data,
  );
  const i = Number(soldId);
  const j = Number(boughtId);
  if (!validIndex(i) || !validIndex(j) || i === j) return null;
  return Object.freeze({
    candidateKind: "curve-underlying-pool" as const,
    pool: canonicalAddress(observation.address),
    sourceKind: "underlying-swap-log" as const,
    hintedI: i,
    hintedJ: j,
  });
}

function validIndex(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value < 8;
}
