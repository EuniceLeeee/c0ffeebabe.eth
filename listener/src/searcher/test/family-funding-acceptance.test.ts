import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { selectorNativeFundingFamilyId, selectorNativeFundingCandidateFromCensus, normalizeSelectorNativeFundingDefinition } from "../venues/selector-native-funding-definition.js";
import { readySelectorCensusFromTransaction } from "../ready-selector-census.js";
import test from "node:test";
import { AbiCoder, Interface, getAddress, getBytes, hexlify, toBeHex, zeroPadValue } from "ethers";
import { executeFundingFamilyLiquidity } from "../adapter-funding-runtime.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../venues/production-family-composition.js";
import { candidatesFromCall, createProbeWiring, rebuildFamilyCandidateKey } from "../universe-rebuild-production.js";
import { assertDurableVerifiedMemoFingerprint } from "../universe-rebuild-checkpoint.js";
import { assertFundingReadyPublication } from "./family-funding-acceptance-context.js";
import { parseFundingAcceptanceCase, runFamilyFundingAcceptance, verifyFundingAcceptanceReport, fundingAcceptanceStages } from "./family-funding-acceptance.js";
import { inspectRuntime } from "./runtime-program-testkit.js";
import { buildSubscriptCalldata } from "../../shared/executor/botvm-program-entry.js";

const token = getAddress(toBeHex(41, 20)), executor = getAddress(toBeHex(42, 20)), owner = getAddress(toBeHex(43, 20));
const source = { number: 25_800_000, hash: toBeHex(17, 32), generation: 2 };
const erc20 = new Interface(["function balanceOf(address) view returns(uint256)", "function approve(address,uint256)",
  "function transfer(address,uint256)", "event Transfer(address indexed from,address indexed to,uint256 value)"]);
const morpho = new Interface(["function flashLoan(address,uint256,bytes)"]);
const balancer = new Interface(["function flashLoan(address,address[],uint256[],bytes)"]);
const coder = AbiCoder.defaultAbiCoder(), sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Actual installed issuers/encoders, with a small deterministic host instead of RPC/EVM.
 * This proves harness wiring and negative controls; it is not chain acceptance. */
async function fixture(selector = "e0232b42", options: { noPrincipal?: boolean; missingTransfer?: boolean; shortRepayment?: boolean } = {}) {
  const definition=normalizeSelectorNativeFundingDefinition(JSON.parse(readFileSync(new URL(`../venues/selector-native/selector-${selector}-family/selector-${selector}.json`,import.meta.url),"utf8")));
  const familyId=selectorNativeFundingFamilyId(definition),family = catalog.forStrictFamily(familyId); assert("funding" in family.plugin);
  const plugin = family.plugin, funding = plugin.funding, lender = getAddress(toBeHex(44,20));
  const binding={chainId:1,provider:lender,asset:token,selector:definition.selector,signature:definition.signature};
  const [selected] = funding.liquidity.sources([token],[binding]); assert(selected);
  const sample = parseFundingAcceptanceCase({ version: 1, domain: "funding", id: "offline-funding", familyId,
    instanceKey: selected.instanceKey, fundingId:selected.fundingId, lineageId: plugin.manifest.supportedLineages[0], source: { number: source.number, hash: source.hash },
    executor, owner, token, amountIn: "100" });
  const calls: { probe: string; callbackGuard: boolean; borrowed: bigint; repaid: bigint }[] = [];
  const runtime = createStrictCentralAdapterRuntime({ executor, transactionOrigin: owner,
    generationFence: { assertCurrent(generation, current) { assert.equal(generation, source.generation); assert.deepEqual(current, source); } },
    provider: { async getCode() { throw new Error("unexpected getCode"); }, async getStorage() { throw new Error("unexpected getStorage"); },
      async call(tx, block) {
        assert.equal(block ?? tx.blockTag, source.number);
        if(getAddress(tx.to)===lender){const abi=new Interface(["function getProtocolFeesCollector() view returns(address)","function getFlashLoanFeePercentage() view returns(uint256)"]);const call=abi.parseTransaction(tx);assert(call);return abi.encodeFunctionResult(call.name,[call.name==="getProtocolFeesCollector"?lender:0n]);}
        assert.equal(getAddress(tx.to), token);const call = erc20.parseTransaction(tx); assert.equal(call?.name, "balanceOf");
        return erc20.encodeFunctionResult("balanceOf", [getAddress(call!.args[0]) === lender ? 10_000n : 7n]);
      } },
    simulator: { executorProgramCodeHash: toBeHex(777, 32), async simulate({ request, source: current }) {
      assert.deepEqual(current, source); assert.equal(request.kind, "effect-delta-simulation");
      assert.equal(request.call.executionMode, "executor-program"); assert.equal(getAddress(request.call.to), executor);
      assert.equal(request.overrideIntent?.tokenBalances, undefined, "principal must not be manufactured as an input overlay");
      const row = { probe: request.id, callbackGuard: false, borrowed: 0n, repaid: 0n }; calls.push(row);
      let balance = 7n, lenderBalance = 10_000n, allowance = 0n;
      const logs: any[] = [], transfer = (from: string, to: string, amount: bigint) => {
        if (from === lender) { lenderBalance -= amount; balance += amount; row.borrowed += amount; }
        else { assert(balance >= amount); balance -= amount; lenderBalance += amount; row.repaid += amount; }
        const event = erc20.encodeEventLog(erc20.getEvent("Transfer")!, [from, to, amount]);
        if (!options.missingTransfer) logs.push({ address: token, ...event });
      };
      const loanCall = (data:string) => {
        const loan=(funding.repayment.mode==="approve-pull"?morpho:balancer).parseTransaction({data});assert(loan);
        const amount=BigInt(funding.repayment.mode==="approve-pull"?loan.args[1]:loan.args[2][0]);
        const child=getBytes(funding.repayment.mode==="approve-pull"?loan.args[2]:loan.args[3]);
        const cb=new Interface([definition.execution.callback.signature]);
        const calldata=cb.encodeFunctionData(cb.fragments[0] as any,funding.repayment.mode==="approve-pull"?[amount,child]:[[token],[amount],[0n],child]);
        if(!options.noPrincipal)transfer(lender,executor,amount);run(child,calldata);
        if(funding.repayment.mode==="approve-pull"){assert(allowance>=amount);transfer(executor,lender,options.shortRepayment?amount-1n:amount);}
      };
      const run = (script: Uint8Array, callback?:string) => {
        let offset = 0;
        const take = (size: number) => { const result = script.slice(offset, offset + size); assert.equal(result.length, size); offset += size; return result; };
        const number = (size: number) => Number(BigInt(hexlify(take(size))));
        while (offset < script.length) {
          const opcode = number(1);
          if (opcode === 2) { number(3); continue; }
          if (opcode === 5) continue;
          if (opcode === 8) { assert.equal(getAddress(hexlify(take(20))), token); assert(balance >= BigInt(hexlify(take(32)))); continue; }
          if (opcode === 10) {
            assert.equal(getAddress(hexlify(take(20))), token); assert.equal(getAddress(hexlify(take(20))), lender);
            const minimum = BigInt(hexlify(take(32))), ceiling = BigInt(hexlify(take(32)));
            if (allowance < minimum) allowance = ceiling;
            assert(allowance >= minimum); continue;
          }
          if (opcode === 14) {
            const amount = BigInt(hexlify(take(32))), program = hexlify(take(number(3)));
            inspectRuntime(program, amount, { calldata:callback,call(call) {
              if(getAddress(call.target)===lender){loanCall(call.data);return "0x";}
              assert.equal(getAddress(call.target), token); const decoded = erc20.parseTransaction({ data: call.data });
              assert.equal(decoded?.name, "balanceOf"); assert.equal(getAddress(decoded!.args[0]), executor);
              if (callback) row.callbackGuard = true;
              return erc20.encodeFunctionResult("balanceOf", [balance]);
            } }, { output: true }); continue;
          }
          assert.equal(opcode, 0, "fixture received an unknown production opcode");
          const target = getAddress(hexlify(take(20))), data = hexlify(take(number(3)));
          if (target === lender) { loanCall(data);
          } else {
            assert.equal(target, token); const call = erc20.parseTransaction({ data }); assert(call);
            assert.equal(getAddress(call.args[0]), lender);
            if (call.name === "approve") allowance = BigInt(call.args[1]);
            else { assert.equal(call.name, "transfer"); transfer(executor, lender, options.shortRepayment ? BigInt(call.args[1]) - 1n : BigInt(call.args[1])); }
          }
        }
      };
      try { run(getBytes(coder.decode(["bytes"], `0x${request.call.data.slice(10)}`)[0])); }
      catch (error) { Object.assign(row, { error: String(error) }); throw Object.assign(new Error(String(error)), { code: "CALL_EXCEPTION", data: "0x" }); }
      return { data: "0x", effects: { tokenDeltas: [{ token, account: executor, delta: balance - 7n },
        { token, account: lender, delta: lenderBalance - 10_000n }], nativeDeltas: [{ account: executor, delta: 0n }], logs } };
    } },
  });
  const published = await executeFundingFamilyLiquidity({ family, assets: [token], bindings:[binding], source, generation: source.generation, runtime, publisher: { publish() {} } });
  const offer = published.offers[0]; assert(offer);
  const census=readySelectorCensusFromTransaction({chain_id:1,tx_hash:toBeHex(71,32),block_number:source.number,block_hash:source.hash,receipt_status:1,from:executor,to:lender,
    input:(funding.repayment.mode==="approve-pull"?morpho:balancer).encodeFunctionData("flashLoan",funding.repayment.mode==="approve-pull"?[token,100n,"0x"]:[executor,[token],[100n],"0x"]),logs:[],traces:[]});
  const decoded=selectorNativeFundingCandidateFromCensus(definition,census,census.calls[0]!.id);assert(decoded);
  const [candidate]=candidatesFromCall({kind:"call",target:lender,sender:executor,data:census.calls[0]!.calldata!,transactionHash:census.transactionHash!,blockNumber:source.number,blockHash:source.hash,traceAddress:[],opaque:{selectorCensus:census,callId:census.calls[0]!.id} as any},[familyId]);assert(candidate);

  const probe = createProbeWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: [familyId] });
  const memo = probe.sealDurableVerifiedMemo({ candidate, familyCandidateKey: rebuildFamilyCandidateKey(candidate), proofSource: source,
    result: { domain: "funding", familyId, asset: token, instanceKey:selected.instanceKey,bindings:[offer.binding],fundingId: offer.fundingId, evidenceRefs: offer.evidenceRefs,
      authorityFingerprint: "offline-production-issuer-fixture" } });
  assertDurableVerifiedMemoFingerprint(memo);
  const context = { family, catalog, source, executor, owner, runtime, memo, ready: { cutoff: source, graphHash: "offline", catalogHash: "offline" },
    evidence: { actors: { executor, owner }, executorCodeHash: toBeHex(777, 32), kind: "offline-fixture-not-chain-evidence" }, control: { signal: new AbortController().signal, deadlineAtMs: Date.now() + 20_000 } } as any;
  const report: any = {}; await runFamilyFundingAcceptance(sample, context, report);
  return { family, sample, context, report, calls };
}

test("both installed Funding issuers and encoders prove callback principal plus actual repayment and controls", async () => {
  for (const family of ["e0232b42", "5c38449e"]) {
    const f = await fixture(family);
    assert.equal(f.report.result, "pass", JSON.stringify(f.calls, (_key, value) => typeof value === "bigint" ? String(value) : value));
    assert.equal(f.calls.length, 3); assert(f.calls[0]!.callbackGuard); assert(f.calls[2]!.callbackGuard);
    assert.deepEqual([f.calls[0]!.borrowed, f.calls[0]!.repaid], [100n, 100n]);
    assert.deepEqual([f.calls[1]!.borrowed, f.calls[1]!.repaid], [0n, 0n]);
    assert.deepEqual([f.calls[2]!.borrowed, f.calls[2]!.repaid], [100n, 100n]);
    verifyFundingAcceptanceReport(f.sample, f.report, f.family);
    const stages = fundingAcceptanceStages(f.sample, f.report);
    assert.equal(stages.quotedExecution.actualBorrowed, "100"); assert.equal(stages.quotedExecution.actualRepaid, "100");
    assert.equal(stages.simulationOutputParity.quotedDifference, "0"); assert.equal(stages.runtimeExecution.required, false);
  }
});

test("a zero-fee no-op, absent transfers or a short repayment cannot pass", async () => {
  for (const options of [{ noPrincipal: true }, { missingTransfer: true }, { shortRepayment: true }]) {
    const f = await fixture("e0232b42", options);
    assert.equal(f.report.result, "failed"); assert.throws(() => verifyFundingAcceptanceReport(f.sample, f.report, f.family));
  }
});

test("raw verifier reconstructs offer, baseline, actor, source and callback bytes instead of trusting PASS", async () => {
  const f = await fixture();
  assert.equal(f.report.result, "pass");
  for (const change of [
    (r: any) => { r.evidence.actors.executor = owner; },
    (r: any) => { r.source.hash = toBeHex(22, 32); },
    (r: any) => { r.baseline.result.data = erc20.encodeFunctionResult("balanceOf", [6n]); },
    (r: any) => { r.liquidityEvidence[0].results[0].data = erc20.encodeFunctionResult("balanceOf", [99n]); },
    (r: any) => { r.executions[0].resultEvidence.effects.logs = []; },
    (r: any) => { r.executions[0].request.overrideIntent.tokenBalances = [{ token, amount: 100n }]; },
    (r: any) => { const row = r.executions[0], changed = Uint8Array.of(5);
      row.request.call.data = buildSubscriptCalldata(changed); row.scriptSha256 = sha(changed); },
    (r: any) => { r.executions[0].resultEvidence.provenance.fingerprint = "unrelated-program"; },
    (r: any) => { r.executions[0].resultEvidence.completion = "reverted-as-declared"; },
    (r: any) => { r.discovery.memo.candidateSnapshot.asset = owner; },
  ]) { const report = structuredClone(f.report); change(report); assert.throws(() => verifyFundingAcceptanceReport(f.sample, report, f.family)); }
  for (const key of ["familyId", "instanceKey", "lineageId"] as const)
    assert.throws(() => assertFundingReadyPublication(f.family, f.context.memo, source, { ...f.sample, [key]: "wrong" }));
});

test("a genuine positive revert retains valid provenance but fails execution facts", async () => {
  for (const family of ["e0232b42", "5c38449e"]) {
    const f = await fixture(family, { noPrincipal: true });
    assert.equal(f.report.result, "failed");
    assert.equal(f.report.executions[0].resultEvidence.completion, "reverted-as-declared");
    assert.throws(() => verifyFundingAcceptanceReport(f.sample, f.report, f.family), error =>
      error instanceof Error && error.message.includes('"completion"') && !error.message.includes("provenance"));
  }
});
