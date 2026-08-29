import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  deepFreeze,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import {
  decodeAssetReferenceV1,
  type AssetReferenceV1,
} from "../../asset-ref/src/index.ts";
import {
  isEconomicSafetyFinalizationServiceV1,
} from "./internal/state.ts";
import type {
  EconomicValuationFactV1,
  EconomicValuationSourceV1,
} from "../../../specs/economic-valuation-owner/src/index.ts";
import {
  ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
  type EconomicSafetyProfileRequiredClaimV1,
} from "../../../specs/economic-safety-profile/src/index.ts";
import type { EconomicSafetyPolicyRejectionCodeV1 } from "./policy-rejection.ts";

export type { EconomicValuationFactV1 } from "../../../specs/economic-valuation-owner/src/index.ts";

export interface EconomicSafetySourceV1 extends EconomicValuationSourceV1 {}

export interface EconomicSafetyFinalizationInputV1 {
  readonly releaseProvenanceHash: Hash;
  readonly correlationId: Hash;
  readonly generationId: string;
  readonly source: EconomicSafetySourceV1;
  readonly objectiveRef: Hash;
  readonly exactHash: Hash;
  readonly programHash: Hash;
  readonly obligationRoot: Hash;
  readonly finalSimulationReceiptHash: Hash;
  readonly effectsHash: Hash;
  readonly executionOwnerEvidenceRoot: Hash;
  readonly finalSimulationOwnerEvidenceRoot: Hash;
  readonly dryRun: true;
  /** Exact facts emitted by the execution-program owner. */
  readonly executionOwnerFacts: CanonicalJson;
  /** Exact facts emitted by the qualified final-simulation owner. */
  readonly finalSimulationOwnerFacts: CanonicalJson;
  /** Complete owner-declared obligation set; omission is not "not required". */
  readonly declaredObligations: readonly EconomicSafetyDeclaredObligationV1[];
}

export interface EconomicSafetyDeclaredObligationV1 {
  readonly obligationRef: Hash;
  readonly ownerRef: Hash;
  readonly policy: "must-satisfy";
}

export interface EconomicReceiptV1 {
  readonly kind: "aloha.economic-receipt-v1";
  readonly gasUsed: string;
  readonly nextBlockBaseFeePerGas: string;
  readonly priorityFeePerGas: string;
  readonly effectiveGasPrice: string;
  readonly gasCostNative: string;
  readonly profitAsset: AssetReferenceV1;
  readonly grossProfitAmount: string;
  readonly valuationNumerator: string;
  readonly valuationDenominator: string;
  readonly valuationFactRoot: Hash;
  readonly valuationFact: EconomicValuationFactV1;
  readonly grossProfitNative: string;
  readonly bidCostNative: string;
  readonly netProfitNative: string;
  readonly minNetProfitNative: string;
  readonly verdict: "positive-net-ev";
  readonly receiptRoot: Hash;
}

export interface SafetyObligationReceiptV1 {
  readonly schemaRef: Hash;
  readonly ownerRef: Hash;
  readonly qualificationLeafDigest: Hash;
  readonly verifierHash: Hash;
  readonly subjectRoot: Hash;
  readonly proofRoot: Hash;
  readonly outcome: "satisfied" | "explicitly-permitted";
  readonly receiptRoot: Hash;
}

export interface SafetyReceiptV1 {
  readonly kind: "aloha.final-safety-receipt-v1";
  readonly obligationRoot: Hash;
  readonly obligationReceipts: readonly SafetyObligationReceiptV1[];
  readonly obligationReceiptSetRoot: Hash;
  readonly safetyProfileRef: Hash;
  readonly safetyProfileRoot: Hash;
  readonly selectedRequiredClaims: readonly EconomicSafetyProfileRequiredClaimV1[];
  readonly requiredClaimSetRoot: Hash;
  readonly revmObservationSchemaRef: Hash;
  readonly revmObservationRoot: Hash;
  readonly assetConservationProofRoot: Hash;
  readonly assetConservation: "satisfied";
  readonly verdict: "safe";
  readonly receiptRoot: Hash;
}

export interface EconomicSafetyEvidenceV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.economic-safety-finalization-evidence-v1";
  readonly authorityRoot: Hash;
  readonly implementationHash: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly correlationId: Hash;
  readonly generationId: string;
  readonly source: EconomicSafetySourceV1;
  readonly objectiveRef: Hash;
  readonly exactHash: Hash;
  readonly programHash: Hash;
  readonly obligationRoot: Hash;
  readonly finalSimulationReceiptHash: Hash;
  readonly effectsHash: Hash;
  readonly executionOwnerEvidenceRoot: Hash;
  readonly finalSimulationOwnerEvidenceRoot: Hash;
  readonly executionOwnerFacts: CanonicalJson;
  readonly executionOwnerFactsRoot: Hash;
  readonly finalSimulationOwnerFacts: CanonicalJson;
  readonly finalSimulationOwnerFactsRoot: Hash;
  readonly declaredObligations: readonly EconomicSafetyDeclaredObligationV1[];
  readonly declaredObligationSetRoot: Hash;
  readonly economic: EconomicReceiptV1;
  readonly safety: SafetyReceiptV1;
  readonly dryRun: true;
  readonly evidenceRoot: Hash;
}

export { EconomicSafetyPolicyRejectionErrorV1 } from "./policy-rejection.ts";
export type { EconomicSafetyPolicyRejectionCodeV1 } from "./policy-rejection.ts";

export interface EconomicSafetyChainRejectionV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.economic-safety-chain-rejection-v1";
  readonly authorityRoot: Hash;
  readonly implementationHash: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly correlationId: Hash;
  readonly generationId: string;
  readonly source: EconomicSafetySourceV1;
  readonly objectiveRef: Hash;
  readonly exactHash: Hash;
  readonly programHash: Hash;
  readonly obligationRoot: Hash;
  readonly finalSimulationReceiptHash: Hash;
  readonly effectsHash: Hash;
  readonly executionOwnerEvidenceRoot: Hash;
  readonly finalSimulationOwnerEvidenceRoot: Hash;
  readonly executionOwnerFactsRoot: Hash;
  readonly finalSimulationOwnerFactsRoot: Hash;
  readonly declaredObligationSetRoot: Hash;
  readonly code: EconomicSafetyPolicyRejectionCodeV1;
  readonly evidenceRoot: Hash;
}

export type EconomicSafetyFinalizationOutcomeV1 = EconomicSafetyEvidenceV1 | EconomicSafetyChainRejectionV1;

export interface EconomicSafetyEvidenceCapabilityV1 {
  readonly kind: "opaque-qualified-stage-rejection-capability";
}

export interface EconomicSafetyFinalizationServiceV1 {
  readonly finalize: (input: EconomicSafetyFinalizationInputV1) => Promise<EconomicSafetyEvidenceCapabilityV1>;
  readonly read: (capability: EconomicSafetyEvidenceCapabilityV1) => EconomicSafetyFinalizationOutcomeV1;
  readonly binding: () => EconomicSafetyEvidenceAuthorityExpectationV1;
}

export interface EconomicSafetyEvidenceAuthorityExpectationV1 {
  readonly authorityRoot: Hash;
  readonly implementationHash: Hash;
  readonly releaseProvenanceHash: Hash;
}

export interface EconomicSafetyDecisionV1 {
  readonly economic: Omit<EconomicReceiptV1, "receiptRoot">;
  readonly safety: Omit<SafetyReceiptV1, "receiptRoot" | "obligationReceiptSetRoot" | "obligationReceipts"> & {
    readonly obligationReceipts: readonly Omit<SafetyObligationReceiptV1, "receiptRoot">[];
  };
}

export interface EconomicSafetyQualifiedEvaluatorV1 {
  readonly evaluate: (input: EconomicSafetyFinalizationInputV1) => Promise<EconomicSafetyDecisionV1>;
}


export {
  createEconomicSafetyQualifiedEvaluatorV1,
  encodeEconomicSafetyObjectiveTemplatesV1,
  decodeEconomicSafetyObjectiveTemplatesV1,
  economicSafetyObjectivePolicyRootV1,
  ECONOMIC_SAFETY_EVALUATOR_EXPORT_IDENTITY_V1,
  ECONOMIC_SAFETY_EVALUATOR_EXPORT_IDENTITY_HASH_V1,
} from "./evaluator.ts";
export type {
  EconomicSafetyActionOwnerPolicyV1,
  EconomicSafetyActionOwnerVerifierBindingV1,
  EconomicSafetyObjectiveTemplateV1,
  EconomicSafetyValuationOwnerBindingV1,
  EconomicSafetyValuationOwnerDescriptorV1,
  EconomicSafetyExecutorQualificationV1,
} from "./evaluator.ts";

function positiveHash(value: unknown, path: string): Hash {
  const result = assertHash(value, path);
  if (/^0x0{64}$/.test(result)) throw new TypeError(`${path} must be non-zero`);
  return result;
}

function source(value: unknown, path: string): EconomicSafetySourceV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, ["chainId", "number", "hash", "stateRoot"], path);
  const record = value as Record<string, unknown>;
  return Object.freeze({
    chainId: assertDecimalString(record.chainId, `${path}.chainId`),
    number: assertDecimalString(record.number, `${path}.number`),
    hash: positiveHash(record.hash, `${path}.hash`),
    stateRoot: positiveHash(record.stateRoot, `${path}.stateRoot`),
  });
}

function canonical(value: unknown, path: string): CanonicalJson {
  try {
    return deepFreeze(JSON.parse(JSON.stringify(value)) as CanonicalJson);
  } catch (error) {
    throw new TypeError(`${path} must be canonical JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function declaredObligations(value: unknown): readonly EconomicSafetyDeclaredObligationV1[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("economicSafety.input.declaredObligations must be non-empty");
  const normalized = value.map((entry, index) => {
    const path = `economicSafety.input.declaredObligations[${index}]`;
    assertPlainObject(entry, path);
    assertExactKeys(entry, ["obligationRef", "ownerRef", "policy"], path);
    const record = entry as Record<string, unknown>;
    if (record.policy !== "must-satisfy") throw new TypeError(`${path}.policy is unsupported`);
    return Object.freeze({
      obligationRef: positiveHash(record.obligationRef, `${path}.obligationRef`),
      ownerRef: positiveHash(record.ownerRef, `${path}.ownerRef`),
      policy: "must-satisfy" as const,
    });
  });
  const refs = normalized.map(entry => entry.obligationRef);
  if (new Set(refs).size !== refs.length) throw new TypeError("economicSafety.input.declaredObligations contains duplicates");
  return Object.freeze(normalized);
}

export function normalizeEconomicSafetyFinalizationInputV1(value: unknown): EconomicSafetyFinalizationInputV1 {
  assertPlainObject(value, "economicSafety.input");
  assertExactKeys(value, ["releaseProvenanceHash", "correlationId", "generationId", "source", "objectiveRef", "exactHash", "programHash", "obligationRoot", "finalSimulationReceiptHash", "effectsHash", "executionOwnerEvidenceRoot", "finalSimulationOwnerEvidenceRoot", "dryRun", "executionOwnerFacts", "finalSimulationOwnerFacts", "declaredObligations"], "economicSafety.input");
  const record = value as Record<string, unknown>;
  if (record.dryRun !== true) throw new TypeError("economicSafety.input.dryRun must be true");
  const normalizedDeclarations = declaredObligations(record.declaredObligations);
  const obligationRoot = positiveHash(record.obligationRoot, "economicSafety.input.obligationRoot");
  if (obligationRoot !== hashDomain("aloha/search-runtime-obligation-root/v1", normalizedDeclarations.map(entry => entry.obligationRef))) {
    throw new TypeError("economicSafety.input declared obligations do not close the program obligation root");
  }
  return deepFreeze({
    releaseProvenanceHash: positiveHash(record.releaseProvenanceHash, "economicSafety.input.releaseProvenanceHash"),
    correlationId: positiveHash(record.correlationId, "economicSafety.input.correlationId"),
    generationId: assertNonEmptyString(record.generationId, "economicSafety.input.generationId"),
    source: source(record.source, "economicSafety.input.source"),
    objectiveRef: positiveHash(record.objectiveRef, "economicSafety.input.objectiveRef"),
    exactHash: positiveHash(record.exactHash, "economicSafety.input.exactHash"),
    programHash: positiveHash(record.programHash, "economicSafety.input.programHash"),
    obligationRoot,
    finalSimulationReceiptHash: positiveHash(record.finalSimulationReceiptHash, "economicSafety.input.finalSimulationReceiptHash"),
    effectsHash: positiveHash(record.effectsHash, "economicSafety.input.effectsHash"),
    executionOwnerEvidenceRoot: positiveHash(record.executionOwnerEvidenceRoot, "economicSafety.input.executionOwnerEvidenceRoot"),
    finalSimulationOwnerEvidenceRoot: positiveHash(record.finalSimulationOwnerEvidenceRoot, "economicSafety.input.finalSimulationOwnerEvidenceRoot"),
    dryRun: true,
    executionOwnerFacts: canonical(record.executionOwnerFacts, "economicSafety.input.executionOwnerFacts"),
    finalSimulationOwnerFacts: canonical(record.finalSimulationOwnerFacts, "economicSafety.input.finalSimulationOwnerFacts"),
    declaredObligations: normalizedDeclarations,
  });
}

function economic(value: EconomicSafetyDecisionV1["economic"]): EconomicReceiptV1 {
  assertPlainObject(value, "economicSafety.economic");
  assertExactKeys(value, ["kind", "gasUsed", "nextBlockBaseFeePerGas", "priorityFeePerGas", "effectiveGasPrice", "gasCostNative", "profitAsset", "grossProfitAmount", "valuationNumerator", "valuationDenominator", "valuationFactRoot", "valuationFact", "grossProfitNative", "bidCostNative", "netProfitNative", "minNetProfitNative", "verdict"], "economicSafety.economic");
  if (value.kind !== "aloha.economic-receipt-v1" || value.verdict !== "positive-net-ev") throw new TypeError("economic receipt kind/verdict mismatch");
  const gasUsed = BigInt(assertDecimalString(value.gasUsed, "economic.gasUsed"));
  const baseFee = BigInt(assertDecimalString(value.nextBlockBaseFeePerGas, "economic.nextBlockBaseFeePerGas"));
  const priorityFee = BigInt(assertDecimalString(value.priorityFeePerGas, "economic.priorityFeePerGas"));
  const effectiveGasPrice = BigInt(assertDecimalString(value.effectiveGasPrice, "economic.effectiveGasPrice"));
  const gasCostNative = BigInt(assertDecimalString(value.gasCostNative, "economic.gasCostNative"));
  const grossProfitAmount = BigInt(assertDecimalString(value.grossProfitAmount, "economic.grossProfitAmount"));
  const numerator = BigInt(assertDecimalString(value.valuationNumerator, "economic.valuationNumerator"));
  const denominator = BigInt(assertDecimalString(value.valuationDenominator, "economic.valuationDenominator"));
  const grossProfitNative = BigInt(assertDecimalString(value.grossProfitNative, "economic.grossProfitNative"));
  const bidCostNative = BigInt(assertDecimalString(value.bidCostNative, "economic.bidCostNative"));
  const netProfitNative = BigInt(assertDecimalString(value.netProfitNative, "economic.netProfitNative"));
  const minNetProfitNative = BigInt(assertDecimalString(value.minNetProfitNative, "economic.minNetProfitNative"));
  if (gasUsed <= 0n || denominator <= 0n || numerator <= 0n || grossProfitAmount <= 0n || effectiveGasPrice !== baseFee + priorityFee || gasCostNative !== gasUsed * effectiveGasPrice || grossProfitNative !== grossProfitAmount * numerator / denominator || netProfitNative !== grossProfitNative - gasCostNative - bidCostNative || netProfitNative <= minNetProfitNative || netProfitNative <= 0n) throw new TypeError("economic receipt arithmetic/net EV mismatch");
  assertPlainObject(value.valuationFact, "economic.valuationFact");
  assertExactKeys(value.valuationFact, ["kind", "ownerRef", "generationId", "source", "assetRef", "numerator", "denominator", "ownerImplementationHash", "valuationOwnerRegistryRoot", "qualifiedValuationOwnerSetRoot", "qualificationLeafDigest", "currentSourceObservationRoot", "factRoot"], "economic.valuationFact");
  if (value.valuationFact.kind !== "aloha.economic-valuation-fact-v1") throw new TypeError("economic valuation fact kind mismatch");
  const valuationFactBody = deepFreeze({
    kind: "aloha.economic-valuation-fact-v1" as const,
    ownerRef: positiveHash(value.valuationFact.ownerRef, "economic.valuationFact.ownerRef"),
    generationId: assertNonEmptyString(value.valuationFact.generationId, "economic.valuationFact.generationId"),
    source: source(value.valuationFact.source, "economic.valuationFact.source"),
    assetRef: positiveHash(value.valuationFact.assetRef, "economic.valuationFact.assetRef"),
    numerator: assertDecimalString(value.valuationFact.numerator, "economic.valuationFact.numerator"),
    denominator: assertDecimalString(value.valuationFact.denominator, "economic.valuationFact.denominator"),
    ownerImplementationHash: positiveHash(value.valuationFact.ownerImplementationHash, "economic.valuationFact.ownerImplementationHash"),
    valuationOwnerRegistryRoot: positiveHash(value.valuationFact.valuationOwnerRegistryRoot, "economic.valuationFact.valuationOwnerRegistryRoot"),
    qualifiedValuationOwnerSetRoot: positiveHash(value.valuationFact.qualifiedValuationOwnerSetRoot, "economic.valuationFact.qualifiedValuationOwnerSetRoot"),
    qualificationLeafDigest: positiveHash(value.valuationFact.qualificationLeafDigest, "economic.valuationFact.qualificationLeafDigest"),
    currentSourceObservationRoot: positiveHash(value.valuationFact.currentSourceObservationRoot, "economic.valuationFact.currentSourceObservationRoot"),
  });
  const factRoot = positiveHash(value.valuationFact.factRoot, "economic.valuationFact.factRoot");
  if (BigInt(valuationFactBody.numerator) <= 0n || BigInt(valuationFactBody.denominator) <= 0n
    || factRoot !== hashDomain("aloha/economic-valuation-fact/v1", valuationFactBody)) {
    throw new TypeError("economic valuation fact root mismatch");
  }
  const valuationFact = deepFreeze({ ...valuationFactBody, factRoot });
  const body = deepFreeze({
    ...value,
    profitAsset: decodeAssetReferenceV1(value.profitAsset, "economic.profitAsset"),
    valuationFactRoot: positiveHash(value.valuationFactRoot, "economic.valuationFactRoot"),
    valuationFact,
  });
  if (body.valuationFactRoot !== valuationFact.factRoot
    || body.valuationNumerator !== valuationFact.numerator
    || body.valuationDenominator !== valuationFact.denominator
    || body.profitAsset.assetRef !== valuationFact.assetRef) {
    throw new TypeError("economic receipt valuation fact mismatch");
  }
  return deepFreeze({ ...body, receiptRoot: hashDomain("aloha/economic-receipt/v1", body) });
}

function safety(value: EconomicSafetyDecisionV1["safety"], obligationRoot: Hash, declarations: readonly EconomicSafetyDeclaredObligationV1[]): SafetyReceiptV1 {
  assertPlainObject(value, "economicSafety.safety");
  assertExactKeys(value, [
    "kind", "obligationRoot", "obligationReceipts", "safetyProfileRef", "safetyProfileRoot",
    "selectedRequiredClaims", "requiredClaimSetRoot", "revmObservationSchemaRef", "revmObservationRoot",
    "assetConservationProofRoot", "assetConservation", "verdict",
  ], "economicSafety.safety");
  if (value.kind !== "aloha.final-safety-receipt-v1" || value.verdict !== "safe" || value.assetConservation !== "satisfied" || value.obligationRoot !== obligationRoot || !Array.isArray(value.obligationReceipts)) throw new TypeError("safety receipt verdict/obligation mismatch");
  if (!Array.isArray(value.selectedRequiredClaims) || value.selectedRequiredClaims.length === 0) {
    throw new TypeError("safety selected required claim set must be non-empty");
  }
  const selectedRequiredClaims = value.selectedRequiredClaims.map((entry, index) => {
    const path = `economicSafety.safety.selectedRequiredClaims[${index}]`;
    assertPlainObject(entry, path);
    assertExactKeys(entry, ["claimSchemaRef", "ownerRef", "qualificationLeafDigest", "revmObservationSchemaRef"], path);
    const claim = {
      claimSchemaRef: positiveHash(entry.claimSchemaRef, `${path}.claimSchemaRef`),
      ownerRef: positiveHash(entry.ownerRef, `${path}.ownerRef`),
      qualificationLeafDigest: positiveHash(entry.qualificationLeafDigest, `${path}.qualificationLeafDigest`),
      revmObservationSchemaRef: positiveHash(entry.revmObservationSchemaRef, `${path}.revmObservationSchemaRef`),
    };
    if (claim.revmObservationSchemaRef !== ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1) {
      throw new TypeError(`${path}.revmObservationSchemaRef is unsupported`);
    }
    return deepFreeze(claim);
  });
  for (let index = 1; index < selectedRequiredClaims.length; index += 1) {
    const left = selectedRequiredClaims[index - 1]!;
    const right = selectedRequiredClaims[index]!;
    if (`${left.ownerRef}\u0000${left.claimSchemaRef}` >= `${right.ownerRef}\u0000${right.claimSchemaRef}`) {
      throw new TypeError("safety selected required claims must be strictly sorted and unique");
    }
  }
  const requiredClaimSetRoot = hashDomain("aloha/economic-safety-selected-required-claim-set/v1", selectedRequiredClaims);
  if (requiredClaimSetRoot !== positiveHash(value.requiredClaimSetRoot, "safety.requiredClaimSetRoot")) {
    throw new TypeError("safety selected required claim set root mismatch");
  }
  const obligationReceipts = value.obligationReceipts.map((entry, index) => {
    assertPlainObject(entry, `economicSafety.safety.obligationReceipts[${index}]`);
    assertExactKeys(entry, ["schemaRef", "ownerRef", "qualificationLeafDigest", "verifierHash", "subjectRoot", "proofRoot", "outcome"], `economicSafety.safety.obligationReceipts[${index}]`);
    if (entry.outcome !== "satisfied" && entry.outcome !== "explicitly-permitted") throw new TypeError("safety obligation outcome mismatch");
    const outcome: SafetyObligationReceiptV1["outcome"] = entry.outcome;
    const body = {
      schemaRef: positiveHash(entry.schemaRef, "safety.schemaRef"),
      ownerRef: positiveHash(entry.ownerRef, "safety.ownerRef"),
      qualificationLeafDigest: positiveHash(entry.qualificationLeafDigest, "safety.qualificationLeafDigest"),
      verifierHash: positiveHash(entry.verifierHash, "safety.verifierHash"),
      subjectRoot: positiveHash(entry.subjectRoot, "safety.subjectRoot"),
      proofRoot: positiveHash(entry.proofRoot, "safety.proofRoot"),
      outcome,
    };
    return deepFreeze({ ...body, receiptRoot: hashDomain("aloha/safety-obligation-receipt/v1", body) });
  });
  const obligationReceiptSetRoot = hashDomain("aloha/safety-obligation-receipt-set/v1", obligationReceipts.map(receipt => receipt.receiptRoot));
  const receiptKeys = obligationReceipts.map(receipt => `${receipt.subjectRoot}\u0000${receipt.ownerRef}\u0000${receipt.schemaRef}`);
  if (new Set(receiptKeys).size !== receiptKeys.length) throw new TypeError("safety obligation receipts contain duplicates");
  for (const declaration of declarations) {
    const claims = selectedRequiredClaims.filter(claim => claim.ownerRef === declaration.ownerRef);
    const matches = obligationReceipts.filter(receipt => receipt.subjectRoot === declaration.obligationRef && receipt.ownerRef === declaration.ownerRef);
    if (claims.length === 0 || matches.length !== claims.length || matches.some((receipt, index) => {
      const claim = claims[index];
      return claim === undefined
        || receipt.schemaRef !== claim.claimSchemaRef
        || receipt.qualificationLeafDigest !== claim.qualificationLeafDigest
        || receipt.outcome !== "satisfied";
    })) throw new TypeError("safety declared obligation is not exactly covered by selected qualified claims");
  }
  if (obligationReceipts.some(receipt => !declarations.some(declaration =>
    declaration.obligationRef === receipt.subjectRoot && declaration.ownerRef === receipt.ownerRef))) {
    throw new TypeError("safety obligation receipts contain an undeclared subject or owner");
  }
  const body = deepFreeze({
    ...value,
    obligationRoot,
    obligationReceipts: Object.freeze(obligationReceipts),
    obligationReceiptSetRoot,
    safetyProfileRef: positiveHash(value.safetyProfileRef, "safety.safetyProfileRef"),
    safetyProfileRoot: positiveHash(value.safetyProfileRoot, "safety.safetyProfileRoot"),
    selectedRequiredClaims: Object.freeze(selectedRequiredClaims),
    requiredClaimSetRoot,
    revmObservationSchemaRef: positiveHash(value.revmObservationSchemaRef, "safety.revmObservationSchemaRef"),
    revmObservationRoot: positiveHash(value.revmObservationRoot, "safety.revmObservationRoot"),
    assetConservationProofRoot: positiveHash(value.assetConservationProofRoot, "safety.assetConservationProofRoot"),
  });
  if (body.revmObservationSchemaRef !== ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1) {
    throw new TypeError("safety REVM observation schema mismatch");
  }
  return deepFreeze({ ...body, receiptRoot: hashDomain("aloha/final-safety-receipt/v1", body) });
}

function evidencePayload(value: Omit<EconomicSafetyEvidenceV1, "evidenceRoot">): CanonicalJson {
  return value as unknown as CanonicalJson;
}

export function validateEconomicSafetyEvidenceV1(
  value: EconomicSafetyEvidenceV1,
  expected: EconomicSafetyFinalizationInputV1,
  authority?: EconomicSafetyEvidenceAuthorityExpectationV1,
): EconomicSafetyEvidenceV1 {
  assertPlainObject(value, "economicSafety.evidence");
  assertExactKeys(value, ["schemaVersion", "kind", "authorityRoot", "implementationHash", "releaseProvenanceHash", "correlationId", "generationId", "source", "objectiveRef", "exactHash", "programHash", "obligationRoot", "finalSimulationReceiptHash", "effectsHash", "executionOwnerEvidenceRoot", "finalSimulationOwnerEvidenceRoot", "executionOwnerFacts", "executionOwnerFactsRoot", "finalSimulationOwnerFacts", "finalSimulationOwnerFactsRoot", "declaredObligations", "declaredObligationSetRoot", "economic", "safety", "dryRun", "evidenceRoot"], "economicSafety.evidence");
  if (value.schemaVersion !== 1 || value.kind !== "aloha.economic-safety-finalization-evidence-v1" || value.dryRun !== true) throw new TypeError("economic safety evidence kind/version/dryRun mismatch");
  const normalizedInput = normalizeEconomicSafetyFinalizationInputV1(expected);
  if (authority !== undefined && (
    value.authorityRoot !== positiveHash(authority.authorityRoot, "economicSafety.expected.authorityRoot")
    || value.implementationHash !== positiveHash(authority.implementationHash, "economicSafety.expected.implementationHash")
    || value.releaseProvenanceHash !== positiveHash(authority.releaseProvenanceHash, "economicSafety.expected.releaseProvenanceHash")
  )) throw new TypeError("economic safety evidence release authority binding mismatch");
  const { receiptRoot: suppliedEconomicReceiptRoot, ...economicDecision } = value.economic;
  const normalizedEconomic = economic(economicDecision);
  if (normalizedEconomic.profitAsset.identity.chainId !== normalizedInput.source.chainId) throw new TypeError("economic safety profit asset chain mismatch");
  if (normalizedEconomic.valuationFact.generationId !== normalizedInput.generationId
    || encodeCanonicalJson(normalizedEconomic.valuationFact.source) !== encodeCanonicalJson(normalizedInput.source)) {
    throw new TypeError("economic safety valuation fact source/generation mismatch");
  }
  if (normalizedEconomic.receiptRoot !== suppliedEconomicReceiptRoot) throw new TypeError("economic safety economic receipt root mismatch");
  const suppliedSafetyReceiptRoot = value.safety.receiptRoot;
  const suppliedObligationReceiptSetRoot = value.safety.obligationReceiptSetRoot;
  const {
    receiptRoot: _suppliedSafetyReceiptRoot,
    obligationReceiptSetRoot: _suppliedObligationReceiptSetRoot,
    ...safetyDecision
  } = value.safety;
  const normalizedSafety = safety({
    ...safetyDecision,
    obligationReceipts: safetyDecision.obligationReceipts.map(({ receiptRoot: _root, ...receipt }) => receipt),
  }, normalizedInput.obligationRoot, normalizedInput.declaredObligations);
  if (normalizedSafety.receiptRoot !== suppliedSafetyReceiptRoot
    || normalizedSafety.obligationReceiptSetRoot !== suppliedObligationReceiptSetRoot
    || normalizedSafety.obligationReceipts.some((receipt, index) => receipt.receiptRoot !== value.safety.obligationReceipts[index]?.receiptRoot)) {
    throw new TypeError("economic safety safety receipt root mismatch");
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "aloha.economic-safety-finalization-evidence-v1" as const,
    authorityRoot: positiveHash(value.authorityRoot, "economicSafety.evidence.authorityRoot"),
    implementationHash: positiveHash(value.implementationHash, "economicSafety.evidence.implementationHash"),
    releaseProvenanceHash: positiveHash(value.releaseProvenanceHash, "economicSafety.evidence.releaseProvenanceHash"),
    correlationId: positiveHash(value.correlationId, "economicSafety.evidence.correlationId"),
    generationId: assertNonEmptyString(value.generationId, "economicSafety.evidence.generationId"),
    source: source(value.source, "economicSafety.evidence.source"),
    objectiveRef: positiveHash(value.objectiveRef, "economicSafety.evidence.objectiveRef"),
    exactHash: positiveHash(value.exactHash, "economicSafety.evidence.exactHash"),
    programHash: positiveHash(value.programHash, "economicSafety.evidence.programHash"),
    obligationRoot: positiveHash(value.obligationRoot, "economicSafety.evidence.obligationRoot"),
    finalSimulationReceiptHash: positiveHash(value.finalSimulationReceiptHash, "economicSafety.evidence.finalSimulationReceiptHash"),
    effectsHash: positiveHash(value.effectsHash, "economicSafety.evidence.effectsHash"),
    executionOwnerEvidenceRoot: positiveHash(value.executionOwnerEvidenceRoot, "economicSafety.evidence.executionOwnerEvidenceRoot"),
    finalSimulationOwnerEvidenceRoot: positiveHash(value.finalSimulationOwnerEvidenceRoot, "economicSafety.evidence.finalSimulationOwnerEvidenceRoot"),
    executionOwnerFacts: canonical(value.executionOwnerFacts, "economicSafety.evidence.executionOwnerFacts"),
    executionOwnerFactsRoot: positiveHash(value.executionOwnerFactsRoot, "economicSafety.evidence.executionOwnerFactsRoot"),
    finalSimulationOwnerFacts: canonical(value.finalSimulationOwnerFacts, "economicSafety.evidence.finalSimulationOwnerFacts"),
    finalSimulationOwnerFactsRoot: positiveHash(value.finalSimulationOwnerFactsRoot, "economicSafety.evidence.finalSimulationOwnerFactsRoot"),
    declaredObligations: declaredObligations(value.declaredObligations),
    declaredObligationSetRoot: positiveHash(value.declaredObligationSetRoot, "economicSafety.evidence.declaredObligationSetRoot"),
    economic: normalizedEconomic,
    safety: normalizedSafety,
    dryRun: true as const,
  };
  for (const key of ["releaseProvenanceHash", "correlationId", "generationId", "objectiveRef", "exactHash", "programHash", "obligationRoot", "finalSimulationReceiptHash", "effectsHash", "executionOwnerEvidenceRoot", "finalSimulationOwnerEvidenceRoot"] as const) if (body[key] !== normalizedInput[key]) throw new TypeError(`economic safety evidence ${key} mismatch`);
  if (JSON.stringify(body.source) !== JSON.stringify(normalizedInput.source)) throw new TypeError("economic safety evidence source mismatch");
  if (JSON.stringify(body.executionOwnerFacts) !== JSON.stringify(normalizedInput.executionOwnerFacts)
    || JSON.stringify(body.finalSimulationOwnerFacts) !== JSON.stringify(normalizedInput.finalSimulationOwnerFacts)
    || JSON.stringify(body.declaredObligations) !== JSON.stringify(normalizedInput.declaredObligations)) throw new TypeError("economic safety evidence owner facts mismatch");
  if (body.executionOwnerFactsRoot !== hashDomain("aloha/economic-safety/execution-owner-facts/v1", body.executionOwnerFacts)
    || body.finalSimulationOwnerFactsRoot !== hashDomain("aloha/economic-safety/final-simulation-owner-facts/v1", body.finalSimulationOwnerFacts)
    || body.declaredObligationSetRoot !== hashDomain("aloha/economic-safety/declared-obligation-set/v1", body.declaredObligations)) throw new TypeError("economic safety evidence fact commitment mismatch");
  const evidenceRoot = positiveHash(value.evidenceRoot, "economicSafety.evidence.evidenceRoot");
  if (evidenceRoot !== hashDomain("aloha/economic-safety-finalization-evidence/v1", evidencePayload(body))) throw new TypeError("economic safety evidence root mismatch");
  return deepFreeze({ ...body, evidenceRoot });
}

function policyRejectionCode(value: unknown, path: string): EconomicSafetyPolicyRejectionCodeV1 {
  if (value !== "quoted-gain-not-positive" && value !== "quoted-gain-below-minimum"
    && value !== "value-at-risk-exceeded" && value !== "declared-gas-exceeded"
    && value !== "net-profit-not-positive") throw new TypeError(`${path} is invalid`);
  return value;
}

function economicSafetyChainRejectionBody(
  inputValue: {
    readonly authorityRoot: Hash;
    readonly implementationHash: Hash;
    readonly releaseProvenanceHash: Hash;
    readonly input: EconomicSafetyFinalizationInputV1;
    readonly code: EconomicSafetyPolicyRejectionCodeV1;
  },
): Omit<EconomicSafetyChainRejectionV1, "evidenceRoot"> {
  const normalized = normalizeEconomicSafetyFinalizationInputV1(inputValue.input);
  if (normalized.releaseProvenanceHash !== inputValue.releaseProvenanceHash) throw new TypeError("economic safety rejection release provenance mismatch");
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.economic-safety-chain-rejection-v1" as const,
    authorityRoot: positiveHash(inputValue.authorityRoot, "economicSafety.rejection.authorityRoot"),
    implementationHash: positiveHash(inputValue.implementationHash, "economicSafety.rejection.implementationHash"),
    releaseProvenanceHash: normalized.releaseProvenanceHash,
    correlationId: normalized.correlationId,
    generationId: normalized.generationId,
    source: normalized.source,
    objectiveRef: normalized.objectiveRef,
    exactHash: normalized.exactHash,
    programHash: normalized.programHash,
    obligationRoot: normalized.obligationRoot,
    finalSimulationReceiptHash: normalized.finalSimulationReceiptHash,
    effectsHash: normalized.effectsHash,
    executionOwnerEvidenceRoot: normalized.executionOwnerEvidenceRoot,
    finalSimulationOwnerEvidenceRoot: normalized.finalSimulationOwnerEvidenceRoot,
    executionOwnerFactsRoot: hashDomain("aloha/economic-safety/execution-owner-facts/v1", normalized.executionOwnerFacts),
    finalSimulationOwnerFactsRoot: hashDomain("aloha/economic-safety/final-simulation-owner-facts/v1", normalized.finalSimulationOwnerFacts),
    declaredObligationSetRoot: hashDomain("aloha/economic-safety/declared-obligation-set/v1", normalized.declaredObligations),
    code: policyRejectionCode(inputValue.code, "economicSafety.rejection.code"),
  });
}

export function sealEconomicSafetyChainRejectionV1(inputValue: {
  readonly authorityRoot: Hash;
  readonly implementationHash: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly input: EconomicSafetyFinalizationInputV1;
  readonly code: EconomicSafetyPolicyRejectionCodeV1;
}): EconomicSafetyChainRejectionV1 {
  const body = economicSafetyChainRejectionBody(inputValue);
  return deepFreeze({ ...body, evidenceRoot: hashDomain("aloha/economic-safety-chain-rejection/v1", body as unknown as CanonicalJson) });
}

export function validateEconomicSafetyChainRejectionV1(
  value: EconomicSafetyChainRejectionV1,
  expected: EconomicSafetyFinalizationInputV1,
  authority: EconomicSafetyEvidenceAuthorityExpectationV1,
): EconomicSafetyChainRejectionV1 {
  assertPlainObject(value, "economicSafety.rejection");
  assertExactKeys(value, [
    "schemaVersion", "kind", "authorityRoot", "implementationHash", "releaseProvenanceHash", "correlationId",
    "generationId", "source", "objectiveRef", "exactHash", "programHash", "obligationRoot", "finalSimulationReceiptHash",
    "effectsHash", "executionOwnerEvidenceRoot", "finalSimulationOwnerEvidenceRoot", "executionOwnerFactsRoot",
    "finalSimulationOwnerFactsRoot", "declaredObligationSetRoot", "code", "evidenceRoot",
  ], "economicSafety.rejection");
  if (value.schemaVersion !== 1 || value.kind !== "aloha.economic-safety-chain-rejection-v1") throw new TypeError("economic safety rejection kind/version mismatch");
  const body = economicSafetyChainRejectionBody({
    authorityRoot: positiveHash(value.authorityRoot, "economicSafety.rejection.authorityRoot"),
    implementationHash: positiveHash(value.implementationHash, "economicSafety.rejection.implementationHash"),
    releaseProvenanceHash: positiveHash(value.releaseProvenanceHash, "economicSafety.rejection.releaseProvenanceHash"),
    input: expected,
    code: policyRejectionCode(value.code, "economicSafety.rejection.code"),
  });
  if (body.authorityRoot !== authority.authorityRoot || body.implementationHash !== authority.implementationHash
    || body.releaseProvenanceHash !== authority.releaseProvenanceHash) throw new TypeError("economic safety rejection authority binding mismatch");
  for (const key of Object.keys(body) as (keyof typeof body)[]) {
    if (encodeCanonicalJson(value[key] as CanonicalJson) !== encodeCanonicalJson(body[key] as CanonicalJson)) {
      throw new TypeError(`economic safety rejection ${String(key)} mismatch`);
    }
  }
  const evidenceRoot = positiveHash(value.evidenceRoot, "economicSafety.rejection.evidenceRoot");
  if (evidenceRoot !== hashDomain("aloha/economic-safety-chain-rejection/v1", body as unknown as CanonicalJson)) throw new TypeError("economic safety rejection root mismatch");
  return deepFreeze({ ...body, evidenceRoot });
}

export function assertIssuedEconomicSafetyFinalizationServiceV1(value: unknown): asserts value is EconomicSafetyFinalizationServiceV1 {
  if (value === null || typeof value !== "object" || !isEconomicSafetyFinalizationServiceV1(value)) throw new TypeError("economic safety finalization service is not owner-issued");
}

/** Internal owner helper; it seals bytes but does not issue a capability. */
export function sealEconomicSafetyEvidenceV1(inputValue: {
  readonly authorityRoot: Hash;
  readonly implementationHash: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly input: EconomicSafetyFinalizationInputV1;
  readonly decision: EconomicSafetyDecisionV1;
}): EconomicSafetyEvidenceV1 {
  const normalized = normalizeEconomicSafetyFinalizationInputV1(inputValue.input);
  if (normalized.releaseProvenanceHash !== inputValue.releaseProvenanceHash) throw new TypeError("economic safety release provenance mismatch");
  const body = {
    schemaVersion: 1 as const,
    kind: "aloha.economic-safety-finalization-evidence-v1" as const,
    authorityRoot: positiveHash(inputValue.authorityRoot, "economicSafety.owner.authorityRoot"),
    implementationHash: positiveHash(inputValue.implementationHash, "economicSafety.owner.implementationHash"),
    releaseProvenanceHash: positiveHash(inputValue.releaseProvenanceHash, "economicSafety.owner.releaseProvenanceHash"),
    correlationId: normalized.correlationId,
    generationId: normalized.generationId,
    source: normalized.source,
    objectiveRef: normalized.objectiveRef,
    exactHash: normalized.exactHash,
    programHash: normalized.programHash,
    obligationRoot: normalized.obligationRoot,
    finalSimulationReceiptHash: normalized.finalSimulationReceiptHash,
    effectsHash: normalized.effectsHash,
    executionOwnerEvidenceRoot: normalized.executionOwnerEvidenceRoot,
    finalSimulationOwnerEvidenceRoot: normalized.finalSimulationOwnerEvidenceRoot,
    executionOwnerFacts: normalized.executionOwnerFacts,
    executionOwnerFactsRoot: hashDomain("aloha/economic-safety/execution-owner-facts/v1", normalized.executionOwnerFacts),
    finalSimulationOwnerFacts: normalized.finalSimulationOwnerFacts,
    finalSimulationOwnerFactsRoot: hashDomain("aloha/economic-safety/final-simulation-owner-facts/v1", normalized.finalSimulationOwnerFacts),
    declaredObligations: normalized.declaredObligations,
    declaredObligationSetRoot: hashDomain("aloha/economic-safety/declared-obligation-set/v1", normalized.declaredObligations),
    economic: economic(inputValue.decision.economic),
    safety: safety(inputValue.decision.safety, normalized.obligationRoot, normalized.declaredObligations),
    dryRun: true as const,
  };
  if (body.economic.profitAsset.identity.chainId !== normalized.source.chainId) throw new TypeError("economic safety profit asset chain mismatch");
  if (body.economic.valuationFact.generationId !== normalized.generationId
    || encodeCanonicalJson(body.economic.valuationFact.source) !== encodeCanonicalJson(normalized.source)) {
    throw new TypeError("economic safety valuation fact source/generation mismatch");
  }
  return deepFreeze({ ...body, evidenceRoot: hashDomain("aloha/economic-safety-finalization-evidence/v1", evidencePayload(body)) });
}
