import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type {
  AdapterRequest,
  AdapterRequestResult,
} from "../../adapter-request-program.js";
import { RequiredAdapterRequestError } from
  "../../adapter-request-failure.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  assertSameSource,
  callRequest,
  canonicalAddress,
  codeRequest,
  decodeAddress,
  decodeUint,
  effectsProjection,
  requireRuntimeCode,
  sameAddress,
  tokenDeltaAtLeast,
  totalSupplyDeltaAtLeast,
} from "../standard-family/common.js";
import {
  ERC4626_DEPOSIT_TOPIC,
  ERC4626_ERC20_INTERFACE,
  ERC4626_INTERFACE,
  ERC4626_PROBE_ACTOR,
  ERC4626_SAMPLE_AMOUNTS,
  ERC4626_WITHDRAW_TOPIC,
} from "./abi.js";
import {
  ERC4626_FAMILY_ID,
  ERC4626_LINEAGE_ID,
} from "./manifest.js";
import type {
  Erc4626ActiveEvidence,
  Erc4626BaseEvidence,
  Erc4626Candidate,
  Erc4626Identity,
  Erc4626IdentityEvidence,
} from "./types.js";

export const ERC4626_PROBE_ACTOR_EVIDENCE_ID = "erc4626-probe-actor";

export const erc4626Identity: IdentitySemantics<
  Erc4626Candidate,
  Erc4626Identity
> = {
  variants: [{
    id: "standalone-standard-behavior",
    kind: "standalone-contract" as const,
    lineageId: ERC4626_LINEAGE_ID,
    applies: () => true,
    requirements({ evidence }) {
      if (evidence === undefined) {
        return { transports: ["get-code" as const, "eth-call" as const] };
      }
      return {
        transports: [
          "get-code" as const,
          "eth-call" as const,
          "effect-delta-simulation" as const,
        ],
        caller: "verified-actor" as const,
        effects: [
          "return-data" as const,
          "revert-data" as const,
          "token-delta" as const,
          "total-supply-delta" as const,
          "logs" as const,
        ],
      };
    },
    buildRequests({ candidate, evidence }) {
      if (evidence === undefined) return baseRequests(candidate.vault);
      return activeRequests(evidence as Erc4626BaseEvidence);
    },
    decode({ step, results }) {
      const optionalDirectionIds = step.evidence === undefined
        ? new Set<string>()
        : new Set([
            "active-asset-balance",
            "active-share-balance",
            "active-deposit",
            "active-redeem",
          ]);
      const successful = results.filter((result) => result.ok);
      for (const result of results) {
        if (!result.ok && !optionalDirectionIds.has(result.id)) {
          throw new RequiredAdapterRequestError(result);
        }
      }
      assertSameSource(successful);
      return step.evidence === undefined
        ? decodeBaseEvidence(step.candidate.vault, results)
        : decodeActiveEvidence(
            step.evidence as Erc4626BaseEvidence,
            results,
          );
    },
    decide: ({ candidate, evidence }) => {
      if (evidence === undefined) return { status: "continue" as const };
      const proof = evidence as Erc4626IdentityEvidence;
      if (proof.phase === "base") {
        return proof.baseValid
          ? { status: "continue" as const }
          : {
              status: "chain-proven-rejected" as const,
              reasonCode: "erc4626_standard_views_failed",
              evidenceRequestIds:
                proof.evidenceRequestIds !== undefined
                  ? proof.evidenceRequestIds
                  : ["base-asset", "base-total-assets", "base-total-supply"],
            };
      }
      if (!proof.erc20SurfacesValid) {
        return {
          status: "chain-proven-rejected" as const,
          reasonCode: "erc4626_erc20_surfaces_failed",
          evidenceRequestIds: ["base-asset"],
        };
      }
      if (!proof.depositVerified && !proof.redeemVerified) {
        // Both declared execution surfaces reverted at the fixed cutoff.
        return {
          status: "chain-proven-rejected" as const,
          reasonCode: "erc4626_execution_surfaces_failed",
          evidenceRequestIds: ["active-deposit", "active-redeem"],
        };
      }
      return {
        status: "verified" as const,
        identity: Object.freeze({
          familyId: ERC4626_FAMILY_ID,
          lineageId: ERC4626_LINEAGE_ID,
          subject: canonicalAddress(candidate.vault),
          provenance: Object.freeze([Object.freeze({
            kind: "erc4626-standard-active-proof",
            subject: canonicalAddress(candidate.vault),
            evidenceHash: proof.behaviorProofHash,
          })]),
          asset: proof.asset,
          verifiedDirections: Object.freeze({
            deposit: proof.depositVerified,
            redeem: proof.redeemVerified,
          }),
        }),
      };
    },
  }],
  identityKey: (identity) => identity.subject.toLowerCase(),
};

function tolerance(value: bigint): bigint {
  return value / 1_000n + 2n;
}

function baseRequests(vault: string): readonly AdapterRequest[] {
  const target = canonicalAddress(vault);
  const requests: AdapterRequest[] = [
    codeRequest("base-vault-code", target),
    callRequest(
      "base-asset",
      target,
      ERC4626_INTERFACE.encodeFunctionData("asset"),
    ),
    callRequest(
      "base-total-assets",
      target,
      ERC4626_INTERFACE.encodeFunctionData("totalAssets"),
    ),
    callRequest(
      "base-total-supply",
      target,
      ERC4626_INTERFACE.encodeFunctionData("totalSupply"),
    ),
  ];
  for (let index = 0; index < ERC4626_SAMPLE_AMOUNTS.length; index++) {
    const amount = ERC4626_SAMPLE_AMOUNTS[index];
    requests.push(callRequest(
      `base-convert-shares:${index}`,
      target,
      ERC4626_INTERFACE.encodeFunctionData("convertToShares", [amount]),
    ));
    requests.push(callRequest(
      `base-preview-deposit:${index}`,
      target,
      ERC4626_INTERFACE.encodeFunctionData("previewDeposit", [amount]),
    ));
    requests.push(callRequest(
      `base-convert-assets:${index}`,
      target,
      ERC4626_INTERFACE.encodeFunctionData("convertToAssets", [amount]),
    ));
    requests.push(callRequest(
      `base-preview-redeem:${index}`,
      target,
      ERC4626_INTERFACE.encodeFunctionData("previewRedeem", [amount]),
    ));
  }
  return Object.freeze(requests);
}

function requestShape(
  results: readonly AdapterRequestResult[],
  id: string,
): "returned" | "reverted" | "missing" {
  const result = results.find((candidate) => candidate.id === id);
  if (result === undefined || !result.ok) return "missing";
  return result.completion === "returned" ? "returned" : "reverted";
}

function invalidBaseEvidence(
  vault: string,
  code: string,
  evidenceRequestIds: readonly string[],
): Erc4626BaseEvidence {
  return Object.freeze({
    phase: "base",
    vault: canonicalAddress(vault),
    vaultCodeHash: ethers.keccak256(code),
    asset: ethers.ZeroAddress,
    assetCodeHash: hashCanonical({ asset: ethers.ZeroAddress }),
    totalAssets: 0n,
    totalSupply: 0n,
    sampleAssets: 0n,
    sampleShares: 0n,
    previewDeposit: 0n,
    previewRedeem: 0n,
    baseValid: false,
    evidenceRequestIds: Object.freeze([...evidenceRequestIds]),
  });
}

function decodeBaseEvidence(
  vault: string,
  results: readonly AdapterRequestResult[],
): Erc4626BaseEvidence {
  const code = requireRuntimeCode(results, "base-vault-code");
  // Family-declared negative evidence: a pinned revert or empty return for
  // a standard ERC4626 view is deterministic chain shape at the fixed
  // cutoff and is interpreted by THIS Family as "not a standard vault".
  // The central runtime never infers this from result shapes.
  if (requestShape(results, "base-asset") !== "returned") {
    return invalidBaseEvidence(vault, code, [
      "base-asset",
      "base-total-assets",
      "base-total-supply",
    ]);
  }
  const asset = decodeAddress(
    ERC4626_INTERFACE,
    "asset",
    results,
    "base-asset",
  );
  if (sameAddress(asset, ethers.ZeroAddress) || sameAddress(asset, vault)) {
    return invalidBaseEvidence(vault, code, ["base-asset"]);
  }
  const assetCodeResult = results.find((result) =>
    result.id === "base-asset-code"
  );
  if (
    requestShape(results, "base-total-assets") !== "returned" ||
    requestShape(results, "base-total-supply") !== "returned"
  ) {
    return invalidBaseEvidence(vault, code, [
      "base-total-assets",
      "base-total-supply",
    ]);
  }
  const totalAssets = decodeUint(
    ERC4626_INTERFACE,
    "totalAssets",
    results,
    "base-total-assets",
  );
  const totalSupply = decodeUint(
    ERC4626_INTERFACE,
    "totalSupply",
    results,
    "base-total-supply",
  );
  let depositSample: {
    amount: bigint;
    shares: bigint;
    preview: bigint;
  } | null = null;
  let redeemSample: {
    shares: bigint;
    assets: bigint;
    preview: bigint;
  } | null = null;
  for (let index = 0; index < ERC4626_SAMPLE_AMOUNTS.length; index++) {
    const amount = ERC4626_SAMPLE_AMOUNTS[index];
    // A reverted/empty sample view is Family-declared negative evidence
    // for that sample direction; it must not crash decode (which would
    // surface as a program error instead of a chain-proven rejection).
    if (
      requestShape(results, `base-convert-shares:${index}`) !== "returned" ||
      requestShape(results, `base-preview-deposit:${index}`) !== "returned" ||
      requestShape(results, `base-convert-assets:${index}`) !== "returned" ||
      requestShape(results, `base-preview-redeem:${index}`) !== "returned"
    ) {
      continue;
    }
    const shares = decodeUint(
      ERC4626_INTERFACE,
      "convertToShares",
      results,
      `base-convert-shares:${index}`,
    );
    const previewDeposit = decodeUint(
      ERC4626_INTERFACE,
      "previewDeposit",
      results,
      `base-preview-deposit:${index}`,
    );
    const assets = decodeUint(
      ERC4626_INTERFACE,
      "convertToAssets",
      results,
      `base-convert-assets:${index}`,
    );
    const previewRedeem = decodeUint(
      ERC4626_INTERFACE,
      "previewRedeem",
      results,
      `base-preview-redeem:${index}`,
    );
    if (
      depositSample === null && shares > 0n && previewDeposit > 0n &&
      previewDeposit <= shares + tolerance(shares)
    ) {
      depositSample = { amount, shares, preview: previewDeposit };
    }
    if (
      redeemSample === null && assets > 0n && previewRedeem > 0n &&
      previewRedeem <= assets + tolerance(assets)
    ) {
      redeemSample = { shares: amount, assets, preview: previewRedeem };
    }
  }
  const sampleShares = totalSupply > 1n
    ? (redeemSample?.shares ?? totalSupply / 2n) > totalSupply / 2n
      ? totalSupply / 2n
      : (redeemSample?.shares ?? totalSupply / 2n)
    : 0n;
  return Object.freeze({
    phase: "base",
    vault: canonicalAddress(vault),
    vaultCodeHash: ethers.keccak256(code),
    asset,
    assetCodeHash:
      assetCodeResult?.ok && assetCodeResult.completion === "returned"
        ? ethers.keccak256(assetCodeResult.data)
        : hashCanonical({ asset }),
    totalAssets,
    totalSupply,
    sampleAssets: depositSample?.amount ?? 0n,
    sampleShares,
    previewDeposit: depositSample?.preview ?? 0n,
    previewRedeem: redeemSample?.preview ?? 0n,
    baseValid: depositSample !== null && redeemSample !== null,
  });
}

function activeRequests(
  evidence: Erc4626BaseEvidence,
): readonly AdapterRequest[] {
  if (!evidence.baseValid) return [];
  const requests: AdapterRequest[] = [
    codeRequest("active-asset-code", evidence.asset),
    declaredCallRequest(
      "active-asset-balance",
      evidence.asset,
      ERC4626_ERC20_INTERFACE.encodeFunctionData("balanceOf", [
        ERC4626_PROBE_ACTOR,
      ]),
    ),
    declaredCallRequest(
      "active-share-balance",
      evidence.vault,
      ERC4626_ERC20_INTERFACE.encodeFunctionData("balanceOf", [
        ERC4626_PROBE_ACTOR,
      ]),
    ),
    callRequest(
      "active-roundtrip",
      evidence.vault,
      ERC4626_INTERFACE.encodeFunctionData("previewRedeem", [
        evidence.previewDeposit,
      ]),
    ),
    Object.freeze({
      id: "active-deposit",
      required: false,
      kind: "effect-delta-simulation" as const,
      preCalls: Object.freeze([Object.freeze({
        caller: Object.freeze({
          kind: "verified-actor" as const,
          evidenceId: ERC4626_PROBE_ACTOR_EVIDENCE_ID,
        }),
        to: evidence.asset,
        data: ERC4626_ERC20_INTERFACE.encodeFunctionData("approve", [
          evidence.vault,
          evidence.sampleAssets,
        ]),
      })]),
      call: Object.freeze({
        caller: Object.freeze({
          kind: "verified-actor" as const,
          evidenceId: ERC4626_PROBE_ACTOR_EVIDENCE_ID,
        }),
        to: evidence.vault,
        data: ERC4626_INTERFACE.encodeFunctionData("deposit", [
          evidence.sampleAssets,
          ERC4626_PROBE_ACTOR,
        ]),
      }),
      overrideIntent: Object.freeze({
        caller: Object.freeze({
          kind: "verified-actor" as const,
          evidenceId: ERC4626_PROBE_ACTOR_EVIDENCE_ID,
        }),
        tokenBalances: Object.freeze([Object.freeze({
          token: evidence.asset,
          amount: evidence.sampleAssets,
        })]),
      }),
      observe: Object.freeze([
        "return-data" as const,
        "revert-data" as const,
        "token-delta" as const,
        "total-supply-delta" as const,
        "logs" as const,
      ]),
    }),
  ];
  if (evidence.sampleShares > 0n) {
    requests.push(callRequest(
      "active-preview-redeem",
      evidence.vault,
      ERC4626_INTERFACE.encodeFunctionData("previewRedeem", [
        evidence.sampleShares,
      ]),
    ));
    requests.push(Object.freeze({
      id: "active-redeem",
      required: false,
      kind: "effect-delta-simulation" as const,
      call: Object.freeze({
        caller: Object.freeze({
          kind: "verified-actor" as const,
          evidenceId: ERC4626_PROBE_ACTOR_EVIDENCE_ID,
        }),
        to: evidence.vault,
        data: ERC4626_INTERFACE.encodeFunctionData("redeem", [
          evidence.sampleShares,
          ERC4626_PROBE_ACTOR,
          ERC4626_PROBE_ACTOR,
        ]),
      }),
      overrideIntent: Object.freeze({
        caller: Object.freeze({
          kind: "verified-actor" as const,
          evidenceId: ERC4626_PROBE_ACTOR_EVIDENCE_ID,
        }),
        tokenBalances: Object.freeze([Object.freeze({
          token: evidence.vault,
          amount: evidence.sampleShares,
        })]),
      }),
      observe: Object.freeze([
        "return-data" as const,
        "revert-data" as const,
        "token-delta" as const,
        "total-supply-delta" as const,
        "logs" as const,
      ]),
    }));
  }
  return Object.freeze(requests);
}

function decodeActiveEvidence(
  base: Erc4626BaseEvidence,
  results: readonly AdapterRequestResult[],
): Erc4626ActiveEvidence {
  const assetCode = requireRuntimeCode(results, "active-asset-code");
  const assetBalanceSurface = balanceSurfaceOutcome(
    results,
    "active-asset-balance",
  );
  const shareBalanceSurface = balanceSurfaceOutcome(
    results,
    "active-share-balance",
  );
  const balanceSurfaces = [assetBalanceSurface, shareBalanceSurface];
  const erc20SurfacesValid = balanceSurfaces.every((outcome) =>
    outcome.status === "valid"
  );
  if (!balanceSurfaces.some((outcome) => outcome.status === "invalid")) {
    const unresolved = balanceSurfaces.find((outcome) =>
      outcome.status === "unresolved"
    );
    if (unresolved?.status === "unresolved") {
      throw new RequiredAdapterRequestError(unresolved.result);
    }
  }
  const roundTrip = decodeUint(
    ERC4626_INTERFACE,
    "previewRedeem",
    results,
    "active-roundtrip",
  );
  const roundTripSafe =
    roundTrip <= base.sampleAssets + tolerance(base.sampleAssets);
  const depositResult = results.find((result) => result.id === "active-deposit");
  if (depositResult === undefined) {
    throw new Error("ERC4626 active-deposit result is missing");
  }
  const deposit = depositResult.ok ? depositResult : null;
  const depositReturned = deposit?.completion === "returned";
  const depositAmountOut = depositReturned
    ? decodeSimulationUint("deposit", deposit!.data)
    : 0n;
  const depositVerified = roundTripSafe && depositReturned &&
    depositAmountOut === base.previewDeposit &&
    tokenDeltaAtLeast({
      result: deposit!,
      token: base.asset,
      account: ERC4626_PROBE_ACTOR,
      direction: "decrease",
      amount: base.sampleAssets,
    }) &&
    tokenDeltaAtLeast({
      result: deposit!,
      token: base.vault,
      account: ERC4626_PROBE_ACTOR,
      direction: "increase",
      amount: base.previewDeposit,
    }) &&
    totalSupplyDeltaAtLeast({
      result: deposit!,
      token: base.vault,
      direction: "increase",
      amount: base.previewDeposit,
    }) &&
    lifecycleEventMatches(
      deposit!,
      "Deposit",
      base,
      base.sampleAssets,
      base.previewDeposit,
    );

  const redeemResult = results.find((result) => result.id === "active-redeem");
  let redeemVerified = false;
  if (base.sampleShares > 0n && redeemResult?.ok) {
    const previewRedeem = decodeUint(
      ERC4626_INTERFACE,
      "previewRedeem",
      results,
      "active-preview-redeem",
    );
    const redeemAmountOut = redeemResult.completion === "returned"
      ? decodeSimulationUint("redeem", redeemResult.data)
      : 0n;
    redeemVerified = redeemResult.completion === "returned" &&
      previewRedeem > 0n && redeemAmountOut === previewRedeem &&
      tokenDeltaAtLeast({
        result: redeemResult,
        token: base.vault,
        account: ERC4626_PROBE_ACTOR,
        direction: "decrease",
        amount: base.sampleShares,
      }) &&
      tokenDeltaAtLeast({
        result: redeemResult,
        token: base.asset,
        account: ERC4626_PROBE_ACTOR,
        direction: "increase",
        amount: previewRedeem,
      }) &&
      totalSupplyDeltaAtLeast({
        result: redeemResult,
        token: base.vault,
        direction: "decrease",
        amount: base.sampleShares,
      }) &&
      lifecycleEventMatches(
        redeemResult,
        "Withdraw",
        base,
        previewRedeem,
        base.sampleShares,
      );
  }
  const unresolvedDirections = [depositResult, redeemResult]
    .filter((result): result is Extract<
      AdapterRequestResult,
      { readonly ok: false }
    > => result !== undefined && !result.ok)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (
    erc20SurfacesValid && !depositVerified && !redeemVerified &&
    unresolvedDirections.length > 0
  ) {
    throw new RequiredAdapterRequestError(unresolvedDirections[0]!);
  }
  return Object.freeze({
    ...base,
    phase: "active",
    assetCodeHash: ethers.keccak256(assetCode),
    erc20SurfacesValid,
    depositVerified,
    redeemVerified,
    behaviorProofHash: hashCanonical({
      vault: base.vault,
      asset: base.asset,
      roundTrip,
      erc20SurfacesValid,
      depositVerified,
      redeemVerified,
      directionOutcomes: Object.freeze(results
        .filter((result) =>
          result.id === "active-deposit" || result.id === "active-redeem"
        )
        .map((result) => ({
          id: result.id,
          status: result.ok ? "ok" : "failure",
          outcome: result.ok ? result.completion : result.failure,
        }))),
      resultEffects: results.filter((result) => result.ok).map((result) => ({
        id: result.id,
        completion: result.completion,
        effects: effectsProjection(result.effects),
      })),
    }),
  });
}

function declaredCallRequest(
  id: string,
  to: string,
  data: string,
): AdapterRequest {
  return Object.freeze({
    id,
    required: false,
    kind: "eth-call" as const,
    to: canonicalAddress(to),
    data,
    completion: "return-or-revert-data" as const,
  });
}

function balanceSurfaceOutcome(
  results: readonly AdapterRequestResult[],
  id: string,
):
  | { readonly status: "valid" }
  | { readonly status: "invalid" }
  | {
      readonly status: "unresolved";
      readonly result: Extract<AdapterRequestResult, { readonly ok: false }>;
    } {
  const result = results.find((candidate) => candidate.id === id);
  if (result === undefined) {
    throw new Error(`ERC4626 balance surface result ${id} is missing`);
  }
  if (!result.ok) {
    return Object.freeze({ status: "unresolved" as const, result });
  }
  if (result.completion !== "returned" || !/^0x[0-9a-fA-F]{64}$/.test(
    result.data,
  )) {
    return Object.freeze({ status: "invalid" as const });
  }
  try {
    ERC4626_ERC20_INTERFACE.decodeFunctionResult("balanceOf", result.data);
    return Object.freeze({ status: "valid" as const });
  } catch {
    return Object.freeze({ status: "invalid" as const });
  }
}

function decodeSimulationUint(
  functionName: "deposit" | "redeem",
  data: string,
): bigint {
  return BigInt(
    ERC4626_INTERFACE.decodeFunctionResult(functionName, data)[0],
  );
}

function lifecycleEventMatches(
  result: Extract<AdapterRequestResult, { readonly ok: true }>,
  eventName: "Deposit" | "Withdraw",
  base: Erc4626BaseEvidence,
  assets: bigint,
  shares: bigint,
): boolean {
  const topic = eventName === "Deposit"
    ? ERC4626_DEPOSIT_TOPIC
    : ERC4626_WITHDRAW_TOPIC;
  return (result.effects?.logs ?? []).some((log) => {
    if (
      !sameAddress(log.address, base.vault) ||
      log.topics[0]?.toLowerCase() !== topic
    ) {
      return false;
    }
    try {
      const parsed = ERC4626_INTERFACE.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      return parsed !== null &&
        BigInt(parsed.args.assets) === assets &&
        BigInt(parsed.args.shares) === shares;
    } catch {
      return false;
    }
  });
}
