import {
  localZeroExactMethod,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import type { AdapterRequestResult } from "../../adapter-request-program.js";
import { quoteDodoPmmExactInput } from "../dodo-pmm-math.js";
import {
  assertSameSource,
  canonicalAddress,
  decodeDodoPmmState,
  decodeFeeRates,
  decodeFirstWord,
  decodeInputSemanticsResult,
  inputSemanticsCall,
  requireSuccessfulResult,
  sameAddress,
  DODO_V2_POOL_INTERFACE,
} from "./codec.js";
import { applyDodoTransferToInput } from "./pricing-helpers.js";
import { DODO_V2_QUOTE_ACTOR_EVIDENCE_ID } from "./identity.js";
import type {
  DodoV2Descriptor,
  DodoV2ExactEvidence,
  DodoV2Route,
} from "./types.js";

const EXACT_PMM_ID = "exact-pmm-state";
const EXACT_FEE_ID = "exact-actor-fee";
const EXACT_INPUT_ID = "exact-input-semantics";
const EXACT_QUERY_ID = "exact-actor-query";

const dodoV2RequestProgram: ExactRequestProgram<
  DodoV2Descriptor,
  DodoV2Route,
  DodoV2ExactEvidence
> = {
  requirements(input) {
    assertInvocation(input.descriptor, input.route, input.executor);
    return { transports: ["eth-call"], caller: "verified-actor" };
  },
  buildRequests(input) {
    assertInvocation(input.descriptor, input.route, input.executor);
    if (input.amountIn < 0n) throw new Error("dodo-v2 exact amountIn cannot be negative");
    if (input.amountIn === 0n) return [];
    const actor = input.descriptor.quoteActorBinding.actor;
    const inputCall = inputSemanticsCall(input.descriptor);
    const queryFunction = input.route.direction === "sell-base"
      ? "querySellBase"
      : "querySellQuote";
    return Object.freeze([
      Object.freeze({
        id: EXACT_PMM_ID,
        kind: "eth-call" as const,
        to: input.descriptor.pool,
        data: DODO_V2_POOL_INTERFACE.encodeFunctionData("getPMMStateForCall"),
        completion: "return-data" as const,
      }),
      Object.freeze({
        id: EXACT_FEE_ID,
        kind: "eth-call" as const,
        to: input.descriptor.pool,
        caller: Object.freeze({
          kind: "verified-actor" as const,
          evidenceId: DODO_V2_QUOTE_ACTOR_EVIDENCE_ID,
        }),
        data: DODO_V2_POOL_INTERFACE.encodeFunctionData("getUserFeeRate", [actor]),
        completion: "return-data" as const,
      }),
      Object.freeze({
        id: EXACT_INPUT_ID,
        kind: "eth-call" as const,
        to: inputCall.to,
        data: inputCall.data,
        completion: "return-data" as const,
      }),
      Object.freeze({
        id: EXACT_QUERY_ID,
        kind: "eth-call" as const,
        to: input.descriptor.pool,
        caller: Object.freeze({
          kind: "verified-actor" as const,
          evidenceId: DODO_V2_QUOTE_ACTOR_EVIDENCE_ID,
        }),
        data: DODO_V2_POOL_INTERFACE.encodeFunctionData(queryFunction, [
          actor,
          input.amountIn,
        ]),
        completion: "return-data" as const,
      }),
    ]);
  },
  decode({ programInput, initialResults }) {
    const results = initialResults;
    assertInvocation(
      programInput.descriptor,
      programInput.route,
      programInput.executor,
    );
    if (programInput.amountIn === 0n) return zeroQuote(programInput);
    if (programInput.amountIn < 0n) {
      throw new Error("dodo-v2 exact amountIn cannot be negative");
    }
    const pmmResult = requireSuccessfulResult(results, EXACT_PMM_ID);
    const feeResult = requireSuccessfulResult(results, EXACT_FEE_ID);
    const inputResult = requireSuccessfulResult(results, EXACT_INPUT_ID);
    const queryResult = requireSuccessfulResult(results, EXACT_QUERY_ID);
    assertSameSource([pmmResult, feeResult, inputResult, queryResult]);
    assertSource(queryResult.source, programInput.source);
    const inputState = decodeInputSemanticsResult({
      result: inputResult,
      pool: programInput.descriptor.pool,
      baseToken: programInput.descriptor.baseToken,
      quoteToken: programInput.descriptor.quoteToken,
    });
    const sellBase = programInput.route.direction === "sell-base";
    const effectiveInput = applyDodoTransferToInput(
      sellBase ? inputState.baseInput : inputState.quoteInput,
      programInput.amountIn,
      programInput.descriptor.pool,
    );
    let amountOut: bigint;
    let quotePath: DodoV2ExactEvidence["quotePath"];
    if (effectiveInput === programInput.amountIn) {
      amountOut = decodeFirstWord(queryResult.data, "actor-bound exact query");
      quotePath = "actor-query";
    } else {
      const fees = decodeFeeRates(feeResult.data);
      const local = quoteDodoPmmExactInput({
        state: decodeDodoPmmState(pmmResult.data),
        sellBase,
        payAmount: effectiveInput,
        lpFeeRate: fees.lpFeeRate,
        mtFeeRate: fees.mtFeeRate,
      });
      if (local.status !== "quote") {
        throw new Error(
          `dodo-v2 exact effective input ${effectiveInput} requires a ` +
            "dependent actor query that the single-round exact contract cannot prove",
        );
      }
      amountOut = local.amountOut;
      quotePath = "pmm-derived-after-input-adjustment";
    }
    if (amountOut < 0n) throw new Error("dodo-v2 exact quote returned negative output");
    return Object.freeze({
      amountOut,
      evidence: evidence(programInput, effectiveInput, amountOut, quotePath),
    });
  },
};

export const dodoV2Exact = {
  methods: () => Object.freeze([
    localZeroExactMethod<DodoV2Descriptor, DodoV2Route, DodoV2ExactEvidence>(
      "local-zero",
      (input) => {
        assertInvocation(input.descriptor, input.route, input.executor);
        return zeroQuote(input);
      },
    ),
    Object.freeze({
      id: "actor-bound-query",
      kind: "request-program" as const,
      program: dodoV2RequestProgram,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route, executor }) => ({
    pool: descriptor.pool,
    baseToken: descriptor.baseToken,
    quoteToken: descriptor.quoteToken,
    direction: route.direction,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    registryBinding: {
      registry: descriptor.registryBinding.registry,
      listedPool: descriptor.registryBinding.listedPool,
    },
    quoteActorBinding: {
      actor: descriptor.quoteActorBinding.actor,
      role: descriptor.quoteActorBinding.role,
      feeSemantics: descriptor.quoteActorBinding.feeSemantics,
      querySemantics: descriptor.quoteActorBinding.querySemantics,
      inputSemantics: descriptor.quoteActorBinding.inputSemantics,
    },
    caller: canonicalAddress(executor),
  }),
} satisfies ExactQuoteSemantics<
  DodoV2Descriptor,
  DodoV2Route,
  DodoV2ExactEvidence
>;

function zeroQuote(input: {
  readonly descriptor: DodoV2Descriptor;
  readonly route: DodoV2Route;
  readonly amountIn: bigint;
  readonly source: DodoV2ExactEvidence["source"];
  readonly executor: string;
}) {
  return Object.freeze({
    amountOut: 0n,
    evidence: evidence(input, 0n, 0n, "zero-input"),
  });
}

function evidence(
  input: {
    readonly descriptor: DodoV2Descriptor;
    readonly route: DodoV2Route;
    readonly amountIn: bigint;
    readonly source: DodoV2ExactEvidence["source"];
  },
  effectiveInput: bigint,
  amountOut: bigint,
  quotePath: DodoV2ExactEvidence["quotePath"],
): DodoV2ExactEvidence {
  return Object.freeze({
    kind: "dodo-v2-actor-bound-query" as const,
    source: input.source,
    pool: input.descriptor.pool,
    actor: input.descriptor.quoteActorBinding.actor,
    direction: input.route.direction,
    tokenIn: input.route.tokenIn,
    tokenOut: input.route.tokenOut,
    amountIn: input.amountIn,
    effectiveInput,
    amountOut,
    quotePath,
  });
}

function assertInvocation(
  descriptor: DodoV2Descriptor,
  route: DodoV2Route,
  executor: string,
): void {
  const sellBase = route.direction === "sell-base";
  const expectedIn = sellBase ? descriptor.baseToken : descriptor.quoteToken;
  const expectedOut = sellBase ? descriptor.quoteToken : descriptor.baseToken;
  if (
    route.instanceKey !== descriptor.instanceKey ||
    !sameAddress(route.pool, descriptor.pool) ||
    !sameAddress(route.tokenIn, expectedIn) ||
    !sameAddress(route.tokenOut, expectedOut)
  ) {
    throw new Error(`dodo-v2 exact route binding does not match ${descriptor.pool}`);
  }
  if (!sameAddress(executor, descriptor.quoteActorBinding.actor)) {
    throw new Error(
      `dodo-v2 exact caller ${executor} does not match the verified quote actor`,
    );
  }
}

function assertSource(
  actual: DodoV2ExactEvidence["source"],
  expected: DodoV2ExactEvidence["source"],
): void {
  if (
    actual.number !== expected.number ||
    actual.hash.toLowerCase() !== expected.hash.toLowerCase() ||
    actual.generation !== expected.generation
  ) {
    throw new Error("dodo-v2 exact quote came from a foreign source");
  }
}
