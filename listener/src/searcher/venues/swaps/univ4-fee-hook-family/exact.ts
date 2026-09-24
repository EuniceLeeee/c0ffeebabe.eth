import { ethers } from "ethers";
import { hookDataFor, SAT1_MAX_BUY, sat1Permissions } from "./sat1.js";
import {
  localZeroExactMethod,
  type ExactQuoteSemantics,
  type ExactQuoteInput,
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
const SEQUENTIAL_QUOTER = new ethers.Interface([
  "function quoteExactInput((address exactCurrency,(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)[] path,uint128 exactAmount) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);

/** The audited Sat1 hook's state changes are reproduced by the Quoter's
 * multi-swap unlock. It reverts the entire trial after returning the quote.
 * Do not silently omit interleaved foreign legs or assume another hook has
 * the same caller/transient/settlement semantics. */
function sequenceParams(input: ExactQuoteInput<FeeHookDescriptor, FeeHookRoute>) {
  if (!input.prefix?.length) return null;
  const steps = [...input.prefix, input].map(step => {
    const descriptor = step.descriptor as FeeHookDescriptor;
    const route = step.route as FeeHookRoute;
    if (descriptor.familyId !== input.descriptor.familyId || descriptor.hookModel !== "sat1" ||
        descriptor.instanceKey !== input.descriptor.instanceKey || descriptor.poolId !== input.descriptor.poolId ||
        !sameAddress(descriptor.managerBinding.quoter, input.descriptor.managerBinding.quoter) ||
        !sameAddress(descriptor.managerBinding.manager, input.descriptor.managerBinding.manager)) {
      throw new Error("sequential quote unsupported: requires a complete same-instance Sat1 prefix");
    }
    assertRoute(descriptor, route);
    if (step.amountIn <= 0n || step.amountIn >= (1n << 127n)) throw new Error("invalid sequential exact amount");
    if (route.direction === "zero-for-one" && step.amountIn > SAT1_MAX_BUY) throw new Error("sat1 buy exceeds contract MAX_BUY");
    return { descriptor, route, amountIn: step.amountIn };
  });
  for (let i = 1; i < steps.length; i++) {
    if (!sameAddress(steps[i - 1]!.route.realTokenOut, steps[i]!.route.realTokenIn) ||
        input.prefix[i - 1]!.amountOut !== steps[i]!.amountIn) throw new Error("sequential exact token/amount mismatch");
  }
  return {
    exactCurrency: steps[0]!.route.realTokenIn,
    exactAmount: steps[0]!.amountIn,
    path: steps.map(({ descriptor, route }) => ({
      intermediateCurrency: route.realTokenOut,
      fee: descriptor.poolKey.fee, tickSpacing: descriptor.poolKey.tickSpacing,
      hooks: descriptor.hook,
      hookData: hookDataFor(descriptor, input.executor, route.direction === "zero-for-one"),
    })),
  };
}

function supportsPrefix(input: ExactQuoteInput<FeeHookDescriptor, FeeHookRoute>): boolean {
  return !input.prefix?.length || [input, ...input.prefix].every(step => {
    const descriptor = step.descriptor as FeeHookDescriptor;
    return descriptor.familyId === input.descriptor.familyId && descriptor.hookModel === "sat1" &&
      descriptor.instanceKey === input.descriptor.instanceKey && descriptor.poolId === input.descriptor.poolId &&
      sameAddress(descriptor.managerBinding.quoter, input.descriptor.managerBinding.quoter) &&
      sameAddress(descriptor.managerBinding.manager, input.descriptor.managerBinding.manager);
  });
}

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
    if (input.descriptor.hookModel === "sat1" && input.route.direction === "zero-for-one" && input.amountIn > SAT1_MAX_BUY) {
      throw new Error("sat1 buy exceeds contract MAX_BUY");
    }
    if (input.amountIn === 0n) return [];
    const sequence = sequenceParams(input);
    return [Object.freeze({
      id: EXACT_QUOTE_REQUEST_ID,
      kind: "eth-call" as const,
      to: input.descriptor.managerBinding.quoter,
      data: sequence ? SEQUENTIAL_QUOTER.encodeFunctionData("quoteExactInput", [sequence]) : UNIV4_QUOTER_INTERFACE.encodeFunctionData(
        "quoteExactInputSingle",
        [{
          poolKey: input.descriptor.poolKey,
          zeroForOne: input.route.direction === "zero-for-one",
          exactAmount: input.amountIn,
          hookData: hookDataFor(input.descriptor, input.executor, input.route.direction === "zero-for-one"),
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
    const sequence = sequenceParams(programInput);
    const decoded = (sequence ? SEQUENTIAL_QUOTER : UNIV4_QUOTER_INTERFACE).decodeFunctionResult(
      sequence ? "quoteExactInput" : "quoteExactInputSingle",
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
  methods: (input: ExactQuoteInput<FeeHookDescriptor, FeeHookRoute>) => Object.freeze([
    localZeroExactMethod<FeeHookDescriptor, FeeHookRoute, FeeHookExactEvidence>(
      "local-zero",
      (input) => {
        assertRoute(input.descriptor, input.route);
        return zeroQuote(input);
      },
    ),
    ...(supportsPrefix(input) ? [Object.freeze({
      id: "univ4-fee-hook-quoter",
      kind: "request-program" as const,
      chainAmountQuote: true as const,
      sequentialPrefix: true as const,
      program: feeHookRequestProgram,
    })] : []),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route, executor }) => ({
    poolId: descriptor.poolId,
    poolKey: poolKeyProjection(descriptor.poolKey),
    quoter: descriptor.managerBinding.quoter,
    direction: [route.tokenIn, route.tokenOut],
    hookData: hookDataFor(descriptor, executor, route.direction === "zero-for-one"),
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
    readonly executor: string;
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
    hookData: hookDataFor(input.descriptor, input.executor, input.route.direction === "zero-for-one"),
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
    !sameAddress(descriptor.hook, descriptor.poolKey.hooks) ||
    !(descriptor.hookModel === "sat1" ? sat1Permissions(descriptor.hook) : sameAddress(descriptor.hook, UNIV4_FEE_HOOK_ADDRESS))
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
