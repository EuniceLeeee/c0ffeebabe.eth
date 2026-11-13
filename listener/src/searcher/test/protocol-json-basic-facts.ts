import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AbiCoder, getBytes, hexlify, isAddress } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../adapters/runtime-amount-program.js";
import { assertSubscriptCalldata } from "../../shared/executor/botvm-program-entry.js";
import { checkProtocolJsonExecutionFacts, checkProtocolJsonRevertFacts,
  type ProtocolJsonAcceptanceCase } from "./protocol-json-acceptance-facts.js";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const errorText = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
const uint = (value: unknown): bigint => {
  assert(typeof value === "bigint" && value >= 0n && value < 1n << 256n, "missing raw uint256 quote value"); return value;
};
const rawScript = (record: any): string => {
  assertSubscriptCalldata(record.request?.call?.data);
  const [script] = AbiCoder.defaultAbiCoder().decode(["bytes"], `0x${record.request.call.data.slice(10)}`);
  assert.equal(sha(getBytes(script)), record.scriptSha256, "execution calldata/script hash mismatch");
  return script;
};

/** Recompute core facts from the raw requests/results, not persisted pass labels.
 * This is a verifier of the trusted runner's receipts, not a hostile-host sandbox. */
export function verifyBasicRouteAcceptance(sample: ProtocolJsonAcceptanceCase, report: any, ordinaryRuntime: boolean) {
  assert.equal(sample.trials.length, 1, "one registry leg is one independently reported case");
  const trial = sample.trials[0]!, amountIn = BigInt(trial.amountIn);
  assert.equal(trial.expectedAmountOut, undefined, "historical output cannot be a simulation oracle");
  assert.equal(trial.inputToleranceRawUnits ?? 0, 0);
  const outputToleranceRawUnits = trial.outputToleranceRawUnits ?? 0;
  assert(outputToleranceRawUnits === 0 || outputToleranceRawUnits === 1, "output tolerance must be 0 or 1 raw unit");
  assert(report.source && report.source.number === sample.source.number && same(report.source.hash, sample.source.hash));
  assert(Number.isSafeInteger(report.source.generation) && report.source.generation >= 0);
  assert(Array.isArray(report.samples) && report.samples.length === 1, "raw case result is missing or ambiguous");
  const row = report.samples[0]; assert.equal(row.id, trial.id);
  assert.equal(row.quote?.status, "resolved", "current amount quote unavailable");
  assert.equal(row.quote.familyId, sample.familyId, "quote Family differs from case");
  assert.equal(isAddress(sample.instanceKey) ? row.quote.instanceKey?.toLowerCase() : row.quote.instanceKey,
    isAddress(sample.instanceKey) ? sample.instanceKey.toLowerCase() : sample.instanceKey, "quote instance differs from case");
  assert.equal(row.quote.routeKey, row.routeKey, "quote route differs from selected direction");
  assert.deepEqual(row.quote.source, report.source, "quote source differs from execution source");
  assert.equal(row.quote.generation, report.source.generation);
  if (sample.domain === "credit") {
    assert(trial.credit, "Credit policy missing");
    assert.equal(row.quote.debtBps, BigInt(trial.credit.debtBps), "Credit quote changed requested policy");
    assert.equal(row.quote.blocksPrefixInversion, true);
  }
  const quoteAmountIn = uint(sample.domain === "credit" ? row.quote.collateralAmount : row.quote.amountIn);
  assert.equal(quoteAmountIn, amountIn, "quote amountIn differs from request");
  const amountOut = uint(row.quote.amountOut); assert(amountOut > 0n, "quote output must be positive");
  assert(typeof row.routeKey === "string" && row.routeKey.length > 0);
  if (trial.routeKey !== undefined) assert.equal(row.routeKey, trial.routeKey);
  assert(report.runtimeConstruction?.exact > 0 && report.runtimeConstruction.quoted > 0, "quote/build work was not executed");
  assert.equal(report.runtimeConstruction.forbiddenDuringRuntimeBuild, 0, "runtime construction performed forbidden work");
  if (ordinaryRuntime) assert(report.runtimeConstruction.runtimeBuilds > 0, "declared runtime interface was not built");
  else assert.equal(sample.domain, "credit", "ordinary runtime cannot be waived for a conversion Family");
  const encodings = ordinaryRuntime ? ["quoted", "runtime"] : ["quoted"];
  const result: Record<string, any> = {
    exact: { status: "pass", tokenIn: trial.tokenIn, tokenOut: trial.tokenOut,
      requestedAmountIn: trial.amountIn, quotedAmountIn: quoteAmountIn.toString(), quotedAmountOut: amountOut.toString() },
  };
  for (const encoding of encodings) {
    const executions = row.executions.filter((item: any) => item.encoding === encoding && typeof item.recipient === "string" && same(item.recipient, sample.executor));
    assert.equal(executions.length, 3, `${encoding} requires unique positive/no-input/forced-revert observations`);
    const records = new Map<string, any>();
    for (const record of executions) {
      assert(["positive", "no-input", "forced-revert"].includes(record.probe) && !records.has(record.probe), "duplicate/unknown execution control");
      records.set(record.probe, record);
      const request = record.request;
      assert.equal(request?.kind, "effect-delta-simulation"); assert.equal(request.required, false);
      assert.deepEqual(request.call.caller, { kind: "executor" });
      assert.equal(request.call.executionMode, "executor-program"); assert(same(request.call.to, sample.executor));
      const intent = request.overrideIntent;
      assert.deepEqual({ ...intent, tokenBalances: intent?.tokenBalances?.map((balance: any) => {
        assert(isAddress(balance.token), "invalid execution funding token");
        return { ...balance, token: balance.token.toLowerCase() };
      }) }, { caller: { kind: "executor" }, nativeBalanceWei: 17n,
        tokenBalances: [{ token: trial.tokenIn.toLowerCase(), amount: record.probe === "no-input" ? 0n : amountIn + 101n },
          { token: trial.tokenOut.toLowerCase(), amount: amountOut + 103n }] }, "execution preparation differs from requested input/inventory controls");
      rawScript(record);
      const common = { requestId: request.id, result: record.resultEvidence, source: report.source,
        tokenIn: trial.tokenIn, tokenOut: trial.tokenOut, executor: sample.executor, recipient: sample.executor,
        protectedBalances: trial.protectedBalances };
      assert(record.inputMode === "exact" || record.inputMode === "maximum", "actual execution input mode was not recorded");
      const facts = record.probe === "positive" ? checkProtocolJsonExecutionFacts({ ...common,
        amountIn, quoteAmountOut: amountOut, inputMode: record.inputMode, inputToleranceRawUnits: 0, outputToleranceRawUnits })
        : checkProtocolJsonRevertFacts({ ...common, probe: record.probe });
      assert(facts.passed, `${encoding}/${record.probe}: ${JSON.stringify(facts.violations)}`);
    }
    const positive = records.get("positive"), script = rawScript(positive);
    assert.equal(rawScript(records.get("no-input")), script, "no-input control changed the execution program");
    const forced = runtimeProgramScript(new RuntimeAmountProgram().constant(0, 0n).constant(1, 1n).equal(0, 1).bytes());
    assert.equal(rawScript(records.get("forced-revert")), script + hexlify(forced).slice(2), "forced rollback does not follow the complete positive program");
    const delta = (token: string) => {
      const rows = positive.resultEvidence.effects.tokenDeltas.filter((r: any) => same(r.token, token) && same(r.account, sample.executor));
      assert.equal(rows.length, 1); return BigInt(rows[0].delta);
    };
    const actualIn = -delta(trial.tokenIn), actualOut = delta(trial.tokenOut);
    result[encoding === "quoted" ? "quotedExecution" : "runtimeExecution"] = { status: "pass", required: true,
      actualAmountIn: actualIn.toString(), actualAmountOut: actualOut.toString(),
      differenceFromExact: (actualOut - amountOut).toString(), controls: { positive: "pass", noInput: "pass", forcedRevert: "pass" } };
  }
  if (!ordinaryRuntime) result.runtimeExecution = { status: "not-declared", required: false, kind: "credit-risk-bound-execution" };
  result.simulationOutputParity = { status: "pass", toleranceRawUnits: outputToleranceRawUnits,
    quotedDifference: result.quotedExecution.differenceFromExact,
    ...(ordinaryRuntime ? { runtimeDifference: result.runtimeExecution.differenceFromExact } : {}) };
  return result;
}

/** Keep raw integers/failure details readable even when the evidence is incomplete. */
export function basicRouteAcceptanceStages(sample: ProtocolJsonAcceptanceCase, report: any, ordinaryRuntime: boolean) {
  try { return verifyBasicRouteAcceptance(sample, report, ordinaryRuntime); }
  catch (error) {
    const row = report.samples?.[0], trial = sample.trials[0]!;
    const value = (v: unknown) => typeof v === "bigint" ? v.toString() : null;
    const failure = errorText(error);
    const stage = (encoding: string) => {
      const records = row?.executions?.filter((r: any) => r.encoding === encoding) ?? [];
      const p = records.find((r: any) => r.probe === "positive" && same(r.recipient, sample.executor));
      const read = (token: string) => p?.resultEvidence?.ok === true
        ? p.resultEvidence.effects?.tokenDeltas?.find((r: any) => same(r.token, token) && same(r.account, sample.executor))?.delta : undefined;
      const input = read(trial.tokenIn), output = read(trial.tokenOut);
      return { status: records.length ? "failed" : "not-run", required: true,
        actualAmountIn: typeof input === "bigint" ? (-input).toString() : null, actualAmountOut: value(output),
        differenceFromExact: typeof output === "bigint" && typeof row?.quote?.amountOut === "bigint" ? (output - row.quote.amountOut).toString() : null,
        controls: records.map((r: any) => ({ probe: r.probe, status: r.result, failure: r.error ?? r.facts?.violations ?? null })), failure };
    };
    return { exact: { status: row?.quote?.status === "resolved" ? "observed" : "failed", requestedAmountIn: trial.amountIn,
      quotedAmountIn: value(sample.domain === "credit" ? row?.quote?.collateralAmount : row?.quote?.amountIn),
      quotedAmountOut: value(row?.quote?.amountOut), failure }, quotedExecution: stage("quoted"),
      runtimeExecution: ordinaryRuntime ? stage("runtime") : { status: "not-declared", required: false, kind: "credit-risk-bound-execution" },
      simulationOutputParity: { status: "failed", toleranceRawUnits: trial.outputToleranceRawUnits ?? 0, failure } };
  }
}
