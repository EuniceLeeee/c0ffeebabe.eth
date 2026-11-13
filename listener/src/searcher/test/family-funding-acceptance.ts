import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Interface, MaxUint256, ZeroAddress, getAddress, isHexString } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../adapters/runtime-amount-program.js";
import { concatBytes } from "../../encoder.js";
import type { ResolvedPlanNode } from "../../types.js";
import { buildSubscriptCalldata } from "../../shared/executor/botvm-program-entry.js";
import { executeAdapterWork, type CentralAdapterRuntime } from "../adapter-work-intent.js";
import { executeFundingFamilyLiquidity, buildFundingBorrowFragment, buildFundingRepaymentFragment } from "../adapter-funding-runtime.js";
import { planFragmentNodes } from "../solver/plan-fragment-requirements.js";
import { createBoundedRequestExecutor, physicalAdapterRequestFingerprint, type AdapterRequest, type AdapterRequestResult, type CanonicalSource } from "../venues/adapter-request-program.js";
import { hashCanonical } from "../venues/canonical-value.js";
import type { FundingOfferDescriptor } from "../venues/adapter-family-plugin.js";
import type { LoadedFamilyBox } from "../venues/family-capability-catalog.js";
import type { PlanFragment } from "../venues/route-leg-adapter.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../venues/production-infra-actions.js";
import type { openFamilyAcceptanceRuntimeContext } from "./protocol-json-acceptance-context.js";
import { assertFundingReadyPublication, assertFundingRuntimeReady } from "./family-funding-acceptance-context.js";

export interface FundingAcceptanceCase {
  readonly version: 1; readonly domain: "funding"; readonly id: string;
  readonly familyId: string; readonly instanceKey: string; readonly lineageId: string;
  readonly source: { readonly number: number; readonly hash: string };
  readonly executor: string; readonly owner: string; readonly transactionHash?: string;
  readonly token: string; readonly amountIn: string;
}
export type FundingAcceptanceContext = Awaited<ReturnType<typeof openFamilyAcceptanceRuntimeContext>>;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const erc20 = new Interface(["function balanceOf(address) view returns(uint256)", "event Transfer(address indexed from,address indexed to,uint256 value)"]);
const effects = ["return-data", "revert-data", "token-delta", "native-delta", "logs"] as const;
const probes = ["positive", "no-input", "forced-revert"] as const;
type Probe = typeof probes[number];
const safeError = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
const uint = (value: unknown): bigint => {
  assert(typeof value === "bigint" && value >= 0n && value <= MaxUint256, "uint256 evidence required"); return value;
};

export function parseFundingAcceptanceCase(raw: unknown): FundingAcceptanceCase {
  assert(raw && typeof raw === "object" && !Array.isArray(raw));
  const row = raw as Record<string, any>, keys = ["version", "domain", "id", "familyId", "instanceKey", "lineageId", "source", "executor", "owner", "token", "amountIn"];
  assert(keys.every(key => Object.hasOwn(row, key)) && Object.keys(row).every(key => keys.includes(key) || key === "transactionHash"), "invalid Funding case fields");
  assert.equal(row.version, 1); assert.equal(row.domain, "funding");
  for (const key of ["id", "familyId", "instanceKey", "lineageId"]) assert(typeof row[key] === "string" && row[key].length > 0 && row[key].trim() === row[key]);
  assert(row.source && Object.keys(row.source).sort().join(",") === "hash,number" && Number.isSafeInteger(row.source.number) && row.source.number >= 0 && isHexString(row.source.hash, 32));
  assert(typeof row.amountIn === "string" && /^[1-9][0-9]*$/.test(row.amountIn) && BigInt(row.amountIn) <= MaxUint256);
  const [executor, owner, token] = [row.executor, row.owner, row.token].map(value => getAddress(value));
  assert(![executor, owner, token].includes(ZeroAddress) && executor !== owner);
  if (row.transactionHash !== undefined) assert(isHexString(row.transactionHash, 32));
  return Object.freeze({ ...row, executor, owner, token, source: Object.freeze({ ...row.source }) }) as FundingAcceptanceCase;
}

/** Record actual scheduler-issued reads without replacing their transport or Family decoder. */
function recordingRuntime(runtime: CentralAdapterRuntime, records: any[]): CentralAdapterRuntime {
  return { ...runtime, scheduler: { issueExecutor(input) {
    const issued = runtime.scheduler.issueExecutor(input), original = issued.executor;
    const executor = createBoundedRequestExecutor({
      assertSupported: value => original.assertSupported(value),
      assertCallerBinding: value => original.assertCallerBinding(value),
      assertWithinBudget: (family, requests) => original.assertWithinBudget(family, requests),
      sealStaticEvidenceReuseProof: value => original.sealStaticEvidenceReuseProof(value),
      async execute(value) {
        const results = await original.execute(value);
        records.push({ source: value.source, requests: value.requests, results, callerAuthority: input.callerAuthority });
        return results;
      },
    });
    return { executor, timing: () => issued.timing() };
  } } };
}

function fundingPlugin(family: LoadedFamilyBox) {
  assert.equal(family.plugin.manifest.domain, "funding");
  assert("funding" in family.plugin); return family.plugin;
}
function descriptor(offer: FundingOfferDescriptor): FundingOfferDescriptor {
  for (const value of [offer.maxBorrow, offer.fee]) uint(value);
  assert(typeof offer.fundingId === "string" && offer.fundingId.length > 0);
  getAddress(offer.asset);
  return { fundingId: offer.fundingId, asset: offer.asset, maxBorrow: offer.maxBorrow, fee: offer.fee,
    actionAdapterId: offer.actionAdapterId, planningPriority: offer.planningPriority, liquidityPriority: offer.liquidityPriority };
}

/** The callback independently measures borrowed principal above the pre-call balance. */
export function buildFundingCallbackGuard(token: string, executor: string, baseline: bigint, amount: bigint): Uint8Array {
  uint(baseline); uint(amount); assert(amount > 0n && baseline + amount <= MaxUint256);
  return runtimeProgramScript(new RuntimeAmountProgram()
    .call(token, erc20.encodeFunctionData("balanceOf", [executor]), { static: true }).load(0, 0)
    .constant(1, baseline).math("sub", 0, 0, 1).constant(1, amount).equal(0, 1).bytes());
}

function compileFundingPrograms(family: LoadedFamilyBox, sample: FundingAcceptanceCase, baseline: bigint,
  borrow: PlanFragment, repayment: PlanFragment) {
  const amount = BigInt(sample.amountIn), adapters = [...family.plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
  assert.equal(borrow.nodes.length, 1, "Funding acceptance requires one callback wrapper");
  const root = borrow.nodes[0]!;
  assert(family.plugin.manifest.ownedActionAdapterIds.includes(root.adapterId), "Funding root is not family-owned");
  const guard = buildFundingCallbackGuard(sample.token, sample.executor, baseline, amount);
  const encode = (node: ResolvedPlanNode): Uint8Array => {
    const action = adapters.find(adapter => adapter.id === node.adapterId); assert(action, "unowned Funding action");
    if (node === root) assert(action.isWrapper, "Funding root must execute callback children");
    return action.encode(node, sample.executor, concatBytes(...(node === root ? [guard] : []), ...node.children.map(encode)));
  };
  const positive = concatBytes(...planFragmentNodes(borrow, sample.token, amount).map(encode));
  return {
    positive,
    "no-input": concatBytes(guard, ...planFragmentNodes(repayment, sample.token, amount).map(encode)),
    "forced-revert": concatBytes(positive, runtimeProgramScript(new RuntimeAmountProgram().constant(0, 0n).constant(1, 1n).equal(0, 1).bytes())),
  };
}

function executionRequest(sample: FundingAcceptanceCase, lender: string, probe: Probe, script: Uint8Array): AdapterRequest {
  const caller = { kind: "executor" as const };
  return { id: `${sample.id}-${probe}`, kind: "effect-delta-simulation", required: false,
    call: { caller, executionMode: "executor-program", to: sample.executor, data: buildSubscriptCalldata(script) },
    // No token input overlay: the measured callback principal must come from the lender.
    overrideIntent: { caller, nativeBalanceWei: 17n }, observe: effects,
    observeTokenBalances: [sample.executor, lender].map(account => ({ token: sample.token, account })) };
}

function commonFacts(input: { sample: FundingAcceptanceCase; source: CanonicalSource; result: AdapterRequestResult; requestId: string }, completion: string) {
  const { sample, source, result } = input, violations: string[] = [];
  const require = (ok: unknown, reason: string) => { if (!ok) violations.push(reason); };
  require(result?.id === input.requestId, "request-id");
  require(result?.source?.number === source.number && result?.source?.hash?.toLowerCase() === source.hash.toLowerCase() && result?.source?.generation === source.generation, "source");
  require(result?.ok === true && result.completion === completion, "completion");
  if (result?.ok) {
    require(result.provenance?.kind === "strict-simulation-transport" && !!result.provenance.fingerprint, "provenance");
    require(isHexString(result.data, true), "result-data");
  }
  const observed = result?.ok ? result.effects : undefined;
  require(Array.isArray(observed?.tokenDeltas) && Array.isArray(observed?.nativeDeltas) && Array.isArray(observed?.logs), "missing-effects");
  const balances = new Map<string, bigint>();
  for (const row of observed?.tokenDeltas ?? []) {
    const key = `${row.token.toLowerCase()}:${row.account.toLowerCase()}`;
    require(!balances.has(key) && typeof row.delta === "bigint", "duplicate-or-invalid-token-delta"); balances.set(key, row.delta);
  }
  const native = new Set<string>();
  for (const row of observed?.nativeDeltas ?? []) {
    require(!native.has(row.account.toLowerCase()) && row.delta === 0n, "native-inventory"); native.add(row.account.toLowerCase());
  }
  for (const row of observed?.totalSupplyDeltas ?? []) require(row.delta === 0n, "token-supply");
  return { require, violations, observed, balances, native,
    balance(account: string) { return balances.get(`${sample.token.toLowerCase()}:${account.toLowerCase()}`); } };
}

export function checkFundingPositiveFacts(input: { sample: FundingAcceptanceCase; source: CanonicalSource;
  result: AdapterRequestResult; requestId: string; lender: string; fee: bigint }) {
  uint(input.fee);
  const f = commonFacts(input, "returned"), amount = BigInt(input.sample.amountIn);
  f.require(f.balance(input.sample.executor) === -input.fee, "borrower-fee-debit");
  f.require(f.balance(input.lender) === input.fee, "lender-fee-credit");
  f.require(f.balances.size === 2 && f.native.has(input.sample.executor.toLowerCase()), "complete-balance-observations");
  const transfers: { from: string; to: string; amount: bigint }[] = [];
  for (const log of f.observed?.logs ?? []) if (same(log.address, input.sample.token) && same(log.topics[0] ?? "", erc20.getEvent("Transfer")!.topicHash)) {
    try {
      const decoded = erc20.parseLog(log); assert(decoded);
      transfers.push({ from: getAddress(decoded.args[0]), to: getAddress(decoded.args[1]), amount: BigInt(decoded.args[2]) });
    } catch { f.require(false, "malformed-transfer"); }
  }
  const borrowed = transfers.filter(row => same(row.from, input.lender) && same(row.to, input.sample.executor)).reduce((n, row) => n + row.amount, 0n);
  const repaid = transfers.filter(row => same(row.from, input.sample.executor) && same(row.to, input.lender)).reduce((n, row) => n + row.amount, 0n);
  f.require(borrowed === amount, "principal-received"); f.require(repaid === amount + input.fee, "principal-and-fee-repaid");
  return { passed: f.violations.length === 0, violations: f.violations, observed: { requestedInput: String(amount),
    quotedOutput: String(amount), actualDebit: String(repaid), actualCredit: String(borrowed), outputDifference: String(borrowed - amount),
    fee: String(input.fee), borrowerNetDelta: f.balance(input.sample.executor)?.toString() ?? null,
    lenderNetDelta: f.balance(input.lender)?.toString() ?? null } };
}

export function checkFundingRevertFacts(input: { sample: FundingAcceptanceCase; source: CanonicalSource; result: AdapterRequestResult; requestId: string }) {
  const f = commonFacts(input, "reverted-as-declared");
  for (const row of f.observed?.tokenDeltas ?? []) f.require(row.delta === 0n, "rollback-token-inventory");
  f.require(f.observed?.logs?.length === 0, "rollback-logs");
  return { passed: f.violations.length === 0, violations: f.violations, observed: { rollback: f.violations.length === 0 } };
}

export async function runFamilyFundingAcceptance(raw: FundingAcceptanceCase, context: FundingAcceptanceContext,
  report: Record<string, any>, checkpoint: () => void = () => {}) {
  const sample = parseFundingAcceptanceCase(raw), { family, source, executor, owner, control } = context;
  assert.equal(sample.familyId, family.plugin.manifest.familyId); assert.equal(source.number, sample.source.number);
  assert(same(source.hash, sample.source.hash) && same(executor, sample.executor) && same(owner, sample.owner), "Funding case source/actors mismatch");
  const discovery = assertFundingRuntimeReady(context, sample), plugin = fundingPlugin(family);
  const lender = getAddress(plugin.funding.repayment.liquidityHolder); assert(!same(executor, lender), "borrower and lender must differ");
  Object.assign(report, { format: "family-funding-acceptance-v1", sample, source, evidence: context.evidence,
    discovery, result: "failed", executions: [], liquidityEvidence: [] }); checkpoint();
  let stage = "exact";
  try {
  const runtime = recordingRuntime(context.runtime, report.liquidityEvidence);
  const liquidity = await executeFundingFamilyLiquidity({ family, assets: [sample.token], source,
    generation: source.generation, runtime, control, publisher: { publish() {} } });
  report.liquidity = liquidity;
  const offers = liquidity.offers.filter(offer => offer.fundingId === sample.instanceKey && same(offer.asset, sample.token));
  assert.equal(offers.length, 1, "Funding case requires one issued current offer");
  const offer = offers[0]!, amount = BigInt(sample.amountIn);
  assert(amount <= offer.maxBorrow && offer.maxBorrow > 0n, "Funding capacity does not cover input");
  report.offer = descriptor(offer); report.quote = { amountIn: amount, amountOut: amount, fee: offer.fee };
  stage = "quotedExecution"; checkpoint();
  const dispatch = async (request: AdapterRequest, simulated: boolean) => {
    const result = await executeAdapterWork({ runtime: context.runtime, control, intent: {
      stage: "exact-refine", familyId: family.plugin.manifest.familyId, source, generation: source.generation,
      programInput: undefined, program: {
        requirements: () => simulated ? { transports: ["effect-delta-simulation"], caller: "executor", effects } : { transports: ["eth-call"] },
        buildRequests: () => [request], decode: ({ results }) => results,
      },
    } });
    assert.equal(result.status, "resolved", "Funding transport is not a protocol rejection");
    if (result.status !== "resolved") throw new Error("Funding transport unavailable");
    assert.equal(result.executed.evidence.length, 1); return result.executed.evidence[0]!;
  };
  const balanceRequest: AdapterRequest = { id: `${sample.id}-baseline`, kind: "eth-call", to: sample.token,
    data: erc20.encodeFunctionData("balanceOf", [executor]), completion: "return-data" };
  const balanceResult = await dispatch(balanceRequest, false); report.baseline = { request: balanceRequest, result: balanceResult };
  assert(balanceResult.ok && balanceResult.completion === "returned");
  const baseline = uint(BigInt(erc20.decodeFunctionResult("balanceOf", balanceResult.data)[0]));
  assert(baseline >= offer.fee, "executor does not own the required fee balance");
  const args = { family, offer, source, generation: source.generation, amount };
  const borrow = buildFundingBorrowFragment({ ...args, minProfit: 0n, children: [] });
  const repayment = buildFundingRepaymentFragment(args);
  const programs = compileFundingPrograms(family, sample, baseline, borrow, repayment);
  for (const probe of probes) {
    const request = executionRequest(sample, lender, probe, programs[probe]);
    const row: Record<string, any> = { probe, encoding: "funding", result: "failed", request, scriptSha256: hash(programs[probe]) };
    report.executions.push(row); checkpoint();
    try {
      row.resultEvidence = await dispatch(request, true);
      row.facts = probe === "positive" ? checkFundingPositiveFacts({ sample, source, lender, fee: offer.fee,
        requestId: request.id, result: row.resultEvidence }) : checkFundingRevertFacts({ sample, source, requestId: request.id, result: row.resultEvidence });
      assert(row.facts.passed, JSON.stringify(row.facts)); row.result = "pass";
    } catch (error) { row.error = safeError(error); }
    checkpoint();
  }
  report.result = report.executions.length === probes.length && report.executions.every((row: any) => row.result === "pass") ? "pass" : "failed";
  if (report.result === "pass") verifyFundingAcceptanceReport(sample, report, family);
  } catch (error) { report.result = "failed"; report.failure = { stage, reason: safeError(error) }; }
  checkpoint(); return report;
}

/** Recompute data and program bytes from actual recorded reads and current pure Family builders.
 * A serialized offer is a projection, and is never cast to PreparedFundingOffer. */
export function verifyFundingAcceptanceReport(raw: FundingAcceptanceCase, report: any, family: LoadedFamilyBox): void {
  const sample = parseFundingAcceptanceCase(raw), plugin = fundingPlugin(family), source: CanonicalSource = report.source;
  assert.deepEqual(report.sample, sample); assert.equal(family.plugin.manifest.familyId, sample.familyId);
  assert(source.number === sample.source.number && same(source.hash, sample.source.hash) && Number.isSafeInteger(source.generation));
  assert(same(report.evidence.actors.executor, sample.executor) && same(report.evidence.actors.owner, sample.owner), "Funding evidence actor mismatch");
  assert(isHexString(report.evidence.executorCodeHash, 32), "Funding executor code binding is missing");
  const discovery = assertFundingReadyPublication(family, report.discovery.memo, source, sample);
  for (const [key, value] of Object.entries(discovery)) assert.deepEqual(report.discovery[key], value, "Funding discovery projection changed");
  const sources = plugin.funding.liquidity.sources([sample.token]).filter(row => row.fundingId === sample.instanceKey);
  assert.equal(sources.length, 1);
  const programInput = { assets: [sample.token], sources, source };
  const expectedRequests = plugin.funding.liquidity.program.buildRequests(programInput);
  assert.equal(report.liquidityEvidence.length, 1, "Funding quote must retain its actual read round");
  const round = report.liquidityEvidence[0]; assert.deepEqual(round.source, source); assert.deepEqual(round.requests, expectedRequests);
  assert.equal(round.results.length, expectedRequests.length);
  for (let i = 0; i < round.results.length; i++) {
    const row = round.results[i]; assert.equal(row.id, expectedRequests[i]!.id); assert.deepEqual(row.source, source);
    assert(row.ok && row.completion === "returned" && row.provenance?.fingerprint, "Funding quote lacks completed source-bound reads");
  }
  const derived = plugin.funding.liquidity.deriveOffers({ sources,
    evidence: plugin.funding.liquidity.program.decode({ programInput, results: round.results }) }).filter(offer => offer.fundingId === sample.instanceKey && same(offer.asset, sample.token));
  assert.equal(derived.length, 1); const offer = descriptor(derived[0]!); assert.deepEqual(report.offer, offer);
  const amount = BigInt(sample.amountIn); assert(amount <= offer.maxBorrow && amount > 0n);
  assert.deepEqual(report.quote, { amountIn: amount, amountOut: amount, fee: offer.fee });
  const baseline = report.baseline;
  assert.deepEqual(baseline.request, { id: `${sample.id}-baseline`, kind: "eth-call", to: sample.token,
    data: erc20.encodeFunctionData("balanceOf", [sample.executor]), completion: "return-data" });
  assert.equal(baseline.result.id, baseline.request.id); assert.deepEqual(baseline.result.source, source);
  assert(baseline.result.ok && baseline.result.completion === "returned" && baseline.result.provenance?.fingerprint);
  const initial = uint(BigInt(erc20.decodeFunctionResult("balanceOf", baseline.result.data)[0])); assert(initial >= offer.fee);
  const borrow = plugin.funding.repayment.buildBorrowFragment({ offer, amount, minProfit: 0n, children: [] });
  const repayment = plugin.funding.repayment.buildRepaymentFragment({ offer, amount });
  const programs = compileFundingPrograms(family, sample, initial, borrow, repayment), lender = getAddress(plugin.funding.repayment.liquidityHolder);
  assert(!same(lender, sample.executor)); assert.equal(report.executions.length, probes.length);
  for (const probe of probes) {
    const rows = report.executions.filter((row: any) => row.probe === probe); assert.equal(rows.length, 1);
    const row = rows[0]; assert.equal(row.scriptSha256, hash(programs[probe]));
    assert.deepEqual(row.request, executionRequest(sample, lender, probe, programs[probe]), "Funding script/baseline/actors or input preparation changed");
    assert(row.resultEvidence.completion === "returned" || row.resultEvidence.completion === "reverted-as-declared",
      "Funding simulation did not complete");
    assert.deepEqual(row.resultEvidence.provenance, { kind: "strict-simulation-transport", fingerprint: hashCanonical({
      id: row.request.id, requestFingerprint: physicalAdapterRequestFingerprint(row.request),
      executorProgramCodeHash: report.evidence.executorCodeHash,
      callerAddresses: [sample.executor.toLowerCase(), sample.executor.toLowerCase()], transactionOrigin: sample.owner.toLowerCase(),
      // Authenticate what the transport observed, then check below whether
      // that outcome satisfies the probe. A real revert is not a bad hash.
      completion: row.resultEvidence.completion,
      source: { number: source.number, hash: source.hash.toLowerCase(), generation: source.generation },
    }) }, "Funding result provenance is not bound to its program/source/actors");
    const facts = probe === "positive" ? checkFundingPositiveFacts({ sample, source, result: row.resultEvidence, requestId: row.request.id, lender, fee: offer.fee })
      : checkFundingRevertFacts({ sample, source, result: row.resultEvidence, requestId: row.request.id });
    assert(facts.passed, JSON.stringify(facts)); assert.equal(row.result, "pass"); assert.deepEqual(row.facts, facts);
  }
  assert.equal(report.result, "pass");
}

/** Human-readable stages retain raw principal, repayment and fee, including failures. */
export function fundingAcceptanceStages(sample: FundingAcceptanceCase, report: any) {
  const positive = report.executions?.find((row: any) => row.probe === "positive");
  const controls = Object.fromEntries(probes.map(probe => [probe === "no-input" ? "noInput" : probe === "forced-revert" ? "forcedRevert" : probe,
    report.executions?.find((row: any) => row.probe === probe)?.result ?? "not-run"]));
  const observed = positive?.facts?.observed, passed = report.result === "pass";
  return {
    discoveryCheckpoint: { status: report.discovery ? "pass" : "failed", kind: "funding-token-publication",
      familyId: sample.familyId, instanceKey: sample.instanceKey, lineageId: sample.lineageId, token: sample.token },
    exact: { status: report.quote ? "pass" : report.failure?.stage === "exact" ? "failed" : "not-run", kind: "current-funding-offer", tokenIn: sample.token, tokenOut: sample.token,
      requestedAmountIn: sample.amountIn, quotedAmountIn: report.quote?.amountIn?.toString() ?? null,
      quotedAmountOut: report.quote?.amountOut?.toString() ?? null, fee: report.quote?.fee?.toString() ?? null,
      ...(report.failure?.stage === "exact" ? { reason: report.failure.reason } : {}) },
    quotedExecution: { status: report.executions?.length ? passed ? "pass" : "failed" : report.failure?.stage === "quotedExecution" ? "failed" : "not-run", required: true, kind: "funding-callback",
      actualBorrowed: observed?.actualCredit ?? null, actualRepaid: observed?.actualDebit ?? null,
      fee: observed?.fee ?? null, differenceFromExact: observed?.outputDifference ?? null, controls,
      failures: (report.executions ?? []).filter((row: any) => row.result !== "pass").map((row: any) => ({ probe: row.probe, reason: row.error ?? "execution evidence incomplete" })),
      ...(report.failure?.stage === "quotedExecution" ? { reason: report.failure.reason } : {}) },
    runtimeExecution: { status: "not-declared", required: false, kind: "funding-callback" },
    simulationOutputParity: { status: passed ? "pass" : "failed", toleranceRawUnits: 0,
      quotedDifference: observed?.outputDifference ?? null },
  };
}
