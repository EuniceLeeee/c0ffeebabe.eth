import { ethers } from "ethers";
import {
  localZeroExactMethod,
  type ExactQuoteInput,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import {
  BLOCKSCAN_MULTICALL3,
  blockScanMulticallIface,
  encodeMulticall,
  type MulticallItem,
} from "../blockscan-state-shared.js";
import { UNIV4_QUOTER_INTERFACE } from "../univ4-abi.js";
import {
  poolKeyFingerprint,
  poolKeyProjection,
  requireSuccessfulResult,
  sameAddress,
} from "./codec.js";
import {
  requireAngstromRuntimeEvidence,
} from "./evidence.js";
import { hashCanonical, type CanonicalValue } from "../../canonical-value.js";
import { angstromV4StaticBindingProjection } from "./binding.js";
import type {
  AngstromV4Descriptor,
  AngstromV4ExactEvidence,
  AngstromV4SignedExactEvidence,
  AngstromV4Route,
} from "./types.js";

const EXACT_QUOTE_REQUEST_ID = "exact-angstrom-v4-quotes";
const UINT128_MAX = (1n << 128n) - 1n;
type AngstromExactInput = ExactQuoteInput<AngstromV4Descriptor, AngstromV4Route>;

const angstromV4RequestProgram: ExactRequestProgram<
  AngstromV4Descriptor,
  AngstromV4Route,
  AngstromV4ExactEvidence
> = {
  requirements: () => ({ transports: ["eth-call"] }),
  buildRequests(input) {
    assertRoute(input.descriptor, input.route);
    assertAmount(input.amountIn);
    const evidence = requireAngstromRuntimeEvidence(input);
    if (input.amountIn === 0n) return [];
    return [Object.freeze({
      id: EXACT_QUOTE_REQUEST_ID,
      kind: "eth-call" as const,
      to: BLOCKSCAN_MULTICALL3,
      data: encodeMulticall(quoteItems(input, evidence.attestations)),
      completion: "return-data" as const,
    })];
  },
  decode({ programInput, initialResults }) {
    const results = initialResults;
    assertRoute(programInput.descriptor, programInput.route);
    assertAmount(programInput.amountIn);
    const runtime = requireAngstromRuntimeEvidence(programInput);
    if (programInput.amountIn === 0n) return zeroQuote(programInput, runtime);
    const result = requireSuccessfulResult(results, EXACT_QUOTE_REQUEST_ID);
    assertSource(result.source, programInput.source);
    const items = quoteItems(programInput, runtime.attestations);
    const aggregate = blockScanMulticallIface.decodeFunctionResult(
      "aggregate3",
      result.data,
    )[0] as readonly { readonly success: boolean; readonly returnData: string }[];
    if (aggregate.length !== items.length) {
      throw new Error(
        `angstrom-v4 exact multicall returned ${aggregate.length}/${items.length}`,
      );
    }
    for (const item of aggregate) {
      if (!item.success || item.returnData === "0x") continue;
      try {
        const amountOut = BigInt(
          UNIV4_QUOTER_INTERFACE.decodeFunctionResult(
            "quoteExactInputSingle",
            item.returnData,
          )[0],
        );
        if (amountOut > 0n) {
          return Object.freeze({
            amountOut,
            evidence: exactEvidence(programInput, runtime, amountOut),
          });
        }
      } catch {
        // A malformed/foreign proof result cannot satisfy this Family; try
        // the next independently verified attestation in the bounded bundle.
      }
    }
    throw new Error(
      "angstrom-v4 no verified attestation matched the current source",
    );
  },
};

const sourceUnlockedProgram: ExactRequestProgram<
  AngstromV4Descriptor, AngstromV4Route, AngstromV4ExactEvidence
> = {
  requirements: () => ({ transports: ["eth-call"] }),
  buildRequests(input) {
    assertUnsignedInput(input);
    if (input.amountIn === 0n) return [];
    return [Object.freeze({
      id: EXACT_QUOTE_REQUEST_ID,
      kind: "eth-call" as const,
      to: BLOCKSCAN_MULTICALL3,
      completion: "return-data" as const,
      data: encodeMulticall([{
        label: "angstrom-v4-source-unlocked",
        target: input.descriptor.immutableBinding.quoter,
        callData: UNIV4_QUOTER_INTERFACE.encodeFunctionData("quoteExactInputSingle", [{
          poolKey: input.descriptor.poolKey,
          zeroForOne: input.route.direction === "zero-for-one",
          exactAmount: input.amountIn,
          hookData: "0x",
        }]),
        allowFailure: true,
      }]),
    })];
  },
  decode({ programInput: input, initialResults }) {
    assertUnsignedInput(input);
    if (input.amountIn === 0n) return unsignedQuote(input, 0n);
    if (initialResults.length !== 1) throw new Error("angstrom-v4 source-unlocked requires one quote result");
    const result = requireSuccessfulResult(initialResults, EXACT_QUOTE_REQUEST_ID);
    assertSource(result.source, input.source);
    const aggregate = blockScanMulticallIface.decodeFunctionResult("aggregate3", result.data)[0];
    if (aggregate.length !== 1 || !aggregate[0].success) {
      throw new Error("angstrom-v4 source-unlocked hook quote did not succeed");
    }
    const amountOut = BigInt(UNIV4_QUOTER_INTERFACE.decodeFunctionResult(
      "quoteExactInputSingle", aggregate[0].returnData,
    )[0]);
    if (amountOut <= 0n || amountOut > UINT128_MAX) {
      throw new Error("angstrom-v4 source-unlocked output must fit positive uint128");
    }
    return unsignedQuote(input, amountOut);
  },
};

export const angstromV4Exact = {
  methods(input: AngstromExactInput) {
    assertRoute(input.descriptor, input.route);
    assertAmount(input.amountIn);
    // Only a genuinely empty list selects this mode. Never catch a rejected
    // signed envelope and try an unsigned call instead.
    if (!Array.isArray(input.runtimeEvidence)) throw new Error("angstrom-v4 runtime evidence must be an array");
    if (input.runtimeEvidence.length === 0) {
      assertUnsignedInput(input);
      return Object.freeze([
        localZeroExactMethod<AngstromV4Descriptor, AngstromV4Route, AngstromV4ExactEvidence>(
          "local-zero", (zeroInput) => {
            assertUnsignedInput(zeroInput);
            return unsignedQuote(zeroInput, 0n);
          },
        ),
        Object.freeze({ id: "source-unlocked-quoter", kind: "request-program" as const,
          chainAmountQuote: true as const, program: sourceUnlockedProgram }),
      ]);
    }
    requireAngstromRuntimeEvidence(input);
    return Object.freeze([
      localZeroExactMethod<
        AngstromV4Descriptor,
        AngstromV4Route,
        AngstromV4ExactEvidence
      >(
        "local-zero",
        (input) => {
          assertRoute(input.descriptor, input.route);
          return zeroQuote(input, requireAngstromRuntimeEvidence(input));
        },
      ),
      Object.freeze({
        id: "tx-bound-quoter",
        kind: "request-program" as const,
        chainAmountQuote: true as const,
        program: angstromV4RequestProgram,
      }),
    ]);
  },
  cacheCompatibilityProjection(input): CanonicalValue {
    if (Array.isArray(input.runtimeEvidence) && input.runtimeEvidence.length === 0) {
      assertUnsignedInput(input);
      return {
        mode: "source-unlocked",
        source: { ...input.source, hash: input.source.hash.toLowerCase() },
        bindingFingerprint: hashCanonical(angstromV4StaticBindingProjection(input.descriptor)),
        direction: [input.route.tokenIn, input.route.tokenOut],
        executor: input.executor.toLowerCase(),
      };
    }
    const runtime = requireAngstromRuntimeEvidence(input);
    return {
      poolId: input.descriptor.poolId,
      poolKey: poolKeyProjection(input.descriptor.poolKey),
      quoter: input.descriptor.immutableBinding.quoter,
      direction: [input.route.tokenIn, input.route.tokenOut],
      txHash: runtime.runtime.txHash!,
      runtimeEvidenceHash: runtime.runtime.evidenceHash,
      payloadHash: runtime.payloadHash,
    };
  },
} satisfies ExactQuoteSemantics<
  AngstromV4Descriptor,
  AngstromV4Route,
  AngstromV4ExactEvidence
>;

function quoteItems(
  input: {
    readonly descriptor: AngstromV4Descriptor;
    readonly route: AngstromV4Route;
    readonly amountIn: bigint;
  },
  attestations: readonly import("../angstrom-attestation.js").VerifiedAngstromAttestation[],
): readonly MulticallItem[] {
  return Object.freeze(attestations.map((attestation) => Object.freeze({
    label: `angstrom-v4-exact:${attestation.blockNumber}:` +
      attestation.evidenceHash,
    target: input.descriptor.immutableBinding.quoter,
    callData: UNIV4_QUOTER_INTERFACE.encodeFunctionData(
      "quoteExactInputSingle",
      [{
        poolKey: input.descriptor.poolKey,
        zeroForOne: input.route.direction === "zero-for-one",
        exactAmount: input.amountIn,
        hookData: attestation.unlockData,
      }],
    ),
    allowFailure: true,
  })));
}

function zeroQuote(
  input: {
    readonly descriptor: AngstromV4Descriptor;
    readonly route: AngstromV4Route;
    readonly amountIn: bigint;
    readonly source: AngstromV4ExactEvidence["source"];
  },
  runtime: ReturnType<typeof requireAngstromRuntimeEvidence>,
) {
  return Object.freeze({
    amountOut: 0n,
    evidence: exactEvidence(input, runtime, 0n),
  });
}

function exactEvidence(
  input: {
    readonly descriptor: AngstromV4Descriptor;
    readonly route: AngstromV4Route;
    readonly amountIn: bigint;
    readonly source: AngstromV4ExactEvidence["source"];
  },
  runtime: ReturnType<typeof requireAngstromRuntimeEvidence>,
  amountOut: bigint,
): AngstromV4SignedExactEvidence {
  return Object.freeze({
    kind: "angstrom-v4-tx-bound-quoter" as const,
    source: input.source,
    poolId: input.descriptor.poolId,
    poolKeyFingerprint: poolKeyFingerprint(input.descriptor.poolKey),
    quoter: input.descriptor.immutableBinding.quoter,
    txHash: runtime.runtime.txHash!,
    runtimeEvidenceHash: runtime.runtime.evidenceHash,
    payloadHash: runtime.payloadHash,
    attestationEvidenceHashes: Object.freeze(
      runtime.attestations.map((item) => item.evidenceHash),
    ),
    tokenIn: input.route.tokenIn,
    tokenOut: input.route.tokenOut,
    amountIn: input.amountIn,
    amountOut,
  });
}

function assertUnsignedInput(input: AngstromExactInput): void {
  assertRoute(input.descriptor, input.route);
  assertAmount(input.amountIn);
  if (!Array.isArray(input.runtimeEvidence) || input.runtimeEvidence.length !== 0) {
    throw new Error("angstrom-v4 source-unlocked requires empty runtime evidence");
  }
  if (!Number.isSafeInteger(input.source.number) || input.source.number < 0 ||
      !Number.isSafeInteger(input.source.generation) || input.source.generation < 0 ||
      !ethers.isHexString(input.source.hash, 32) ||
      !ethers.isAddress(input.executor) || input.executor === ethers.ZeroAddress) {
    throw new Error("angstrom-v4 source-unlocked requires a canonical source and executor");
  }
}

function unsignedQuote(input: AngstromExactInput, amountOut: bigint) {
  return Object.freeze({ amountOut, evidence: Object.freeze({
    kind: input.amountIn === 0n ? "angstrom-v4-unsigned-local-zero" as const
      : "angstrom-v4-source-unlocked-quoter" as const,
    source: Object.freeze({ ...input.source }),
    poolId: input.descriptor.poolId,
    poolKeyFingerprint: poolKeyFingerprint(input.descriptor.poolKey),
    quoter: input.descriptor.immutableBinding.quoter,
    bindingFingerprint: hashCanonical(angstromV4StaticBindingProjection(input.descriptor)),
    executor: input.executor,
    tokenIn: input.route.tokenIn,
    tokenOut: input.route.tokenOut,
    amountIn: input.amountIn,
    amountOut,
  }) });
}

function assertAmount(amountIn: bigint): void {
  if (amountIn < 0n || amountIn > UINT128_MAX) {
    throw new Error(`angstrom-v4 exact input does not fit uint128: ${amountIn}`);
  }
}

function assertRoute(
  descriptor: AngstromV4Descriptor,
  route: AngstromV4Route,
): void {
  const expectedIn = route.direction === "zero-for-one"
    ? descriptor.poolKey.currency0
    : descriptor.poolKey.currency1;
  const expectedOut = route.direction === "zero-for-one"
    ? descriptor.poolKey.currency1
    : descriptor.poolKey.currency0;
  if (
    route.instanceKey !== descriptor.instanceKey ||
    route.poolId !== descriptor.poolId ||
    !sameAddress(route.manager, descriptor.immutableBinding.manager) ||
    !sameAddress(route.tokenIn, expectedIn) ||
    !sameAddress(route.tokenOut, expectedOut)
  ) {
    throw new Error(
      `angstrom-v4 exact route binding does not match ${descriptor.poolId}`,
    );
  }
}

function assertSource(
  actual: AngstromV4ExactEvidence["source"],
  expected: AngstromV4ExactEvidence["source"],
): void {
  if (
    actual.number !== expected.number ||
    actual.hash.toLowerCase() !== expected.hash.toLowerCase() ||
    actual.generation !== expected.generation
  ) {
    throw new Error("angstrom-v4 exact quote came from a foreign source");
  }
}
