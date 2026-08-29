import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  decodeExactObject,
  hashDomain,
  type Hash,
} from "../../canonical-codec/src/index.ts";

export const FUNDING_CONTRACT_VERSION_V1 = 1 as const;
export const FUNDING_CONTRACT_SCHEMA_HASH_V1 = hashDomain(
  "aloha/funding-contract/schema/v1",
  ["funding-repayment", "same-transaction", "receiver", "effects", "effect-root", "action-intent-hash"],
);

export interface FundingEffectExpectationV1 {
  readonly asset: string;
  readonly account: "lender" | "executor";
  readonly direction: "decrease" | "increase";
  readonly amount: string;
}

export interface FundingRepaymentObligationV1 {
  readonly kind: "funding-repayment";
  readonly version: typeof FUNDING_CONTRACT_VERSION_V1;
  readonly familyId: string;
  readonly instanceKey: string;
  readonly lender: string;
  readonly receiver: string;
  readonly asset: string;
  readonly principal: string;
  readonly fee: string;
  readonly repayment: string;
  readonly due: "same-transaction";
  readonly actionIntentHash: Hash;
  readonly effects: readonly FundingEffectExpectationV1[];
  readonly effectRoot: Hash;
  readonly obligationHash: Hash;
}

export interface FundingAuthoringDefinitionV1 {
  readonly familyId: string;
  readonly version: string;
  readonly actionOwnerId: string;
  readonly schemaHash: Hash;
}

export function defineFundingFamilyContract(
  input: Omit<FundingAuthoringDefinitionV1, "schemaHash"> & { readonly schemaHash?: Hash },
): FundingAuthoringDefinitionV1 {
  const familyId = assertNonEmptyString(input.familyId, "funding.familyId");
  const version = assertNonEmptyString(input.version, "funding.version");
  const actionOwnerId = assertNonEmptyString(input.actionOwnerId, "funding.actionOwnerId");
  const schemaHash = input.schemaHash === undefined
    ? FUNDING_CONTRACT_SCHEMA_HASH_V1
    : assertHash(input.schemaHash, "funding.schemaHash");
  return Object.freeze({ familyId, version, actionOwnerId, schemaHash });
}

function positiveDecimal(value: string, path: string, allowZero = false): string {
  const decoded = assertDecimalString(value, path);
  if (!allowZero && BigInt(decoded) <= 0n) throw new TypeError(`${path} must be positive`);
  return decoded;
}

function asset(value: string, path: string): string {
  const decoded = assertNonEmptyString(value, path);
  if (!/^0x[0-9a-fA-F]{40}$/.test(decoded)) throw new TypeError(`${path} must be an address`);
  return `0x${decoded.slice(2).toLowerCase()}`;
}

function effectRoot(effects: readonly FundingEffectExpectationV1[]): Hash {
  return hashDomain("aloha/funding-contract/effect-root/v1", effects.map((effect, index) => ({
    index,
    asset: asset(effect.asset, `effects[${index}].asset`),
    account: effect.account,
    direction: effect.direction,
    amount: positiveDecimal(effect.amount, `effects[${index}].amount`),
  })));
}

export function makeFundingRepaymentObligation(input: {
  readonly familyId: string;
  readonly instanceKey: string;
  readonly lender: string;
  readonly receiver: string;
  readonly asset: string;
  readonly principal: string;
  readonly fee: string;
  readonly actionIntentHash: Hash;
  readonly effects: readonly FundingEffectExpectationV1[];
}): FundingRepaymentObligationV1 {
  const familyId = assertNonEmptyString(input.familyId, "funding.familyId");
  const instanceKey = assertNonEmptyString(input.instanceKey, "funding.instanceKey");
  const lender = asset(input.lender, "funding.lender");
  const receiver = asset(input.receiver, "funding.receiver");
  const token = asset(input.asset, "funding.asset");
  const principal = positiveDecimal(input.principal, "funding.principal");
  const fee = positiveDecimal(input.fee, "funding.fee", true);
  const actionIntentHash = assertHash(input.actionIntentHash, "funding.actionIntentHash");
  if (input.effects.length !== 4) throw new TypeError("funding repayment requires loan and repayment effect legs");
  const repayment = (BigInt(principal) + BigInt(fee)).toString();
  const effects = Object.freeze(input.effects.map((effect, index) => Object.freeze({
    asset: asset(effect.asset, `funding.effects[${index}].asset`),
    account: effect.account,
    direction: effect.direction,
    amount: positiveDecimal(effect.amount, `funding.effects[${index}].amount`),
  })));
  if (effects.some(effect => effect.asset !== token)
    || effects[0]?.account !== "lender" || effects[0]?.direction !== "decrease" || effects[0]?.amount !== principal
    || effects[1]?.account !== "executor" || effects[1]?.direction !== "increase" || effects[1]?.amount !== principal
    || effects[2]?.account !== "executor" || effects[2]?.direction !== "decrease" || effects[2]?.amount !== repayment
    || effects[3]?.account !== "lender" || effects[3]?.direction !== "increase" || effects[3]?.amount !== repayment) {
    throw new TypeError("funding repayment effects do not bind principal and repayment");
  }
  const root = effectRoot(effects);
  const payload = {
    kind: "funding-repayment" as const,
    version: FUNDING_CONTRACT_VERSION_V1,
    familyId,
    instanceKey,
    lender,
    receiver,
    asset: token,
    principal,
    fee,
    repayment,
    due: "same-transaction" as const,
    actionIntentHash,
    effects,
    effectRoot: root,
  };
  return Object.freeze({ ...payload, obligationHash: hashDomain("aloha/funding-contract/obligation/v1", payload) });
}

export function assertFundingRepaymentObligation(value: unknown, path = "fundingRepayment"): FundingRepaymentObligationV1 {
  const decoded = decodeExactObject(value, {
    kind: (field, fieldPath) => field === "funding-repayment" ? field : (() => { throw new TypeError(`${fieldPath} kind mismatch`); })(),
    version: (field, fieldPath) => field === FUNDING_CONTRACT_VERSION_V1 ? field : (() => { throw new TypeError(`${fieldPath} version mismatch`); })(),
    familyId: (field, fieldPath) => assertNonEmptyString(field, fieldPath),
    instanceKey: (field, fieldPath) => assertNonEmptyString(field, fieldPath),
    lender: (field, fieldPath) => asset(field as string, fieldPath),
    receiver: (field, fieldPath) => asset(field as string, fieldPath),
    asset: (field, fieldPath) => asset(field as string, fieldPath),
    principal: (field, fieldPath) => positiveDecimal(field as string, fieldPath),
    fee: (field, fieldPath) => positiveDecimal(field as string, fieldPath, true),
    repayment: (field, fieldPath) => positiveDecimal(field as string, fieldPath),
    due: (field, fieldPath) => field === "same-transaction" ? field : (() => { throw new TypeError(`${fieldPath} due mismatch`); })(),
    actionIntentHash: (field, fieldPath) => assertHash(field, fieldPath),
    effects: (field, fieldPath) => {
      if (!Array.isArray(field)) throw new TypeError(`${fieldPath} must be an array`);
      return Object.freeze(field.map((item, index) => decodeExactObject(item, {
        asset: (effect, effectPath) => asset(effect as string, effectPath),
        account: (effect, effectPath) => effect === "lender" || effect === "executor" ? effect : (() => { throw new TypeError(`${effectPath} account mismatch`); })(),
        direction: (effect, effectPath) => effect === "decrease" || effect === "increase" ? effect : (() => { throw new TypeError(`${effectPath} direction mismatch`); })(),
        amount: (effect, effectPath) => positiveDecimal(effect as string, effectPath),
      }, `${fieldPath}[${index}]`)));
    },
    effectRoot: (field, fieldPath) => assertHash(field, fieldPath),
    obligationHash: (field, fieldPath) => assertHash(field, fieldPath),
  }, path) as FundingRepaymentObligationV1;
  if (BigInt(decoded.repayment) !== BigInt(decoded.principal) + BigInt(decoded.fee)) throw new TypeError(`${path} repayment arithmetic mismatch`);
  if (decoded.effects.length !== 4
    || effectsDoNotBind(decoded)) throw new TypeError(`${path} effect binding mismatch`);
  const payload = {
    kind: decoded.kind,
    version: decoded.version,
    familyId: decoded.familyId,
    instanceKey: decoded.instanceKey,
    lender: decoded.lender,
    receiver: decoded.receiver,
    asset: decoded.asset,
    principal: decoded.principal,
    fee: decoded.fee,
    repayment: decoded.repayment,
    due: decoded.due,
    actionIntentHash: decoded.actionIntentHash,
    effects: decoded.effects,
    effectRoot: decoded.effectRoot,
  };
  if (decoded.obligationHash !== hashDomain("aloha/funding-contract/obligation/v1", payload)) throw new TypeError(`${path} obligation hash mismatch`);
  return Object.freeze(decoded);
}

function effectsDoNotBind(decoded: FundingRepaymentObligationV1): boolean {
  return decoded.effects.some(effect => effect.asset !== decoded.asset)
    || decoded.effects[0]?.account !== "lender" || decoded.effects[0]?.direction !== "decrease" || decoded.effects[0]?.amount !== decoded.principal
    || decoded.effects[1]?.account !== "executor" || decoded.effects[1]?.direction !== "increase" || decoded.effects[1]?.amount !== decoded.principal
    || decoded.effects[2]?.account !== "executor" || decoded.effects[2]?.direction !== "decrease" || decoded.effects[2]?.amount !== decoded.repayment
    || decoded.effects[3]?.account !== "lender" || decoded.effects[3]?.direction !== "increase" || decoded.effects[3]?.amount !== decoded.repayment
    || decoded.effectRoot !== effectRoot(decoded.effects);
}
