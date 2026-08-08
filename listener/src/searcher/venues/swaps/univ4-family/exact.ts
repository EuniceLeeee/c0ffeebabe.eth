import {
  localZeroExactMethod,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import { hashCanonical } from "../../canonical-value.js";
import { UNIV4_QUOTER_INTERFACE } from "../univ4-abi.js";
import {
  poolKeyFingerprint,
  poolKeyProjection,
  requireSuccessfulResult,
  sameAddress,
} from "./codec.js";
import type {
  UniV4Descriptor,
  UniV4ExactEvidence,
  UniV4Route,
} from "./types.js";

const EXACT_QUOTE_REQUEST_ID = "exact-univ4-quote";
const MAX_UINT128 = (1n << 128n) - 1n;

const univ4RequestProgram: ExactRequestProgram<
  UniV4Descriptor,
  UniV4Route,
  UniV4ExactEvidence
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

export const univ4Exact = {
  methods: () => Object.freeze([
    localZeroExactMethod<UniV4Descriptor, UniV4Route, UniV4ExactEvidence>(
      "local-zero",
      (input) => {
        assertRoute(input.descriptor, input.route);
        return zeroQuote(input);
      },
    ),
    Object.freeze({
      id: "univ4-quoter",
      kind: "request-program" as const,
      program: univ4RequestProgram,
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
  UniV4Descriptor,
  UniV4Route,
  UniV4ExactEvidence
>;

function zeroQuote(input: Parameters<typeof exactEvidence>[0]) {
  return Object.freeze({
    amountOut: 0n,
    evidence: exactEvidence(input, 0n, 0n),
  });
}

function exactEvidence(
  input: {
    readonly descriptor: UniV4Descriptor;
    readonly route: UniV4Route;
    readonly amountIn: bigint;
    readonly source: UniV4ExactEvidence["source"];
  },
  amountOut: bigint,
  gasEstimate: bigint,
): UniV4ExactEvidence {
  return Object.freeze({
    kind: "univ4-no-hook-quoter" as const,
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
    throw new Error(`univ4 exact input does not fit uint128: ${amountIn}`);
  }
}

function assertRoute(
  descriptor: UniV4Descriptor,
  route: UniV4Route,
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
    descriptor.hookPolicy !== "no-hook"
  ) {
    throw new Error(`univ4 exact route binding does not match ${descriptor.poolId}`);
  }
}

function assertSource(
  actual: UniV4ExactEvidence["source"],
  expected: UniV4ExactEvidence["source"],
): void {
  if (
    actual.number !== expected.number ||
    actual.hash.toLowerCase() !== expected.hash.toLowerCase() ||
    actual.generation !== expected.generation
  ) {
    throw new Error("univ4 exact quote came from a foreign source");
  }
}

export function uniV4ExactEvidenceFingerprintForTest(
  evidence: UniV4ExactEvidence,
): string {
  return hashCanonical({
    poolId: evidence.poolId,
    poolKeyFingerprint: evidence.poolKeyFingerprint,
    amountIn: evidence.amountIn,
    amountOut: evidence.amountOut,
  });
}
