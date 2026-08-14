import { ethers } from "ethers";
import type {
  DiscoverySemantics,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import { nominateUniv2 } from "./nomination.js";
import {
  canonicalAddress,
  lowerAddress,
  UNIV2_FACTORY_INTERFACE,
  UNIV2_PAIR_CREATED_PATTERN_ID,
  UNIV2_PAIR_CREATED_TOPIC,
  UNIV2_SWAP_CALL_PATTERN_ID,
  UNIV2_SWAP_LOG_PATTERN_ID,
  UNIV2_SWAP_SELECTOR,
  UNIV2_SWAP_TOPIC,
  UNIV2_SYNC_LOG_PATTERN_ID,
  UNIV2_SYNC_TOPIC,
} from "./codec.js";
import type { UniV2Candidate } from "./types.js";

export const univ2Discovery = {
  evidenceChannel: "nominate" as const,
  sources: ["factory-log", "landed-log", "observed-call"],
  callPatterns: [{
    id: UNIV2_SWAP_CALL_PATTERN_ID,
    selector: UNIV2_SWAP_SELECTOR,
    signature: "swap(uint256,uint256,address,bytes)",
    candidateAddress: { from: "call-target" },
  }],
  logPatterns: [{
    id: UNIV2_PAIR_CREATED_PATTERN_ID,
    topic: UNIV2_PAIR_CREATED_TOPIC,
    signature: "PairCreated(address,address,address,uint256)",
  }, {
    id: UNIV2_SWAP_LOG_PATTERN_ID,
    topic: UNIV2_SWAP_TOPIC,
    signature: "Swap(address,uint256,uint256,uint256,uint256,address)",
  }, {
    id: UNIV2_SYNC_LOG_PATTERN_ID,
    topic: UNIV2_SYNC_TOPIC,
    signature: "Sync(uint112,uint112)",
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      return decodeCandidate(observation, matchedPatternId);
    } catch {
      return null;
    }
  },
  candidateKey: (candidate) => lowerAddress(candidate.pool),
  nominate: { nominate: nominateUniv2 },
  factoryEnumeration: { enumerate: enumerateUniv2Factory },
} satisfies DiscoverySemantics<UniV2Candidate>;

const UNIV2_FACTORY_ADDRESS = ethers.getAddress(
  "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
);
const UNIV2_FACTORY_ENUM_INTERFACE = new ethers.Interface([
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
]);

/**
 * Full factory enumeration (allPairsLength + allPairs) so the universe
 * covers every pool the factory owns, not only the activity window.
 * Reverse identity stays the admission gate; enumeration is provenance.
 */
async function enumerateUniv2Factory(input: {
  readonly provider: {
    call(req: { readonly to: string; readonly data: string }, blockTag?: number): Promise<string>;
  };
}): Promise<readonly { readonly address: string; readonly adapter: string }[]> {
  const rawLen = await input.provider.call({
    to: UNIV2_FACTORY_ADDRESS,
    data: UNIV2_FACTORY_ENUM_INTERFACE.encodeFunctionData("allPairsLength"),
  });
  const count = Number(UNIV2_FACTORY_ENUM_INTERFACE.decodeFunctionResult(
    "allPairsLength",
    rawLen,
  )[0]);
  if (!Number.isSafeInteger(count) || count <= 0 || count > 10_000_000) {
    throw new Error(`univ2 factory enumeration rejected invalid pool count ${count}`);
  }
  const out: { address: string; adapter: string }[] = [];
  const CHUNK = 128;
  for (let start = 0; start < count; start += CHUNK) {
    const size = Math.min(CHUNK, count - start);
    const raw = await Promise.all(
      Array.from({ length: size }, (_, i) => input.provider.call({
        to: UNIV2_FACTORY_ADDRESS,
        data: UNIV2_FACTORY_ENUM_INTERFACE.encodeFunctionData(
          "allPairs",
          [BigInt(start + i)],
        ),
      })),
    );
    for (const result of raw) {
      out.push(Object.freeze({
        address: ethers.getAddress("0x" + result.slice(26)).toLowerCase(),
        adapter: "univ2",
      }));
    }
  }
  return out;
}

function decodeCandidate(
  observation: UnifiedObservation,
  matchedPatternId: string,
): UniV2Candidate | null {
  if (
    matchedPatternId === UNIV2_SWAP_CALL_PATTERN_ID &&
    observation.kind === "call"
  ) {
    return candidate("pair-call", observation.target);
  }
  if (
    matchedPatternId === UNIV2_SWAP_LOG_PATTERN_ID &&
    observation.kind === "log"
  ) {
    return candidate("pair-swap-log", observation.address);
  }
  if (
    matchedPatternId === UNIV2_SYNC_LOG_PATTERN_ID &&
    observation.kind === "log"
  ) {
    return candidate("pair-sync-log", observation.address);
  }
  if (
    matchedPatternId !== UNIV2_PAIR_CREATED_PATTERN_ID ||
    observation.kind !== "log"
  ) {
    return null;
  }
  const decoded = UNIV2_FACTORY_INTERFACE.decodeEventLog(
    "PairCreated",
    observation.data,
    observation.topics,
  );
  return Object.freeze({
    candidateKind: "univ2-pair" as const,
    sourceKind: "pair-created" as const,
    pool: canonicalAddress(String(decoded.pair)),
    hintedFactory: canonicalAddress(observation.address),
    hintedToken0: canonicalAddress(String(decoded.token0)),
    hintedToken1: canonicalAddress(String(decoded.token1)),
  });
}

function candidate(
  sourceKind: Exclude<UniV2Candidate["sourceKind"], "pair-created">,
  pool: string,
): UniV2Candidate {
  return Object.freeze({
    candidateKind: "univ2-pair" as const,
    sourceKind,
    pool: canonicalAddress(pool),
    hintedFactory: null,
    hintedToken0: null,
    hintedToken1: null,
  });
}
