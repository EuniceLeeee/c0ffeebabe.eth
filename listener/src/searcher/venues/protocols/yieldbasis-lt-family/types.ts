import type {
  CompiledInstanceDescriptor,
  FamilyCandidate,
  FamilyRouteDescriptor,
  VerifiedIdentity,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";

export interface YieldBasisLtCandidate extends FamilyCandidate {
  readonly candidateKind: "yieldbasis-lt";
  readonly lt: string;
}

/** Phase 1 — the LT's own surfaces at the pinned block. */
export interface YieldBasisLtBaseEvidence {
  readonly phase: "base";
  readonly lt: string;
  readonly ltCodeHash: string;
  readonly asset: string;
  readonly stablecoin: string;
  readonly cryptopool: string;
  readonly amm: string;
  readonly agg: string;
  readonly staker: string;
  readonly admin: string;
  readonly decimals: number;
  readonly totalSupply: bigint;
  readonly killed: boolean;
  readonly liquidityAdmin: bigint;
  readonly liquidityTotal: bigint;
  readonly liquidityIdealStaked: bigint;
  readonly liquidityStaked: bigint;
  readonly liveSupplyTokens: bigint;
  readonly baseValid: boolean;
  readonly evidenceRequestIds: readonly string[];
}

/**
 * Phase 2 — reverse binding. The LT names an AMM and a Curve cryptoswap pool;
 * both must independently name the same objects back
 * (`amm.LT_CONTRACT() == lt`, `amm.COLLATERAL() == cryptopool`,
 * `amm.STABLECOIN() == stablecoin`, `pool.coins(0) == stablecoin`,
 * `pool.coins(1) == asset`). There is no `factory()` on an LT, so this mutual
 * reference — not an address allowlist — is the admission source.
 */
export interface YieldBasisLtBindingEvidence
  extends Omit<YieldBasisLtBaseEvidence, "phase"> {
  readonly phase: "binding";
  readonly ammLtContract: string;
  readonly ammCollateral: string;
  readonly ammStablecoin: string;
  readonly poolCoin0: string;
  readonly poolCoin1: string;
  readonly poolDecimals: number;
  readonly poolShareSupply: bigint;
  readonly assetDecimals: number;
  readonly assetCoinIndex: number;
  readonly ammBindingsValid: boolean;
  readonly poolCoinBindingsValid: boolean;
  readonly bindingValid: boolean;
}

/**
 * Phase 3 — the redemption surface is live on the same state: the LT is not
 * killed (its own `is_killed()` proxies `amm().is_killed()`, which `withdraw`
 * asserts) and `preview_withdraw` returns a positive single-asset amount.
 */
export interface YieldBasisLtActiveEvidence
  extends Omit<YieldBasisLtBindingEvidence, "phase"> {
  readonly phase: "active";
  readonly ammKilled: boolean;
  readonly probeShares: bigint;
  readonly probeCryptoReceived: bigint;
  readonly redemptionPathLive: boolean;
  readonly behaviorProofHash: string;
}

export type YieldBasisLtIdentityEvidence =
  | YieldBasisLtBaseEvidence
  | YieldBasisLtBindingEvidence
  | YieldBasisLtActiveEvidence;

export interface YieldBasisLtIdentity extends VerifiedIdentity {
  readonly asset: string;
  readonly stablecoin: string;
  readonly cryptopool: string;
  readonly amm: string;
  readonly agg: string;
  readonly staker: string;
  readonly admin: string;
  readonly decimals: number;
  readonly assetDecimals: number;
  readonly assetCoinIndex: number;
  readonly redemptionPathVerified: boolean;
}

export interface YieldBasisLtDescriptor extends CompiledInstanceDescriptor {
  readonly lt: string;
  readonly share: string;
  readonly asset: string;
  readonly stablecoin: string;
  readonly cryptopool: string;
  readonly amm: string;
  readonly agg: string;
  readonly staker: string;
  readonly admin: string;
  readonly decimals: number;
  readonly assetDecimals: number;
  readonly assetCoinIndex: number;
  readonly redemptionPathVerified: boolean;
}

export interface YieldBasisLtRoute extends FamilyRouteDescriptor {
  readonly target: string;
  readonly direction: "withdraw";
  readonly adapterId: "yieldbasis-lt-withdraw";
}

export interface YieldBasisLtPricingDraft {
  readonly instanceKey: string;
  readonly lt: string;
  readonly asset: string;
  readonly stablecoin: string;
  readonly cryptopool: string;
  readonly amm: string;
  readonly routes: readonly YieldBasisLtRoute[];
}

export interface YieldBasisLtPricingDescriptor
  extends YieldBasisLtPricingDraft {
  readonly oneShare: bigint;
}

export interface YieldBasisLtState {
  readonly source: CanonicalSource;
  readonly killed: boolean;
  readonly liveSupplyTokens: bigint;
  readonly liquidityTotal: bigint;
  readonly cryptoReceived: bigint;
}

export interface YieldBasisLtExactEvidence {
  readonly kind: "yieldbasis-lt-withdraw-preview";
  readonly source: CanonicalSource;
  readonly lt: string;
  readonly asset: string;
  readonly direction: "withdraw";
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  /** LT's live supply_tokens at the quoted state (`updated_balances()`). */
  readonly liveSupplyTokens: bigint;
  /** LT's own `liquidity().total` (value units) at the quoted state. */
  readonly liquidityTotal: bigint;
  /** Cryptopool balance of the crypto leg: hard instant-withdrawal ceiling. */
  readonly poolAssetBalance: bigint;
  readonly assetCoinIndex: number;
  readonly bindingFingerprint: string;
}
