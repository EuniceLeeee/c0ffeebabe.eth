const HASH_32 = /^0x[a-f0-9]{64}$/;
const CALLDATA_HASH = /^[a-f0-9]{64}$/;
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

export type BackrunEvDecision =
  | "allow"
  | "below_ev_gate"
  | "unpriceable_profit_token"
  | "missing_gas_estimate"
  | "missing_fee_state"
  | "disabled";

/**
 * Production EV evidence emitted by the trusted backrun hunt.
 *
 * Oracle-round fields are nullable only for WETH, whose wei value is native.
 * Every other admitted profit token must carry the pinned Chainlink mark and
 * its round provenance so a replay cannot silently revive a static USD price.
 */
export interface BackrunEvEvidence {
  decision: BackrunEvDecision;
  profitToken: string;
  gasUsed: string;
  calldataHash: string;
  netEvWei: string;
  expectedProfitEth: string;
  gasCostEth: string;
  bidEth: string;
  minNetEth: string;
  decisionParentBlock: number;
  targetBlock: number;
  decisionParentHash: string | null;
  maxBaseFeePerGas: string;
  ethUsd: number | null;
  ethUsdRoundId?: string | null;
  ethUsdUpdatedAt?: string | null;
}

function parseUnsigned(value: string): bigint | null {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function optionalPositiveInteger(value: string | null | undefined): boolean {
  if (value === undefined || value === null) return true;
  const parsed = parseUnsigned(value);
  return parsed !== null && parsed > 0n;
}

/**
 * A replay is production-positive only when its decision is tied to the exact
 * canonical parent/target fee state and clears the configured EV threshold
 * strictly. Equality is a rejection boundary in production.
 */
export function isStrictPositiveBackrunEv(
  evidence: BackrunEvEvidence | null,
): evidence is BackrunEvEvidence {
  const profitToken =
    typeof evidence?.profitToken === "string" ? evidence.profitToken.toLowerCase() : "";
  const isWeth = profitToken === WETH;
  const hasPinnedUsdProvenance = evidence !== null
    && evidence.ethUsd !== null
    && Number.isFinite(evidence.ethUsd)
    && evidence.ethUsd > 0
    && evidence.ethUsdRoundId !== undefined
    && evidence.ethUsdRoundId !== null
    && optionalPositiveInteger(evidence.ethUsdRoundId)
    && evidence.ethUsdUpdatedAt !== undefined
    && evidence.ethUsdUpdatedAt !== null
    && optionalPositiveInteger(evidence.ethUsdUpdatedAt);
  if (
    evidence === null ||
    evidence.decision !== "allow" ||
    !Number.isSafeInteger(evidence.decisionParentBlock) ||
    evidence.decisionParentBlock < 0 ||
    !Number.isSafeInteger(evidence.targetBlock) ||
    evidence.targetBlock !== evidence.decisionParentBlock + 1 ||
    evidence.decisionParentHash === null ||
    !HASH_32.test(evidence.decisionParentHash.toLowerCase()) ||
    !CALLDATA_HASH.test(evidence.calldataHash.toLowerCase()) ||
    (
      evidence.ethUsd !== null &&
      (!Number.isFinite(evidence.ethUsd) || evidence.ethUsd <= 0)
    ) ||
    (!isWeth && !hasPinnedUsdProvenance) ||
    !optionalPositiveInteger(evidence.ethUsdRoundId) ||
    !optionalPositiveInteger(evidence.ethUsdUpdatedAt)
  ) {
    return false;
  }

  const gasUsed = parseUnsigned(evidence.gasUsed);
  const netEvWei = parseUnsigned(evidence.netEvWei);
  const expectedProfitEth = parseUnsigned(evidence.expectedProfitEth);
  const gasCostEth = parseUnsigned(evidence.gasCostEth);
  const bidEth = parseUnsigned(evidence.bidEth);
  const minNetEth = parseUnsigned(evidence.minNetEth);
  const maxBaseFeePerGas = parseUnsigned(evidence.maxBaseFeePerGas);
  if (
    gasUsed === null ||
    gasUsed <= 0n ||
    netEvWei === null ||
    expectedProfitEth === null ||
    expectedProfitEth <= 0n ||
    gasCostEth === null ||
    bidEth === null ||
    minNetEth === null ||
    maxBaseFeePerGas === null ||
    maxBaseFeePerGas <= 0n
  ) {
    return false;
  }

  return gasCostEth === gasUsed * maxBaseFeePerGas
    && bidEth <= expectedProfitEth
    && netEvWei === expectedProfitEth - gasCostEth - bidEth
    && netEvWei > minNetEth;
}
