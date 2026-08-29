import {
  decodeCanonicalJson,
  encodeCanonicalJson,
  hashDomain,
  sha256Hex,
  type CanonicalJsonObject,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeArtifactBytes,
  type ArtifactResolutionClaimV1,
  type ResolverPolicyV1,
  type RetentionLeaseReceiptV1,
} from "../../../specs/artifact-resolution/src/index.ts";
import {
  decodeProductionReceipt,
  decodeReadOnlyArtifactRef,
  decodeSemanticArtifact,
  type ProductionReceiptV1,
  type ReadOnlyArtifactRefV1,
  type SemanticArtifactV1,
} from "../../../specs/core-envelope/src/index.ts";
import {
  assertEvidenceEventMatchesReceipt,
  decodeEvidenceEvent,
  type EvidenceEventV1,
} from "../../../specs/evidence/src/index.ts";
import {
  decodeSixStepEventFact,
  decodeSixStepNativeBoundaryRecord,
  decodeSixStepStageInput,
  decodeSixStepStageFacts,
  decodeSixStepWitnessContent,
  hashOrderedInstanceBindingsRoot,
  hashSixStepWitnessContentRoot,
  stageFactsSchemaRef,
  stageInputSchemaRef,
  type SixStepEventFactV1,
  type SixStepEvidenceWitnessV1,
  type SixStepStageFactsV1,
} from "./schema.ts";
import { resolveSixStepValuationOracle } from "./composition/valuation-oracle-composition.ts";

export type SixStepPredicateVerdict = "pass" | "fail" | "invalid";

const ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF = hashDomain(
  "aloha/economic-safety/revm-observation-schema-ref/v1",
  {
    workerReceipt: "aloha.qualified-final-simulation-owner-facts-v1",
    effects: "aloha.revm-effect-observation-v1",
    source: "canonical-current-source-v1",
  },
);

export type SixStepReasonCode =
  | "predicate-observation-missing"
  | "predicate-observation-mismatch"
  | "artifact-ref-mismatch"
  | "artifact-claim-mismatch"
  | "observation-mismatch"
  | "production-receipt-mismatch"
  | "process-anchor-mismatch"
  | "predicate-failed";

export interface SixStepReasonV1 {
  readonly code: SixStepReasonCode;
  readonly path: string;
}

export interface SixStepRuntimeFactsV1 {
  readonly facts: readonly unknown[];
  readonly refs: readonly ReadOnlyArtifactRefV1[];
  readonly claims: readonly ArtifactResolutionClaimV1[];
  readonly policies: readonly ResolverPolicyV1[];
  readonly leases: readonly RetentionLeaseReceiptV1[];
  readonly observations: readonly {
    readonly observationId: string;
    readonly rawArtifactRefs: readonly ReadOnlyArtifactRefV1[];
    readonly observedClaimIds: readonly string[];
  }[];
}

interface EconomicEvaluatorBindingObservationV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.six-step-economic-evaluator-binding-observation-v1";
  readonly runtimeBindingId: Hash;
  readonly candidateReleaseCommit: string;
  readonly releaseProvenanceHash: Hash;
  readonly authorityRoot: Hash;
  readonly implementationHash: Hash;
  readonly policyRoot: Hash;
  readonly evaluatorExportIdentityHash: Hash;
  readonly objectiveTemplates: readonly unknown[];
  readonly actionOwners: readonly unknown[];
  readonly valuationOwners: readonly unknown[];
  readonly executorQualification: unknown;
  readonly safetyProfile: unknown;
  readonly observationRoot: Hash;
}

export interface SixStepPredicateResultV1 {
  readonly verdict: SixStepPredicateVerdict;
  readonly reasons: readonly SixStepReasonV1[];
}

interface DecodedEventV1 {
  readonly fact: SixStepEventFactV1;
  readonly event: EvidenceEventV1;
  readonly semantic: SemanticArtifactV1;
  readonly receipt: ProductionReceiptV1;
  readonly stageFacts: SixStepStageFactsV1;
  readonly witnessPayloads: Readonly<Record<string, CanonicalJsonObject>>;
  readonly rawPayload: CanonicalJsonObject;
  readonly eventClaimId: Hash;
}

function same(left: unknown, right: unknown): boolean {
  try {
    return encodeCanonicalJson(left) === encodeCanonicalJson(right);
  } catch {
    return false;
  }
}

function payloadRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function exactPayloadKeys(value: unknown, keys: readonly string[]): boolean {
  const record = payloadRecord(value);
  return record !== null && same(Object.keys(record).sort(), [...keys].sort());
}

function stableRuntime(runtime: EvidenceEventV1["runtime"]): Omit<EvidenceEventV1["runtime"], "logRangeArtifactRefId"> {
  const { logRangeArtifactRefId: _logRangeArtifactRefId, ...stable } = runtime;
  return stable;
}

function add(reasons: SixStepReasonV1[], code: SixStepReasonCode, path: string): void {
  if (!reasons.some((reason) => reason.code === code && reason.path === path)) {
    reasons.push(Object.freeze({ code, path }));
  }
}

function positiveHash(value: unknown): value is Hash {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value) && !/^0x0+$/.test(value);
}

function canonicalUnsigned(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

function domainHashMatches(domain: string, body: unknown, expected: unknown): boolean {
  if (!positiveHash(expected)) return false;
  try { return hashDomain(domain, body as never) === expected; } catch { return false; }
}

function validAssetReference(value: unknown, chainId: unknown): boolean {
  const asset = payloadRecord(value);
  const identity = payloadRecord(asset?.identity);
  if (asset === null || identity === null
    || !exactPayloadKeys(asset, ["identity", "assetRef"])
    || !exactPayloadKeys(identity, ["chainId", "kind", "address"])
    || canonicalUnsigned(chainId) === null
    || canonicalUnsigned(identity?.chainId) === null
    || identity?.chainId !== chainId
    || (identity.kind !== "native" && identity.kind !== "erc20")) return false;
  if (identity.kind === "native" ? identity.address !== null : typeof identity.address !== "string" || !/^0x[0-9a-f]{40}$/.test(identity.address) || /^0x0+$/.test(identity.address)) return false;
  return domainHashMatches("aloha/asset-ref/v1", identity, asset?.assetRef);
}

function validEffectAccount(value: unknown): boolean {
  return typeof value === "string"
    ? /^0x[0-9a-f]{40}$/.test(value)
    : exactPayloadKeys(value, ["kind"]) && payloadRecord(value)?.kind === "observed-sender";
}

function validEffectCaller(value: unknown): boolean {
  const caller = payloadRecord(value);
  return exactPayloadKeys(caller, ["ref", "executionMode"])
    && validEffectAccount(caller?.ref)
    && (caller?.executionMode === "top-level" || caller?.executionMode === "impersonated-call-frame");
}

function validEffectTransport(value: unknown): boolean {
  const transport = payloadRecord(value);
  if (!exactPayloadKeys(transport, ["caller", "preCalls", "observeTokenBalances", "observeLogs"])
    || !validEffectCaller(transport?.caller)
    || !Array.isArray(transport?.preCalls)
    || !Array.isArray(transport?.observeTokenBalances)
    || typeof transport?.observeLogs !== "boolean") return false;
  for (const preCall of transport.preCalls) {
    const item = payloadRecord(preCall);
    if (!exactPayloadKeys(item, ["caller", "to", "data"])
      || !validEffectCaller(item?.caller)
      || typeof item?.to !== "string" || !/^0x[0-9a-f]{40}$/.test(item.to)
      || typeof item?.data !== "string" || !/^0x(?:[0-9a-f]{2})*$/.test(item.data)) return false;
  }
  const seen = new Set<string>();
  for (const observation of transport.observeTokenBalances) {
    const item = payloadRecord(observation);
    if (!exactPayloadKeys(item, ["token", "account"])
      || typeof item?.token !== "string" || !/^0x[0-9a-f]{40}$/.test(item.token)
      || !validEffectAccount(item.account)) return false;
    const key = encodeCanonicalJson(item);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

interface IndependentlyObservedEffectsV1 {
  readonly gasUsed: bigint;
  readonly tokenBefore: ReadonlyMap<string, bigint>;
  readonly tokenAfter: ReadonlyMap<string, bigint>;
}

interface IndependentRouteSafetyV1 {
  readonly routeProof: Readonly<{
    readonly objectiveRef: Hash;
    readonly actionHashes: readonly Hash[];
    readonly executionReceiptHash: Hash;
    readonly effectsHash: Hash;
    readonly deltas: readonly Readonly<{
      readonly assetRef: Hash;
      readonly before: string;
      readonly after: string;
      readonly delta: string;
    }>[];
  }>;
  readonly actions: readonly Readonly<{
    readonly familyDefinitionHash: Hash;
    readonly actionOwnerId: string;
    readonly actionOwnerRef: Hash;
    readonly actionHash: Hash;
    readonly obligationRoot: Hash;
  }>[];
}

function independentTokenBalances(value: unknown): ReadonlyMap<string, bigint> | null {
  if (!Array.isArray(value)) return null;
  const balances = new Map<string, bigint>();
  for (const raw of value) {
    const item = payloadRecord(raw);
    if (!exactPayloadKeys(item, ["token", "account", "balance"])
      || typeof item?.token !== "string" || !/^0x[0-9a-f]{40}$/.test(item.token)
      || typeof item?.account !== "string" || !/^0x[0-9a-f]{40}$/.test(item.account)) return null;
    const balance = canonicalUnsigned(item.balance);
    const key = `${item.token}\u0000${item.account}`;
    if (balance === null || balances.has(key)) return null;
    balances.set(key, balance);
  }
  return balances;
}

function independentlyVerifyWorkerReceipt(
  finalFacts: Readonly<Record<string, unknown>> | null,
  generationId: unknown,
  source: unknown,
  programHash: unknown,
  simulation: Readonly<Record<string, unknown>> | null,
  evaluatorBinding: EconomicEvaluatorBindingObservationV1,
): IndependentlyObservedEffectsV1 | null {
  const worker = payloadRecord(finalFacts?.workerReceipt);
  const projection = payloadRecord(finalFacts?.projection);
  const observedQualification = payloadRecord(finalFacts?.executorQualification);
  const expectedQualification = payloadRecord(evaluatorBinding.executorQualification);
  const effects = payloadRecord(worker?.effects);
  const workerKeys = ["requestId", "attemptId", "ownerRef", "generationId", "authority", "inputHash", "deadlineAtMs", "authorityRoot", "workerEpoch", "executorSessionHash", "engine", "engineBuildFingerprint", "caller", "observeAccounts", "source", "programHash", "status", "output", "effects", "executionReceiptHash"];
  if (Object.prototype.hasOwnProperty.call(worker ?? {}, "effectTransport")) workerKeys.push("effectTransport");
  const authority = payloadRecord(worker?.authority);
  if (!exactPayloadKeys(finalFacts, ["kind", "executorQualification", "projection", "workerReceipt"])
    || finalFacts?.kind !== "aloha.qualified-final-simulation-owner-facts-v1"
    || !exactPayloadKeys(observedQualification, ["engineBuildFingerprint", "executableFingerprint", "qualifiedExecutorRegistryRoot", "selectedExecutorLeafHash", "releaseRoleManifestRoot"])
    || !exactPayloadKeys(expectedQualification, ["executorKind", "engineBuildFingerprint", "executableFingerprint", "qualifiedExecutorRegistryRoot", "selectedExecutorLeafHash", "releaseRoleManifestRoot"])
    || expectedQualification?.executorKind !== "revm"
    || observedQualification?.engineBuildFingerprint !== expectedQualification.engineBuildFingerprint
    || observedQualification?.executableFingerprint !== expectedQualification.executableFingerprint
    || observedQualification?.qualifiedExecutorRegistryRoot !== expectedQualification.qualifiedExecutorRegistryRoot
    || observedQualification?.selectedExecutorLeafHash !== expectedQualification.selectedExecutorLeafHash
    || observedQualification?.releaseRoleManifestRoot !== expectedQualification.releaseRoleManifestRoot
    || !exactPayloadKeys(worker, workerKeys)
    || !exactPayloadKeys(effects, ["format", "bytes", "observedAccounts", "effectsHash"])
    || worker?.generationId !== generationId || !same(worker?.source, source) || worker?.programHash !== programHash
    || worker?.status !== "returned" || worker?.engine !== expectedQualification.executorKind
    || worker?.engineBuildFingerprint !== expectedQualification.engineBuildFingerprint
    || authority === null || worker?.authorityRoot !== authority.authorityRoot
    || worker?.workerEpoch !== authority.workerEpoch || worker?.executorSessionHash !== authority.executorSessionHash
    || typeof worker?.deadlineAtMs !== "number" || !Number.isFinite(worker.deadlineAtMs)
    || effects?.format !== "revm-effects-v1" || typeof effects.bytes !== "string" || !Array.isArray(effects.observedAccounts)
    || !same(effects.observedAccounts, worker?.observeAccounts)
    || !domainHashMatches("aloha/revm-effects-wire/v1", {
      format: effects.format,
      bytes: effects.bytes,
      observedAccounts: effects.observedAccounts,
    }, effects.effectsHash)
    || effects.effectsHash !== simulation?.effectsHash
    || !same(effects, payloadRecord(simulation?.simulation)?.effects)) return null;
  const receiptBody = {
    requestId: worker.requestId,
    workerEpoch: worker.workerEpoch,
    ownerRef: worker.ownerRef,
    generationId: worker.generationId,
    attemptId: worker.attemptId,
    authority: worker.authority,
    inputHash: worker.inputHash,
    deadlineAtMs: worker.deadlineAtMs,
    source: worker.source,
    caller: worker.caller,
    observeAccounts: worker.observeAccounts,
    programHash: worker.programHash,
    status: worker.status,
    output: worker.output,
    effects: worker.effects,
    ...(Object.prototype.hasOwnProperty.call(worker, "effectTransport") ? { effectTransport: worker.effectTransport } : {}),
  };
  if (!domainHashMatches("aloha/revm-execution-receipt/v1", receiptBody, worker.executionReceiptHash)
    || worker.executionReceiptHash !== payloadRecord(simulation?.simulation)?.executionReceiptHash
    || !same(worker.effectTransport, projection?.effectTransport)) return null;
  let decoded: Readonly<Record<string, unknown>> | null = null;
  try { decoded = payloadRecord(decodeCanonicalJson(effects.bytes)); } catch { return null; }
  if (!exactPayloadKeys(decoded, ["accounts", "before", "gasUsed", "output", "status", "preCalls", "tokenBalancesBefore", "tokenBalancesAfter"])
    || decoded?.status !== "returned" || decoded.output !== worker.output) return null;
  const gasUsed = canonicalUnsigned(decoded.gasUsed);
  const tokenBefore = independentTokenBalances(decoded.tokenBalancesBefore);
  const tokenAfter = independentTokenBalances(decoded.tokenBalancesAfter);
  if (gasUsed === null || gasUsed <= 0n || tokenBefore === null || tokenAfter === null) return null;
  return { gasUsed, tokenBefore, tokenAfter };
}

function validEconomicReceipt(value: unknown, chainId: unknown): boolean {
  const receipt = payloadRecord(value);
  const valuationFact = payloadRecord(receipt?.valuationFact);
  if (!exactPayloadKeys(receipt, ["kind", "gasUsed", "nextBlockBaseFeePerGas", "priorityFeePerGas", "effectiveGasPrice", "gasCostNative", "profitAsset", "grossProfitAmount", "valuationNumerator", "valuationDenominator", "valuationFactRoot", "valuationFact", "grossProfitNative", "bidCostNative", "netProfitNative", "minNetProfitNative", "verdict", "receiptRoot"])
    || receipt?.kind !== "aloha.economic-receipt-v1"
    || receipt?.verdict !== "positive-net-ev"
    || !positiveHash(receipt?.valuationFactRoot)
    || !exactPayloadKeys(valuationFact, ["kind", "ownerRef", "generationId", "source", "assetRef", "numerator", "denominator", "ownerImplementationHash", "valuationOwnerRegistryRoot", "qualifiedValuationOwnerSetRoot", "qualificationLeafDigest", "currentSourceObservationRoot", "factRoot"])
    || valuationFact?.kind !== "aloha.economic-valuation-fact-v1"
    || canonicalUnsigned(valuationFact.numerator) === null || canonicalUnsigned(valuationFact.denominator) === null
    || canonicalUnsigned(valuationFact.numerator)! <= 0n || canonicalUnsigned(valuationFact.denominator)! <= 0n
    || !positiveHash(valuationFact.ownerRef) || !positiveHash(valuationFact.ownerImplementationHash)
    || !positiveHash(valuationFact.valuationOwnerRegistryRoot) || !positiveHash(valuationFact.qualifiedValuationOwnerSetRoot)
    || !positiveHash(valuationFact.qualificationLeafDigest) || !positiveHash(valuationFact.currentSourceObservationRoot)
    || !positiveHash(valuationFact.factRoot)
    || receipt.valuationFactRoot !== valuationFact.factRoot
    || !domainHashMatches("aloha/economic-valuation-fact/v1", {
      kind: valuationFact.kind,
      ownerRef: valuationFact.ownerRef,
      generationId: valuationFact.generationId,
      source: valuationFact.source,
      assetRef: valuationFact.assetRef,
      numerator: valuationFact.numerator,
      denominator: valuationFact.denominator,
      ownerImplementationHash: valuationFact.ownerImplementationHash,
      valuationOwnerRegistryRoot: valuationFact.valuationOwnerRegistryRoot,
      qualifiedValuationOwnerSetRoot: valuationFact.qualifiedValuationOwnerSetRoot,
      qualificationLeafDigest: valuationFact.qualificationLeafDigest,
      currentSourceObservationRoot: valuationFact.currentSourceObservationRoot,
    }, valuationFact.factRoot)
    || !validAssetReference(receipt?.profitAsset, chainId)) return false;
  const fields = ["gasUsed", "nextBlockBaseFeePerGas", "priorityFeePerGas", "effectiveGasPrice", "gasCostNative", "grossProfitAmount", "valuationNumerator", "valuationDenominator", "grossProfitNative", "bidCostNative", "netProfitNative", "minNetProfitNative"] as const;
  const numbers = Object.fromEntries(fields.map((field) => [field, canonicalUnsigned(receipt[field])])) as Record<(typeof fields)[number], bigint | null>;
  if (fields.some((field) => numbers[field] === null)) return false;
  const gasUsed = numbers.gasUsed!;
  const baseFee = numbers.nextBlockBaseFeePerGas!;
  const priorityFee = numbers.priorityFeePerGas!;
  const effectiveGasPrice = numbers.effectiveGasPrice!;
  const gasCostNative = numbers.gasCostNative!;
  const grossProfitAmount = numbers.grossProfitAmount!;
  const numerator = numbers.valuationNumerator!;
  const denominator = numbers.valuationDenominator!;
  const grossProfitNative = numbers.grossProfitNative!;
  const bidCostNative = numbers.bidCostNative!;
  const netProfitNative = numbers.netProfitNative!;
  const minNetProfitNative = numbers.minNetProfitNative!;
  if (gasUsed <= 0n || grossProfitAmount <= 0n || numerator <= 0n || denominator <= 0n
    || effectiveGasPrice !== baseFee + priorityFee
    || gasCostNative !== gasUsed * effectiveGasPrice
    || grossProfitNative !== grossProfitAmount * numerator / denominator
    || netProfitNative !== grossProfitNative - gasCostNative - bidCostNative
    || netProfitNative <= minNetProfitNative || netProfitNative <= 0n) return false;
  const { receiptRoot: _receiptRoot, ...body } = receipt;
  return domainHashMatches("aloha/economic-receipt/v1", body, receipt.receiptRoot);
}

function economicMatchesIndependentEffects(input: Readonly<{
  receipt: unknown;
  observed: IndependentlyObservedEffectsV1;
  executionFacts: Readonly<Record<string, unknown>> | null;
  finalProjection: Readonly<Record<string, unknown>> | null;
  evaluatorBinding: EconomicEvaluatorBindingObservationV1;
  objectiveRef: unknown;
  generationId: unknown;
  source: unknown;
}>): boolean {
  const receipt = payloadRecord(input.receipt);
  const profitAsset = payloadRecord(receipt?.profitAsset);
  const valuationFact = payloadRecord(receipt?.valuationFact);
  const templates = input.evaluatorBinding.objectiveTemplates.map(payloadRecord);
  const template = templates.find(value => value?.objectiveRef === input.objectiveRef);
  const valuationOwners = input.evaluatorBinding.valuationOwners.map(payloadRecord);
  const valuationOwner = valuationOwners.find(value => value?.ownerRef === template?.valuationOwnerRef);
  const projectionInput = payloadRecord(input.finalProjection?.input);
  const block = payloadRecord(projectionInput?.block);
  const valuationNumerator = canonicalUnsigned(receipt?.valuationNumerator);
  const valuationDenominator = canonicalUnsigned(receipt?.valuationDenominator);
  const minNetGain = canonicalUnsigned(template?.minNetGain);
  const valuationOracle = resolveSixStepValuationOracle(valuationOwner?.ownerRef);
  if (!exactPayloadKeys(template, ["objectiveRef", "profitAsset", "profitAccount", "minNetGain", "maxGas", "maxValueAtRisk", "priorityFeePerGas", "bidCostNative", "valuationOwnerRef"])
    || !same(template?.profitAsset, receipt?.profitAsset)
    || typeof template?.profitAccount !== "string" || !/^0x[0-9a-f]{40}$/.test(template.profitAccount)
    || !validAssetReference(template?.profitAsset, input.source !== null && typeof input.source === "object" ? (input.source as Readonly<Record<string, unknown>>).chainId : null)
    || valuationOwner === null || valuationOwner === undefined
    || !exactPayloadKeys(valuationOwner, ["ownerRef", "implementationHash", "factSchemaRef", "implementationClosureRoot", "qualificationLeafDigest", "valuationOwnerRegistryRoot", "qualifiedValuationOwnerSetRoot"])
    || valuationOracle === null
    || template?.valuationOwnerRef !== valuationOracle.ownerRef
    || valuationOwner.implementationHash !== valuationOracle.implementationHash
    || valuationOwner.factSchemaRef !== valuationOracle.factSchemaRef
    || valuationFact?.generationId !== input.generationId || !same(valuationFact?.source, input.source)
    || valuationFact?.assetRef !== profitAsset?.assetRef
    || valuationFact?.ownerRef !== template?.valuationOwnerRef
    || valuationFact?.ownerRef !== valuationOwner.ownerRef
    || valuationFact?.ownerImplementationHash !== valuationOwner.implementationHash
    || valuationFact?.valuationOwnerRegistryRoot !== valuationOwner.valuationOwnerRegistryRoot
    || valuationFact?.qualifiedValuationOwnerSetRoot !== valuationOwner.qualifiedValuationOwnerSetRoot
    || valuationFact?.qualificationLeafDigest !== valuationOwner.qualificationLeafDigest
    || !valuationOracle.evaluate({
      profitAsset: profitAsset ?? Object.freeze({}),
      descriptor: valuationOwner,
      fact: valuationFact ?? Object.freeze({}),
      generationId: input.generationId,
      source: input.source,
    })
    || canonicalUnsigned(block?.baseFeePerGas) === null
    || receipt?.nextBlockBaseFeePerGas !== block?.baseFeePerGas
    || receipt?.priorityFeePerGas !== template.priorityFeePerGas
    || receipt?.bidCostNative !== template.bidCostNative
    || valuationNumerator === null || valuationDenominator === null || valuationDenominator <= 0n
    || minNetGain === null
    || receipt?.minNetProfitNative !== (minNetGain * valuationNumerator / valuationDenominator).toString(10)
    || receipt?.valuationNumerator !== valuationFact?.numerator
    || receipt?.valuationDenominator !== valuationFact?.denominator
    || canonicalUnsigned(receipt?.gasUsed) !== input.observed.gasUsed) return false;
  const references = Array.isArray(input.executionFacts?.routeAssetReferences)
    ? input.executionFacts.routeAssetReferences.map(payloadRecord)
    : [];
  if (references.length === 0 || new Set(references.map(value => value?.assetRef)).size !== references.length
    || !references.some(value => value?.assetRef === profitAsset?.assetRef && same(value, receipt?.profitAsset))) return false;
  let profitDelta: bigint | null = null;
  for (const reference of references) {
    const routeIdentity = payloadRecord(reference?.identity);
    if (routeIdentity?.kind !== "erc20" || typeof routeIdentity.address !== "string" || !/^0x[0-9a-f]{40}$/.test(routeIdentity.address)) return false;
    const key = `${routeIdentity.address}\u0000${template.profitAccount}`;
    const before = input.observed.tokenBefore.get(key);
    const after = input.observed.tokenAfter.get(key);
    if (before === undefined || after === undefined) return false;
    const delta = after - before;
    if (reference?.assetRef === profitAsset?.assetRef) profitDelta = delta;
    else if (delta !== 0n) return false;
  }
  return profitDelta !== null && profitDelta > 0n && receipt?.grossProfitAmount === profitDelta.toString(10);
}

function independentlyRecomputeRouteSafety(input: Readonly<{
  executionFacts: Readonly<Record<string, unknown>> | null;
  finalFacts: Readonly<Record<string, unknown>> | null;
  evaluatorBinding: EconomicEvaluatorBindingObservationV1;
  objectiveRef: unknown;
  observed: IndependentlyObservedEffectsV1;
}>): IndependentRouteSafetyV1 | null {
  if (!positiveHash(input.objectiveRef)) return null;
  const templates = input.evaluatorBinding.objectiveTemplates.map(payloadRecord);
  const template = templates.find(value => value?.objectiveRef === input.objectiveRef);
  if (!exactPayloadKeys(template, ["objectiveRef", "profitAsset", "profitAccount", "minNetGain", "maxGas", "maxValueAtRisk", "priorityFeePerGas", "bidCostNative", "valuationOwnerRef"])
    || typeof template?.profitAccount !== "string" || !/^0x[0-9a-f]{40}$/.test(template.profitAccount)) return null;
  const rawActions = input.executionFacts?.actionOwners;
  if (!Array.isArray(rawActions) || rawActions.length === 0) return null;
  const actions: Array<{
    readonly familyDefinitionHash: Hash;
    readonly actionOwnerId: string;
    readonly actionOwnerRef: Hash;
    readonly actionHash: Hash;
    readonly obligationRoot: Hash;
    readonly input: Readonly<{ readonly assetRef: Hash; readonly amount: bigint }>;
    readonly output: Readonly<{ readonly assetRef: Hash; readonly amount: bigint }>;
  }> = [];
  for (const raw of rawActions) {
    const action = payloadRecord(raw);
    if (!exactPayloadKeys(action, ["familyDefinitionHash", "routeBindingHash", "actionOwnerId", "actionOwnerRef", "actionHash", "actionArtifactHash", "exactEvaluationHash", "payload", "payloadHash", "inputs", "outputs", "obligationRoot"])
      || !positiveHash(action?.familyDefinitionHash) || typeof action?.actionOwnerId !== "string" || action.actionOwnerId.length === 0
      || !positiveHash(action?.actionOwnerRef) || !positiveHash(action?.actionHash) || !positiveHash(action?.obligationRoot)
      || !Array.isArray(action?.inputs) || action.inputs.length !== 1
      || !Array.isArray(action?.outputs) || action.outputs.length !== 1) return null;
    const amount = (value: unknown): Readonly<{ readonly assetRef: Hash; readonly amount: bigint }> | null => {
      const item = payloadRecord(value);
      const quantity = canonicalUnsigned(item?.amount);
      return exactPayloadKeys(item, ["assetRef", "amount"]) && positiveHash(item?.assetRef) && quantity !== null && quantity > 0n
        ? Object.freeze({ assetRef: item.assetRef, amount: quantity })
        : null;
    };
    const actionInput = amount(action.inputs[0]);
    const actionOutput = amount(action.outputs[0]);
    if (actionInput === null || actionOutput === null) return null;
    actions.push(Object.freeze({
      familyDefinitionHash: action.familyDefinitionHash,
      actionOwnerId: action.actionOwnerId,
      actionOwnerRef: action.actionOwnerRef,
      actionHash: action.actionHash,
      obligationRoot: action.obligationRoot,
      input: actionInput,
      output: actionOutput,
    }));
  }
  for (let index = 1; index < actions.length; index += 1) {
    if (actions[index - 1]!.output.assetRef !== actions[index]!.input.assetRef
      || actions[index - 1]!.output.amount !== actions[index]!.input.amount) return null;
  }
  const profitAsset = payloadRecord(template.profitAsset);
  if (!positiveHash(profitAsset?.assetRef)
    || actions[0]!.input.assetRef !== profitAsset.assetRef
    || actions[actions.length - 1]!.output.assetRef !== profitAsset.assetRef) return null;
  const references = Array.isArray(input.executionFacts?.routeAssetReferences)
    ? input.executionFacts.routeAssetReferences.map(payloadRecord)
    : [];
  const referencesByAsset = new Map<Hash, Readonly<Record<string, unknown>>>();
  for (const reference of references) {
    if (!positiveHash(reference?.assetRef) || referencesByAsset.has(reference.assetRef)) return null;
    referencesByAsset.set(reference.assetRef, reference!);
  }
  const routeAssetRefs: Hash[] = [];
  for (const action of actions) {
    for (const assetRef of [action.input.assetRef, action.output.assetRef]) {
      if (!routeAssetRefs.includes(assetRef)) routeAssetRefs.push(assetRef);
    }
  }
  const deltas: Array<Readonly<{ readonly assetRef: Hash; readonly before: string; readonly after: string; readonly delta: string }>> = [];
  for (const assetRef of routeAssetRefs) {
    const reference = referencesByAsset.get(assetRef);
    const identity = payloadRecord(reference?.identity);
    if (reference === undefined || identity?.kind !== "erc20" || typeof identity.address !== "string" || !/^0x[0-9a-f]{40}$/.test(identity.address)) return null;
    const key = `${identity.address}\u0000${template.profitAccount}`;
    const before = input.observed.tokenBefore.get(key);
    const after = input.observed.tokenAfter.get(key);
    if (before === undefined || after === undefined) return null;
    const delta = after - before;
    if (assetRef !== profitAsset.assetRef && delta !== 0n) return null;
    deltas.push(Object.freeze({ assetRef, before: before.toString(10), after: after.toString(10), delta: delta.toString(10) }));
  }
  const worker = payloadRecord(input.finalFacts?.workerReceipt);
  const effects = payloadRecord(worker?.effects);
  if (!positiveHash(worker?.executionReceiptHash) || !positiveHash(effects?.effectsHash)) return null;
  return Object.freeze({
    routeProof: Object.freeze({
      objectiveRef: input.objectiveRef,
      actionHashes: Object.freeze(actions.map(action => action.actionHash)),
      executionReceiptHash: worker.executionReceiptHash,
      effectsHash: effects.effectsHash,
      deltas: Object.freeze(deltas),
    }),
    actions: Object.freeze(actions.map(action => Object.freeze({
      familyDefinitionHash: action.familyDefinitionHash,
      actionOwnerId: action.actionOwnerId,
      actionOwnerRef: action.actionOwnerRef,
      actionHash: action.actionHash,
      obligationRoot: action.obligationRoot,
    }))),
  });
}

function qualifiedSafetyProfile(binding: EconomicEvaluatorBindingObservationV1): Readonly<{
  profile: Readonly<Record<string, unknown>>;
  claims: readonly Readonly<Record<string, unknown>>[];
  policies: readonly Readonly<Record<string, unknown>>[];
}> | null {
  const profile = payloadRecord(binding.safetyProfile);
  if (!exactPayloadKeys(profile, ["schemaVersion", "kind", "profileRef", "requiredClaims", "qualifiedOwnerSetRoot", "profileCompositionRoot"])
    || profile?.schemaVersion !== 1 || profile?.kind !== "aloha.economic-safety-profile"
    || !positiveHash(profile.profileRef) || !positiveHash(profile.qualifiedOwnerSetRoot)
    || !Array.isArray(profile.requiredClaims) || profile.requiredClaims.length === 0) return null;
  const claims = profile.requiredClaims.map(payloadRecord);
  if (claims.some(claim => !exactPayloadKeys(claim, ["claimSchemaRef", "ownerRef", "qualificationLeafDigest", "revmObservationSchemaRef"])
    || !positiveHash(claim?.claimSchemaRef) || !positiveHash(claim?.ownerRef)
    || !positiveHash(claim?.qualificationLeafDigest)
    || claim?.revmObservationSchemaRef !== ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF)) return null;
  for (let index = 1; index < claims.length; index += 1) {
    const left = claims[index - 1]!;
    const right = claims[index]!;
    if (`${left.ownerRef}\u0000${left.claimSchemaRef}` >= `${right.ownerRef}\u0000${right.claimSchemaRef}`) return null;
  }
  const profileBody = {
    schemaVersion: 1,
    kind: "aloha.economic-safety-profile",
    profileRef: profile.profileRef,
    requiredClaims: profile.requiredClaims,
    qualifiedOwnerSetRoot: profile.qualifiedOwnerSetRoot,
  };
  if (!domainHashMatches("aloha/economic-safety-profile-composition/v1", profileBody, profile.profileCompositionRoot)) return null;
  const policies = binding.actionOwners.map(payloadRecord);
  if (policies.some(policy => !exactPayloadKeys(policy, [
    "familyDefinitionHash", "ownerId", "ownerRef", "implementationHash", "schemaRef",
    "implementationClosureRoot", "claimSchemaRefs", "qualificationLeafDigest", "verifierHash",
  ]) || !positiveHash(policy?.familyDefinitionHash) || typeof policy?.ownerId !== "string" || policy.ownerId.length === 0
    || !positiveHash(policy?.ownerRef) || !positiveHash(policy?.implementationHash) || !positiveHash(policy?.schemaRef)
    || !positiveHash(policy?.implementationClosureRoot) || !positiveHash(policy?.qualificationLeafDigest)
    || !positiveHash(policy?.verifierHash) || !Array.isArray(policy?.claimSchemaRefs) || policy.claimSchemaRefs.length === 0)) return null;
  if (new Set(policies.map(policy => policy!.ownerRef)).size !== policies.length) return null;
  for (const policy of policies) {
    const schemaRefs = policy!.claimSchemaRefs as readonly unknown[];
    if (schemaRefs.some(schema => !positiveHash(schema))) return null;
    for (let index = 1; index < schemaRefs.length; index += 1) if (schemaRefs[index - 1]! >= schemaRefs[index]!) return null;
    const ownerClaims = claims.filter(claim => claim?.ownerRef === policy!.ownerRef);
    if (ownerClaims.length !== schemaRefs.length || ownerClaims.some((claim, index) =>
      claim?.claimSchemaRef !== schemaRefs[index] || claim?.qualificationLeafDigest !== policy!.qualificationLeafDigest)) return null;
  }
  if (new Set(claims.map(claim => claim!.ownerRef)).size !== policies.length
    || claims.some(claim => !policies.some(policy => policy!.ownerRef === claim!.ownerRef))) return null;
  return Object.freeze({ profile: profile!, claims: Object.freeze(claims as Readonly<Record<string, unknown>>[]), policies: Object.freeze(policies as Readonly<Record<string, unknown>>[]) });
}

function validEconomicSafetyBinding(input: Readonly<{
  economicSafety: unknown;
  economicWitness: unknown;
  safetyWitness: unknown;
  executionOwnerEvidence: unknown;
  finalOwnerEvidence: unknown;
  program: unknown;
  simulation: unknown;
  correlationId: unknown;
  generationId: unknown;
  source: unknown;
  exactHash: unknown;
  evaluatorBinding: EconomicEvaluatorBindingObservationV1;
}>): boolean {
  const evidence = payloadRecord(input.economicSafety);
  const executionEvidence = payloadRecord(input.executionOwnerEvidence);
  const finalEvidence = payloadRecord(input.finalOwnerEvidence);
  const executionFacts = payloadRecord(executionEvidence?.facts);
  const finalFacts = payloadRecord(finalEvidence?.facts);
  const program = payloadRecord(input.program);
  const simulation = payloadRecord(input.simulation);
  if (!exactPayloadKeys(evidence, ["schemaVersion", "kind", "authorityRoot", "implementationHash", "releaseProvenanceHash", "correlationId", "generationId", "source", "objectiveRef", "exactHash", "programHash", "obligationRoot", "finalSimulationReceiptHash", "effectsHash", "executionOwnerEvidenceRoot", "finalSimulationOwnerEvidenceRoot", "executionOwnerFacts", "executionOwnerFactsRoot", "finalSimulationOwnerFacts", "finalSimulationOwnerFactsRoot", "declaredObligations", "declaredObligationSetRoot", "economic", "safety", "dryRun", "evidenceRoot"])
    || evidence?.schemaVersion !== 1 || evidence?.kind !== "aloha.economic-safety-finalization-evidence-v1" || evidence?.dryRun !== true
    || evidence.authorityRoot !== input.evaluatorBinding.authorityRoot
    || evidence.implementationHash !== input.evaluatorBinding.implementationHash
    || evidence.releaseProvenanceHash !== input.evaluatorBinding.releaseProvenanceHash
    || !positiveHash(evidence.objectiveRef)
    || evidence.correlationId !== input.correlationId || evidence.generationId !== input.generationId || !same(evidence.source, input.source)
    || evidence.exactHash !== input.exactHash || evidence.programHash !== program?.programHash || evidence.obligationRoot !== program?.obligationRoot
    || evidence.finalSimulationReceiptHash !== simulation?.receiptHash || evidence.effectsHash !== simulation?.effectsHash
    || evidence.executionOwnerEvidenceRoot !== executionEvidence?.evidenceRoot || evidence.finalSimulationOwnerEvidenceRoot !== finalEvidence?.evidenceRoot
    || !same(evidence.executionOwnerFacts, executionEvidence?.facts) || !same(evidence.finalSimulationOwnerFacts, finalEvidence?.facts)
    || !domainHashMatches("aloha/economic-safety/execution-owner-facts/v1", evidence.executionOwnerFacts, evidence.executionOwnerFactsRoot)
    || !domainHashMatches("aloha/economic-safety/final-simulation-owner-facts/v1", evidence.finalSimulationOwnerFacts, evidence.finalSimulationOwnerFactsRoot)) return false;

  const executionEvidenceKeys = Object.prototype.hasOwnProperty.call(executionEvidence, "ownerObservation")
    ? ["schemaVersion", "kind", "correlationId", "generationId", "source", "routeHash", "exactHash", "programHash", "facts", "ownerObservation", "evidenceRoot"]
    : ["schemaVersion", "kind", "correlationId", "generationId", "source", "routeHash", "exactHash", "programHash", "facts", "evidenceRoot"];
  if (!exactPayloadKeys(executionEvidence, executionEvidenceKeys)
    || executionEvidence?.schemaVersion !== 1 || executionEvidence?.kind !== "aloha.execution-program-six-step-evidence-v1") return false;
  const { evidenceRoot: _executionRoot, ...executionBody } = executionEvidence;
  if (!domainHashMatches("aloha/execution-program-six-step-evidence/v1", executionBody, executionEvidence.evidenceRoot)
    || !exactPayloadKeys(finalEvidence, ["schemaVersion", "kind", "correlationId", "generationId", "source", "programHash", "finalSimulationReceiptHash", "facts", "evidenceRoot"])
    || finalEvidence?.schemaVersion !== 1 || finalEvidence?.kind !== "aloha.final-simulation-six-step-evidence-v1") return false;
  const { evidenceRoot: _finalRoot, ...finalBody } = finalEvidence;
  if (!domainHashMatches("aloha/final-simulation-six-step-evidence/v1", finalBody, finalEvidence.evidenceRoot)) return false;

  if (!Array.isArray(evidence.declaredObligations) || evidence.declaredObligations.length === 0
    || !same(evidence.declaredObligations, executionFacts?.declaredObligations)
    || !domainHashMatches("aloha/economic-safety/declared-obligation-set/v1", evidence.declaredObligations, evidence.declaredObligationSetRoot)) return false;
  const declarations = evidence.declaredObligations.map((value) => payloadRecord(value));
  if (declarations.some((value) => !exactPayloadKeys(value, ["obligationRef", "ownerRef", "policy"]) || !positiveHash(value?.obligationRef) || !positiveHash(value?.ownerRef) || value?.policy !== "must-satisfy")) return false;
  if (new Set(declarations.map((value) => value!.obligationRef)).size !== declarations.length
    || !domainHashMatches("aloha/search-runtime-obligation-root/v1", declarations.map((value) => value!.obligationRef), program?.obligationRoot)
    || executionFacts?.obligationRoot !== program?.obligationRoot) return false;
  const actionOwners = Array.isArray(executionFacts?.actionOwners) ? executionFacts.actionOwners.map(payloadRecord) : [];
  for (const declaration of declarations) {
    if (actionOwners.filter((owner) => owner?.obligationRoot === declaration?.obligationRef && owner?.actionOwnerRef === declaration?.ownerRef).length !== 1) return false;
  }

  const transport = program?.effectTransport;
  const finalProjection = payloadRecord(finalFacts?.projection);
  const worker = payloadRecord(finalFacts?.workerReceipt);
  const workerEffects = payloadRecord(worker?.effects);
  if (!validEffectTransport(transport)
    || !same(simulation?.effectTransport, transport)
    || !validEffectCaller(payloadRecord(transport)?.caller)) return false;
  const caller = payloadRecord(payloadRecord(transport)?.caller);
  if (executionFacts?.callerMode !== caller?.executionMode
    || !same(executionFacts?.preCalls, payloadRecord(transport)?.preCalls)
    || !same(executionFacts?.observationPairs, payloadRecord(transport)?.observeTokenBalances)
    || executionFacts?.observeLogs !== payloadRecord(transport)?.observeLogs
    || !same(finalProjection?.effectTransport, transport)
    || !same(worker?.effectTransport, transport)
    || workerEffects?.effectsHash !== simulation?.effectsHash) return false;

  const independentlyObserved = independentlyVerifyWorkerReceipt(
    finalFacts,
    input.generationId,
    input.source,
    program?.programHash,
    simulation,
    input.evaluatorBinding,
  );
  if (independentlyObserved === null) return false;

  if (!same(input.economicWitness, evidence.economic)
    || !validEconomicReceipt(evidence.economic, payloadRecord(input.source)?.chainId)
    || !economicMatchesIndependentEffects({
      receipt: evidence.economic,
      observed: independentlyObserved,
      executionFacts,
      finalProjection,
      evaluatorBinding: input.evaluatorBinding,
      objectiveRef: evidence.objectiveRef,
      generationId: input.generationId,
      source: input.source,
    })) return false;
  const independentSafety = independentlyRecomputeRouteSafety({
    executionFacts,
    finalFacts,
    evaluatorBinding: input.evaluatorBinding,
    objectiveRef: evidence.objectiveRef,
    observed: independentlyObserved,
  });
  if (independentSafety === null) return false;
  const qualified = qualifiedSafetyProfile(input.evaluatorBinding);
  if (qualified === null) return false;
  const safety = payloadRecord(evidence.safety);
  if (!exactPayloadKeys(safety, [
    "kind", "obligationRoot", "obligationReceipts", "obligationReceiptSetRoot", "safetyProfileRef", "safetyProfileRoot",
    "selectedRequiredClaims", "requiredClaimSetRoot", "revmObservationSchemaRef", "revmObservationRoot",
    "assetConservationProofRoot", "assetConservation", "verdict", "receiptRoot",
  ])
    || safety?.kind !== "aloha.final-safety-receipt-v1" || safety?.verdict !== "safe" || safety?.assetConservation !== "satisfied"
    || safety?.obligationRoot !== program?.obligationRoot
    || safety.safetyProfileRef !== qualified.profile.profileRef
    || safety.safetyProfileRoot !== qualified.profile.profileCompositionRoot
    || safety.revmObservationSchemaRef !== ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF
    || safety.assetConservationProofRoot !== hashDomain("aloha/economic-safety/asset-conservation-proof/v1", independentSafety.routeProof)
    || !Array.isArray(safety.selectedRequiredClaims)
    || !Array.isArray(safety.obligationReceipts)) return false;
  const selectedOwnerRefs = [...new Set(independentSafety.actions.map(action => action.actionOwnerRef))].sort();
  const selectedClaims = qualified.claims.filter(claim => selectedOwnerRefs.includes(claim.ownerRef as Hash));
  if (!same(safety.selectedRequiredClaims, selectedClaims)
    || !domainHashMatches("aloha/economic-safety-selected-required-claim-set/v1", selectedClaims, safety.requiredClaimSetRoot)) return false;
  const workerReceipt = payloadRecord(finalFacts?.workerReceipt);
  const workerReceiptEffects = payloadRecord(workerReceipt?.effects);
  if (!positiveHash(workerReceipt?.executionReceiptHash) || !positiveHash(workerReceiptEffects?.effectsHash)
    || !domainHashMatches("aloha/economic-safety/revm-observation/v1", {
      schemaRef: ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF,
      executorQualification: input.evaluatorBinding.executorQualification,
      source: input.source,
      executionReceiptHash: workerReceipt.executionReceiptHash,
      effectsHash: workerReceiptEffects.effectsHash,
    }, safety.revmObservationRoot)) return false;
  const receipts = safety.obligationReceipts.map(payloadRecord);
  if (receipts.some((receipt) => !exactPayloadKeys(receipt, ["schemaRef", "ownerRef", "qualificationLeafDigest", "verifierHash", "subjectRoot", "proofRoot", "outcome", "receiptRoot"])
    || !positiveHash(receipt?.schemaRef) || !positiveHash(receipt?.ownerRef) || !positiveHash(receipt?.qualificationLeafDigest)
    || !positiveHash(receipt?.verifierHash) || !positiveHash(receipt?.subjectRoot) || !positiveHash(receipt?.proofRoot) || receipt?.outcome !== "satisfied")) return false;
  const receiptKeys = receipts.map(receipt => `${receipt?.subjectRoot}\u0000${receipt?.ownerRef}\u0000${receipt?.schemaRef}`);
  if (new Set(receiptKeys).size !== receipts.length) return false;
  for (const receipt of receipts) {
    const { receiptRoot: _root, ...body } = receipt!;
    if (!domainHashMatches("aloha/safety-obligation-receipt/v1", body, receipt!.receiptRoot)) return false;
  }
  let expectedReceiptCount = 0;
  for (const declaration of declarations) {
    const action = independentSafety.actions.find(value => value.obligationRoot === declaration?.obligationRef && value.actionOwnerRef === declaration?.ownerRef);
    const policy = qualified.policies.find(value => value?.familyDefinitionHash === action?.familyDefinitionHash
      && value?.ownerId === action?.actionOwnerId && value?.ownerRef === action?.actionOwnerRef);
    const claims = selectedClaims.filter(claim => claim.ownerRef === declaration?.ownerRef);
    if (action === undefined || policy === undefined || claims.length === 0) return false;
    expectedReceiptCount += claims.length;
    for (const claim of claims) {
      if (receipts.filter((receipt) => receipt?.subjectRoot === declaration?.obligationRef
        && receipt?.ownerRef === declaration?.ownerRef
        && receipt?.schemaRef === claim.claimSchemaRef
        && receipt?.qualificationLeafDigest === claim.qualificationLeafDigest
        && receipt?.verifierHash === policy.verifierHash
        && receipt?.outcome === "satisfied").length !== 1) return false;
    }
  }
  if (receipts.length !== expectedReceiptCount) return false;
  if (!domainHashMatches("aloha/safety-obligation-receipt-set/v1", receipts.map((receipt) => receipt!.receiptRoot), safety.obligationReceiptSetRoot)) return false;
  const { receiptRoot: _safetyRoot, ...safetyBody } = safety;
  if (!domainHashMatches("aloha/final-safety-receipt/v1", safetyBody, safety.receiptRoot)
    || !same(input.safetyWitness, { safety: evidence.safety })) return false;
  const { evidenceRoot: _evidenceRoot, ...evidenceBody } = evidence;
  return domainHashMatches("aloha/economic-safety-finalization-evidence/v1", evidenceBody, evidence.evidenceRoot);
}

function requireQualifiedLease(
  ref: ReadOnlyArtifactRefV1,
  leasesById: ReadonlyMap<Hash, RetentionLeaseReceiptV1>,
  reasons: SixStepReasonV1[],
  path: string,
): void {
  const lease = leasesById.get(ref.retentionLeaseReceiptId);
  if (
    lease === undefined
    || lease.storeIdentityHash !== ref.immutableMirrorLocator.storeIdentityHash
    || lease.objectKey !== ref.immutableMirrorLocator.objectKey
    || lease.contentSha256 !== ref.contentSha256
    || !positiveHash(lease.issuerQualificationId)
    || !positiveHash(lease.qualificationRegistryRoot)
  ) add(reasons, "observation-mismatch", `${path}.qualifiedLease`);
}

function decodeObservedObject<T>(
  refId: Hash,
  refsById: ReadonlyMap<Hash, ReadOnlyArtifactRefV1>,
  claimsByRef: ReadonlyMap<Hash, ArtifactResolutionClaimV1>,
  decode: (bytes: Uint8Array) => T,
  reasons: SixStepReasonV1[],
  path: string,
): { readonly value: T; readonly claimId: Hash } | null {
  const ref = refsById.get(refId);
  const claim = claimsByRef.get(refId);
  if (ref === undefined) {
    add(reasons, "artifact-ref-mismatch", `${path}.artifactRefId`);
    return null;
  }
  if (claim === undefined || claim.outcome !== "content-observed" || claim.observedMirror === null) {
    add(reasons, "artifact-claim-mismatch", `${path}.claim`);
    return null;
  }
  const mirror = claim.observedMirror;
  let bytes: Uint8Array;
  try {
    bytes = decodeArtifactBytes(mirror.bytes);
  } catch {
    add(reasons, "predicate-observation-mismatch", `${path}.bytes`);
    return null;
  }
  if (
    claim.resolverPolicyHash !== ref.resolverPolicyHash ||
    mirror.storeIdentityHash !== ref.immutableMirrorLocator.storeIdentityHash ||
    mirror.contentSha256 !== ref.contentSha256 ||
    mirror.byteLength !== ref.byteLength ||
    mirror.objectKey !== ref.immutableMirrorLocator.objectKey ||
    mirror.mediaType !== ref.mediaType ||
    !same(mirror.schema, ref.schema) ||
    sha256Hex(bytes) !== ref.contentSha256
  ) {
    add(reasons, "artifact-claim-mismatch", `${path}.mirror`);
    return null;
  }
  try {
    return Object.freeze({ value: decode(bytes), claimId: claim.claimId });
  } catch {
    add(reasons, "predicate-observation-mismatch", `${path}.bytes`);
    return null;
  }
}

function requireObservation(
  refId: Hash,
  claimId: Hash,
  observations: SixStepRuntimeFactsV1["observations"],
  reasons: SixStepReasonV1[],
  path: string,
): void {
  if (!observations.some((observation) =>
    observation.rawArtifactRefs.some((ref) => ref.artifactRefId === refId) &&
    observation.observedClaimIds.includes(claimId),
  )) add(reasons, "observation-mismatch", path);
}

function verifyStageWitness(
  witness: SixStepEvidenceWitnessV1,
  stageId: SixStepStageFactsV1["stageId"],
  role: string,
  runtime: SixStepRuntimeFactsV1,
  refsById: ReadonlyMap<Hash, ReadOnlyArtifactRefV1>,
  claimsByRef: ReadonlyMap<Hash, ArtifactResolutionClaimV1>,
  leasesById: ReadonlyMap<Hash, RetentionLeaseReceiptV1>,
  reasons: SixStepReasonV1[],
  path: string,
): CanonicalJsonObject | null {
  const observed = decodeObservedObject(
    witness.artifactRefId,
    refsById,
    claimsByRef,
    decodeSixStepWitnessContent,
    reasons,
    path,
  );
  const ref = refsById.get(witness.artifactRefId);
  if (ref !== undefined) requireQualifiedLease(ref, leasesById, reasons, path);
  if (observed === null) return null;
  requireObservation(witness.artifactRefId, observed.claimId, runtime.observations, reasons, `${path}.observation`);
  if (
    observed.value.stageId !== stageId
    || observed.value.role !== role
    || hashSixStepWitnessContentRoot(observed.value) !== witness.contentRoot
  ) add(reasons, "predicate-observation-mismatch", `${path}.contentRoot`);
  return observed.value.payload;
}

function verifyStageWitnesses(
  facts: SixStepStageFactsV1,
  runtime: SixStepRuntimeFactsV1,
  refsById: ReadonlyMap<Hash, ReadOnlyArtifactRefV1>,
  claimsByRef: ReadonlyMap<Hash, ArtifactResolutionClaimV1>,
  leasesById: ReadonlyMap<Hash, RetentionLeaseReceiptV1>,
  reasons: SixStepReasonV1[],
  path: string,
): Readonly<Record<string, CanonicalJsonObject>> {
  const witnesses: readonly [SixStepEvidenceWitnessV1, string][] = (() => {
    switch (facts.stageId) {
      case "universe_instance": return [[facts.candidatePartition, "candidate-partition"], [facts.instancePublication, "instance-publication"], [facts.identityProof, "identity-proof"], [facts.sourceCoverage, "source-coverage"]];
      case "edge_ready_generation": return [[facts.instancePublication, "instance-publication"], [facts.edge, "edge"], [facts.coverage, "coverage"], [facts.memoReuseProof, "memo-reuse-proof"]];
      case "planner_consumption": return [[facts.routeSet, "route-set"], [facts.coarseProjection, "coarse-projection"], [facts.admissionReceipt, "admission-receipt"]];
      case "current_source_exact": return [[facts.exactOutput, "exact-output"]];
      case "execution_program": return [[facts.program, "program"], [facts.preCalls, "pre-calls"], [facts.observationPairs, "observation-pairs"], [facts.actionOwner, "action-owner"]];
      case "final_simulation": return [[facts.finalSimulationReceipt, "final-simulation-receipt"], [facts.economicReceipt, "economic-receipt"], [facts.safetyReceipt, "safety-receipt"]];
    }
  })();
  const payloads: Record<string, CanonicalJsonObject> = {};
  for (const [witness, role] of witnesses) {
    const witnessStageId = facts.stageId === "edge_ready_generation" && role === "instance-publication"
      ? "universe_instance"
      : facts.stageId;
    const payload = verifyStageWitness(witness, witnessStageId, role, runtime, refsById, claimsByRef, leasesById, reasons, `${path}.${role}`);
    if (payload !== null) payloads[role] = payload;
  }
  return Object.freeze(payloads);
}

function decodeOne(
  rawFact: unknown,
  index: number,
  runtime: SixStepRuntimeFactsV1,
  refsById: ReadonlyMap<Hash, ReadOnlyArtifactRefV1>,
  claimsByRef: ReadonlyMap<Hash, ArtifactResolutionClaimV1>,
  leasesById: ReadonlyMap<Hash, RetentionLeaseReceiptV1>,
  reasons: SixStepReasonV1[],
): DecodedEventV1 | null {
  const path = `$.predicateFacts[${index}]`;
  let fact: SixStepEventFactV1;
  try {
    fact = decodeSixStepEventFact(rawFact as object);
  } catch {
    add(reasons, "predicate-observation-mismatch", path);
    return null;
  }
  const event = decodeObservedObject(fact.eventArtifactRefId, refsById, claimsByRef, decodeEvidenceEvent, reasons, `${path}.event`);
  const semantic = decodeObservedObject(fact.semanticArtifactRefId, refsById, claimsByRef, decodeSemanticArtifact, reasons, `${path}.semanticArtifact`);
  const receipt = decodeObservedObject(fact.productionReceiptArtifactRefId, refsById, claimsByRef, decodeProductionReceipt, reasons, `${path}.productionReceipt`);
  if (event === null || semantic === null || receipt === null) return null;
  const rawBoundary = decodeObservedObject(receipt.value.rawBoundaryArtifactRef.artifactRefId, refsById, claimsByRef, decodeSixStepNativeBoundaryRecord, reasons, `${path}.rawBoundary`);
  if (rawBoundary === null) return null;
  requireObservation(fact.eventArtifactRefId, event.claimId, runtime.observations, reasons, `${path}.event.observation`);
  requireObservation(fact.semanticArtifactRefId, semantic.claimId, runtime.observations, reasons, `${path}.semanticArtifact.observation`);
  requireObservation(fact.productionReceiptArtifactRefId, receipt.claimId, runtime.observations, reasons, `${path}.productionReceipt.observation`);
  requireObservation(receipt.value.rawBoundaryArtifactRef.artifactRefId, rawBoundary.claimId, runtime.observations, reasons, `${path}.rawBoundary.observation`);
  let stageFacts: SixStepStageFactsV1;
  try {
    if (!same(event.value.factSchema, stageFactsSchemaRef())) throw new TypeError("stage fact schema mismatch");
    stageFacts = decodeSixStepStageFacts(event.value.facts as object);
    if (stageFacts.stageId !== event.value.stage.id) throw new TypeError("stage fact discriminator mismatch");
  } catch {
    add(reasons, "predicate-observation-mismatch", `${path}.event.facts`);
    return null;
  }
  const witnessPayloads = verifyStageWitnesses(stageFacts, runtime, refsById, claimsByRef, leasesById, reasons, `${path}.event.facts`);
  if (rawBoundary.value.stageId !== stageFacts.stageId || rawBoundary.value.role !== "raw-boundary") {
    add(reasons, "predicate-observation-mismatch", `${path}.rawBoundary.stage`);
  }
  if (
    event.value.artifactLineage.outputArtifactId !== semantic.value.artifactId ||
    event.value.artifactLineage.productionReceiptId !== receipt.value.receiptId ||
    !same(event.value.artifactLineage.inputArtifactIds, semantic.value.inputArtifactIds) ||
    receipt.value.artifactId !== semantic.value.artifactId ||
    event.value.outputHash !== semantic.value.canonicalPayloadHash
  ) {
    add(reasons, "production-receipt-mismatch", `${path}.lineage`);
  }
  try {
    assertEvidenceEventMatchesReceipt(event.value, receipt.value);
  } catch {
    add(reasons, "production-receipt-mismatch", `${path}.receipt`);
  }
  for (const inputArtifactId of semantic.value.inputArtifactIds) {
    if (!refsById.has(inputArtifactId) || !claimsByRef.has(inputArtifactId)) add(reasons, "artifact-ref-mismatch", `${path}.semanticArtifact.inputArtifactIds`);
  }
  try {
    const input = decodeSixStepStageInput(event.value.inputs);
    const witnessArtifactRefIds = (() => {
      switch (stageFacts.stageId) {
        case "universe_instance": return [stageFacts.candidatePartition.artifactRefId, stageFacts.instancePublication.artifactRefId, stageFacts.identityProof.artifactRefId, stageFacts.sourceCoverage.artifactRefId];
        case "edge_ready_generation": return [stageFacts.instancePublication.artifactRefId, stageFacts.edge.artifactRefId, stageFacts.coverage.artifactRefId, stageFacts.memoReuseProof.artifactRefId];
        case "planner_consumption": return [stageFacts.routeSet.artifactRefId, stageFacts.coarseProjection.artifactRefId, stageFacts.admissionReceipt.artifactRefId];
        case "current_source_exact": return [stageFacts.exactOutput.artifactRefId];
        case "execution_program": return [stageFacts.program.artifactRefId, stageFacts.preCalls.artifactRefId, stageFacts.observationPairs.artifactRefId, stageFacts.actionOwner.artifactRefId];
        case "final_simulation": return [stageFacts.finalSimulationReceipt.artifactRefId, stageFacts.economicReceipt.artifactRefId, stageFacts.safetyReceipt.artifactRefId];
      }
    })();
    const expectedInputs = [receipt.value.rawBoundaryArtifactRef.artifactRefId, ...witnessArtifactRefIds];
    if (!same(event.value.inputSchema, stageInputSchemaRef())
      || input.stageId !== stageFacts.stageId
      || input.rawBoundaryArtifactRefId !== receipt.value.rawBoundaryArtifactRef.artifactRefId
      || !same(input.orderedWitnessArtifactRefIds, witnessArtifactRefIds)
      || !same(input.parentEventIds, event.value.parentEventIds)
      || !same(semantic.value.inputArtifactIds, expectedInputs)
      || !same(event.value.artifactLineage.inputArtifactIds, expectedInputs)) {
      add(reasons, "production-receipt-mismatch", `${path}.semanticInputs`);
    }
  } catch {
    add(reasons, "predicate-observation-mismatch", `${path}.event.inputs`);
  }
  for (const refId of [receipt.value.logRangeArtifactRef.artifactRefId, receipt.value.rawBoundaryArtifactRef.artifactRefId, event.value.source.rawBoundaryArtifactRef.artifactRefId]) {
    if (!refsById.has(refId) || !claimsByRef.has(refId)) add(reasons, "artifact-ref-mismatch", `${path}.receipt.rawRefs`);
  }
  return Object.freeze({
    fact,
    event: event.value,
    semantic: semantic.value,
    receipt: receipt.value,
    stageFacts,
    witnessPayloads,
    rawPayload: rawBoundary.value.payload,
    eventClaimId: event.claimId,
  });
}

function compareStage12(
  stage1: readonly DecodedEventV1[],
  stage2: readonly DecodedEventV1[],
  reasons: SixStepReasonV1[],
): void {
  if (stage1.length === 0 || stage1.length !== stage2.length) {
    add(reasons, "predicate-observation-missing", "$.predicateFacts.stage1-stage2");
    return;
  }
  const stage1ById = new Map(stage1.map((entry) => [entry.event.eventId, entry]));
  const used = new Set<Hash>();
  for (const [index, entry] of stage2.entries()) {
    const parentId = entry.event.parentEventIds.length === 1 ? entry.event.parentEventIds[0] : undefined;
    const parent = parentId === undefined ? undefined : stage1ById.get(parentId);
    if (parent === undefined || entry.event.parentOutputHashes.length !== 1 || entry.event.parentOutputHashes[0] !== parent.event.outputHash || used.has(parent.event.eventId)) {
      add(reasons, "predicate-observation-mismatch", `$.stage2[${index}].parent`);
      continue;
    }
    used.add(parent.event.eventId);
    const entryFacts = entry.stageFacts as Extract<SixStepStageFactsV1, { readonly stageId: "edge_ready_generation" }>;
    const parentFacts = parent.stageFacts as Extract<SixStepStageFactsV1, { readonly stageId: "universe_instance" }>;
    if (entryFacts.stageId !== "edge_ready_generation" || parentFacts.stageId !== "universe_instance" || entryFacts.instancePublication.artifactRefId !== parentFacts.instancePublication.artifactRefId || entryFacts.instancePublication.contentRoot !== parentFacts.instancePublication.contentRoot) add(reasons, "predicate-observation-mismatch", `$.stage2[${index}].publication`);
    for (const [field, left, right] of [
      ["cutoff", parent.event.cutoff, entry.event.cutoff],
      ["builderRunId", parent.event.scope.builderRunId, entry.event.scope.builderRunId],
      ["definitionCatalogRoot", parent.event.definitionCatalogRoot, entry.event.definitionCatalogRoot],
      ["familyId", parent.event.familyId, entry.event.familyId],
      ["familyDefinitionHash", parent.event.familyDefinitionHash, entry.event.familyDefinitionHash],
      ["capabilitySetHash", parent.event.capabilitySetHash, entry.event.capabilitySetHash],
    ] as const) if (!same(left, right)) add(reasons, "predicate-observation-mismatch", `$.stage2[${index}].${field}`);
    if (entry.event.scope.kind !== "ready-generation" || entry.event.scope.generationId !== entryFacts.generationId || entry.event.graphRoot === null || entry.event.instanceCatalogRoot === null) add(reasons, "predicate-observation-mismatch", `$.stage2[${index}].ready`);
    if (BigInt(entry.event.runSequence) <= BigInt(parent.event.runSequence)) add(reasons, "predicate-observation-mismatch", `$.stage2[${index}].sequence`);
  }
}

function compareReadyStageSet(
  stage2: readonly DecodedEventV1[],
  planner: DecodedEventV1 | undefined,
  reasons: SixStepReasonV1[],
): void {
  if (stage2.length === 0) return;
  const first = stage2[0]!;
  for (const [index, entry] of stage2.entries()) {
    for (const [field, left, right] of [
      ["cutoff", first.event.cutoff, entry.event.cutoff],
      ["builderRunId", first.event.scope.builderRunId, entry.event.scope.builderRunId],
      ["generationId", first.event.scope.generationId, entry.event.scope.generationId],
      ["definitionCatalogRoot", first.event.definitionCatalogRoot, entry.event.definitionCatalogRoot],
      ["strategyCatalogRoot", first.event.strategyCatalogRoot, entry.event.strategyCatalogRoot],
      ["instanceCatalogRoot", first.event.instanceCatalogRoot, entry.event.instanceCatalogRoot],
      ["graphRoot", first.event.graphRoot, entry.event.graphRoot],
    ] as const) if (!same(left, right)) add(reasons, "predicate-observation-mismatch", `$.stage2-set[${index}].${field}`);
  }
  if (planner !== undefined) {
    for (const [field, left, right] of [
      ["cutoff", first.event.cutoff, planner.event.cutoff],
      ["builderRunId", first.event.scope.builderRunId, planner.event.scope.builderRunId],
      ["generationId", first.event.scope.generationId, planner.event.scope.generationId],
      ["definitionCatalogRoot", first.event.definitionCatalogRoot, planner.event.definitionCatalogRoot],
      ["instanceCatalogRoot", first.event.instanceCatalogRoot, planner.event.instanceCatalogRoot],
      ["graphRoot", first.event.graphRoot, planner.event.graphRoot],
    ] as const) if (!same(left, right)) add(reasons, "predicate-observation-mismatch", `$.planner-ready.${field}`);
  }
}

function comparePlanner(
  planner: DecodedEventV1,
  stage2: readonly DecodedEventV1[],
  reasons: SixStepReasonV1[],
): void {
  if (planner.stageFacts.stageId !== "planner_consumption") return;
  const facts = planner.stageFacts;
  if (planner.event.parentEventIds.length !== stage2.length || facts.orderedInstanceBindings.length !== stage2.length) add(reasons, "predicate-observation-mismatch", "$.planner.parents");
  const stage2ById = new Map(stage2.map((entry) => [entry.event.eventId, entry]));
  for (const [index, parentId] of planner.event.parentEventIds.entries()) {
    const parent = stage2ById.get(parentId);
    const binding = facts.orderedInstanceBindings[index];
    if (parent === undefined || binding === undefined || planner.event.parentOutputHashes[index] !== parent.event.outputHash || binding.stage1EventId !== (parent.event.parentEventIds.length === 1 ? parent.event.parentEventIds[0] : "") || binding.stage2EventId !== parent.event.eventId || binding.instanceKey !== parent.event.instanceKey || binding.instancePublicationRoot !== (parent.stageFacts.stageId === "edge_ready_generation" ? parent.stageFacts.instancePublication.contentRoot : "")) add(reasons, "predicate-observation-mismatch", `$.planner.route[${index}]`);
  }
  if (hashOrderedInstanceBindingsRoot(facts.orderedInstanceBindings) !== facts.orderedInstanceBindingsRoot) add(reasons, "predicate-observation-mismatch", "$.planner.orderedInstanceBindingsRoot");
  const routeSet = planner.witnessPayloads["route-set"];
  const routeRecord = payloadRecord(routeSet);
  const orderedEdgeIds = routeRecord?.orderedEdgeIds;
  const plannerRaw = payloadRecord(planner.rawPayload);
  if (!exactPayloadKeys(routeSet, ["routeCandidateId", "orderedEdgeIds", "routeHash"])
    || routeRecord?.routeCandidateId !== planner.event.candidateKey
    || !Array.isArray(orderedEdgeIds)
    || !same(orderedEdgeIds, facts.orderedInstanceBindings.map((binding) => binding.edgeId))
    || plannerRaw?.routeCandidateId !== routeRecord.routeCandidateId
    || !same(plannerRaw?.orderedEdgeIds, orderedEdgeIds)
    || plannerRaw?.routeHash !== routeRecord.routeHash
    || !positiveHash(plannerRaw?.routeBindingHash)
    || !same(planner.witnessPayloads["coarse-projection"], { coarse: plannerRaw?.coarse })
    || !same(planner.witnessPayloads["admission-receipt"], { planned: plannerRaw?.planned, admissionClass: plannerRaw?.admissionClass })
    || plannerRaw?.admissionClass !== facts.admissionClass) {
    add(reasons, "predicate-observation-mismatch", "$.planner.routeSetPayload");
  }
  for (const [index, parentId] of planner.event.parentEventIds.entries()) {
    const parent = stage2ById.get(parentId);
    const edgePayload = payloadRecord(parent?.witnessPayloads.edge);
    if (edgePayload?.edgeId !== facts.orderedInstanceBindings[index]?.edgeId) {
      add(reasons, "predicate-observation-mismatch", `$.planner.routeEdgePayload[${index}]`);
    }
  }
}

function compareTail(
  tail: readonly DecodedEventV1[],
  reasons: SixStepReasonV1[],
  evaluatorBinding: EconomicEvaluatorBindingObservationV1,
): void {
  if (tail.length !== 4) {
    add(reasons, "predicate-observation-missing", "$.predicateFacts.tail");
    return;
  }
  const [stage3, stage4, stage5, stage6] = tail;
  if (tail.some(entry => entry.event.runtime.commitSha !== evaluatorBinding.candidateReleaseCommit)) {
    add(reasons, "process-anchor-mismatch", "$.economicEvaluatorBinding.candidateReleaseCommit");
  }
  for (const [index, entry] of tail.entries()) {
    if (entry.event.scope.kind !== "producer-session" || entry.event.scope.producerSessionId === null || entry.event.scope.generationId === null || entry.event.strategyCatalogRoot === null || entry.event.instanceCatalogRoot === null || entry.event.graphRoot === null) add(reasons, "predicate-observation-mismatch", `$.tail[${index}].scope`);
    if (index > 0) {
      const parent = tail[index - 1]!;
      if (entry.event.parentEventIds.length !== 1 || entry.event.parentEventIds[0] !== parent.event.eventId || entry.event.parentOutputHashes[0] !== parent.event.outputHash || BigInt(entry.event.runSequence) <= BigInt(parent.event.runSequence)) add(reasons, "predicate-observation-mismatch", `$.tail[${index}].parent`);
    }
    for (const [field, left, right] of [
      ["correlationId", stage3.event.correlationId, entry.event.correlationId],
      ["runtime", stableRuntime(stage3.event.runtime), stableRuntime(entry.event.runtime)],
      ["scope", stage3.event.scope, entry.event.scope],
      ["cutoff", stage3.event.cutoff, entry.event.cutoff],
      ["definitionCatalogRoot", stage3.event.definitionCatalogRoot, entry.event.definitionCatalogRoot],
      ["strategyCatalogRoot", stage3.event.strategyCatalogRoot, entry.event.strategyCatalogRoot],
      ["instanceCatalogRoot", stage3.event.instanceCatalogRoot, entry.event.instanceCatalogRoot],
      ["graphRoot", stage3.event.graphRoot, entry.event.graphRoot],
      ["familyId", stage3.event.familyId, entry.event.familyId],
      ["candidateKey", stage3.event.candidateKey, entry.event.candidateKey],
      ["familyDefinitionHash", stage3.event.familyDefinitionHash, entry.event.familyDefinitionHash],
      ["capabilitySetHash", stage3.event.capabilitySetHash, entry.event.capabilitySetHash],
      ["instanceKey", stage3.event.instanceKey, entry.event.instanceKey],
    ] as const) if (!same(left, right)) add(reasons, "predicate-observation-mismatch", `$.tail.${field}`);
  }
  if (stage4.stageFacts.stageId !== "current_source_exact" || stage4.stageFacts.fallback !== false) add(reasons, "predicate-observation-mismatch", "$.stage4");
  if (stage5.stageFacts.stageId !== "execution_program" || stage5.stageFacts.fallback !== false) add(reasons, "predicate-observation-mismatch", "$.stage5");
  if (stage6.stageFacts.stageId !== "final_simulation" || stage6.stageFacts.dryRun !== true) add(reasons, "predicate-observation-mismatch", "$.stage6");

  const routeSet = payloadRecord(stage3.witnessPayloads["route-set"]);
  const exactPayload = payloadRecord(stage4.witnessPayloads["exact-output"]);
  const exact = payloadRecord(exactPayload?.exact);
  const programPayload = payloadRecord(stage5.witnessPayloads.program);
  const program = payloadRecord(programPayload?.program);
  if (!exactPayloadKeys(stage4.witnessPayloads["exact-output"], ["exact"])
    || !same(stage4.witnessPayloads["exact-output"], { exact: payloadRecord(stage4.rawPayload)?.exact })
    || exact?.routeHash !== routeSet?.routeHash
    || exact?.routeBindingHash !== payloadRecord(stage3.rawPayload)?.routeBindingHash
    || !same(exact?.source, stage4.stageFacts.stageId === "current_source_exact" ? stage4.stageFacts.currentSource : null)) {
    add(reasons, "predicate-observation-mismatch", "$.stage4.exactPayload");
  }
  if (!exactPayloadKeys(stage5.witnessPayloads.program, ["program"])
    || !same(programPayload, { program: payloadRecord(stage5.rawPayload)?.program })
    || program?.routeHash !== routeSet?.routeHash
    || program?.generationId !== stage5.event.scope.generationId
    || !same(program?.source, stage4.stageFacts.stageId === "current_source_exact" ? stage4.stageFacts.currentSource : null)
    || !exactPayloadKeys(stage5.witnessPayloads["pre-calls"], ["preCalls"])
    || !exactPayloadKeys(stage5.witnessPayloads["observation-pairs"], ["observationPairs"])
    || !exactPayloadKeys(stage5.witnessPayloads["action-owner"], ["actionOwners"])) {
    add(reasons, "predicate-observation-mismatch", "$.stage5.programPayload");
  }
  const executionOwnerEvidence = payloadRecord(payloadRecord(stage5.rawPayload)?.ownerEvidence);
  const executionOwnerFacts = payloadRecord(executionOwnerEvidence?.facts);
  const stage5Facts = stage5.stageFacts.stageId === "execution_program" ? stage5.stageFacts : null;
  if (executionOwnerEvidence?.correlationId !== stage5.event.correlationId
    || executionOwnerEvidence?.generationId !== stage5.event.scope.generationId
    || executionOwnerEvidence?.routeHash !== routeSet?.routeHash
    || executionOwnerEvidence?.exactHash !== exact?.exactHash
    || executionOwnerEvidence?.programHash !== program?.programHash
    || !same(executionOwnerEvidence?.source, stage4.stageFacts.stageId === "current_source_exact" ? stage4.stageFacts.currentSource : null)
    || stage5Facts === null
    || payloadRecord(stage5.rawPayload)?.callerMode !== stage5Facts.callerMode
    || executionOwnerFacts?.callerMode !== stage5Facts.callerMode
    || !same(stage5.witnessPayloads["pre-calls"], { preCalls: executionOwnerFacts?.preCalls })
    || !same(stage5.witnessPayloads["observation-pairs"], { observationPairs: executionOwnerFacts?.observationPairs })
    || !same(stage5.witnessPayloads["action-owner"], { actionOwners: executionOwnerFacts?.actionOwners })) {
    add(reasons, "predicate-observation-mismatch", "$.stage5.ownerEvidencePayload");
  }
  const finalPayload = payloadRecord(stage6.witnessPayloads["final-simulation-receipt"]);
  const simulation = payloadRecord(finalPayload?.simulation);
  const ownerEvidence = payloadRecord(finalPayload?.ownerEvidence);
  const ownerFacts = payloadRecord(ownerEvidence?.facts);
  const ownerEffects = payloadRecord(payloadRecord(ownerFacts?.workerReceipt)?.effects);
  const stage6Raw = payloadRecord(stage6.rawPayload);
  const economicSafety = payloadRecord(stage6Raw?.economicSafety);
  const source = stage6.stageFacts.stageId === "final_simulation" ? stage6.stageFacts.simulationSourceAnchor : null;
  if (!exactPayloadKeys(stage6.witnessPayloads["final-simulation-receipt"], ["simulation", "ownerEvidence"])
    || simulation?.programHash !== program?.programHash
    || !same(simulation?.effectTransport, program?.effectTransport)
    || simulation?.generationId !== stage6.event.scope.generationId
    || !same(simulation?.source, source)
    || !same(source, stage4.stageFacts.stageId === "current_source_exact" ? stage4.stageFacts.currentSource : null)
    || ownerEvidence?.correlationId !== stage6.event.correlationId
    || ownerEvidence?.generationId !== stage6.event.scope.generationId
    || ownerEvidence?.programHash !== program?.programHash
    || ownerEvidence?.finalSimulationReceiptHash !== simulation?.receiptHash
    || !same(ownerEvidence?.source, source)
    || ownerEffects?.effectsHash !== simulation?.effectsHash) {
    add(reasons, "predicate-observation-mismatch", "$.stage6.simulationPayload");
  }
  const economicPayload = payloadRecord(stage6.witnessPayloads["economic-receipt"]);
  const economic = payloadRecord(economicPayload?.economic);
  const safetyWitness = payloadRecord(stage6.witnessPayloads["safety-receipt"]);
  if (!exactPayloadKeys(stage6.witnessPayloads["economic-receipt"], ["economic"])
    || !same(stage6Raw?.program, program)
    || !same(stage6Raw?.simulation, simulation)
    || !same(stage6Raw?.ownerEvidence, ownerEvidence)
    || !validEconomicSafetyBinding({
      economicSafety,
      economicWitness: economic,
      safetyWitness,
      executionOwnerEvidence,
      finalOwnerEvidence: ownerEvidence,
      program,
      simulation,
      correlationId: stage6.event.correlationId,
      generationId: stage6.event.scope.generationId,
      source,
      exactHash: exact?.exactHash,
      evaluatorBinding,
    })) {
    add(reasons, "predicate-observation-mismatch", "$.stage6.safetyPayload");
  }
}

function economicEvaluatorBindingObservation(
  facts: readonly unknown[],
  reasons: SixStepReasonV1[],
): { readonly binding: EconomicEvaluatorBindingObservationV1 | null; readonly eventFacts: readonly unknown[] } {
  const observations = facts.filter(value => payloadRecord(value)?.kind === "aloha.six-step-economic-evaluator-binding-observation-v1");
  const eventFacts = facts.filter(value => payloadRecord(value)?.kind !== "aloha.six-step-economic-evaluator-binding-observation-v1");
  if (observations.length !== 1) {
    add(reasons, "predicate-observation-missing", "$.economicEvaluatorBinding");
    return { binding: null, eventFacts };
  }
  const value = payloadRecord(observations[0]);
  const executorQualification = payloadRecord(value?.executorQualification);
  if (!exactPayloadKeys(value, ["schemaVersion", "kind", "runtimeBindingId", "candidateReleaseCommit", "releaseProvenanceHash", "authorityRoot", "implementationHash", "policyRoot", "evaluatorExportIdentityHash", "objectiveTemplates", "actionOwners", "valuationOwners", "executorQualification", "safetyProfile", "observationRoot"])
    || value?.schemaVersion !== 1
    || !positiveHash(value.runtimeBindingId)
    || typeof value.candidateReleaseCommit !== "string" || !/^[0-9a-f]{40}$/.test(value.candidateReleaseCommit)
    || !positiveHash(value.releaseProvenanceHash)
    || !positiveHash(value.authorityRoot)
    || !positiveHash(value.implementationHash)
    || !positiveHash(value.policyRoot)
    || !positiveHash(value.evaluatorExportIdentityHash)
    || !Array.isArray(value.objectiveTemplates) || value.objectiveTemplates.length === 0
    || !Array.isArray(value.actionOwners) || value.actionOwners.length === 0
    || !Array.isArray(value.valuationOwners) || value.valuationOwners.length === 0
    || payloadRecord(value.safetyProfile) === null
    || value.valuationOwners.some(owner => {
      const descriptor = payloadRecord(owner);
      return !exactPayloadKeys(descriptor, ["ownerRef", "implementationHash", "factSchemaRef", "implementationClosureRoot", "qualificationLeafDigest", "valuationOwnerRegistryRoot", "qualifiedValuationOwnerSetRoot"])
        || ["ownerRef", "implementationHash", "factSchemaRef", "implementationClosureRoot", "qualificationLeafDigest", "valuationOwnerRegistryRoot", "qualifiedValuationOwnerSetRoot"]
          .some(key => !positiveHash(descriptor?.[key]));
    })
    || new Set(value.valuationOwners.map(owner => payloadRecord(owner)?.ownerRef)).size !== value.valuationOwners.length
    || !exactPayloadKeys(executorQualification, ["executorKind", "engineBuildFingerprint", "executableFingerprint", "qualifiedExecutorRegistryRoot", "selectedExecutorLeafHash", "releaseRoleManifestRoot"])
    || executorQualification?.executorKind !== "revm"
    || ["engineBuildFingerprint", "executableFingerprint", "qualifiedExecutorRegistryRoot", "selectedExecutorLeafHash", "releaseRoleManifestRoot"].some(key => !positiveHash(executorQualification?.[key]))
    || !domainHashMatches("aloha/runtime-release-economic-evaluator-policies/v4", {
      templates: value.objectiveTemplates,
      actionOwners: value.actionOwners,
      valuationOwners: value.valuationOwners,
      executorQualification: value.executorQualification,
      safetyProfile: value.safetyProfile,
    }, value.policyRoot)) {
    add(reasons, "predicate-observation-mismatch", "$.economicEvaluatorBinding");
    return { binding: null, eventFacts };
  }
  const { observationRoot: _root, ...payload } = value;
  if (!domainHashMatches("aloha/six-step-economic-evaluator-binding-observation/v1", payload, value.observationRoot)) {
    add(reasons, "predicate-observation-mismatch", "$.economicEvaluatorBinding.root");
    return { binding: null, eventFacts };
  }
  return { binding: value as unknown as EconomicEvaluatorBindingObservationV1, eventFacts };
}

/** Runtime evaluation consumes only GateCore's normalized immutable values. */
export function evaluateSixStepPredicate(runtime: SixStepRuntimeFactsV1): SixStepPredicateResultV1 {
  const reasons: SixStepReasonV1[] = [];
  if (runtime.facts.length === 0) return { verdict: "invalid", reasons: [{ code: "predicate-observation-missing", path: "$.predicateFacts" }] };
  const evaluator = economicEvaluatorBindingObservation(runtime.facts, reasons);
  const refsById = new Map(runtime.refs.map((ref) => [ref.artifactRefId, ref]));
  const claimsByRef = new Map(runtime.claims.map((claim) => [claim.artifactRefId, claim]));
  const policiesByHash = new Map(runtime.policies.map((policy) => [policy.policyHash, policy]));
  const leasesById = new Map(runtime.leases.map((lease) => [lease.receiptId, lease]));
  if (refsById.size !== runtime.refs.length) add(reasons, "artifact-ref-mismatch", "$.refs.duplicate");
  if (claimsByRef.size !== runtime.claims.length || new Set(runtime.claims.map((claim) => claim.claimId)).size !== runtime.claims.length) add(reasons, "artifact-claim-mismatch", "$.claims.duplicate");
  if (policiesByHash.size !== runtime.policies.length) add(reasons, "artifact-claim-mismatch", "$.policies.duplicate");
  if (leasesById.size !== runtime.leases.length) add(reasons, "observation-mismatch", "$.leases.duplicate");
  const decoded: DecodedEventV1[] = [];
  const seenEventIds = new Set<Hash>();
  for (const [index, rawFact] of evaluator.eventFacts.entries()) {
    const entry = decodeOne(rawFact, index, runtime, refsById, claimsByRef, leasesById, reasons);
    if (entry === null) continue;
    if (seenEventIds.has(entry.event.eventId)) add(reasons, "predicate-observation-mismatch", `$.predicateFacts[${index}].duplicate`);
    seenEventIds.add(entry.event.eventId);
    decoded.push(entry);
  }
  if (decoded.length !== evaluator.eventFacts.length || evaluator.binding === null) return { verdict: "invalid", reasons: Object.freeze(reasons) };
  const expectedRefIds = new Set<Hash>();
  for (const entry of decoded) {
    expectedRefIds.add(entry.fact.eventArtifactRefId);
    expectedRefIds.add(entry.fact.semanticArtifactRefId);
    expectedRefIds.add(entry.fact.productionReceiptArtifactRefId);
    expectedRefIds.add(entry.receipt.rawBoundaryArtifactRef.artifactRefId);
    expectedRefIds.add(entry.receipt.logRangeArtifactRef.artifactRefId);
    for (const refId of entry.semantic.inputArtifactIds.slice(1)) expectedRefIds.add(refId);
  }
  const expectedIds = [...expectedRefIds].sort();
  if (!same([...refsById.keys()].sort(), expectedIds)) add(reasons, "artifact-ref-mismatch", "$.refs.denominator");
  if (!same([...claimsByRef.keys()].sort(), expectedIds)) add(reasons, "artifact-claim-mismatch", "$.claims.denominator");
  const expectedPolicyHashes = [...new Set(runtime.refs.map((ref) => ref.resolverPolicyHash))].sort();
  if (!same([...policiesByHash.keys()].sort(), expectedPolicyHashes)) add(reasons, "artifact-claim-mismatch", "$.policies.denominator");
  const expectedLeaseIds = [...new Set(runtime.refs.map((ref) => ref.retentionLeaseReceiptId))].sort();
  if (!same([...leasesById.keys()].sort(), expectedLeaseIds)) add(reasons, "observation-mismatch", "$.leases.denominator");
  for (const ref of runtime.refs) {
    const policy = policiesByHash.get(ref.resolverPolicyHash);
    if (policy === undefined || policy.allowedLocatorKind !== "content-object" || policy.digestAlgorithm !== "sha256" || policy.requireExactLengthMediaAndSchema !== true || policy.failureOutcome !== "invalid") add(reasons, "artifact-claim-mismatch", `$.policies.${ref.artifactRefId}`);
  }
  if (runtime.observations.length !== 1) {
    add(reasons, "observation-mismatch", "$.observations.denominator");
  } else {
    const observation = runtime.observations[0]!;
    const observedIds = observation.rawArtifactRefs.map((ref) => ref.artifactRefId).sort();
    const claimIds = runtime.claims.map((claim) => claim.claimId).sort();
    if (!same(observedIds, expectedIds)
      || !same(observation.observedClaimIds.slice().sort(), claimIds)
      || observation.rawArtifactRefs.some((ref) => !same(refsById.get(ref.artifactRefId), ref))) {
      add(reasons, "observation-mismatch", "$.observations.complete");
    }
  }
  const stage1 = decoded.filter((entry) => entry.event.stage.ordinal === 1);
  const stage2 = decoded.filter((entry) => entry.event.stage.ordinal === 2);
  const stage3 = decoded.filter((entry) => entry.event.stage.ordinal === 3);
  const stage4 = decoded.filter((entry) => entry.event.stage.ordinal === 4);
  const stage5 = decoded.filter((entry) => entry.event.stage.ordinal === 5);
  const stage6 = decoded.filter((entry) => entry.event.stage.ordinal === 6);
  if (stage3.length !== 1 || stage4.length !== 1 || stage5.length !== 1 || stage6.length !== 1) add(reasons, "predicate-observation-missing", "$.predicateFacts.stageCardinality");
  if (stage1.some((entry) => entry.event.outcome !== "verified" || entry.event.instanceKey === null || entry.event.scope.kind !== "builder-run" || entry.event.scope.generationId !== null)) add(reasons, "predicate-observation-mismatch", "$.stage1");
  if (stage2.some((entry) => entry.event.outcome !== "success" || entry.event.instanceKey === null || entry.event.scope.kind !== "ready-generation")) add(reasons, "predicate-observation-mismatch", "$.stage2");
  if (decoded.some((entry) => entry.event.stage.ordinal >= 2 && entry.event.outcome !== "success")) add(reasons, "predicate-failed", "$.predicateFacts.outcome");
  compareStage12(stage1, stage2, reasons);
  if (stage3[0] !== undefined) comparePlanner(stage3[0], stage2, reasons);
  compareReadyStageSet(stage2, stage3[0], reasons);
  compareTail([stage3[0], stage4[0], stage5[0], stage6[0]].filter((entry): entry is DecodedEventV1 => entry !== undefined), reasons, evaluator.binding);
  if (stage6[0]?.event.outcome !== "success") add(reasons, "predicate-failed", "$.stage6.outcome");
  const invalidCodes = new Set<SixStepReasonCode>([
    "predicate-observation-missing",
    "predicate-observation-mismatch",
    "artifact-ref-mismatch",
    "artifact-claim-mismatch",
    "observation-mismatch",
    "production-receipt-mismatch",
    "process-anchor-mismatch",
  ]);
  const verdict: SixStepPredicateVerdict = reasons.some((reason) => reason.code === "predicate-failed")
    ? (reasons.some((reason) => invalidCodes.has(reason.code)) ? "invalid" : "fail")
    : (reasons.length === 0 ? "pass" : "invalid");
  return Object.freeze({ verdict, reasons: Object.freeze(reasons) });
}

export function hashSixStepFactBundleIds(facts: readonly SixStepEventFactV1[]): Hash {
  return hashDomain("aloha/six-step/fact-bundle/v1", facts.map((fact) => fact.eventArtifactRefId));
}
