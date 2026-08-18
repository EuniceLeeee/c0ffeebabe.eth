import { ethers } from "ethers";
import type {
  IdentityDecision,
  IdentitySemantics,
  IdentityStepInput,
} from "../../adapter-family-plugin.js";
import type {
  AdapterRequest,
  AdapterRequestResult,
  ObservedEffects,
} from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  ASTRA_MULTITOKEN_BASE_INTERFACE_ID,
  ASTRA_MULTITOKEN_CHANGE_TOPIC,
  ASTRA_MULTITOKEN_INTERFACE,
  ASTRA_ERC20_INTERFACE,
  ASTRA_MULTITOKEN_INTERFACE_ID,
  MAX_ASTRA_MULTITOKEN_TOKENS,
  assertSameSource,
  assertTokenSet,
  canonicalAddress,
  decodeOptionalBoolean,
  decodeOptionalUint,
  decodeToken,
  decodeUint,
  lowerAddress,
  returnedResult,
  sameAddress,
  successfulResult,
} from "./codec.js";
import {
  ASTRA_MULTITOKEN_ACTIVE_REGISTRY_LINEAGE_ID,
  ASTRA_MULTITOKEN_FAMILY_ID,
} from "./manifest.js";
import type {
  AstraMultiTokenCandidate,
  AstraMultiTokenIdentity,
  AstraMultiTokenIdentityEvidence,
  AstraTokenWeightBinding,
} from "./types.js";

const TARGET_CODE_ID = "surface-target-code";
const PRIMARY_INTERFACE_ID = "surface-primary-interface";
const BASE_INTERFACE_ID = "surface-base-interface";
const LENDING_MODE_ID = "surface-lending-mode";
const TOKEN_COUNT_ID = "surface-token-count";
const CHANGES_ENABLED_ID = "surface-changes-enabled";
const CHANGE_FEE_ID = "surface-change-fee";
const TOTAL_PERCENTS_ID = "surface-total-percents";
const ZERO_QUOTE_ID = "behavior-zero-quote";
const ACTIVE_QUOTE_ID = "behavior-active-quote";
const ACTIVE_CHANGE_ID = "behavior-active-change";

export const astraMultiTokenIdentity = {
  variants: [{
    id: "observed-active-registry",
    kind: "standalone-contract" as const,
    lineageId: ASTRA_MULTITOKEN_ACTIVE_REGISTRY_LINEAGE_ID,
    applies: (candidate: AstraMultiTokenCandidate) =>
      candidate.candidateKind === "astra-multitoken-contract",
    requirements(input: IdentityStepInput<AstraMultiTokenCandidate, unknown>) {
      const evidence = identityEvidence(input.evidence);
      if (evidence === undefined) {
        return { transports: ["get-code" as const, "eth-call" as const] };
      }
      if (evidence.phase === "surface") {
        return { transports: ["eth-call" as const] };
      }
      return {
        transports: [
          "eth-call" as const,
          "get-code" as const,
          "effect-delta-simulation" as const,
        ],
        caller: "observed-sender" as const,
        effects: ["return-data" as const, "token-delta" as const, "logs" as const],
      };
    },
    buildRequests(input: IdentityStepInput<AstraMultiTokenCandidate, unknown>) {
      const evidence = identityEvidence(input.evidence);
      if (evidence === undefined) return surfaceRequests(input.candidate);
      if (evidence.phase === "surface") return registryRequests(evidence);
      if (evidence.phase === "registry") {
        return activeBehaviorRequests(input.candidate, evidence);
      }
      return [];
    },
    decode(input: {
      readonly step: IdentityStepInput<AstraMultiTokenCandidate, unknown>;
      readonly results: readonly AdapterRequestResult[];
    }) {
      const prior = identityEvidence(input.step.evidence);
      if (prior === undefined) {
        return decodeSurfaceEvidence(input.step.candidate, input.results);
      }
      if (prior.phase === "surface") {
        return decodeRegistryEvidence(input.step.candidate, prior, input.results);
      }
      if (prior.phase === "registry") {
        return decodeActiveBehaviorEvidence(
          input.step.candidate,
          prior,
          input.results,
        );
      }
      throw new Error("astra-multitoken identity proof has already completed");
    },
    decide(input: IdentityStepInput<AstraMultiTokenCandidate, unknown>) {
      return decideIdentity(input, identityEvidence(input.evidence));
    },
  }],
  identityKey: (identity) => lowerAddress(identity.subject),
} satisfies IdentitySemantics<AstraMultiTokenCandidate, AstraMultiTokenIdentity>;

function surfaceRequests(
  candidate: AstraMultiTokenCandidate,
): readonly AdapterRequest[] {
  const target = canonicalAddress(candidate.target);
  return Object.freeze([
    Object.freeze({ id: TARGET_CODE_ID, kind: "get-code" as const, address: target }),
    optionalCall(PRIMARY_INTERFACE_ID, target, "supportsInterface", [
      ASTRA_MULTITOKEN_INTERFACE_ID,
    ]),
    optionalCall(BASE_INTERFACE_ID, target, "supportsInterface", [
      ASTRA_MULTITOKEN_BASE_INTERFACE_ID,
    ]),
    optionalCall(LENDING_MODE_ID, target, "inLendingMode"),
    requiredCall(TOKEN_COUNT_ID, target, "tokensCount"),
    requiredCall(CHANGES_ENABLED_ID, target, "changesEnabled"),
    requiredCall(CHANGE_FEE_ID, target, "changeFee"),
    requiredCall(TOTAL_PERCENTS_ID, target, "TOTAL_PERCRENTS"),
  ]);
}

function registryRequests(
  evidence: Extract<AstraMultiTokenIdentityEvidence, { readonly phase: "surface" }>,
): readonly AdapterRequest[] {
  return Object.freeze(Array.from(
    { length: evidence.tokenCount },
    (_, index) => requiredCall(
      tokenRequestId(index),
      evidence.target,
      "tokens",
      [index],
    ),
  ));
}

function activeBehaviorRequests(
  candidate: AstraMultiTokenCandidate,
  evidence: Extract<AstraMultiTokenIdentityEvidence, { readonly phase: "registry" }>,
): readonly AdapterRequest[] {
  assertCandidatePair(candidate, evidence.tokens);
  const requests: AdapterRequest[] = [];
  for (let index = 0; index < evidence.tokens.length; index++) {
    const token = evidence.tokens[index];
    requests.push(requiredCall(
      weightRequestId(index),
      evidence.target,
      "weights",
      [token],
    ));
    requests.push(Object.freeze({
      id: tokenCodeRequestId(index),
      kind: "get-code" as const,
      address: token,
    }));
  }
  requests.push(requiredCall(
    ZERO_QUOTE_ID,
    evidence.target,
    "getReturn",
    [evidence.tokens[0], evidence.tokens[1], 0n],
  ));
  requests.push(requiredCall(
    ACTIVE_QUOTE_ID,
    evidence.target,
    "getReturn",
    [candidate.tokenIn, candidate.tokenOut, candidate.amountIn],
  ));
  requests.push(Object.freeze({
    id: ACTIVE_CHANGE_ID,
    kind: "effect-delta-simulation" as const,
    call: Object.freeze({
      caller: Object.freeze({ kind: "observed-sender" as const }),
      // The observed actor is an executor/router contract (the outer tx's
      // `to`, never tx.from) that internally CALLs the Astra target. It is
      // simulated as the msg.sender of an inner call frame, so EIP-3607
      // (contract addresses cannot be tx.origin) must not apply to it.
      executionMode: "impersonated-call-frame" as const,
      to: evidence.target,
      data: ASTRA_MULTITOKEN_INTERFACE.encodeFunctionData("change", [
        candidate.tokenIn,
        candidate.tokenOut,
        candidate.amountIn,
        0n,
      ]),
    }),
    // Fund the router: the observed actor must hold tokenIn to spend it.
    preCalls: Object.freeze([Object.freeze({
      caller: Object.freeze({ kind: "observed-sender" as const }),
      to: canonicalAddress(candidate.tokenIn),
      data: ASTRA_ERC20_INTERFACE.encodeFunctionData("approve", [
        canonicalAddress(evidence.target),
        candidate.amountIn,
      ]),
    })]),
    // Exact effect scope: the verifier requires deltas on both sides of
    // the transfer for both tokens (tokenIn: actor -> target, tokenOut:
    // target -> actor). The literal target address is not a caller role,
    // so it is declared as a literal observation account.
    observeTokenBalances: Object.freeze([
      Object.freeze({
        token: candidate.tokenIn,
        account: Object.freeze({ kind: "observed-sender" as const }),
      }),
      Object.freeze({
        token: candidate.tokenIn,
        account: canonicalAddress(evidence.target),
      }),
      Object.freeze({
        token: candidate.tokenOut,
        account: Object.freeze({ kind: "observed-sender" as const }),
      }),
      Object.freeze({
        token: candidate.tokenOut,
        account: canonicalAddress(evidence.target),
      }),
    ]),
    overrideIntent: Object.freeze({
      caller: Object.freeze({ kind: "observed-sender" as const }),
      tokenBalances: Object.freeze([Object.freeze({
        token: candidate.tokenIn,
        amount: candidate.amountIn,
      })]),
    }),
    observe: Object.freeze([
      "return-data" as const,
      "token-delta" as const,
      "logs" as const,
    ]),
  }));
  return Object.freeze(requests);
}

function decodeSurfaceEvidence(
  candidate: AstraMultiTokenCandidate,
  results: readonly AdapterRequestResult[],
): AstraMultiTokenIdentityEvidence {
  const successful = results.map((result) => {
    if (!result.ok) {
      throw new Error(`astra-multitoken surface unresolved: ${result.failure}`);
    }
    return result;
  });
  assertSameSource(successful);
  const code = returnedResult(results, TARGET_CODE_ID).data;
  if (code === "0x") {
    throw new Error("astra-multitoken target has no runtime code");
  }
  const primary = decodeOptionalBoolean(
    results,
    PRIMARY_INTERFACE_ID,
    "supportsInterface",
  );
  const base = decodeOptionalBoolean(
    results,
    BASE_INTERFACE_ID,
    "supportsInterface",
  );
  const interfaceMode = primary === true && base === true
    ? "erc165" as const
    : primary === null && base === null
    ? "legacy-abi" as const
    : null;
  const tokenCountRaw = decodeUint(results, TOKEN_COUNT_ID, "tokensCount");
  const tokenCount = Number(tokenCountRaw);
  const changesEnabled = Boolean(
    ASTRA_MULTITOKEN_INTERFACE.decodeFunctionResult(
      "changesEnabled",
      returnedResult(results, CHANGES_ENABLED_ID).data,
    )[0],
  );
  const changeFee = decodeUint(results, CHANGE_FEE_ID, "changeFee");
  const totalPercents = decodeUint(
    results,
    TOTAL_PERCENTS_ID,
    "TOTAL_PERCRENTS",
  );
  if (
    interfaceMode === null ||
    !changesEnabled ||
    !Number.isSafeInteger(tokenCount) ||
    tokenCount < 2 ||
    tokenCount > MAX_ASTRA_MULTITOKEN_TOKENS ||
    totalPercents <= 0n ||
    changeFee < 0n ||
    changeFee > totalPercents
  ) {
    throw new Error("astra-multitoken identity surface is not supported");
  }
  return Object.freeze({
    phase: "surface" as const,
    target: canonicalAddress(candidate.target),
    interfaceMode,
    tokenCount,
    changesEnabled: true as const,
    totalPercents,
    changeFee,
    inLendingMode: decodeOptionalUint(
      results,
      LENDING_MODE_ID,
      "inLendingMode",
    ),
  });
}

function decodeRegistryEvidence(
  candidate: AstraMultiTokenCandidate,
  prior: Extract<AstraMultiTokenIdentityEvidence, { readonly phase: "surface" }>,
  results: readonly AdapterRequestResult[],
): AstraMultiTokenIdentityEvidence {
  const successful = results.map((result) => {
    if (!result.ok) {
      throw new Error(`astra-multitoken registry unresolved: ${result.failure}`);
    }
    return result;
  });
  assertSameSource(successful);
  const tokens = Object.freeze(Array.from(
    { length: prior.tokenCount },
    (_, index) => decodeToken(results, tokenRequestId(index)),
  ));
  assertTokenSet(tokens);
  assertCandidatePair(candidate, tokens);
  return Object.freeze({
    phase: "registry" as const,
    target: prior.target,
    interfaceMode: prior.interfaceMode,
    tokens,
    changesEnabled: prior.changesEnabled,
    totalPercents: prior.totalPercents,
    changeFee: prior.changeFee,
    inLendingMode: prior.inLendingMode,
  });
}

function decodeActiveBehaviorEvidence(
  candidate: AstraMultiTokenCandidate,
  prior: Extract<AstraMultiTokenIdentityEvidence, { readonly phase: "registry" }>,
  results: readonly AdapterRequestResult[],
): AstraMultiTokenIdentityEvidence {
  const successful = results.map((result) => {
    if (!result.ok) {
      throw new Error(`astra-multitoken behavior unresolved: ${result.failure}`);
    }
    return result;
  });
  assertSameSource(successful);
  const tokenWeights: AstraTokenWeightBinding[] = [];
  for (let index = 0; index < prior.tokens.length; index++) {
    const weight = decodeUint(results, weightRequestId(index), "weights");
    const code = returnedResult(results, tokenCodeRequestId(index)).data;
    if (weight <= 0n || code === "0x") {
      throw new Error(
        "astra-multitoken registry contains a nonpositive weight or non-contract token",
      );
    }
    tokenWeights.push(Object.freeze({
      token: prior.tokens[index],
      weight,
      codeHash: ethers.keccak256(code),
    }));
  }
  const zeroQuote = decodeUint(results, ZERO_QUOTE_ID, "getReturn");
  const activeAmountOut = decodeUint(results, ACTIVE_QUOTE_ID, "getReturn");
  if (zeroQuote !== 0n || activeAmountOut <= 0n) {
    throw new Error("astra-multitoken getReturn behavior proof failed");
  }
  const activeResult = returnedResult(results, ACTIVE_CHANGE_ID);
  const returnedAmount = BigInt(
    ASTRA_MULTITOKEN_INTERFACE.decodeFunctionResult(
      "change",
      activeResult.data,
    )[0],
  );
  if (
    returnedAmount !== activeAmountOut ||
    !hasRequiredDeltas(activeResult.effects, candidate, activeAmountOut) ||
    !hasRequiredChangeLog(activeResult.effects, candidate, activeAmountOut)
  ) {
    throw new Error("astra-multitoken active change effect proof failed");
  }
  const behaviorProofHash = hashCanonical({
    target: prior.target,
    candidate: {
      actor: candidate.actor,
      tokenIn: candidate.tokenIn,
      tokenOut: candidate.tokenOut,
      amountIn: candidate.amountIn,
    },
    activeAmountOut,
    tokenWeights: tokenWeights.map((binding) => ({
      token: binding.token,
      weight: binding.weight,
      codeHash: binding.codeHash,
    })),
    source: {
      number: activeResult.source.number,
      hash: activeResult.source.hash,
      generation: activeResult.source.generation,
    },
  });
  return Object.freeze({
    phase: "active-behavior" as const,
    target: prior.target,
    interfaceMode: prior.interfaceMode,
    tokens: prior.tokens,
    tokenWeights: Object.freeze(tokenWeights),
    changesEnabled: prior.changesEnabled,
    totalPercents: prior.totalPercents,
    changeFee: prior.changeFee,
    inLendingMode: prior.inLendingMode,
    activeAmountOut,
    behaviorProofHash,
  });
}

function decideIdentity(
  input: IdentityStepInput<AstraMultiTokenCandidate, unknown>,
  evidence: AstraMultiTokenIdentityEvidence | undefined,
): IdentityDecision<AstraMultiTokenIdentity> {
  if (evidence === undefined || evidence.phase !== "active-behavior") {
    return { status: "continue" };
  }
  const registryBinding = Object.freeze({
    registryContract: evidence.target,
    tokens: Object.freeze([...evidence.tokens]),
    tokenWeights: Object.freeze(evidence.tokenWeights.map((binding) =>
      Object.freeze({ ...binding })
    )),
  });
  const behaviorBinding = Object.freeze({
    interfaceMode: evidence.interfaceMode,
    changesEnabled: true as const,
    totalPercents: evidence.totalPercents,
    changeFee: evidence.changeFee,
    inLendingMode: evidence.inLendingMode,
    activeProof: "registry-bound-effect-delta" as const,
  });
  const evidenceHash = hashCanonical({
    registryBinding,
    behaviorBinding,
    behaviorProofHash: evidence.behaviorProofHash,
  });
  return Object.freeze({
    status: "verified" as const,
    identity: Object.freeze({
      familyId: ASTRA_MULTITOKEN_FAMILY_ID,
      lineageId: ASTRA_MULTITOKEN_ACTIVE_REGISTRY_LINEAGE_ID,
      subject: evidence.target,
      provenance: Object.freeze([Object.freeze({
        kind: "observed-active-registry-proof",
        subject: evidence.target,
        evidenceHash,
      })]),
      facts: Object.freeze({
        target: evidence.target,
        registryBinding,
        behaviorBinding,
      }),
    }),
  });
}

function hasRequiredDeltas(
  effects: ObservedEffects | undefined,
  candidate: AstraMultiTokenCandidate,
  amountOut: bigint,
): boolean {
  const deltas = effects?.tokenDeltas;
  if (deltas === undefined) return false;
  const aggregate = new Map<string, bigint>();
  for (const delta of deltas) {
    const key = `${lowerAddress(delta.token)}:${lowerAddress(delta.account)}`;
    aggregate.set(key, (aggregate.get(key) ?? 0n) + delta.delta);
  }
  return requiredDelta(aggregate, candidate.tokenIn, candidate.actor) ===
      -candidate.amountIn &&
    requiredDelta(aggregate, candidate.tokenIn, candidate.target) ===
      candidate.amountIn &&
    requiredDelta(aggregate, candidate.tokenOut, candidate.actor) ===
      amountOut &&
    requiredDelta(aggregate, candidate.tokenOut, candidate.target) ===
      -amountOut;
}

function requiredDelta(
  aggregate: ReadonlyMap<string, bigint>,
  token: string,
  account: string,
): bigint | undefined {
  return aggregate.get(`${lowerAddress(token)}:${lowerAddress(account)}`);
}

function hasRequiredChangeLog(
  effects: ObservedEffects | undefined,
  candidate: AstraMultiTokenCandidate,
  amountOut: bigint,
): boolean {
  return (effects?.logs ?? []).some((log) => {
    if (
      !sameAddress(log.address, candidate.target) ||
      log.topics[0]?.toLowerCase() !== ASTRA_MULTITOKEN_CHANGE_TOPIC
    ) {
      return false;
    }
    try {
      const decoded = ASTRA_MULTITOKEN_INTERFACE.decodeEventLog(
        "Change",
        log.data,
        log.topics,
      );
      return sameAddress(String(decoded.fromToken), candidate.tokenIn) &&
        sameAddress(String(decoded.toToken), candidate.tokenOut) &&
        sameAddress(String(decoded.changer), candidate.actor) &&
        BigInt(decoded.amount) === candidate.amountIn &&
        BigInt(decoded.returnAmount) === amountOut;
    } catch {
      return false;
    }
  });
}

function assertCandidatePair(
  candidate: AstraMultiTokenCandidate,
  tokens: readonly string[],
): void {
  const set = new Set(tokens.map(lowerAddress));
  if (
    !set.has(lowerAddress(candidate.tokenIn)) ||
    !set.has(lowerAddress(candidate.tokenOut)) ||
    sameAddress(candidate.tokenIn, candidate.tokenOut)
  ) {
    throw new Error(
      "astra-multitoken observed pair is not bound by the current token registry",
    );
  }
}

function identityEvidence(
  value: unknown,
): AstraMultiTokenIdentityEvidence | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value !== "object" ||
    !Object.hasOwn(value, "phase") ||
    !new Set(["surface", "registry", "active-behavior"]).has(
      String((value as { readonly phase?: unknown }).phase),
    )
  ) {
    throw new Error("astra-multitoken identity received malformed evidence");
  }
  return value as AstraMultiTokenIdentityEvidence;
}

function requiredCall(
  id: string,
  to: string,
  functionName: string,
  args: readonly unknown[] = [],
): AdapterRequest {
  return Object.freeze({
    id,
    kind: "eth-call" as const,
    to,
    data: ASTRA_MULTITOKEN_INTERFACE.encodeFunctionData(functionName, args),
    completion: "return-data" as const,
  });
}

function optionalCall(
  id: string,
  to: string,
  functionName: string,
  args: readonly unknown[] = [],
): AdapterRequest {
  return Object.freeze({
    id,
    kind: "eth-call" as const,
    to,
    data: ASTRA_MULTITOKEN_INTERFACE.encodeFunctionData(functionName, args),
    completion: "return-or-revert-data" as const,
  });
}

function tokenRequestId(index: number): string {
  return `registry-token:${index}`;
}

function weightRequestId(index: number): string {
  return `registry-weight:${index}`;
}

function tokenCodeRequestId(index: number): string {
  return `registry-token-code:${index}`;
}
