import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ethers } from "ethers";
import { applyExactTrialState, emptyExactTrialState } from "../../../../exact-trial-state.js";
import { storageState, tokenBalanceState } from "../../../local-state-models/resources.js";
import { plugin } from "../../../production-families/psm.production.js";
import { PSM_INTERFACE, psmBuyCost, psmBuyQuote } from "../codec.js";
import { PSM_IMMUTABLES, verifyPsmTrialModel } from "../local-model.js";
import { PSM_FAMILY_ID, PSM_LINEAGE_ID } from "../manifest.js";
import { decodePsmTrial, psmTrialDependentRequests, psmTrialRequests, quotePsmTrial } from "../trial-state.js";
import type { AdapterRequestResult } from "../../../adapter-request-program.js";

const executor = "0x1111111111111111111111111111111111111111";
const pocket = "0x37305b1cd40574e4c5ce33f8e8306be057fd7341";
const identity = { familyId: PSM_FAMILY_ID, lineageId: PSM_LINEAGE_ID,
  subject: "0x2222222222222222222222222222222222222222", provenance: [],
  gem: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", dai: "0x6b175474e89094c44da98b954eedeac495271d0f" };
const descriptor = plugin.instance.finalizeDescriptor({ identity, draft: plugin.instance.compileDraft(identity), sharedBindings: [] });
const [sell, buy] = plugin.routes.project({ descriptor });
const source = { number: 123, hash: ethers.id("psm-trial-test"), generation: 1 };
const input = { descriptor, route: sell, amountIn: 3_000_000n, source, executor, runtimeEvidence: [] };
const baseline = { source, pocket, tin: 0n, tout: 0n, daiBalance: 10n ** 19n,
  gemBalance: 5_000_000n, pocketAllowanceFloor: 8_000_000n };
const first = () => quotePsmTrial({ ...input, trialState: emptyExactTrialState().view }, baseline)!;

test("PSM uses updated pocket and target inventory for opposite and repeated directions", () => {
  const base = emptyExactTrialState();
  const sellQuote = quotePsmTrial({ ...input, trialState: base.view }, baseline)!;
  assert.equal(sellQuote.amountOut, 3n * 10n ** 18n);
  const afterSell = applyExactTrialState(base, sellQuote.stateChanges!, sellQuote.stateEffects);
  const buyQuote = quotePsmTrial({ ...input, route: buy, amountIn: 8n * 10n ** 18n, trialState: afterSell.view })!;
  assert.equal(buyQuote.amountOut, 8_000_000n, "sell replenished USDC before buy");
  const afterBuy = applyExactTrialState(afterSell, buyQuote.stateChanges!, buyQuote.stateEffects);
  assert.throws(() => quotePsmTrial({ ...input, route: buy, amountIn: 10n ** 18n, trialState: afterBuy.view }), /capacity exceeded/);
  assert.throws(() => quotePsmTrial({ ...input, amountIn: 8_000_000n, trialState: afterSell.view }), /capacity exceeded/,
    "second sell cannot use the original DAI inventory");
  assert.equal(quotePsmTrial({ ...input, trialState: base.view }, baseline)!.amountOut, sellQuote.amountOut,
    "a different amount trial starts from the unchanged source");
});

test("buy credits actual spent DAI, keeps fees and reduces the allowance capacity", () => {
  const amountIn = 1_123_456_789_012_345_678n, tout = 10n ** 15n;
  const result = quotePsmTrial({ ...input, route: buy, amountIn, trialState: emptyExactTrialState().view }, { ...baseline, tout })!;
  const out = psmBuyQuote(amountIn, tout, descriptor.decimalScale), spent = psmBuyCost(out, tout, descriptor.decimalScale);
  assert(spent < amountIn);
  const next = result.stateChanges![0].value as typeof baseline;
  assert.equal(next.daiBalance, baseline.daiBalance + spent);
  assert.equal(next.gemBalance, baseline.gemBalance - out);
  assert.equal(next.pocketAllowanceFloor, baseline.pocketAllowanceFloor - out);
  const max = (1n << 256n) - 1n;
  const unlimited = quotePsmTrial({ ...input, route: buy, amountIn, trialState: emptyExactTrialState().view },
    { ...baseline, tout, pocketAllowanceFloor: max })!;
  assert.equal((unlimited.stateChanges![0].value as typeof baseline).pocketAllowanceFloor, max - out,
    "do not invent an unlimited-approval sentinel behavior for another token runtime");
});

test("trial state rejects finite allowance exhaustion, overflow and actor/inventory aliases", () => {
  assert.throws(() => quotePsmTrial({ ...input, route: buy, amountIn: 2n * 10n ** 18n, trialState: emptyExactTrialState().view },
    { ...baseline, pocketAllowanceFloor: 1_000_000n }), /capacity exceeded/);
  assert.throws(() => quotePsmTrial({ ...input, trialState: emptyExactTrialState().view },
    { ...baseline, gemBalance: (1n << 256n) - 1n }), /overflow/);
  assert.throws(() => quotePsmTrial({ ...input, executor: pocket, trialState: emptyExactTrialState().view }, baseline), /alias/);
});

test("public trial state checks complete inventory and config dependencies; swaps do not mutate config", () => {
  const base = emptyExactTrialState(), q = first();
  assert(!q.stateEffects!.includes(storageState(descriptor.target)));
  for (const dependency of q.stateChanges![0].ref.dependencies!) {
    const after = applyExactTrialState(base, q.stateChanges!, q.stateEffects);
    const dirty = applyExactTrialState(after, [], [dependency]);
    assert.throws(() => quotePsmTrial({ ...input, trialState: dirty.view }), /invalidated dependency/);
  }
  const changedBeforeInitial = applyExactTrialState(base, [], [tokenBalanceState(descriptor.gem, pocket)]);
  assert.throws(() => quotePsmTrial({ ...input, trialState: changedBeforeInitial.view }, baseline), /invalidated dependency/);
  assert.throws(() => quotePsmTrial({ ...input, source: { ...source, number: 124 }, trialState: base.view }, baseline), /foreign source/);
});

const cached = process.env.PSM_RUNTIME_EVIDENCE;
const html = cached ? readFileSync(cached, "utf8") : undefined;
const runtime = html?.slice(html.indexOf("Deployed Bytecode")).match(/0x[0-9a-fA-F]{200,}/)?.[0];
test("cached verified LitePSM runtime normalization is exactly the constructor patch table", { skip: !runtime }, () => {
  const creation = ethers.getBytes(`0x${html!.match(/id='verifiedbytecode2'>([0-9a-f]+)/)![1]}`);
  const offsets: number[] = [];
  for (let pc = 0x4df; pc < 0x636; pc++) if (creation[pc] === 0x61 && creation[pc + 3] === 0x01 && creation[pc + 4] === 0x52)
    offsets.push(creation[pc + 1] * 256 + creation[pc + 2]);
  assert.deepEqual(offsets.sort((a, b) => a - b), Object.values(PSM_IMMUTABLES).flat().sort((a, b) => a - b));
  assert(verifyPsmTrialModel(runtime!, { ...descriptor, pocket }));
  assert(!verifyPsmTrialModel(runtime!, { ...descriptor, pocket: executor }));
  const moved = ethers.getBytes(runtime!);
  for (const offset of PSM_IMMUTABLES.pocket) moved.set(ethers.getBytes(ethers.zeroPadValue(executor, 32)), offset);
  assert(verifyPsmTrialModel(ethers.hexlify(moved), { ...descriptor, pocket: executor }));
  for (const at of [0, 500, PSM_IMMUTABLES.pocket[0], moved.length - 1]) {
    const modified = ethers.getBytes(runtime!); modified[at] ^= 1;
    assert(!verifyPsmTrialModel(ethers.hexlify(modified), { ...descriptor, pocket }));
  }
});

test("source-pinned request decode proves model and capacity; repeat quote needs no request", { skip: !runtime }, () => {
  const i = { ...input, trialState: emptyExactTrialState().view };
  const uint = (x: bigint) => ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [x]);
  const data: Record<string, string> = { "trial-code": runtime!, "trial-pocket": PSM_INTERFACE.encodeFunctionResult("pocket", [pocket]),
    "trial-tin": uint(baseline.tin), "trial-tout": uint(baseline.tout), "trial-dai": uint(baseline.daiBalance),
    "trial-gem": uint(baseline.gemBalance), "trial-allowance": uint(baseline.pocketAllowanceFloor) };
  const response = (id: string): AdapterRequestResult => ({ id, source, ok: true, completion: "returned", data: data[id],
    provenance: { kind: "cached-psm-contract", fingerprint: "fixture" } });
  const initial = psmTrialRequests(i).map(r => response(r.id));
  const dependent = psmTrialDependentRequests(i, initial).map(r => response(r.id));
  const state = decodePsmTrial(i, initial, [...initial, ...dependent]);
  assert.deepEqual(state, baseline);
  const q = quotePsmTrial(i, state)!, after = applyExactTrialState(emptyExactTrialState(), q.stateChanges!, q.stateEffects);
  const method = plugin.exact.methods(i)[1];
  assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") throw new Error("missing method");
  const quoteTrial = method.trialState?.quote;
  assert(typeof quoteTrial === "function", "expected supported PSM trial model");
  assert.equal(quoteTrial({ ...i, trialState: after.view }).status, "quoted");
  assert.throws(() => decodePsmTrial(i, initial, [...initial, ...dependent.slice(1)]), /missing or ambiguous/);
  assert.throws(() => decodePsmTrial(i, initial, [...initial, ...dependent.map(r => ({ ...r, source: { ...source, generation: 2 } }))]), /foreign source/);
  assert.throws(() => psmTrialDependentRequests(i, initial.map(r => r.id === "trial-code" ? { ...r, data: "0x6000" } : r)), /model unproven/);
});
