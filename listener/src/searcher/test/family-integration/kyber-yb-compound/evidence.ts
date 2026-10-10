// Assertions/observation only. No admission, pricing math, scheduler or mock EVM.
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { KYSWAP_POOL_INTERFACE as KYBER } from "../../../venues/swaps/kyberswap-elastic-family/abi.js";
import { ALGEBRA_POOL_INTERFACE as ALGEBRA } from "../../../venues/swaps/algebra-integral-family/abi.js";
import { LT_INTERFACE as LT } from "../../../venues/protocols/yieldbasis-lt-family/abi.js";
import { CTOKEN_INTERFACE as CT } from "../../../venues/protocols/compound-ctoken-family/abi.js";
import { ERC4626_INTERFACE as CUSTODIAN } from "../../../venues/protocols/erc4626-family/abi.js";
import { successfulRedeemCalls, classifyRedeemLog } from "../../../venues/protocols/compound-ctoken-family/test/history-evidence.js";
import { assertHistoricalPriceDirection } from "../three-family/historical-input-observations.js";
import { originalEkuboLeg } from "../../../venues/swaps/ekubo-family/test/history-evidence.js";
import { originalXwinLeg } from "../../../venues/protocols/token-conversion-family/test/history-evidence.js";
import { originalStandardErc4626Leg } from "../../../venues/protocols/erc4626-family/test/history-evidence.js";
import { originalEtherTokenLeg } from "../../../venues/protocols/ethertoken-native-redeem-family/test/history-evidence.js";
import { originalSelfBurnLeg } from "../../../venues/protocols/self-burn-native-family/test/history-evidence.js";
import { blockScanEdgeKey } from "../../../venues/blockscan-state-capability.js";
export { json, sha, word, observeBalance } from "../../../venues/protocols/set-redemption-family/test/historical-runtime-observations.js";

export const SAMPLES = {
  "self-burn-native": { family: "protocol:self-burn-native", number: 25619948,
    tx: "0xb51c9e139384978731d58c526d337bf78ac223647c5c0b570a574855bda723a7",
    instances: ["0x292a477e521230fe230c13c93374adde8ddec1c1"] },
  "ethertoken-native": { family: "protocol:ethertoken-native-redeem", number: 25648967,
    tx: "0xdf54ad38d4b812c4ab23ba6225543caaa433897f9454414c70bf7fda1290694e",
    instances: ["0xc0829421c1d260bd3cb3e0f06cfe2d52db2ce315"] },
  "erc4626-fluid": { family: "protocol:erc4626", number: 26030897,
    tx: "0xf321cd5b5f7b29f933ae98dd7444af919e8eeac1854c6a7389ce09ea3deb7212",
    instances: ["0x90551c1795392094fe6d29b758eccd233cfaa260",
      "0x2411802d8bea09be0af8fd8d08314a63e706b29c"] },
  "xwin-mint": { family: "protocol:token-conversion", number: 26075823,
    tx: "0x10b7f1d5ac14281c916b4f94bd8c781c2795bfdd7d1a527885e83f4f22ec9ae3",
    instances: ["0x49edcc5aab2e349c1f71c27c98fe9c65b01745b1"] },
  "xwin-redeem": { family: "protocol:token-conversion", number: 26075823,
    tx: "0x10b7f1d5ac14281c916b4f94bd8c781c2795bfdd7d1a527885e83f4f22ec9ae3",
    instances: ["0x49edcc5aab2e349c1f71c27c98fe9c65b01745b1"] },
  "ekubo-native": { family: "custom-swap:ekubo-router-v1", number: 26088150,
    tx: "0xed014b884a511a4abd1c0e5f218be8dbcd1209cd7bb645d440334fdfecf928f0",
    instances: ["0x77e86b8f5da17873d7bdd70efc68a06dd3edc1d6e36b5bd65ff45eece33a31e4"] },
  "ekubo-erc20": { family: "custom-swap:ekubo-router-v1", number: 25943731,
    tx: "0x868b69ff429fea8ec1e483c8be1d9e236aabe00065e355ff5a60af0596a75847",
    instances: ["0x4cbcf9747988eb06d17794c224d3e4a70101c3b70d6c5819069af651cff06b7b"] },
  frax: { family: "protocol:erc4626", number: 26017168,
    tx: "0x02bf41c595d08e397b90edaaee8a00f4521d1d7c2b0f538b1d1597e4e1ccacec",
    instances: ["0x4f95c5ba0c7c69fb2f9340e190ccee890b3bd87c"] },
  kyber: { family: "kyberswap-elastic", number: 25953136,
    tx: "0x023fd22564532537a14977836049e12e8df706c4872020a9302fdfbb383230d5",
    instances: ["0xf138462c76568cdfd77c6eb831e973d6963f2006"] },
  yb: { family: "protocol:yieldbasis-lt", number: 26003536,
    tx: "0x022a9ff85219675bcf0a0a2b17c76ac72b98d5e2c4177bc104edff56e706ee77",
    instances: ["0x2b9c9f3bdceb5d8e36a4704f08a78fca53343cea"] },
  compound: { family: "protocol:compound-ctoken", number: 25944463,
    tx: "0x032b820506f44423a7f62918464e8e735619ff463bb6ecce1b3d0d6299ba99df",
    instances: ["0x39aa39c021dfbae8fac545936693ac917d5e7563", "0x5d3a536e4d6dbd6114cc1ead35777bab948e3643"] },
  algebra: { family: "swap:algebra-integral", number: 26018534,
    tx: "0x02175d2ac2e806bc6e1033cae640cf45509b7ded4a2e64ebcbba9c425afff5b7",
    instances: ["0x76a278bd71f566ee6ba2fe438f6099c8d8f98f43"] },
  algebra2: { family: "swap:algebra-integral", number: 26030898,
    tx: "0x006223028f05865619d07584c43cf67cb608705d04ebc732e15bf40869d030b8",
    instances: ["0x915fd34cadd63907b51eb64dddc2eadd114a0bed"] },
  algebra3: { family: "swap:algebra-integral", number: 26013785,
    tx: "0x1f0e69a9d9be232986b81216ce341e5d3dea9d6241074f2331cf8bb4d7ecaacc",
    instances: ["0xc0cf00079741ab9db6aceb5f7fe2f69c243c1aae"] },
  algebra4: { family: "swap:algebra-integral", number: 25946003,
    tx: "0x246160cdd6c0048a58076fc96a49d9ee18f4438a42e8bcb0727c6b42e06b86b8",
    instances: ["0x65937a5421603612c243300b250f64e58afcdbc4"] },
  algebra5: { family: "swap:algebra-integral", number: 25930616,
    tx: "0x4a12dbe50e89057b07ccfc471d0db0c406be65e9d82d6e29a55284844e30cd85",
    instances: ["0x177f07c0843776b2a6342ed6c488af64e6f2fd65"] },
  algebra6: { family: "swap:algebra-integral", number: 25975130,
    tx: "0xacc347b03f7b6fd9efe0f50035f2c63720ac2e2954229ac8fe7465dcc6f23ef0",
    instances: ["0xf53dcd757f208fb4f3631d16d8c17ddb21a9d98d"] },
} as const;
export type SampleKey = keyof typeof SAMPLES;
export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** EIP-7702 delegation designators are valid origin-account code, not an
 * arbitrary contract sender. The harness preserves this code; it never executes
 * or authorizes a delegation and never signs a transaction. */
export function assertOriginAccountCode(code: string): void {
  assert(code === "0x" || /^0xef0100[0-9a-f]{40}$/i.test(code),
    "owner must have empty code or an exact EIP-7702 delegation designator");
}

/** Test-only executor upgrade, never a chain-state/admission override. The
 * replacement comes exclusively from the source-verified current BotVM artifact.
 * Require explicit binding to the old actor code; default refusal stays intact. */
export function assertExecutorCode(code: string, trustedRuntime: string, expectedHistoricalHash?: string) {
  assert(ethers.isHexString(code, true) && ethers.isHexString(trustedRuntime, true) && trustedRuntime !== "0x");
  const historicalHash = ethers.keccak256(code), runtimeHash = ethers.keccak256(trustedRuntime);
  const replacement = code !== "0x" && !same(code, trustedRuntime);
  if (expectedHistoricalHash !== undefined) {
    assert(ethers.isHexString(expectedHistoricalHash, 32), "expected executor code hash must be bytes32");
    assert(same(historicalHash, expectedHistoricalHash), "historical executor code hash differs");
    assert(replacement, "explicit executor upgrade must identify an existing different runtime");
  } else assert(!replacement, "refuse replacing an unrelated actor contract without a pinned explicit test upgrade");
  return { historicalHash, runtimeHash, replacement, historicalRuntimeExecuted: same(code, trustedRuntime),
    scope: "local eth_call/debug_traceCall code overlay only; same executor/origin; no protocol or permission override" };
}

/** A storage-access list can contain a proxy implementation slot. Overriding
 * that slot may produce empty return data, which disproves the balance-slot
 * candidate; it is not a successful observation or a transport failure. */
export function matchesBalanceSlotProbe(data: string, expected: bigint): boolean {
  return ethers.isHexString(data, 32) && BigInt(data) === expected;
}

/** Only a declared EVM revert from a local eth_call can disprove an injected
 * storage-slot hypothesis. Transport, unknown server and upstream errors fail. */
export function isLocalBalanceProbeRevert(error: unknown): boolean {
  const e = error as { localCall?: unknown; rpcCode?: unknown; returnData?: unknown } | null;
  return e instanceof Error && e.localCall === true && e.rpcCode === 3 && ethers.isHexString(e.returnData, true);
}

export const ERC20 = new ethers.Interface(["function balanceOf(address) view returns(uint256)",
  "function totalSupply() view returns(uint256)", "event Transfer(address indexed from,address indexed to,uint256 value)"]);

export function options(argv: string[]) {
  const v = new Map<string, string>();
  const required = ["--family", "--ready", "--prices", "--port", "--out"];
  const names = [...required, "--reference-prices", "--reference-edges", "--expected-executor-code-hash"];
  for (let i = 0; i < argv.length; i += 2) {
    assert(names.includes(argv[i]!) && !v.has(argv[i]!), "unknown/duplicate argument");
    const value = argv[i + 1]; assert(value && !value.startsWith("--"), "missing argument"); v.set(argv[i]!, value);
  }
  assert(required.every(k => v.has(k)), "all five arguments required");
  assert.equal(v.has("--reference-prices"), v.has("--reference-edges"), "reference prices and edges must be paired");
  const referenceEdges: unknown = v.has("--reference-edges") ? JSON.parse(v.get("--reference-edges")!) : [];
  assert(Array.isArray(referenceEdges) && referenceEdges.every(k => typeof k === "string" && k.length > 0));
  assert.equal(new Set(referenceEdges).size, referenceEdges.length, "duplicate reference edge");
  if (v.has("--reference-prices")) assert(referenceEdges.length > 0, "select reference edges explicitly");
  const family = v.get("--family")!;
  assert(Object.hasOwn(SAMPLES, family), "only the registered fixed Family samples are supported");
  const portText = v.get("--port")!; assert(/^[1-9][0-9]*$/.test(portText));
  const port = Number(portText); assert(port >= 1024 && port <= 65535 && Number.isSafeInteger(port));
  const expectedExecutorCodeHash = v.get("--expected-executor-code-hash");
  if (expectedExecutorCodeHash !== undefined) assert(ethers.isHexString(expectedExecutorCodeHash, 32));
  return { family: family as SampleKey, port, ready: v.get("--ready")!, prices: v.get("--prices")!, out: v.get("--out")!,
    referencePrices: v.get("--reference-prices"), referenceEdges: referenceEdges as string[], expectedExecutorCodeHash };
}

export function assertHeader(actual: any, expected: any): void {
  // Missing mandatory fields must not pass by comparing undefined to undefined.
  for (const k of ["number", "hash", "parentHash", "stateRoot", "timestamp", "baseFeePerGas", "gasLimit", "miner", "mixHash"]) {
    assert(typeof expected?.[k] === "string" && typeof actual?.[k] === "string", "missing N header " + k);
    assert.equal(actual[k].toLowerCase(), expected[k].toLowerCase(), "N header changed: " + k);
  }
  assert.equal(actual.excessBlobGas, expected.excessBlobGas);
}

export function assertPriceInput(saved: any, provenance: any, ready: any, input: {
  readySha256: string; sourceTreeSha256: string; number: number;
}): void {
  for (const p of [saved, provenance]) assert.equal(p.readySha256, input.readySha256, "prices refer to another Ready");
  assert.equal(provenance.executionMode, "source-block", "N+1 is not same-N acceptance");
  assert.equal(provenance.through, "prices"); assert.equal(provenance.broadcast, false);
  assert.equal(provenance.implementation?.sourceTreeSha256, input.sourceTreeSha256, "stale production source fingerprint");
  assert.equal(BigInt(provenance.chainId), 1n);
  assert.equal(ready.universeRange.fromBlock, input.number); assert.equal(ready.universeRange.toBlock, input.number);
  for (const source of [ready.cutoff, provenance.stateSource, provenance.topologySource,
    { number: saved.runtime?.sourceBlock, hash: saved.runtime?.sourceBlockHash },
    { number: saved.runtime?.pricing?.sourceBlock, hash: saved.runtime?.pricing?.sourceBlockHash }]) {
    assert.equal(source?.number, input.number); assert(same(source.hash, ready.cutoff.hash), "source mismatch");
  }
  assert.equal(Number(BigInt(provenance.sourceHeader.number)), input.number);
  assert(same(provenance.sourceHeader.hash, ready.cutoff.hash));
}

/** A missing/not-quoted effective row is an unmet gate, never a fabricated P. */
export function productionAmount(row: any, raw: any, edge: any, source: { number: number; hash: string }, generation: number) {
  if (!row || row.status !== "quoted") return { status: "unmet" as const, reason: row?.status ?? "missing-effective-row" };
  assertHistoricalPriceDirection(edge, row, edge.instanceKey);
  assert(raw && Number.isFinite(raw.mid) && raw.mid > 0, "quoted effective row lacks valid production raw mid");
  assert(typeof row.amountIn === "bigint" && row.amountIn > 0n && row.amountIn <= ethers.MaxUint256);
  assert(typeof row.amountOut === "bigint" && row.amountOut > 0n && row.amountOut <= ethers.MaxUint256);
  assert.equal(row.quotedAt?.number, source.number); assert(same(row.quotedAt.hash, source.hash));
  assert.equal(row.quotedAt.generation, generation, "carried/stale row is not a fresh N measurement");
  return { status: "met" as const, amountIn: row.amountIn as bigint, amountOut: row.amountOut as bigint };
}

/** Explicitly borrow only amountIn from a saved production-stage graph. The
 * donor can be carried and from another block; its output/identity/valuation
 * never substitutes for the target's same-N quote, Ready or execution. */
export function splicedProductionAmount(saved: any, declaration: any, edgeKeys: readonly string[], tokenIn: string) {
  const runtime = saved.runtime, table = runtime?.pricing?.effectiveMids;
  assert(table?.rows instanceof Map && Array.isArray(runtime.graph?.edges));
  assert(declaration?.benchmark === "effective-update" && declaration.liveStarted === false &&
    declaration.broadcast === false && declaration.signing === false, "expected saved production-stage benchmark");
  assert(/^[0-9a-f]{40}$/i.test(declaration.head), "missing donor source commit");
  assert(Array.isArray(declaration.bindings), "missing donor source/Ready bindings");
  const bound = (path: string) => {
    const matches = declaration.bindings.filter((b: any) => b.path === path);
    assert(matches.length === 1 && /^[0-9a-f]{64}$/i.test(matches[0].sha256), "missing/ambiguous donor binding: " + path);
    return matches[0];
  };
  assert(typeof saved.readyPath === "string" && /^[0-9a-f]{64}$/i.test(saved.readySha256));
  assert.equal(bound(saved.readyPath).sha256, saved.readySha256, "donor Ready contradicts declaration");
  for (const suffix of ["/listener/benchmarks/effective-update.ts", "/listener/src/searcher/blockscan-runtime-loop.ts", "/listener/src/searcher/main.ts"]) {
    const matches = declaration.bindings.filter((b: any) => typeof b.path === "string" && b.path.endsWith(suffix));
    assert.equal(matches.length, 1, "missing/ambiguous production source binding"); bound(matches[0].path);
  }
  assert.equal(declaration.graphEdges, runtime.graph.edges.length);
  assert.deepEqual(saved.cfg, declaration.cfg, "donor configuration mismatch");
  const source = { number: runtime.sourceBlock, hash: runtime.sourceBlockHash, generation: runtime.generation };
  assert(Number.isSafeInteger(source.number) && source.number >= 0 && ethers.isHexString(source.hash, 32));
  assert(Number.isSafeInteger(source.generation) && source.generation >= 0);
  assert.equal(saved.header?.number, source.number); assert.equal(saved.header?.hash, source.hash);
  assert.equal(table.source?.number, source.number); assert.equal(table.source?.hash, source.hash);
  assert.equal(table.source?.generation, source.generation);
  assert.equal(runtime.pricing.generation, source.generation);
  assert.equal(runtime.pricing.sourceBlock, source.number); assert.equal(runtime.pricing.sourceBlockHash, source.hash);
  assert(declaration.notifications?.some((n: any) => n.number === source.number && n.hash === source.hash));
  assert(edgeKeys.length > 0 && new Set(edgeKeys).size === edgeKeys.length);
  const selected = edgeKeys.map(key => {
    const row = table.rows.get(key);
    assert(row?.edgeId === key && row.status === "quoted", "reference must be a recorded quoted row");
    const edges = runtime.graph.edges.filter((e: any) => blockScanEdgeKey(e) === key);
    assert.equal(edges.length, 1, "reference row absent/ambiguous in donor graph");
    assertHistoricalPriceDirection(edges[0], row, edges[0].instanceKey);
    assert(ethers.isAddress(row.tokenIn) && ethers.isAddress(row.tokenOut));
    for (const amount of [row.amountIn, row.amountOut]) assert(typeof amount === "bigint" && amount > 0n && amount <= ethers.MaxUint256);
    const q = row.quotedAt;
    assert(Number.isSafeInteger(q?.number) && q.number >= 0 && q.number <= source.number && ethers.isHexString(q.hash, 32));
    assert(Number.isSafeInteger(q.generation) && q.generation >= 0 && q.generation <= source.generation);
    if (q.number === source.number) assert(q.hash === source.hash && q.generation === source.generation, "inconsistent fresh donor");
    else assert(q.generation < source.generation, "inconsistent carried donor");
    if (q.number === source.number - 1) {
      assert(ethers.isHexString(saved.header.parentHash, 32));
      assert.equal(q.hash, saved.header.parentHash, "carried row contradicts donor parent");
    }
    for (const n of declaration.notifications.filter((n: any) => n.number === q.number)) {
      assert.equal(q.hash, n.hash, "row contradicts recorded notification");
    }
    return row;
  });
  const matches = selected.filter(row => same(row.tokenIn, tokenIn));
  assert.equal(matches.length, 1, "select exactly one reference row per target input token");
  const donorRow = matches[0];
  return { kind: "spliced-recorded-input" as const, amountIn: donorRow.amountIn as bigint, donorRow,
    tableSource: source, freshness: donorRow.quotedAt.number === source.number ? "fresh" : "carried",
    naturalTargetValuation: "unmet; not supplied by this input splice" };
}

function successfulCalls(trace: any, target: string, selector: string): any[] {
  const result: any[] = [];
  const visit = (f: any) => {
    if (!f || f.error || f.revertReason) return;
    if (f.type === "CALL" && same(f.to ?? "", target) && f.input?.slice(0, 10) === selector) result.push(f);
    for (const c of f.calls ?? []) visit(c);
  };
  visit(trace); return result;
}

/** Extract only one unambiguous real successful call + event per instance. */
export function originalLeg(key: SampleKey, instance: string, descriptor: any, receipt: any, trace: any) {
  assert(!trace.error && !trace.revertReason, "original transaction reverted");
  if (key === "ethertoken-native") return originalEtherTokenLeg(instance, descriptor, receipt, trace);
  if (key === "self-burn-native") return originalSelfBurnLeg(instance, descriptor, receipt, trace);
  if (key === "erc4626-fluid")
    return originalStandardErc4626Leg(instance, descriptor, receipt, trace);
  if (key === "xwin-mint" || key === "xwin-redeem")
    return originalXwinLeg(instance, descriptor, receipt, trace, key === "xwin-mint" ? "mint" : "redeem");
  if (SAMPLES[key].family === "custom-swap:ekubo-router-v1") return originalEkuboLeg(instance, descriptor, receipt, trace);
  const isSwap = key === "kyber" || SAMPLES[key].family === "swap:algebra-integral";
  const abi = key === "kyber" ? KYBER : isSwap ? ALGEBRA : key === "yb" ? LT : key === "frax" ? CUSTODIAN : CT;
  const event = isSwap ? "Swap" : key === "yb" || key === "frax" ? "Withdraw" : "Redeem";
  const logs = receipt.logs.filter((l: any) => same(l.address, instance) && same(l.topics?.[0] ?? "", abi.getEvent(event)!.topicHash));
  assert.equal(logs.length, 1, "ambiguous original event count");
  const a = abi.parseLog(logs[0])!.args;
  let tokenIn: string, tokenOut: string, amountIn: bigint, amountOut: bigint, caller: string, recipient: string;
  let originalInterface: string, comparison: string;
  if (isSwap) {
    const calls = successfulCalls(trace, instance, abi.getFunction("swap")!.selector); assert.equal(calls.length, 1);
    const c = calls[0], data = abi.decodeFunctionData("swap", c.input), out = abi.decodeFunctionResult("swap", c.output);
    assert.equal(out[0], a.amount0); assert.equal(out[1], a.amount1);
    const zeroIn = a.amount0 > 0n && a.amount1 < 0n;
    assert(zeroIn || (a.amount1 > 0n && a.amount0 < 0n), "not a settled one-input swap");
    tokenIn = zeroIn ? descriptor.token0 : descriptor.token1; tokenOut = zeroIn ? descriptor.token1 : descriptor.token0;
    amountIn = BigInt(zeroIn ? a.amount0 : a.amount1); amountOut = -BigInt(zeroIn ? a.amount1 : a.amount0);
    const required = key === "kyber" ? data.swapQty : data.amountRequired;
    const direction = key === "kyber" ? data.isToken0 : data.zeroToOne;
    assert(required > 0n && required === amountIn && direction === zeroIn, "sample is not full exact-input swap");
    caller = c.from; recipient = data.recipient;
    assert(same(a.sender, caller) && same(a.recipient, recipient)); originalInterface = "swap/exact-input";
    comparison = "same interface at N-end; original pre-call state NOT restored";
  } else if (key === "yb") {
    const selector = LT.getFunction("withdraw(uint256,uint256)")!.selector;
    const calls = successfulCalls(trace, instance, selector); assert.equal(calls.length, 1, "ordinary two-argument withdraw required");
    const c = calls[0], data = LT.decodeFunctionData("withdraw(uint256,uint256)", c.input);
    tokenIn = descriptor.share; tokenOut = descriptor.asset; amountIn = a.shares; amountOut = a.assets;
    caller = c.from; recipient = a.receiver;
    assert.equal(data[0], amountIn); assert.equal(LT.decodeFunctionResult("withdraw(uint256,uint256)", c.output)[0], amountOut);
    assert(same(a.sender, caller) && same(a.owner, caller) && same(recipient, caller));
    originalInterface = "withdraw(uint256,uint256)"; comparison = "same interface at N-end; original pre-call state NOT restored";
  } else if (key === "frax") {
    const calls = successfulCalls(trace, instance, CUSTODIAN.getFunction("redeem")!.selector);
    assert.equal(calls.length, 1, "one direct synchronous Custodian redeem required");
    const c = calls[0], data = CUSTODIAN.decodeFunctionData("redeem", c.input);
    assert(descriptor.custodian && !same(descriptor.share, instance), "external-share identity required");
    tokenIn = descriptor.share; tokenOut = descriptor.asset; amountIn = BigInt(a.shares); amountOut = BigInt(a.assets);
    caller = c.from; recipient = String(data[1]);
    assert.equal(data[0], amountIn); assert(same(data[2], caller) && same(a.sender, caller) && same(a.owner, caller) && same(a.receiver, recipient));
    assert.equal(CUSTODIAN.decodeFunctionResult("redeem", c.output)[0], amountOut);
    originalInterface = "redeem(uint256,address,address)";
    comparison = "synchronous external-share redemption at N-end; original pre-call state NOT restored";
  } else {
    const calls = successfulRedeemCalls(trace, new Set([instance.toLowerCase()]));
    const kind = classifyRedeemLog({ emitter: instance, redeemer: a.redeemer, redeemTokens: a.redeemTokens, redeemAmount: a.redeemAmount }, calls, logs.length);
    assert.notEqual(kind, "unverified-or-ambiguous");
    tokenIn = descriptor.share; tokenOut = descriptor.underlying; amountIn = a.redeemTokens; amountOut = a.redeemAmount;
    caller = a.redeemer; recipient = a.redeemer; originalInterface = calls[0]!.method;
    comparison = kind === "underlying-output"
      ? "redeemUnderlying observed; burned shares mapped to redeem at N-end, NOT original interface/pre-call parity"
      : "redeem at N-end; original pre-call state NOT restored";
  }
  assert(ethers.isAddress(tokenIn) && ethers.isAddress(tokenOut) && !same(tokenIn, tokenOut));
  assert(amountIn > 0n && amountOut > 0n);
  // Independent receipt transfer to the observed recipient, not whole-TX net profit.
  const received = receipt.logs.filter((l: any) => same(l.address, tokenOut) && l.topics?.[0] === ERC20.getEvent("Transfer")!.topicHash)
    .map((l: any) => ERC20.parseLog(l)!.args).filter((t: any) => same(t.to, recipient) && t.value === amountOut);
  assert.equal(received.length, 1, "original output receipt is missing/ambiguous");
  return { tokenIn: tokenIn.toLowerCase(), tokenOut: tokenOut.toLowerCase(), amountIn, amountOut,
    caller: caller.toLowerCase(), recipient: recipient.toLowerCase(), originalInterface, comparison, logIndex: logs[0].logIndex };
}

export function assertReceipt(receipt: any, tx: string, header: any): void {
  assert(same(receipt?.transactionHash ?? "", tx) && same(receipt.blockHash, header.hash));
  assert.equal(BigInt(receipt.blockNumber), BigInt(header.number)); assert.equal(BigInt(receipt.status), 1n);
  for (const l of receipt.logs) {
    assert(!l.removed && same(l.transactionHash, tx) && same(l.blockHash, header.hash));
    assert.equal(BigInt(l.blockNumber), BigInt(header.number));
  }
}

export function assertDeltas(input: { before: bigint; after: bigint; delta: bigint }, output: { before: bigint; after: bigint; delta: bigint }, amountIn: bigint, quoteOut: bigint) {
  assert.equal(input.delta, -amountIn, "real input debit mismatch");
  assert.equal(input.after, input.before - amountIn, "old input inventory consumed");
  assert.equal(output.delta, quoteOut, "actual credited output differs from quote (inventory cannot top up)");
  assert.equal(output.after, output.before + quoteOut, "old output inventory consumed");
}

/** An execution-boundary conversion must restore all pre-existing native ETH.
 * Observe the state diff independently of prescribed WETH deposit amounts. */
export function assertNativeInventory(diff: any, actor: string, before: bigint) {
  const account = actor.toLowerCase(), pre = diff.pre?.[account], post = diff.post?.[account];
  if (pre?.balance !== undefined) assert.equal(BigInt(pre.balance), before, "native prestate differs from injected baseline");
  const after = post?.balance === undefined ? before : BigInt(post.balance);
  // A deleted actor cannot be interpreted as unchanged native inventory.
  assert(!(pre && !post), "actor removed from poststate");
  assert.equal(after, before, "native inventory spent or new native output left unwrapped");
  return { before, after, delta: after - before };
}

/** The same guard wraps the real production Exact/quoted calls in the runner. */
export function constructionGuard() {
  let building = false;
  const counts = { exact: 0, quoted: 0, forbiddenDuringBuild: 0 };
  const check = () => { if (building) { counts.forbiddenDuringBuild++; throw new Error("Exact/quoted/RPC forbidden during runtime build"); } };
  return { counts, check,
    exact<T>(f: () => T): T { check(); counts.exact++; return f(); },
    quoted<T>(f: () => T): T { check(); counts.quoted++; return f(); },
    build<T>(f: () => T): T { assert(!building); building = true; try { return f(); } finally { building = false; } },
    runtime<T extends object>(runtime: T): T { return new Proxy(runtime, { get(target, key, receiver) {
      if (!["callerAuthority", "generationFence"].includes(String(key))) check(); return Reflect.get(target, key, receiver);
    } }); },
  };
}
