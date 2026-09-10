import {
  bindRequestResultRound,
  collectRequestProgramResults,
  localZeroExactMethod,
  type ExactQuoteInput,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import type { AdapterRequestResult } from "../../adapter-request-program.js";
import { DODO_DECIMAL_ONE } from "../dodo-pmm-math.js";
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
const EXACT_EFFECTIVE_QUERY_ID = "exact-effective-actor-query";

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
  buildDependentProgram({ programInput, completedRound, initialResults }) {
    assertInvocation(programInput.descriptor, programInput.route, programInput.executor);
    if (programInput.amountIn === 0n || completedRound !== 0) return null;
    const { effectiveInput } = decodeInitialInput(programInput, initialResults);
    if (effectiveInput === programInput.amountIn) return null;
    return bindRequestResultRound(
      { transports: ["eth-call"], caller: "verified-actor" },
      [Object.freeze({
        id: EXACT_EFFECTIVE_QUERY_ID,
        kind: "eth-call" as const,
        to: programInput.descriptor.pool,
        caller: Object.freeze({
          kind: "verified-actor" as const,
          evidenceId: DODO_V2_QUOTE_ACTOR_EVIDENCE_ID,
        }),
        data: DODO_V2_POOL_INTERFACE.encodeFunctionData(
          programInput.route.direction === "sell-base" ? "querySellBase" : "querySellQuote",
          [programInput.descriptor.quoteActorBinding.actor, effectiveInput],
        ),
        completion: "return-data" as const,
      })],
    );
  },
  decode({ programInput, initialResults, dependentEvidence }) {
    assertInvocation(
      programInput.descriptor,
      programInput.route,
      programInput.executor,
    );
    if (programInput.amountIn === 0n) return zeroQuote(programInput);
    const { effectiveInput, queryResult } = decodeInitialInput(programInput, initialResults);
    const amountResult = effectiveInput === programInput.amountIn
      ? queryResult
      : requireSuccessfulResult(
          collectRequestProgramResults(initialResults, dependentEvidence),
          EXACT_EFFECTIVE_QUERY_ID,
        );
    assertSource(amountResult.source, programInput.source);
    const amountOut = decodeFirstWord(amountResult.data, "actor-bound exact query");
    if (amountOut < 0n) throw new Error("dodo-v2 exact quote returned negative output");
    return Object.freeze({
      amountOut,
      evidence: evidence(programInput, effectiveInput, amountOut, "actor-query"),
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
      chainAmountQuote: true,
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

function decodeInitialInput(
  input: ExactQuoteInput<DodoV2Descriptor, DodoV2Route>,
  results: readonly AdapterRequestResult[],
) {
  if (input.amountIn < 0n) throw new Error("dodo-v2 exact amountIn cannot be negative");
  const pmmResult = requireSuccessfulResult(results, EXACT_PMM_ID);
  const feeResult = requireSuccessfulResult(results, EXACT_FEE_ID);
  const inputResult = requireSuccessfulResult(results, EXACT_INPUT_ID);
  // Retain the four-request initial contract: a failed gross-input query still
  // fails closed, even when a later effective-input query might have succeeded.
  const queryResult = requireSuccessfulResult(results, EXACT_QUERY_ID);
  assertSameSource([pmmResult, feeResult, inputResult, queryResult]);
  assertSource(queryResult.source, input.source);
  const inputState = decodeInputSemanticsResult({
    result: inputResult,
    pool: input.descriptor.pool,
    baseToken: input.descriptor.baseToken,
    quoteToken: input.descriptor.quoteToken,
  });
  const effectiveInput = applyDodoTransferToInput(
    input.route.direction === "sell-base" ? inputState.baseInput : inputState.quoteInput,
    input.amountIn,
    input.descriptor.pool,
  );
  if (effectiveInput !== input.amountIn) {
    // Preserve adjusted-input fee/state domain checks without computing a
    // discarded local quote. The actor query owns output arithmetic and fees.
    decodeFeeRates(feeResult.data);
    const pmm = decodeDodoPmmState(pmmResult.data);
    if (pmm.K > DODO_DECIMAL_ONE) throw new Error("dodo PMM K exceeds one");
  }
  return { effectiveInput, queryResult };
}

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
