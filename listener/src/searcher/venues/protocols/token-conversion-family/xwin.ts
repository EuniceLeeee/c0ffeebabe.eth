import { Interface, getAddress, keccak256, zeroPadValue } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource, RequestRequirements } from "../../adapter-request-program.js";
import { assertSameSource, assertSource, callRequest, codeRequest, decodeAddress, decodeUint, requireRuntimeCode, returnedResult, sameAddress, successfulResult } from "../standard-family/common.js";
import { ABI, nonzero, positiveAmount } from "./variants.js";
import type { Direction } from "./types.js";

export const XWIN_ABI = new Interface([
  "function baseToken() view returns(address)", "function xWinSwap() view returns(address)",
  "function priceMaster() view returns(address)", "function lockingAddress() view returns(address)",
  "function getTargetNamesAddress() view returns(address[])",
  "function deposit(uint256,uint32) returns(uint256)", "function withdraw(uint256,uint32) returns(uint256)",
]);
export const XWIN_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
// Verified-source template identities, not deployment address allowlists.
export const XWIN_IMPLEMENTATION_HASH = "0xa2ee2404f7434f475888a0770162d1cbcb52d0c1925a0cbc334d3691e61e4387";
const PROXY_TEMPLATE_HASH = "0x2ba76c23cdb6d2a61a15d659f69dca9ae8067e48ed3f59d70d9de090f6f7de52";
// Zero is the strategy's own default-slippage overload. Both simulation and
// encoding use this exact argument, not the observed caller's optional value.
export const XWIN_SLIPPAGE = 0;
export function proveXwinProxy(code: string): { codeHash: string; proxyAdmin: string } {
  if (!/^0x[0-9a-fA-F]{2334}$/.test(code)) throw new Error("unsupported xWin proxy runtime");
  const start = 2 + 16 * 2;
  const operand = `0x${code.slice(start, start + 64)}`;
  const proxyAdmin = nonzero(`0x${operand.slice(-40)}`);
  if (code.slice(start - 2, start).toLowerCase() !== "7f" || zeroPadValue(proxyAdmin, 32).toLowerCase() !== operand.toLowerCase())
    throw new Error("xWin proxy admin immutable mismatch");
  const normalized = code.slice(0, start) + "0".repeat(64) + code.slice(start + 64);
  if (keccak256(normalized) !== PROXY_TEMPLATE_HASH) throw new Error("unsupported xWin proxy template");
  return { codeHash: keccak256(code), proxyAdmin };
}
export interface XwinSurface {
  readonly source: CanonicalSource;
  readonly target: string;
  readonly asset: string;
  readonly codeHash: string;
  readonly proxyAdmin: string;
  readonly implementation: string;
  readonly swap: string;
  readonly oracle: string;
  readonly locking: string;
  readonly targets: readonly string[];
  readonly supply: bigint;
}
export function xwinStateRequests(prefix: string, target: string): AdapterRequest[] {
  return [codeRequest(`${prefix}-proxy`, target),
    { id: `${prefix}-implementation`, kind: "get-storage", address: target, slot: XWIN_IMPLEMENTATION_SLOT },
    ...["baseToken", "xWinSwap", "priceMaster", "lockingAddress", "getTargetNamesAddress"].map(name =>
      callRequest(`${prefix}-${name}`, target, XWIN_ABI.encodeFunctionData(name), { kind: "executor" })),
    callRequest(`${prefix}-supply`, target, ABI.encodeFunctionData("totalSupply"), { kind: "executor" }),
  ];
}
export function decodeXwinSurface(results: readonly AdapterRequestResult[], prefix: string, target: string): XwinSurface {
  const source = assertSameSource(results.map(r => successfulResult(results, r.id)));
  const proxy = proveXwinProxy(requireRuntimeCode(results, `${prefix}-proxy`));
  const word = returnedResult(results, `${prefix}-implementation`).data;
  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(word)) throw new Error("invalid xWin implementation slot");
  const implementation = nonzero(`0x${word.slice(-40)}`);
  const asset = nonzero(decodeAddress(XWIN_ABI, "baseToken", results, `${prefix}-baseToken`));
  const swap = nonzero(decodeAddress(XWIN_ABI, "xWinSwap", results, `${prefix}-xWinSwap`));
  const oracle = nonzero(decodeAddress(XWIN_ABI, "priceMaster", results, `${prefix}-priceMaster`));
  const locking = getAddress(decodeAddress(XWIN_ABI, "lockingAddress", results, `${prefix}-lockingAddress`));
  const targets = (XWIN_ABI.decodeFunctionResult("getTargetNamesAddress", returnedResult(results, `${prefix}-getTargetNamesAddress`).data)[0] as string[]).map(nonzero);
  if (sameAddress(asset, target) || targets.length === 0 || new Set(targets.map(a => a.toLowerCase())).size !== targets.length || targets.some(a => sameAddress(a, target)))
    throw new Error("unsupported xWin asset topology");
  return { source, target: nonzero(target), ...proxy, implementation, asset, swap, oracle, locking, targets,
    supply: decodeUint(ABI, "totalSupply", results, `${prefix}-supply`) };
}
export function xwinDependencies(s: XwinSurface): string[] {
  return [...new Set([s.asset, s.swap, s.oracle, ...s.targets, ...(BigInt(s.locking) === 0n ? [] : [s.locking])].map(a => a.toLowerCase()))];
}
export function xwinDependencyRequests(prefix: string, s: XwinSurface): AdapterRequest[] {
  return [codeRequest(`${prefix}-implementation-code`, s.implementation),
    ...xwinDependencies(s).map((address, i) => codeRequest(`${prefix}-dependency-${i}`, address)),
    callRequest(`${prefix}-asset-decimals`, s.asset, ABI.encodeFunctionData("decimals")),
    callRequest(`${prefix}-share-decimals`, s.target, ABI.encodeFunctionData("decimals"), { kind: "executor" }),
  ];
}
export function checkXwinDependencies(results: readonly AdapterRequestResult[], prefix: string, s: XwinSurface): bigint {
  assertSource(assertSameSource(results.map(r => successfulResult(results, r.id))), s.source);
  if (keccak256(requireRuntimeCode(results, `${prefix}-implementation-code`)) !== XWIN_IMPLEMENTATION_HASH)
    throw new Error("unsupported xWin implementation code");
  xwinDependencies(s).forEach((_, i) => requireRuntimeCode(results, `${prefix}-dependency-${i}`));
  const decimals = decodeUint(ABI, "decimals", results, `${prefix}-asset-decimals`);
  if (decimals > 18n || decodeUint(ABI, "decimals", results, `${prefix}-share-decimals`) !== 18n)
    throw new Error("unsupported xWin decimals");
  return 10n ** decimals;
}
export function assertXwinBinding(s: XwinSurface, d: { asset: string; codeHash: string; proxyAdmin: string }): void {
  if (!sameAddress(s.asset, d.asset) || s.codeHash !== d.codeHash || !sameAddress(s.proxyAdmin, d.proxyAdmin))
    throw new Error("xWin static binding changed");
}
export function xwinCalldata(direction: Direction, amount: bigint): string {
  positiveAmount(amount);
  if (!["mint", "redeem"].includes(direction)) throw new Error("invalid xWin conversion direction");
  return XWIN_ABI.encodeFunctionData(direction === "mint" ? "deposit" : "withdraw", [amount, XWIN_SLIPPAGE]);
}
const xwinEffects = ["return-data", "token-delta", "native-delta", "total-supply-delta", "logs"] as const;
export const xwinSimulationRequirements: RequestRequirements = Object.freeze({
  transports: ["effect-delta-simulation"] as const, caller: "executor", effects: xwinEffects,
});
export interface XwinPrefixStep { readonly direction: Direction; readonly amountIn: bigint; readonly amountOut: bigint }
export function xwinSimulation(id: string, s: XwinSurface, direction: Direction, amount: bigint,
  prefix: readonly XwinPrefixStep[] = []): AdapterRequest {
  positiveAmount(amount);
  const caller = { kind: "executor" as const };
  const approvals = (n: bigint) => [0n, n].map(value => ({ caller, to: s.asset, data: ABI.encodeFunctionData("approve", [s.target, value]) }));
  const first = prefix[0] ?? { direction, amountIn: amount };
  const initialToken = first.direction === "mint" ? s.asset : s.target;
  return { id, kind: "effect-delta-simulation",
    preCalls: [...prefix.flatMap(step => [
      ...(step.direction === "mint" ? approvals(step.amountIn) : []),
      { caller, to: s.target, data: xwinCalldata(step.direction, step.amountIn) },
      ...(step.direction === "mint" ? [{ caller, to: s.asset, data: ABI.encodeFunctionData("approve", [s.target, 0n]) }] : []),
    ]), ...(direction === "mint" ? approvals(amount) : [])],
    call: { caller, executionMode: "impersonated-call-frame", to: s.target, data: xwinCalldata(direction, amount) },
    // Quote sandbox only: seed the first input, never the later leg. Clear the
    // other route token so old executor inventory cannot conceal short output.
    overrideIntent: { caller, tokenBalances: [{ token: initialToken, amount: first.amountIn },
      ...(prefix.length ? [{ token: first.direction === "mint" ? s.target : s.asset, amount: 0n }] : [])] },
    observeTokenBalances: [...new Set([s.asset, s.target, ...s.targets].map(a => a.toLowerCase()))].map(token => ({ token, account: caller })),
    observe: xwinEffects,
  };
}
export function decodeXwinReceipt(results: readonly AdapterRequestResult[], id: string, s: XwinSurface,
  direction: Direction, amountIn: bigint, executor?: string, prefix: readonly XwinPrefixStep[] = []) {
  positiveAmount(amountIn);
  const result = returnedResult(results, id);
  assertSource(result.source, s.source);
  const amountOut = BigInt(XWIN_ABI.decodeFunctionResult(direction === "mint" ? "deposit" : "withdraw", result.data)[0]);
  positiveAmount(amountOut);
  const deltas = result.effects?.tokenDeltas ?? [];
  const shareRows = deltas.filter(row => sameAddress(row.token, s.target));
  if (shareRows.length !== 1) throw new Error("xWin missing/duplicate share balance");
  const actor = nonzero(shareRows[0]!.account);
  if ([s.target, s.asset, s.proxyAdmin, ...s.targets].some(a => sameAddress(a, actor)) || (executor !== undefined && !sameAddress(actor, executor)))
    throw new Error("xWin executor/admin binding mismatch");
  // ERC20-only conversion: the impersonated call frame must neither consume
  // nor return native currency. Missing evidence is not an observed zero.
  const native = result.effects?.nativeDeltas ?? [];
  if (native.length !== 1 || !sameAddress(native[0]!.account, actor) || native[0]!.delta !== 0n)
    throw new Error("xWin native conservation mismatch");
  // The transport observes the entire sibling-call sequence, not just main.
  const steps = [...prefix, { direction, amountIn, amountOut }];
  const expectedShares = steps.reduce((sum, step) => sum + (step.direction === "mint" ? step.amountOut : -step.amountIn), 0n);
  const expectedAsset = steps.reduce((sum, step) => sum + (step.direction === "mint" ? -step.amountIn : step.amountOut), 0n);
  const tokens = [...new Set([s.target, s.asset, ...s.targets].map(a => a.toLowerCase()))];
  if (deltas.length !== tokens.length) throw new Error("xWin effect scope mismatch");
  for (const token of tokens) {
    const rows = deltas.filter(row => sameAddress(row.token, token) && sameAddress(row.account, actor));
    const expected = sameAddress(token, s.target) ? expectedShares : sameAddress(token, s.asset) ? expectedAsset : 0n;
    if (rows.length !== 1 || rows[0]!.delta !== expected) throw new Error("xWin actual balance mismatch");
  }
  const supplies = (result.effects?.totalSupplyDeltas ?? []).filter(row => sameAddress(row.token, s.target));
  if (supplies.length !== 1 || supplies[0]!.delta !== expectedShares) throw new Error("xWin supply mismatch");
  const transfers = (result.effects?.logs ?? []).filter(log => sameAddress(log.address, s.target)).flatMap(log => {
    try { const event = ABI.parseLog({ topics: [...log.topics], data: log.data }); return event?.name === "Transfer" ? [event] : []; } catch { return []; }
  }).filter(event => (BigInt(event.args.from) === 0n && sameAddress(event.args.to, actor)) ||
    (BigInt(event.args.to) === 0n && sameAddress(event.args.from, actor)));
  if (transfers.length !== steps.length || steps.some((step, index) => {
    const event = transfers[index]!;
    return !(step.direction === "mint" ? BigInt(event.args.from) === 0n && sameAddress(event.args.to, actor) :
      BigInt(event.args.to) === 0n && sameAddress(event.args.from, actor)) ||
      BigInt(event.args.value) !== (step.direction === "mint" ? step.amountOut : step.amountIn);
  }))
    throw new Error("xWin mint/burn log mismatch");
  return { source: result.source, actor, amountOut };
}
