import { ethers } from "ethers";
import type { UnifiedObservation } from "../../adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult } from "../../adapter-request-program.js";
import { assertSameSource, canonicalAddress, requireSuccessfulResult, sameAddress } from "./codec.js";
import type { CurveUnderlyingClassicMetaBinding } from "./types.js";

// A quote-semantics classifier, NEVER a pool admission list. MetaRegistry
// membership and behavior admission still apply to every instance. This exact
// immutable 1167 runtime delegates to a MetaUSD implementation with 3pool as its
// embedded base. Unknown implementations retain their declared chain quote path.
// Code guards at each quote source prohibit applying this model after a change.
// Verified deployed source independently recompiles byte-for-byte with Vyper
// 0.2.15 (meta) / 0.2.4 (base); evidence: curve-binding-sidecar-20261007.Tgn060.
// Meta initialize embeds 3pool, its LP and base coins. Source-local identity
// cross-checks private LP storage and actual getters rather than trusting labels.
const IMPLEMENTATION = "0x213be373fdff327658139c7df330817dad2d5bbe";
const IMPLEMENTATION_HASH = "0x86092e83f01ab6d7a368475cdf5c75f0a18352f943cdc4de65248f10d4881267";
const BASE_POOL = "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7";
const BASE_COINS = [
  "0x6b175474e89094c44da98b954eedeac495271d0f",
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "0xdac17f958d2ee523a2206206994597c13d831ec7",
] as const;
const BASE_HASH = "0x954a1e212c557c85043985931498ffa3e2fcbe7dfe9cd61513f36eb47d6f4dfc";
const CLONE = "0x363d3d373d3d3d363d73" + IMPLEMENTATION.slice(2) + "5af43d82803e903d91602b57fd5bf3";
const COINS = new ethers.Interface([
  "function coins(uint256) view returns (address)",

]);

export function hasClassicUnderlyingQuoteModel(poolCode: string | undefined): boolean {
  return typeof poolCode === "string" && poolCode.toLowerCase() === CLONE;
}

export function underlyingQuoteModelBindingRequests(poolCode: string, pool: string): readonly AdapterRequest[] {
  if (!hasClassicUnderlyingQuoteModel(poolCode)) return [];
  const coin = (id: string, address: string, index: number): AdapterRequest => ({
    id, kind: "eth-call", to: address, data: COINS.encodeFunctionData("coins", [index]), completion: "return-data",
  });
  return [
    { id: "model-implementation-code", kind: "get-code", address: IMPLEMENTATION },
    { id: "model-base-code", kind: "get-code", address: BASE_POOL },
    coin("model-meta-coin", pool, 0),
    coin("model-meta-lp", pool, 1),
    ...[0, 1, 2].map(index => coin("model-base-coin:" + index, BASE_POOL, index)),
    // Exact deployed Vyper layouts: base 0.2.4 token slot 5, meta 0.2.15 rate slot 16.
    // Runtime hashes above guard these layouts; registry labels alone do not.
    { id: "model-base-lp", kind: "get-storage", address: BASE_POOL, slot: ethers.toBeHex(5, 32) },
    { id: "model-meta-rate", kind: "get-storage", address: pool, slot: ethers.toBeHex(16, 32) },
  ];
}

export function decodeUnderlyingQuoteModel(poolCode: string, pool: string, underlyingCoins: readonly string[],
  results: readonly AdapterRequestResult[]): CurveUnderlyingClassicMetaBinding | undefined {
  if (!hasClassicUnderlyingQuoteModel(poolCode)) return undefined;
  const requested = underlyingQuoteModelBindingRequests(poolCode, pool);
  const reads = requested.map(request => requireSuccessfulResult(results, request.id));
  assertSameSource(reads);
  const read = (id: string) => requireSuccessfulResult(reads, id).data;
  if (ethers.keccak256(read("model-implementation-code")).toLowerCase() !== IMPLEMENTATION_HASH ||
      ethers.keccak256(read("model-base-code")).toLowerCase() !== BASE_HASH) {
    throw new Error("curve-underlying classic quote implementation is not the bound runtime");
  }
  const address = (id: string) => {
    const data = read(id);
    if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(data)) throw new Error("curve-underlying malformed model token address");
    const value = canonicalAddress("0x" + data.slice(-40));
    if (value === ethers.ZeroAddress) throw new Error("curve-underlying zero model token address");
    return value;
  };
  const rateData = read("model-meta-rate");
  if (!/^0x[0-9a-fA-F]{64}$/.test(rateData) || BigInt(rateData) <= 0n) {
    throw new Error("curve-underlying invalid meta rate multiplier");
  }
  const metaCoin = address("model-meta-coin");
  const baseLPToken = address("model-base-lp");
  const baseCoins = [0, 1, 2].map(index => address("model-base-coin:" + index));
  if (underlyingCoins.length !== 4 || !sameAddress(underlyingCoins[0], metaCoin) ||
      baseCoins.some((coin, index) => !sameAddress(coin, underlyingCoins[index + 1]) || !sameAddress(coin, BASE_COINS[index])) ||
      !sameAddress(address("model-meta-lp"), baseLPToken) ||
      !sameAddress(baseLPToken, "0x6c3f90f043a72fa612cbac8115ee7e52bde6e490") ||
      new Set([metaCoin, baseLPToken, ...baseCoins].map(token => token.toLowerCase())).size !== 5) {
    throw new Error("curve-underlying classic base/LP/underlying topology mismatch");
  }
  return Object.freeze({
    kind: "classic-meta-base-3pool-v1" as const,
    poolCodeHash: ethers.keccak256(poolCode).toLowerCase(), metaRateMultiplier: BigInt(rateData),
    implementation: canonicalAddress(IMPLEMENTATION), implementationCodeHash: IMPLEMENTATION_HASH,
    basePool: canonicalAddress(BASE_POOL), baseCodeHash: BASE_HASH, baseLPToken,
    baseCoins: Object.freeze(baseCoins), basePrecisions: Object.freeze([1n, 10n ** 12n, 10n ** 12n]),
  });
}

export function curveUnderlyingQuoteModelProjection(model: CurveUnderlyingClassicMetaBinding | undefined) {
  return model ? { ...model, baseCoins: [...model.baseCoins], basePrecisions: [...model.basePrecisions] } : null;
}

export function curveUnderlyingRefreshAddresses(descriptor: {
  readonly pool: string; readonly quoteModel?: CurveUnderlyingClassicMetaBinding;
}): readonly string[] {
  const model = descriptor.quoteModel;
  return model ? [descriptor.pool, model.basePool, model.baseLPToken, model.implementation, model.baseCoins[2]] : [descriptor.pool];
}

const USDT_CONTROL_TOPICS = new Set([
  "Params(uint256,uint256)", "Pause()", "Unpause()", "Deprecate(address)",
].map(signature => ethers.id(signature).toLowerCase()));

const DONATE_ADMIN_FEES = ethers.id("donate_admin_fees()").slice(0, 10);

/** The bound base implementation rewrites balances without emitting a log. */
export function curveUnderlyingAcceptBaseCall(observation: UnifiedObservation): boolean {
  return observation.kind === "call" &&
    observation.data.slice(0, 10).toLowerCase() === DONATE_ADMIN_FEES;
}

/** Ordinary USDT transfers/approvals do not change this model's transfer mode. */
export function curveUnderlyingAcceptMutation(observation: UnifiedObservation): boolean {
  if (observation.kind !== "log") return false;
  return !sameAddress(observation.address, BASE_COINS[2]) ||
    USDT_CONTROL_TOPICS.has(observation.topics[0]?.toLowerCase() ?? "");
}
