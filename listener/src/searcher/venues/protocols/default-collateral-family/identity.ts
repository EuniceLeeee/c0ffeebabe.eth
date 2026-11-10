import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import { RequiredAdapterRequestError } from "../../adapter-request-failure.js";
import type {
  AdapterRequest,
  AdapterRequestResult,
  CanonicalSource,
} from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  assertSameSource,
  assertSource,
  canonicalAddress,
  codeRequest,
  decodeAddress,
  decodeUint,
  lowerAddress,
  requireRuntimeCode,
  sameAddress,
} from "../standard-family/common.js";
import {
  DEFAULT_COLLATERAL_BEHAVIOR_SAMPLE,
  DEFAULT_COLLATERAL_DECIMALS,
  DEFAULT_COLLATERAL_ERC20_INTERFACE,
  DEFAULT_COLLATERAL_IMPLEMENTATION_CODE_HASH,
  DEFAULT_COLLATERAL_INTERFACE,
  DEFAULT_COLLATERAL_PROBE_RECEIVER,
  DEFAULT_COLLATERAL_ASSET_CODE_HASH,
  DEFAULT_COLLATERAL_SHARE_CODE_HASH,
  DEFAULT_COLLATERAL_TRANSFER_TOPIC,
  DEFAULT_COLLATERAL_WITHDRAW_TOPIC,
  declaredCallRequest,
  eip1167Implementation,
} from "./codec.js";
import {
  DEFAULT_COLLATERAL_FAMILY_ID,
  DEFAULT_COLLATERAL_LINEAGE_ID,
} from "./manifest.js";
import type {
  DefaultCollateralActiveEvidence,
  DefaultCollateralBaseEvidence,
  DefaultCollateralCandidate,
  DefaultCollateralIdentity,
  DefaultCollateralIdentityEvidence,
  DefaultCollateralSurfaceEvidence,
} from "./types.js";

const CALLER = Object.freeze({ kind: "executor" as const });
const ZERO_TOPIC = `0x${"0".repeat(64)}`;

type Proof = DefaultCollateralIdentityEvidence;

type FailureReason = {
  readonly reasonCode: string;
  readonly evidenceRequestIds: readonly string[];
};

function padded(address: string): string {
  return `0x${"0".repeat(24)}${canonicalAddress(address).slice(2)}`.toLowerCase();
}

function shape(
  results: readonly AdapterRequestResult[],
  id: string,
): "returned" | "reverted" | "missing" {
  const result = results.find((candidate) => candidate.id === id);
  if (result === undefined || !result.ok) return "missing";
  return result.completion === "returned" ? "returned" : "reverted";
}

function emptyAssetHash(): string {
  return hashCanonical({ asset: ethers.ZeroAddress });
}

/**
 * Identity for the verified DefaultCollateral share-vault implementation.
 *
 * base:   45-byte EIP-1167 clone shape + embedded implementation, then the
 *         proxy-visible asset()/decimals()/totalSupply() facts.
 * surface: the implementation runtime code hash and the asset runtime code
 *         hash pinned at the source block, plus the vault asset backing read.
 * active:  same-state effect-delta proof in an impersonated call frame. The
 *         probe deals exactly one share sample to the executor, calls
 *         withdraw(probeReceiver, shares) and requires the vault totalSupply
 *         to fall by exactly the sample, the probe receiver to gain exactly
 *         the sample, and the vault's own Transfer/Withdraw logs to report the
 *         same amount. Any other delta refuses admission instead of claiming a
 *         rate the implementation did not exhibit.
 */
export const defaultCollateralIdentity = {
  memoReuse: "recheck-identity" as const,
  variants: [{
    id: "default-collateral-eip1167-one-to-one",
    kind: "standalone-contract" as const,
    lineageId: DEFAULT_COLLATERAL_LINEAGE_ID,
    applies: (candidate) =>
      candidate.candidateKind === "default-collateral-share-vault",
    requirements: ({ evidence }) => {
      const proof = evidence as Proof | undefined;
      // base round: clone/surface shape reads; surface round: implementation
      // and asset code + backing reads; active round: one effect simulation.
      if (proof === undefined || proof.phase === "base") {
        return { transports: ["get-code" as const, "eth-call" as const] };
      }
      return {
        transports: ["effect-delta-simulation" as const],
        caller: "executor" as const,
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
      const proof = evidence as Proof | undefined;
      if (proof === undefined) return baseRequests(candidate.vault);
      if (proof.phase === "base") return surfaceRequests(proof);
      if (proof.phase === "surface") return activeRequests(proof);
      return Object.freeze([]);
    },
    decode({ step, results }) {
      const prior = step.evidence as Proof | undefined;
      if (prior === undefined) {
        return decodeBase(canonicalAddress(step.candidate.vault), results);
      }
      for (const result of results) {
        if (result.ok) assertSource(result.source, prior.source);
      }
      if (prior.phase === "base") return decodeSurface(prior, results);
      if (prior.phase === "surface") return decodeActive(prior, results);
      throw new Error("default-collateral identity reached an unexpected phase");
    },
    decide({ candidate, evidence }) {
      const proof = evidence as Proof | undefined;
      if (proof === undefined) return { status: "continue" as const };
      if (proof.phase === "base") {
        const failure = baseFailure(proof);
        if (failure !== undefined) {
          return {
            status: "chain-proven-rejected" as const,
            reasonCode: failure.reasonCode,
            evidenceRequestIds: failure.evidenceRequestIds,
          };
        }
        return { status: "continue" as const };
      }
      if (proof.phase === "surface") {
        const failure = surfaceFailure(proof);
        if (failure !== undefined) {
          return {
            status: "chain-proven-rejected" as const,
            reasonCode: failure.reasonCode,
            evidenceRequestIds: failure.evidenceRequestIds,
          };
        }
        if (proof.backing === 0n) {
          return {
            status: "retryable" as const,
            reasonCode: "default_collateral_backing_unavailable",
          };
        }
        if (!proof.invariantProven) {
          return {
            status: "retryable" as const,
            reasonCode: "default_collateral_backing_not_one_to_one",
          };
        }
        return { status: "continue" as const };
      }
      if (!proof.behaviorValid) {
        return {
          status: "retryable" as const,
          reasonCode: "default_collateral_withdraw_behavior_not_proven",
        };
      }
      if (!proof.invariantProven) {
        return {
          status: "retryable" as const,
          reasonCode: "default_collateral_backing_not_one_to_one",
        };
      }
      return {
        status: "verified" as const,
        identity: Object.freeze({
          familyId: DEFAULT_COLLATERAL_FAMILY_ID,
          lineageId: DEFAULT_COLLATERAL_LINEAGE_ID,
          subject: canonicalAddress(candidate.vault),
          provenance: Object.freeze([Object.freeze({
            kind: "default-collateral-eip1167-one-to-one-proof",
            subject: canonicalAddress(candidate.vault),
            evidenceHash: proof.behaviorProofHash,
          })]),
          vault: canonicalAddress(proof.vault),
          share: canonicalAddress(proof.vault),
          asset: canonicalAddress(proof.asset),
          implementation: canonicalAddress(proof.implementation),
          shareCodeHash: proof.shareCodeHash.toLowerCase(),
          implementationCodeHash: proof.implementationCodeHash.toLowerCase(),
          assetCodeHash: proof.assetCodeHash.toLowerCase(),
          decimals: proof.decimals,
          oneToOne: proof.behaviorValid && proof.invariantProven,
        }),
      };
    },
  }],
  identityKey: (identity) => lowerAddress(identity.subject),
} satisfies IdentitySemantics<
  DefaultCollateralCandidate,
  DefaultCollateralIdentity
>;

function baseFailure(proof: DefaultCollateralBaseEvidence): FailureReason | undefined {
  if (!proof.shareIsClone) {
    return {
      reasonCode: "default_collateral_not_eip1167_clone",
      evidenceRequestIds: ["base-share-code"],
    };
  }
  return factsFailure(proof);
}

function factsFailure(proof: {
  readonly vault: string;
  readonly asset: string;
  readonly decimals: bigint;
  readonly totalSupply: bigint;
}): FailureReason | undefined {
  if (proof.asset === ethers.ZeroAddress) {
    return {
      reasonCode: "default_collateral_asset_unavailable",
      evidenceRequestIds: ["base-asset"],
    };
  }
  if (sameAddress(proof.asset, proof.vault)) {
    return {
      reasonCode: "default_collateral_asset_aliases_vault",
      evidenceRequestIds: ["base-asset"],
    };
  }
  if (proof.decimals !== DEFAULT_COLLATERAL_DECIMALS) {
    return {
      reasonCode: "default_collateral_decimals_mismatch",
      evidenceRequestIds: ["base-decimals"],
    };
  }
  if (proof.totalSupply === 0n) {
    return {
      reasonCode: "default_collateral_supply_empty",
      evidenceRequestIds: ["base-total-supply"],
    };
  }
  return undefined;
}

function surfaceFailure(
  proof: DefaultCollateralSurfaceEvidence,
): FailureReason | undefined {
  const failure = factsFailure(proof);
  if (failure !== undefined) return failure;
  if (
    proof.implementationCodeHash.toLowerCase() !==
    DEFAULT_COLLATERAL_IMPLEMENTATION_CODE_HASH
  ) {
    return {
      reasonCode: "default_collateral_implementation_code_mismatch",
      evidenceRequestIds: ["surface-implementation-code"],
    };
  }
  if (proof.shareCodeHash.toLowerCase() !== DEFAULT_COLLATERAL_SHARE_CODE_HASH) {
    return {
      reasonCode: "default_collateral_share_code_mismatch",
      evidenceRequestIds: ["base-share-code"],
    };
  }
  if (proof.assetCodeHash.toLowerCase() !== DEFAULT_COLLATERAL_ASSET_CODE_HASH) {
    return {
      reasonCode: "default_collateral_asset_code_mismatch",
      evidenceRequestIds: ["surface-asset-code"],
    };
  }
  return undefined;
}

function baseRequests(vault: string): readonly AdapterRequest[] {
  const target = canonicalAddress(vault);
  return Object.freeze([
    codeRequest("base-share-code", target),
    declaredCallRequest(
      "base-asset",
      target,
      DEFAULT_COLLATERAL_INTERFACE.encodeFunctionData("asset"),
    ),
    declaredCallRequest(
      "base-decimals",
      target,
      DEFAULT_COLLATERAL_INTERFACE.encodeFunctionData("decimals"),
    ),
    declaredCallRequest(
      "base-total-supply",
      target,
      DEFAULT_COLLATERAL_INTERFACE.encodeFunctionData("totalSupply"),
    ),
  ]);
}

function decodeBase(
  vault: string,
  results: readonly AdapterRequestResult[],
): DefaultCollateralBaseEvidence {
  const code = requireRuntimeCode(results, "base-share-code");
  const shareCodeHash = ethers.keccak256(code).toLowerCase();
  const successful = results.filter((result) => result.ok);
  const source: CanonicalSource = assertSameSource(successful);
  let implementation = ethers.ZeroAddress;
  let shareIsClone = false;
  try {
    implementation = eip1167Implementation(code);
    shareIsClone = true;
  } catch {
    // Family-declared negative evidence: a non-clone runtime is not this
    // Family's vault shape. decide() turns it into a chain-proven rejection.
  }
  if (!shareIsClone) {
    return Object.freeze({
      phase: "base" as const,
      source,
      vault: canonicalAddress(vault),
      shareCodeHash,
      implementation: ethers.ZeroAddress,
      asset: ethers.ZeroAddress,
      assetCodeHash: emptyAssetHash(),
      decimals: 0n,
      totalSupply: 0n,
      shareIsClone: false,
      baseValid: false,
      evidenceRequestIds: Object.freeze(["base-share-code"]),
    });
  }
  const assetShape = shape(results, "base-asset");
  if (assetShape !== "returned") {
    return invalidBase(vault, source, shareCodeHash, implementation, [
      "base-asset",
      "base-decimals",
      "base-total-supply",
    ]);
  }
  const decimalsShape = shape(results, "base-decimals");
  if (decimalsShape !== "returned") {
    return invalidBase(vault, source, shareCodeHash, implementation, [
      "base-decimals",
    ]);
  }
  const supplyShape = shape(results, "base-total-supply");
  if (supplyShape !== "returned") {
    return invalidBase(vault, source, shareCodeHash, implementation, [
      "base-total-supply",
    ]);
  }
  const asset = decodeAddress(
    DEFAULT_COLLATERAL_INTERFACE,
    "asset",
    results,
    "base-asset",
  );
  const decimals = decodeUint(
    DEFAULT_COLLATERAL_INTERFACE,
    "decimals",
    results,
    "base-decimals",
  );
  const totalSupply = decodeUint(
    DEFAULT_COLLATERAL_INTERFACE,
    "totalSupply",
    results,
    "base-total-supply",
  );
  const baseValid = decimals === DEFAULT_COLLATERAL_DECIMALS &&
    totalSupply > 0n &&
    !sameAddress(asset, ethers.ZeroAddress) &&
    !sameAddress(asset, vault);
  return Object.freeze({
    phase: "base" as const,
    source,
    vault: canonicalAddress(vault),
    shareCodeHash,
    implementation,
    asset,
    assetCodeHash: emptyAssetHash(),
    decimals,
    totalSupply,
    shareIsClone: true,
    baseValid,
    ...(baseValid ? {} : {
      evidenceRequestIds: Object.freeze(["base-asset"]),
    }),
  });
}

function invalidBase(
  vault: string,
  source: CanonicalSource,
  shareCodeHash: string,
  implementation: string,
  evidenceRequestIds: readonly string[],
): DefaultCollateralBaseEvidence {
  return Object.freeze({
    phase: "base" as const,
    source,
    vault: canonicalAddress(vault),
    shareCodeHash,
    implementation,
    asset: ethers.ZeroAddress,
    assetCodeHash: emptyAssetHash(),
    decimals: 0n,
    totalSupply: 0n,
    shareIsClone: true,
    baseValid: false,
    evidenceRequestIds: Object.freeze([...evidenceRequestIds]),
  });
}

function surfaceRequests(
  evidence: DefaultCollateralBaseEvidence,
): readonly AdapterRequest[] {
  const requests: AdapterRequest[] = [
    codeRequest(
      "surface-implementation-code",
      canonicalAddress(evidence.implementation),
    ),
    codeRequest("surface-asset-code", canonicalAddress(evidence.asset)),
    declaredCallRequest(
      "surface-backing",
      evidence.asset,
      DEFAULT_COLLATERAL_ERC20_INTERFACE.encodeFunctionData("balanceOf", [
        evidence.vault,
      ]),
    ),
  ];
  return Object.freeze(requests);
}

function decodeSurface(
  prior: DefaultCollateralBaseEvidence,
  results: readonly AdapterRequestResult[],
): DefaultCollateralSurfaceEvidence {
  const implementationCodeHash = ethers.keccak256(
    requireRuntimeCode(results, "surface-implementation-code"),
  ).toLowerCase();
  const assetCodeHash = ethers.keccak256(
    requireRuntimeCode(results, "surface-asset-code"),
  ).toLowerCase();
  const backingShape = shape(results, "surface-backing");
  const backing = backingShape === "returned"
    ? decodeUint(
      DEFAULT_COLLATERAL_ERC20_INTERFACE,
      "balanceOf",
      results,
      "surface-backing",
    )
    : 0n;
  const surfaceValid = backingShape === "returned" &&
    prior.baseValid &&
    implementationCodeHash === DEFAULT_COLLATERAL_IMPLEMENTATION_CODE_HASH &&
    assetCodeHash === DEFAULT_COLLATERAL_ASSET_CODE_HASH &&
    backing > 0n;
  return Object.freeze({
    ...prior,
    phase: "surface" as const,
    implementationCodeHash,
    assetCodeHash,
    backing,
    surfaceValid,
    invariantProven: surfaceValid && backing === prior.totalSupply,
  });
}

function behaviorSample(evidence: DefaultCollateralSurfaceEvidence): bigint {
  if (evidence.totalSupply <= 0n) return 0n;
  const sample = DEFAULT_COLLATERAL_BEHAVIOR_SAMPLE < evidence.totalSupply
    ? DEFAULT_COLLATERAL_BEHAVIOR_SAMPLE
    : evidence.totalSupply / 1000n;
  return sample > 0n ? sample : 0n;
}

function activeRequests(
  evidence: DefaultCollateralSurfaceEvidence,
): readonly AdapterRequest[] {
  const sample = behaviorSample(evidence);
  if (sample === 0n) return Object.freeze([]);
  return Object.freeze([Object.freeze({
    id: "active-withdraw",
    required: false,
    kind: "effect-delta-simulation" as const,
    call: Object.freeze({
      caller: CALLER,
      executionMode: "impersonated-call-frame" as const,
      to: canonicalAddress(evidence.vault),
      data: DEFAULT_COLLATERAL_INTERFACE.encodeFunctionData("withdraw", [
        canonicalAddress(DEFAULT_COLLATERAL_PROBE_RECEIVER),
        sample,
      ]),
    }),
    overrideIntent: Object.freeze({
      caller: CALLER,
      tokenBalances: Object.freeze([Object.freeze({
        token: canonicalAddress(evidence.vault),
        amount: sample,
      })]),
    }),
    observeTokenBalances: Object.freeze([
      Object.freeze({
        token: canonicalAddress(evidence.asset),
        account: canonicalAddress(DEFAULT_COLLATERAL_PROBE_RECEIVER),
      }),
      Object.freeze({
        token: canonicalAddress(evidence.asset),
        account: CALLER,
      }),
    ]),
    observe: Object.freeze([
      "return-data" as const,
      "revert-data" as const,
      "token-delta" as const,
      "total-supply-delta" as const,
      "logs" as const,
    ]),
  })]);
}

function decodeActive(
  prior: DefaultCollateralSurfaceEvidence,
  results: readonly AdapterRequestResult[],
): DefaultCollateralActiveEvidence {
  const sample = behaviorSample(prior);
  const result = results.find((candidate) => candidate.id === "active-withdraw");
  if (sample > 0n && result === undefined) {
    throw new Error("default-collateral behavior result is missing");
  }
  if (result !== undefined && !result.ok) {
    throw new RequiredAdapterRequestError(result);
  }
  if (result !== undefined) {
    assertSource(
      (result as Extract<AdapterRequestResult, { readonly ok: true }>).source,
      prior.source,
    );
  }
  let shareBurn = 0n;
  let assetReceipt = 0n;
  let supplyBurn = 0n;
  let behaviorValid = false;
  if (sample > 0n && result !== undefined && result.ok) {
    const deltas = result.effects?.tokenDeltas ?? [];
    const receipt = deltas.find((delta) =>
      sameAddress(delta.token, prior.asset) &&
      sameAddress(delta.account, DEFAULT_COLLATERAL_PROBE_RECEIVER)
    );
    assetReceipt = receipt?.delta ?? 0n;
    const supplies = result.effects?.totalSupplyDeltas ?? [];
    const supply = supplies.find((delta) =>
      sameAddress(delta.token, prior.vault)
    );
    supplyBurn = supply === undefined ? 0n : -supply.delta;
    shareBurn = supplyBurn;
    behaviorValid = result.completion === "returned" &&
      sample === assetReceipt &&
      sample === supplyBurn &&
      burnedShareLogs(result, prior, sample) &&
      withdrawEventLogs(result, prior, sample);
  }
  return Object.freeze({
    ...prior,
    phase: "active" as const,
    sampleShares: sample,
    shareBurn,
    assetReceipt,
    supplyBurn,
    behaviorValid,
    behaviorProofHash: hashCanonical({
      phase: "default-collateral-eip1167-one-to-one-proof",
      vault: lowerAddress(prior.vault),
      shareCodeHash: prior.shareCodeHash,
      implementation: lowerAddress(prior.implementation),
      implementationCodeHash: prior.implementationCodeHash,
      asset: lowerAddress(prior.asset),
      assetCodeHash: prior.assetCodeHash,
      decimals: prior.decimals,
      totalSupply: prior.totalSupply,
      backing: prior.backing,
      invariantProven: prior.invariantProven,
      sample,
      shareBurn,
      assetReceipt,
      supplyBurn,
      behaviorValid,
      source: { ...prior.source },
    }),
  });
}

function burnedShareLogs(
  result: Extract<AdapterRequestResult, { readonly ok: true }>,
  prior: DefaultCollateralSurfaceEvidence,
  sample: bigint,
): boolean {
  return (result.effects?.logs ?? []).some((log) => {
    if (
      !sameAddress(log.address, prior.vault) ||
      log.topics[0]?.toLowerCase() !== DEFAULT_COLLATERAL_TRANSFER_TOPIC ||
      log.topics.length !== 3 ||
      log.topics[2]?.toLowerCase() !== ZERO_TOPIC
    ) {
      return false;
    }
    try {
      const parsed = DEFAULT_COLLATERAL_INTERFACE.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      return parsed !== null && BigInt(parsed.args.value) === sample;
    } catch {
      return false;
    }
  });
}

function withdrawEventLogs(
  result: Extract<AdapterRequestResult, { readonly ok: true }>,
  prior: DefaultCollateralSurfaceEvidence,
  sample: bigint,
): boolean {
  const receiverTopic = padded(DEFAULT_COLLATERAL_PROBE_RECEIVER);
  return (result.effects?.logs ?? []).some((log) => {
    if (
      !sameAddress(log.address, prior.vault) ||
      log.topics[0]?.toLowerCase() !== DEFAULT_COLLATERAL_WITHDRAW_TOPIC ||
      log.topics.length !== 3 ||
      !log.topics.slice(1).some((topic) => topic.toLowerCase() === receiverTopic)
    ) {
      return false;
    }
    try {
      const parsed = DEFAULT_COLLATERAL_INTERFACE.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      return parsed !== null && BigInt(parsed.args.amount) === sample;
    } catch {
      return false;
    }
  });
}
