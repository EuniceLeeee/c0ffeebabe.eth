import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertPlainObject,
  decodeCanonicalJson,
  encodeCanonicalBytes,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeAssetReferenceV1,
  type AssetReferenceV1,
} from "../../../packages/asset-ref/src/index.ts";
import type { GenerationRefreshPolicyV1 } from "../../../packages/ready-generation/src/index.ts";

export interface RuntimeEconomicSafetyPolicyV1 {
  readonly profitAsset: AssetReferenceV1;
  readonly profitAccount: string;
  readonly priorityFeePerGas: string;
  readonly bidCostNative: string;
  readonly valuationOwnerRef: Hash;
}

export interface RuntimePolicyV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.runtime-policy-v1";
  readonly pending: "disabled" | "public-pending-v1";
  readonly generation: GenerationRefreshPolicyV1;
  readonly objective: Readonly<{
    readonly numeraireAssetRef: Hash;
    readonly minNetGain: string;
    readonly maxGas: string;
    readonly maxValueAtRisk: string;
  }>;
  readonly economicSafety: RuntimeEconomicSafetyPolicyV1;
  readonly callerId: string;
  readonly deadlineMs: number;
  readonly admission: Readonly<{
    readonly topK: number;
    readonly boundedUnrankedBudget: number;
  }>;
  readonly amountSeed: Readonly<{
    readonly amountIn: string;
    readonly recipient: string;
  }>;
  readonly executor: Readonly<{
    readonly address: string;
    readonly callerAddress: string;
    readonly codeHash: Hash;
    readonly config: CanonicalJson;
    readonly accounts: readonly Readonly<{
      readonly address: string;
      readonly storageSlots: readonly string[];
    }>[];
  }>;
  readonly revm: Readonly<{
    readonly maxWorkers: number;
    readonly queueCap: number;
    readonly timeoutMs: number;
    readonly perOwnerConcurrency: number;
  }>;
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
  if (typeof value !== "number" || !Number.isSafeInteger(value)
    || value < minimum || value > maximum) {
    throw new TypeError(`${path} must be an integer in [${minimum}, ${maximum}]`);
  }
  return value;
}

function canonicalObject(value: unknown, path: string): CanonicalJson {
  const decoded = decodeCanonicalJson(encodeCanonicalBytes(value)) as CanonicalJson;
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TypeError(`${path} must be a canonical object`);
  }
  return decoded;
}

function generationPolicy(value: unknown): GenerationRefreshPolicyV1 {
  assertPlainObject(value, "runtimePolicy.generation");
  assertExactKeys(value, [
    "observationWindowBlocks",
    "targetRefreshAgeBlocks",
    "maxServingAgeBlocks",
    "minPromotionMarginBlocks",
    "maxInProgressRuns",
  ], "runtimePolicy.generation");
  const observationWindowBlocks = assertDecimalString(value.observationWindowBlocks, "runtimePolicy.generation.observationWindowBlocks");
  const maxInProgressRuns = assertDecimalString(value.maxInProgressRuns, "runtimePolicy.generation.maxInProgressRuns");
  if (observationWindowBlocks !== "50" || maxInProgressRuns !== "1") {
    throw new TypeError("runtimePolicy generation denominator must use 50 blocks and one in-progress run");
  }
  return Object.freeze({
    observationWindowBlocks,
    targetRefreshAgeBlocks: assertDecimalString(value.targetRefreshAgeBlocks, "runtimePolicy.generation.targetRefreshAgeBlocks"),
    maxServingAgeBlocks: assertDecimalString(value.maxServingAgeBlocks, "runtimePolicy.generation.maxServingAgeBlocks"),
    minPromotionMarginBlocks: assertDecimalString(value.minPromotionMarginBlocks, "runtimePolicy.generation.minPromotionMarginBlocks"),
    maxInProgressRuns,
  });
}

function executorAccounts(value: unknown): RuntimePolicyV1["executor"]["accounts"] {
  if (!Array.isArray(value)) throw new TypeError("runtimePolicy.executor.accounts must be an array");
  const accounts = value.map((entry, index) => {
    assertPlainObject(entry, `runtimePolicy.executor.accounts[${index}]`);
    assertExactKeys(entry, ["address", "storageSlots"], `runtimePolicy.executor.accounts[${index}]`);
    if (!Array.isArray(entry.storageSlots)) {
      throw new TypeError(`runtimePolicy.executor.accounts[${index}].storageSlots must be an array`);
    }
    const storageSlots = entry.storageSlots.map((item, slotIndex) =>
      slot(item, `runtimePolicy.executor.accounts[${index}].storageSlots[${slotIndex}]`));
    if (new Set(storageSlots).size !== storageSlots.length
      || [...storageSlots].sort().some((item, itemIndex) => item !== storageSlots[itemIndex])) {
      throw new TypeError("runtimePolicy executor storage slots must be sorted and unique");
    }
    return Object.freeze({
      address: address(entry.address, `runtimePolicy.executor.accounts[${index}].address`),
      storageSlots: Object.freeze(storageSlots),
    });
  });
  if (new Set(accounts.map(entry => entry.address)).size !== accounts.length
    || [...accounts].sort((left, right) => left.address.localeCompare(right.address))
      .some((entry, index) => entry.address !== accounts[index]!.address)) {
    throw new TypeError("runtimePolicy executor accounts must be sorted and unique");
  }
  return Object.freeze(accounts);
}

export function decodeRuntimePolicyV1(value: unknown): RuntimePolicyV1 {
  assertPlainObject(value, "runtimePolicy");
  assertExactKeys(value, [
    "schemaVersion",
    "kind",
    "pending",
    "generation",
    "objective",
    "economicSafety",
    "callerId",
    "deadlineMs",
    "admission",
    "amountSeed",
    "executor",
    "revm",
  ], "runtimePolicy");
  if (value.schemaVersion !== 1 || value.kind !== "aloha.runtime-policy-v1") {
    throw new TypeError("runtimePolicy kind/version mismatch");
  }
  if (value.pending !== "disabled" && value.pending !== "public-pending-v1") {
    throw new TypeError("runtimePolicy pending profile is invalid");
  }
  assertPlainObject(value.objective, "runtimePolicy.objective");
  assertExactKeys(value.objective, [
    "numeraireAssetRef", "minNetGain", "maxGas", "maxValueAtRisk",
  ], "runtimePolicy.objective");
  assertPlainObject(value.economicSafety, "runtimePolicy.economicSafety");
  assertExactKeys(value.economicSafety, [
    "profitAsset", "profitAccount", "priorityFeePerGas", "bidCostNative", "valuationOwnerRef",
  ], "runtimePolicy.economicSafety");
  assertPlainObject(value.admission, "runtimePolicy.admission");
  assertExactKeys(value.admission, ["topK", "boundedUnrankedBudget"], "runtimePolicy.admission");
  assertPlainObject(value.amountSeed, "runtimePolicy.amountSeed");
  assertExactKeys(value.amountSeed, ["amountIn", "recipient"], "runtimePolicy.amountSeed");
  assertPlainObject(value.executor, "runtimePolicy.executor");
  assertExactKeys(value.executor, [
    "address", "callerAddress", "codeHash", "config", "accounts",
  ], "runtimePolicy.executor");
  assertPlainObject(value.revm, "runtimePolicy.revm");
  assertExactKeys(value.revm, [
    "maxWorkers", "queueCap", "timeoutMs", "perOwnerConcurrency",
  ], "runtimePolicy.revm");

  const objective = Object.freeze({
    numeraireAssetRef: assertHash(value.objective.numeraireAssetRef, "runtimePolicy.objective.numeraireAssetRef"),
    minNetGain: assertDecimalString(value.objective.minNetGain, "runtimePolicy.objective.minNetGain"),
    maxGas: assertDecimalString(value.objective.maxGas, "runtimePolicy.objective.maxGas"),
    maxValueAtRisk: assertDecimalString(value.objective.maxValueAtRisk, "runtimePolicy.objective.maxValueAtRisk"),
  });
  const economicSafety = Object.freeze({
    profitAsset: decodeAssetReferenceV1(value.economicSafety.profitAsset, "runtimePolicy.economicSafety.profitAsset"),
    profitAccount: address(value.economicSafety.profitAccount, "runtimePolicy.economicSafety.profitAccount"),
    priorityFeePerGas: assertDecimalString(value.economicSafety.priorityFeePerGas, "runtimePolicy.economicSafety.priorityFeePerGas"),
    bidCostNative: assertDecimalString(value.economicSafety.bidCostNative, "runtimePolicy.economicSafety.bidCostNative"),
    valuationOwnerRef: assertHash(value.economicSafety.valuationOwnerRef, "runtimePolicy.economicSafety.valuationOwnerRef"),
  });
  if (economicSafety.profitAsset.assetRef !== objective.numeraireAssetRef) {
    throw new TypeError("runtimePolicy profit asset does not match the objective numeraire");
  }
  const callerId = address(value.callerId, "runtimePolicy.callerId");
  const amountSeed = Object.freeze({
    amountIn: assertDecimalString(value.amountSeed.amountIn, "runtimePolicy.amountSeed.amountIn"),
    recipient: address(value.amountSeed.recipient, "runtimePolicy.amountSeed.recipient"),
  });
  const executor = Object.freeze({
    address: address(value.executor.address, "runtimePolicy.executor.address"),
    callerAddress: address(value.executor.callerAddress, "runtimePolicy.executor.callerAddress"),
    codeHash: assertHash(value.executor.codeHash, "runtimePolicy.executor.codeHash"),
    config: canonicalObject(value.executor.config, "runtimePolicy.executor.config"),
    accounts: executorAccounts(value.executor.accounts),
  });
  if (callerId !== executor.callerAddress
    || amountSeed.recipient !== executor.address
    || economicSafety.profitAccount !== executor.address) {
    throw new TypeError("runtimePolicy caller, recipient, profit account and executor do not join");
  }

  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.runtime-policy-v1" as const,
    pending: value.pending,
    generation: generationPolicy(value.generation),
    objective,
    economicSafety,
    callerId,
    deadlineMs: boundedInteger(value.deadlineMs, "runtimePolicy.deadlineMs", 1, 60_000),
    admission: Object.freeze({
      topK: boundedInteger(value.admission.topK, "runtimePolicy.admission.topK", 1, 10_000),
      boundedUnrankedBudget: boundedInteger(value.admission.boundedUnrankedBudget, "runtimePolicy.admission.boundedUnrankedBudget", 0, 10_000),
    }),
    amountSeed,
    executor,
    revm: Object.freeze({
      maxWorkers: boundedInteger(value.revm.maxWorkers, "runtimePolicy.revm.maxWorkers", 1, 256),
      queueCap: boundedInteger(value.revm.queueCap, "runtimePolicy.revm.queueCap", 1, 100_000),
      timeoutMs: boundedInteger(value.revm.timeoutMs, "runtimePolicy.revm.timeoutMs", 1, 60_000),
      perOwnerConcurrency: boundedInteger(value.revm.perOwnerConcurrency, "runtimePolicy.revm.perOwnerConcurrency", 1, 256),
    }),
  });
}

export function decodeRuntimePolicyBytesV1(bytes: Uint8Array): RuntimePolicyV1 {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("runtime policy bytes are required");
  const decoded = decodeRuntimePolicyV1(decodeCanonicalJson(bytes));
  if (!Buffer.from(bytes).equals(Buffer.from(encodeCanonicalBytes(decoded)))) {
    throw new TypeError("runtime policy is not canonical exact bytes");
  }
  return decoded;
}
