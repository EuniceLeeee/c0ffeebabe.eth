import assert from "node:assert/strict";
import { ethers } from "ethers";
import { ADDR } from "../../../../../shared/constants/addresses.js";
import { curvePlainIdentity } from "../identity.js";
import type { AdapterRequestResult } from "../../../adapter-request-program.js";

const pool = "0x1111111111111111111111111111111111111111", actor = "0x2222222222222222222222222222222222222222";
const source = { number: 123, hash: ethers.id("tricrypto-effects-fixture"), generation: 1 };
const variant = curvePlainIdentity.variants[1];
const word = (value: bigint) => ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [value]);
for (const wethIn of [true, false]) {
  const quote = { i: 0, j: 1, tokenIn: wethIn ? ADDR.WETH : ADDR.USDC, tokenOut: wethIn ? ADDR.USDC : ADDR.WETH,
    amountIn: 10000n, amountOut: 9999n };
  const candidate = { candidateKind: "curve-plain-pool" as const, pool, hintedI: null, hintedJ: null };
  const step = { candidate, step: 3, evidence: { phase: "quotes", pool, source,
    binding: { quoteAbi: "uint256", coinAbi: "uint256", balanceAbi: "uint256", coins: [quote.tokenIn, quote.tokenOut],
      decimals: [18, 18], registry: pool, handlers: [pool], codeHash: ethers.id("fixture") },
    balances: [1000000n, 1000000n], quotes: [quote], directions: [], requestIds: [] } };
  const results: AdapterRequestResult[] = variant.buildRequests(step).map(r => ({ id: r.id, source, ok: true,
    provenance: { kind: "fixture", fingerprint: "not-chain-evidence" },
    completion: r.id.endsWith(":exchange-uint") ? "returned" : "reverted-as-declared", data: word(quote.amountOut),
    effects: { tokenDeltas: [
      { token: quote.tokenIn, account: actor, delta: -quote.amountIn },
      { token: quote.tokenIn, account: pool, delta: wethIn ? 0n : quote.amountIn },
      { token: quote.tokenOut, account: actor, delta: quote.amountOut },
      { token: quote.tokenOut, account: pool, delta: wethIn ? -quote.amountOut : 0n },
    ], logs: [{ address: ADDR.WETH,
      topics: [ethers.id(wethIn ? "Withdrawal(address,uint256)" : "Deposit(address,uint256)"), ethers.zeroPadValue(pool, 32)],
      data: word(wethIn ? quote.amountIn : quote.amountOut) }] },
  }));
  const decide = (results: readonly AdapterRequestResult[]) => variant.decide({ candidate, step: 4,
    evidence: variant.decode({ step, results }) });
  assert.equal(decide(results).status, "verified");
  for (const corrupt of ["missing", "wrong-amount", "wrong-emitter", "wrong-receiver"]) {
    const changed = results.map(r => !r.ok ? r : { ...r, effects: { ...r.effects,
      logs: corrupt === "missing" ? [] : r.effects!.logs!.map(log => ({ ...log,
        ...(corrupt === "wrong-amount" ? { data: word(1n) } : {}),
        ...(corrupt === "wrong-emitter" ? { address: actor } : {}) })),
      tokenDeltas: r.effects!.tokenDeltas!.map((delta, i) => corrupt === "wrong-receiver" && i === 2 ? { ...delta, delta: delta.delta - 1n } : delta),
    } });
    assert.equal(decide(changed).status, "retryable", corrupt);
  }
}
console.log("Tricrypto exchange-uint WETH wrapping effects and strict receipt negatives PASS (synthetic)");
