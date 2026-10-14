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
// The original 213be/base sources independently recompile byte-for-byte with
// Vyper 0.2.15 / 0.2.4; evidence: curve-binding-sidecar-20261007.Tgn060.
// V1 source is verified against historical runtime bytes and compiler layout;
// its independent recompilation is not claimed.
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
const V1_IMPLEMENTATION = "0x2c7796c0590cc100d70af473993890d457cb2ac9";
const V1_CLONE = "0x366000600037611000600036600073" + V1_IMPLEMENTATION.slice(2) + "5af4602c57600080fd5b6110006000f3";
const PROFILES = [
  { implementation: IMPLEMENTATION, implementationHash: IMPLEMENTATION_HASH, code: CLONE, rateSlot: 16, underlyingReceiver: true },
  // Vyper 0.2.8 allocates one root per declaration (arrays use hashed roots).
  // initialize bytecode writes 10**(36-decimals) with PUSH1 0x0a / SSTORE.
  { implementation: V1_IMPLEMENTATION, implementationHash: "0xdf4543ae0cb4d3878072c1da2c56ebec96a64237051a7291429a2fb66d5f54da",
    code: V1_CLONE, rateSlot: 10, underlyingReceiver: true },
].map(profile => ({ ...profile, poolCodeHash: ethers.keccak256(profile.code) }));
function profileForCode(code: string | undefined) {
  return PROFILES.find(profile => profile.code === code?.toLowerCase());
}
export function hasLegacyV1UnderlyingQuoteModel(code: string | undefined): boolean {
  return code?.toLowerCase() === V1_CLONE;
}
export function classicMetaRateSlot(model: CurveUnderlyingClassicMetaBinding): number {
  const profile = PROFILES.find(value => value.implementation === model.implementation.toLowerCase() &&
    value.implementationHash === model.implementationCodeHash.toLowerCase() &&
    value.poolCodeHash === model.poolCodeHash.toLowerCase());
  if (!profile) throw new Error("curve-underlying unknown classic implementation profile");
  return profile.rateSlot;
}
/** Both bound classic implementations expose the optional receiver overload.
 * This describes already admitted code; registry identity remains mandatory. */
export function supportsClassicUnderlyingRecipient(model: CurveUnderlyingClassicMetaBinding | undefined): boolean {
  return model !== undefined && PROFILES.some(profile => profile.underlyingReceiver &&
    profile.implementation === model.implementation.toLowerCase() &&
    profile.implementationHash === model.implementationCodeHash.toLowerCase() &&
    profile.poolCodeHash === model.poolCodeHash.toLowerCase());
}
/** The old bound forwarder returns 4096 bytes, reusing the calldata buffer.
 * Normalize only its known one-word pool getters; the tail can contain calldata.
 * Registry/base/storage responses keep their existing canonical length checks. */
export function classicMetaScalar(model: Pick<CurveUnderlyingClassicMetaBinding, "implementationCodeHash">, data: string): string {
  if (model.implementationCodeHash.toLowerCase() !== PROFILES[1].implementationHash) return data;
  if (!ethers.isHexString(data, 4096)) throw new Error("curve-underlying invalid V1 forwarder return");
  return ethers.dataSlice(data, 0, 32);
}
const COINS = new ethers.Interface([
  "function coins(uint256) view returns (address)",

]);

export function hasClassicUnderlyingQuoteModel(poolCode: string | undefined): boolean {
  return profileForCode(poolCode) !== undefined;
}

export function underlyingQuoteModelBindingRequests(poolCode: string, pool: string): readonly AdapterRequest[] {
  const profile = profileForCode(poolCode);
  if (!profile) return [];
  const coin = (id: string, address: string, index: number): AdapterRequest => ({
    id, kind: "eth-call", to: address, data: COINS.encodeFunctionData("coins", [index]), completion: "return-data",
  });
  return [
    { id: "model-implementation-code", kind: "get-code", address: profile.implementation },
    { id: "model-base-code", kind: "get-code", address: BASE_POOL },
    coin("model-meta-coin", pool, 0),
    coin("model-meta-lp", pool, 1),
    ...[0, 1, 2].map(index => coin("model-base-coin:" + index, BASE_POOL, index)),
    // Base 0.2.4 token slot 5; each immutable meta profile binds its own rate slot.
    // Runtime hashes above guard these layouts; registry labels alone do not.
    { id: "model-base-lp", kind: "get-storage", address: BASE_POOL, slot: ethers.toBeHex(5, 32) },
    { id: "model-meta-rate", kind: "get-storage", address: pool, slot: ethers.toBeHex(profile.rateSlot, 32) },
  ];
}

export function decodeUnderlyingQuoteModel(poolCode: string, pool: string, underlyingCoins: readonly string[],
  results: readonly AdapterRequestResult[]): CurveUnderlyingClassicMetaBinding | undefined {
  const profile = profileForCode(poolCode);
  if (!profile) return undefined;
  const requested = underlyingQuoteModelBindingRequests(poolCode, pool);
  const reads = requested.map(request => requireSuccessfulResult(results, request.id));
  assertSameSource(reads);
  const read = (id: string) => requireSuccessfulResult(reads, id).data;
  if (ethers.keccak256(read("model-implementation-code")).toLowerCase() !== profile.implementationHash ||
      ethers.keccak256(read("model-base-code")).toLowerCase() !== BASE_HASH) {
    throw new Error("curve-underlying classic quote implementation is not the bound runtime");
  }
  const address = (id: string) => {
    const data = id === "model-meta-coin" || id === "model-meta-lp"
      ? classicMetaScalar({ implementationCodeHash: profile.implementationHash }, read(id)) : read(id);
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
    implementation: canonicalAddress(profile.implementation), implementationCodeHash: profile.implementationHash,
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

const LP_TRANSFER = ethers.id("Transfer(address,address,uint256)").toLowerCase();
const LP_APPROVAL = ethers.id("Approval(address,address,uint256)").toLowerCase();
const ZERO_TOPIC = ethers.zeroPadValue(ethers.ZeroAddress, 32).toLowerCase();

/** Only for the bound 3pool LP dependency: quotes read its total supply,
 * not holder balances/allowances. Its verified Vyper 0.2.4 mint/burn paths
 * emit zero-address Transfer; keep those, unknown and malformed events. */
export function curveUnderlyingAcceptLpMutation(observation: UnifiedObservation): boolean {
  if (observation.kind !== "log") return false;
  const topic = observation.topics[0]?.toLowerCase();
  if (topic !== LP_TRANSFER && topic !== LP_APPROVAL) return true;
  if (observation.topics.length !== 3 || !/^0x[0-9a-fA-F]{64}$/.test(observation.data) ||
      !observation.topics.slice(1).every(value => /^0x0{24}[0-9a-fA-F]{40}$/.test(value))) return true;
  if (topic === LP_APPROVAL) return false;
  return observation.topics.slice(1).some(value => value.toLowerCase() === ZERO_TOPIC);
}
