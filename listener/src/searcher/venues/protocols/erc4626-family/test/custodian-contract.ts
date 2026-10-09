import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult } from "../../../adapter-request-program.js";
import { RequiredAdapterRequestError } from "../../../adapter-request-failure.js";
import { ERC4626_INTERFACE, ERC4626_PROBE_ACTOR } from "../abi.js";
import { erc4626Identity } from "../identity.js";
import { custodianIdentity } from "../custodian-identity.js";
import { erc4626Instance } from "../instance.js";
import { erc4626Routes } from "../routes.js";
import { erc4626Exact } from "../exact.js";
import { erc4626Pricing } from "../pricing.js";
import { erc4626Execution } from "../execution.js";
import { erc4626RedeemFamilyOwnedAction, erc4626DepositFamilyOwnedAction } from "../action.js";
import { CUSTODIAN_ABI, CUSTODIAN_IMPLEMENTATION_HASH, CUSTODIAN_IMPLEMENTATION_SLOT,
  proveCustodianProxy, CUSTODIAN_TOKEN } from "../custodian.js";
import { custodianRedeemProgram, custodianProgram } from "../custodian-execution.js";
import { CACHED_BYTECODE } from "./custodian-bytecode.js";
import type { Erc4626Descriptor, Erc4626Identity, Erc4626Route } from "../types.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { StrictProductionRuntimeRoot, type StrictProductionRuntimeSession } from "../../../../strict-production-runtime-session.js";
import { StrictCurrentRuntimeCoordinator } from "../../../../strict-current-runtime-coordinator.js";
import { buildEffectiveMids } from "../../../../blockscan-effective-mid.js";
import { detectProductionBlockScanOpportunities } from "../../../../detector/blockscan-scanner-production.js";
import { blockScanEdgeKey, createVerifiedGraphView } from "../../../blockscan-state-capability.js";
import { buildFamilyRouteGraphView } from "../../../../adapter-family-graph-runtime.js";
import { executeAdapterFamilyLifecycleBatch } from "../../../adapter-family-runtime.js";
import { capabilityManifestHash, FAMILY_CAPABILITY_NAMES, FamilyCapabilityCatalog } from "../../../family-capability-catalog.js";
import { definedFamilyPluginContractSummary } from "../../../adapter-family-plugin.js";
import { plugin } from "../../../production-families/erc4626.production.js";
import { ERC4626_FAMILY_ID } from "../manifest.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";

// Only bytecode/provenance is real saved evidence. Every reply/effect below is
// synthetic: no RPC/EVM, strict admission or historical acceptance is claimed.
const vault = "0x4f95c5ba0c7c69fb2f9340e190ccee890b3bd87c";
const implementation = "0x0a2d27a86a2ea07bcc34e457c65aeca7631c0f10";
const share = "0xcacd6fd266af91b8aed52accc382b4e165586e29";
const asset = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const executor = "0x1111111111111111111111111111111111111111";
const proxyAdmin = proveCustodianProxy(CACHED_BYTECODE.proxy).proxyAdmin;
const source = { number: CACHED_BYTECODE.provenance.blockNumber, hash: CACHED_BYTECODE.provenance.blockHash, generation: 1 };
const candidate = { candidateKind: "erc4626-vault" as const, vault };
const word = (n: bigint) => ethers.toBeHex(n, 32);
const lower = (s: string) => s.toLowerCase();
const inventory = 1_000_000n * 10n ** 6n, capacity = inventory * 10n ** 12n;
function returned(id: string, data: string): AdapterRequestResult {
  return { id, ok: true, source, completion: "returned", provenance: { kind: "fixture", fingerprint: "custodian-synthetic-v1" }, data };
}
function replies(requests: readonly AdapterRequest[], target = vault): AdapterRequestResult[] {
  return requests.map(request => {
    if (request.kind === "get-code") return returned(request.id,
      lower(request.address) === lower(target) ? CACHED_BYTECODE.proxy : lower(request.address) === implementation ? CACHED_BYTECODE.implementation :
      lower(request.address) === share ? "0x6001" : "0x6002");
    if (request.kind === "get-storage") { assert.equal(request.slot, CUSTODIAN_IMPLEMENTATION_SLOT); return returned(request.id, word(BigInt(implementation))); }
    assert.equal(request.kind, "eth-call");
    if (request.kind !== "eth-call") throw new Error("fixture only serves reads");
    const isVault = lower(request.to) === lower(target);
    const abi = isVault ? new ethers.Interface([...CUSTODIAN_ABI.fragments, ...ERC4626_INTERFACE.fragments]) : CUSTODIAN_TOKEN;
    const call = abi.parseTransaction({ data: request.data })!;
    let value: readonly unknown[];
    switch (call.name) {
      case "asset": case "custodianTkn": value = [asset]; break;
      case "frxUSD": value = [share]; break;
      case "frxUSDDecimals": value = [18]; break;
      case "custodianTknDecimals": value = [6]; break;
      case "decimals": value = [lower(request.to) === share ? 18 : 6]; break;
      case "mdwrComboView": value = [inventory, capacity, inventory, capacity]; break;
      case "minters": value = [true]; break;
      case "isFrozen": case "isPaused": value = [false]; break;
      case "totalAssets": value = [inventory]; break;
      case "totalSupply": value = [capacity]; break;
      case "previewRedeem": case "convertToAssets": value = [BigInt(call.args[0]) / 10n ** 12n]; break;
      case "previewDeposit": case "convertToShares": value = [BigInt(call.args[0]) * 10n ** 12n]; break;
      default: throw new Error(`unexpected fixture read ${call.name}`);
    }
    return returned(request.id, abi.encodeFunctionResult(call.name, value));
  });
}
function stage(count: number, target = vault) {
  let step: any = { candidate: { ...candidate, vault: target }, step: 0 };
  for (let n = 0; n < count; n++) step = { ...step, step: step.step + 1,
    evidence: custodianIdentity.decode({ step, results: replies(custodianIdentity.buildRequests(step), target) }) };
  return step;
}
function activeReply(proof: any, direction: "deposit" | "redeem" = "redeem"): AdapterRequestResult {
  const sample = proof.samples?.find((s: any) => s.direction === direction) ?? proof, deposit = direction === "deposit";
  const amount = sample.amount, expected = sample.expected;
  const event = ERC4626_INTERFACE.encodeEventLog(ERC4626_INTERFACE.getEvent(deposit ? "Deposit" : "Withdraw")!,
    deposit ? [ERC4626_PROBE_ACTOR, ERC4626_PROBE_ACTOR, amount, expected] :
      [ERC4626_PROBE_ACTOR, ERC4626_PROBE_ACTOR, ERC4626_PROBE_ACTOR, expected, amount]);
  return { ...returned(`custodian-active-${direction}`, word(expected)), ok: true,
    effects: { tokenDeltas: [{ token: share, account: ERC4626_PROBE_ACTOR, delta: deposit ? expected : -amount },
      { token: asset, account: ERC4626_PROBE_ACTOR, delta: deposit ? -amount : expected },
      { token: asset, account: proof.surface.vault, delta: deposit ? amount : -expected }],
    // Production strict observes totalSupply on the call target. This verified
    // implementation forwards that read to frxUSD; token balances stay external.
    totalSupplyDeltas: [{ token: proof.surface.vault, delta: deposit ? expected : -amount }], logs: [{ address: proof.surface.vault, ...event }] } } as AdapterRequestResult;
}
function setup(target = vault, direction: "deposit" | "redeem" = "redeem"): { descriptor: Erc4626Descriptor; route: Erc4626Route; identity: Erc4626Identity } {
  const step = stage(3, target);
  const evidence = custodianIdentity.decode({ step, results: [activeReply(step.evidence, "deposit"), activeReply(step.evidence)] });
  const decision = custodianIdentity.decide({ ...step, evidence });
  assert.equal(decision.status, "verified");
  if (decision.status !== "verified") throw new Error("fixture identity failed");
  const descriptor = erc4626Instance.compileDraft(decision.identity);
  return { descriptor, route: erc4626Routes.project({ descriptor }).find(r => r.direction === direction)!, identity: decision.identity };
}
function quoteInput(amountIn = 215_200_560_000_000_000_000n) {
  return { ...setup(), amountIn, source, executor, runtimeEvidence: [] };
}
function exactProgram(input = quoteInput()) {
  const method = erc4626Exact.methods().find(m => m.kind === "request-program")!;
  if (method.kind !== "request-program") throw new Error("request quote missing");
  return method.program;
}
function decodedQuote(input = quoteInput()) {
  const p = exactProgram(input);
  return p.decode({ programInput: input, initialResults: replies(p.buildRequests(input)), dependentEvidence: [] });
}

test("cached runtime identities authenticate the saved bytecode; targets are not allowlisted", () => {
  assert.equal(ethers.keccak256(CACHED_BYTECODE.implementation), CUSTODIAN_IMPLEMENTATION_HASH);
  assert.equal(proveCustodianProxy(CACHED_BYTECODE.proxy).proxyCodeHash, ethers.keccak256(CACHED_BYTECODE.proxy));
  const changedAdmin = CACHED_BYTECODE.proxy.slice(0, 34) + ethers.zeroPadValue(executor, 32).slice(2) + CACHED_BYTECODE.proxy.slice(98);
  assert.equal(proveCustodianProxy(changedAdmin).proxyAdmin.toLowerCase(), executor);
  assert.throws(() => proveCustodianProxy("0x61" + CACHED_BYTECODE.proxy.slice(4)), /template/);
  for (const target of [vault, "0x2222222222222222222222222222222222222222"]) {
    const { descriptor, route } = setup(target);
    assert.equal(lower(descriptor.share), share); assert.notEqual(lower(descriptor.share), lower(target));
    assert.equal(lower(route.tokenIn), share); assert.equal(lower(route.tokenOut), asset);
    assert.deepEqual(descriptor.verifiedDirections, { deposit: true, redeem: true });
    assert.equal(erc4626Routes.project({ descriptor }).length, 2);
  }
});
test("standard identity keeps index zero and delegates only the reverse-proven Custodian implementation", () => {
  const standard = erc4626Identity.variants[0]!;
  assert.equal(standard.id, "standalone-standard-behavior");
  let step: any = { candidate, step: 0 };
  for (let n = 0; n < 3; n++) {
    const requests = standard.buildRequests(step);
    assert(!requests.some(r => r.kind === "effect-delta-simulation"));
    step = { ...step, step: n + 1, evidence: standard.decode({ step, results: replies(requests) }) };
  }
  assert.equal(standard.decide(step).status, "chain-proven-rejected");
  // Same proxy bytecode is not itself a reason to exclude a standard vault.
  const codeStep: any = { candidate, step: 2, evidence: { ...step.evidence, baseValid: true,
    custodianCheck: "code", custodianImplementation: implementation, custodianCheckSource: source } };
  const normal = standard.decode({ step: codeStep, results: [returned("standard-implementation-code", "0x6000")] }) as any;
  assert(normal.baseValid); assert.equal(normal.custodianCheck, undefined);
  assert(standard.buildRequests({ ...codeStep, evidence: normal }).some(r => r.id === "active-deposit"));
  assert.equal(custodianIdentity.decide({ candidate, step: 1,
    evidence: custodianIdentity.decode({ step: { candidate, step: 0 }, results: [returned("custodian-proxy", "0x6000")] }) }).status, "chain-proven-rejected");
});
test("identity seeds, approves, burns and observes the external frxUSD only", () => {
  const step = stage(3), request = custodianIdentity.buildRequests(step).find(r => r.id === "custodian-active-redeem")!;
  assert.equal(request.kind, "effect-delta-simulation");
  if (request.kind !== "effect-delta-simulation") return;
  assert.equal(lower(request.overrideIntent.tokenBalances![0]!.token), share);
  assert.deepEqual(request.preCalls!.map(c => lower(c.to)), [share, share]);
  assert(request.observeTokenBalances!.every(r => lower(r.token) !== vault));
  const call = CUSTODIAN_ABI.decodeFunctionData("redeem", request.call.data);
  assert.equal(call[1], ERC4626_PROBE_ACTOR); assert.equal(call[2], ERC4626_PROBE_ACTOR);
});
test("identity validates the authenticated supply forwarding target in both directions", () => {
  const step = stage(3);
  for (const direction of ["deposit", "redeem"] as const) {
    const good = activeReply(step.evidence, direction) as any;
    const other = activeReply(step.evidence, direction === "deposit" ? "redeem" : "deposit");
    const supply = good.effects.totalSupplyDeltas[0];
    assert.equal(lower(supply.token), vault);
    const valid = custodianIdentity.decode({ step, results: [good, other] });
    assert.equal(custodianIdentity.decide({ ...step, evidence: valid }).status, "verified");
    for (const supplies of [[], [{ ...supply, token: share }], [{ ...supply, token: asset }],
      [{ ...supply, delta: 0n }], [{ ...supply, delta: -supply.delta }], [supply, supply]]) {
      const bad = { ...good, effects: { ...good.effects, totalSupplyDeltas: supplies } };
      const evidence = custodianIdentity.decode({ step, results: [bad, other] });
      assert.equal(custodianIdentity.decide({ ...step, evidence }).status, "retryable");
    }
  }
});
for (const [id, data, reason] of [["custodian-paused", word(1n), "paused"], ["custodian-minter", word(0n), "minter"],
  ["custodian-actor-frozen", word(1n), "frozen"], ["custodian-vault-frozen", word(1n), "frozen"],
  ["custodian-paused", word(2n), "malformed"], ["custodian-code", "0x6000", "implementation"]] as const) {
  test(`identity is statefully retryable for ${id}/${reason}`, () => {
    const step = stage(2), results = replies(custodianIdentity.buildRequests(step)).map(r => r.id === id ? returned(id, data) : r);
    const evidence = custodianIdentity.decode({ step, results });
    const decision = custodianIdentity.decide({ ...step, evidence });
    assert.equal(decision.status, "retryable");
    assert.match((decision as any).reasonCode, new RegExp(reason));
    // The production runner stops at this terminal retryable decision; its
    // guarded buildRequests contract must not be called after termination.
  });
}
test("transport/missing/foreign-source proof cannot become paused, allowed or permanently rejected", () => {
  const step = stage(2), results = replies(custodianIdentity.buildRequests(step));
  assert.throws(() => custodianIdentity.decode({ step, results: results.map(r => r.id === "custodian-paused" ?
    { id: r.id, ok: false, source, failure: "rpc" } : r) }), RequiredAdapterRequestError);
  for (const broken of [results.filter(r => r.id !== "custodian-paused"), results.map(r => ({ ...r, source: { ...source, generation: 2 } }))]) {
    const evidence = custodianIdentity.decode({ step, results: broken });
    assert.equal(custodianIdentity.decide({ ...step, evidence }).status, "retryable");
  }
});
test("identity refuses partial input, missing independent inventory payout, missing burn and wrong receiver logs", () => {
  const step = stage(3), good = activeReply(step.evidence) as any;
  const broken = [
    { ...good, effects: { ...good.effects, tokenDeltas: good.effects.tokenDeltas.slice(0, 2) } },
    { ...good, effects: { ...good.effects, tokenDeltas: good.effects.tokenDeltas.map((d: any, i: number) => i ? d : { ...d, delta: d.delta + 1n }) } },
    { ...good, effects: { ...good.effects, totalSupplyDeltas: [] } },
    { ...good, effects: { ...good.effects, logs: [] } },
    { ...good, completion: "reverted-as-declared", data: "0x" },
  ];
  for (const result of broken) {
    const evidence = custodianIdentity.decode({ step, results: [activeReply(step.evidence, "deposit"), result] });
    assert.equal(custodianIdentity.decide({ ...step, evidence }).status,
      result.completion === "reverted-as-declared" ? "verified" : "retryable");
  }
});
test("quote uses the exact trial input, external decimals and inventory capacity, not owner prebalance", () => {
  for (const amount of [10n ** 12n, 10n ** 18n, 215_200_560_000_000_000_000n]) {
    const input = quoteInput(amount), p = exactProgram(input), requests = p.buildRequests(input);
    assert.equal(decodedQuote(input).amountOut, amount / 10n ** 12n);
    const preview = requests.find(r => r.id === "exact-preview")!;
    assert(preview.kind === "eth-call"); assert.equal(CUSTODIAN_ABI.decodeFunctionData("previewRedeem", preview.data)[0], amount);
    assert(!requests.some(r => r.kind === "eth-call" && r.data.startsWith(ethers.id("maxRedeem(address)").slice(0, 10))));
  }
  const input = quoteInput(capacity + 10n ** 12n);
  assert.throws(() => decodedQuote(input), /capacity/);
  assert.throws(() => decodedQuote(quoteInput(1n)), /no output/);
  const { descriptor, route } = setup();
  const draft = erc4626Pricing.compileDraft({ descriptor, routes: [route], stateKey: descriptor.instanceKey });
  const decimals = erc4626Pricing.staticEvidence!.buildRequests(draft);
  assert.deepEqual(decimals.map(r => r.kind === "eth-call" ? lower(r.to) : "wrong"), [asset, share]);
});
test("current pricing refreshes Custodian each block and fails closed on upgrades/permissions/source mixes", () => {
  const { descriptor: d, route } = setup();
  const descriptor = { instanceKey: d.instanceKey, vault: d.vault, routes: [route], custodian: d.custodian, oneAsset: 10n ** 6n, oneShare: 10n ** 18n };
  assert.equal(erc4626Pricing.refreshPolicyForInstance!({ descriptor, routes: [route] }), "each-block");
  assert.equal(erc4626Pricing.refreshPolicyForInstance!({ descriptor: { ...descriptor, custodian: undefined }, routes: [route] }), "on-touch");
  const requests = erc4626Pricing.current.buildRequests({ descriptor, routes: [route], source } as never);
  const results = replies(requests);
  const decode = (initialResults: readonly AdapterRequestResult[]) => erc4626Pricing.current.decodeSnapshot({ descriptor, initialResults, dependentEvidence: [] });
  assert.equal(decode(results).source.hash, source.hash);
  for (const [id, data] of [["current-custodian-proxy", "0x6000"], ["current-custodian-code", "0x6000"],
    ["current-custodian-implementation", word(BigInt(executor))], ["current-custodian-frxUSD", word(BigInt(executor))],
    ["current-custodian-paused", word(1n)], ["current-custodian-minter", word(0n)]] as const)
    assert.throws(() => decode(results.map(r => r.id === id ? returned(id, data) : r)));
  assert.throws(() => decode(results.map((r, i) => i ? r : { ...r, source: { ...source, generation: 2 } })));
  assert.equal(decode(results.map(r => ({ ...r, source: { ...source, generation: 2 } }))).source.generation, 2);
});

// Existing shared bytecode testkit, synthetic token state; NOT an EVM receipt.
function run(program: string, amount: bigint, behavior: Record<string, bigint | boolean> = {}, direction: "deposit" | "redeem" = "redeem") {
  const deposit = direction === "deposit", tokenIn = deposit ? asset : share;
  const amountOut = deposit ? amount * 10n ** 12n : amount / 10n ** 12n;
  let inputBalance = amount + 987654321n, outputBalance = 999999999999n;
  let supply = capacity * 100n, allowance = 777n, redeemed = false;
  const beforeInput = inputBalance, beforeOutput = outputBalance;
  const approvalAmounts: bigint[] = [];
  const trace = inspectRuntime(program, amount, { call(c) {
      const target = lower(c.target), mode = c.static ? 1 : 0;
      assert.equal(c.value, 0n); assert.equal(c.incoming, 0); assert.equal(c.outgoing, 0);
      const isVault = target === vault, abi = isVault ? CUSTODIAN_ABI : CUSTODIAN_TOKEN;
      assert([vault, share, asset].includes(target));
      const call = abi.parseTransaction({ data: c.data })!;
      let value: readonly unknown[] = [];
      if (!["deposit", "redeem", "approve"].includes(call.name)) assert.equal(mode, 1);
      switch (call.name) {
        case "frxUSD": value = [behavior.wrongShare ? executor : share]; break;
        case "asset": case "custodianTkn": value = [asset]; break;
        case "minters": value = [behavior.noMinter ? false : true]; break;
        case "isPaused": value = [!!behavior.paused]; break;
        case "isFrozen": value = [!!behavior.frozen]; break;
        case "balanceOf": assert.equal(lower(String(call.args[0])), executor); value = [target === tokenIn ? inputBalance : outputBalance]; break;
        case "totalSupply": value = [supply]; break;
        case "allowance": assert.equal(lower(String(call.args[0])), executor); assert.equal(lower(String(call.args[1])), vault); value = [allowance]; break;
        case "mdwrComboView": value = [behavior.depositCapacity ?? inventory, behavior.mintCapacity ?? capacity,
          behavior.inventory ?? inventory, behavior.capacity ?? capacity]; break;
        case "previewDeposit": case "previewRedeem": assert.equal(call.args[0], amount); value = [amountOut]; break;
        case "approve":
          assert.equal(target, tokenIn); assert.equal(mode, 0); assert.equal(lower(String(call.args[0])), vault);
          approvalAmounts.push(BigInt(call.args[1]));
          allowance = redeemed && behavior.dirtyAllowance ? 1n : BigInt(call.args[1]); value = [!behavior.falseApproval]; break;
        case "deposit": case "redeem": {
          assert.equal(call.name, direction);
          assert.equal(mode, 0); assert.equal(call.args[0], amount); assert.equal(lower(String(call.args[1])), executor);
          if (!deposit) assert.equal(lower(String(call.args[2])), executor);
          assert.equal(allowance, amount); redeemed = true;
          const spent = behavior.partialInput ? amount - 1n : behavior.excessInput ? amount + 1n : amount;
          inputBalance -= spent; if (!behavior.noBurn) supply += deposit ? amountOut : -amount;
          const received = behavior.noReceipt ? 0n : behavior.shortReceipt ? amountOut - 1n : amountOut;
          outputBalance += received; allowance = 0n;
          value = [behavior.falseReturn ? amountOut + 1n : amountOut]; break;
        }
        default: assert.fail(`unexpected emitted call ${call.name}`);
      }
      if (behavior.malformedBool && call.name === "isPaused") return word(2n);
      if (behavior.missingBool && call.name === "isPaused") return "0x";
      return abi.encodeFunctionResult(call.name, value);
  } });
  assert(redeemed); assert.equal(trace.registers[0], amount); assert.equal(allowance, 0n);
  assert.deepEqual(approvalAmounts, [0n, amount, 0n]);
  assert.equal(beforeInput - inputBalance, amount); assert.equal(outputBalance - beforeOutput, amountOut);
}
test("deposit uses external shares, current mint capacity, exact asset debit and isolated actual mint receipt", () => {
  const { descriptor, route } = setup(vault, "deposit");
  const i = { descriptor, route, source, executor, runtimeEvidence: [] };
  const leg = erc4626Execution.buildRuntimeLeg!(i)!;
  for (const amount of [1n, 1_000_000n, 215_200_560n]) {
    const input = { ...i, amountIn: amount }, q = decodedQuote(input);
    assert.equal(q.amountOut, amount * 10n ** 12n);
    run(leg.program, amount, {}, "deposit");
    const fragment = erc4626Execution.buildFragment({ ...input, quotedAmountOut: q.amountOut, minAmountOut: 1n, exactEvidence: q.evidence });
    const bytes = erc4626DepositFamilyOwnedAction.encode(fragment.nodes[0]! as never, executor, new Uint8Array());
    assert.equal(ethers.hexlify(bytes.slice(36)), leg.program);
  }
  for (const behavior of ["partialInput", "excessInput", "noReceipt", "shortReceipt", "falseReturn", "noBurn", "falseApproval", "dirtyAllowance", "paused", "frozen"])
    assert.throws(() => run(leg.program, 1_000_000n, { [behavior]: true }, "deposit"), behavior);
  assert.throws(() => run(leg.program, 1_000_000n, { depositCapacity: 999999n }, "deposit"));
  assert.throws(() => run(leg.program, 1_000_000n, { mintCapacity: 10n ** 18n - 1n }, "deposit"));
});
test("runtime never reads amountIn/Exact/quoted; quoted action executes the same guarded ABI program", () => {
  const { descriptor, route } = setup();
  const runtimeInput: any = { descriptor, route, executor, source, runtimeEvidence: [] };
  for (const field of ["amountIn", "quotedAmountOut", "exactEvidence", "quote", "exact"]) Object.defineProperty(runtimeInput, field, { get() { assert.fail(`runtime read ${field}`); } });
  const leg = erc4626Execution.buildRuntimeLeg!(runtimeInput)!;
  for (const amount of [10n ** 12n, 10n ** 18n, 215_200_560_000_000_000_000n]) {
    run(leg.program, amount);
    const q = decodedQuote(quoteInput(amount));
    const fragment = erc4626Execution.buildFragment({ ...runtimeInput, amountIn: amount, quotedAmountOut: q.amountOut, minAmountOut: 1n, exactEvidence: q.evidence });
    assert.equal(fragment.requirements.length, 0);
    const bytes = erc4626RedeemFamilyOwnedAction.encode(fragment.nodes[0]! as never, executor, new Uint8Array());
    assert.equal(bytes[0], 0x0e); assert.equal(BigInt(ethers.hexlify(bytes.slice(1, 33))), amount);
    assert.equal(ethers.hexlify(bytes.slice(36)), leg.program);
  }
});
for (const behavior of ["partialInput", "excessInput", "noReceipt", "shortReceipt", "falseReturn", "noBurn", "falseApproval", "dirtyAllowance",
  "noMinter", "paused", "frozen", "malformedBool", "missingBool", "wrongShare"]) {
  test(`runtime rejects ${behavior} without borrowing old input/output inventory`, () => {
    const { descriptor } = setup(), program = ethers.hexlify(custodianRedeemProgram(descriptor, executor).bytes());
    assert.throws(() => run(program, 10n ** 18n, { [behavior]: true }));
  });
}
test("runtime enforces capacity/positive output/minimum receipt and rejects incompatible bindings", () => {
  const { descriptor, route } = setup(), p = ethers.hexlify(custodianRedeemProgram(descriptor, executor).bytes());
  assert.throws(() => run(p, 10n ** 18n, { capacity: 10n ** 18n - 1n }));
  assert.throws(() => run(p, 10n ** 18n, { inventory: 999999n }));
  assert.throws(() => run(p, 1n));
  assert.throws(() => run(ethers.hexlify(custodianRedeemProgram(descriptor, executor, 1000001n).bytes()), 10n ** 18n));
  assert.throws(() => erc4626Execution.buildRuntimeLeg!({ descriptor, route, executor, runtimeEvidence: [] }), /source/);
  assert.throws(() => erc4626Execution.buildRuntimeLeg!({ descriptor, route, executor: proxyAdmin, source, runtimeEvidence: [] }), /executor/);
  assert.throws(() => erc4626Execution.buildRuntimeLeg!({ descriptor, route: { ...route, direction: "deposit" }, executor, source, runtimeEvidence: [] }), /direction|binding/);
  assert.throws(() => erc4626Execution.buildRuntimeLeg!({ descriptor: { ...descriptor, share: vault }, route, executor, source, runtimeEvidence: [] }), /binding/);
  const input = quoteInput(), q = decodedQuote(input);
  assert.throws(() => erc4626Execution.buildFragment({ ...input, quotedAmountOut: q.amountOut, minAmountOut: 1n,
    exactEvidence: { ...q.evidence, executor: vault } }), /actor/);
  assert.throws(() => exactProgram(input).buildRequests({ ...input, prefix: [{}] } as never), /sequential/);
});

test("production reissues later-source runtime without Exact; fresh pricing/Exact reject unknown upgrades", async () => {
  // Real production issuers with a synthetic transport, no disk Ready/catalog.
  const entries = FAMILY_CAPABILITY_NAMES.map(capability => ({ familyId: ERC4626_FAMILY_ID, capability,
    contractVersion: "custodian-offline-blocker-v1", contentHash: ethers.id(`fixture:${capability}`).slice(2),
    semanticDependencies: [`contract:${capability}`], provenanceCommit: null }));
  const catalog = new FamilyCapabilityCatalog({ modules: [{ plugin, sourceFile: "fixture/erc4626.production.ts",
    definitionBoundaryHash: definedFamilyPluginContractSummary(plugin).definitionBoundaryHash }],
    generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) } });
  const family = catalog.forFamily(ERC4626_FAMILY_ID), reads: string[] = [];
  function runtime(at = source, upgraded: false | "code" | "slot" = false) {
    const read = (request: AdapterRequest) => {
      reads.push(request.kind);
      const row = replies([request])[0]!; assert(row.ok);
      if (upgraded === "code" && request.kind === "get-code" && lower(request.address) === implementation) return "0x6000";
      if (upgraded === "slot" && request.kind === "get-storage") return word(BigInt(executor));
      return row.data;
    };
    return createStrictCentralAdapterRuntime({ executor, verifiedActors: { "erc4626-probe-actor": ERC4626_PROBE_ACTOR },
      generationFence: { assertCurrent(g, s) { assert.equal(g, at.generation); assert.deepEqual(s, at); } },
      provider: {
        async getCode(address, block) { assert.equal(block, at.number); return read({ id: "fixture", kind: "get-code", address }); },
        async getStorage(address, slot, block) { assert.equal(block, at.number); return read({ id: "fixture", kind: "get-storage", address, slot }); },
        async call(req, block) { assert.equal(block, at.number); return read({ id: "fixture", kind: "eth-call", to: req.to, data: req.data, completion: "return-data" }); },
      },
      simulator: { async simulate({ request }) {
        const direction = request.id === "custodian-active-deposit" ? "deposit" : "redeem";
        const amount = BigInt(CUSTODIAN_ABI.decodeFunctionData(direction, request.call.data)[0]);
        const result = activeReply({ amount, expected: direction === "deposit" ? amount * 10n ** 12n : amount / 10n ** 12n,
          surface: { vault } }, direction); assert(result.ok);
        return { data: result.data, effects: result.effects };
      } },
    });
  }
  const admitted = await executeAdapterFamilyLifecycleBatch({ family, source, generation: source.generation, runtime: runtime(),
    publisher: { publish() {} }, matches: [{ matchedPatternId: "erc4626-redeem-call", observation: { kind: "call", source,
      target: vault, data: CUSTODIAN_ABI.encodeFunctionData("redeem", [10n ** 18n, executor, executor]) } }] });
  assert(admitted.publication, JSON.stringify(admitted.outcomes));
  const ready = admitted.publication.instances; assert.equal(ready.length, 1, JSON.stringify(admitted.outcomes));
  assert.equal((ready[0]!.descriptor as Erc4626Descriptor).custodian?.share.toLowerCase(), share);
  const edges = buildFamilyRouteGraphView({ routes: ready.flatMap(i => i.routes.map((route, n) => ({ family,
    descriptor: i.descriptor, route, handle: i.routeHandles[n]! }))) }).edges;
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: source, readyGraph: edges, readyInstances: ready, readyFundingAssets: [] });
  const edge = edges.find(e => e.tokenIn.toLowerCase() === share)!;
  reads.length = 0;
  const same = await root.createSession({ source, runtime: runtime(), kind: "exact", fundingAssets: [] });
  assert(same.buildRuntimeAmountLeg({ edge, executor, runtimeEvidence: [] }));
  assert.equal(reads.length, 0, "proof-source runtime constructs without Exact or new reads");
  const next = { number: source.number + 1, hash: ethers.toBeHex(source.number + 1, 32), generation: 2 };
  reads.length = 0;
  const session = await root.createSession({ source: next, runtime: runtime(next, "code"), kind: "exact", fundingAssets: [] });
  assert.equal(reads.length, 0, "source reissuance does not run pricing or Exact guards");
  await assert.rejects(() => session.issueExact({ edge, amountIn: 10n ** 18n, executor, runtimeEvidence: [] }), /unresolved/);
  assert(reads.includes("get-code"), "explicit Exact does reject the changed implementation");
  const unchanged = await root.createSession({ source: next, runtime: runtime(next), kind: "exact", fundingAssets: [] });
  reads.length = 0;
  assert(unchanged.buildRuntimeAmountLeg({ edge, executor, runtimeEvidence: [] }));
  assert.equal(reads.length, 0, "later-source runtime never invokes Exact or guards off-chain");
  const quote = await unchanged.issueExact({ edge, amountIn: 10n ** 18n, executor, runtimeEvidence: [] });
  assert("amountOut" in quote);
  assert.equal(unchanged.buildExecution({ edge, exact: quote, minAmountOut: quote.amountOut, executor }).status, "resolved");
  assert(unchanged.buildRuntimeAmountLeg({ edge, executor, runtimeEvidence: [] }));
  for (const mutation of ["code", "slot"] as const) {
    let upgraded: false | "code" | "slot" = false;
    const at = (offset: number) => ({ number: source.number + 10 + offset,
      hash: ethers.toBeHex(source.number + 10 + offset, 32), generation: source.generation + 10 + offset });
    const graph = (now: ReturnType<typeof at>) => createVerifiedGraphView({ id: "custodian-offline-refresh", edges,
      generation: now.generation, sourceBlock: now.number, sourceBlockHash: now.hash, completenessWatermark: now.number,
      familyIdForEdge: () => ERC4626_FAMILY_ID, perSourceCoverage: [{ familyId: ERC4626_FAMILY_ID,
        sourceId: "synthetic-custodian", sourceFingerprint: "offline-only", completeThroughBlock: now.number, completeThroughHash: now.hash }] });
    const coordinator = new StrictCurrentRuntimeCoordinator(i => root.createSession({ source: i.source,
      runtime: runtime(i.source, upgraded), fundingAssets: [], kind: i.purpose === "exact-execution" ? "exact" : "pricing",
      touchedPools: i.touchedPools, requiredEdgeIds: i.requiredEdgeIds, control: i.control }), () => {}, undefined,
      async (pricing, control, _backend, reuse) => {
        const target = reuse?.quoteGraph ?? pricing;
        const now = { number: target.sourceBlock, hash: target.sourceBlockHash, generation: target.generation };
        let exact: StrictProductionRuntimeSession | undefined;
        return buildEffectiveMids({ pricing, quoteGraph: reuse?.quoteGraph, previous: reuse?.previous,
          touchedStateKeys: reuse?.touchedStateKeys, disabledEdgeIds: reuse?.disabledEdgeIds, control,
          // Offline scheduling anchor only, not a natural WETH valuation claim.
          weth: share, gasCostWei: null, enumerationSpreadBps: 0, concurrency: 1,
          prepareQuote: async requiredEdgeIds => {
            exact = await root.createSession({ source: now, runtime: runtime(now, upgraded), kind: "exact", fundingAssets: [], requiredEdgeIds, control });
          },
          quote: async request => { assert(exact); const q = await exact.issueExact({ ...request, executor, runtimeEvidence: [] }); assert("amountIn" in q); return q; },
        });
      });
    async function step(offset: number) {
      const now = at(offset), touched = new Set<string>();
      const prepared = await coordinator.prepare({ graph: graph(now), fundingTokens: [], deadlineAtMs: Date.now() + 10000,
        ...(offset === 0 ? {} : { touchedPools: touched, canonicalActivity: {
          source: now, parentHash: at(offset - 1).hash, touchedStateKeys: touched, complete: true as const } }) });
      assert(prepared.status !== "incomplete");
      const visited: string[] = [];
      const scan = detectProductionBlockScanOpportunities({ runtime: prepared.snapshot, swapTouched: null,
        cfg: { maxHops: 3, minSpreadBps: 0, maxCandidates: 10, budgetMs: 10000,
          enumerationBackend: "typescript", pricedTokens: new Map([[share, { maxBorrow: 10n ** 18n }]]) },
        edgeEligible: candidate => { visited.push(blockScanEdgeKey(candidate)); return true; },
      });
      return { pricing: prepared.snapshot.pricing, visited, scan };
    }
    const first = await step(0);
    assert.equal(first.pricing.coverage.resolvedEdgeKeys.length, 2);
    assert.equal(first.visited.length, 2, "healthy edges must actually reach the production scanner");
    reads.length = 0;
    const quiet = await step(1);
    assert.equal(quiet.pricing.coverage.resolvedEdgeKeys.length, 2);
    assert(reads.includes("get-storage") && reads.includes("get-code"), "quiet blocks must revalidate implementation through current effective");
    assert([...quiet.pricing.effectiveMids!.rows.values()].every(row => row.quotedAt?.number === at(1).number));
    upgraded = mutation;
    for (const offset of [2, 3]) {
      const failed = await step(offset);
      assert.equal(failed.pricing.graph.edges.length, 2, "frozen Ready graph is retained");
      assert.equal(failed.pricing.coverage.resolvedEdgeKeys.length, 0, "unsupported upgrade must withdraw both executable prices");
      assert([...failed.pricing.effectiveMids!.rows.values()].every(row => row.status !== "quoted"), "never revive the previous successful price");
      assert.deepEqual(failed.visited, [], "production scanner must exclude unresolved target edges before enumeration");
      assert.equal(failed.scan.opportunities.length, 0, "no target candidate can reach runtime sizing");
    }
  }
});
