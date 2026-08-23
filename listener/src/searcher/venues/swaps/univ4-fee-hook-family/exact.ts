import { ethers } from "ethers";
import {
  localZeroExactMethod,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import { UNIV4_QUOTER_INTERFACE } from "../univ4-abi.js";
import {
  poolKeyFingerprint,
  poolKeyProjection,
  requireSuccessfulResult,
  sameAddress,
} from "../univ4-family/codec.js";
import {
  UNIV4_FEE_HOOK_ADDRESS,
} from "./manifest.js";
import type {
  FeeHookDescriptor,
  FeeHookExactEvidence,
  FeeHookRoute,
} from "./types.js";

const EXACT_QUOTE_REQUEST_ID = "exact-univ4-fee-hook-quote";
const MAX_UINT128 = (1n << 128n) - 1n;

/**
 * Exact quotes reuse the standard V4 quoter (same poolKey, same
 * quoteExactInputSingle) with the audited fee-hook evidence kind. The tiered
 * dynamic fee is part of the pool's on-chain state at the quoted block, so
 * the quoter output already reflects the hook's actual fee; the mandatory
 * final simulation re-executes the hook on the fork as the fail-closed gate.
 */
const feeHookRequestProgram: ExactRequestProgram<
  FeeHookDescriptor,
  FeeHookRoute,
  FeeHookExactEvidence
> = {
  requirements: () => ({ transports: ["eth-call"] }),
  buildRequests(input) {
    assertRoute(input.descriptor, input.route);
    assertAmount(input.amountIn);
    if (input.amountIn === 0n) return [];
    return [Object.freeze({
      id: EXACT_QUOTE_REQUEST_ID,
      kind: "eth-call" as const,
      to: input.descriptor.managerBinding.quoter,
      data: UNIV4_QUOTER_INTERFACE.encodeFunctionData(
        "quoteExactInputSingle",
        [{
          poolKey: input.descriptor.poolKey,
          zeroForOne: input.route.direction === "zero-for-one",
          exactAmount: input.amountIn,
          hookData: "0x",
        }],
      ),
      completion: "return-data" as const,
    })];
  },
  decode({ programInput, initialResults }) {
    const results = initialResults;
    assertRoute(programInput.descriptor, programInput.route);
    assertAmount(programInput.amountIn);
    if (programInput.amountIn === 0n) return zeroQuote(programInput);
    const result = requireSuccessfulResult(results, EXACT_QUOTE_REQUEST_ID);
    assertSource(result.source, programInput.source);
    const decoded = UNIV4_QUOTER_INTERFACE.decodeFunctionResult(
      "quoteExactInputSingle",
      result.data,
    );
    const amountOut = BigInt(decoded[0]);
    return Object.freeze({
      amountOut,
      evidence: exactEvidence(programInput, amountOut, BigInt(decoded[1])),
    });
  },
};

export const univ4FeeHookExact = {
  methods: () => Object.freeze([
    localZeroExactMethod<FeeHookDescriptor, FeeHookRoute, FeeHookExactEvidence>(
      "local-zero",
      (input) => {
        assertRoute(input.descriptor, input.route);
        return zeroQuote(input);
      },
    ),
    Object.freeze({
      id: "univ4-fee-hook-quoter",
      kind: "request-program" as const,
      program: feeHookRequestProgram,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route }) => ({
    poolId: descriptor.poolId,
    poolKey: poolKeyProjection(descriptor.poolKey),
    quoter: descriptor.managerBinding.quoter,
    direction: [route.tokenIn, route.tokenOut],
    hookData: "0x",
  }),
} satisfies ExactQuoteSemantics<
  FeeHookDescriptor,
  FeeHookRoute,
  FeeHookExactEvidence
>;

function zeroQuote(input: Parameters<typeof exactEvidence>[0]) {
  return Object.freeze({
    amountOut: 0n,
    evidence: exactEvidence(input, 0n, 0n),
  });
}

function exactEvidence(
  input: {
    readonly descriptor: FeeHookDescriptor;
    readonly route: FeeHookRoute;
    readonly amountIn: bigint;
    readonly source: FeeHookExactEvidence["source"];
  },
  amountOut: bigint,
  gasEstimate: bigint,
): FeeHookExactEvidence {
  return Object.freeze({
    kind: "univ4-fee-hook-quoter" as const,
    source: input.source,
    poolId: input.descriptor.poolId,
    poolKeyFingerprint: poolKeyFingerprint(input.descriptor.poolKey),
    quoter: input.descriptor.managerBinding.quoter,
    tokenIn: input.route.tokenIn,
    tokenOut: input.route.tokenOut,
    amountIn: input.amountIn,
    amountOut,
    gasEstimate,
    hookData: "0x" as const,
  });
}

function assertAmount(amountIn: bigint): void {
  if (amountIn < 0n || amountIn > MAX_UINT128) {
    throw new Error(
      "univ4 fee-hook exact input does not fit uint128: " + amountIn,
    );
  }
}

function assertRoute(
  descriptor: FeeHookDescriptor,
  route: FeeHookRoute,
): void {
  const expectedIn = route.direction === "zero-for-one"
    ? descriptor.graphToken0
    : descriptor.graphToken1;
  const expectedOut = route.direction === "zero-for-one"
    ? descriptor.graphToken1
    : descriptor.graphToken0;
  if (
    route.instanceKey !== descriptor.instanceKey ||
    route.poolId !== descriptor.poolId ||
    !sameAddress(route.manager, descriptor.managerBinding.manager) ||
    !sameAddress(route.tokenIn, expectedIn) ||
    !sameAddress(route.tokenOut, expectedOut) ||
    !sameAddress(descriptor.hook, UNIV4_FEE_HOOK_ADDRESS)
  ) {
    throw new Error(
      "univ4 fee-hook exact route binding does not match " + descriptor.poolId,
    );
  }
}

function assertSource(
  actual: FeeHookExactEvidence["source"],
  expected: FeeHookExactEvidence["source"],
): void {
  if (
    actual.number !== expected.number ||
    actual.hash.toLowerCase() !== expected.hash.toLowerCase() ||
    actual.generation !== expected.generation
  ) {
    throw new Error("univ4 fee-hook exact quote came from a foreign source");
  }
}

export function feeHookExactEvidenceFingerprintForTest(
  evidence: FeeHookExactEvidence,
): string {
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(evidence)));
}
