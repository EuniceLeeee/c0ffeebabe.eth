import { Interface, getAddress, isHexString, keccak256 } from "ethers";
import { UNIV3_CANONICAL_FACTORY } from "../../swaps/univ3-abi.js";

/** Infrastructure runtime bindings, not pool, fund, token or feed-address
 * allowlists. These bytecodes were independently read at sample block 26029585
 * in token-conversion-xwin-slot2/rpc.jsonl. The parent program must reread code
 * and mutable addresses at its own canonical source. Unlike the xWin fund/swap
 * proofs, these bindings are NOT a fresh verified-source recompilation claim.
 * Final whole-route execution remains the token-transfer/eligibility gate.
 */
const LEGACY_ROUTER_RUNTIME = "0xbb90113d2f9a5e9b7feb15a1d1fff06c1ee1575b3f9b1181778ffd0cf633e7ea";
const CHAINLINK_FEED_RUNTIMES = new Set([
  "0x4b79b5c8aee6da0f7b393e8b53e6265ef7320a1d16184c65bd3841b5aa3d700d",
  "0xbd6f524cdc4268b6bd1bb6f77a8821faeea9c52ee9e0afa0b6d948ce82c966c2",
]);
const CHAINLINK_AGGREGATOR_RUNTIME = "0x16f41184f797cb8f8918680df0ebf2a97cc3192aa6b104615f61096fc674f2aa";
const WETH9_RUNTIME = "0xd0a06b12ac47863b5c7be4185c2deaad1c61557033f56c7d4ea74429cbb25e23";
const WBTC_RUNTIME = "0x131ff5c755b710d543ea70fede2eb38e5d15b1456df0ae932ba12e2786f7e5df";
const FIAT_TOKEN_PROXY_RUNTIME = "0xd80d4b7c890cb9d6a4893e6b52bc34b56b25335cb13716e0d1d31383e6b41505";
const FIAT_TOKEN_IMPLEMENTATION_RUNTIME = "0xcdfb7d322961af3acae7a8f7ee8b69c205b36f576cc5b077f170c7eb8ecbe3ea";
const XWIN_DEPENDENCY_PROXY_RUNTIME = "0x4d9be648c5bf39973670d9f8b481d5d0b971e6a2db2deccc6b98cde21c5dd83e";

// The observed Fiat proxy uses legacy Zeppelin slots, NOT EIP-1967. The exact
// proxy runtime binds these literal SLOAD slots. Current implementation/admin
// words must be resolved at the quote source, never remembered by token address.
export const XWIN_FIAT_IMPLEMENTATION_SLOT = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";
export const XWIN_FIAT_ADMIN_SLOT = "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b";
export type XwinLocalTokenRuntime = "weth9" | "wbtc" | "fiat-token-proxy";

/** The swap/oracle dependencies use the older OZ TransparentUpgradeableProxy
 * (solc 0.8.9), not the fund's immutable-admin proxy. Both current pinned
 * runtimes match the published verified-source runtime byte-for-byte in the
 * cached swap proxy page. Admin is mutable EIP-1967 storage; its value must be
 * read and checked against the internal caller, not decoded as an immutable.
 */
export function proveXwinDependencyProxy(code: string) {
  const codeHash = runtimeHash(code);
  if (codeHash !== XWIN_DEPENDENCY_PROXY_RUNTIME) throw new Error("unsupported xWin dependency proxy runtime");
  return {
    kind: "eip1967-storage-admin" as const,
    codeHash,
    adminSlot: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
    implementationSlot: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  };
}

export const XWIN_DEPENDENCY_ABI = new Interface([
  "function factory() view returns(address)",
  "function chainLinkUSDpair(address) view returns(address)",
  "function priceSourceMap(address,address) view returns(uint8 source,address chainLinkAddr)",
  "function getPrice(address,address) view returns(uint256)",
  "function aggregator() view returns(address)",
  "function decimals() view returns(uint8)",
  "function latestRoundData() view returns(uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function minAnswer() view returns(int192)",
  "function maxAnswer() view returns(int192)",
  "function paused() view returns(bool)",
  "function isBlacklisted(address) view returns(bool)",
]);

function runtimeHash(code: string): string {
  if (!isHexString(code, true) || code === "0x") throw new Error("xWin dependency runtime missing or malformed");
  return keccak256(code);
}

/** This exact legacy ISwapRouter runtime includes its immutable canonical V3
 * factory. The read is still checked so arbitrary factory() data cannot select
 * another pool namespace. No Router02 seven-field calldata is assumed here. */
export function assertXwinRouterRuntime(code: string, factory: string): string {
  const hash = runtimeHash(code);
  if (hash !== LEGACY_ROUTER_RUNTIME || getAddress(factory) !== UNIV3_CANONICAL_FACTORY)
    throw new Error("unsupported xWin legacy V3 router runtime/factory binding");
  return hash;
}

/** Bind the currently resolved feed implementation, not the historically
 * observed feed address. The source-pinned priceMaster.getPrice read retains
 * its own decimals/range/revert semantics; this is not a second price formula. */
export function assertXwinChainlinkFeedRuntime(code: string): string {
  const hash = runtimeHash(code);
  if (!CHAINLINK_FEED_RUNTIMES.has(hash)) throw new Error("unsupported xWin Chainlink feed runtime");
  return hash;
}

/** aggregator() is mutable and must be read again at the quote source. A
 * matching feed proxy alone must not approve a different aggregator runtime.
 * This OCR2 template embeds maxAnswer at three solc immutable offsets. The
 * coffee N26075823 USDC feed changed that bound, not the executable template.
 * Offsets/semantics are backed by the exact-match published compiler output
 * (solc 0.8.19, OCR2Aggregator.maxAnswer id630). Normalize ONLY that positive
 * int192 constant, requiring all copies to agree and every other byte to match.
 * The on-chain priceMaster.getPrice still applies the actual min/max bounds;
 * normalization never replaces a returned answer or bypasses its range check. */
export function assertXwinChainlinkAggregatorRuntime(code: string): string {
  const hash = runtimeHash(code);
  if (hash === CHAINLINK_AGGREGATOR_RUNTIME) return hash;
  if (code.length !== 2 + 22337 * 2) throw new Error("unsupported xWin Chainlink aggregator runtime");
  const offsets = [1303, 9901, 15567] as const;
  const words = offsets.map(offset => code.slice(2 + offset * 2, 2 + (offset + 32) * 2).toLowerCase());
  const maxAnswer = BigInt(`0x${words[0]}`);
  if (maxAnswer < 1n || maxAnswer >= 1n << 191n || words.some(word => word !== words[0]))
    throw new Error("unsupported xWin Chainlink maxAnswer immutable");
  const legacyMax = "0".repeat(20) + "f".repeat(44);
  let normalized = code.toLowerCase();
  for (const offset of offsets) normalized = normalized.slice(0, 2 + offset * 2) + legacyMax + normalized.slice(2 + (offset + 32) * 2);
  if (keccak256(normalized) !== CHAINLINK_AGGREGATOR_RUNTIME) throw new Error("unsupported xWin Chainlink aggregator runtime");
  return hash;
}

/** Narrow local-model compatibility only. Unknown ERC20 code is NOT assumed
 * untaxed merely because it exposes balanceOf/transfer or lacks external calls.
 * These are the exact archived WETH9/WBTC/Fiat proxy runtimes used by the sample,
 * not symbol/address gates. Source recompilation is not claimed: same-state
 * production amount/execution comparisons must establish the supported model.
 * WBTC/Fiat still require their mutable paused/blacklist reads; Fiat additionally
 * requires current implementation proof. A match is not execution eligibility.
 */
export function assertXwinTokenRuntime(code: string): XwinLocalTokenRuntime {
  const hash = runtimeHash(code);
  if (hash === WETH9_RUNTIME) return "weth9";
  if (hash === WBTC_RUNTIME) return "wbtc";
  if (hash === FIAT_TOKEN_PROXY_RUNTIME) return "fiat-token-proxy";
  throw new Error("unsupported xWin local token runtime");
}

export function assertXwinFiatImplementationRuntime(code: string): string {
  const hash = runtimeHash(code);
  if (hash !== FIAT_TOKEN_IMPLEMENTATION_RUNTIME) throw new Error("unsupported xWin Fiat token implementation runtime");
  return hash;
}
