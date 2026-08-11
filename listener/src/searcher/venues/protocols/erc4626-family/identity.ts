import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type {
  AdapterRequest,
  AdapterRequestResult,
} from "../../adapter-request-program.js";
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
  successfulResult,
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
      const successful = results.map((result) => {
        if (!result.ok) {
          throw new Error(`ERC4626 identity unresolved: ${result.failure}`);
        }
        return result;
      });
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
              status: "rejected" as const,
              reason: "erc4626_standard_views_failed",
            };
      }
      if (!proof.depositVerified && !proof.redeemVerified) {
        return {
          status: "rejected" as const,
          reason: "erc4626_execution_surfaces_failed",
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

function decodeBaseEvidence(
  vault: string,
  results: readonly AdapterRequestResult[],
): Erc4626BaseEvidence {
  const code = requireRuntimeCode(results, "base-vault-code");
  const asset = decodeAddress(
    ERC4626_INTERFACE,
    "asset",
    results,
    "base-asset",
  );
  if (sameAddress(asset, ethers.ZeroAddress) || sameAddress(asset, vault)) {
    throw new Error("ERC4626 asset relation is invalid");
  }
  const assetCodeResult = results.find((result) =>
    result.id === "base-asset-code"
  );
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
    callRequest(
      "active-roundtrip",
      evidence.vault,
      ERC4626_INTERFACE.encodeFunctionData("previewRedeem", [
        evidence.previewDeposit,
      ]),
    ),
    Object.freeze({
      id: "active-deposit",
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
  const roundTrip = decodeUint(
    ERC4626_INTERFACE,
    "previewRedeem",
    results,
    "active-roundtrip",
  );
  const roundTripSafe =
    roundTrip <= base.sampleAssets + tolerance(base.sampleAssets);
  const deposit = successfulResult(results, "active-deposit");
  const depositReturned = deposit.completion === "returned";
  const depositAmountOut = depositReturned
    ? decodeSimulationUint("deposit", deposit.data)
    : 0n;
  const depositVerified = roundTripSafe && depositReturned &&
    depositAmountOut === base.previewDeposit &&
    tokenDeltaAtLeast({
      result: deposit,
      token: base.asset,
      account: ERC4626_PROBE_ACTOR,
      direction: "decrease",
      amount: base.sampleAssets,
    }) &&
    tokenDeltaAtLeast({
      result: deposit,
      token: base.vault,
      account: ERC4626_PROBE_ACTOR,
      direction: "increase",
      amount: base.previewDeposit,
    }) &&
    totalSupplyDeltaAtLeast({
      result: deposit,
      token: base.vault,
      direction: "increase",
      amount: base.previewDeposit,
    }) &&
    lifecycleEventMatches(
      deposit,
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
  return Object.freeze({
    ...base,
    phase: "active",
    assetCodeHash: ethers.keccak256(assetCode),
    depositVerified,
    redeemVerified,
    behaviorProofHash: hashCanonical({
      vault: base.vault,
      asset: base.asset,
      roundTrip,
      depositVerified,
      redeemVerified,
      resultEffects: results.filter((result) => result.ok).map((result) => ({
        id: result.id,
        completion: result.completion,
        effects: effectsProjection(result.effects),
      })),
    }),
  });
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
