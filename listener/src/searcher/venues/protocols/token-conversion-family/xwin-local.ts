import { Interface, keccak256, zeroPadValue } from "ethers";
import { bindRequestResultRound } from "../../adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult } from "../../adapter-request-program.js";
import { assertSameSource, assertSource, callRequest, codeRequest, requireRuntimeCode, returnedResult, sameAddress, successfulResult } from "../standard-family/common.js";
import { UNIV3_STATE_READER, UNIV3_STATE_READER_INTERFACE, UNIV3_STATE_WORD_RADIUS, readUniV3State, type UniV3StateBinding } from "../../swaps/univ3-family/state-reader.js";
import { ABI, nonzero } from "./variants.js";
import { assertXwinBinding, checkXwinDependencies, decodeXwinSurface, xwinDependencyRequests, XWIN_IMPLEMENTATION_SLOT, type XwinSurface, type XwinPrefixStep } from "./xwin.js";
import { quoteXwinTransition, type XwinLocalFundState, type XwinLocalSwapRoute } from "./xwin-transition.js";
import type { ConversionDescriptor, Direction } from "./types.js";
import { assertXwinRouterRuntime, assertXwinChainlinkFeedRuntime, assertXwinChainlinkAggregatorRuntime, assertXwinTokenRuntime, assertXwinFiatImplementationRuntime, proveXwinDependencyProxy, XWIN_FIAT_IMPLEMENTATION_SLOT, XWIN_FIAT_ADMIN_SLOT } from "./xwin-dependency-runtime.js";
import { storageState, tokenBalanceState, tokenSupplyState } from "../../local-state-models/resources.js";

export const XWIN_LOCAL_ABI = new Interface([
  ...["pendingMFee", "managerFee", "performanceFee", "blocksPerDay", "lastManagerFeeCollection", "collectionPeriod", "prevCollectionBlock", "watermarkUnitprice", "swapFee"].map(n => `function ${n}() view returns(uint256)`),
  "function strategyManager() view returns(address)", "function xWinFeeAddress() view returns(address)",
  "function paused() view returns(bool)", "function waivedPerformanceFees(address) view returns(bool)",
  "function isBlacklisted(address) view returns(bool)",
  "function TargetWeight(address) view returns(uint256)", "function isxWinStrategy(address) view returns(bool)",
  "function getSwapData(address,address) view returns((address router,address[] path,bytes multihopPath,uint24 slippage,uint24 poolFee,uint8 swapMethod))",
  "function priceSourceMap(address,address) view returns(uint8 source,address chainLinkAddr)",
  "function chainLinkUSDpair(address) view returns(address)", "function getPrice(address,address) view returns(uint256)",
  "function aggregator() view returns(address)", "function factory() view returns(address)",
  "function getPool(address,address,uint24) view returns(address)", "function token0() view returns(address)",
  "function token1() view returns(address)", "function fee() view returns(uint24)", "function tickSpacing() view returns(int24)",
]);
const FUND_NUMBERS = ["pendingMFee", "managerFee", "performanceFee", "blocksPerDay", "lastManagerFeeCollection", "collectionPeriod", "prevCollectionBlock", "watermarkUnitprice"] as const;
const SWAP_IMPLEMENTATION_HASH = "0x73b15c68f5fa0525a8c7d8ce1f3b1a2bd520f851e7c5319d3cc0efd4a2d722e3";
const ORACLE_IMPLEMENTATION_HASH = "0xc23cfe4f28d304e2f239e2e14a3f1adb0538f1063200c0f13c41b52c80748e94";
const requirements = { transports: ["get-code", "get-storage", "eth-call"] as const };
const lower = (a: string) => nonzero(a).toLowerCase();
type Results = readonly AdapterRequestResult[];
const data = (r: Results, id: string) => returnedResult(r, id).data;
const read = (r: Results, id: string, name: string) => XWIN_LOCAL_ABI.decodeFunctionResult(name, data(r, id));
const value = (r: Results, id: string, name: string) => BigInt(read(r, id, name)[0]);
const address = (r: Results, id: string, name: string) => lower(read(r, id, name)[0]);
const call = (id: string, to: string, name: string, args: readonly unknown[] = []) => callRequest(id, to, XWIN_LOCAL_ABI.encodeFunctionData(name, args));
const storage = (id: string, to: string, slot: string): AdapterRequest => ({ id, kind: "get-storage", address: to, slot: zeroPadValue(slot, 32) });
function storedAddress(r: Results, id: string) {
  const word = data(r, id);
  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(word)) throw new Error("xWin non-canonical address storage");
  return lower(`0x${word.slice(-40)}`);
}
function tokens(s: XwinSurface) { return [...new Set([s.asset, ...s.targets].map(lower))]; }
function dependencyIndex(s: XwinSurface, token: string) { return [...new Set([s.asset, s.swap, s.oracle, ...s.targets].map(lower))].indexOf(lower(token)); }
function tokenKind(r: Results, p: string, s: XwinSurface, token: string) { return assertXwinTokenRuntime(requireRuntimeCode(r, `${p}-dependency-${dependencyIndex(s, token)}`)); }
function participants(r: Results, p: string, s: XwinSurface, executor: string) {
  return [...new Set([lower(executor), lower(s.target), lower(s.swap), address(r, `${p}-manager`, "strategyManager"), address(r, `${p}-fee-recipient`, "xWinFeeAddress"),
    ...pairs(s).flatMap((_, j) => [swapInfo(r, p, j).router, address(r, `${p}-pool-${j}`, "getPool")])])];
}
function pairs(s: XwinSurface) { return s.targets.filter(t => !sameAddress(t, s.asset)).flatMap(t => [[lower(s.asset), lower(t)], [lower(t), lower(s.asset)]]); }
function swapInfo(r: Results, p: string, index: number) {
  const d = read(r, `${p}-swap-${index}`, "getSwapData")[0];
  if (BigInt(d.swapMethod) !== 1n || BigInt(d.poolFee) === 0n || BigInt(d.poolFee) >= 1_000_000n || BigInt(d.slippage) > 10000n) throw new Error("unsupported xWin swap configuration");
  return { router: lower(d.router), fee: BigInt(d.poolFee), slippage: BigInt(d.slippage) };
}
function oracles(r: Results, p: string, s: XwinSurface) { return [...new Set([lower(s.oracle), storedAddress(r, `${p}-swap-oracle`)])]; }
function oracleMap(r: Results, p: string, oracle: number, pair: number) {
  const direct = read(r, `${p}-map-${oracle}-${pair}`, "priceSourceMap");
  const reverse = read(r, `${p}-reverse-map-${oracle}-${pair}`, "priceSourceMap");
  const selected = BigInt(direct.source) === 0n ? reverse : direct;
  const source = BigInt(selected.source);
  if (source !== 1n && source !== 2n) throw new Error("xWin local quote requires independent Chainlink oracle branch");
  return { source, feed: selected.chainLinkAddr as string };
}
function feeds(r: Results, p: string, s: XwinSurface): string[] {
  const found = new Set<string>();
  oracles(r, p, s).forEach((_, o) => pairs(s).forEach(([a, b], j) => {
    const m = oracleMap(r, p, o, j);
    if (m.source === 2n) found.add(lower(m.feed));
    else for (const t of [a, b]) found.add(address(r, `${p}-usd-feed-${o}-${tokens(s).indexOf(t)}`, "chainLinkUSDpair"));
  }));
  return [...found];
}

// Read dynamic eligibility with the initial identity/surface wave. A paused
// fund needs no oracle, token or internal pool reads; each new quote checks again.
export function xwinLocalPauseRequest(p: string, target: string): AdapterRequest {
  return call(`${p}-paused`, target, "paused");
}

/** Read-only preparation for the exact amount model. The existing request runtime
 * owns source-pinned deduplication; no private provider, scheduler or quote cache. */
export function xwinLocalRound(p: string, s: XwinSurface, executor: string, completedRound: number, r: Results) {
  const requests: AdapterRequest[] = [];
  assertSource(returnedResult(r, `${p}-paused`).source, s.source);
  if (read(r, `${p}-paused`, "paused")[0]) throw new Error("xWin paused");
  if (completedRound === 0) {
    if (BigInt(s.locking) !== 0n) throw new Error("xWin locking discount not supported locally");
    requests.push(...xwinDependencyRequests(p, s),
      ...FUND_NUMBERS.map(n => call(`${p}-${n}`, s.target, n)),
      call(`${p}-waived`, s.target, "waivedPerformanceFees", [executor]),
      call(`${p}-manager`, s.target, "strategyManager"), storage(`${p}-base-amount`, s.target, "0x0124"),
      storage(`${p}-swap-implementation`, s.swap, XWIN_IMPLEMENTATION_SLOT), storage(`${p}-swap-oracle`, s.swap, "0xa5"),
      call(`${p}-swapFee`, s.swap, "swapFee"), call(`${p}-fee-recipient`, s.swap, "xWinFeeAddress"));
    tokens(s).forEach((t, j) => requests.push(
      callRequest(`${p}-balance-${j}`, t, ABI.encodeFunctionData("balanceOf", [s.target])),
      callRequest(`${p}-decimals-${j}`, t, ABI.encodeFunctionData("decimals")),
      call(`${p}-weight-${j}`, s.target, "TargetWeight", [t]), call(`${p}-strategy-${j}`, s.swap, "isxWinStrategy", [t])));
    pairs(s).forEach(([a, b], j) => requests.push(call(`${p}-swap-${j}`, s.swap, "getSwapData", [a, b])));
    // xwinDependencyRequests uses executor-call getters for the fund.
    return bindRequestResultRound({ ...requirements, caller: "executor" }, requests);
  }
  checkXwinDependencies(r, p, s);
  if (tokens(s).some((_, j) => read(r, `${p}-strategy-${j}`, "isxWinStrategy")[0])) throw new Error("xWin nested strategy unsupported locally");
  const swapProxy = proveXwinDependencyProxy(requireRuntimeCode(r, `${p}-dependency-${dependencyIndex(s, s.swap)}`));
  if (completedRound === 1) {
    tokens(s).forEach((t, j) => {
      const kind = tokenKind(r, p, s, t);
      if (kind !== "weth9") requests.push(call(`${p}-token-paused-${j}`, t, "paused"));
      if (kind === "fiat-token-proxy") requests.push(storage(`${p}-token-implementation-${j}`, t, XWIN_FIAT_IMPLEMENTATION_SLOT), storage(`${p}-token-admin-${j}`, t, XWIN_FIAT_ADMIN_SLOT));
    });
    requests.push(codeRequest(`${p}-swap-implementation-code`, storedAddress(r, `${p}-swap-implementation`)), storage(`${p}-swap-admin`, s.swap, swapProxy.adminSlot));
    oracles(r, p, s).forEach((o, index) => {
      requests.push(codeRequest(`${p}-oracle-code-${index}`, o), storage(`${p}-oracle-implementation-${index}`, o, XWIN_IMPLEMENTATION_SLOT));
      tokens(s).forEach((t, j) => requests.push(call(`${p}-usd-feed-${index}-${j}`, o, "chainLinkUSDpair", [t])));
      pairs(s).forEach(([a, b], j) => requests.push(call(`${p}-price-${index}-${j}`, o, "getPrice", [a, b]),
        call(`${p}-map-${index}-${j}`, o, "priceSourceMap", [a, b]), call(`${p}-reverse-map-${index}-${j}`, o, "priceSourceMap", [b, a])));
    });
    pairs(s).forEach((_, j) => {
      const d = swapInfo(r, p, j);
      requests.push(call(`${p}-factory-${j}`, d.router, "factory"), codeRequest(`${p}-router-code-${j}`, d.router));
    });
  } else if (completedRound === 2) {
    if (sameAddress(storedAddress(r, `${p}-swap-admin`), s.target)) throw new Error("xWin swap proxy admin aliases caller");
    tokens(s).forEach((t, j) => {
      if (tokenKind(r, p, s, t) === "fiat-token-proxy") requests.push(codeRequest(`${p}-token-implementation-code-${j}`, storedAddress(r, `${p}-token-implementation-${j}`)));
    });
    if (keccak256(requireRuntimeCode(r, `${p}-swap-implementation-code`)) !== SWAP_IMPLEMENTATION_HASH) throw new Error("unsupported xWin swap implementation");
    oracles(r, p, s).forEach((o, j) => {
      const proxy = proveXwinDependencyProxy(requireRuntimeCode(r, `${p}-oracle-code-${j}`));
      requests.push(storage(`${p}-oracle-admin-${j}`, o, proxy.adminSlot), codeRequest(`${p}-oracle-implementation-code-${j}`, storedAddress(r, `${p}-oracle-implementation-${j}`)));
    });
    feeds(r, p, s).forEach((f, j) => requests.push(codeRequest(`${p}-feed-code-${j}`, f), call(`${p}-aggregator-${j}`, f, "aggregator")));
    pairs(s).forEach(([a, b], j) => {
      assertXwinRouterRuntime(requireRuntimeCode(r, `${p}-router-code-${j}`), address(r, `${p}-factory-${j}`, "factory"));
      requests.push(call(`${p}-pool-${j}`, address(r, `${p}-factory-${j}`, "factory"), "getPool", [a, b, swapInfo(r, p, j).fee]));
    });
  } else if (completedRound === 3) {
    tokens(s).forEach((t, j) => {
      if (tokenKind(r, p, s, t) === "fiat-token-proxy") participants(r, p, s, executor).forEach((a, k) => requests.push(call(`${p}-blacklist-${j}-${k}`, t, "isBlacklisted", [a])));
    });
    oracles(r, p, s).forEach((_, j) => {
      if (keccak256(requireRuntimeCode(r, `${p}-oracle-implementation-code-${j}`)) !== ORACLE_IMPLEMENTATION_HASH) throw new Error("unsupported xWin oracle implementation");
    });
    feeds(r, p, s).forEach((_, j) => {
      assertXwinChainlinkFeedRuntime(requireRuntimeCode(r, `${p}-feed-code-${j}`));
      requests.push(codeRequest(`${p}-aggregator-code-${j}`, address(r, `${p}-aggregator-${j}`, "aggregator")));
    });
    pairs(s).forEach(([a, b], j) => {
      const pool = address(r, `${p}-pool-${j}`, "getPool");
      for (const n of ["factory", "token0", "token1", "fee", "tickSpacing"]) requests.push(call(`${p}-pool-${n}-${j}`, pool, n));
      requests.push(callRequest(`${p}-pool-state-${j}`, UNIV3_STATE_READER, UNIV3_STATE_READER_INTERFACE.encodeFunctionData("getFullStateWithRelativeBitmaps", [
        address(r, `${p}-factory-${j}`, "factory"), a, b, swapInfo(r, p, j).fee, UNIV3_STATE_WORD_RADIUS + 1, UNIV3_STATE_WORD_RADIUS])));
    });
  } else return null;
  // The final round reads pool state and dependency bytecode, but no storage
  // slots. The issuer rejects declared transports absent from the actual round.
  return bindRequestResultRound(completedRound === 3 ? { transports: ["get-code", "eth-call"] } : requirements, requests);
}

export function decodeXwinLocal(p: string, s: XwinSurface, executor: string, r: Results): XwinLocalFundState {
  assertSource(assertSameSource(r.map(row => successfulResult(r, row.id))), s.source);
  checkXwinDependencies(r, p, s);
  proveXwinDependencyProxy(requireRuntimeCode(r, `${p}-dependency-${dependencyIndex(s, s.swap)}`));
  if (sameAddress(storedAddress(r, `${p}-swap-admin`), s.target)) throw new Error("xWin swap proxy admin aliases caller");
  if (keccak256(requireRuntimeCode(r, `${p}-swap-implementation-code`)) !== SWAP_IMPLEMENTATION_HASH) throw new Error("unsupported xWin swap implementation");
  const oracleAddresses = oracles(r, p, s);
  oracleAddresses.forEach((o, j) => {
    proveXwinDependencyProxy(requireRuntimeCode(r, `${p}-oracle-code-${j}`));
    const admin = storedAddress(r, `${p}-oracle-admin-${j}`);
    if ((sameAddress(o, s.oracle) && sameAddress(admin, s.target)) || (sameAddress(o, storedAddress(r, `${p}-swap-oracle`)) && sameAddress(admin, s.swap))) throw new Error("xWin oracle proxy admin aliases caller");
    if (keccak256(requireRuntimeCode(r, `${p}-oracle-implementation-code-${j}`)) !== ORACLE_IMPLEMENTATION_HASH) throw new Error("unsupported xWin oracle implementation");
  });
  feeds(r, p, s).forEach((_, j) => {
    assertXwinChainlinkFeedRuntime(requireRuntimeCode(r, `${p}-feed-code-${j}`));
    assertXwinChainlinkAggregatorRuntime(requireRuntimeCode(r, `${p}-aggregator-code-${j}`));
  });
  if (BigInt(s.locking) !== 0n || read(r, `${p}-paused`, "paused")[0] || tokens(s).some((_, j) => read(r, `${p}-strategy-${j}`, "isxWinStrategy")[0])) throw new Error("unsupported xWin local eligibility");
  tokens(s).forEach((t, j) => {
    const kind = tokenKind(r, p, s, t);
    if (kind !== "weth9" && read(r, `${p}-token-paused-${j}`, "paused")[0]) throw new Error("xWin token paused");
    if (kind === "fiat-token-proxy") {
      assertXwinFiatImplementationRuntime(requireRuntimeCode(r, `${p}-token-implementation-code-${j}`));
      const admin = storedAddress(r, `${p}-token-admin-${j}`);
      if (participants(r, p, s, executor).some((a, k) => sameAddress(a, admin) || read(r, `${p}-blacklist-${j}-${k}`, "isBlacklisted")[0])) throw new Error("xWin token caller blocked");
    }
  });
  const manager = address(r, `${p}-manager`, "strategyManager"), recipient = address(r, `${p}-fee-recipient`, "xWinFeeAddress");
  const aliases = [s.target, s.swap, ...tokens(s)];
  if (aliases.some(a => sameAddress(a, executor)) || [manager, recipient].some(a => sameAddress(a, s.target) || sameAddress(a, executor))) throw new Error("xWin local fee/caller alias unsupported");
  const pools = new Map<string, ReturnType<typeof readUniV3State>>();
  const swaps: XwinLocalSwapRoute[] = pairs(s).map(([a, b], j) => {
    const config = swapInfo(r, p, j), pool = address(r, `${p}-pool-${j}`, "getPool"), factory = address(r, `${p}-factory-${j}`, "factory");
    assertXwinRouterRuntime(requireRuntimeCode(r, `${p}-router-code-${j}`), factory);
    const token0 = address(r, `${p}-pool-token0-${j}`, "token0"), token1 = address(r, `${p}-pool-token1-${j}`, "token1");
    if (address(r, `${p}-pool-factory-${j}`, "factory") !== factory || value(r, `${p}-pool-fee-${j}`, "fee") !== config.fee ||
      token0 >= token1 || ![token0, token1].includes(a) || ![token0, token1].includes(b)) throw new Error("xWin V3 reverse binding mismatch");
    const binding: UniV3StateBinding = { pool, token0, token1, fee: config.fee, tickSpacing: Number(read(r, `${p}-pool-tickSpacing-${j}`, "tickSpacing")[0]), factoryBinding: { factory, reversePool: pool } };
    const encoded = data(r, `${p}-pool-state-${j}`);
    const state = readUniV3State(encoded, binding);
    // Exact packed ABI word 9 is slot0.unlocked (decoder checks canonicality).
    if (BigInt(`0x${encoded.slice(2 + 9 * 64, 2 + 10 * 64)}`) !== 1n || state.sqrtPriceX96 === 0n) throw new Error("xWin V3 pool locked/uninitialized");
    if ([manager, recipient, executor].some(a => sameAddress(a, pool))) throw new Error("xWin fee/caller aliases internal pool");
    pools.set(pool, { ...state, unlocked: true });
    return { tokenIn: a, tokenOut: b, poolKey: pool, zeroForOne: a === token0, swapFeeBps: value(r, `${p}-swapFee`, "swapFee"),
      oraclePrice: value(r, `${p}-price-${oracleAddresses.indexOf(storedAddress(r, `${p}-swap-oracle`))}-${j}`, "getPrice"), slippageBps: config.slippage };
  });
  const allTokens = tokens(s), numbers = Object.fromEntries(FUND_NUMBERS.map(n => [n, value(r, `${p}-${n}`, n)])) as Record<typeof FUND_NUMBERS[number], bigint>;
  const decimals = (j: number) => Number(ABI.decodeFunctionResult("decimals", data(r, `${p}-decimals-${j}`))[0]);
  return { ...numbers, supply: s.supply, blockNumber: BigInt(s.source.number), baseToken: lower(s.asset), baseDecimals: decimals(allTokens.indexOf(lower(s.asset))),
    baseTokenAmt: BigInt(data(r, `${p}-base-amount`)), waived: Boolean(read(r, `${p}-waived`, "waivedPerformanceFees")[0]), lockingDiscountBps: null,
    balances: new Map(allTokens.map((t, j) => [t, BigInt(ABI.decodeFunctionResult("balanceOf", data(r, `${p}-balance-${j}`))[0])])),
    targets: s.targets.map(t => { const token = lower(t), j = allTokens.indexOf(token); return { token, decimals: decimals(j), weightBps: value(r, `${p}-weight-${j}`, "TargetWeight"),
      priceInBase: sameAddress(t, s.asset) ? 10n ** BigInt(decimals(j)) : value(r, `${p}-price-${oracleAddresses.indexOf(lower(s.oracle))}-${pairs(s).findIndex(([a, b]) => a === token && b === lower(s.asset))}`, "getPrice") }; }), pools, swaps };
}

export function quoteXwinLocal(state: XwinLocalFundState, direction: Direction, amount: bigint, prefix: readonly XwinPrefixStep[] = []): bigint {
  for (const step of prefix) {
    const next = quoteXwinTransition(state, step.direction === "mint" ? "deposit" : "withdraw", step.amountIn);
    if (next.amountOut !== step.amountOut) throw new Error("xWin local prefix output mismatch");
    state = next.state;
  }
  return quoteXwinTransition(state, direction === "mint" ? "deposit" : "withdraw", amount).amountOut;
}

/** The fund's price or eligibility dependencies exclude internal swap pools:
 * each pool is a separate shared cell. Oracle branches above prove independence. */
export function xwinLocalResources(p: string, s: XwinSurface, executor: string, r: Results) {
  const allTokens = tokens(s), oracleAddresses = oracles(r, p, s);
  const feeRecipients = [address(r, `${p}-manager`, "strategyManager"), address(r, `${p}-fee-recipient`, "xWinFeeAddress")];
  return {
    dependencies: [...new Set([storageState(s.target), storageState(s.swap), tokenSupplyState(s.target),
      ...allTokens.flatMap(token => [storageState(token), tokenBalanceState(token, s.target)]),
      ...oracleAddresses.map(storageState), ...feeds(r, p, s).flatMap((feed, index) =>
        [storageState(feed), storageState(address(r, `${p}-aggregator-${index}`, "aggregator"))])])],
    effects: [...new Set([storageState(s.target), tokenSupplyState(s.target),
      ...allTokens.flatMap(token => [s.target, executor, ...feeRecipients].map(account => tokenBalanceState(token, account))),
      ...[executor, ...feeRecipients].map(account => tokenBalanceState(s.target, account))])],
  };
}

export function localSurface(r: Results, p: string, d: ConversionDescriptor) {
  if (d.variant !== "xwin-allocations-v1") throw new Error("xWin local descriptor variant mismatch");
  const s = decodeXwinSurface(r, p, d.target);
  assertXwinBinding(s, d);
  return s;
}
