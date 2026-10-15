import { ethers } from "ethers";
import { address, normalizedToken } from "./codec.js";
import type { FactoryBinding, PoolBinding } from "./types.js";

// solc 0.8.36+commit.8a079791, viaIR, optimizer 200, Prague.
// Authenticated compiler immutableReferences; only these full words may vary.
// Hashes cover all remaining opcodes and metadata. Unknown clones/proxies fail.
export const POOL_IMMUTABLES = {
  "token0": [
    922,
    1459,
    2111,
    2499,
    2916,
    3519,
    3716,
    3940,
    4122,
    5224,
    5469,
    5971,
    9545,
    10351,
    11352,
    14395,
    15888
  ],
  "token1": [
    872,
    1409,
    2017,
    2180,
    3469,
    4159,
    5868,
    9627,
    10129,
    11227,
    14335,
    15935
  ],
  "factory": [
    2365,
    2581,
    3892,
    5081,
    15311
  ],
  "sqrtPLow": [
    4057,
    7393,
    7565,
    9839,
    10700,
    10970,
    11631,
    12514,
    12897,
    12943,
    13229,
    13380,
    13461,
    13494,
    13950,
    15071,
    15209,
    16918,
    17036
  ],
  "sqrtPHigh": [
    3042,
    7351,
    7611,
    9797,
    10746,
    10926,
    11677,
    12436,
    12985,
    13025,
    13101,
    13180,
    13321,
    13551,
    13584,
    13880,
    15026,
    15125,
    15165,
    15269,
    16952,
    17069
  ],
  "fee": [
    1077,
    7071,
    16092,
    17208,
    18233,
    18734
  ],
  "hook": [
    1209,
    3127,
    6949,
    7465,
    8860,
    9435,
    9920,
    11046,
    16034,
    16725,
    17161
  ],
  "feeRecipient": [
    3269,
    4279,
    12843
  ],
  "creatorFeeBps": [
    5340,
    8907,
    9482,
    16160,
    18398,
    18892
  ]
} as const;
export const FACTORY_IMMUTABLES = {
  "trustedExecutor": [
    1442,
    1693,
    3458,
    4101,
    4767
  ],
  "poolCode": [
    3526,
    5761,
    6077
  ],
  "poolInitCodeHash": [
    345
  ]
} as const;
export const POOL_RUNTIME_LENGTH = 19440;
export const FACTORY_RUNTIME_LENGTH = 7898;
export const POOL_RUNTIME_HASH = "0xf5c5d7bb1686e99e64f01488cf3a6c0821343f93783289ef71841301317a038c";
export const FACTORY_RUNTIME_HASH = "0x2f0046e620722c4afb4018583a4f173aadfcf7b30c06cf3e8ffb024da758d981";
export const POOL_INIT_CODE_HASH = "0x897b0181f6b0a84c801ae9934c3e8219c68bd65d46d2d534068ae4cda61cbf10";

function immutableWords(code: string, offsets: Readonly<Record<string, readonly number[]>>, length: number, hash: string): Record<string, string> | null {
  try {
    const bytes = ethers.getBytes(code), words: Record<string, string> = {};
    if (bytes.length !== length) return null;
    for (const [name, positions] of Object.entries(offsets)) {
      for (const offset of positions) {
        const word = ethers.hexlify(bytes.slice(offset, offset + 32));
        if (bytes[offset - 1] !== 0x7f || (words[name] !== undefined && words[name] !== word)) return null;
        words[name] = word; bytes.fill(0, offset, offset + 32);
      }
    }
    return ethers.keccak256(bytes) === hash ? words : null;
  } catch { return null; }
}
export function decodePoolRuntime(code: string): PoolBinding | null {
  const w = immutableWords(code, POOL_IMMUTABLES, POOL_RUNTIME_LENGTH, POOL_RUNTIME_HASH);
  if (!w) return null;
  try {
    const p: PoolBinding = { factory: address(w.factory), token0: address(w.token0), token1: address(w.token1),
      sqrtPLow: BigInt(w.sqrtPLow), sqrtPHigh: BigInt(w.sqrtPHigh), fee: BigInt(w.fee), hook: address(w.hook),
      feeRecipient: address(w.feeRecipient), creatorFeeBps: BigInt(w.creatorFeeBps) };
    if (p.factory === ethers.ZeroAddress || BigInt(p.token0) >= BigInt(p.token1) || p.sqrtPLow === 0n ||
        p.sqrtPHigh <= p.sqrtPLow || p.sqrtPHigh > 10n ** 36n || p.fee >= 100_000n ||
        p.hook !== ethers.ZeroAddress || p.creatorFeeBps !== 0n || normalizedToken(p.token0) === normalizedToken(p.token1))
      return null;
    return p;
  } catch { return null; }
}
export function decodeFactoryRuntime(code: string): FactoryBinding | null {
  const w = immutableWords(code, FACTORY_IMMUTABLES, FACTORY_RUNTIME_LENGTH, FACTORY_RUNTIME_HASH);
  if (!w || w.poolInitCodeHash !== POOL_INIT_CODE_HASH) return null;
  try {
    const f = { trustedExecutor: address(w.trustedExecutor), poolCode: address(w.poolCode), poolInitCodeHash: w.poolInitCodeHash };
    return f.poolCode !== ethers.ZeroAddress ? f : null;
  } catch { return null; }
}
