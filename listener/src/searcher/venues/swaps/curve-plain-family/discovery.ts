import { ethers } from "ethers";
import type { DiscoverySemantics, UnifiedObservation } from "../../adapter-family-plugin.js";
import { createTxEvidenceNomination } from "../../tx-evidence-nomination.js";
import { EXECUTION, MODES, executionFunction, lower, selector, validIndex } from "./codec.js";
import { reverseBindCurvePlain } from "./nomination.js";
import type { CurvePlainCandidate } from "./types.js";

export const SWAP_TOPIC = ethers.id("TokenExchange(address,int128,uint256,int128,uint256)") as `0x${string}`;
export const UINT_SWAP_TOPIC = ethers.id("TokenExchange(address,uint256,uint256,uint256,uint256)") as `0x${string}`;
export const UINT_NG_SWAP_TOPIC = ethers.id("TokenExchange(address,uint256,uint256,uint256,uint256,uint256,uint256)") as `0x${string}`;
export const LOG_ID = "curve-plain-int128-swap";
export const UINT_LOG_ID = "curve-plain-uint256-swap";
export const UINT_NG_LOG_ID = "curve-plain-uint256-ng-swap";
export const SURFACE_ID = "curve-plain-direct-coins";
export const SURFACE = "curve-plain-direct-coins-v1";
const callPatterns = MODES.map(mode => ({
  id: `curve-plain-${mode}`, selector: selector(mode),
  signature: EXECUTION[mode].getFunction(executionFunction(mode))!.format("sighash"),
  candidateAddress: { from: "call-target" as const },
}));
const logPatterns = [{ id: LOG_ID, topic: SWAP_TOPIC,
  signature: "TokenExchange(address,int128,uint256,int128,uint256)" },
  { id: UINT_LOG_ID, topic: UINT_SWAP_TOPIC, signature: "TokenExchange(address,uint256,uint256,uint256,uint256)" },
  { id: UINT_NG_LOG_ID, topic: UINT_NG_SWAP_TOPIC, signature: "TokenExchange(address,uint256,uint256,uint256,uint256,uint256,uint256)" }];
const txNomination = createTxEvidenceNomination({
  opaqueLabels: ["curve", "curve-nr", "curve-plain"], logPatterns, callPatterns,
});
export function decodeSwapLog(observation: UnifiedObservation |
  Omit<Extract<UnifiedObservation, { kind: "log" }>, "source">) {
  if (observation.kind !== "log" || !logPatterns.some(pattern => pattern.topic.toLowerCase() === observation.topics[0]?.toLowerCase()) ||
      observation.topics.length !== 2) return null;
  const topic = observation.topics[0].toLowerCase();
  const ng = topic === UINT_NG_SWAP_TOPIC.toLowerCase();
  if (!ethers.isHexString(observation.data, ng ? 192 : 128)) return null;
  try {
    const indexType = topic === SWAP_TOPIC.toLowerCase() ? "int128" : "uint256";
    // Tricrypto NG appends fee and packed_price_scale. Neither changes which
    // four fields identify the swap or proves support for an execution selector.
    const types = [indexType, "uint256", indexType, "uint256", ...(ng ? ["uint256", "uint256"] : [])];
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const decoded = coder.decode(types, observation.data);
    // int128 decoding may discard dirty upper bits; require canonical encoding
    // and bound the original bigint indices before converting them to numbers.
    if (coder.encode(types, decoded).toLowerCase() !== observation.data.toLowerCase()) return null;
    const [i, amountIn, j, amountOut] = decoded;
    if (i < 0n || i >= 8n || j < 0n || j >= 8n || i === j || amountIn <= 0n || amountOut <= 0n) return null;
    return { pool: ethers.getAddress(observation.address), i: Number(i), j: Number(j),
      amountIn: BigInt(amountIn), amountOut: BigInt(amountOut) };
  } catch { return null; }
}
export const curvePlainDiscovery = {
  evidenceChannel: "nominate" as const,
  txSeedNominations: true,
  sources: ["landed-log", "observed-call"],
  callPatterns,
  logPatterns,
  addressSurfaces: [{ id: SURFACE_ID, kind: "interface" as const, fingerprint: SURFACE }],
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      let pool: string, i: number | null = null, j: number | null = null;
      if (observation.kind === "address-surface" && matchedPatternId === SURFACE_ID) {
        if (!observation.interfaceFingerprints?.includes(SURFACE)) return null;
        pool = observation.address;
      } else if (observation.kind === "log" && logPatterns.some(pattern => pattern.id === matchedPatternId && pattern.topic.toLowerCase() === observation.topics[0]?.toLowerCase())) {
        const decoded = decodeSwapLog(observation);
        if (decoded === null) return null;
        ({ pool, i, j } = decoded);
      } else if (observation.kind === "call") {
        const mode = MODES.find(value => matchedPatternId === `curve-plain-${value}` &&
          observation.data.slice(0, 10).toLowerCase() === selector(value));
        if (mode === undefined) return null;
        const fn = executionFunction(mode);
        const decoded = EXECUTION[mode].decodeFunctionData(fn, observation.data);
        if (EXECUTION[mode].encodeFunctionData(fn, decoded).toLowerCase() !== observation.data.toLowerCase()) return null;
        i = Number(decoded[0]); j = Number(decoded[1]); pool = observation.target;
        if (!validIndex(i) || !validIndex(j) || i === j || BigInt(decoded[2]) <= 0n) return null;
      } else return null;
      return Object.freeze({ candidateKind: "curve-plain-pool" as const,
        pool: ethers.getAddress(pool), hintedI: i, hintedJ: j });
    } catch { return null; }
  },
  candidateKey: candidate => lower(candidate.pool),
  instanceNominationKey: candidate => {
    const value = candidate as Readonly<Record<string, unknown>>;
    return lower(String(value.pool ?? value.address ?? ""));
  },
  nominate: { nominate(input) {
    // A cached transaction is only a nomination. Do not relabel future or
    // unanchored receipt evidence as an observation at this source.
    return txNomination.nominate({ ...input, provider: { ...input.provider,
      async getTransactionReceipt(hash) {
        const receipt = await input.provider.getTransactionReceipt(hash);
        const height = receipt?.blockNumber;
        return typeof height === "number" && Number.isSafeInteger(height) &&
          height >= 0 && height <= input.source.number ? receipt : null;
      },
    } });
  } },
  reverseBinding: { kind: "implementation" as const, reverseBinding: reverseBindCurvePlain },
} satisfies DiscoverySemantics<CurvePlainCandidate>;
