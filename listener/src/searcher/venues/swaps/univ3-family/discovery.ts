import type {
  DiscoverySemantics,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import { ethers } from "ethers";
import { nominateUniv3 } from "./nomination.js";
import {
  PANCAKE_V3_SWAP_TOPIC,
  UNIV3_BURN_TOPIC,
  UNIV3_FACTORY_INTERFACE,
  UNIV3_INITIALIZE_TOPIC,
  UNIV3_MINT_TOPIC,
  UNIV3_POOL_CREATED_TOPIC,
  UNIV3_SWAP_SELECTOR,
  UNIV3_SWAP_TOPIC,
} from "../univ3-abi.js";
import {
  canonicalAddress,
  lowerAddress,
  PANCAKE_V3_SWAP_LOG_PATTERN_ID,
  UNIV3_BURN_LOG_PATTERN_ID,
  UNIV3_INITIALIZE_LOG_PATTERN_ID,
  UNIV3_MINT_LOG_PATTERN_ID,
  UNIV3_POOL_CREATED_PATTERN_ID,
  UNIV3_SWAP_CALL_PATTERN_ID,
  UNIV3_SWAP_LOG_PATTERN_ID,
} from "./codec.js";
import type { UniV3Candidate } from "./types.js";

export const univ3Discovery = {
  evidenceChannel: "nominate" as const,
  sources: ["factory-log", "landed-log", "observed-call"],
  callPatterns: [{
    id: UNIV3_SWAP_CALL_PATTERN_ID,
    selector: UNIV3_SWAP_SELECTOR,
    signature: "swap(address,bool,int256,uint160,bytes)",
    candidateAddress: { from: "call-target" },
  }],
  logPatterns: [{
    id: UNIV3_POOL_CREATED_PATTERN_ID,
    topic: UNIV3_POOL_CREATED_TOPIC as `0x${string}`,
    signature: "PoolCreated(address,address,uint24,int24,address)",
  }, {
    id: UNIV3_SWAP_LOG_PATTERN_ID,
    topic: UNIV3_SWAP_TOPIC as `0x${string}`,
    signature: "Swap(address,address,int256,int256,uint160,uint128,int24)",
  }, {
    id: PANCAKE_V3_SWAP_LOG_PATTERN_ID,
    topic: PANCAKE_V3_SWAP_TOPIC as `0x${string}`,
    signature:
      "Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)",
  }, {
    id: UNIV3_INITIALIZE_LOG_PATTERN_ID,
    topic: UNIV3_INITIALIZE_TOPIC as `0x${string}`,
    signature: "Initialize(uint160,int24)",
  }, {
    id: UNIV3_MINT_LOG_PATTERN_ID,
    topic: UNIV3_MINT_TOPIC as `0x${string}`,
    signature: "Mint(address,address,int24,int24,uint128,uint256,uint256)",
  }, {
    id: UNIV3_BURN_LOG_PATTERN_ID,
    topic: UNIV3_BURN_TOPIC as `0x${string}`,
    signature: "Burn(address,int24,int24,uint128,uint256,uint256)",
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      return decodeCandidate(observation, matchedPatternId);
    } catch {
      return null;
    }
  },
  candidateKey: (candidate) => lowerAddress(candidate.pool),
  nominate: { nominate: nominateUniv3 },
  factoryEnumeration: { enumerate: enumerateUniv3Factory },
} satisfies DiscoverySemantics<UniV3Candidate>;

const UNIV3_FACTORY_ADDRESS = ethers.getAddress(
  "0x1F98431c8aD98523631AE4a59f267346ea31F984",
);

/**
 * Factory log enumeration: UniV3 has no traversal API, so pools are
 * recovered from the factory PoolCreated log (node retained window).
 */
async function enumerateUniv3Factory(input: {
  readonly provider: {
    getLogs(filter: {
      readonly address?: string;
      readonly topics?: readonly (string | null)[];
      readonly fromBlock?: number;
      readonly toBlock?: number;
    }): Promise<readonly {
      readonly address: string;
      readonly topics: readonly string[];
      readonly data: string;
    }[]>;
  };
}): Promise<readonly { readonly address: string; readonly adapter: string }[]> {
  const logs = await input.provider.getLogs({
    address: UNIV3_FACTORY_ADDRESS,
    topics: [UNIV3_POOL_CREATED_TOPIC as `0x${string}`],
    fromBlock: 0,
  });
  const out: { address: string; adapter: string }[] = [];
  for (const log of logs) {
    const decoded = UNIV3_FACTORY_INTERFACE.decodeEventLog(
      "PoolCreated",
      log.data,
      log.topics,
    );
    out.push(Object.freeze({
      address: canonicalAddress(String(decoded.pool)).toLowerCase(),
      adapter: "univ3",
    }));
  }
  return out;
}

function decodeCandidate(
  observation: UnifiedObservation,
  matchedPatternId: string,
): UniV3Candidate | null {
  if (
    matchedPatternId === UNIV3_SWAP_CALL_PATTERN_ID &&
    observation.kind === "call"
  ) {
    return addressCandidate("pool-call", observation.target);
  }
  if (
    observation.kind === "log" &&
    matchedPatternId !== UNIV3_POOL_CREATED_PATTERN_ID &&
    new Set([
      UNIV3_SWAP_LOG_PATTERN_ID,
      PANCAKE_V3_SWAP_LOG_PATTERN_ID,
      UNIV3_INITIALIZE_LOG_PATTERN_ID,
      UNIV3_MINT_LOG_PATTERN_ID,
      UNIV3_BURN_LOG_PATTERN_ID,
    ]).has(matchedPatternId)
  ) {
    return addressCandidate("pool-swap-log", observation.address);
  }
  if (
    matchedPatternId !== UNIV3_POOL_CREATED_PATTERN_ID ||
    observation.kind !== "log"
  ) {
    return null;
  }
  const decoded = UNIV3_FACTORY_INTERFACE.decodeEventLog(
    "PoolCreated",
    observation.data,
    observation.topics,
  );
  const tickSpacing = Number(decoded.tickSpacing);
  if (!Number.isSafeInteger(tickSpacing) || tickSpacing <= 0) return null;
  return Object.freeze({
    candidateKind: "univ3-pool" as const,
    sourceKind: "pool-created" as const,
    pool: canonicalAddress(String(decoded.pool)),
    hintedFactory: canonicalAddress(observation.address),
    hintedToken0: canonicalAddress(String(decoded.token0)),
    hintedToken1: canonicalAddress(String(decoded.token1)),
    hintedFee: BigInt(decoded.fee),
    hintedTickSpacing: tickSpacing,
  });
}

function addressCandidate(
  sourceKind: Exclude<UniV3Candidate["sourceKind"], "pool-created">,
  pool: string,
): UniV3Candidate {
  return Object.freeze({
    candidateKind: "univ3-pool" as const,
    sourceKind,
    pool: canonicalAddress(pool),
    hintedFactory: null,
    hintedToken0: null,
    hintedToken1: null,
    hintedFee: null,
    hintedTickSpacing: null,
  });
}
