import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { requireSuccessfulResult } from "./codec.js";
import { CLASSIC_META_UPDATE_CLOCK, classicMetaChecksUpdate, classicMetaScalar } from "./quote-model.js";
import type { CurveUnderlyingClassicMetaBinding } from "./types.js";

type Binding = { readonly pool: string; readonly quoteModel?: CurveUnderlyingClassicMetaBinding };
const ABI = new ethers.Interface([
  "function getCurrentBlockTimestamp() view returns (uint256)",
  "function block_timestamp_last() view returns (uint256)",
  "function balances(uint256) view returns (uint256)",
  "function get_price_cumulative_last() view returns (uint256[2])",
]);
const UINT_MAX = (1n << 256n) - 1n;

/** 5f exchange_underlying calls _update even for base-to-base routes. These
 * amount-independent reads are shared by the existing central request runtime.
 * The older profiles neither depend on this clock nor acquire these reads. */
export function classicMetaUpdateRequests(descriptor: Binding): readonly AdapterRequest[] {
  if (!classicMetaChecksUpdate(descriptor.quoteModel)) return [];
  const call = (id: string, to: string, method: string, args: readonly unknown[] = []): AdapterRequest => ({
    id, kind: "eth-call", to, data: ABI.encodeFunctionData(method, args), completion: "return-data",
  });
  return [
    { id: "classic-update-pool-code", kind: "get-code", address: descriptor.pool },
    { id: "classic-update-implementation-code", kind: "get-code", address: descriptor.quoteModel!.implementation },
    { id: "classic-update-clock-code", kind: "get-code", address: CLASSIC_META_UPDATE_CLOCK.address },
    call("classic-update-time", CLASSIC_META_UPDATE_CLOCK.address, "getCurrentBlockTimestamp"),
    call("classic-update-last", descriptor.pool, "block_timestamp_last"),
    call("classic-update-balance:0", descriptor.pool, "balances", [0]),
    call("classic-update-balance:1", descriptor.pool, "balances", [1]),
    call("classic-update-cumulative", descriptor.pool, "get_price_cumulative_last"),
  ];
}

export function assertClassicMetaUpdate(descriptor: Binding, source: CanonicalSource,
  results: readonly AdapterRequestResult[]): void {
  const model = descriptor.quoteModel;
  if (!classicMetaChecksUpdate(model)) return;
  const read = (id: string) => {
    const result = requireSuccessfulResult(results, id);
    if (result.source.number !== source.number || result.source.generation !== source.generation ||
        result.source.hash.toLowerCase() !== source.hash.toLowerCase()) {
      throw new Error("curve-underlying cumulative update source mismatch");
    }
    return result.data;
  };
  for (const [id, hash] of [
    ["classic-update-pool-code", model!.poolCodeHash],
    ["classic-update-implementation-code", model!.implementationCodeHash],
    ["classic-update-clock-code", CLASSIC_META_UPDATE_CLOCK.codeHash],
  ]) {
    if (ethers.keccak256(read(id)).toLowerCase() !== hash.toLowerCase()) {
      throw new Error("curve-underlying cumulative update code changed: " + id);
    }
  }
  const uint = (data: string): bigint => {
    if (!ethers.isHexString(data, 32)) throw new Error("curve-underlying malformed cumulative update uint256");
    return BigInt(data);
  };
  // Only the code-bound pool forwarder uses a 4096-byte result. Clock/storage/
  // base results must never inherit that normalization.
  const scalar = (id: string) => uint(classicMetaScalar(model!, read(id)));
  const now = uint(read("classic-update-time"));
  const last = scalar("classic-update-last");
  if (now < last) throw new Error("curve-underlying cumulative update timestamp underflow");
  const elapsed = now - last;
  if (elapsed === 0n) return; // _update does not read/multiply/add the arrays.
  const cumulative = read("classic-update-cumulative");
  if (!ethers.isHexString(cumulative, 4096)) throw new Error("curve-underlying invalid cumulative forwarder return");
  for (let index = 0; index < 2; index++) {
    const balance = scalar("classic-update-balance:" + index);
    if (balance > UINT_MAX / elapsed) throw new Error("curve-underlying cumulative update multiplication overflow");
    const previous = uint(ethers.dataSlice(cumulative, index * 32, (index + 1) * 32));
    if (previous > UINT_MAX - balance * elapsed) throw new Error("curve-underlying cumulative update addition overflow");
  }
}
