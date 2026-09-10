import type { BlockScanOpportunity } from "./detector/detector.js";
import type { BlockScanStateSnapshot } from "./blockscan-state-coordinator.js";
import { nextBlockBaseFee } from "./ev-evaluator.js";
import { blockScanEdgeKey, type BlockSource } from "./venues/blockscan-state-capability.js";
import { edgeInstanceKey } from "./venues/route-instance-identity.js";

export interface RawTokenRate {
  /** WETH wei per input-token raw unit; token decimals must NOT be applied again. */
  readonly num: bigint;
  readonly den: bigint;
}

interface ReferenceHeader {
  readonly number: number;
  readonly hash: string | null;
  readonly parentHash: string;
  readonly baseFeePerGas?: bigint | null;
  readonly gasUsed?: bigint;
  readonly gasLimit?: bigint;
}

type PricingReference = Pick<BlockScanStateSnapshot,
  "sourceBlock" | "sourceBlockHash" | "generation" | "graph" | "mids" | "coverage">;

/** Converts the decimal representation of a finite Number without fixed-scale underflow. */
function ratio(value: number): RawTokenRate | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const [mantissa, exponent = "0"] = value.toString().toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  const digits = BigInt(whole! + fraction);
  const scale = fraction.length - Number(exponent);
  return scale >= 0
    ? { num: digits, den: 10n ** BigInt(scale) }
    : { num: digits * 10n ** BigInt(-scale), den: 1n };
}

const compareRates = (a: RawTokenRate, b: RawTokenRate): number => {
  const delta = a.num * b.den - b.num * a.den;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
};
const multiply = (a: RawTokenRate, b: RawTokenRate): RawTokenRate =>
  ({ num: a.num * b.num, den: a.den * b.den });
const lowerMedian = (rates: RawTokenRate[]): RawTokenRate =>
  rates.sort(compareRates)[Math.floor((rates.length - 1) / 2)]!;

/** Approximate marks for sizing only, never trusted final-EV valuation. No RPC. */
export function tokenToWethReferences(
  pricing: PricingReference,
  weth: string,
): ReadonlyMap<string, RawTokenRate> {
  const pairs = new Map<string, { from: string; to: string; instances: Map<string, RawTokenRate> }>();
  const resolved = new Set(pricing.coverage.resolvedEdgeKeys);
  for (const edge of pricing.graph.edges) {
    if (edge.leavesStandingPosition) continue;
    const key = blockScanEdgeKey(edge);
    if (!resolved.has(key)) continue;
    const mid = pricing.mids.get(key);
    if (!mid || !Number.isFinite(mid.feeBps) || mid.feeBps < 0 || mid.feeBps >= 10_000) continue;
    const rate = ratio(mid.mid);
    const residualFee = ratio(10_000 - mid.feeBps);
    if (!rate || !residualFee) continue;
    const from = edge.tokenIn.toLowerCase();
    const to = edge.tokenOut.toLowerCase();
    if (from === to) continue;
    const pairKey = `${from}|${to}`;
    let pair = pairs.get(pairKey);
    if (!pair) {
      pair = { from, to, instances: new Map() };
      pairs.set(pairKey, pair);
    }
    const adjusted = multiply(rate, { num: residualFee.num, den: residualFee.den * 10_000n });
    const instance = edgeInstanceKey(edge);
    const previous = pair.instances.get(instance);
    // Multiple execution variants of one logical venue get one vote.
    if (!previous || compareRates(adjusted, previous) < 0) pair.instances.set(instance, adjusted);
  }
  const directed = [...pairs.values()].map(pair => ({
    from: pair.from, to: pair.to, rate: lowerMedian([...pair.instances.values()]),
  }));
  const marks = new Map<string, RawTokenRate>([[weth.toLowerCase(), { num: 1n, den: 1n }]]);
  // Shortest directed paths only. Each layer reads the completed prior layer,
  // so cycles cannot amplify marks and no reverse edge is invented.
  for (let hop = 0; hop < 3; hop++) {
    const candidates = new Map<string, RawTokenRate[]>();
    for (const pair of directed) {
      if (marks.has(pair.from)) continue;
      const tail = marks.get(pair.to);
      if (!tail) continue;
      const values = candidates.get(pair.from) ?? [];
      values.push(multiply(pair.rate, tail));
      candidates.set(pair.from, values);
    }
    for (const [token, values] of candidates) marks.set(token, lowerMedian(values));
    if (candidates.size === 0) break;
  }
  return marks;
}

export function gasReferenceInput(
  gasWei: bigint,
  rate: RawTokenRate,
  enumerationSpreadBps: number,
): bigint | null {
  const spread = ratio(enumerationSpreadBps);
  if (gasWei <= 0n || rate.num <= 0n || rate.den <= 0n || !spread) return null;
  // Strictly above estimated gas at the CURRENT enumeration floor. This is a
  // reference point, not a guarantee of realizable spread or positive net EV.
  return gasWei * 10_000n * rate.den * spread.den / (spread.num * rate.num) + 1n;
}

export function resolveExactProbe(gasMinRaw: bigint | null | undefined): bigint {
  return gasMinRaw == null || gasMinRaw < 10n ? 10n : gasMinRaw;
}

/** One instance per configured live process; never persists across execution-config changes. */
export class BlockScanAmountReference {
  private readonly headers = new Map<number, ReferenceHeader>();
  private readonly samples = new Map<number, { source: BlockSource; gasUsed: bigint }>();

  constructor(private readonly weth: string, private readonly capacity = 2048) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new Error("invalid amount reference capacity");
  }

  private ancestorHashes(number: number): ReadonlyMap<number, string> {
    const ancestors = new Map<number, string>();
    let header = this.headers.get(number);
    while (header?.hash) {
      ancestors.set(header.number, header.hash);
      const parent = this.headers.get(header.number - 1);
      if (!parent || parent.hash !== header.parentHash) break;
      header = parent;
    }
    return ancestors;
  }

  observeHeader(header: ReferenceHeader): void {
    if (!header.hash || !Number.isSafeInteger(header.number) || header.number < 0) return;
    const previous = this.headers.get(header.number);
    const parent = this.headers.get(header.number - 1);
    if ((previous && previous.hash !== header.hash.toLowerCase()) ||
        (parent && parent.hash !== header.parentHash.toLowerCase())) {
      this.samples.clear();
      this.headers.clear();
    }
    this.headers.delete(header.number);
    this.headers.set(header.number, Object.freeze({
      number: header.number, hash: header.hash.toLowerCase(), parentHash: header.parentHash.toLowerCase(),
      baseFeePerGas: header.baseFeePerGas, gasUsed: header.gasUsed, gasLimit: header.gasLimit,
    }));
    while (this.headers.size > this.capacity) this.headers.delete(this.headers.keys().next().value!);
  }

  /** Caller supplies only successful final sims after its existing source/hash check. */
  recordSimulation(input: {
    opportunity: BlockScanOpportunity; source: BlockSource; gasUsed: bigint; success: boolean;
  }): void {
    if (!input.success || input.gasUsed <= 0n ||
        this.headers.get(input.source.number)?.hash !== input.source.hash.toLowerCase()) return;
    // One maximum per observed block, shared across routes. The observation
    // contract still accepts opportunity, but route identity does not gate reuse.
    const key = input.source.number;
    const previous = this.samples.get(key);
    // This is an observed sizing estimate, not a bound on future execution gas.
    if (previous && previous.gasUsed >= input.gasUsed &&
        previous.source.hash.toLowerCase() === input.source.hash.toLowerCase()) return;
    this.samples.delete(key);
    this.samples.set(key, { source: { ...input.source }, gasUsed: input.gasUsed });
    while (this.samples.size > this.capacity) this.samples.delete(this.samples.keys().next().value!);
  }

  prepare(input: {
    source: BlockSource;
    pricing: PricingReference | null;
    enumerationSpreadBps: number;
    opportunities: readonly BlockScanOpportunity[];
  }): ReadonlyMap<BlockScanOpportunity, bigint> {
    const result = new Map<BlockScanOpportunity, bigint>();
    const { pricing, source } = input;
    const header = this.headers.get(source.number);
    if (!pricing || !header || header.hash !== source.hash.toLowerCase() ||
        pricing.sourceBlock !== source.number ||
        pricing.sourceBlockHash.toLowerCase() !== source.hash.toLowerCase() ||
        pricing.generation !== source.generation) return result;
    const fee = nextBlockBaseFee(header);
    if (fee === null) return result;
    const ancestors = this.ancestorHashes(source.number);
    let gasUsed = 0n;
    let gasSourceBlock = -1;
    // Prefer N-1, otherwise the nearest earlier successful block. An older,
    // higher-gas execution must not displace a newer observation. Only units
    // are reused: the current header above supplies the target gas price.
    for (const sample of this.samples.values()) {
      if (sample.source.number < source.number && sample.source.number > gasSourceBlock &&
          ancestors.get(sample.source.number) === sample.source.hash.toLowerCase()) {
        gasSourceBlock = sample.source.number;
        gasUsed = sample.gasUsed;
      }
    }
    if (gasUsed === 0n || input.opportunities.length === 0) return result;
    const marks = tokenToWethReferences(pricing, this.weth);
    const amounts = new Map<string, bigint | null>();
    for (const opportunity of input.opportunities) {
      const token = opportunity.flashToken.toLowerCase();
      const mark = marks.get(token);
      if (!mark) continue;
      if (!amounts.has(token)) amounts.set(token, gasReferenceInput(gasUsed * fee, mark, input.enumerationSpreadBps));
      const amount = amounts.get(token);
      if (amount != null) result.set(opportunity, amount);
    }
    return result; // A pass-owned value map; later samples/headers cannot change it.
  }
}
