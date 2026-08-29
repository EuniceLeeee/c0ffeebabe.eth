import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  decodeExactObject,
  hashDomain,
  type Hash,
} from "../../canonical-codec/src/index.ts";

export const CREDIT_CONTRACT_VERSION_V1 = 1 as const;
export const CREDIT_CONTRACT_SCHEMA_HASH_V1 = hashDomain(
  "aloha/credit-contract/schema/v1",
  ["standing-position", "repayment", "final-safety", "effects", "effect-root"],
);

export interface CreditEffectObservationV1 {
  readonly asset: string;
  readonly account: "executor" | "vault";
  readonly delta: string;
}

export interface CreditStandingPositionObligationV1 {
  readonly kind: "credit-standing-position";
  readonly version: typeof CREDIT_CONTRACT_VERSION_V1;
  readonly familyId: string;
  readonly instanceKey: string;
  readonly positionKey: Hash;
  readonly collateralAsset: string;
  readonly collateralAmount: string;
  readonly debtAsset: string;
  readonly debtAmount: string;
  readonly actionIntentHash: Hash;
  readonly finalSafety: "repayment-and-position-safe";
  readonly effects: readonly CreditEffectObservationV1[];
  readonly effectRoot: Hash;
  readonly obligationHash: Hash;
}

export interface CreditRepaymentObligationV1 {
  readonly kind: "credit-repayment";
  readonly version: typeof CREDIT_CONTRACT_VERSION_V1;
  readonly debtAsset: string;
  readonly amount: string;
  readonly due: "final-simulation";
  readonly obligationHash: Hash;
}

export interface CreditObligationSetV1 {
  readonly kind: "credit-obligation-set";
  readonly version: typeof CREDIT_CONTRACT_VERSION_V1;
  readonly standingPosition: CreditStandingPositionObligationV1;
  readonly repayment: CreditRepaymentObligationV1;
  readonly obligationRoot: Hash;
}

export interface CreditAuthoringDefinitionV1 {
  readonly familyId: string;
  readonly version: string;
  readonly actionOwnerId: string;
  readonly schemaHash: Hash;
}

export function defineCreditFamilyContract(
  input: Omit<CreditAuthoringDefinitionV1, "schemaHash"> & { readonly schemaHash?: Hash },
): CreditAuthoringDefinitionV1 {
  const familyId = assertNonEmptyString(input.familyId, "credit.familyId");
  const version = assertNonEmptyString(input.version, "credit.version");
  const actionOwnerId = assertNonEmptyString(input.actionOwnerId, "credit.actionOwnerId");
  const schemaHash = input.schemaHash === undefined
    ? CREDIT_CONTRACT_SCHEMA_HASH_V1
    : assertHash(input.schemaHash, "credit.schemaHash");
  return Object.freeze({ familyId, version, actionOwnerId, schemaHash });
}

function positiveDecimal(value: string, path: string): string {
  const decoded = assertDecimalString(value, path);
  if (BigInt(decoded) <= 0n) throw new TypeError(`${path} must be positive`);
  return decoded;
}

function signedDecimal(value: string, path: string): string {
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(value)) throw new TypeError(`${path} must be a signed decimal integer`);
  return value;
}

function address(value: string, path: string): string {
  const decoded = assertNonEmptyString(value, path);
  if (!/^0x[0-9a-fA-F]{40}$/.test(decoded)) throw new TypeError(`${path} must be an address`);
  return `0x${decoded.slice(2).toLowerCase()}`;
}

function effectRoot(effects: readonly CreditEffectObservationV1[]): Hash {
  return hashDomain("aloha/credit-contract/effect-root/v1", effects.map((effect, index) => ({
    index,
    asset: address(effect.asset, `effects[${index}].asset`),
    account: effect.account,
    delta: effect.delta,
  })));
}

export function makeCreditObligationSet(input: {
  readonly familyId: string;
  readonly instanceKey: string;
  readonly positionKey: Hash;
  readonly collateralAsset: string;
  readonly collateralAmount: string;
  readonly debtAsset: string;
  readonly debtAmount: string;
  readonly actionIntentHash: Hash;
  readonly effects: readonly CreditEffectObservationV1[];
}): CreditObligationSetV1 {
  const familyId = assertNonEmptyString(input.familyId, "credit.familyId");
  const instanceKey = assertNonEmptyString(input.instanceKey, "credit.instanceKey");
  const positionKey = assertHash(input.positionKey, "credit.positionKey");
  const collateralAsset = address(input.collateralAsset, "credit.collateralAsset");
  const debtAsset = address(input.debtAsset, "credit.debtAsset");
  if (collateralAsset === debtAsset) throw new TypeError("credit collateral and debt assets must differ");
  const collateralAmount = positiveDecimal(input.collateralAmount, "credit.collateralAmount");
  const debtAmount = positiveDecimal(input.debtAmount, "credit.debtAmount");
  const actionIntentHash = assertHash(input.actionIntentHash, "credit.actionIntentHash");
  if (input.effects.length !== 2) throw new TypeError("credit effect proof must contain collateral and debt deltas");
  const effects = Object.freeze(input.effects.map((effect, index) => Object.freeze({
    asset: address(effect.asset, `credit.effects[${index}].asset`),
    account: effect.account,
    delta: signedDecimal(effect.delta, `credit.effects[${index}].delta`),
  })));
  const expectedEffectRoot = effectRoot(effects);
  const standingPayload = {
    kind: "credit-standing-position" as const,
    version: CREDIT_CONTRACT_VERSION_V1,
    familyId,
    instanceKey,
    positionKey,
    collateralAsset,
    collateralAmount,
    debtAsset,
    debtAmount,
    actionIntentHash,
    finalSafety: "repayment-and-position-safe" as const,
    effects,
    effectRoot: expectedEffectRoot,
  };
  const standingPosition = Object.freeze({
    ...standingPayload,
    obligationHash: hashDomain("aloha/credit-contract/standing-position/v1", standingPayload),
  });
  const repaymentPayload = {
    kind: "credit-repayment" as const,
    version: CREDIT_CONTRACT_VERSION_V1,
    debtAsset,
    amount: debtAmount,
    due: "final-simulation" as const,
  };
  const repayment = Object.freeze({
    ...repaymentPayload,
    obligationHash: hashDomain("aloha/credit-contract/repayment/v1", repaymentPayload),
  });
  return Object.freeze({
    kind: "credit-obligation-set",
    version: CREDIT_CONTRACT_VERSION_V1,
    standingPosition,
    repayment,
    obligationRoot: hashDomain("aloha/credit-contract/obligation-root/v1", { standingPosition, repayment }),
  });
}

export function assertCreditObligationSet(value: unknown, path = "creditObligationSet"): CreditObligationSetV1 {
  const decoded = decodeExactObject(value, {
    kind: (field, fieldPath) => field === "credit-obligation-set" ? field : (() => { throw new TypeError(`${fieldPath} kind mismatch`); })(),
    version: (field, fieldPath) => field === CREDIT_CONTRACT_VERSION_V1 ? field : (() => { throw new TypeError(`${fieldPath} version mismatch`); })(),
    standingPosition: (field, fieldPath) => assertStandingPosition(field, fieldPath),
    repayment: (field, fieldPath) => assertRepayment(field, fieldPath),
    obligationRoot: (field, fieldPath) => assertHash(field, fieldPath),
  }, path) as CreditObligationSetV1;
  const expectedRoot = hashDomain("aloha/credit-contract/obligation-root/v1", { standingPosition: decoded.standingPosition, repayment: decoded.repayment });
  if (decoded.obligationRoot !== expectedRoot) throw new TypeError(`${path} obligation root mismatch`);
  return Object.freeze(decoded);
}

function assertStandingPosition(value: unknown, path: string): CreditStandingPositionObligationV1 {
  const decoded = decodeExactObject(value, {
    kind: (field, fieldPath) => field === "credit-standing-position" ? field : (() => { throw new TypeError(`${fieldPath} kind mismatch`); })(),
    version: (field, fieldPath) => field === CREDIT_CONTRACT_VERSION_V1 ? field : (() => { throw new TypeError(`${fieldPath} version mismatch`); })(),
    familyId: (field, fieldPath) => assertNonEmptyString(field, fieldPath),
    instanceKey: (field, fieldPath) => assertNonEmptyString(field, fieldPath),
    positionKey: (field, fieldPath) => assertHash(field, fieldPath),
    collateralAsset: (field, fieldPath) => address(field as string, fieldPath),
    collateralAmount: (field, fieldPath) => positiveDecimal(field as string, fieldPath),
    debtAsset: (field, fieldPath) => address(field as string, fieldPath),
    debtAmount: (field, fieldPath) => positiveDecimal(field as string, fieldPath),
    actionIntentHash: (field, fieldPath) => assertHash(field, fieldPath),
    finalSafety: (field, fieldPath) => field === "repayment-and-position-safe" ? field : (() => { throw new TypeError(`${fieldPath} final safety mismatch`); })(),
    effects: (field, fieldPath) => {
      if (!Array.isArray(field)) throw new TypeError(`${fieldPath} must be an array`);
      return Object.freeze(field.map((item, index) => decodeExactObject(item, {
        asset: (effect, effectPath) => address(effect as string, effectPath),
        account: (effect, effectPath) => effect === "executor" || effect === "vault" ? effect : (() => { throw new TypeError(`${effectPath} account mismatch`); })(),
        delta: (effect, effectPath) => signedDecimal(effect as string, effectPath),
      }, `${fieldPath}[${index}]`)));
    },
    effectRoot: (field, fieldPath) => assertHash(field, fieldPath),
    obligationHash: (field, fieldPath) => assertHash(field, fieldPath),
  }, path) as CreditStandingPositionObligationV1;
  if (decoded.collateralAsset === decoded.debtAsset) throw new TypeError(`${path} assets must differ`);
  if (decoded.effects.length !== 2
    || decoded.effects[0]?.asset !== decoded.collateralAsset
    || decoded.effects[0]?.account !== "executor"
    || decoded.effects[0]?.delta !== `-${decoded.collateralAmount}`
    || decoded.effects[1]?.asset !== decoded.debtAsset
    || decoded.effects[1]?.account !== "executor"
    || decoded.effects[1]?.delta !== decoded.debtAmount
    || decoded.effectRoot !== effectRoot(decoded.effects)) throw new TypeError(`${path} effect binding mismatch`);
  const payload = {
    kind: decoded.kind,
    version: decoded.version,
    familyId: decoded.familyId,
    instanceKey: decoded.instanceKey,
    positionKey: decoded.positionKey,
    collateralAsset: decoded.collateralAsset,
    collateralAmount: decoded.collateralAmount,
    debtAsset: decoded.debtAsset,
    debtAmount: decoded.debtAmount,
    actionIntentHash: decoded.actionIntentHash,
    finalSafety: decoded.finalSafety,
    effects: decoded.effects,
    effectRoot: decoded.effectRoot,
  };
  if (decoded.obligationHash !== hashDomain("aloha/credit-contract/standing-position/v1", payload)) throw new TypeError(`${path} standing-position hash mismatch`);
  return Object.freeze(decoded);
}

function assertRepayment(value: unknown, path: string): CreditRepaymentObligationV1 {
  const decoded = decodeExactObject(value, {
    kind: (field, fieldPath) => field === "credit-repayment" ? field : (() => { throw new TypeError(`${fieldPath} kind mismatch`); })(),
    version: (field, fieldPath) => field === CREDIT_CONTRACT_VERSION_V1 ? field : (() => { throw new TypeError(`${fieldPath} version mismatch`); })(),
    debtAsset: (field, fieldPath) => address(field as string, fieldPath),
    amount: (field, fieldPath) => positiveDecimal(field as string, fieldPath),
    due: (field, fieldPath) => field === "final-simulation" ? field : (() => { throw new TypeError(`${fieldPath} due mismatch`); })(),
    obligationHash: (field, fieldPath) => assertHash(field, fieldPath),
  }, path) as CreditRepaymentObligationV1;
  const payload = { kind: decoded.kind, version: decoded.version, debtAsset: decoded.debtAsset, amount: decoded.amount, due: decoded.due };
  if (decoded.obligationHash !== hashDomain("aloha/credit-contract/repayment/v1", payload)) throw new TypeError(`${path} repayment hash mismatch`);
  return Object.freeze(decoded);
}
