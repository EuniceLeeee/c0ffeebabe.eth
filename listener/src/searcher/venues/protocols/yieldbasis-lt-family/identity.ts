import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import { RequiredAdapterRequestError } from
  "../../adapter-request-failure.js";
import type { AdapterRequestResult } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  assertSameSource,
  assertSource,
  callRequest,
  canonicalAddress,
  codeRequest,
  decodeAddress,
  decodeUint,
  lowerAddress,
  returnedResult,
  sameAddress,
} from "../standard-family/common.js";
import {
  CRYPTOPOOL_INTERFACE,
  ERC20_INTERFACE,
  LEVAMM_INTERFACE,
  LT_INTERFACE,
  LT_PROBE_SHARES,
} from "./abi.js";
import { candidateLt, isZeroAddress, lower } from "./codec.js";
import { balancedDepositDebt, decodeDepositReceipt, depositBalanceRequests,
  depositSimulation, depositProgramSimulation, decodeDepositProgramReceipt, DEPOSIT_REQUIREMENTS, DEPOSIT_DEBT_POLICY } from "./deposit.js";
import {
  YIELDBASIS_FAMILY_ID,
  YIELDBASIS_LINEAGE_ID,
} from "./manifest.js";
import type {
  YieldBasisLtActiveEvidence,
  YieldBasisLtDepositEvidence,
  YieldBasisLtProgramEvidence,
  YieldBasisLtBaseEvidence,
  YieldBasisLtBindingEvidence,
  YieldBasisLtCandidate,
  YieldBasisLtIdentity,
  YieldBasisLtIdentityEvidence,
} from "./types.js";

const BASE_IDS = [
  "lt-asset-token",
  "lt-stablecoin",
  "lt-cryptopool",
  "lt-amm",
  "lt-agg",
  "lt-staker",
  "lt-admin",
  "lt-decimals",
  "lt-total-supply",
  "lt-liquidity",
  "lt-updated-balances",
  "lt-is-killed",
] as const;
const BINDING_IDS = [
  "binding-amm-lt",
  "binding-amm-collateral",
  "binding-amm-stablecoin",
  "binding-pool-coin-0",
  "binding-pool-coin-1",
  "binding-pool-decimals",
  "binding-pool-share-supply",
  "binding-asset-decimals",
] as const;
/**
 * The active round always carries a required successful read (`is_killed`, which
 * the LT answers by proxying `amm().is_killed()`), so the round can never be
 * empty; the redemption probe beside it is what proves the withdraw surface is
 * live, and a dead surface still surfaces as a chain-proven rejection.
 */
const ACTIVE_IDS = [
  "active-is-killed",
  "active-amm-is-killed",
  "active-preview-withdraw",
] as const;

/**
 * Yield Basis LT identity — reverse-proven mutual reference, never an address
 * allowlist. A Yield Basis LT has no `factory()`, so this family proves a real,
 * reverse-checkable relation instead:
 *
 *   1. `ASSET_TOKEN()` / `STABLECOIN()` / `CRYPTOPOOL()` / `amm()` / `agg()` /
 *      `staker()` / `admin()` / `decimals()` / `totalSupply()` / `liquidity()` /
 *      `updated_balances()` / `is_killed()` are read at the pinned block
 *      together with the runtime code hash;
 *   2. the LevAMM the LT itself names must name the SAME LT back
 *      (`amm().LT_CONTRACT() == lt`), and the pool/stablecoin it names must
 *      match the LT's own immutables (`amm().COLLATERAL() == CRYPTOPOOL()`,
 *      `amm().STABLECOIN() == STABLECOIN()`);
 *   3. the Curve cryptoswap pool the LT names must list exactly
 *      `[STABLECOIN(), ASSET_TOKEN()]` as its coins, with 18-decimal LP shares
 *      and a positive pool share supply — which also yields the chain-derived
 *      crypto coin index the quote uses for its capacity ceiling;
 *   4. the redemption surface must be live on that same state: not killed and
 *      `preview_withdraw(1e18)` returns a positive single-asset amount.
 *
 * What this proves, plainly: the subject contract is the LT that a real LevAMM
 * was built for, holding a real position in the Curve pool that itself contains
 * this LT's own asset and stablecoin — i.e. the redemption the family routes is
 * the one this contract's `withdraw` executes. It does NOT prove deployment
 * lineage (no factory exists to ask) and it does not enumerate a fixed
 * allowlist: any LT whose own getters survive this reverse check is admitted,
 * and the pinned-block reads are never used to claim a creation event.
 */
export const yieldBasisLtIdentity: IdentitySemantics<
  YieldBasisLtCandidate,
  YieldBasisLtIdentity
> = {
  identityKey: (identity) => lower(identity.subject),
  variants: [{
    id: "levamm-bound-single-asset-withdraw",
    kind: "standalone-contract" as const,
    lineageId: YIELDBASIS_LINEAGE_ID,
    applies: (candidate) => candidate.candidateKind === "yieldbasis-lt",
    requirements({ evidence }) {
      if (evidence === undefined) {
        return { transports: ["get-code" as const, "eth-call" as const] };
      }
      const proof = evidence as YieldBasisLtIdentityEvidence;
      if (proof.phase === "base") {
        return proof.baseValid
          ? { transports: ["eth-call" as const] }
          : { transports: [] as const };
      }
      if (proof.phase === "binding") {
        return proof.bindingValid
          ? proof.depositAssets > 0n
            ? { ...DEPOSIT_REQUIREMENTS, transports: ["eth-call" as const, "effect-delta-simulation" as const] }
            : { transports: ["eth-call" as const] }
          : { transports: [] as const };
      }
      if (proof.phase === "deposit" && proof.depositPathLive) return DEPOSIT_REQUIREMENTS;
      return { transports: [] as const };
    },
    buildRequests({ candidate, evidence }) {
      const lt = candidateLt(candidate);
      if (evidence === undefined) {
        return Object.freeze([
          codeRequest("lt-code", lt),
          ...baseRequests(lt),
        ]);
      }
      const proof = evidence as YieldBasisLtIdentityEvidence;
      if (proof.phase === "base") {
        if (!proof.baseValid) return Object.freeze([]);
        return Object.freeze(bindingRequests(proof));
      }
      if (proof.phase === "binding") {
        if (!proof.bindingValid) return Object.freeze([]);
        return Object.freeze([
          callRequest(
            "active-is-killed",
            proof.lt,
            LT_INTERFACE.encodeFunctionData("is_killed"),
          ),
          callRequest(
            "active-amm-is-killed",
            proof.amm,
            LEVAMM_INTERFACE.encodeFunctionData("is_killed"),
          ),
          callRequest(
            "active-preview-withdraw",
            proof.lt,
            LT_INTERFACE.encodeFunctionData("preview_withdraw", [
              LT_PROBE_SHARES,
            ]),
          ),
          ...(proof.depositAssets > 0n ? [depositSimulation("active-deposit", proof, proof.depositAssets, proof.depositDebt)] : []),
        ]);
      }
      if (proof.phase === "deposit" && proof.depositPathLive) {
        if (!proof.depositExecutor) throw new Error("Yield Basis deposit actor proof missing");
        return [depositProgramSimulation("active-deposit-program", proof, proof.depositExecutor, proof.depositAssets)];
      }
      return Object.freeze([]);
    },
    decode({ step, results }) {
      for (const result of results) {
        // RPC/deadline/resource failures are unresolved, never killed/inactive.
        if (!result.ok) throw new RequiredAdapterRequestError(result);
        if (step.evidence) assertSource(result.source, (step.evidence as YieldBasisLtIdentityEvidence).source);
      }
      const successful = results.filter(
        (result): result is Extract<AdapterRequestResult, { readonly ok: true }> =>
          result.ok,
      );
      // A probe round may legitimately fail entirely (that is the dead
      // redemption surface); only compare sources when something succeeded.
      if (successful.length > 0) assertSameSource(successful);
      const lt = candidateLt(step.candidate);
      if (step.evidence === undefined) return decodeBase(lt, results);
      const prior = step.evidence as YieldBasisLtIdentityEvidence;
      if (prior.phase === "base") return decodeBinding(prior, results);
      if (prior.phase === "binding") {
        const active = decodeActive(prior, results);
        if (prior.depositAssets === 0n) return active;
        const result = results.find(r => r.id === "active-deposit");
        if (!result || !result.ok) throw new Error("Yield Basis deposit behavior evidence missing");
        const depositShares = result.completion === "returned"
          ? decodeDepositReceipt(results, "active-deposit", prior, prior.source, undefined, prior.depositAssets) : 0n;
        // This account is sealed by the central symbolic-caller transport,
        // never taken from candidate calldata or a per-instance list.
        const depositExecutor = depositShares > 0n
          ? result.effects!.tokenDeltas!.find(row => sameAddress(row.token, prior.asset))!.account : undefined;
        return { ...active, phase: "deposit", depositShares, depositPathLive: depositShares > 0n,
          ...(depositExecutor === undefined ? {} : { depositExecutor }) } satisfies YieldBasisLtDepositEvidence;
      }
      if (prior.phase === "deposit") {
        const result = results.find(r => r.id === "active-deposit-program");
        if (!result || !result.ok || !prior.depositExecutor) throw new Error("Yield Basis guarded deposit evidence missing");
        const shares = result.completion === "returned"
          ? decodeDepositProgramReceipt(results, result.id, prior, prior.source, prior.depositExecutor, prior.depositAssets) : 0n;
        if (shares > 0n && shares !== prior.depositShares) throw new Error("Yield Basis raw/program mint mismatch");
        return { ...prior, phase: "deposit-program", depositProgramVerified: shares > 0n,
          depositProgramProof: hashCanonical({ source: { ...result.source }, provenance: { ...result.provenance },
            completion: result.completion, shares, executor: prior.depositExecutor }) } satisfies YieldBasisLtProgramEvidence;
      }
      throw new Error("yield basis LT identity is already complete");
    },
    decide({ candidate, evidence }) {
      if (evidence === undefined) return { status: "continue" as const };
      const lt = candidateLt(candidate);
      const proof = evidence as YieldBasisLtIdentityEvidence;
      if (lower(proof.lt) !== lt) {
        return {
          status: "invalid-program" as const,
          reasonCode: "foreign-yieldbasis-lt-candidate",
        };
      }
      if (proof.phase === "base") {
        return proof.baseValid
          ? { status: "continue" as const }
          : {
              status: "chain-proven-rejected" as const,
              reasonCode: "yieldbasis_lt_binding_surfaces_failed",
              evidenceRequestIds: [...proof.evidenceRequestIds],
            };
      }
      if (proof.phase === "binding") {
        if (proof.bindingValid) return { status: "continue" as const };
        if (!proof.ammBindingsValid) {
          return {
            status: "chain-proven-rejected" as const,
            reasonCode: "yieldbasis_lt_amm_lt_contract_mismatch",
            evidenceRequestIds: [...BINDING_IDS],
          };
        }
        if (proof.assetCoinIndex < 0 || !proof.poolCoinBindingsValid) {
          return {
            status: "chain-proven-rejected" as const,
            reasonCode: "yieldbasis_lt_cryptopool_coin_binding_failed",
            evidenceRequestIds: [...BINDING_IDS],
          };
        }
        return {
          status: "chain-proven-rejected" as const,
          reasonCode: "yieldbasis_lt_asset_decimals_invalid",
          evidenceRequestIds: ["binding-asset-decimals", "binding-pool-decimals"],
        };
      }
      const active = proof;
      if (active.ammKilled || active.killed) {
        return {
          status: "chain-proven-rejected" as const,
          reasonCode: "yieldbasis_lt_killed",
          evidenceRequestIds: ["active-is-killed", "active-amm-is-killed"],
        };
      }
      if (!active.redemptionPathLive) {
        return {
          status: "chain-proven-rejected" as const,
          reasonCode: "yieldbasis_lt_redemption_path_inactive",
          evidenceRequestIds: ["active-preview-withdraw"],
        };
      }
      if (active.phase === "deposit" && active.depositPathLive) return { status: "continue" as const };
      const depositPathVerified = active.phase === "deposit-program" && active.depositProgramVerified;
      return {
        status: "verified" as const,
        identity: {
          familyId: YIELDBASIS_FAMILY_ID,
          lineageId: YIELDBASIS_LINEAGE_ID,
          subject: active.lt,
          asset: active.asset,
          stablecoin: active.stablecoin,
          cryptopool: active.cryptopool,
          amm: active.amm,
          agg: active.agg,
          staker: active.staker,
          admin: active.admin,
          decimals: active.decimals,
          assetDecimals: active.assetDecimals,
          assetCoinIndex: active.assetCoinIndex,
          redemptionPathVerified: true,
          depositPathVerified,
          facts: {
            lt: active.lt,
            asset: active.asset,
            stablecoin: active.stablecoin,
            cryptopool: active.cryptopool,
            amm: active.amm,
            agg: active.agg,
            staker: active.staker,
            admin: active.admin,
            decimals: active.decimals,
            assetDecimals: active.assetDecimals,
            assetCoinIndex: active.assetCoinIndex,
            totalSupply: active.totalSupply,
            liveSupplyTokens: active.liveSupplyTokens,
            liquidityTotal: active.liquidityTotal,
            probeShares: active.probeShares,
            probeCryptoReceived: active.probeCryptoReceived,
            killed: active.killed,
            depositPathVerified,
            depositDebtPolicy: DEPOSIT_DEBT_POLICY,
            depositProbeAssets: active.depositAssets,
            depositProbeDebt: active.depositDebt,
            depositProbeShares: active.phase !== "active" ? active.depositShares : 0n,
            depositProgramProof: active.phase === "deposit-program" ? active.depositProgramProof : null,
          },
          provenance: [{
            kind: "levamm-mutual-reference-and-live-withdraw-preview",
            subject: active.amm,
            evidenceHash: hashCanonical({
              lt: active.lt,
              ltCodeHash: active.ltCodeHash,
              ammLtContract: active.ammLtContract,
              ammCollateral: active.ammCollateral,
              ammStablecoin: active.ammStablecoin,
              poolCoin0: active.poolCoin0,
              poolCoin1: active.poolCoin1,
              assetCoinIndex: active.assetCoinIndex,
              assetDecimals: active.assetDecimals,
              probeShares: active.probeShares.toString(),
              probeCryptoReceived: active.probeCryptoReceived.toString(),
              behaviorProof: active.behaviorProofHash,
              depositPathVerified,
              depositDebtPolicy: DEPOSIT_DEBT_POLICY,
              depositProbeAssets: active.depositAssets.toString(),
              depositProbeDebt: active.depositDebt.toString(),
              depositProbeShares: active.phase !== "active" ? active.depositShares.toString() : "0",
              depositProgramProof: active.phase === "deposit-program" ? active.depositProgramProof : null,
            }),
          }],
        },
      };
    },
  }],
};

function baseRequests(lt: string) {
  return BASE_IDS.map((id) => {
    const name = {
      "lt-asset-token": "ASSET_TOKEN",
      "lt-stablecoin": "STABLECOIN",
      "lt-cryptopool": "CRYPTOPOOL",
      "lt-amm": "amm",
      "lt-agg": "agg",
      "lt-staker": "staker",
      "lt-admin": "admin",
      "lt-decimals": "decimals",
      "lt-total-supply": "totalSupply",
      "lt-liquidity": "liquidity",
      "lt-updated-balances": "updated_balances",
      "lt-is-killed": "is_killed",
    }[id]!;
    return callRequest(id, lt, LT_INTERFACE.encodeFunctionData(name));
  });
}

function bindingRequests(proof: YieldBasisLtBaseEvidence) {
  return [
    ...depositBalanceRequests(proof, "binding-deposit-balance"),
    callRequest(
      "binding-amm-lt",
      proof.amm,
      LEVAMM_INTERFACE.encodeFunctionData("LT_CONTRACT"),
    ),
    callRequest(
      "binding-amm-collateral",
      proof.amm,
      LEVAMM_INTERFACE.encodeFunctionData("COLLATERAL"),
    ),
    callRequest(
      "binding-amm-stablecoin",
      proof.amm,
      LEVAMM_INTERFACE.encodeFunctionData("STABLECOIN"),
    ),
    callRequest(
      "binding-pool-coin-0",
      proof.cryptopool,
      CRYPTOPOOL_INTERFACE.encodeFunctionData("coins", [0]),
    ),
    callRequest(
      "binding-pool-coin-1",
      proof.cryptopool,
      CRYPTOPOOL_INTERFACE.encodeFunctionData("coins", [1]),
    ),
    callRequest(
      "binding-pool-decimals",
      proof.cryptopool,
      CRYPTOPOOL_INTERFACE.encodeFunctionData("decimals"),
    ),
    callRequest(
      "binding-pool-share-supply",
      proof.cryptopool,
      CRYPTOPOOL_INTERFACE.encodeFunctionData("totalSupply"),
    ),
    callRequest(
      "binding-asset-decimals",
      proof.asset,
      ERC20_INTERFACE.encodeFunctionData("decimals"),
    ),
  ];
}

function decodeBase(
  lt: string,
  results: readonly AdapterRequestResult[],
): YieldBasisLtBaseEvidence {
  const code = returnedResult(results, "lt-code").data;
  const asset = decodeAddress(LT_INTERFACE, "ASSET_TOKEN", results, "lt-asset-token");
  const stablecoin = decodeAddress(
    LT_INTERFACE,
    "STABLECOIN",
    results,
    "lt-stablecoin",
  );
  const cryptopool = decodeAddress(
    LT_INTERFACE,
    "CRYPTOPOOL",
    results,
    "lt-cryptopool",
  );
  const amm = decodeAddress(LT_INTERFACE, "amm", results, "lt-amm");
  const agg = decodeAddress(LT_INTERFACE, "agg", results, "lt-agg");
  const staker = decodeAddress(LT_INTERFACE, "staker", results, "lt-staker");
  const admin = decodeAddress(LT_INTERFACE, "admin", results, "lt-admin");
  const decimals = Number(decodeUint(LT_INTERFACE, "decimals", results, "lt-decimals"));
  const totalSupply = decodeUint(
    LT_INTERFACE,
    "totalSupply",
    results,
    "lt-total-supply",
  );
  const liquidityData = returnedResult(results, "lt-liquidity").data;
  const liquidity = LT_INTERFACE.decodeFunctionResult("liquidity", liquidityData);
  const balances = LT_INTERFACE.decodeFunctionResult(
    "updated_balances",
    returnedResult(results, "lt-updated-balances").data,
  );
  const killed = Boolean(
    LT_INTERFACE.decodeFunctionResult(
      "is_killed",
      returnedResult(results, "lt-is-killed").data,
    )[0],
  );
  const rejected: string[] = [];
  if (code === "0x") rejected.push("lt-code");
  for (const [id, value] of [
    ["lt-asset-token", asset],
    ["lt-stablecoin", stablecoin],
    ["lt-cryptopool", cryptopool],
    ["lt-amm", amm],
    ["lt-agg", agg],
    ["lt-admin", admin],
  ] as const) {
    if (isZeroAddress(value) || sameAddress(value, lt)) rejected.push(id);
  }
  if (!Number.isSafeInteger(decimals) || decimals <= 0 || decimals > 36) {
    rejected.push("lt-decimals");
  }
  return {
    phase: "base",
    source: assertSameSource(results.filter((r): r is Extract<AdapterRequestResult, { ok: true }> => r.ok)),
    lt,
    ltCodeHash: ethers.keccak256(code),
    asset: canonicalAddress(asset),
    stablecoin: canonicalAddress(stablecoin),
    cryptopool: canonicalAddress(cryptopool),
    amm: canonicalAddress(amm),
    agg: canonicalAddress(agg),
    staker: canonicalAddress(staker),
    admin: canonicalAddress(admin),
    decimals,
    totalSupply,
    killed,
    liquidityAdmin: BigInt(liquidity[0] as bigint | number | string),
    liquidityTotal: BigInt(liquidity[1] as bigint | number | string),
    liquidityIdealStaked: BigInt(liquidity[2] as bigint | number | string),
    liquidityStaked: BigInt(liquidity[3] as bigint | number | string),
    liveSupplyTokens: BigInt(balances[0] as bigint | number | string),
    baseValid: rejected.length === 0,
    evidenceRequestIds: rejected.length === 0 ? [] : rejected,
  };
}

function decodeBinding(
  prior: YieldBasisLtBaseEvidence,
  results: readonly AdapterRequestResult[],
): YieldBasisLtBindingEvidence {
  const ammLtContract = decodeAddress(
    LEVAMM_INTERFACE,
    "LT_CONTRACT",
    results,
    "binding-amm-lt",
  );
  const ammCollateral = decodeAddress(
    LEVAMM_INTERFACE,
    "COLLATERAL",
    results,
    "binding-amm-collateral",
  );
  const ammStablecoin = decodeAddress(
    LEVAMM_INTERFACE,
    "STABLECOIN",
    results,
    "binding-amm-stablecoin",
  );
  const coin0 = decodeAddress(
    CRYPTOPOOL_INTERFACE,
    "coins",
    results,
    "binding-pool-coin-0",
  );
  const coin1 = decodeAddress(
    CRYPTOPOOL_INTERFACE,
    "coins",
    results,
    "binding-pool-coin-1",
  );
  const poolDecimals = Number(decodeUint(
    CRYPTOPOOL_INTERFACE,
    "decimals",
    results,
    "binding-pool-decimals",
  ));
  const poolShareSupply = decodeUint(
    CRYPTOPOOL_INTERFACE,
    "totalSupply",
    results,
    "binding-pool-share-supply",
  );
  const assetDecimals = Number(decodeUint(
    ERC20_INTERFACE,
    "decimals",
    results,
    "binding-asset-decimals",
  ));
  const ammBindingsValid = sameAddress(ammLtContract, prior.lt) &&
    sameAddress(ammCollateral, prior.cryptopool) &&
    sameAddress(ammStablecoin, prior.stablecoin);
  const poolCoinBindingsValid = !isZeroAddress(coin0) &&
    !isZeroAddress(coin1) &&
    !sameAddress(coin0, coin1) &&
    sameAddress(coin0, prior.stablecoin) &&
    sameAddress(coin1, prior.asset) &&
    poolDecimals === 18 &&
    poolShareSupply > 0n;
  const assetCoinIndex = sameAddress(coin1, prior.asset)
    ? 1
    : sameAddress(coin0, prior.asset)
    ? 0
    : -1;
  const assetDecimalsValid = Number.isSafeInteger(assetDecimals) &&
    assetDecimals > 0 &&
    assetDecimals <= 36;
  const balances = [0, 1].map(i => decodeUint(CRYPTOPOOL_INTERFACE, "balances", results, `binding-deposit-balance-${i}`));
  // Bounded strict behavior sample, not a substitute for the production P.
  const unitSample = assetDecimalsValid ? ((10n ** BigInt(assetDecimals)) / 1000n || 1n) : 0n;
  const poolSample = balances[1]! / 1_000_000n;
  let depositAssets = unitSample < poolSample ? unitSample : poolSample, depositDebt = 0n;
  if (depositAssets > 0n && balances[0]! > 0n) {
    const cap = ethers.MaxUint256 / balances[0]!;
    if (depositAssets > cap) depositAssets = cap;
    if (depositAssets > 0n && depositAssets * balances[0]! / balances[1]! > 0n)
      depositDebt = balancedDepositDebt(depositAssets, { stable: balances[0]!, asset: balances[1]! });
  }
  if (depositDebt === 0n) depositAssets = 0n;
  return {
    ...prior,
    phase: "binding",
    ammLtContract: canonicalAddress(ammLtContract),
    ammCollateral: canonicalAddress(ammCollateral),
    ammStablecoin: canonicalAddress(ammStablecoin),
    poolCoin0: canonicalAddress(coin0),
    poolCoin1: canonicalAddress(coin1),
    poolDecimals,
    poolShareSupply,
    assetDecimals,
    assetCoinIndex,
    ammBindingsValid,
    poolCoinBindingsValid,
    bindingValid: prior.baseValid && ammBindingsValid &&
      poolCoinBindingsValid && assetCoinIndex >= 0 && assetDecimalsValid,
    depositAssets, depositDebt,
  };
}

function decodeActive(
  prior: YieldBasisLtBindingEvidence,
  results: readonly AdapterRequestResult[],
): YieldBasisLtActiveEvidence {
  const ltKilled = results.find((result) => result.id === "active-is-killed");
  const ammKilledResult = results.find((result) =>
    result.id === "active-amm-is-killed");
  const probe = results.find((result) =>
    result.id === "active-preview-withdraw");
  const killed = ltKilled !== undefined && ltKilled.ok
    ? Boolean(LT_INTERFACE.decodeFunctionResult("is_killed", ltKilled.data)[0])
    : true;
  const ammKilled = ammKilledResult !== undefined && ammKilledResult.ok
    ? Boolean(LEVAMM_INTERFACE.decodeFunctionResult(
        "is_killed",
        ammKilledResult.data,
      )[0])
    : true;
  const probeCryptoReceived = probe !== undefined && probe.ok
    ? BigInt(LT_INTERFACE.decodeFunctionResult(
        "preview_withdraw",
        probe.data,
      )[0])
    : 0n;
  const redemptionPathLive = ltKilled !== undefined && ltKilled.ok &&
    ammKilledResult !== undefined && ammKilledResult.ok && !killed &&
    !ammKilled && probe !== undefined && probe.ok &&
    probeCryptoReceived > 0n;
  return {
    ...prior,
    phase: "active",
    ammKilled,
    killed,
    probeShares: LT_PROBE_SHARES,
    probeCryptoReceived,
    redemptionPathLive,
    behaviorProofHash: hashCanonical({
      lt: prior.lt,
      amm: prior.amm,
      cryptopool: prior.cryptopool,
      asset: prior.asset,
      stablecoin: prior.stablecoin,
      assetCoinIndex: prior.assetCoinIndex,
      liveSupplyTokens: prior.liveSupplyTokens.toString(),
      liquidityTotal: prior.liquidityTotal.toString(),
      killed,
      ammKilled,
      probeShares: LT_PROBE_SHARES.toString(),
      probeCryptoReceived: probeCryptoReceived.toString(),
      redemptionPathLive,
    }),
  };
}

/** Re-exported so the negative contracts can name the canonical lowercase LT. */
export const yieldBasisLtIdentityKey = (lt: string) => lowerAddress(lt);
