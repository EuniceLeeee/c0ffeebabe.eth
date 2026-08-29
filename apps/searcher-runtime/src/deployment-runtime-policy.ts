import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  decodeCanonicalJson,
  encodeCanonicalBytes,
  gitSha40Schema,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeRuntimeReleaseBindingV1,
  runtimeReleaseBindingProvenanceHash,
  type RuntimeReleaseBindingV1,
} from "../../../specs/release-authority/src/index.ts";
import {
  decodeAssetReferenceV1,
  type AssetReferenceV1,
} from "../../../packages/asset-ref/src/index.ts";

/** Release-packaged limits and owner selection only.  Asset-denominator,
 * action-owner and valuation facts remain current-generation/runtime facts. */
export interface DeploymentEconomicSafetyTemplateV1 {
  readonly profitAsset: AssetReferenceV1;
  readonly profitAccount: string;
  readonly priorityFeePerGas: string;
  readonly bidCostNative: string;
  readonly valuationOwnerRef: Hash;
}

export interface DeploymentRuntimePolicyV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.deployment-runtime-policy-v1";
  readonly bindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly candidateReleaseCommit: string;
  readonly pending: "disabled" | "public-pending-v1";
  readonly objective: Readonly<{
    readonly numeraireAssetRef: Hash;
    readonly minNetGain: string;
    readonly maxGas: string;
    readonly maxValueAtRisk: string;
  }>;
  readonly economicSafety: DeploymentEconomicSafetyTemplateV1;
  readonly callerId: string;
  readonly deadlineMs: number;
  readonly admission: Readonly<{ readonly topK: number; readonly boundedUnrankedBudget: number }>;
  readonly amountSeed: Readonly<{ readonly amountIn: string; readonly recipient: string }>;
}

export interface DeploymentExecutorStateDescriptorV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.deployment-executor-state-v1";
  readonly bindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly executorAuthorityRoot: Hash;
  readonly selectedExecutorLeafHash: Hash;
  readonly executorAddress: string;
  readonly callerAddress: string;
  readonly qualifiedExecutorCodeHash: Hash;
  readonly executorConfig: CanonicalJson;
  readonly accounts: readonly Readonly<{ readonly address: string; readonly storageSlots: readonly string[] }>[];
}

function address(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/.test(value)) {
    throw new TypeError(`${path} must be a lowercase address`);
  }
  return value;
}

function slot(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${path} must be a lowercase 32-byte slot`);
  }
  return value;
}

function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${path} must be an integer in [${minimum}, ${maximum}]`);
  }
  return value;
}

function canonicalObject(value: unknown, path: string): CanonicalJson {
  const bytes = encodeCanonicalBytes(value);
  const decoded = decodeCanonicalJson(bytes) as CanonicalJson;
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TypeError(`${path} must be a canonical object`);
  }
  return decoded;
}

export function decodeDeploymentRuntimePolicyV1(value: unknown): DeploymentRuntimePolicyV1 {
  assertPlainObject(value, "deploymentRuntimePolicy");
  assertExactKeys(value, [
    "schemaVersion", "kind", "bindingId", "releaseProvenanceHash", "frameworkAuthorityRoot",
    "candidateReleaseCommit", "pending", "objective", "economicSafety", "callerId", "deadlineMs", "admission", "amountSeed",
  ], "deploymentRuntimePolicy");
  if (value.schemaVersion !== 1 || value.kind !== "aloha.deployment-runtime-policy-v1") {
    throw new TypeError("deploymentRuntimePolicy kind/version mismatch");
  }
  if (value.pending !== "disabled" && value.pending !== "public-pending-v1") {
    throw new TypeError("deploymentRuntimePolicy pending profile is invalid");
  }
  assertPlainObject(value.objective, "deploymentRuntimePolicy.objective");
  assertExactKeys(value.objective, ["numeraireAssetRef", "minNetGain", "maxGas", "maxValueAtRisk"], "deploymentRuntimePolicy.objective");
  assertPlainObject(value.economicSafety, "deploymentRuntimePolicy.economicSafety");
  assertExactKeys(value.economicSafety, [
    "profitAsset", "profitAccount", "priorityFeePerGas", "bidCostNative", "valuationOwnerRef",
  ], "deploymentRuntimePolicy.economicSafety");
  assertPlainObject(value.admission, "deploymentRuntimePolicy.admission");
  assertExactKeys(value.admission, ["topK", "boundedUnrankedBudget"], "deploymentRuntimePolicy.admission");
  assertPlainObject(value.amountSeed, "deploymentRuntimePolicy.amountSeed");
  assertExactKeys(value.amountSeed, ["amountIn", "recipient"], "deploymentRuntimePolicy.amountSeed");
  const objective = Object.freeze({
    numeraireAssetRef: assertHash(value.objective.numeraireAssetRef, "deploymentRuntimePolicy.objective.numeraireAssetRef"),
    minNetGain: assertDecimalString(value.objective.minNetGain, "deploymentRuntimePolicy.objective.minNetGain"),
    maxGas: assertDecimalString(value.objective.maxGas, "deploymentRuntimePolicy.objective.maxGas"),
    maxValueAtRisk: assertDecimalString(value.objective.maxValueAtRisk, "deploymentRuntimePolicy.objective.maxValueAtRisk"),
  });
  const economicSafety = Object.freeze({
    profitAsset: decodeAssetReferenceV1(value.economicSafety.profitAsset, "deploymentRuntimePolicy.economicSafety.profitAsset"),
    profitAccount: address(value.economicSafety.profitAccount, "deploymentRuntimePolicy.economicSafety.profitAccount"),
    priorityFeePerGas: assertDecimalString(value.economicSafety.priorityFeePerGas, "deploymentRuntimePolicy.economicSafety.priorityFeePerGas"),
    bidCostNative: assertDecimalString(value.economicSafety.bidCostNative, "deploymentRuntimePolicy.economicSafety.bidCostNative"),
    valuationOwnerRef: assertHash(value.economicSafety.valuationOwnerRef, "deploymentRuntimePolicy.economicSafety.valuationOwnerRef"),
  });
  if (/^0x0{64}$/.test(economicSafety.valuationOwnerRef)) {
    throw new TypeError("deploymentRuntimePolicy economic valuation owner ref must be non-zero");
  }
  if (economicSafety.profitAsset.assetRef !== objective.numeraireAssetRef) {
    throw new TypeError("deploymentRuntimePolicy economic profit asset does not match the objective numeraire");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.deployment-runtime-policy-v1" as const,
    bindingId: assertHash(value.bindingId, "deploymentRuntimePolicy.bindingId"),
    releaseProvenanceHash: assertHash(value.releaseProvenanceHash, "deploymentRuntimePolicy.releaseProvenanceHash"),
    frameworkAuthorityRoot: assertHash(value.frameworkAuthorityRoot, "deploymentRuntimePolicy.frameworkAuthorityRoot"),
    candidateReleaseCommit: gitSha40Schema.decode(value.candidateReleaseCommit, "deploymentRuntimePolicy.candidateReleaseCommit"),
    pending: value.pending,
    objective,
    economicSafety,
    callerId: assertNonEmptyString(value.callerId, "deploymentRuntimePolicy.callerId"),
    deadlineMs: boundedInteger(value.deadlineMs, "deploymentRuntimePolicy.deadlineMs", 1, 60_000),
    admission: Object.freeze({
      topK: boundedInteger(value.admission.topK, "deploymentRuntimePolicy.admission.topK", 1, 10_000),
      boundedUnrankedBudget: boundedInteger(value.admission.boundedUnrankedBudget, "deploymentRuntimePolicy.admission.boundedUnrankedBudget", 0, 10_000),
    }),
    amountSeed: Object.freeze({
      amountIn: assertDecimalString(value.amountSeed.amountIn, "deploymentRuntimePolicy.amountSeed.amountIn"),
      recipient: address(value.amountSeed.recipient, "deploymentRuntimePolicy.amountSeed.recipient"),
    }),
  });
}

export function decodeDeploymentExecutorStateDescriptorV1(value: unknown): DeploymentExecutorStateDescriptorV1 {
  assertPlainObject(value, "deploymentExecutorState");
  assertExactKeys(value, [
    "schemaVersion", "kind", "bindingId", "releaseProvenanceHash", "executorAuthorityRoot",
    "selectedExecutorLeafHash", "executorAddress", "callerAddress", "qualifiedExecutorCodeHash",
    "executorConfig", "accounts",
  ], "deploymentExecutorState");
  if (value.schemaVersion !== 1 || value.kind !== "aloha.deployment-executor-state-v1") {
    throw new TypeError("deploymentExecutorState kind/version mismatch");
  }
  if (!Array.isArray(value.accounts)) throw new TypeError("deploymentExecutorState.accounts must be an array");
  const accounts = value.accounts.map((entry, index) => {
    assertPlainObject(entry, `deploymentExecutorState.accounts[${index}]`);
    assertExactKeys(entry, ["address", "storageSlots"], `deploymentExecutorState.accounts[${index}]`);
    if (!Array.isArray(entry.storageSlots)) throw new TypeError(`deploymentExecutorState.accounts[${index}].storageSlots must be an array`);
    const storageSlots = entry.storageSlots.map((item, slotIndex) => slot(item, `deploymentExecutorState.accounts[${index}].storageSlots[${slotIndex}]`));
    if (new Set(storageSlots).size !== storageSlots.length || [...storageSlots].sort().some((item, itemIndex) => item !== storageSlots[itemIndex])) {
      throw new TypeError("deploymentExecutorState storage slots must be sorted and unique");
    }
    return Object.freeze({ address: address(entry.address, `deploymentExecutorState.accounts[${index}].address`), storageSlots: Object.freeze(storageSlots) });
  });
  if (new Set(accounts.map(entry => entry.address)).size !== accounts.length
    || [...accounts].sort((left, right) => left.address.localeCompare(right.address)).some((entry, index) => entry.address !== accounts[index]!.address)) {
    throw new TypeError("deploymentExecutorState accounts must be sorted and unique");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.deployment-executor-state-v1" as const,
    bindingId: assertHash(value.bindingId, "deploymentExecutorState.bindingId"),
    releaseProvenanceHash: assertHash(value.releaseProvenanceHash, "deploymentExecutorState.releaseProvenanceHash"),
    executorAuthorityRoot: assertHash(value.executorAuthorityRoot, "deploymentExecutorState.executorAuthorityRoot"),
    selectedExecutorLeafHash: assertHash(value.selectedExecutorLeafHash, "deploymentExecutorState.selectedExecutorLeafHash"),
    executorAddress: address(value.executorAddress, "deploymentExecutorState.executorAddress"),
    callerAddress: address(value.callerAddress, "deploymentExecutorState.callerAddress"),
    qualifiedExecutorCodeHash: assertHash(value.qualifiedExecutorCodeHash, "deploymentExecutorState.qualifiedExecutorCodeHash"),
    executorConfig: canonicalObject(value.executorConfig, "deploymentExecutorState.executorConfig"),
    accounts: Object.freeze(accounts),
  });
}

function exactBytes<T>(bytes: Uint8Array, decode: (value: unknown) => T, label: string): T {
  if (!(bytes instanceof Uint8Array)) throw new TypeError(`${label} bytes are required`);
  const decoded = decode(decodeCanonicalJson(bytes));
  if (!Buffer.from(bytes).equals(Buffer.from(encodeCanonicalBytes(decoded)))) {
    throw new TypeError(`${label} is not canonical exact bytes`);
  }
  return decoded;
}

export const decodeDeploymentRuntimePolicyBytesV1 = (bytes: Uint8Array): DeploymentRuntimePolicyV1 =>
  exactBytes(bytes, decodeDeploymentRuntimePolicyV1, "deployment runtime policy");

export const decodeDeploymentExecutorStateDescriptorBytesV1 = (bytes: Uint8Array): DeploymentExecutorStateDescriptorV1 =>
  exactBytes(bytes, decodeDeploymentExecutorStateDescriptorV1, "deployment executor state");

export function assertDeploymentRuntimeArtifactsJoinReleaseV1(
  policyValue: DeploymentRuntimePolicyV1,
  executorValue: DeploymentExecutorStateDescriptorV1,
  bindingValue: RuntimeReleaseBindingV1,
): void {
  const policy = decodeDeploymentRuntimePolicyV1(policyValue);
  const executor = decodeDeploymentExecutorStateDescriptorV1(executorValue);
  const binding = decodeRuntimeReleaseBindingV1(bindingValue);
  const provenance = runtimeReleaseBindingProvenanceHash(binding);
  if (policy.bindingId !== binding.bindingId
    || policy.releaseProvenanceHash !== provenance
    || policy.frameworkAuthorityRoot !== binding.frameworkAuthorityRoot
    || policy.candidateReleaseCommit !== binding.candidateReleaseCommit
    || executor.bindingId !== binding.bindingId
    || executor.releaseProvenanceHash !== provenance
    || executor.executorAuthorityRoot !== binding.executorAuthorityRoot
    || executor.selectedExecutorLeafHash !== binding.selectedExecutorLeafHash
    || policy.callerId !== executor.callerAddress
    || policy.economicSafety.profitAccount !== executor.executorAddress) {
    throw new TypeError("deployment runtime artifacts do not join the signed release");
  }
}
