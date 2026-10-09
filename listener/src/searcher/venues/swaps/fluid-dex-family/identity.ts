import type {
  IdentityDecision,
  IdentitySemantics,
  IdentityStepInput,
} from "../../adapter-family-plugin.js";
import type {
  AdapterRequest,
  AdapterRequestResult,
} from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { identityAssetRequestId, type IdentityAssetMetadata } from "../../../identity-asset-metadata.js";
import {
  canonicalAddress,
  decodeAddressResult,
  decodeDeclaredFluidDexQuote,
  decodeFluidDexConstants,
  fluidDexAsset,
  FLUID_DEX_ADDRESS_DEAD,
  FLUID_DEX_CONSTANTS_INTERFACE,
  FLUID_DEX_FACTORY_INTERFACE,
  FLUID_DEX_INTERFACE,
  lowerAddress,
  requireSuccessfulResult,
  sameAddress,
} from "./codec.js";
import {
  FLUID_DEX_FACTORY_LINEAGE_ID,
  FLUID_DEX_FAMILY_ID,
} from "./manifest.js";
import type {
  FluidDexCandidate,
  FluidDexIdentity,
  FluidDexIdentityEvidence,
} from "./types.js";

const CONSTANTS_ID = "pool-constants";
const POOL_CODE_ID = "pool-code";
const FACTORY_REVERSE_ID = "factory-reverse-dex";
const ZERO_TO_ONE_PROBE_ID = "active-quote-zero-to-one";
const ONE_TO_ZERO_PROBE_ID = "active-quote-one-to-zero";

export const fluidDexIdentity = {
  variants: [{
    id: "factory-child-active-quote",
    kind: "factory-child" as const,
    lineageId: FLUID_DEX_FACTORY_LINEAGE_ID,
    applies: () => true,
    assets(input: IdentityStepInput<FluidDexCandidate, unknown>) {
      const evidence = identityEvidence(input.evidence);
      return evidence?.phase === "constants"
        ? [fluidDexAsset("token0", evidence.token0), fluidDexAsset("token1", evidence.token1)] : [];
    },
    requirements(input: IdentityStepInput<FluidDexCandidate, unknown>) {
      const evidence = identityEvidence(input.evidence);
      return evidence?.phase === "reverse-binding"
        ? { transports: ["eth-call" as const], effects: ["revert-data" as const] }
        : { transports: ["eth-call" as const, "get-code" as const] };
    },
    buildRequests(input: IdentityStepInput<FluidDexCandidate, unknown>) {
      const evidence = identityEvidence(input.evidence);
      if (evidence === undefined) return constantsRequests(input.candidate);
      if (evidence.phase === "constants") return reverseBindingRequests(evidence);
      if (evidence.phase === "reverse-binding") {
        return activeQuoteRequests(evidence);
      }
      return [];
    },
    decode(input: {
      readonly step: IdentityStepInput<FluidDexCandidate, unknown>;
      readonly results: readonly AdapterRequestResult[];
      readonly assets?: readonly IdentityAssetMetadata[];
    }) {
      const prior = identityEvidence(input.step.evidence);
      if (prior === undefined) {
        return decodeConstants(input.step.candidate, input.results);
      }
      if (prior.phase === "constants") {
        return decodeReverseBinding(prior, input.results, input.assets);
      }
      return decodeActiveBehavior(prior, input.results);
    },
    decide(input: IdentityStepInput<FluidDexCandidate, unknown>) {
      return decideIdentity(identityEvidence(input.evidence));
    },
  }],
  identityKey: (identity) => lowerAddress(identity.subject),
} satisfies IdentitySemantics<FluidDexCandidate, FluidDexIdentity>;

function constantsRequests(candidate: FluidDexCandidate): readonly AdapterRequest[] {
  const pool = canonicalAddress(candidate.pool);
  return Object.freeze([
    Object.freeze({
      id: CONSTANTS_ID,
      kind: "eth-call" as const,
      to: pool,
      data: FLUID_DEX_CONSTANTS_INTERFACE.encodeFunctionData("constantsView"),
      completion: "return-data" as const,
    }),
    Object.freeze({
      id: POOL_CODE_ID,
      kind: "get-code" as const,
      address: pool,
    }),
  ]);
}

function reverseBindingRequests(
  evidence: Extract<FluidDexIdentityEvidence, { readonly phase: "constants" }>,
): readonly AdapterRequest[] {
  return Object.freeze([
    Object.freeze({
      id: FACTORY_REVERSE_ID,
      kind: "eth-call" as const,
      to: evidence.factory,
      data: FLUID_DEX_FACTORY_INTERFACE.encodeFunctionData(
        "getDexAddress",
        [evidence.dexId],
      ),
      completion: "return-data" as const,
    }),
  ]);
}

function activeQuoteRequests(
  evidence: Extract<FluidDexIdentityEvidence, { readonly phase: "reverse-binding" }>,
): readonly AdapterRequest[] {
  return Object.freeze([
    quoteRequest(
      ZERO_TO_ONE_PROBE_ID,
      evidence.pool,
      true,
      10n ** BigInt(assetDecimals(evidence.assets[0])),
    ),
    quoteRequest(
      ONE_TO_ZERO_PROBE_ID,
      evidence.pool,
      false,
      10n ** BigInt(assetDecimals(evidence.assets[1])),
    ),
  ]);
}

function quoteRequest(
  id: string,
  pool: string,
  swap0To1: boolean,
  amountIn: bigint,
): AdapterRequest {
  // The direct eth-call contract has no value field. Keep ADDRESS_DEAD's
  // declared-revert proof mandatory in BOTH directions; native zero-value
  // quote support requires historical evidence, not an execution fallback.
  return Object.freeze({
    id,
    kind: "eth-call" as const,
    to: pool,
    data: FLUID_DEX_INTERFACE.encodeFunctionData("swapIn", [
      swap0To1,
      amountIn,
      0n,
      FLUID_DEX_ADDRESS_DEAD,
    ]),
    completion: "return-or-revert-data" as const,
  });
}

function decodeConstants(
  candidate: FluidDexCandidate,
  results: readonly AdapterRequestResult[],
): FluidDexIdentityEvidence {
  const constantsResult = requireSuccessfulResult(results, CONSTANTS_ID);
  const codeResult = requireSuccessfulResult(results, POOL_CODE_ID);
  if (constantsResult.completion !== "returned") {
    throw new Error("fluid-dex constantsView unexpectedly reverted");
  }
  const constants = decodeFluidDexConstants(constantsResult.data);
  if (codeResult.data === "0x") {
    throw new Error("fluid-dex pool has no code");
  }
  return Object.freeze({
    phase: "constants" as const,
    pool: canonicalAddress(candidate.pool),
    ...constants,
  });
}

function decodeReverseBinding(
  prior: Extract<FluidDexIdentityEvidence, { readonly phase: "constants" }>,
  results: readonly AdapterRequestResult[],
  metadata: readonly IdentityAssetMetadata[] | undefined,
): FluidDexIdentityEvidence {
  const reverse = requireSuccessfulResult(results, FACTORY_REVERSE_ID);
  if (reverse.completion !== "returned") {
    throw new Error("fluid-dex reverse identity unexpectedly reverted");
  }
  if (!metadata || metadata.length !== 2) throw new Error("fluid-dex asset metadata missing or ambiguous");
  const assets = ["token0", "token1"].map((key, index) => {
    const raw = index === 0 ? prior.token0 : prior.token1;
    const declaration = fluidDexAsset(key, raw);
    const matches = metadata.filter(asset => asset.key === key);
    const asset = matches[0];
    if (matches.length !== 1 || asset.kind !== declaration.kind ||
        (asset.kind === "erc20" && !sameAddress(asset.token, raw))) {
      throw new Error("fluid-dex asset metadata binding mismatch");
    }
    // No HasCode fiction for native. Empty ERC20 code is retained as actual
    // negative code evidence; central supplied null decimals are not invented.
    if (asset.kind === "native" || asset.code !== "0x") assetDecimals(asset);
    return Object.freeze({ ...asset });
  }) as [IdentityAssetMetadata, IdentityAssetMetadata];
  if (sameAddress(assets[0].token, assets[1].token)) {
    throw new Error("fluid-dex asset graph mapping conflict");
  }
  return Object.freeze({
    ...prior,
    phase: "reverse-binding" as const,
    assets: Object.freeze(assets),
    reverseDex: decodeAddressResult(reverse.data, "getDexAddress"),
    poolHasCode: true,
  });
}

function assetDecimals(asset: IdentityAssetMetadata): number {
  const decimals = asset.decimals;
  if (decimals === null || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36 ||
      (asset.kind === "native" && decimals !== 18)) {
    throw new Error("fluid-dex token returned invalid decimals metadata");
  }
  return decimals;
}

function decodeActiveBehavior(
  prior: FluidDexIdentityEvidence,
  results: readonly AdapterRequestResult[],
): FluidDexIdentityEvidence {
  if (prior.phase !== "reverse-binding") {
    throw new Error("fluid-dex active behavior proof already completed");
  }
  const zeroToOne = requireSuccessfulResult(results, ZERO_TO_ONE_PROBE_ID);
  const oneToZero = requireSuccessfulResult(results, ONE_TO_ZERO_PROBE_ID);
  return Object.freeze({
    phase: "active-behavior" as const,
    binding: prior,
    zeroToOneAmountOut: decodeDeclaredFluidDexQuote(zeroToOne),
    oneToZeroAmountOut: decodeDeclaredFluidDexQuote(oneToZero),
  });
}

function decideIdentity(
  evidence: FluidDexIdentityEvidence | undefined,
): IdentityDecision<FluidDexIdentity> {
  if (evidence === undefined || evidence.phase === "constants") {
    return { status: "continue" };
  }
  if (evidence.phase === "reverse-binding") {
    if (!sameAddress(evidence.reverseDex, evidence.pool)) {
      return {
        status: "chain-proven-rejected",
        reasonCode: "factory_reverse_binding_failed",
        evidenceRequestIds: [FACTORY_REVERSE_ID],
      };
    }
    if (
      !evidence.poolHasCode ||
      evidence.assets.some(asset => asset.kind === "erc20" && asset.code === "0x")
    ) {
      return {
        status: "chain-proven-rejected",
        reasonCode: "fluid_dex_code_binding_failed",
        evidenceRequestIds: [POOL_CODE_ID, ...evidence.assets.filter(asset => asset.kind === "erc20")
          .map(asset => identityAssetRequestId(asset.key, "code"))],
      };
    }
    return { status: "continue" };
  }
  if (
    evidence.zeroToOneAmountOut === null ||
    evidence.oneToZeroAmountOut === null
  ) {
    // Each direction must supply its declared quote proof at the fixed cutoff.
    return {
      status: "chain-proven-rejected",
      reasonCode: "bidirectional_active_quote_failed",
      evidenceRequestIds: [ZERO_TO_ONE_PROBE_ID, ONE_TO_ZERO_PROBE_ID],
    };
  }
  const binding = evidence.binding;
  const factoryBinding = Object.freeze({
    factory: binding.factory,
    dexId: binding.dexId,
    reverseDex: binding.reverseDex,
  });
  const quoteBinding = Object.freeze({
    target: binding.pool,
    recipient: FLUID_DEX_ADDRESS_DEAD,
    completion: "return-or-revert-data" as const,
    successEncoding: "FluidDexSwapResult(uint256)-revert" as const,
  });
  const evidenceHash = hashCanonical({
    pool: binding.pool,
    rawToken0: binding.token0,
    rawToken1: binding.token1,
    token0: binding.assets[0].token,
    token1: binding.assets[1].token,
    token0Decimals: assetDecimals(binding.assets[0]),
    token1Decimals: assetDecimals(binding.assets[1]),
    factoryBinding,
    quoteBinding,
    activeQuotes: {
      zeroToOne: evidence.zeroToOneAmountOut,
      oneToZero: evidence.oneToZeroAmountOut,
    },
  });
  return {
    status: "verified",
    identity: Object.freeze({
      familyId: FLUID_DEX_FAMILY_ID,
      lineageId: FLUID_DEX_FACTORY_LINEAGE_ID,
      subject: binding.pool,
      provenance: Object.freeze([Object.freeze({
        kind: "fluid-dex-factory-reverse-active-quote",
        subject: binding.factory,
        evidenceHash,
      })]),
      facts: Object.freeze({
        pool: binding.pool,
        rawToken0: binding.token0,
        rawToken1: binding.token1,
        token0: binding.assets[0].token,
        token1: binding.assets[1].token,
        token0Decimals: assetDecimals(binding.assets[0]),
        token1Decimals: assetDecimals(binding.assets[1]),
        factoryBinding,
        quoteBinding,
      }),
    }),
  };
}

function identityEvidence(value: unknown): FluidDexIdentityEvidence | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value !== "object" ||
    !Object.hasOwn(value, "phase") ||
    !new Set(["constants", "reverse-binding", "active-behavior"]).has(
      String((value as { readonly phase?: unknown }).phase),
    )
  ) {
    throw new Error("fluid-dex identity received malformed evidence");
  }
  return value as FluidDexIdentityEvidence;
}
