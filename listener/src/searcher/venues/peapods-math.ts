import { MaxUint256, keccak256 } from "ethers";
import type { DeclarativeMathModel, MathValue } from "./declarative-math.js";

const MAX_UINT256 = MaxUint256;
const Q96 = 1n << 96n;
const WAD = 10n ** 18n;
const BPS = 10000n;

function plain(value: MathValue, fields: readonly string[], label: string): Readonly<Record<string, MathValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  const record = value as Record<string, MathValue>;
  const keys = Reflect.ownKeys(record);
  if (keys.some(key => typeof key !== "string") ||
      keys.some(key => typeof key === "string" && !fields.includes(key)) ||
      fields.some(key => !Object.hasOwn(record, key))) {
    throw new Error(`${label} has missing or unknown fields`);
  }
  return record;
}

function uint(value: MathValue, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_UINT256) {
    throw new Error(`${label} must be a uint256`);
  }
  return value;
}

/** Bytes32 amount work word; the original Family uses checked uint256 reads. */
function word(value: MathValue, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`${label} must be runtime code hex`);
  return value;
}

// Independently compiled WeightedIndex 0.7.6 runtime shape. The offsets are
// compiler-reported immutable words, never instruction bytes; the normalized
// code hash is the source-runtime identity used by the hand-written Family.
const NORMALIZED_CODE_HASH = "0xd6c722955476be393dbf38f51df65318135545023e97da5f532fdf48cb53a768";
const IMMUTABLES = {
  BOND_FEE: [5745, 8534], DEBOND_FEE: [7321, 7937],
  V2_ROUTER: [2245, 2284, 4047, 4192, 4239, 11982, 12170],
  V2_POOL: [1781, 2002, 2158, 2211, 2517, 2692, 2835, 9295, 9373],
  DAI: [2332, 3867, 4105, 4158, 4279, 4528, 4703, 4846, 6606, 6759, 11900, 12307, 12949, 13709],
  WETH: [9750, 9894, 10614, 12982], V3_TWAP_UTILS: [1437, 7501], V2_FACTORY: [9847, 12902],
} as const;

function runtimeProof(value: MathValue): { readonly codeHash: string; readonly feeBps: bigint } {
  const source = plain(value, ["code"], "peapods runtime proof input");
  const code = word(source.code!, "peapods runtime code");
  if (!/^0x[0-9a-f]+$/i.test(code) || code.length !== 2 + 16972 * 2) throw new Error("peapods unsupported runtime size");
  let normalized = code.slice(2).toLowerCase();
  const values = {} as Record<keyof typeof IMMUTABLES, bigint>;
  for (const [name, offsets] of Object.entries(IMMUTABLES) as [keyof typeof IMMUTABLES, readonly number[]][]) {
    const words = offsets.map(offset => normalized.slice(offset * 2, (offset + 32) * 2));
    if (new Set(words).size !== 1) throw new Error("peapods inconsistent immutable " + name);
    const immutable = BigInt("0x" + words[0]);
    if (!name.endsWith("FEE") && (immutable === 0n || immutable >= 1n << 160n)) throw new Error("peapods invalid immutable address");
    values[name] = immutable;
    for (const offset of offsets) normalized = normalized.slice(0, offset * 2) + "0".repeat(64) + normalized.slice((offset + 32) * 2);
  }
  if (keccak256("0x" + normalized) !== NORMALIZED_CODE_HASH) throw new Error("peapods unsupported source runtime");
  if (values.DEBOND_FEE > 10000n) throw new Error("peapods unsupported underflow fee");
  return Object.freeze({ codeHash: keccak256(code), feeBps: values.DEBOND_FEE });
}

/** Source-faithful WeightedIndex 0.7.6 debond order, including unchecked
 * intermediate products. Never imports ABI, transport, state or settlement. */
type DebondInput = { readonly supply: bigint; readonly backing: bigint; readonly feeBps: bigint; readonly amountIn: bigint };
function debondInput(value: MathValue): DebondInput {
  const source = plain(value, ["supply", "backing", "feeBps", "amountIn"], "peapods debond input");
  return Object.freeze({
    supply: uint(source.supply!, "peapods debond supply"),
    backing: uint(source.backing!, "peapods debond backing"),
    feeBps: uint(source.feeBps!, "peapods debond feeBps"),
    amountIn: uint(source.amountIn!, "peapods debond amountIn"),
  });
}

function debond(source: DebondInput) {
  const wrap = (value: bigint) => BigInt.asUintN(256, value);
  const { supply, backing, feeBps, amountIn } = source;
  if (feeBps > BPS || amountIn <= 0n || supply <= 0n || amountIn > supply) throw new Error("peapods unavailable amount/supply/fee");
  const exempt = amountIn >= wrap(supply * 98n) / 100n;
  const burned = exempt ? amountIn : wrap(amountIn * (BPS - feeBps)) / BPS;
  const fractionX96 = wrap(burned * Q96) / supply;
  const amountOut = wrap(backing * fractionX96) / Q96;
  if (burned > amountIn || amountOut > backing) throw new Error("peapods unsupported wrapped output");
  return Object.freeze({
    amountOut,
    burned,
    feeShares: amountIn - burned,
    exempt,
    state: Object.freeze({ supply: supply - burned, backing: backing - amountOut, feeBps }),
  });
}

export const peapodsRuntimeShapeMathModel: DeclarativeMathModel = Object.freeze({
  id: "peapods:runtime-shape",
  version: 1,
  validateInput(value: MathValue): void {
    runtimeProof(value);
  },
  evaluate(value: MathValue): MathValue {
    const proof = runtimeProof(value);
    return Object.freeze({ codeHash: proof.codeHash, feeBps: proof.feeBps });
  },
  validateOutput(value: MathValue): void {
    const output = plain(value, ["codeHash", "feeBps"], "peapods runtime proof output");
    if (typeof output.codeHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(output.codeHash)) throw new Error("peapods runtime proof codeHash");
    uint(output.feeBps!, "peapods runtime proof feeBps");
  },
});

export const peapodsDebondMathModel: DeclarativeMathModel = Object.freeze({
  id: "peapods:debond",
  version: 1,
  validateInput(value: MathValue): void {
    const source = debondInput(value);
    if (source.feeBps > BPS || source.amountIn <= 0n || source.supply <= 0n || source.amountIn > source.supply)
      throw new Error("peapods unavailable amount/supply/fee");
  },
  evaluate(value: MathValue): MathValue {
    const quote = debond(debondInput(value));
    return Object.freeze({ amountOut: quote.amountOut, burned: quote.burned, feeShares: quote.feeShares,
      exempt: quote.exempt, state: quote.state });
  },
  validateOutput(value: MathValue): void {
    const output = plain(value, ["amountOut", "burned", "feeShares", "exempt", "state"], "peapods debond output");
    uint(output.amountOut!, "peapods debond amountOut");
    uint(output.burned!, "peapods debond burned");
    uint(output.feeShares!, "peapods debond feeShares");
    if (typeof output.exempt !== "boolean") throw new Error("peapods debond exempt");
    const state = plain(output.state!, ["supply", "backing", "feeBps"], "peapods debond state");
    uint(state.supply!, "peapods debond state supply");
    uint(state.backing!, "peapods debond state backing");
    uint(state.feeBps!, "peapods debond state feeBps");
  },
});
