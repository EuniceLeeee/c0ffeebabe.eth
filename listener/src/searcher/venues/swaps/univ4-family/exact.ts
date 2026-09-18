import { ethers } from "ethers";
import {
  localZeroExactMethod,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import { hashCanonical } from "../../canonical-value.js";
import { UNIV4_QUOTER_INTERFACE } from "../univ4-abi.js";
import { BLOCKSCAN_MULTICALL3 } from "../../../blockscan-multicall.js";
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
const OUTPUT_BALANCE_REQUEST_ID = "exact-univ4-output-balance";
const OUTPUT_BALANCE_INTERFACE = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
  "function getEthBalance(address account) view returns (uint256)",
]);
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
    const currencyOut = input.route.direction === "zero-for-one"
      ? input.descriptor.poolKey.currency1 : input.descriptor.poolKey.currency0;
    const nativeOut = sameAddress(currencyOut, ethers.ZeroAddress);
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
    }), Object.freeze({
      id: OUTPUT_BALANCE_REQUEST_ID,
      kind: "eth-call" as const,
      to: nativeOut ? BLOCKSCAN_MULTICALL3 : currencyOut,
      data: OUTPUT_BALANCE_INTERFACE.encodeFunctionData(
        nativeOut ? "getEthBalance" : "balanceOf",
        [input.descriptor.managerBinding.manager],
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
    const balanceResult = requireSuccessfulResult(results, OUTPUT_BALANCE_REQUEST_ID);
    assertSource(balanceResult.source, programInput.source);
    if (!ethers.isHexString(balanceResult.data, 32)) {
      throw new Error("univ4 output balance returned invalid uint256");
    }
    const outputBalance = BigInt(balanceResult.data);
    // The Quoter computes swap deltas without executing our take(). The
    // manager's shared balance is a payout ceiling, not this pool's reserves
    // or proof that the full route can execute. Never clip the quoted output.
    if (amountOut > outputBalance) {
      throw new Error(
        `univ4 output-balance-capacity: amountOut=${amountOut} balance=${outputBalance}`,
      );
    }
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
      id: "univ4-quoter-with-output-balance",
      kind: "request-program" as const,
      chainAmountQuote: true as const,
      program: univ4RequestProgram,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route }) => ({
    poolId: descriptor.poolId,
    poolKey: poolKeyProjection(descriptor.poolKey),
    quoter: descriptor.managerBinding.quoter,
    manager: descriptor.managerBinding.manager,
    payoutCheck: "same-source-output-balance-v1",
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
