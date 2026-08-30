import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  deepFreeze,
  hashDomain,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { erc20AssetRefV1 } from "../../../packages/asset-ref/src/index.ts";
import {
  decodePackedCallProgram,
  encodePackedCallProgram,
  normalizeEffectTransportDeclaration,
  sameEffectTransportDeclaration,
  type EffectTransportDeclarationV1,
} from "../../../packages/execution-program/src/index.ts";
import { encodeFluidDexApproveCall, FLUID_DEX_MAX_UINT256, encodeSwapInCall } from "./abi.ts";
import { FLUID_DEX_ACTION_OWNER_ID } from "./manifest.ts";
import { buildFluidDexAction } from "./stages.ts";
import {
  assertCutoff,
  canonicalAddress,
  cutoffEqual,
  type FluidDexActionV1,
  type FluidDexQuoteV1,
  type FluidDexRouteV1,
} from "./types.ts";

export const FLUID_DEX_ACTION_SCHEMA_REF = hashDomain("aloha/fluid-dex/action-schema/v2", "force-approve-max-then-swap");
export const FLUID_DEX_ACTION_IMPLEMENTATION_HASH = hashDomain("aloha/fluid-dex/action-implementation/v2", "force-approve-max-then-swap");
export const FLUID_DEX_ACTION_GAS_UPPER_BOUND = "390000";
export const FLUID_DEX_ACTION_VERIFIER_PROGRAM_DIGEST = hashDomain("aloha/fluid-dex/action-verifier-program/v2", {
  module: "families/fluid-dex/src/action.ts",
  schemaRef: FLUID_DEX_ACTION_SCHEMA_REF,
  implementationHash: FLUID_DEX_ACTION_IMPLEMENTATION_HASH,
});
export const FLUID_DEX_ACTION_QUALIFICATION_SPEC_ROOT = hashDomain("aloha/fluid-dex/action-verifier-qualification/v2", [
  "exact-decode",
  "exact-cutoff-shape",
  "raw-action",
  "semantic-route",
  "token-order-direction",
  "quote-lineage",
  "asset-amounts",
  "evaluation",
  "obligation-root",
  "obligation-proof-root",
  "force-approve-zero-max-then-swap-program",
  "effect-caller",
  "effect-token-accounts",
  "effect-logs",
  "artifact-program-transport-binding",
  "final-action-hash",
  "mutation-execution-ids",
]);
export const FLUID_DEX_ACTION_MUTATION_EXECUTION_IDS = Object.freeze([
  "metadata-splice",
  "state-facts-root-splice",
  "input-amount-splice",
  "input-asset-splice",
  "output-amount-splice",
  "output-asset-splice",
  "quote-splice",
  "raw-action-splice",
  "evaluation-splice",
  "obligation-root-splice",
  "obligation-proof-splice",
  "packed-program-splice",
  "approval-token-splice",
  "approval-spender-splice",
  "approval-zero-splice",
  "approval-max-splice",
  "swap-call-splice",
  "effect-caller-splice",
  "effect-observation-splice",
  "effect-log-splice",
  "final-action-splice",
  "top-level-field-injection",
  "quote-field-injection",
  "route-field-injection",
  "raw-action-field-injection",
  "quote-cutoff-field-injection",
  "raw-cutoff-field-injection",
  "token-order-splice",
  "direction-reroot",
] as const);
export const FLUID_DEX_ACTION_MUTATION_CORPUS_ROOT = hashDomain("aloha/fluid-dex/action-verifier-mutations/v2", {
  executionIds: FLUID_DEX_ACTION_MUTATION_EXECUTION_IDS,
});
export const FLUID_DEX_ACTION_INDEPENDENT_ORACLE_CASE_ROOT = hashDomain("aloha/fluid-dex/action-verifier-oracle/v2", {
  gasUpperBound: FLUID_DEX_ACTION_GAS_UPPER_BOUND,
  program: "erc20-approve-zero-then-max-then-fluid-swap-in",
  effects: "sender/recipient/pool-token-in-and-token-out",
});

type Amount = Readonly<{ assetRef: Hash; amount: string }>;

export interface FluidDexSearchActionInputV1 {
  readonly rawAction: FluidDexActionV1;
  readonly quote: FluidDexQuoteV1;
  readonly route: FluidDexRouteV1;
  readonly token0: string;
  readonly token1: string;
  readonly swap0to1: boolean;
  readonly recipient: string;
  readonly stateFactsRoot: Hash;
  readonly inputs: readonly Amount[];
  readonly outputs: readonly Amount[];
  readonly exactEvaluationHash: Hash;
  readonly obligationRoot: Hash;
}

export interface FluidDexSearchActionV1 {
  readonly kind: "fluid-dex.search-swap-action";
  readonly schemaVersion: 2;
  readonly schemaRef: Hash;
  readonly actionOwnerId: string;
  readonly actionImplementationHash: Hash;
  readonly rawAction: FluidDexActionV1;
  readonly quote: FluidDexQuoteV1;
  readonly route: FluidDexRouteV1;
  readonly token0: string;
  readonly token1: string;
  readonly swap0to1: boolean;
  readonly recipient: string;
  readonly stateFactsRoot: Hash;
  readonly inputs: readonly Amount[];
  readonly outputs: readonly Amount[];
  readonly exactEvaluationHash: Hash;
  readonly obligationRoot: Hash;
  readonly obligationProofRoot: Hash;
  readonly gasUpperBound: string;
  readonly opaqueBytes: string;
  readonly effectTransport: EffectTransportDeclarationV1;
  readonly actionHash: Hash;
}

export interface FluidDexActionPortV1 {
  readonly actionOwnerId: typeof FLUID_DEX_ACTION_OWNER_ID;
  readonly actionKind: "swap";
  readonly build: (input: FluidDexSearchActionInputV1) => FluidDexSearchActionV1;
  readonly decode: (value: unknown) => FluidDexSearchActionV1;
  readonly verifyObligations: (value: unknown) => Readonly<{
    kind: "aloha.family-action-obligation-verifier-receipt-v1";
    schemaRef: Hash;
    implementationHash: Hash;
    subjectRoot: Hash;
    proofRoot: Hash;
    outcome: "satisfied";
  }>;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function cutoff(value: unknown, path: string): FluidDexQuoteV1["cutoff"] {
  const item = record(value, path);
  assertExactKeys(item, ["chainId", "hash", "number", "stateRoot"], path);
  return assertCutoff(item as unknown as FluidDexQuoteV1["cutoff"]);
}

function amount(value: unknown, path: string): Amount {
  const item = record(value, path);
  assertExactKeys(item, ["amount", "assetRef"], path);
  return Object.freeze({ assetRef: assertHash(item.assetRef, `${path}.assetRef`), amount: assertDecimalString(item.amount, `${path}.amount`) });
}

function vector(value: unknown, path: string): readonly Amount[] {
  if (!Array.isArray(value) || value.length !== 1) throw new TypeError(`${path} must contain one amount`);
  return Object.freeze([amount(value[0], `${path}[0]`)]);
}

function quote(value: unknown, path: string): FluidDexQuoteV1 {
  const item = record(value, path);
  assertExactKeys(item, ["amountIn", "cutoff", "observedAmountOut", "quoteHash", "routeBindingHash"], path);
  const result = Object.freeze({
    cutoff: cutoff(item.cutoff, `${path}.cutoff`),
    routeBindingHash: assertHash(item.routeBindingHash, `${path}.routeBindingHash`),
    amountIn: assertDecimalString(item.amountIn, `${path}.amountIn`),
    observedAmountOut: assertDecimalString(item.observedAmountOut, `${path}.observedAmountOut`),
    quoteHash: assertHash(item.quoteHash, `${path}.quoteHash`),
  });
  const { quoteHash: ignored, ...body } = result;
  void ignored;
  if (result.quoteHash !== hashDomain("aloha/fluid-dex/quote/v1", body)) throw new TypeError(`${path} hash mismatch`);
  return result;
}

function route(value: unknown, path: string): FluidDexRouteV1 {
  const item = record(value, path);
  assertExactKeys(item, ["inputAsset", "instanceKey", "outputAsset", "routeBindingHash"], path);
  const result = Object.freeze({
    instanceKey: canonicalAddress(item.instanceKey as string),
    inputAsset: canonicalAddress(item.inputAsset as string),
    outputAsset: canonicalAddress(item.outputAsset as string),
    routeBindingHash: assertHash(item.routeBindingHash, `${path}.routeBindingHash`),
  });
  if (result.inputAsset === result.outputAsset || result.routeBindingHash !== hashDomain("aloha/fluid-dex/route-binding/v1", {
    instanceKey: result.instanceKey,
    inputAsset: result.inputAsset,
    outputAsset: result.outputAsset,
  })) throw new TypeError(`${path} route mismatch`);
  return result;
}

function raw(
  value: unknown,
  expectedQuote: FluidDexQuoteV1,
  expectedRoute: FluidDexRouteV1,
  swap0to1: boolean,
  recipient: string,
  path: string,
): FluidDexActionV1 {
  const item = record(value, path);
  assertExactKeys(item, ["actionHash", "calldata", "cutoff", "exactQuoteHash", "target"], path);
  const result = Object.freeze({
    cutoff: cutoff(item.cutoff, `${path}.cutoff`),
    target: canonicalAddress(item.target as string),
    calldata: String(item.calldata),
    exactQuoteHash: assertHash(item.exactQuoteHash, `${path}.exactQuoteHash`),
    actionHash: assertHash(item.actionHash, `${path}.actionHash`),
  });
  const body = { cutoff: result.cutoff, target: result.target, calldata: result.calldata, exactQuoteHash: result.exactQuoteHash };
  if (!cutoffEqual(result.cutoff, expectedQuote.cutoff)
    || result.target !== expectedRoute.instanceKey
    || expectedQuote.routeBindingHash !== expectedRoute.routeBindingHash
    || result.calldata !== encodeSwapInCall(swap0to1, expectedQuote.amountIn, expectedQuote.observedAmountOut, recipient)
    || result.exactQuoteHash !== expectedQuote.quoteHash
    || result.actionHash !== hashDomain("aloha/fluid-dex/action/v1", body)) throw new TypeError(`${path} lineage mismatch`);
  return result;
}

function expectedEffectTransport(routeValue: FluidDexRouteV1, recipientValue: string): EffectTransportDeclarationV1 {
  const recipient = canonicalAddress(recipientValue);
  if (recipient === routeValue.instanceKey) throw new TypeError("fluid-dex effect recipient must not be the pool");
  const sender = Object.freeze({ kind: "observed-sender" as const });
  const observations = [
    { token: routeValue.inputAsset, account: sender },
    { token: routeValue.inputAsset, account: recipient },
    { token: routeValue.inputAsset, account: routeValue.instanceKey },
    { token: routeValue.outputAsset, account: routeValue.instanceKey },
    { token: routeValue.outputAsset, account: recipient },
    { token: routeValue.outputAsset, account: sender },
  ];
  return normalizeEffectTransportDeclaration({
    caller: { ref: sender, executionMode: "top-level" },
    preCalls: [],
    observeTokenBalances: observations,
    observeLogs: true,
  }, "fluid-dex.action.effectTransport");
}

function expectedPackedProgram(rawAction: FluidDexActionV1, routeValue: FluidDexRouteV1): string {
  return encodePackedCallProgram([
    {
      target: routeValue.inputAsset as `0x${string}`,
      value: "0",
      calldata: encodeFluidDexApproveCall(routeValue.instanceKey, 0n) as `0x${string}`,
    },
    {
      target: routeValue.inputAsset as `0x${string}`,
      value: "0",
      calldata: encodeFluidDexApproveCall(routeValue.instanceKey, FLUID_DEX_MAX_UINT256) as `0x${string}`,
    },
    {
      target: routeValue.instanceKey as `0x${string}`,
      value: "0",
      calldata: rawAction.calldata as `0x${string}`,
    },
  ]);
}

function assertPackedProgram(value: unknown, rawAction: FluidDexActionV1, routeValue: FluidDexRouteV1, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be packed CALL bytes`);
  const calls = decodePackedCallProgram(value, path);
  if (calls.length !== 3
    || calls[0]!.target !== routeValue.inputAsset
    || calls[0]!.value !== "0"
    || calls[0]!.calldata !== encodeFluidDexApproveCall(routeValue.instanceKey, 0n)
    || calls[1]!.target !== routeValue.inputAsset
    || calls[1]!.value !== "0"
    || calls[1]!.calldata !== encodeFluidDexApproveCall(routeValue.instanceKey, FLUID_DEX_MAX_UINT256)
    || calls[2]!.target !== routeValue.instanceKey
    || calls[2]!.value !== "0"
    || calls[2]!.calldata !== rawAction.calldata
    || value !== expectedPackedProgram(rawAction, routeValue)) throw new TypeError(`${path} force-approve/swap lineage mismatch`);
  return value;
}

function fluidProofRoot(input: {
  rawAction: FluidDexActionV1;
  route: FluidDexRouteV1;
  token0: string;
  token1: string;
  exactEvaluationHash: Hash;
  obligationRoot: Hash;
  inputs: readonly Amount[];
  outputs: readonly Amount[];
  stateFactsRoot: Hash;
  swap0to1: boolean;
  recipient: string;
  opaqueBytes: string;
  effectTransport: EffectTransportDeclarationV1;
}): Hash {
  return hashDomain("aloha/fluid-dex/action-obligation-postcondition/v2", {
    rawActionHash: input.rawAction.actionHash,
    routeBindingHash: input.route.routeBindingHash,
    token0: input.token0,
    token1: input.token1,
    exactEvaluationHash: input.exactEvaluationHash,
    obligationRoot: input.obligationRoot,
    inputs: input.inputs,
    outputs: input.outputs,
    stateFactsRoot: input.stateFactsRoot,
    swap0to1: input.swap0to1,
    recipient: input.recipient,
    opaqueBytes: input.opaqueBytes,
    effectTransport: input.effectTransport,
  });
}

export function buildFluidDexSearchAction(input: FluidDexSearchActionInputV1): FluidDexSearchActionV1 {
  const routeValue = route(input.route, "fluid-dex.action.route");
  const token0 = canonicalAddress(input.token0);
  const token1 = canonicalAddress(input.token1);
  const recipient = canonicalAddress(input.recipient);
  const rawAction = raw(input.rawAction, input.quote, routeValue, input.swap0to1, recipient, "fluid-dex.action.rawAction");
  const opaqueBytes = expectedPackedProgram(rawAction, routeValue);
  const effectTransport = expectedEffectTransport(routeValue, recipient);
  const obligationProofRoot = fluidProofRoot({ ...input, rawAction, route: routeValue, token0, token1, recipient, opaqueBytes, effectTransport });
  const body = {
    kind: "fluid-dex.search-swap-action" as const,
    schemaVersion: 2 as const,
    schemaRef: FLUID_DEX_ACTION_SCHEMA_REF,
    actionOwnerId: FLUID_DEX_ACTION_OWNER_ID,
    actionImplementationHash: FLUID_DEX_ACTION_IMPLEMENTATION_HASH,
    rawAction,
    quote: input.quote,
    route: routeValue,
    token0,
    token1,
    swap0to1: input.swap0to1,
    recipient,
    stateFactsRoot: input.stateFactsRoot,
    inputs: input.inputs,
    outputs: input.outputs,
    exactEvaluationHash: input.exactEvaluationHash,
    obligationRoot: input.obligationRoot,
    obligationProofRoot,
    gasUpperBound: FLUID_DEX_ACTION_GAS_UPPER_BOUND,
    opaqueBytes,
    effectTransport,
  };
  return decodeFluidDexSearchAction({ ...body, actionHash: hashDomain("aloha/fluid-dex/search-action/v2", body) });
}

export function decodeFluidDexSearchAction(value: unknown, path = "fluid-dex.searchAction"): FluidDexSearchActionV1 {
  const item = record(value, path);
  assertExactKeys(item, [
    "actionHash",
    "actionImplementationHash",
    "actionOwnerId",
    "effectTransport",
    "exactEvaluationHash",
    "gasUpperBound",
    "inputs",
    "kind",
    "obligationProofRoot",
    "obligationRoot",
    "opaqueBytes",
    "outputs",
    "quote",
    "rawAction",
    "recipient",
    "route",
    "schemaRef",
    "schemaVersion",
    "stateFactsRoot",
    "swap0to1",
    "token0",
    "token1",
  ], path);
  if (item.kind !== "fluid-dex.search-swap-action"
    || item.schemaVersion !== 2
    || item.schemaRef !== FLUID_DEX_ACTION_SCHEMA_REF
    || item.actionOwnerId !== FLUID_DEX_ACTION_OWNER_ID
    || item.actionImplementationHash !== FLUID_DEX_ACTION_IMPLEMENTATION_HASH
    || item.gasUpperBound !== FLUID_DEX_ACTION_GAS_UPPER_BOUND
    || typeof item.swap0to1 !== "boolean") throw new TypeError(`${path} metadata mismatch`);
  const decodedQuote = quote(item.quote, `${path}.quote`);
  const decodedRoute = route(item.route, `${path}.route`);
  const token0 = canonicalAddress(item.token0 as string);
  const token1 = canonicalAddress(item.token1 as string);
  const recipient = canonicalAddress(item.recipient as string);
  const rawAction = raw(item.rawAction, decodedQuote, decodedRoute, item.swap0to1, recipient, `${path}.rawAction`);
  const inputs = vector(item.inputs, `${path}.inputs`);
  const outputs = vector(item.outputs, `${path}.outputs`);
  const stateFactsRoot = assertHash(item.stateFactsRoot, `${path}.stateFactsRoot`);
  const exactEvaluationHash = assertHash(item.exactEvaluationHash, `${path}.exactEvaluationHash`);
  const obligationRoot = assertHash(item.obligationRoot, `${path}.obligationRoot`);
  const obligationProofRoot = assertHash(item.obligationProofRoot, `${path}.obligationProofRoot`);
  const opaqueBytes = assertPackedProgram(item.opaqueBytes, rawAction, decodedRoute, `${path}.opaqueBytes`);
  const effectTransport = normalizeEffectTransportDeclaration(item.effectTransport, `${path}.effectTransport`);
  const expectedTransport = expectedEffectTransport(decodedRoute, recipient);
  if (!sameEffectTransportDeclaration(effectTransport, expectedTransport)) throw new TypeError(`${path}.effectTransport lineage mismatch`);
  if (token0 === token1
    || decodedRoute.inputAsset !== (item.swap0to1 ? token0 : token1)
    || decodedRoute.outputAsset !== (item.swap0to1 ? token1 : token0)) throw new TypeError(`${path} token direction mismatch`);
  if (inputs[0]!.amount !== decodedQuote.amountIn
    || outputs[0]!.amount !== decodedQuote.observedAmountOut
    || inputs[0]!.assetRef !== erc20AssetRefV1(decodedQuote.cutoff.chainId, decodedRoute.inputAsset)
    || outputs[0]!.assetRef !== erc20AssetRefV1(decodedQuote.cutoff.chainId, decodedRoute.outputAsset)) throw new TypeError(`${path} amount lineage mismatch`);
  const expectedEvaluation = hashDomain("aloha/fluid-dex/search-exact-evaluation/v1", {
    quoteHash: decodedQuote.quoteHash,
    stateFactsRoot,
    actionHash: rawAction.actionHash,
  });
  if (exactEvaluationHash !== expectedEvaluation || obligationRoot !== hashDomain("aloha/fluid-dex/search-obligation/v1", {
    evaluationHash: expectedEvaluation,
    quoteHash: decodedQuote.quoteHash,
  })) throw new TypeError("fluid-dex exact obligation lineage mismatch");
  if (obligationProofRoot !== fluidProofRoot({
    rawAction,
    route: decodedRoute,
    token0,
    token1,
    exactEvaluationHash,
    obligationRoot,
    inputs,
    outputs,
    stateFactsRoot,
    swap0to1: item.swap0to1,
    recipient,
    opaqueBytes,
    effectTransport,
  })) throw new TypeError("fluid-dex obligation proof root mismatch");
  const decoded = {
    kind: item.kind,
    schemaVersion: 2,
    schemaRef: item.schemaRef,
    actionOwnerId: item.actionOwnerId,
    actionImplementationHash: item.actionImplementationHash,
    rawAction,
    quote: decodedQuote,
    route: decodedRoute,
    token0,
    token1,
    swap0to1: item.swap0to1,
    recipient,
    stateFactsRoot,
    inputs,
    outputs,
    exactEvaluationHash,
    obligationRoot,
    obligationProofRoot,
    gasUpperBound: item.gasUpperBound,
    opaqueBytes,
    effectTransport,
    actionHash: assertHash(item.actionHash, `${path}.actionHash`),
  } as FluidDexSearchActionV1;
  const { actionHash: ignored, ...body } = decoded;
  void ignored;
  if (decoded.actionHash !== hashDomain("aloha/fluid-dex/search-action/v2", body)) throw new TypeError(`${path} action hash mismatch`);
  return deepFreeze(decoded);
}

export function verifyFluidDexSearchActionObligations(value: unknown) {
  const action = decodeFluidDexSearchAction(value, "fluid-dex.obligationProof.action");
  return deepFreeze({
    kind: "aloha.family-action-obligation-verifier-receipt-v1" as const,
    schemaRef: FLUID_DEX_ACTION_SCHEMA_REF,
    implementationHash: FLUID_DEX_ACTION_IMPLEMENTATION_HASH,
    subjectRoot: action.obligationRoot,
    proofRoot: action.obligationProofRoot,
    outcome: "satisfied" as const,
  });
}

export const FLUID_DEX_ACTION_PORT: FluidDexActionPortV1 = Object.freeze({
  actionOwnerId: FLUID_DEX_ACTION_OWNER_ID,
  actionKind: "swap",
  build: buildFluidDexSearchAction,
  decode: decodeFluidDexSearchAction,
  verifyObligations: verifyFluidDexSearchActionObligations,
});
