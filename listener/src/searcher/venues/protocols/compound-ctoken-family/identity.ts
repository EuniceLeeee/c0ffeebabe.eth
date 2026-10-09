import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import { RequiredAdapterRequestError } from
  "../../adapter-request-failure.js";
import type { AdapterRequestResult } from
  "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  assertSameSource,
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
  COMPTROLLER_INTERFACE,
  CTOKEN_INTERFACE,
  CTOKEN_PROBE_ACTOR,
} from "./abi.js";
import { candidateMarket, isZeroAddress, lower } from "./codec.js";
import {
  CTOKEN_FAMILY_ID,
  CTOKEN_LINEAGE_ID,
} from "./manifest.js";
import type {
  CompoundCTokenActiveEvidence,
  CompoundCTokenBaseEvidence,
  CompoundCTokenCandidate,
  CompoundCTokenIdentity,
  CompoundCTokenIdentityEvidence,
  CompoundCTokenRegistryEvidence,
} from "./types.js";

const BASE_IDS = [
  "market-comptroller",
  "market-underlying",
  "market-exchange-rate-stored",
  "market-cash",
  "market-share-supply",
  "market-decimals",
] as const;
const REGISTRY_IDS = ["registry-markets", "registry-all-markets"] as const;
/**
 * The active round always carries a required same-state exchange-rate read
 * (which must succeed) alongside the optional redemption probe, so the round
 * always produces successful evidence while a dead redemption surface still
 * surfaces as a chain-proven rejection.
 */
const ACTIVE_IDS = [
  "active-exchange-rate-stored",
  "active-underlying-balance",
] as const;

/**
 * Compound V2 cToken identity — registry-admission, never an address allowlist.
 *
 *   1. `comptroller()` / `underlying()` / `exchangeRateStored()` / `getCash()` /
 *      `totalSupply()` / `decimals()` are read at the pinned block;
 *   2. the Comptroller must reverse-admit the market: `markets(market)` reports
 *      `isListed == true` AND `getAllMarkets()` enumerates it;
 *   3. `balanceOfUnderlying(probe)` must return, proving the stored
 *      exchange-rate redemption path is live on that same state.
 *
 * The pinned-block reads prove registration existence at that block. They do
 * not claim creation lineage, and public metadata snapshots are never used as
 * identity evidence.
 */
export const compoundCTokenIdentity: IdentitySemantics<
  CompoundCTokenCandidate,
  CompoundCTokenIdentity
> = {
  identityKey: (identity) => lower(identity.subject),
  variants: [{
    id: "comptroller-registered-ctoken",
    kind: "standalone-contract" as const,
    lineageId: CTOKEN_LINEAGE_ID,
    applies: (candidate) => candidate.candidateKind === "compound-ctoken-market",
    requirements({ evidence }) {
      if (evidence === undefined) {
        return { transports: ["get-code" as const, "eth-call" as const] };
      }
      const proof = evidence as CompoundCTokenIdentityEvidence;
      if (proof.phase === "base") {
        return proof.baseValid
          ? { transports: ["eth-call" as const] }
          : { transports: [] as const };
      }
      if (proof.phase === "registry") {
        return proof.registryValid
          ? { transports: ["eth-call" as const] }
          : { transports: [] as const };
      }
      return { transports: [] as const };
    },
    buildRequests({ candidate, evidence }) {
      const market = candidateMarket(candidate);
      if (evidence === undefined) {
        return Object.freeze([
          codeRequest("market-code", market),
          ...baseRequests(market),
        ]);
      }
      const proof = evidence as CompoundCTokenIdentityEvidence;
      if (proof.phase === "base") {
        if (!proof.baseValid) return Object.freeze([]);
        return Object.freeze(registryRequests(proof.comptroller, market));
      }
      if (proof.phase === "registry") {
        if (!proof.registryValid) return Object.freeze([]);
        return Object.freeze([
          callRequest(
            "active-exchange-rate-stored",
            proof.market,
            CTOKEN_INTERFACE.encodeFunctionData("exchangeRateStored"),
          ),
          callRequest(
            "active-underlying-balance",
            proof.market,
            CTOKEN_INTERFACE.encodeFunctionData("balanceOfUnderlying", [
              CTOKEN_PROBE_ACTOR,
            ]),
          ),
        ]);
      }
      return Object.freeze([]);
    },
    decode({ step, results }) {
      const optionalIds = step.evidence === undefined
        ? new Set<string>()
        : new Set<string>([...REGISTRY_IDS, ...ACTIVE_IDS]);
      for (const result of results) {
        if (!result.ok && !optionalIds.has(result.id)) {
          throw new RequiredAdapterRequestError(result);
        }
      }
      const successful = results.filter(
        (result): result is Extract<AdapterRequestResult, { readonly ok: true }> =>
          result.ok,
      );
      // A probe round may legitimately fail entirely (that is the inactive
      // redemption path); only compare sources when something succeeded.
      if (successful.length > 0) assertSameSource(successful);
      const market = candidateMarket(step.candidate);
      if (step.evidence === undefined) return decodeBase(market, results);
      const prior = step.evidence as CompoundCTokenIdentityEvidence;
      if (prior.phase === "base") return decodeRegistry(prior, results);
      if (prior.phase === "registry") return decodeActive(prior, results);
      throw new Error("compound cToken identity is already complete");
    },
    decide({ candidate, evidence }) {
      if (evidence === undefined) return { status: "continue" as const };
      const market = candidateMarket(candidate);
      const proof = evidence as CompoundCTokenIdentityEvidence;
      if (lower(proof.market) !== market) {
        return {
          status: "invalid-program" as const,
          reasonCode: "foreign-compound-ctoken-candidate",
        };
      }
      if (proof.phase === "base") {
        return proof.baseValid
          ? { status: "continue" as const }
          : {
              status: "chain-proven-rejected" as const,
              reasonCode: "compound_ctoken_surfaces_failed",
              evidenceRequestIds: [...proof.evidenceRequestIds],
            };
      }
      if (proof.phase === "registry") {
        return proof.registryValid
          ? { status: "continue" as const }
          : {
              status: "chain-proven-rejected" as const,
              reasonCode: proof.listedInComptroller
                ? "compound_ctoken_not_enumerated_by_comptroller"
                : "compound_ctoken_not_listed_by_comptroller",
              evidenceRequestIds: [...REGISTRY_IDS],
            };
      }
      const active: CompoundCTokenActiveEvidence = proof;
      if (!active.redemptionPathLive) {
        return {
          status: "chain-proven-rejected" as const,
          reasonCode: "compound_ctoken_redemption_path_inactive",
          evidenceRequestIds: [...ACTIVE_IDS],
        };
      }
      return {
        status: "verified" as const,
        identity: {
          familyId: CTOKEN_FAMILY_ID,
          lineageId: CTOKEN_LINEAGE_ID,
          subject: active.market,
          comptroller: active.comptroller,
          underlying: active.underlying,
          decimals: active.decimals,
          redemptionPathVerified: true,
          facts: {
            market: active.market,
            comptroller: active.comptroller,
            underlying: active.underlying,
            exchangeRateStored: active.exchangeRateStored,
            cash: active.cash,
            shareSupply: active.shareSupply,
            decimals: active.decimals,
            listedInComptroller: active.listedInComptroller,
            registeredInAllMarkets: active.registeredInAllMarkets,
          },
          provenance: [{
            kind: "comptroller-registry-and-live-exchange-rate-path",
            subject: active.comptroller,
            evidenceHash: hashCanonical({
              market: active.market,
              comptroller: active.comptroller,
              underlying: active.underlying,
              decimals: active.decimals,
              listed: active.listedInComptroller,
              enumerated: active.registeredInAllMarkets,
              probeUnderlying: active.probeUnderlying.toString(),
              behaviorProof: active.behaviorProofHash,
            }),
          }],
        },
      };
    },
  }],
};

function baseRequests(market: string) {
  return BASE_IDS.map((id) => {
    const name = {
      "market-comptroller": "comptroller",
      "market-underlying": "underlying",
      "market-exchange-rate-stored": "exchangeRateStored",
      "market-cash": "getCash",
      "market-share-supply": "totalSupply",
      "market-decimals": "decimals",
    }[id]!;
    return callRequest(id, market, CTOKEN_INTERFACE.encodeFunctionData(name));
  });
}

function registryRequests(comptroller: string, market: string) {
  return [
    callRequest(
      "registry-markets",
      comptroller,
      COMPTROLLER_INTERFACE.encodeFunctionData("markets", [market]),
    ),
    callRequest(
      "registry-all-markets",
      comptroller,
      COMPTROLLER_INTERFACE.encodeFunctionData("getAllMarkets"),
    ),
  ];
}

function decodeBase(
  market: string,
  results: readonly AdapterRequestResult[],
): CompoundCTokenBaseEvidence {
  const code = returnedResult(results, "market-code").data;
  const comptroller = decodeAddress(
    CTOKEN_INTERFACE,
    "comptroller",
    results,
    "market-comptroller",
  );
  const underlying = decodeAddress(
    CTOKEN_INTERFACE,
    "underlying",
    results,
    "market-underlying",
  );
  const exchangeRateStored = decodeUint(
    CTOKEN_INTERFACE,
    "exchangeRateStored",
    results,
    "market-exchange-rate-stored",
  );
  const cash = decodeUint(CTOKEN_INTERFACE, "getCash", results, "market-cash");
  const shareSupply = decodeUint(
    CTOKEN_INTERFACE,
    "totalSupply",
    results,
    "market-share-supply",
  );
  const decimals = Number(decodeUint(
    CTOKEN_INTERFACE,
    "decimals",
    results,
    "market-decimals",
  ));
  const rejected: string[] = [];
  if (code === "0x") rejected.push("market-code");
  if (isZeroAddress(comptroller) || sameAddress(comptroller, market)) {
    rejected.push("market-comptroller");
  }
  if (isZeroAddress(underlying) || sameAddress(underlying, market)) {
    rejected.push("market-underlying");
  }
  if (exchangeRateStored <= 0n) rejected.push("market-exchange-rate-stored");
  if (!Number.isSafeInteger(decimals) || decimals > 36) {
    rejected.push("market-decimals");
  }
  return {
    phase: "base",
    market,
    marketCodeHash: ethers.keccak256(code),
    comptroller: canonicalAddress(comptroller),
    underlying: canonicalAddress(underlying),
    exchangeRateStored,
    cash,
    shareSupply,
    decimals,
    baseValid: rejected.length === 0,
    evidenceRequestIds: rejected.length === 0 ? [] : rejected,
  };
}

function decodeRegistry(
  prior: CompoundCTokenBaseEvidence,
  results: readonly AdapterRequestResult[],
): CompoundCTokenRegistryEvidence {
  const marketsResult = results.find((result) =>
    result.id === "registry-markets");
  let listedInComptroller = false;
  if (marketsResult !== undefined && marketsResult.ok) {
    const decoded = COMPTROLLER_INTERFACE.decodeFunctionResult(
      "markets",
      marketsResult.data,
    );
    listedInComptroller = Boolean(decoded[0]);
  }
  const allResult = results.find((result) =>
    result.id === "registry-all-markets");
  let registeredInAllMarkets = false;
  if (allResult !== undefined && allResult.ok) {
    const decoded = COMPTROLLER_INTERFACE.decodeFunctionResult(
      "getAllMarkets",
      allResult.data,
    );
    const markets = (decoded[0] as readonly string[]).map((value) =>
      lowerAddress(String(value)));
    registeredInAllMarkets = markets.includes(lowerAddress(prior.market));
  }
  return {
    ...prior,
    phase: "registry",
    listedInComptroller,
    registeredInAllMarkets,
    registryValid: prior.baseValid && listedInComptroller &&
      registeredInAllMarkets,
  };
}

function decodeActive(
  prior: CompoundCTokenRegistryEvidence,
  results: readonly AdapterRequestResult[],
): CompoundCTokenActiveEvidence {
  const probe = results.find((result) =>
    result.id === "active-underlying-balance");
  const storedResult = results.find((result) =>
    result.id === "active-exchange-rate-stored");
  const activeRate = storedResult !== undefined && storedResult.ok
    ? BigInt(CTOKEN_INTERFACE.decodeFunctionResult(
        "exchangeRateStored",
        storedResult.data,
      )[0])
    : prior.exchangeRateStored;
  const probeUnderlying = probe !== undefined && probe.ok
    ? BigInt(CTOKEN_INTERFACE.decodeFunctionResult(
        "balanceOfUnderlying",
        probe.data,
      )[0])
    : 0n;
  const redemptionPathLive = probe !== undefined && probe.ok;
  return {
    ...prior,
    phase: "active",
    exchangeRateStored: activeRate,
    probeUnderlying,
    redemptionPathLive,
    behaviorProofHash: hashCanonical({
      market: prior.market,
      exchangeRateStored: activeRate.toString(),
      cash: prior.cash.toString(),
      shareSupply: prior.shareSupply.toString(),
      probeUnderlying: probeUnderlying.toString(),
      probeActor: CTOKEN_PROBE_ACTOR,
      redemptionPathLive,
    }),
  };
}
