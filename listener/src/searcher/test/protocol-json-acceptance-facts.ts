import { MaxUint256, ZeroAddress, getAddress, isHexString } from "ethers";
import type { AdapterRequestResult, CanonicalSource } from "../venues/adapter-request-program.js";

export interface ProtectedAcceptanceBalance { readonly token: string; readonly account: string }
export interface ProtocolJsonAcceptanceTrial {
  readonly id: string;
  readonly tokenIn: string; readonly tokenOut: string; readonly amountIn: string;
  readonly outputToleranceRawUnits?: 0 | 1; readonly inputToleranceRawUnits?: 0 | 1;
  readonly expectedAmountOut?: string; readonly recipients?: readonly string[];
  readonly protectedBalances?: readonly ProtectedAcceptanceBalance[];
}
export interface ProtocolJsonAcceptanceCase {
  readonly version: 1; readonly familyId: string; readonly instanceKey: string; readonly lineageId: string;
  readonly source: { readonly number: number; readonly hash: string };
  readonly executor: string; readonly owner: string; readonly transactionHash?: string;
  readonly trials: readonly ProtocolJsonAcceptanceTrial[];
}
export interface AcceptanceFactViolation { readonly code: string; readonly detail: string }
export interface ProtocolJsonAcceptanceFacts {
  readonly passed: boolean;
  readonly classification: "executed-as-quoted" | "observed-revert" | "transport-failure" | "unexpected-completion" | "invalid-observation" | "effect-mismatch";
  readonly requestId: string; readonly source: CanonicalSource;
  readonly violations: readonly AcceptanceFactViolation[];
  readonly observed: Readonly<Record<string, string | number | boolean | null>>;
  readonly rollbackEvidence?: "completed-evm-revert" | "observed-zero-balances";
}
const badKeys = new Set(["__proto__", "constructor", "prototype"]);
function json(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || ["string", "boolean"].includes(typeof value) || typeof value === "number" && Number.isSafeInteger(value)) return;
  if (!value || typeof value !== "object" || ancestors.has(value)) throw new Error("acceptance cases require lossless JSON data");
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error("acceptance case arrays must be plain data");
    if (Reflect.ownKeys(value).length !== value.length + 1) throw new Error("acceptance case arrays must be dense data");
    for (let i = 0; i < value.length; i++) {
      const property = Object.getOwnPropertyDescriptor(value, String(i));
      if (!property || !("value" in property)) throw new Error("acceptance case arrays must be dense data");
      json(property.value, ancestors);
    }
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error("acceptance case requires plain records");
    for (const key of Reflect.ownKeys(value)) {
      const property = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== "string" || badKeys.has(key) || !("value" in property) || !property.enumerable)
        throw new Error("acceptance case data property");
      json(property.value, ancestors);
    }
  }
  ancestors.delete(value);
}
function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error("acceptance case missing or unknown field");
}
function address(value: unknown): string {
  if (typeof value !== "string") throw new Error("acceptance address");
  const result = getAddress(value);
  if (result === ZeroAddress) throw new Error("acceptance address cannot be zero");
  return result;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !isHexString(value, 32)) throw new Error("acceptance source/transaction hash");
  return value.toLowerCase();
}
function decimal(value: unknown, positive = false): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > MaxUint256 || positive && value === "0")
    throw new Error("acceptance amount must be a canonical uint256 decimal string");
  return value;
}
function tolerance(value: unknown): 0 | 1 {
  if (value === undefined) return 0;
  if (value !== 0 && value !== 1) throw new Error("acceptance tolerance must be 0 or 1 raw unit");
  return value;
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() !== value || !value.length) throw new Error("acceptance identity/id must be nonempty text");
}
const pair = (token: string, account: string) => `${getAddress(token)}:${getAddress(account)}`;
function protection(raw: unknown): readonly ProtectedAcceptanceBalance[] {
  if (!Array.isArray(raw)) throw new Error("acceptance protectedBalances must be an array");
  const seen = new Set<string>();
  return Object.freeze(raw.map(row => {
    shape(row, ["token", "account"]);
    const item = { token: address(row.token), account: address(row.account) }, key = pair(item.token, item.account);
    if (seen.has(key)) throw new Error("duplicate acceptance protected balance"); seen.add(key);
    return Object.freeze(item);
  }));
}

/** A case selects actual production work. It cannot inject a descriptor,
 * admission decision, callback, test handler, observation or success label. */
export function parseProtocolJsonAcceptanceCase(raw: unknown): ProtocolJsonAcceptanceCase {
  json(raw); shape(raw, ["version", "familyId", "instanceKey", "lineageId", "source", "executor", "owner", "trials"], ["transactionHash"]);
  if (raw.version !== 1 || typeof raw.familyId !== "string" || !/^protocol:[a-zA-Z0-9][a-zA-Z0-9:._-]*$/.test(raw.familyId))
    throw new Error("acceptance case must select a protocol Family");
  text(raw.instanceKey); text(raw.lineageId);
  shape(raw.source, ["number", "hash"]);
  if (!Number.isSafeInteger(raw.source.number) || raw.source.number < 0) throw new Error("acceptance source block");
  if (!Array.isArray(raw.trials) || !raw.trials.length) throw new Error("acceptance trials must be nonempty");
  const ids = new Set<string>();
  const trials = raw.trials.map((trial: unknown) => {
    shape(trial, ["id", "tokenIn", "tokenOut", "amountIn"],
      ["outputToleranceRawUnits", "inputToleranceRawUnits", "expectedAmountOut", "recipients", "protectedBalances"]);
    text(trial.id); if (ids.has(trial.id)) throw new Error("duplicate acceptance trial id"); ids.add(trial.id);
    const tokenIn = address(trial.tokenIn), tokenOut = address(trial.tokenOut);
    if (tokenIn === tokenOut) throw new Error("acceptance route tokens must differ");
    let recipients: readonly string[] | undefined;
    if (trial.recipients !== undefined) {
      if (!Array.isArray(trial.recipients) || !trial.recipients.length) throw new Error("acceptance recipients must be nonempty");
      recipients = Object.freeze(trial.recipients.map(address));
      if (new Set(recipients).size !== recipients.length) throw new Error("duplicate acceptance recipient");
    }
    tolerance(trial.inputToleranceRawUnits); tolerance(trial.outputToleranceRawUnits);
    return Object.freeze({ id: trial.id, tokenIn, tokenOut, amountIn: decimal(trial.amountIn, true),
      ...(trial.inputToleranceRawUnits !== undefined ? { inputToleranceRawUnits: trial.inputToleranceRawUnits } : {}),
      ...(trial.outputToleranceRawUnits !== undefined ? { outputToleranceRawUnits: trial.outputToleranceRawUnits } : {}),
      ...(trial.expectedAmountOut !== undefined ? { expectedAmountOut: decimal(trial.expectedAmountOut) } : {}),
      ...(recipients ? { recipients } : {}),
      ...(trial.protectedBalances !== undefined ? { protectedBalances: protection(trial.protectedBalances) } : {}) });
  });
  return Object.freeze({ version: 1, familyId: raw.familyId, instanceKey: raw.instanceKey, lineageId: raw.lineageId,
    source: Object.freeze({ number: raw.source.number, hash: hash(raw.source.hash) }), executor: address(raw.executor), owner: address(raw.owner),
    ...(raw.transactionHash !== undefined ? { transactionHash: hash(raw.transactionHash) } : {}), trials: Object.freeze(trials) });
}

interface FactInput {
  readonly requestId: string; readonly result: AdapterRequestResult; readonly source: CanonicalSource;
  readonly tokenIn: string; readonly tokenOut: string; readonly executor: string; readonly recipient?: string;
  readonly protectedBalances?: readonly ProtectedAcceptanceBalance[];
}
export interface ProtocolJsonExecutionFactInput extends FactInput {
  readonly amountIn: bigint; readonly quoteAmountOut: bigint; readonly expectedAmountOut?: bigint;
  readonly inputMode: "exact" | "maximum";
  readonly inputToleranceRawUnits?: 0 | 1; readonly outputToleranceRawUnits?: 0 | 1;
}
function positive(value: bigint): void {
  if (typeof value !== "bigint" || value <= 0n || value > MaxUint256) throw new Error("acceptance input/quote must be positive uint256");
}
/** Result objects come from the runner's actual trusted transport, never from
 * case JSON. This helper validates facts; it does not mint transport authority. */
function observation(input: FactInput, completion: "returned" | "reverted-as-declared") {
  const violations: AcceptanceFactViolation[] = [];
  const fail = (code: string, detail: string) => { violations.push({ code, detail }); };
  const executor = address(input.executor), recipient = address(input.recipient ?? executor);
  const tokenIn = address(input.tokenIn), tokenOut = address(input.tokenOut);
  if (tokenIn === tokenOut) throw new Error("acceptance route tokens must differ");
  const protectedBalances = protection(input.protectedBalances ?? []);
  const debitKey = pair(tokenIn, executor), creditKey = pair(tokenOut, recipient);
  if (protectedBalances.some(row => [debitKey, creditKey].includes(pair(row.token, row.account))))
    throw new Error("protected balance overlaps an active route effect");
  const required = new Set([debitKey, creditKey, ...protectedBalances.map(row => pair(row.token, row.account))]);
  if (executor !== recipient) { required.add(pair(tokenOut, executor)); required.add(pair(tokenIn, recipient)); }
  const { result, source } = input;
  if (!Number.isSafeInteger(source.number) || source.number < 0 || !Number.isSafeInteger(source.generation) || source.generation < 0)
    throw new Error("acceptance canonical source");
  hash(source.hash); text(input.requestId);
  if (result?.id !== input.requestId) fail("request-id", "result does not match the issued request");
  if (!result?.source || result.source.number !== source.number || result.source.generation !== source.generation ||
      typeof result.source.hash !== "string" || result.source.hash.toLowerCase() !== source.hash.toLowerCase())
    fail("source", "result does not match the tested canonical block and generation");
  let classification: ProtocolJsonAcceptanceFacts["classification"] = "invalid-observation";
  if (result?.ok === false) {
    classification = "transport-failure"; fail("transport-failure", `no completed EVM result: ${result.failure}`);
  } else if (result?.ok !== true) fail("completion", "result has no completed transport result");
  else {
    if (!result.provenance || typeof result.provenance.kind !== "string" || !result.provenance.kind.length ||
        typeof result.provenance.fingerprint !== "string" || !result.provenance.fingerprint.length)
      fail("provenance", "completed result has no transport provenance");
    if (result.completion !== completion) { classification = "unexpected-completion"; fail("completion", `expected ${completion}, observed ${result.completion}`); }
    if (typeof result.data !== "string" || !isHexString(result.data, true)) fail("return-data", "completed result has malformed return/revert data");
  }
  const tokenRows = result?.ok === true ? result.effects?.tokenDeltas : undefined;
  const nativeRows = result?.ok === true ? result.effects?.nativeDeltas : undefined;
  const tokens = new Map<string, bigint>(), natives = new Map<string, bigint>();
  if (!Array.isArray(tokenRows)) fail("missing-token-effects", "token balance observations are absent");
  else for (const row of tokenRows) {
    try {
      const key = pair(address(row.token), address(row.account));
      if (typeof row.delta !== "bigint" || row.delta < -MaxUint256 || row.delta > MaxUint256) throw new Error("delta");
      if (tokens.has(key)) fail("duplicate-token-delta", key); else tokens.set(key, row.delta);
    } catch { fail("invalid-token-delta", "token delta requires an address pair and signed bigint"); }
  }
  if (!Array.isArray(nativeRows)) fail("missing-native-effects", "native balance observations are absent");
  else for (const row of nativeRows) {
    try {
      const account = address(row.account);
      if (typeof row.delta !== "bigint" || row.delta < -MaxUint256 || row.delta > MaxUint256) throw new Error("delta");
      if (natives.has(account)) fail("duplicate-native-delta", account); else natives.set(account, row.delta);
    } catch { fail("invalid-native-delta", "native delta requires an address and signed bigint"); }
  }
  const complete = () => {
    for (const key of required) if (!tokens.has(key)) fail("missing-token-delta", key);
    if (!natives.has(executor)) fail("missing-native-delta", executor);
  };
  const finish = (observed: ProtocolJsonAcceptanceFacts["observed"], success: "executed-as-quoted" | "observed-revert",
    rollbackEvidence?: ProtocolJsonAcceptanceFacts["rollbackEvidence"]): ProtocolJsonAcceptanceFacts => ({
      passed: violations.length === 0, classification: violations.length ? classification : success,
      requestId: input.requestId, source: { ...source }, violations, observed,
      ...(rollbackEvidence ? { rollbackEvidence } : {}) });
  return { executor, recipient, tokenIn, tokenOut, debitKey, creditKey, protectedBalances,
    tokens, natives, tokenRows, nativeRows, violations, fail, complete, finish,
    mismatch() { if (classification === "invalid-observation" && !violations.length) classification = "effect-mismatch"; } };
}

export function checkProtocolJsonExecutionFacts(input: ProtocolJsonExecutionFactInput): ProtocolJsonAcceptanceFacts {
  positive(input.amountIn); positive(input.quoteAmountOut);
  if (input.inputMode !== "exact" && input.inputMode !== "maximum") throw new Error("acceptance input mode");
  const inputTolerance = BigInt(tolerance(input.inputToleranceRawUnits)), outputTolerance = BigInt(tolerance(input.outputToleranceRawUnits));
  if (input.expectedAmountOut !== undefined && (typeof input.expectedAmountOut !== "bigint" || input.expectedAmountOut < 0n || input.expectedAmountOut > MaxUint256))
    throw new Error("acceptance expected output uint256");
  const facts = observation(input, "returned"); facts.complete(); facts.mismatch();
  const inputDelta = facts.tokens.get(facts.debitKey), actualDebit = inputDelta === undefined ? undefined : -inputDelta;
  const actualCredit = facts.tokens.get(facts.creditKey);
  const inputShortfall = actualDebit === undefined ? undefined : input.amountIn - actualDebit;
  const outputDifference = actualCredit === undefined ? undefined : actualCredit - input.quoteAmountOut;
  if (actualDebit !== undefined) {
    if (actualDebit <= 0n) facts.fail("nonpositive-debit", "zero or increasing input balance is not a conversion");
    if (actualDebit > input.amountIn) facts.fail("input-overdebit", "actual debit exceeded this invocation's input and spent protected inventory");
    if (input.inputMode === "exact" && inputShortfall! > inputTolerance) facts.fail("input-underdebit", "actual input shortfall exceeded the declared 0/1 boundary");
  }
  if (actualCredit !== undefined) {
    if (actualCredit <= 0n) facts.fail("nonpositive-credit", "conversion requires positive newly received output");
    if (outputDifference! < -outputTolerance) facts.fail("output-shortfall", "actual receipt is below the quote beyond the declared 0/1 boundary");
    if (outputDifference! > outputTolerance) facts.fail("output-excess", "actual receipt exceeds the quote beyond the declared 0/1 boundary");
    if (input.expectedAmountOut !== undefined && (actualCredit - input.expectedAmountOut > outputTolerance || input.expectedAmountOut - actualCredit > outputTolerance))
      facts.fail("expected-output", "actual receipt differs from the independently supplied expected amount");
  }
  const protectedKeys = new Set(facts.protectedBalances.map(row => pair(row.token, row.account)));
  for (const [key, delta] of facts.tokens) {
    const account = key.slice(key.indexOf(":") + 1);
    if (![facts.debitKey, facts.creditKey].includes(key) &&
        (protectedKeys.has(key) || account === facts.executor || account === facts.recipient) && delta !== 0n)
      facts.fail("protected-token-inventory", `non-route token/account changed: ${key}`);
  }
  for (const [account, delta] of facts.natives) if (delta !== 0n) facts.fail("native-inventory", `native balance changed: ${account}`);
  return facts.finish({ actualDebit: actualDebit?.toString() ?? null, actualCredit: actualCredit?.toString() ?? null,
    requestedInput: input.amountIn.toString(), quotedOutput: input.quoteAmountOut.toString(),
    expectedOutput: input.expectedAmountOut?.toString() ?? null, inputMode: input.inputMode,
    inputShortfall: inputShortfall?.toString() ?? null,
    outputShortfall: outputDifference === undefined ? null : (outputDifference < 0n ? -outputDifference : 0n).toString(),
    outputExcess: outputDifference === undefined ? null : (outputDifference > 0n ? outputDifference : 0n).toString(),
    inputToleranceRawUnits: Number(inputTolerance), outputToleranceRawUnits: Number(outputTolerance),
  }, "executed-as-quoted");
}

export function checkProtocolJsonRevertFacts(input: FactInput & { readonly probe: "no-input" | "forced-revert" }): ProtocolJsonAcceptanceFacts {
  if (input.probe !== "no-input" && input.probe !== "forced-revert") throw new Error("acceptance negative probe");
  const facts = observation(input, "reverted-as-declared"), result = input.result;
  // The production transport deliberately normalizes completed EVM reverts
  // to explicit empty effect arrays. This proves rollback completion, not
  // independently measured zero balances. Undefined/partial observations fail.
  const normalizedRollback = result.ok === true && result.completion === "reverted-as-declared" &&
    result.provenance?.kind === "strict-simulation-transport" && Array.isArray(facts.tokenRows) && facts.tokenRows.length === 0 &&
    Array.isArray(facts.nativeRows) && facts.nativeRows.length === 0;
  if (!normalizedRollback) facts.complete();
  facts.mismatch();
  for (const [key, delta] of facts.tokens) if (delta !== 0n) facts.fail("rollback-token-delta", key);
  for (const [account, delta] of facts.natives) if (delta !== 0n) facts.fail("rollback-native-delta", account);
  if (result.ok === true) {
    if (result.effects?.logs?.length) facts.fail("rollback-logs", "reverted execution retained logs");
    for (const row of result.effects?.totalSupplyDeltas ?? [])
      if (typeof row.delta !== "bigint" || row.delta !== 0n) facts.fail("rollback-supply-delta", "reverted execution changed token supply");
  }
  const evidence = facts.violations.length ? undefined : normalizedRollback ? "completed-evm-revert" : "observed-zero-balances";
  return facts.finish({ probe: input.probe, tokenObservations: facts.tokens.size, nativeObservations: facts.natives.size,
    measuredZeroBalances: evidence === "observed-zero-balances" }, "observed-revert", evidence);
}
