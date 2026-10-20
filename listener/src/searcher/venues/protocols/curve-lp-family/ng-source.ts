import { ethers } from "ethers";

// Source-verified behavior classes, never pool-address admission lists.
// Vyper 0.3.10 Sourcify full matches: compiler runtime followed by its one
// immutable insertion. Historical 26202387 bytes match the verified runtime;
// all 123 current 23635-byte instances share the same compiler prefix.
// https://sourcify.dev/server/v2/contract/1/0x00836Fe54625BE242BcFA286207795405ca4fD10?fields=all
// source keccak256 8c85849489ac0257f82133937e7dbb001ba45dea5abf6a954582ccd0628203ea
// https://sourcify.dev/server/v2/contract/1/0xe080027Bd47353b5D1639772b4a75E9Ed3658A0d?fields=all
// source keccak256 cf951789e99e20100f4f6652b35785b211c0f38383d65fdd5b65f7f9591b88c1
// Meta source: https://etherscan.io/address/0x579a9A9d43f9C112dEe359e09a87a44F2718a483#code
// Independently recompiled Vyper0.3.10 prefix20798 + compiler code-layout1216,
// matched byte-for-byte against the saved historical runtime.
const MODELS = [
  { id: "ng-v7", prefix: 21491, immutables: 2144, hash: "0x04b4bd650d72be4619d76c7b5a052de46d95b5194945fe44bba7e49b729d3d60", array: "dynamic" as const },
  { id: "ng-meta-v7", prefix: 20798, immutables: 1216, hash: "0xee0eb9aac25c7b778f60b9aff8f5fd29466d9a91a8df951ad0d634622c8cfe5c", array: "fixed2" as const },
  { id: "ng-v6", prefix: 21685, immutables: 1824, hash: "0x2e55958ada4cc5bb9707e70abaa62bd8c6455b252f086e4bde260435af23aaa3", array: "dynamic" as const },
] as const;
export interface NgCodeProof { readonly model: string; readonly array: "dynamic" | "fixed2"; readonly factory: string;
  readonly coins: readonly string[]; readonly external: readonly string[] }
export function proveNgCode(code: string): NgCodeProof {
  if (!ethers.isHexString(code, true)) throw new Error("curve-lp malformed NG runtime");
  const bytes = ethers.getBytes(code), model = MODELS.find(v => bytes.length === v.prefix + v.immutables &&
    ethers.keccak256(bytes.slice(0, v.prefix)) === v.hash);
  if (!model) throw new Error("curve-lp unsupported NG runtime class");
  const tail = bytes.slice(model.prefix), word = (i: number) => BigInt(ethers.hexlify(tail.slice(i * 32, (i + 1) * 32)));
  const addr = (i: number) => { const w = word(i); if (!w || w >= 1n << 160n) throw new Error("curve-lp malformed NG immutable address");
    return ethers.getAddress(ethers.toBeHex(w, 20)).toLowerCase(); };
  // Immutable declaration order is verified in both named Vyper sources.
  if (model.array === "fixed2") {
    if (word(14) !== 2n) throw new Error("curve-lp incompatible NG meta immutable domain");
    const coins = [addr(15), addr(16)], factory = addr(13);
    if (coins[0] === coins[1] || coins.includes(factory)) throw new Error("curve-lp aliased NG meta immutable coins");
    return { model: model.id, array: model.array, factory, coins, external: [addr(0), addr(12)] };
  }
  const n = Number(word(0));
  if (!Number.isInteger(n) || n < 2 || n > 8 || word(1) !== BigInt(n) || word(3) !== BigInt(n))
    throw new Error("curve-lp incompatible NG immutable domain");
  const coins = Array.from({ length: n }, (_v, i) => addr(4 + i)), factory = addr(2);
  if (new Set(coins).size !== n || coins.includes(factory)) throw new Error("curve-lp aliased NG immutable coins");
  return { model: model.id, array: model.array, factory, coins, external: [] };
}

// Verified deployed NG Views code, shared by these actual historical classes.
// Sourcify full match, source keccak256 86aff4bfcf441663890a7ed6855e99a8ee0f51ff569b044999ce072ff0931199.
// A changed view implementation requires reattestation/source review, never reuse
// of an old quote or automatic acceptance merely because its ABI is present.
export const NG_VIEWS_HASH = "0x978cd7754947f9c66e1cbb95ae13d3d82e14954463daae02d162315f1dee3429";
export function proveNgViews(code: string): string {
  if (!ethers.isHexString(code, true) || ethers.keccak256(code) !== NG_VIEWS_HASH) throw new Error("curve-lp unsupported NG views runtime class");
  return NG_VIEWS_HASH;
}
