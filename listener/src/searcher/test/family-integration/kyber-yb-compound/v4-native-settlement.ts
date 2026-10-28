// Opt-in extension of the existing same-N acceptance runner. Real protocol and
// token contracts are untouched; only isolated actor balances and fixture code
// are overlaid. No search, valuation or production settlement is reimplemented.
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript, type RuntimeSettlementRequest } from "../../../../adapters/runtime-amount-program.js";
import { buildExecuteCalldata } from "../../../../shared/executor/botvm-executor.js";
import { json, sha, word, observeBalance, assertNativeInventory, same } from "./evidence.js";
const TOKEN = new ethers.Interface(["function transfer(address,uint256) returns(bool)"]);
const FUND = new ethers.Interface(["function fund(address,address,uint256,uint256,address) returns(uint256)"]);
const receiver = "0x1000000000000000000000000000000000000026";
const funder = "0x1000000000000000000000000000000000000027";
export function loadV4FundingFixture(root: string, path: string) {
  const file = realpathSync(path), bytes = readFileSync(file), artifact = JSON.parse(bytes.toString());
  const metadata = typeof artifact.metadata === "string" ? JSON.parse(artifact.metadata) : artifact.metadata;
  assert.equal(metadata?.settings?.compilationTarget?.["test/V4NativeFundingFixture.sol"], "V4NativeFundingFixture");
  const sources = Object.entries(metadata.sources) as [string, { keccak256: string }][];
  assert(sources.length > 0);
  for (const [name, entry] of sources) {
    const p = realpathSync(resolve(root, name));
    assert(name.endsWith(".sol") && !relative(realpathSync(root), p).startsWith(".."));
    assert.equal(ethers.keccak256(readFileSync(p)), entry.keccak256, "stale funding fixture");
  }
  const code = artifact.deployedBytecode.object;
  assert(ethers.isHexString(code, true) && code !== "0x");
  return { file, sha256: sha(bytes), code, codeHash: ethers.keccak256(code),
    scope: "fork-only isolated funded actor; protocol/token state and code unchanged; actual PoolManager callback settlement, not a production return route or opportunity" };
}
export function assertV4SettlementAssets(route: any, descriptor: any): "native" | "erc20" {
  assert(["zero-for-one", "one-for-zero"].includes(route.direction));
  const zeroForOne = route.direction === "zero-for-one", key = descriptor.poolKey;
  const rawIn = zeroForOne ? key.currency0 : key.currency1, rawOut = zeroForOne ? key.currency1 : key.currency0;
  assert(same(route.realTokenIn, rawIn) && same(route.realTokenOut, rawOut));
  const nativeIn = same(rawIn, ethers.ZeroAddress), nativeOut = same(rawOut, ethers.ZeroAddress);
  assert(!(nativeIn && nativeOut));
  assert.equal(route.executionAssets?.input, nativeIn ? "native" : "erc20");
  assert.equal(route.executionAssets?.output, nativeOut ? "native" : "erc20");
  return nativeIn || nativeOut ? "native" : "erc20";
}
export async function acceptV4NativeSettlement(c: {
  fixture: ReturnType<typeof loadV4FundingFixture>; route: any; descriptor: any; source: any; header: any;
  executor: string; owner: string; runtimeCode: any; amountIn: bigint; amountOut: bigint;
  keys: string[]; base: bigint[]; pin: any; report: any; result: any;
  rpc: (method: string, params: any[]) => Promise<any>;
  balance: (token: string, holder: string, overrides?: any) => Promise<bigint>;
  slotFor: (token: string, protectedAccount: string, holder?: string) => Promise<string>;
  build: (request: RuntimeSettlementRequest) => any;
}) {
  const assetMode = assertV4SettlementAssets(c.route, c.descriptor);
  const { tokenIn, tokenOut } = c.route, pair = [tokenIn, tokenOut];
  const manager = c.descriptor.managerBinding.manager;
  assert([receiver, funder].every(a => ![c.executor, c.owner, manager, ...pair, c.descriptor.poolKey.hooks].some(b => same(a, b))));
  for (const actor of [receiver, funder]) assert.equal(await c.rpc("eth_getCode", [actor, c.pin]), "0x", "fixture actor must be empty at N");
  const receiverKeys = await Promise.all(pair.map(t => c.slotFor(t, manager, receiver)));
  const funderKeys = await Promise.all(pair.map(t => c.slotFor(t, manager, funder)));
  const nativeBefore = 17n, actorBefore = 23n, outputOld = 10n ** 24n, inputOld = 101n;
  const paymentAmount = 1n; // independent fixture trigger, never derived from quote output
  const payee = c.route.executionAssets.input === "native" ? c.executor : manager;
  const paymentProgram = ethers.hexlify(new RuntimeAmountProgram()
    .call(tokenOut, TOKEN.encodeFunctionData("transfer", [funder, 0n]), { patches: [{ offset: 36, reg: 0 }] })
    .call(funder, FUND.encodeFunctionData("fund", [tokenIn, tokenOut, paymentAmount, c.amountIn, payee])).load(0, 0).bytes());
  const modes: { name: string; request: RuntimeSettlementRequest }[] = [
    { name: "direct-self", request: { kind: "direct-output", recipient: c.executor } },
    { name: "direct-external", request: { kind: "direct-output", recipient: receiver } },
    { name: "deferred-funding-fixture", request: { kind: "deferred-input", paymentAmount, paymentProgram } },
  ];
  c.result.nativeSettlements = [];
  for (const mode of modes) for (const inventory of [false, true]) {
    const deferred = mode.request.kind === "deferred-input", external = mode.name === "direct-external";
    const inputInitial = (inventory ? inputOld : 0n) + (deferred ? 0n : c.amountIn);
    const outputInitial = inventory ? outputOld : 0n;
    const overrides: any = {
      [c.owner]: { balance: ethers.toQuantity(100n * 10n ** 18n) },
      [c.executor]: { code: c.runtimeCode.code, balance: ethers.toQuantity(nativeBefore) },
      [receiver]: { balance: ethers.toQuantity(actorBefore) },
      [tokenIn]: { stateDiff: { [c.keys[0]!]: word(inputInitial), [receiverKeys[0]!]: word(313n), [funderKeys[0]!]: word(deferred ? c.amountIn : 0n) } },
      [tokenOut]: { stateDiff: { [c.keys[1]!]: word(outputInitial), [receiverKeys[1]!]: word(919n), [funderKeys[1]!]: word(0n) } },
      ...(deferred ? { [funder]: { code: c.fixture.code, balance: ethers.toQuantity(actorBefore) } } : {}),
    };
    const leg = c.build(mode.request); assert(leg, "V4 settlement decline");
    assert.deepEqual(leg.settlementRequest, mode.request);
    if (deferred) assert(same(leg.settlement.deferredInput, payee));
    const script = runtimeProgramScript(ethers.getBytes(leg.program), c.amountIn);
    const transaction = { from: c.owner, to: c.executor, data: buildExecuteCalldata(script), gas: "0x1000000", gasPrice: c.header.baseFeePerGas };
    const row: any = { assetMode, mode: mode.name, inventory, status: "failed", source: c.source, amountIn: c.amountIn,
      quoteAmountOut: c.amountOut, inputInitial, outputInitial, recipient: external ? receiver : c.executor,
      ...(deferred ? { paymentAmount, payee, fixture: c.fixture.scope, continuationInputBasis: "fixed 1 raw output unit; target swap amountIn remains full declared trial; no quote output enters runtime construction", fixtureCodeHash: c.fixture.codeHash } : {}),
      scriptHash: ethers.keccak256(script), stateOverridesSha256: sha(json(overrides)), transaction };
    c.result.nativeSettlements.push(row);
    assert.equal(await c.balance(tokenIn, c.executor, overrides), inputInitial);
    assert.equal(await c.balance(tokenOut, c.executor, overrides), outputInitial);
    assert.equal(await c.balance(tokenIn, funder, overrides), deferred ? c.amountIn : 0n);
    assert.equal(await c.balance(tokenOut, funder, overrides), 0n);
    row.trace = await c.rpc("debug_traceCall", [transaction, c.pin, { tracer: "callTracer", timeout: "30s", stateOverrides: overrides }]);
    assert(row.trace?.type === "CALL" && same(row.trace.from, c.owner) && same(row.trace.to, c.executor) && same(row.trace.input, transaction.data));
    assert(!row.trace.error && !row.trace.revertReason, "V4 settlement execution reverted");
    row.diff = await c.rpc("debug_traceCall", [transaction, c.pin, { tracer: "prestateTracer", tracerConfig: { diffMode: true }, timeout: "30s", stateOverrides: overrides }]);
    row.executorBalances = pair.map((t, i) => observeBalance(row.diff, t, c.keys[i]!, i ? outputInitial : inputInitial));
    assert.equal(row.executorBalances[0].delta, deferred ? 0n : -c.amountIn);
    assert.equal(row.executorBalances[1].delta, deferred ? c.amountOut - paymentAmount : external ? 0n : c.amountOut);
    row.receiverBalances = pair.map((t, i) => observeBalance(row.diff, t, receiverKeys[i]!, i ? 919n : 313n));
    assert.equal(row.receiverBalances[0].delta, 0n);
    assert.equal(row.receiverBalances[1].delta, external ? c.amountOut : 0n);
    row.nativeInventory = assertNativeInventory(row.diff, c.executor, nativeBefore);
    row.receiverNative = assertNativeInventory(row.diff, receiver, actorBefore);
    if (deferred) {
      row.funderBalances = pair.map((t, i) => observeBalance(row.diff, t, funderKeys[i]!, i ? 0n : c.amountIn));
      assert.equal(row.funderBalances[0].delta, -c.amountIn);
      assert.equal(row.funderBalances[1].delta, paymentAmount);
      assert.equal(row.executorBalances[1].delta + row.funderBalances[1].delta, c.amountOut, "independently observed whole output equals same-state quote");
      row.funderNative = assertNativeInventory(row.diff, funder, actorBefore);
    }
    // The same program cannot use the executor's old input to replace the
    // deferred funding budget; direct mode cannot use old output as input.
    const failureOverrides = structuredClone(overrides);
    failureOverrides[tokenIn].stateDiff[deferred ? funderKeys[0]! : c.keys[0]!] = word(0n);
    row.noFunding = await c.rpc("debug_traceCall", [transaction, c.pin, { tracer: "callTracer", timeout: "30s", stateOverrides: failureOverrides }]);
    assert(row.noFunding?.type === "CALL" && same(row.noFunding.input, transaction.data) && row.noFunding.error, "old inventory masked missing funding");
    row.status = "pass";
  }
}
