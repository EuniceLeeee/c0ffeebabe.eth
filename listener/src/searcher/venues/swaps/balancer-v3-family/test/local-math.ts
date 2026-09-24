import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { VAULT } from "../codec.js";
import { classifyBalancerPoolCode } from "../local-model.js";
import type { BalancerLocalModel } from "../local-model.js";
import { quoteBalancerExactInScaled18, type BalancerScaledExactIn } from "../local-math.js";
import { BALANCER_MODEL_TEMPLATES } from "../local-math/model-templates.js";

const WAD = 10n ** 18n;
const MAX = (1n << 256n) - 1n;
function instantiated(template: typeof BALANCER_MODEL_TEMPLATES[number]): string {
  const bytes = Buffer.from(template.runtimeTemplate.slice(2), "hex");
  for (const immutable of template.immutableReferences) {
    const word = immutable.name === "_vault" ? VAULT.slice(2).toLowerCase().padStart(64, "0") : "1".padStart(64, "0");
    for (const offset of immutable.offsets) bytes.set(Buffer.from(word, "hex"), offset);
  }
  return `0x${bytes.toString("hex")}`;
}
function byteChange(code: string, offset: number): string {
  const bytes = Buffer.from(code.slice(2), "hex"); bytes[offset] ^= 1;
  return `0x${bytes.toString("hex")}`;
}
const weighted: BalancerScaledExactIn = {
  model: "weighted-v1", balances: [WAD, WAD], indexIn: 0, indexOut: 1,
  amountIn: WAD / 10n, weights: [WAD / 2n, WAD / 2n],
};
const stable: BalancerScaledExactIn = {
  model: "stable-v1", balances: [20000n * WAD, 20000n * WAD], indexIn: 0, indexOut: 1,
  amountIn: 995n * WAD / 10n, amp: 1000000n,
};

const solidityVectors: { cases: {
  model: BalancerLocalModel; balances: string[]; indexIn: number; indexOut: number;
  amountIn: string; weights?: string[]; amp?: string; minTokenBalances?: string[]; expected: string;
}[] } = JSON.parse(readFileSync(new URL("./fixtures/local-math-solidity-vectors.json", import.meta.url), "utf8"));
for (const [index, vector] of solidityVectors.cases.entries()) {
  test(`pinned Solidity core regression ${vector.model}/${index}`, () => {
    const input: BalancerScaledExactIn = { ...vector, balances: vector.balances.map(BigInt),
      amountIn: BigInt(vector.amountIn), weights: vector.weights?.map(BigInt),
      amp: vector.amp === undefined ? undefined : BigInt(vector.amp), minTokenBalances: vector.minTokenBalances?.map(BigInt) };
    assert.equal(quoteBalancerExactInScaled18(input), BigInt(vector.expected));
  });
}

for (const template of BALANCER_MODEL_TEMPLATES) {
  test(`exact compiler runtime classification: ${template.model}`, () => {
    const code = instantiated(template);
    assert.equal(classifyBalancerPoolCode(code), template.model);
    assert.equal(classifyBalancerPoolCode(`0x${code.slice(2).toUpperCase()}`), template.model);
    assert.equal(classifyBalancerPoolCode(byteChange(code, 0)), null, "one instruction changed");
    assert.equal(classifyBalancerPoolCode(byteChange(code, template.byteLength - 1)), null, "metadata retained");
    assert.equal(classifyBalancerPoolCode(`${code}00`), null, "appended bytes rejected");
    assert.equal(classifyBalancerPoolCode(code.slice(0, -2)), null, "truncation rejected");
    for (const immutable of template.immutableReferences) {
      if (immutable.name === "_vault") assert.equal(classifyBalancerPoolCode(byteChange(code, immutable.offsets[0])), null);
      const repeatedOffset = immutable.offsets.at(1);
      if (repeatedOffset !== undefined) assert.equal(classifyBalancerPoolCode(byteChange(code, repeatedOffset)), null);
    }
    const nonVault = template.immutableReferences.find(item => item.name !== "_vault")!;
    const bytes = Buffer.from(code.slice(2), "hex");
    for (const offset of nonVault.offsets) bytes[offset + 31] = 2;
    assert.equal(classifyBalancerPoolCode(`0x${bytes.toString("hex")}`), template.model,
      "immutable identity is not a per-instance allowlist");
  });
}
test("unknown/malformed code remains unsupported by local models", () => {
  for (const code of ["", "0x", "0x0", "0xgg", "0x60006000", "60006000"]) assert.equal(classifyBalancerPoolCode(code), null);
});
test("upstream saved Weighted exact-in vector, Sepolia block 7439300", () => {
  // balancer-maths@4093af0 testData/testData/11155111-7439300-Weighted-USDC-DAI.json.
  // USDC->DAI: 10000000 raw, 6->18 decimals, 1% fee, both rates = 1.
  const amountIn = 10n * WAD - 10n * WAD / 100n;
  assert.equal(quoteBalancerExactInScaled18({ ...weighted, amountIn,
    balances: [6916384366000000000000n, 6240659067374271172646n] }), 8920009849766722311n);
});
test("upstream saved Stable exact-in vector, Sepolia block 7439300", () => {
  // balancer-maths@4093af0 testData/testData/11155111-7439300-Stable-stataUSDC-stataUSDT.json.
  // Pool output is scaled18; this fixed test reproduces Vault input fee/rate and
  // output rate rounding independently of the production state reader.
  const rateIn = 1238765561700857944n, rateOut = 1414776878607727229n;
  const scaledIn = 10000000n * 1000000000000n * rateIn / WAD;
  const fee = (scaledIn * 1000000000000000n - 1n) / WAD + 1n;
  const out = quoteBalancerExactInScaled18({ ...stable, amountIn: scaledIn - fee,
    balances: [21116734020109359171539n, 82348545564048094640470n] });
  assert.equal(out * WAD / (1000000000000n * (rateOut + 1n)), 8771615n);
});
test("Stable reference invariant/balance result and no input mutation", () => {
  const before = [...stable.balances];
  for (const model of ["stable-v1", "stable-v2", "stable-v3"] as const) {
    assert.equal(quoteBalancerExactInScaled18({ ...stable, model }), 99499505472260433154n);
    assert.deepEqual(stable.balances, before);
  }
});
test("Weighted v2 preserves balanceIn + 1 rounding and both minimum-balance gates", () => {
  const input = { ...weighted, model: "weighted-v2" as const, amountIn: 3n * WAD / 10n, minTokenBalances: [1n, 1n] };
  const roundingInput = { ...input, balances: [1000001n, WAD], amountIn: 100000n };
  const first = quoteBalancerExactInScaled18({ ...roundingInput, model: "weighted-v1" });
  assert.equal(first, 90909008264537941n);
  assert.equal(quoteBalancerExactInScaled18(roundingInput), 90908925620135236n);
  const second = quoteBalancerExactInScaled18(input);
  assert.throws(() => quoteBalancerExactInScaled18({ ...input, minTokenBalances: undefined }), /minimum/);
  assert.throws(() => quoteBalancerExactInScaled18({ ...input, minTokenBalances: [WAD + 2n, 1n] }), /TokenBalanceBelowMin/);
  assert.throws(() => quoteBalancerExactInScaled18({ ...input, minTokenBalances: [1n, WAD - second + 1n] }), /TokenBalanceBelowMin/);
  assert.equal(quoteBalancerExactInScaled18({ ...input, minTokenBalances: [WAD + 1n, WAD - second] }), second);
});
test("Weighted maximum input ratio rejects only above the exact boundary", () => {
  assert(quoteBalancerExactInScaled18({ ...weighted, amountIn: 3n * WAD / 10n }) > 0n);
  assert.throws(() => quoteBalancerExactInScaled18({ ...weighted, amountIn: 3n * WAD / 10n + 1n }), /MaxInRatio/);
});
test("Stable v3 rejects the worst starting/ending imbalance without narrowing old versions", () => {
  const imbalance = { ...stable, balances: [10001n * WAD, WAD], amountIn: 1000000n, indexIn: 1, indexOut: 0 };
  assert(quoteBalancerExactInScaled18(imbalance) > 0n);
  assert.throws(() => quoteBalancerExactInScaled18({ ...imbalance, model: "stable-v3" }), /MaxImbalanceRatioExceeded/);
  assert.throws(() => quoteBalancerExactInScaled18({ ...stable, model: "stable-v3",
    balances: [9999n * WAD, WAD], amountIn: WAD }), /MaxImbalanceRatioExceeded/);
});
test("checked uint256 behavior and parameter guards fail closed", () => {
  assert.throws(() => quoteBalancerExactInScaled18({ ...stable, balances: [MAX / 3n, MAX / 3n] }), /overflow/);
  assert.throws(() => quoteBalancerExactInScaled18({ ...weighted, balances: [MAX, WAD] }), /overflow/);
  assert.throws(() => quoteBalancerExactInScaled18({ ...weighted, model: "weighted-v2", balances: [MAX, WAD],
    minTokenBalances: [1n, 1n] }), /overflow/);
  for (const input of [
    { ...weighted, amountIn: -1n }, { ...weighted, balances: [0n, WAD] },
    { ...weighted, indexIn: 0.5 }, { ...weighted, indexOut: 0 },
    { ...weighted, weights: [1n, WAD - 1n] }, { ...weighted, weights: [WAD, WAD] },
    { ...stable, amp: 999n }, { ...stable, amp: 50000001n },
  ]) assert.throws(() => quoteBalancerExactInScaled18(input));
});
