import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  decodeCanonicalBytes,
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalBytes,
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
  ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
  decodeSafetyProfileV1,
  type SafetyProfileV1,
} from "../../../specs/economic-safety-profile/src/index.ts";
import type {
  EconomicSafetyDecisionV1,
  EconomicSafetyFinalizationInputV1,
  EconomicSafetyQualifiedEvaluatorV1,
} from "./index.ts";
import { EconomicSafetyPolicyRejectionErrorV1 } from "./policy-rejection.ts";
import type {
  EconomicValuationOwnerRuntimeBindingV1,
  EconomicValuationOwnerRuntimeDescriptorV1,
} from "../../../specs/economic-valuation-owner/src/index.ts";

export interface EconomicSafetyActionOwnerPolicyV1 {
  readonly familyDefinitionHash: Hash;
  readonly ownerId: string;
  readonly ownerRef: Hash;
  readonly implementationHash: Hash;
  readonly schemaRef: Hash;
  readonly implementationClosureRoot: Hash;
  readonly claimSchemaRefs: readonly Hash[];
  readonly qualificationLeafDigest: Hash;
  readonly verifierHash: Hash;
}

/** Process-local release composition binding. The verifier function is never
 * serialized or admitted through deployment policy bytes; it is resolved from
 * the generated Family action-owner port after runtime composition opens. */
export interface EconomicSafetyActionOwnerVerifierBindingV1 extends EconomicSafetyActionOwnerPolicyV1 {
  readonly verify: (payload: unknown) => unknown;
  readonly verifyObligations: (payload: unknown) => unknown;
}

export type EconomicSafetyValuationOwnerDescriptorV1 = EconomicValuationOwnerRuntimeDescriptorV1;
export type EconomicSafetyValuationOwnerBindingV1 = EconomicValuationOwnerRuntimeBindingV1;

export interface EconomicSafetyExecutorQualificationV1 {
  readonly executorKind: string;
  readonly engineBuildFingerprint: Hash;
  readonly executableFingerprint: Hash;
  readonly qualifiedExecutorRegistryRoot: Hash;
  readonly selectedExecutorLeafHash: Hash;
  readonly releaseRoleManifestRoot: Hash;
}

export interface EconomicSafetyObjectiveTemplateV1 {
  readonly objectiveRef: Hash;
  readonly profitAsset: AssetReferenceV1;
  readonly profitAccount: string;
  readonly minNetGain: string;
  readonly maxGas: string;
  readonly maxValueAtRisk: string;
  readonly priorityFeePerGas: string;
  readonly bidCostNative: string;
  readonly valuationOwnerRef: Hash;
}

type RecordValue = Record<string, unknown>;

export const ECONOMIC_SAFETY_EVALUATOR_EXPORT_IDENTITY_V1 = Object.freeze({
  modulePath: "packages/economics-safety/src/evaluator.ts",
  exportName: "createEconomicSafetyQualifiedEvaluatorV1",
});

export const ECONOMIC_SAFETY_EVALUATOR_EXPORT_IDENTITY_HASH_V1 = hashDomain(
  "aloha/economic-safety/evaluator-export-identity/v1",
  ECONOMIC_SAFETY_EVALUATOR_EXPORT_IDENTITY_V1,
);

function record(value: unknown, path: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as RecordValue;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value;
}

function address(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/.test(value)) throw new TypeError(`${path} must be a canonical EVM address`);
  return value;
}

function decimal(value: unknown, path: string): string {
  return assertDecimalString(value, path);
}

function amount(value: unknown, path: string): { readonly assetRef: Hash; readonly amount: string } {
  const item = record(value, path);
  assertExactKeys(item, ["assetRef", "amount"], path);
  return Object.freeze({ assetRef: assertHash(item.assetRef, `${path}.assetRef`), amount: decimal(item.amount, `${path}.amount`) });
}

function normalizeTemplate(value: EconomicSafetyObjectiveTemplateV1, path: string): EconomicSafetyObjectiveTemplateV1 {
  assertExactKeys(value, [
    "objectiveRef", "profitAsset", "profitAccount", "minNetGain", "maxGas", "maxValueAtRisk",
    "priorityFeePerGas", "bidCostNative", "valuationOwnerRef",
  ], path);
  const profitAsset = decodeAssetReferenceV1(value.profitAsset, `${path}.profitAsset`);
  const normalized = {
    objectiveRef: assertHash(value.objectiveRef, `${path}.objectiveRef`),
    profitAsset,
    profitAccount: address(value.profitAccount, `${path}.profitAccount`),
    minNetGain: decimal(value.minNetGain, `${path}.minNetGain`),
    maxGas: decimal(value.maxGas, `${path}.maxGas`),
    maxValueAtRisk: decimal(value.maxValueAtRisk, `${path}.maxValueAtRisk`),
    priorityFeePerGas: decimal(value.priorityFeePerGas, `${path}.priorityFeePerGas`),
    bidCostNative: decimal(value.bidCostNative, `${path}.bidCostNative`),
    valuationOwnerRef: assertHash(value.valuationOwnerRef, `${path}.valuationOwnerRef`),
  };
  return deepFreeze(normalized);
}

function normalizeActionOwners(value: readonly EconomicSafetyActionOwnerVerifierBindingV1[]): readonly EconomicSafetyActionOwnerVerifierBindingV1[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("economic safety generated action owners must be non-empty");
  const normalized = value.map((entry, index) => {
    const path = `economicSafety.actionOwners[${index}]`;
    const verify: (payload: unknown) => unknown = entry.verify;
    const verifyObligations: (payload: unknown) => unknown = entry.verifyObligations;
    assertExactKeys(entry, [
      "familyDefinitionHash", "ownerId", "ownerRef", "implementationHash", "schemaRef",
      "implementationClosureRoot", "claimSchemaRefs", "qualificationLeafDigest", "verifierHash",
      "verify", "verifyObligations",
    ], path);
    if (typeof verify !== "function") throw new TypeError(`${path}.verify must be a package-owned verifier`);
    if (typeof verifyObligations !== "function") throw new TypeError(`${path}.verifyObligations must be a package-owned verifier`);
    if (!Array.isArray(entry.claimSchemaRefs) || entry.claimSchemaRefs.length === 0) {
      throw new TypeError(`${path}.claimSchemaRefs must be non-empty`);
    }
    const claimSchemaRefs = Object.freeze(entry.claimSchemaRefs.map((schemaRef, claimIndex) =>
      assertHash(schemaRef, `${path}.claimSchemaRefs[${claimIndex}]`)));
    for (let claimIndex = 1; claimIndex < claimSchemaRefs.length; claimIndex += 1) {
      if (claimSchemaRefs[claimIndex - 1]! >= claimSchemaRefs[claimIndex]!) {
        throw new TypeError(`${path}.claimSchemaRefs must be strictly sorted and unique`);
      }
    }
    return Object.freeze({
      familyDefinitionHash: assertHash(entry.familyDefinitionHash, `${path}.familyDefinitionHash`),
      ownerId: assertNonEmptyString(entry.ownerId, `${path}.ownerId`),
      ownerRef: assertHash(entry.ownerRef, `${path}.ownerRef`),
      implementationHash: assertHash(entry.implementationHash, `${path}.implementationHash`),
      schemaRef: assertHash(entry.schemaRef, `${path}.schemaRef`),
      implementationClosureRoot: assertHash(entry.implementationClosureRoot, `${path}.implementationClosureRoot`),
      claimSchemaRefs,
      qualificationLeafDigest: assertHash(entry.qualificationLeafDigest, `${path}.qualificationLeafDigest`),
      verifierHash: assertHash(entry.verifierHash, `${path}.verifierHash`),
      verify,
      verifyObligations,
    });
  });
  if (new Set(normalized.map(entry => `${entry.familyDefinitionHash}\u0000${entry.ownerRef}`)).size !== normalized.length) throw new TypeError("economic safety generated action owners contain duplicates");
  return Object.freeze(normalized);
}

export function decodeEconomicSafetyObjectiveTemplatesV1(
  bytes: unknown,
): readonly EconomicSafetyObjectiveTemplateV1[] {
  if (!(bytes instanceof Uint8Array) || Object.getPrototypeOf(bytes) !== Uint8Array.prototype) {
    throw new TypeError("economic safety policy bytes must be a concrete Uint8Array");
  }
  const value = decodeCanonicalBytes(Uint8Array.from(bytes));
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("economic safety template bytes must contain a non-empty array");
  }
  return Object.freeze(value.map((entry, index) =>
    normalizeTemplate(entry as unknown as EconomicSafetyObjectiveTemplateV1, `economicSafety.templates[${index}]`)));
}

export function encodeEconomicSafetyObjectiveTemplatesV1(
  value: readonly EconomicSafetyObjectiveTemplateV1[],
): Uint8Array {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("economic safety templates must be non-empty");
  const normalized = value.map((entry, index) => normalizeTemplate(entry, `economicSafety.templates[${index}]`));
  if (new Set(normalized.map(policy => policy.objectiveRef)).size !== normalized.length) {
    throw new TypeError("economic safety objective policies contain duplicates");
  }
  return encodeCanonicalBytes(normalized as unknown as CanonicalJson);
}

export function economicSafetyObjectivePolicyRootV1(
  templates: readonly EconomicSafetyObjectiveTemplateV1[],
  actionOwners: readonly EconomicSafetyActionOwnerPolicyV1[],
  valuationOwners: readonly EconomicSafetyValuationOwnerDescriptorV1[],
  executorQualification: EconomicSafetyExecutorQualificationV1,
  safetyProfile: SafetyProfileV1,
): Hash {
  return hashDomain("aloha/runtime-release-economic-evaluator-policies/v4", {
    templates,
    actionOwners,
    valuationOwners,
    executorQualification,
    safetyProfile,
  } as unknown as CanonicalJson);
}

function tokenBalances(value: unknown, path: string): Map<string, bigint> {
  const result = new Map<string, bigint>();
  for (const [index, raw] of array(value, path).entries()) {
    const itemPath = `${path}[${index}]`;
    const item = record(raw, itemPath);
    assertExactKeys(item, ["token", "account", "balance"], itemPath);
    const token = address(item.token, `${itemPath}.token`);
    const account = address(item.account, `${itemPath}.account`);
    const key = `${token}\u0000${account}`;
    if (result.has(key)) throw new TypeError(`${path} contains duplicate token/account entries`);
    result.set(key, BigInt(decimal(item.balance, `${itemPath}.balance`)));
  }
  return result;
}

async function evaluatePolicy(
  policy: EconomicSafetyObjectiveTemplateV1,
  qualifiedActionOwners: readonly EconomicSafetyActionOwnerVerifierBindingV1[],
  valuationOwners: readonly EconomicSafetyValuationOwnerBindingV1[],
  executorQualification: EconomicSafetyExecutorQualificationV1,
  safetyProfile: SafetyProfileV1,
  input: EconomicSafetyFinalizationInputV1,
): Promise<EconomicSafetyDecisionV1> {
  const execution = record(input.executionOwnerFacts, "economicSafety.executionOwnerFacts");
  assertExactKeys(execution, ["kind", "callerMode", "preCalls", "observationPairs", "observeLogs", "callSequence", "routeAssetReferences", "actionOwners", "declaredObligations", "obligationRoot"], "economicSafety.executionOwnerFacts");
  if (execution.kind !== "aloha.search-runtime.execution-program-owner-facts-v1" || execution.obligationRoot !== input.obligationRoot) throw new TypeError("economic safety execution owner facts mismatch");
  if (execution.callerMode !== "top-level" || array(execution.preCalls, "executionOwnerFacts.preCalls").length !== 0) throw new TypeError("economic safety evaluator supports only direct position-conserving routes");
  const actionFacts = array(execution.actionOwners, "executionOwnerFacts.actionOwners");
  if (actionFacts.length === 0) throw new TypeError("economic safety action set is empty");
  const actions = actionFacts.map((raw, index) => {
    const path = `executionOwnerFacts.actionOwners[${index}]`;
    const item = record(raw, path);
    assertExactKeys(item, ["familyDefinitionHash", "routeBindingHash", "actionOwnerId", "actionOwnerRef", "actionHash", "actionArtifactHash", "exactEvaluationHash", "payload", "payloadHash", "inputs", "outputs", "obligationRoot"], path);
    const routeBindingHash = assertHash(item.routeBindingHash, `${path}.routeBindingHash`);
    const familyDefinitionHash = assertHash(item.familyDefinitionHash, `${path}.familyDefinitionHash`);
    const ownerRef = assertHash(item.actionOwnerRef, `${path}.actionOwnerRef`);
    const ownerId = assertNonEmptyString(item.actionOwnerId, `${path}.actionOwnerId`);
    const owner = qualifiedActionOwners.find(entry => entry.familyDefinitionHash === familyDefinitionHash && entry.ownerRef === ownerRef && entry.ownerId === ownerId);
    if (owner === undefined) throw new TypeError(`${path} is not release-qualified for economic safety`);
    const payload = record(item.payload, `${path}.payload`);
    if (assertHash(item.payloadHash, `${path}.payloadHash`) !== hashDomain("aloha/family-search-payload/v1", { kind: "action", payload } as unknown as CanonicalJson)) {
      throw new TypeError(`${path} payload hash mismatch`);
    }
    const verified = record(owner.verify(payload), `${path}.verifiedPayload`);
    if (verified.actionOwnerId !== owner.ownerId
      || verified.actionImplementationHash !== owner.implementationHash
      || verified.schemaRef !== owner.schemaRef
      || verified.actionHash !== item.actionHash
      || verified.exactEvaluationHash !== item.exactEvaluationHash
      || verified.obligationRoot !== item.obligationRoot) {
      throw new TypeError(`${path} package-owned action verification mismatch`);
    }
    const requiredClaims = safetyProfile.requiredClaims.filter(claim => claim.ownerRef === owner.ownerRef);
    if (requiredClaims.length !== owner.claimSchemaRefs.length
      || requiredClaims.some((claim, claimIndex) => claim.claimSchemaRef !== owner.claimSchemaRefs[claimIndex]
        || claim.qualificationLeafDigest !== owner.qualificationLeafDigest
        || claim.revmObservationSchemaRef !== ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1)) {
      throw new TypeError(`${path} SafetyProfile does not exactly cover the selected qualified owner`);
    }
    const rawProofs = owner.verifyObligations(payload);
    const proofValues = Array.isArray(rawProofs) ? rawProofs : [rawProofs];
    const ownerProofs = proofValues.map((rawProof, proofIndex) => {
      const proofPath = `${path}.obligationProofs[${proofIndex}]`;
      const proof = record(rawProof, proofPath);
      assertExactKeys(proof, ["kind", "schemaRef", "implementationHash", "subjectRoot", "proofRoot", "outcome"], proofPath);
      if (proof.kind !== "aloha.family-action-obligation-verifier-receipt-v1"
        || proof.implementationHash !== owner.implementationHash
        || proof.subjectRoot !== item.obligationRoot
        || proof.outcome !== "satisfied") {
        throw new TypeError(`${path} package-owned obligation verifier receipt mismatch`);
      }
      return Object.freeze({
        schemaRef: assertHash(proof.schemaRef, `${proofPath}.schemaRef`),
        proofRoot: assertHash(proof.proofRoot, `${proofPath}.proofRoot`),
      });
    }).sort((left, right) => left.schemaRef.localeCompare(right.schemaRef));
    if (ownerProofs.length !== requiredClaims.length
      || ownerProofs.some((proof, proofIndex) => proof.schemaRef !== requiredClaims[proofIndex]?.claimSchemaRef)) {
      throw new TypeError(`${path} package-owned obligation proof set does not exact-cover SafetyProfile claims`);
    }
    if (encodeCanonicalJson(verified.inputs as CanonicalJson) !== encodeCanonicalJson(item.inputs as CanonicalJson)
      || encodeCanonicalJson(verified.outputs as CanonicalJson) !== encodeCanonicalJson(item.outputs as CanonicalJson)) {
      throw new TypeError(`${path} package-owned amount verification mismatch`);
    }
    if (verified.obligationRoot !== item.obligationRoot) throw new TypeError(`${path} owner payload obligation mismatch`);
    const inputs = array(item.inputs, `${path}.inputs`).map((entry, amountIndex) => amount(entry, `${path}.inputs[${amountIndex}]`));
    const outputs = array(item.outputs, `${path}.outputs`).map((entry, amountIndex) => amount(entry, `${path}.outputs[${amountIndex}]`));
    if (inputs.length !== 1 || outputs.length !== 1) throw new TypeError(`${path} must be a single-input/single-output action`);
    return Object.freeze({
      owner,
      routeBindingHash,
      actionHash: assertHash(item.actionHash, `${path}.actionHash`),
      actionArtifactHash: assertHash(item.actionArtifactHash, `${path}.actionArtifactHash`),
      exactEvaluationHash: assertHash(item.exactEvaluationHash, `${path}.exactEvaluationHash`),
      obligationRoot: assertHash(item.obligationRoot, `${path}.obligationRoot`),
      ownerProofs: Object.freeze(ownerProofs),
      gasUpperBound: BigInt(decimal(verified.gasUpperBound, `${path}.verifiedPayload.gasUpperBound`)),
      input: inputs[0]!,
      output: outputs[0]!,
    });
  });
  for (let index = 1; index < actions.length; index += 1) {
    const previous = actions[index - 1]!;
    const current = actions[index]!;
    if (previous.output.assetRef !== current.input.assetRef || previous.output.amount !== current.input.amount) throw new TypeError("economic safety route action chain is discontinuous");
  }
  const first = actions[0]!;
  const last = actions[actions.length - 1]!;
  if (first.input.assetRef !== policy.profitAsset.assetRef || last.output.assetRef !== policy.profitAsset.assetRef) throw new TypeError("economic safety route does not close in the objective asset");
  const quotedGross = BigInt(last.output.amount) - BigInt(first.input.amount);
  if (quotedGross <= 0n) throw new EconomicSafetyPolicyRejectionErrorV1("quoted-gain-not-positive");
  if (quotedGross <= BigInt(policy.minNetGain)) throw new EconomicSafetyPolicyRejectionErrorV1("quoted-gain-below-minimum");
  if (BigInt(first.input.amount) > BigInt(policy.maxValueAtRisk)) throw new EconomicSafetyPolicyRejectionErrorV1("value-at-risk-exceeded");
  if (actions.reduce((total, action) => total + action.gasUpperBound, 0n) > BigInt(policy.maxGas)) throw new EconomicSafetyPolicyRejectionErrorV1("declared-gas-exceeded");

  const finalFacts = record(input.finalSimulationOwnerFacts, "economicSafety.finalSimulationOwnerFacts");
  assertExactKeys(finalFacts, ["kind", "artifactProgramHash", "wireProgramHash", "executorQualification", "projection", "workerReceipt"], "economicSafety.finalSimulationOwnerFacts");
  if (finalFacts.kind !== "aloha.qualified-final-simulation-owner-facts-v1") throw new TypeError("economic safety final simulation owner kind mismatch");
  const artifactProgramHash = assertHash(finalFacts.artifactProgramHash, "finalSimulationOwnerFacts.artifactProgramHash");
  const wireProgramHash = assertHash(finalFacts.wireProgramHash, "finalSimulationOwnerFacts.wireProgramHash");
  const observedQualification = record(finalFacts.executorQualification, "finalSimulationOwnerFacts.executorQualification");
  assertExactKeys(observedQualification, [
    "engineBuildFingerprint", "executableFingerprint", "qualifiedExecutorRegistryRoot",
    "selectedExecutorLeafHash", "releaseRoleManifestRoot",
  ], "finalSimulationOwnerFacts.executorQualification");
  if (executorQualification.executorKind !== "revm"
    || observedQualification.engineBuildFingerprint !== executorQualification.engineBuildFingerprint
    || observedQualification.executableFingerprint !== executorQualification.executableFingerprint
    || observedQualification.qualifiedExecutorRegistryRoot !== executorQualification.qualifiedExecutorRegistryRoot
    || observedQualification.selectedExecutorLeafHash !== executorQualification.selectedExecutorLeafHash
    || observedQualification.releaseRoleManifestRoot !== executorQualification.releaseRoleManifestRoot) {
    throw new TypeError("economic safety final simulation executor qualification mismatch");
  }
  const projection = record(finalFacts.projection, "finalSimulationOwnerFacts.projection");
  const projectionInput = record(projection.input, "finalSimulationOwnerFacts.projection.input");
  const block = record(projectionInput.block, "finalSimulationOwnerFacts.projection.input.block");
  const baseFee = BigInt(decimal(block.baseFeePerGas, "finalSimulationOwnerFacts.projection.input.block.baseFeePerGas"));
  const worker = record(finalFacts.workerReceipt, "finalSimulationOwnerFacts.workerReceipt");
  const workerKeys = ["requestId", "attemptId", "ownerRef", "generationId", "authority", "inputHash", "deadlineAtMs", "authorityRoot", "workerEpoch", "executorSessionHash", "engine", "engineBuildFingerprint", "caller", "observeAccounts", "source", "programHash", "status", "output", "effects", "executionReceiptHash"];
  if (Object.prototype.hasOwnProperty.call(worker, "effectTransport")) workerKeys.push("effectTransport");
  assertExactKeys(worker, workerKeys, "finalSimulationOwnerFacts.workerReceipt");
  if (worker.status !== "returned") throw new TypeError("economic safety requires a returned final simulation");
  if (worker.engine !== executorQualification.executorKind
    || worker.engineBuildFingerprint !== executorQualification.engineBuildFingerprint) {
    throw new TypeError("economic safety requires the qualified REVM engine");
  }
  if (artifactProgramHash !== input.programHash
    || worker.generationId !== input.generationId
    || encodeCanonicalJson(worker.source as CanonicalJson) !== encodeCanonicalJson(input.source as unknown as CanonicalJson)
    || worker.programHash !== wireProgramHash) throw new TypeError("economic safety worker receipt source/program mismatch");
  const authority = record(worker.authority, "finalSimulationOwnerFacts.workerReceipt.authority");
  if (worker.authorityRoot !== authority.authorityRoot || worker.workerEpoch !== authority.workerEpoch
    || worker.executorSessionHash !== authority.executorSessionHash) throw new TypeError("economic safety worker authority projection mismatch");
  if (typeof worker.deadlineAtMs !== "number" || !Number.isFinite(worker.deadlineAtMs)) throw new TypeError("economic safety worker deadline is invalid");
  if (!Array.isArray(worker.observeAccounts)) throw new TypeError("economic safety worker observation scope is invalid");
  const workerHasTransport = Object.prototype.hasOwnProperty.call(worker, "effectTransport");
  const projectionHasTransport = Object.prototype.hasOwnProperty.call(projection, "effectTransport");
  if (encodeCanonicalJson(worker.caller as CanonicalJson) !== encodeCanonicalJson(projection.caller as CanonicalJson)
    || encodeCanonicalJson(worker.observeAccounts as CanonicalJson) !== encodeCanonicalJson(projection.observeAccounts as CanonicalJson)
    || workerHasTransport !== projectionHasTransport
    || (workerHasTransport && encodeCanonicalJson(worker.effectTransport as CanonicalJson) !== encodeCanonicalJson(projection.effectTransport as CanonicalJson))) {
    throw new TypeError("economic safety worker projection mismatch");
  }
  if (!projectionHasTransport) throw new TypeError("economic safety effect transport is required");
  const effectTransport = record(projection.effectTransport, "finalSimulationOwnerFacts.projection.effectTransport");
  const effectCaller = record(effectTransport.caller, "finalSimulationOwnerFacts.projection.effectTransport.caller");
  if (effectCaller.executionMode !== execution.callerMode
    || encodeCanonicalJson(effectTransport.preCalls as CanonicalJson) !== encodeCanonicalJson(execution.preCalls as CanonicalJson)
    || encodeCanonicalJson(effectTransport.observeTokenBalances as CanonicalJson) !== encodeCanonicalJson(execution.observationPairs as CanonicalJson)
    || effectTransport.observeLogs !== execution.observeLogs) throw new TypeError("economic safety execution effect transport mismatch");
  const executionReceiptHash = assertHash(worker.executionReceiptHash, "finalSimulationOwnerFacts.workerReceipt.executionReceiptHash");
  const effects = record(worker.effects, "finalSimulationOwnerFacts.workerReceipt.effects");
  assertExactKeys(effects, ["format", "bytes", "observedAccounts", "effectsHash"], "finalSimulationOwnerFacts.workerReceipt.effects");
  if (effects.format !== "revm-effects-v1" || !Array.isArray(effects.observedAccounts)
    || encodeCanonicalJson(effects.observedAccounts as CanonicalJson) !== encodeCanonicalJson(worker.observeAccounts as CanonicalJson)
    || effects.effectsHash !== hashDomain("aloha/revm-effects-wire/v1", {
      format: effects.format,
      bytes: assertNonEmptyString(effects.bytes, "finalSimulationOwnerFacts.workerReceipt.effects.bytes"),
      observedAccounts: effects.observedAccounts,
    } as unknown as CanonicalJson)
    || effects.effectsHash !== input.effectsHash) throw new TypeError("economic safety final effects hash mismatch");
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
  if (executionReceiptHash !== hashDomain("aloha/revm-execution-receipt/v1", receiptBody as unknown as CanonicalJson)) {
    throw new TypeError("economic safety execution receipt hash mismatch");
  }
  const decodedEffects = record(decodeCanonicalJson(assertNonEmptyString(effects.bytes, "finalSimulationOwnerFacts.workerReceipt.effects.bytes")), "economicSafety.revmEffects");
  assertExactKeys(decodedEffects, ["accounts", "before", "gasUsed", "output", "status", "preCalls", "tokenBalancesBefore", "tokenBalancesAfter"], "economicSafety.revmEffects");
  if (decodedEffects.status !== "returned") throw new TypeError("economic safety REVM effects did not return");
  const gasUsed = BigInt(decimal(decodedEffects.gasUsed, "economicSafety.revmEffects.gasUsed"));
  if (gasUsed <= 0n || gasUsed > BigInt(policy.maxGas)) throw new TypeError("economic safety actual gas exceeds objective");
  const before = tokenBalances(decodedEffects.tokenBalancesBefore, "economicSafety.revmEffects.tokenBalancesBefore");
  const after = tokenBalances(decodedEffects.tokenBalancesAfter, "economicSafety.revmEffects.tokenBalancesAfter");
  const routeAssetReferences = array(execution.routeAssetReferences, "executionOwnerFacts.routeAssetReferences")
    .map((value, index) => decodeAssetReferenceV1(value, `executionOwnerFacts.routeAssetReferences[${index}]`));
  if (routeAssetReferences.length === 0
    || new Set(routeAssetReferences.map(reference => reference.assetRef)).size !== routeAssetReferences.length) {
    throw new TypeError("economic safety route asset references are empty or duplicated");
  }
  const assetByRef = new Map(routeAssetReferences.map(reference => [reference.assetRef, reference] as const));
  const routeAssetRefs = [...new Set(actions.flatMap(action => [action.input.assetRef, action.output.assetRef]))];
  for (const assetRef of routeAssetRefs) if (!assetByRef.has(assetRef)) throw new TypeError("economic safety route asset lacks a qualified identity");
  const deltas = routeAssetRefs.map(assetRef => {
    const reference = assetByRef.get(assetRef)!;
    if (reference.identity.kind !== "erc20" || reference.identity.address === null) throw new TypeError("economic safety route asset observation is not ERC20");
    const key = `${reference.identity.address}\u0000${policy.profitAccount}`;
    const beforeValue = before.get(key);
    const afterValue = after.get(key);
    if (beforeValue === undefined || afterValue === undefined) throw new TypeError("economic safety route asset balance observation is missing");
    return Object.freeze({ assetRef, token: reference.identity.address, before: beforeValue, after: afterValue, delta: afterValue - beforeValue });
  });
  const profitDelta = deltas.find(entry => entry.assetRef === policy.profitAsset.assetRef)?.delta;
  if (profitDelta === undefined || profitDelta !== quotedGross) throw new TypeError("economic safety quoted gain does not match final token delta");
  if (deltas.some(entry => entry.assetRef !== policy.profitAsset.assetRef && entry.delta !== 0n)) throw new TypeError("economic safety route leaves a standing intermediate position");

  const priorityFee = BigInt(policy.priorityFeePerGas);
  const effectiveGasPrice = baseFee + priorityFee;
  const gasCostNative = gasUsed * effectiveGasPrice;
  const valuationOwner = valuationOwners.find(owner => owner.ownerRef === policy.valuationOwnerRef);
  if (valuationOwner === undefined) throw new TypeError("economic safety valuation owner is unavailable for this profit asset");
  const valuationFact = await valuationOwner.observeCurrentSource({ generationId: input.generationId, source: input.source, asset: policy.profitAsset });
  assertExactKeys(valuationFact, ["kind", "ownerRef", "generationId", "source", "assetRef", "numerator", "denominator", "ownerImplementationHash", "valuationOwnerRegistryRoot", "qualifiedValuationOwnerSetRoot", "qualificationLeafDigest", "currentSourceObservationRoot", "factRoot"], "economicSafety.valuationFact");
  const valuationFactBody = deepFreeze({
    kind: valuationFact.kind,
    ownerRef: assertHash(valuationFact.ownerRef, "economicSafety.valuationFact.ownerRef"),
    generationId: assertNonEmptyString(valuationFact.generationId, "economicSafety.valuationFact.generationId"),
    source: valuationFact.source,
    assetRef: assertHash(valuationFact.assetRef, "economicSafety.valuationFact.assetRef"),
    numerator: decimal(valuationFact.numerator, "economicSafety.valuationFact.numerator"),
    denominator: decimal(valuationFact.denominator, "economicSafety.valuationFact.denominator"),
    ownerImplementationHash: assertHash(valuationFact.ownerImplementationHash, "economicSafety.valuationFact.ownerImplementationHash"),
    valuationOwnerRegistryRoot: assertHash(valuationFact.valuationOwnerRegistryRoot, "economicSafety.valuationFact.valuationOwnerRegistryRoot"),
    qualifiedValuationOwnerSetRoot: assertHash(valuationFact.qualifiedValuationOwnerSetRoot, "economicSafety.valuationFact.qualifiedValuationOwnerSetRoot"),
    qualificationLeafDigest: assertHash(valuationFact.qualificationLeafDigest, "economicSafety.valuationFact.qualificationLeafDigest"),
    currentSourceObservationRoot: assertHash(valuationFact.currentSourceObservationRoot, "economicSafety.valuationFact.currentSourceObservationRoot"),
  });
  if (valuationFactBody.kind !== "aloha.economic-valuation-fact-v1"
    || valuationFactBody.ownerRef !== valuationOwner.ownerRef
    || valuationFactBody.generationId !== input.generationId
    || encodeCanonicalJson(valuationFactBody.source as unknown as CanonicalJson) !== encodeCanonicalJson(input.source as unknown as CanonicalJson)
    || valuationFactBody.assetRef !== policy.profitAsset.assetRef
    || valuationFactBody.ownerImplementationHash !== valuationOwner.implementationHash
    || valuationFactBody.valuationOwnerRegistryRoot !== valuationOwner.valuationOwnerRegistryRoot
    || valuationFactBody.qualifiedValuationOwnerSetRoot !== valuationOwner.qualifiedValuationOwnerSetRoot
    || valuationFactBody.qualificationLeafDigest !== valuationOwner.qualificationLeafDigest
    || valuationFact.factRoot !== hashDomain("aloha/economic-valuation-fact/v1", valuationFactBody)) {
    throw new TypeError("economic safety valuation fact does not bind the current source and selected asset");
  }
  const numerator = BigInt(valuationFactBody.numerator);
  const denominator = BigInt(valuationFactBody.denominator);
  if (numerator <= 0n || denominator <= 0n) throw new TypeError("economic safety valuation ratio is invalid");
  const grossProfitNative = profitDelta * numerator / denominator;
  const bidCostNative = BigInt(policy.bidCostNative);
  const minNetProfitNative = BigInt(policy.minNetGain) * numerator / denominator;
  const netProfitNative = grossProfitNative - gasCostNative - bidCostNative;
  if (netProfitNative <= minNetProfitNative || netProfitNative <= 0n) throw new EconomicSafetyPolicyRejectionErrorV1("net-profit-not-positive");

  const declarations = input.declaredObligations;
  const revmObservationRoot = hashDomain("aloha/economic-safety/revm-observation/v1", {
    schemaRef: ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
    executorQualification,
    source: input.source,
    executionReceiptHash,
    effectsHash: input.effectsHash,
  });
  const selectedOwnerRefs = [...new Set(actions.map(action => action.owner.ownerRef))].sort();
  const selectedRequiredClaims = Object.freeze(safetyProfile.requiredClaims.filter(claim =>
    selectedOwnerRefs.includes(claim.ownerRef)));
  const requiredClaimSetRoot = hashDomain(
    "aloha/economic-safety-selected-required-claim-set/v1",
    selectedRequiredClaims,
  );
  const obligationReceipts = declarations.flatMap((declaration, index) => {
    const action = actions.find(entry => entry.obligationRoot === declaration.obligationRef && entry.owner.ownerRef === declaration.ownerRef);
    if (action === undefined) throw new TypeError(`economic safety obligation[${index}] has no qualified action proof`);
    return action.ownerProofs.map(ownerProof => Object.freeze({
      schemaRef: ownerProof.schemaRef,
      ownerRef: action.owner.ownerRef,
      qualificationLeafDigest: action.owner.qualificationLeafDigest,
      verifierHash: action.owner.verifierHash,
      subjectRoot: declaration.obligationRef,
      proofRoot: hashDomain("aloha/economic-safety/action-obligation-proof/v1", {
        actionHash: action.actionHash,
        actionArtifactHash: action.actionArtifactHash,
        exactEvaluationHash: action.exactEvaluationHash,
        executionReceiptHash,
        effectsHash: input.effectsHash,
        revmObservationRoot,
        ownerProofRoot: ownerProof.proofRoot,
      }),
      outcome: "satisfied" as const,
    }));
  });
  const routeProof = {
    objectiveRef: input.objectiveRef,
    actionHashes: actions.map(action => action.actionHash),
    executionReceiptHash,
    effectsHash: input.effectsHash,
    deltas: deltas.map(entry => ({ assetRef: entry.assetRef, before: entry.before.toString(10), after: entry.after.toString(10), delta: entry.delta.toString(10) })),
  } as const;
  return deepFreeze({
    economic: {
      kind: "aloha.economic-receipt-v1",
      gasUsed: gasUsed.toString(10),
      nextBlockBaseFeePerGas: baseFee.toString(10),
      priorityFeePerGas: priorityFee.toString(10),
      effectiveGasPrice: effectiveGasPrice.toString(10),
      gasCostNative: gasCostNative.toString(10),
      profitAsset: policy.profitAsset,
      grossProfitAmount: profitDelta.toString(10),
      valuationNumerator: numerator.toString(10),
      valuationDenominator: denominator.toString(10),
      valuationFactRoot: valuationFact.factRoot,
      valuationFact,
      grossProfitNative: grossProfitNative.toString(10),
      bidCostNative: bidCostNative.toString(10),
      netProfitNative: netProfitNative.toString(10),
      minNetProfitNative: minNetProfitNative.toString(10),
      verdict: "positive-net-ev",
    },
    safety: {
      kind: "aloha.final-safety-receipt-v1",
      obligationRoot: input.obligationRoot,
      obligationReceipts,
      safetyProfileRef: safetyProfile.profileRef,
      safetyProfileRoot: safetyProfile.profileCompositionRoot,
      selectedRequiredClaims,
      requiredClaimSetRoot,
      revmObservationSchemaRef: ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
      revmObservationRoot,
      assetConservationProofRoot: hashDomain("aloha/economic-safety/asset-conservation-proof/v1", routeProof),
      assetConservation: "satisfied",
      verdict: "safe",
    },
  } as EconomicSafetyDecisionV1);
}

export function createEconomicSafetyQualifiedEvaluatorV1(
  templates: readonly EconomicSafetyObjectiveTemplateV1[],
  actionOwners: readonly EconomicSafetyActionOwnerVerifierBindingV1[],
  valuationOwners: readonly EconomicSafetyValuationOwnerBindingV1[],
  executorQualification: EconomicSafetyExecutorQualificationV1,
  safetyProfileValue: SafetyProfileV1,
): EconomicSafetyQualifiedEvaluatorV1 {
  if (!Array.isArray(templates) || templates.length === 0) throw new TypeError("economic safety templates must be non-empty");
  const normalized = templates.map((template, index) => normalizeTemplate(template, `economicSafety.templates[${index}]`));
  if (new Set(normalized.map(policy => policy.objectiveRef)).size !== normalized.length) throw new TypeError("economic safety objective policies contain duplicates");
  const normalizedActionOwners = normalizeActionOwners(actionOwners);
  const safetyProfile = decodeSafetyProfileV1(safetyProfileValue);
  for (const owner of normalizedActionOwners) {
    const claims = safetyProfile.requiredClaims.filter(claim => claim.ownerRef === owner.ownerRef);
    if (claims.length !== owner.claimSchemaRefs.length
      || claims.some((claim, index) => claim.claimSchemaRef !== owner.claimSchemaRefs[index]
        || claim.qualificationLeafDigest !== owner.qualificationLeafDigest
        || claim.revmObservationSchemaRef !== ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1)) {
      throw new TypeError("economic safety profile does not exact-cover the release-qualified action owner set");
    }
  }
  if (!Array.isArray(valuationOwners) || valuationOwners.length === 0) throw new TypeError("economic safety valuation owners must be non-empty");
  const normalizedValuationOwners = Object.freeze(valuationOwners.map((owner, index) => {
    const path = `economicSafety.valuationOwners[${index}]`;
    const observeCurrentSource: EconomicSafetyValuationOwnerBindingV1["observeCurrentSource"] = owner.observeCurrentSource;
    assertExactKeys(owner, [
      "ownerRef", "implementationHash", "factSchemaRef", "implementationClosureRoot",
      "qualificationLeafDigest", "valuationOwnerRegistryRoot", "qualifiedValuationOwnerSetRoot",
      "observeCurrentSource",
    ], path);
    if (typeof observeCurrentSource !== "function") throw new TypeError(`${path}.observeCurrentSource must be owner-issued`);
    return Object.freeze({
      ownerRef: assertHash(owner.ownerRef, `${path}.ownerRef`),
      implementationHash: assertHash(owner.implementationHash, `${path}.implementationHash`),
      factSchemaRef: assertHash(owner.factSchemaRef, `${path}.factSchemaRef`),
      implementationClosureRoot: assertHash(owner.implementationClosureRoot, `${path}.implementationClosureRoot`),
      qualificationLeafDigest: assertHash(owner.qualificationLeafDigest, `${path}.qualificationLeafDigest`),
      valuationOwnerRegistryRoot: assertHash(owner.valuationOwnerRegistryRoot, `${path}.valuationOwnerRegistryRoot`),
      qualifiedValuationOwnerSetRoot: assertHash(owner.qualifiedValuationOwnerSetRoot, `${path}.qualifiedValuationOwnerSetRoot`),
      observeCurrentSource,
    });
  }));
  if (new Set(normalizedValuationOwners.map(owner => owner.ownerRef)).size !== normalizedValuationOwners.length) throw new TypeError("economic safety valuation owners contain duplicates");
  if (normalized.some(template => !normalizedValuationOwners.some(owner => owner.ownerRef === template.valuationOwnerRef))) throw new TypeError("economic safety template valuation owner is unavailable");
  assertExactKeys(executorQualification, [
    "executorKind", "engineBuildFingerprint", "executableFingerprint",
    "qualifiedExecutorRegistryRoot", "selectedExecutorLeafHash", "releaseRoleManifestRoot",
  ], "economicSafety.executorQualification");
  const normalizedExecutorQualification = Object.freeze({
    executorKind: assertNonEmptyString(executorQualification.executorKind, "economicSafety.executorQualification.executorKind"),
    engineBuildFingerprint: assertHash(executorQualification.engineBuildFingerprint, "economicSafety.executorQualification.engineBuildFingerprint"),
    executableFingerprint: assertHash(executorQualification.executableFingerprint, "economicSafety.executorQualification.executableFingerprint"),
    qualifiedExecutorRegistryRoot: assertHash(executorQualification.qualifiedExecutorRegistryRoot, "economicSafety.executorQualification.qualifiedExecutorRegistryRoot"),
    selectedExecutorLeafHash: assertHash(executorQualification.selectedExecutorLeafHash, "economicSafety.executorQualification.selectedExecutorLeafHash"),
    releaseRoleManifestRoot: assertHash(executorQualification.releaseRoleManifestRoot, "economicSafety.executorQualification.releaseRoleManifestRoot"),
  });
  return Object.freeze({
    async evaluate(input: EconomicSafetyFinalizationInputV1): Promise<EconomicSafetyDecisionV1> {
      const policy = normalized.find(candidate => candidate.objectiveRef === input.objectiveRef);
      if (policy === undefined) throw new TypeError("economic safety objective is not release-qualified");
      return await evaluatePolicy(
        policy,
        normalizedActionOwners,
        normalizedValuationOwners,
        normalizedExecutorQualification,
        safetyProfile,
        input,
      );
    },
  });
}
