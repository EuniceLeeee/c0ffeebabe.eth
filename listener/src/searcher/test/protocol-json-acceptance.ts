// One opt-in, data-driven Swap/Protocol acceptance entry. No Family-specific codec,
// math, discovery, scheduler, executor deployment, signing or submission here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openSync, closeSync, readFileSync, writeSync, ftruncateSync, fsyncSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Interface, getBytes } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript, type RuntimeAmountLeg } from "../../adapters/runtime-amount-program.js";
import { concatBytes } from "../../encoder.js";
import type { ResolvedPlanNode } from "../../types.js";
import { buildSubscriptCalldata } from "../../shared/executor/botvm-program-entry.js";
import { executeAdapterWork, type CentralAdapterRuntime } from "../adapter-work-intent.js";
import { planFragmentNodes } from "../solver/plan-fragment-requirements.js";
import { buildFamilyExecutionFragment, buildFamilyRuntimeAmountLeg, executeFamilyExactQuote } from "../venues/adapter-family-runtime.js";
import type { AdapterRequest, AdapterRequestResult } from "../venues/adapter-request-program.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../venues/production-infra-actions.js";
import { inspectAcceptanceEntry, openProtocolJsonAcceptanceContext, ProtocolJsonAcceptanceContextError, type ProtocolJsonAcceptanceContext } from "./protocol-json-acceptance-context.js";
import { parseProtocolJsonAcceptanceCase, checkProtocolJsonExecutionFacts, checkProtocolJsonRevertFacts, checkReadOnlyQuoteFacts,
  type AcceptanceSettlementMode,
  type ProtocolJsonAcceptanceCase, type ProtocolJsonAcceptanceTrial } from "./protocol-json-acceptance-facts.js";

const safeError = (error: unknown) => String(error instanceof Error ? error.message : error)
  .replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => JSON.stringify(value, (_key, item) =>
  typeof item === "bigint" ? { $type: "bigint", value: String(item) } : item, 2);
const token = new Interface(["function balanceOf(address) view returns(uint256)"]);
const effects = ["return-data", "revert-data", "token-delta", "native-delta", "logs"] as const;

/** The runtime builder may inspect sealed caller/source authority, but cannot
 * acquire a request executor, invoke Exact, or fall back to quoted encoding. */
export function acceptanceConstructionGuard(runtime: CentralAdapterRuntime) {
  let constructing = false;
  const counts = { runtimeBuilds: 0, exact: 0, quoted: 0, forbiddenDuringRuntimeBuild: 0 };
  const assertNotBuilding = () => {
    if (constructing) { counts.forbiddenDuringRuntimeBuild++; throw new Error("Exact/quoted/I/O during runtime construction"); }
  };
  return {
    counts,
    runtime: new Proxy(runtime, { get(target, key, receiver) {
      // This proxy is exclusively for construction. Keeping it read-only after
      // return also catches deferred microtasks retaining the supplied handle.
      if (!["callerAuthority", "generationFence"].includes(String(key))) {
        counts.forbiddenDuringRuntimeBuild++;
        throw new Error("I/O handle is forbidden in runtime construction");
      }
      return Reflect.get(target, key, receiver);
    } }),
    build<T>(fn: () => T): T {
      assert(!constructing); counts.runtimeBuilds++; constructing = true;
      try { const result = fn(); assert(!(result && typeof (result as any).then === "function"), "runtime construction must be synchronous"); return result; }
      finally { constructing = false; }
    },
    exact<T>(fn: () => T): T { assertNotBuilding(); counts.exact++; return fn(); },
    quoted<T>(fn: () => T): T { assertNotBuilding(); counts.quoted++; return fn(); },
  };
}

/** The expected receipt is evaluated by the existing VM in this same state and
 * recipient context. The enclosing test program binds it to independent balance
 * measurement; it does not take a number computed by the Family JSON as truth. */
export function directQuoteReceiptProgram(input: { quote: RuntimeAmountLeg; direct: RuntimeAmountLeg;
  tokenOut: string; recipient: string }): RuntimeAmountProgram {
  return new RuntimeAmountProgram()
    .call(input.tokenOut, token.encodeFunctionData("balanceOf", [input.recipient]), { static: true }).load(1, 0)
    .run(input.quote.program, 0, 2, true)
    .run(input.direct.program, 0, 3)
    .call(input.tokenOut, token.encodeFunctionData("balanceOf", [input.recipient]), { static: true }).load(4, 0)
    .math("sub", 4, 4, 1).equal(4, 2);
}

function delta(result: AdapterRequestResult, tokenAddress: string, account: string): bigint {
  assert(result.ok && result.completion === "returned");
  const matches = result.effects?.tokenDeltas?.filter(row => same(row.token, tokenAddress) && same(row.account, account));
  assert.equal(matches?.length, 1, "receipt must be independently observed exactly once");
  return matches![0]!.delta;
}

/** Select only a naturally admitted route. A key resolves duplicate token
 * directions; it cannot replace the declared token direction or create a route. */
export function selectAcceptanceRoute<T extends { readonly routeKey: string; readonly tokenIn: string; readonly tokenOut: string }>(
  routes: readonly T[], trial: Pick<ProtocolJsonAcceptanceTrial, "tokenIn" | "tokenOut" | "routeKey">): T {
  const matches = routes.filter(route => same(route.tokenIn, trial.tokenIn) && same(route.tokenOut, trial.tokenOut) &&
    (trial.routeKey === undefined || route.routeKey === trial.routeKey));
  assert.equal(matches.length, 1, "case must select one naturally admitted route");
  return matches[0]!;
}

export async function runProtocolJsonAcceptance(sample: ProtocolJsonAcceptanceCase, context: ProtocolJsonAcceptanceContext,
  report: Record<string, any>, checkpoint: () => void = () => {}) {
  sample = parseProtocolJsonAcceptanceCase(sample);
  const { family, instance, source, executor, runtime, catalog, control } = context;
  assert(instance.routes.length > 0, "acceptance requires actual admitted directions");
  assert.equal(source.number, sample.source.number);
  assert(same(source.hash, sample.source.hash), "case source differs from execution source");
  assert(same(executor, sample.executor) && same(context.owner, sample.owner), "case actors differ from execution actors");
  assert.equal(family.plugin.manifest.familyId, sample.familyId);
  assert.equal(family.plugin.manifest.domain, sample.domain ?? "protocol", "case domain differs from the installed Family");
  assert.equal(instance.descriptor.lineageId, sample.lineageId);
  assert.equal(instance.instanceKey, sample.instanceKey);
  const guard = acceptanceConstructionGuard(runtime);
  const adapters = [...family.plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
  const encode = (node: ResolvedPlanNode): Uint8Array => {
    const adapter = adapters.find(candidate => candidate.id === node.adapterId);
    assert(adapter, `unowned action ${node.adapterId}`);
    return adapter.encode(node, executor, concatBytes(...node.children.map(encode)));
  };
  report.implementation = await inspectAcceptanceEntry(family);
  report.source = source; report.evidence = context.evidence; report.samples = [];
  report.scope = "Current-source Ready rehydration and fresh same-state local EVM single-leg execution";
  report.notClaimed = ["original transaction pre-call parity", "new natural valuation", "opportunity replay", "performance", "all variants"];
  report.runtimeConstruction = guard.counts;
  const covered = new Set<string>(), successful = new Set<string>();
  const dispatch = async (request: AdapterRequest) => {
    const outcome = await executeAdapterWork({ runtime, control, intent: {
      stage: "exact-refine", familyId: family.plugin.manifest.familyId, source, generation: source.generation,
      programInput: undefined, program: {
        requirements: () => ({ transports: ["effect-delta-simulation"] as const, caller: "executor" as const, effects }),
        buildRequests: () => [request], decode: ({ results }) => results,
      },
    } });
    assert.equal(outcome.status, "resolved", "transport/scheduling failure is not a protocol rejection");
    if (outcome.status !== "resolved") throw new Error("execution work unresolved");
    assert.equal(outcome.executed.evidence.length, 1);
    return outcome.executed.evidence[0]!;
  };
  for (const trial of sample.trials) {
    const required = new Set<AcceptanceSettlementMode>(trial.requiredSettlement ?? []);
    if (trial.recipients?.length) required.add("direct-output");
    const recipients = [...new Set([executor, context.owner, ...(trial.recipients ?? [])].map(address => address.toLowerCase()))];
    const row: Record<string, any> = { id: trial.id, result: "failed", executions: [] };
    report.samples.push(row); checkpoint();
    try {
      const route = selectAcceptanceRoute(instance.routes, trial), handle = instance.routeHandles.find(handle => handle.routeKey === route.routeKey)!;
      assert(handle); covered.add(route.routeKey); row.routeKey = route.routeKey;
      assert(context.graph.some(edge => edge.instanceKey === instance.instanceKey &&
        same(edge.tokenIn, route.tokenIn) && same(edge.tokenOut, route.tokenOut)), "admitted direction missing from production graph");
      const base = { family, route: handle, source, executor, runtimeEvidence: [], actionOwnership: catalog };
      const build = (settlement?: Parameters<typeof buildFamilyRuntimeAmountLeg>[0]["settlement"]) =>
        guard.build(() => buildFamilyRuntimeAmountLeg({ ...base, runtime: guard.runtime, ...(settlement ? { settlement } : {}) }));
      // This is deliberately before Exact, including on the first trial.
      const leg = build(); assert(leg, "runtime is missing; no quoted fallback");
      const amountIn = BigInt(trial.amountIn);
      const quote = await guard.exact(() => executeFamilyExactQuote({ ...base, amountIn,
        generation: source.generation, runtime, control }));
      row.quote = quote; checkpoint();
      assert.equal(quote.status, "resolved", "state refusal/unavailable is retained, never promoted to execution support");
      if (quote.status !== "resolved") throw new Error("amount quote unavailable");
      assert(quote.amountOut > 0n);
      if (trial.expectedAmountOut !== undefined) assert.equal(quote.amountOut, BigInt(trial.expectedAmountOut));
      const minimum = quote.amountOut > BigInt(trial.outputToleranceRawUnits ?? 0)
        ? quote.amountOut - BigInt(trial.outputToleranceRawUnits ?? 0) : 1n;
      const fragment = guard.quoted(() => buildFamilyExecutionFragment({ ...base, exact: quote, minAmountOut: minimum,
        quoteToleranceRawUnits: BigInt(trial.inputToleranceRawUnits ?? 0) }));
      assert.equal(fragment.status, "resolved");
      if (fragment.status !== "resolved") throw new Error("quoted fragment unavailable");
      const scripts: Array<{ encoding: string; script: Uint8Array; recipient: string; dynamicQuote?: boolean; inputMode?: "maximum" }> = [
        { encoding: "quoted", script: concatBytes(...planFragmentNodes(fragment.fragment, route.tokenIn, amountIn).map(encode)), recipient: executor, inputMode: leg.inputMode },
        { encoding: "runtime", script: runtimeProgramScript(getBytes(leg.program), amountIn), recipient: executor, inputMode: leg.inputMode },
      ];
      row.settlement = leg.settlement ?? {};
      const caps = leg.settlement;
      const declared: AcceptanceSettlementMode[] = [];
      if (caps?.directOutput) declared.push("direct-output");
      if (caps?.quoteOutput) declared.push("quote-output");
      if (caps?.deferredInput) declared.push("deferred-input");
      if (caps?.deferredDebtInput) declared.push("deferred-debt-input");
      if (caps?.settleOutput) declared.push("settle-output");
      for (const mode of declared) required.add(mode);
      row.missingDeclarations = [...required].filter(mode => !declared.includes(mode));
      if (caps?.directOutput) assert(recipients.length > 1, "direct-output needs a distinct external recipient");
      if (caps?.quoteOutput) {
        for (const recipient of recipients) {
          const prepared = build({ kind: "quote-output", recipient }); assert(prepared, "declared quote output missing");
          const read = new RuntimeAmountProgram().run(prepared.program, 0, 1, true);
          // The executor is also the caller/receiver of specified-amount Exact. External recipients can have a different rate.
          if (same(recipient, executor)) read.constant(2, quote.amountOut).equal(1, 2);
          else read.constant(2, 1n).math("sub", 3, 1, 2);
          scripts.push({ encoding: "quote-only", recipient, script: runtimeProgramScript(read.bytes(), amountIn) });
        }
      }
      if (caps?.directOutput) {
        for (const recipient of recipients) {
          const direct = build({ kind: "direct-output", recipient }); assert(direct, "declared direct output missing");
          const prepared = caps.quoteOutput ? build({ kind: "quote-output", recipient }) : null;
          if (caps.quoteOutput) assert(prepared, "declared quote output missing");
          scripts.push({ encoding: "runtime-direct", recipient, inputMode: direct.inputMode, dynamicQuote: prepared !== null,
            script: prepared ? runtimeProgramScript(directQuoteReceiptProgram({ quote: prepared, direct, tokenOut: route.tokenOut, recipient }).bytes(), amountIn)
              : runtimeProgramScript(getBytes(direct.program), amountIn) });
        }
      }
      for (const execution of scripts) for (const probe of (execution.encoding === "quote-only"
        ? ["positive"] as const : ["positive", "no-input", "forced-revert"] as const)) {
        const record: Record<string, any> = { encoding: execution.encoding, recipient: execution.recipient, probe, result: "failed" };
        row.executions.push(record); checkpoint();
        try {
          const script = probe === "forced-revert" ? concatBytes(execution.script,
            runtimeProgramScript(new RuntimeAmountProgram().constant(0, 0n).constant(1, 1n).equal(0, 1).bytes())) : execution.script;
          const caller = { kind: "executor" as const };
          const observations = [route.tokenIn, route.tokenOut].flatMap(token =>
            [...new Set([executor, execution.recipient].map(address => address.toLowerCase()))].map(account => ({ token, account })));
          for (const extra of trial.protectedBalances ?? []) if (!observations.some(row => same(row.token, extra.token) && same(row.account, extra.account))) observations.push(extra);
          const request: AdapterRequest = { id: `${trial.id}-${row.executions.length}`, kind: "effect-delta-simulation", required: false,
            call: { caller, executionMode: "executor-program", to: executor, data: buildSubscriptCalldata(script) },
            overrideIntent: execution.encoding === "quote-only" ? { caller } : { caller, nativeBalanceWei: 17n, tokenBalances: [
              { token: route.tokenIn, amount: probe === "no-input" ? 0n : amountIn + 101n },
              { token: route.tokenOut, amount: quote.amountOut + 103n },
            ] }, observeTokenBalances: observations, observe: effects };
          record.scriptSha256 = hash(script); record.request = request;
          record.resultEvidence = await dispatch(request); checkpoint();
          const common = { requestId: request.id, result: record.resultEvidence as AdapterRequestResult, source,
            tokenIn: route.tokenIn, tokenOut: route.tokenOut, executor, recipient: execution.recipient,
            protectedBalances: trial.protectedBalances };
          if (execution.encoding === "quote-only") {
            record.facts = checkReadOnlyQuoteFacts(common);
          } else if (probe === "positive") {
            const recipientSpecific = execution.dynamicQuote && !same(execution.recipient, executor);
            const expected = recipientSpecific ? delta(common.result, route.tokenOut, execution.recipient) : quote.amountOut;
            record.outputComparison = recipientSpecific ? "recipient-specific quote equality enforced in executed script" : "specified-amount Exact";
            record.facts = checkProtocolJsonExecutionFacts({ ...common, amountIn, quoteAmountOut: expected,
              inputMode: execution.inputMode ?? "exact", inputToleranceRawUnits: trial.inputToleranceRawUnits,
              outputToleranceRawUnits: execution.dynamicQuote ? 0 : trial.outputToleranceRawUnits });
          } else record.facts = checkProtocolJsonRevertFacts({ ...common, probe });
          if (!record.facts.passed) throw new Error(JSON.stringify(record.facts));
          record.result = "pass";
        } catch (error) {
          record.error = safeError(error);
          row.error ??= record.error;
          if (control?.signal.aborted) throw error;
        }
        checkpoint();
      }
    } catch (error) {
      row.error ??= safeError(error);
    }
    const proved = (encoding: string, recipient: string, probes: readonly string[]) => probes.every(probe =>
      row.executions.some((e: any) => e.encoding === encoding && same(e.recipient, recipient) && e.probe === probe && e.result === "pass"));
    const controls = ["positive", "no-input", "forced-revert"];
    const ordinary = proved("quoted", executor, controls) && proved("runtime", executor, controls);
    if (ordinary) successful.add(row.routeKey);
    const verified = new Set<AcceptanceSettlementMode>();
    if (recipients.length > 1 && recipients.every(r => proved("runtime-direct", r, controls))) verified.add("direct-output");
    if (recipients.every(r => proved("quote-only", r, ["positive"]))) verified.add("quote-output");
    row.requiredSettlement = [...required];
    row.verifiedSettlement = [...verified];
    row.unverifiedSettlement = [...required].filter(mode => !verified.has(mode));
    row.result = row.error || !ordinary ? "failed" : row.unverifiedSettlement.length ? "partial" : "pass";
    checkpoint();
  }
  report.coverage = { scope: "one-admitted-instance", familyId: sample.familyId, domain: sample.domain ?? "protocol",
    instanceKey: sample.instanceKey, lineageId: sample.lineageId,
    otherDeclaredLineages: family.plugin.manifest.supportedLineages.filter(lineage => lineage !== sample.lineageId),
    settlementGaps: report.samples.filter((row: any) => row.unverifiedSettlement?.length || row.missingDeclarations?.length)
      .map((row: any) => ({ trial: row.id, routeKey: row.routeKey, missingDeclaration: row.missingDeclarations ?? [],
        unverified: row.unverifiedSettlement ?? row.requiredSettlement })),
    admittedRoutes: instance.routes.length, sampledRoutes: covered.size, executedRoutes: successful.size,
    unsampledRoutes: instance.routes.filter(route => !covered.has(route.routeKey)).map(route => ({ routeKey: route.routeKey, tokenIn: route.tokenIn, tokenOut: route.tokenOut })) };
  report.result = report.samples.every((row: any) => row.result === "pass" && row.executions.length > 0) &&
    successful.size === instance.routes.length && guard.counts.forbiddenDuringRuntimeBuild === 0 ? "pass" : "incomplete-or-failed";
  report.referenceSettlementCoverage = sample.trials.every(trial => trial.requiredSettlement !== undefined)
    ? (report.result === "pass" ? "requirements-met-for-this-case" : "incomplete-for-this-case")
    : "prior-settlement-requirements-not-specified";
  report.declaredVariantsAtThisLineage = report.implementation.variants?.filter((v: { lineageId: string }) => v.lineageId === sample.lineageId);
  report.familyAcceptance = "sample evidence only; combine current variant coverage, interface review and production performance evidence";
  checkpoint();
  return report;
}

export async function protocolJsonAcceptanceMain(argv = process.argv.slice(2)) {
  const args = new Map<string, string>(); let validateOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    if (key === "--validate-only" && !validateOnly) { validateOnly = true; continue; }
    assert(["--case", "--ready", "--rpc-file", "--revm-bin", "--executor-code-mode", "--out"].includes(key) && !args.has(key) && argv[i + 1], "invalid arguments");
    args.set(key, argv[++i]!);
  }
  assert(args.has("--case"), "--case is required");
  const sample = parseProtocolJsonAcceptanceCase(JSON.parse(readFileSync(args.get("--case")!, "utf8")));
  if (validateOnly) { assert.equal(args.size, 1); console.log(json({ result: "case-valid", familyId: sample.familyId, execution: "not-run" })); return; }
  for (const key of ["--ready", "--rpc-file", "--out"]) assert(args.has(key), `${key} is required`);
  assert([undefined, "deployed", "counterfactual"].includes(args.get("--executor-code-mode")), "invalid executor code mode");
  const fd = openSync(args.get("--out")!, "wx", 0o600);
  const report: Record<string, any> = { format: "protocol-json-acceptance-v1", result: "incomplete", sample,
    signing: false, broadcast: false, protocolStateOverrides: false, performance: "not-run", errors: [] };
  const checkpoint = () => { ftruncateSync(fd, 0); const data = Buffer.from(json(report) + "\n");
    // Explicit offset avoids appending after an earlier, longer checkpoint.
    requireWrite(fd, data); fsyncSync(fd); };
  let context: ProtocolJsonAcceptanceContext | undefined;
  try {
    checkpoint();
    context = await openProtocolJsonAcceptanceContext({ ...sample, readyPath: resolve(args.get("--ready")!),
      rpcFile: resolve(args.get("--rpc-file")!), allowExecutorCodeOverride: args.get("--executor-code-mode") === "counterfactual", inputPaths: [resolve(args.get("--case")!),
        fileURLToPath(import.meta.url), fileURLToPath(new URL("./protocol-json-acceptance-facts.ts", import.meta.url))] });
    await runProtocolJsonAcceptance(sample, context, report, checkpoint);
  } catch (error) {
    report.result = "failed"; report.errors.push(String(error instanceof Error ? error.message : error).replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]"));
    if (error instanceof ProtocolJsonAcceptanceContextError) { report.failedStage = error.stage; report.evidence = error.evidence; }
  } finally {
    try { await context?.close(); report.drained = context !== undefined; }
    catch (error) { report.result = "failed"; report.errors.push(String(error instanceof Error ? error.message : error).replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]")); }
    if (context) report.diagnostics = context.counters();
    checkpoint(); closeSync(fd);
  }
  console.log(json({ result: report.result, samples: report.samples?.length ?? 0, out: args.get("--out") }));
  if (report.result !== "pass") process.exitCode = 1;
}

// Kept separate for synchronous append-safe report checkpoints.
function requireWrite(fd: number, data: Buffer) { let offset = 0; while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset, offset); }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  protocolJsonAcceptanceMain().catch(error => { console.error(String(error).replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]")); process.exitCode = 1; });
