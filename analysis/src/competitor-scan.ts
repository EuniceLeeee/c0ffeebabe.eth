import { RpcClient, hexToBigInt, toQuantity } from "./rpc/client.js";
import { mapLimit } from "./util.js";
import { ethers } from "ethers";

export type DropStatus = "competitor_took" | "no_competitor" | "v_not_mined";
export type VictimSource = "mev-share" | "mempool" | "unknown";

interface CompetitorScanOptions {
  eventsPath: string;
  events: any[];
  rpc: RpcClient;
  notSeenScan?: boolean;
  concurrency?: number;
  triageCap?: number;
}

interface DropInput {
  index: number;
  reason: string;
  victimHash: string;
  victimSource: VictimSource;
  pool: string;
}

interface RpcLog {
  address?: string;
  transactionHash?: string;
  transactionIndex?: string;
}

interface RpcReceipt {
  blockNumber?: string;
  transactionIndex?: string;
  gasUsed?: string;
  to?: string | null;
  logs?: RpcLog[];
}

interface PoolLogTx {
  hash: string;
  transactionIndex: number;
}

export interface CandidateAnalysis {
  hash: string;
  transactionIndex: number;
  distinctPools: number;
  gasUsed: string;
  to: string | null;
  toIsContract: boolean;
}

export interface DropResult {
  index: number;
  reason: string;
  pool: string;
  victimHash: string;
  victimSource: VictimSource;
  victimBlock: number | null;
  status: DropStatus;
  bestCandidate: CandidateAnalysis | null;
}

export interface CompetitorScanResult {
  results: DropResult[];
  triage: TriageItem[];
}

interface DoubleHashResolution {
  realTx: string;
  block: number;
}

export interface TriageItem {
  block: number;
  transactionIndex: number;
  hash: string;
  distinctPools: number;
  gasUsed: string;
  to: string;
}

interface ScanContext {
  rpc: RpcClient;
  gate: RpcGate;
  concurrency: number;
  triageCap: number;
  seenVictimHashes: Set<string>;
  receiptCache: Map<string, Promise<RpcReceipt | null>>;
  logsCache: Map<string, Promise<RpcLog[]>>;
  codeCache: Map<string, Promise<string>>;
  errors: string[];
}

export async function runCompetitorScan(options: CompetitorScanOptions): Promise<CompetitorScanResult> {
  const concurrency = options.concurrency ?? 8;
  const ctx: ScanContext = {
    rpc: options.rpc,
    gate: new RpcGate(concurrency),
    concurrency,
    triageCap: options.triageCap ?? 50,
    seenVictimHashes: buildSeenVictimSet(options.events),
    receiptCache: new Map(),
    logsCache: new Map(),
    codeCache: new Map(),
    errors: [],
  };

  const drops = options.events
    .map((event, index) => toDropInput(event, index))
    .filter((drop): drop is DropInput => drop !== null);
  const seenVictims = ctx.seenVictimHashes.size;

  let results = await mapLimit(drops, concurrency, async (drop) => {
    try {
      return await analyzeDrop(ctx, drop);
    } catch (err) {
      ctx.errors.push(`drop#${drop.index} unexpected: ${(err as Error).message}`);
      return errorDropResult(drop);
    }
  });
  results = await resolveMevShareDoubleHashDrops(ctx, drops, results);
  const triage = options.notSeenScan ? await runNotSeenScan(ctx, results) : [];

  console.log(renderCompetitorScan({
    eventsPath: options.eventsPath,
    drops: drops.length,
    seenVictims,
    results,
    triage,
    triageCap: ctx.triageCap,
    notSeenScan: Boolean(options.notSeenScan),
  }));

  if (ctx.errors.length > 0) {
    const errors = [...ctx.errors].sort(compareStrings);
    console.error(`[analysis/competitor-scan] errors=${errors.length}`);
    for (const err of errors.slice(0, 25)) console.error(`[analysis/competitor-scan] ${err}`);
    if (errors.length > 25) console.error(`[analysis/competitor-scan] omitted_errors=${errors.length - 25}`);
  }

  return { results, triage };
}

async function analyzeDrop(
  ctx: ScanContext,
  drop: DropInput,
): Promise<DropResult> {
  const base = (): DropResult => ({
    index: drop.index,
    reason: drop.reason,
    pool: lower(drop.pool),
    victimHash: lower(drop.victimHash),
    victimSource: drop.victimSource,
    victimBlock: null,
    status: "no_competitor",
    bestCandidate: null,
  });

  if (!isTxHash(drop.victimHash)) {
    ctx.errors.push(`drop#${drop.index} invalid victim_hash=${drop.victimHash || "missing"}`);
    return { ...base(), status: "v_not_mined" };
  }
  if (!isAddress(drop.pool)) {
    ctx.errors.push(`drop#${drop.index} invalid pool=${drop.pool || "missing"}`);
    return base();
  }

  let victimReceipt: RpcReceipt | null;
  try {
    victimReceipt = await getReceiptCached(ctx, drop.victimHash);
  } catch (err) {
    ctx.errors.push(`drop#${drop.index} victim_receipt ${drop.victimHash}: ${(err as Error).message}`);
    return { ...base(), status: "v_not_mined" };
  }
  const victimBlock = quantityToNumber(victimReceipt?.blockNumber);
  const victimIndex = quantityToNumber(victimReceipt?.transactionIndex);
  if (!victimReceipt || victimBlock === null || victimIndex === null) {
    return { ...base(), status: "v_not_mined" };
  }

  let poolLogs: RpcLog[];
  try {
    poolLogs = await getPoolLogsCached(ctx, drop.pool, victimBlock);
  } catch (err) {
    ctx.errors.push(`drop#${drop.index} pool_logs pool=${drop.pool} block=${victimBlock}: ${(err as Error).message}`);
    return { ...base(), victimBlock };
  }

  const victimHash = lower(drop.victimHash);
  const candidateTxs = collectPoolLogTxs(poolLogs).filter((tx) =>
    tx.transactionIndex > victimIndex &&
    tx.hash !== victimHash &&
    !ctx.seenVictimHashes.has(tx.hash)
  );

  const candidates = (await mapLimit(candidateTxs, ctx.concurrency, async (tx) =>
    analyzeCandidate(ctx, tx, victimBlock, drop.index)
  )).filter((candidate): candidate is CandidateAnalysis => candidate !== null);

  const arbCandidates = candidates
    .filter((candidate) => candidate.distinctPools >= 2)
    .sort(compareCandidates);
  const bestCandidate = arbCandidates[0] ?? null;
  return {
    ...base(),
    victimBlock,
    status: bestCandidate ? "competitor_took" : "no_competitor",
    bestCandidate,
  };
}

async function resolveMevShareDoubleHashDrops(
  ctx: ScanContext,
  drops: DropInput[],
  results: DropResult[],
): Promise<DropResult[]> {
  const unresolved = results.filter((result) =>
    result.status === "v_not_mined" &&
    isTxHash(result.victimHash)
  );
  if (unresolved.length === 0) return results;

  const blocks = await seenVictimBlocks(ctx, results);
  if (blocks.length === 0) return results;

  const reverseMap = await buildMevShareDoubleHashReverseMap(ctx, blocks);
  if (reverseMap.size === 0) return results;

  const matches = unresolved
    .map((result) => ({
      result,
      drop: drops.find((candidate) => candidate.index === result.index),
      resolved: reverseMap.get(result.victimHash),
    }))
    .filter((item): item is { result: DropResult; drop: DropInput; resolved: DoubleHashResolution } =>
      item.drop !== undefined && item.resolved !== undefined
    );
  if (matches.length === 0) return results;

  for (const match of matches) ctx.seenVictimHashes.add(match.resolved.realTx);

  const replacements = new Map<number, DropResult>();
  await mapLimit(matches, ctx.concurrency, async (match) => {
    try {
      replacements.set(
        match.result.index,
        await analyzeDrop(ctx, { ...match.drop, victimHash: match.resolved.realTx }),
      );
    } catch (err) {
      ctx.errors.push(
        `drop#${match.result.index} mev_share_resolution ${match.resolved.realTx}: ${(err as Error).message}`,
      );
    }
  });

  return results.map((result) => replacements.get(result.index) ?? result);
}

async function buildMevShareDoubleHashReverseMap(
  ctx: ScanContext,
  victimBlocks: number[],
): Promise<Map<string, DoubleHashResolution>> {
  const reverseMap = new Map<string, DoubleHashResolution>();
  const window = expandedBlockWindow(victimBlocks);

  await mapLimit(window, ctx.concurrency, async (blockNumber) => {
    let block: any;
    try {
      block = await ctx.gate.run(() => ctx.rpc.getBlockByNumber(blockNumber, true));
    } catch (err) {
      ctx.errors.push(`double_hash_block block=${blockNumber}: ${(err as Error).message}`);
      return;
    }

    const txs: any[] = Array.isArray(block?.transactions) ? block.transactions : [];
    for (const tx of txs) {
      const materials = blockTxHashMaterials(tx);
      const realTx = blockTxRealHash(tx, materials);
      if (!realTx) continue;

      const hashMaterials = new Set([...materials, realTx]);
      for (const material of hashMaterials) {
        let doubleHash: string;
        try {
          doubleHash = lower(ethers.keccak256(material));
        } catch {
          continue;
        }
        if (!reverseMap.has(doubleHash)) reverseMap.set(doubleHash, { realTx, block: blockNumber });
      }
    }
  });

  return reverseMap;
}

async function analyzeCandidate(
  ctx: ScanContext,
  tx: PoolLogTx,
  victimBlock: number,
  dropIndex: number,
): Promise<CandidateAnalysis | null> {
  let receipt: RpcReceipt | null;
  try {
    receipt = await getReceiptCached(ctx, tx.hash);
  } catch (err) {
    ctx.errors.push(`drop#${dropIndex} candidate_receipt ${tx.hash}: ${(err as Error).message}`);
    return null;
  }
  if (!receipt) return null;

  const to = normalizeAddress(receipt.to);
  let toIsContract = false;
  if (to) {
    try {
      const code = await getCodeCached(ctx, to, victimBlock);
      toIsContract = isContractCode(code);
    } catch (err) {
      ctx.errors.push(`drop#${dropIndex} candidate_code ${tx.hash} to=${to}: ${(err as Error).message}`);
    }
  }

  return {
    hash: tx.hash,
    transactionIndex: quantityToNumber(receipt.transactionIndex) ?? tx.transactionIndex,
    distinctPools: distinctLogAddresses(receipt).size,
    gasUsed: hexToBigInt(receipt.gasUsed).toString(),
    to,
    toIsContract,
  };
}

async function runNotSeenScan(ctx: ScanContext, dropResults: DropResult[]): Promise<TriageItem[]> {
  const victimBlocks = await seenVictimBlocks(ctx, dropResults);
  if (victimBlocks.length === 0) return [];
  const from = victimBlocks[0];
  const to = victimBlocks[victimBlocks.length - 1];
  const out: TriageItem[] = [];

  for (let blockNumber = from; blockNumber <= to && out.length < ctx.triageCap; blockNumber++) {
    let block: any;
    try {
      block = await ctx.gate.run(() => ctx.rpc.getBlockByNumber(blockNumber, true));
    } catch (err) {
      ctx.errors.push(`not_seen block=${blockNumber}: ${(err as Error).message}`);
      continue;
    }
    const txs: any[] = Array.isArray(block?.transactions) ? block.transactions : [];
    for (let i = 0; i < txs.length && out.length < ctx.triageCap; i += ctx.concurrency) {
      const chunk = txs.slice(i, i + ctx.concurrency);
      const items = await mapLimit(chunk, ctx.concurrency, async (tx, offset) =>
        analyzeNotSeenTx(ctx, tx, blockNumber, i + offset)
      );
      for (const item of items) {
        if (item) out.push(item);
        if (out.length >= ctx.triageCap) break;
      }
    }
  }

  return out.sort(compareTriage).slice(0, ctx.triageCap);
}

async function analyzeNotSeenTx(
  ctx: ScanContext,
  tx: any,
  blockNumber: number,
  fallbackIndex: number,
): Promise<TriageItem | null> {
  const hash = typeof tx?.hash === "string" ? lower(tx.hash) : "";
  if (!isTxHash(hash) || ctx.seenVictimHashes.has(hash)) return null;

  let receipt: RpcReceipt | null;
  try {
    receipt = await getReceiptCached(ctx, hash);
  } catch (err) {
    ctx.errors.push(`not_seen receipt ${hash}: ${(err as Error).message}`);
    return null;
  }
  if (!receipt) return null;

  const distinctPools = distinctLogAddresses(receipt).size;
  if (distinctPools < 3) return null;

  const to = normalizeAddress(receipt.to) ?? normalizeAddress(tx.to);
  if (!to) return null;

  let code: string;
  try {
    code = await getCodeCached(ctx, to, blockNumber);
  } catch (err) {
    ctx.errors.push(`not_seen code ${hash} to=${to}: ${(err as Error).message}`);
    return null;
  }
  if (!isContractCode(code)) return null;

  return {
    block: blockNumber,
    transactionIndex: quantityToNumber(receipt.transactionIndex) ?? quantityToNumber(tx.transactionIndex) ?? fallbackIndex,
    hash,
    distinctPools,
    gasUsed: hexToBigInt(receipt.gasUsed).toString(),
    to,
  };
}

async function seenVictimBlocks(ctx: ScanContext, dropResults: DropResult[]): Promise<number[]> {
  const blocks = new Set<number>();
  for (const result of dropResults) {
    if (result.victimBlock !== null) blocks.add(result.victimBlock);
  }

  const missingHashes = [...ctx.seenVictimHashes]
    .sort(compareStrings)
    .filter((hash) => !ctx.receiptCache.has(hash));
  await mapLimit(missingHashes, ctx.concurrency, async (hash) => {
    try {
      const receipt = await getReceiptCached(ctx, hash);
      const block = quantityToNumber(receipt?.blockNumber);
      if (block !== null) blocks.add(block);
    } catch (err) {
      ctx.errors.push(`seen_victim_receipt ${hash}: ${(err as Error).message}`);
    }
  });

  return [...blocks].sort(compareNumbers);
}

function renderCompetitorScan(input: {
  eventsPath: string;
  drops: number;
  seenVictims: number;
  results: DropResult[];
  triage: TriageItem[];
  triageCap: number;
  notSeenScan: boolean;
}): string {
  const lines: string[] = [];
  lines.push("# Competitor Cross-Reference");
  lines.push("");
  lines.push(`events=${input.eventsPath}`);
  lines.push(`pipeline_dropped=${input.drops}`);
  lines.push(`seen_victims=${input.seenVictims}`);
  lines.push("");
  lines.push("| reason | competitor_took | no_competitor | v_not_mined |");
  lines.push("|---|---:|---:|---:|");
  for (const row of reasonRows(input.results)) {
    lines.push(`| ${row.reason} | ${row.competitor_took} | ${row.no_competitor} | ${row.v_not_mined} |`);
  }

  lines.push("");
  lines.push("victim_source summary:");
  lines.push("| victim_source | competitor_took | no_competitor | v_not_mined |");
  lines.push("|---|---:|---:|---:|");
  for (const row of victimSourceRows(input.results)) {
    lines.push(`| ${row.victim_source} | ${row.competitor_took} | ${row.no_competitor} | ${row.v_not_mined} |`);
  }

  const details = input.results
    .filter((result) => result.status === "competitor_took" && result.bestCandidate)
    .sort(compareDropDetails);
  lines.push("");
  lines.push("competitor_took details:");
  if (details.length === 0) {
    lines.push("none");
  } else {
    for (const result of details) {
      const candidate = result.bestCandidate;
      if (!candidate) continue;
      lines.push(
        `reason=${result.reason} pool=${result.pool} victim_source=${result.victimSource} ` +
        `victim_block=${result.victimBlock} ` +
        `competitor_tx=${candidate.hash} distinct_pools=${candidate.distinctPools} ` +
        `gasUsed=${candidate.gasUsed} to=${candidate.to ?? "n/a"} to_contract=${candidate.toIsContract}`,
      );
    }
  }

  if (input.notSeenScan) {
    lines.push("");
    lines.push(`not_seen_scan triage (cap=${input.triageCap}):`);
    if (input.triage.length === 0) {
      lines.push("none");
    } else {
      for (const item of input.triage) {
        lines.push(
          `block=${item.block} tx_index=${item.transactionIndex} tx=${item.hash} ` +
          `distinct_pools=${item.distinctPools} gasUsed=${item.gasUsed} to=${item.to}`,
        );
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function errorDropResult(drop: DropInput): DropResult {
  return {
    index: drop.index,
    reason: drop.reason,
    pool: lower(drop.pool),
    victimHash: lower(drop.victimHash),
    victimSource: drop.victimSource,
    victimBlock: null,
    status: "no_competitor",
    bestCandidate: null,
  };
}

function reasonRows(results: DropResult[]): Array<Record<DropStatus | "reason", string | number>> {
  const rows = new Map<string, Record<DropStatus, number>>();
  for (const result of results) {
    const row = rows.get(result.reason) ?? { competitor_took: 0, no_competitor: 0, v_not_mined: 0 };
    row[result.status]++;
    rows.set(result.reason, row);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([reason, counts]) => ({ reason, ...counts }));
}

function victimSourceRows(results: DropResult[]): Array<Record<DropStatus | "victim_source", string | number>> {
  const rows = new Map<VictimSource, Record<DropStatus, number>>();
  for (const result of results) {
    const row = rows.get(result.victimSource) ?? { competitor_took: 0, no_competitor: 0, v_not_mined: 0 };
    row[result.status]++;
    rows.set(result.victimSource, row);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([victim_source, counts]) => ({ victim_source, ...counts }));
}

function toDropInput(event: any, index: number): DropInput | null {
  if (event?.type !== "pipeline_dropped") return null;
  return {
    index,
    reason: stringValue(event.reason) ?? stringValue(event.stage) ?? "unknown",
    victimHash: stringValue(event.victim_hash ?? event.victimHash) ?? "",
    victimSource: victimSourceValue(event.victim_source ?? event.victimSource),
    pool: stringValue(event.pool) ?? "",
  };
}

function buildSeenVictimSet(events: any[]): Set<string> {
  const out = new Set<string>();
  for (const event of events) {
    if (event?.type !== "opportunity_seen" && event?.type !== "pipeline_dropped") continue;
    const victim = stringValue(event.victim_hash ?? event.victimHash);
    if (victim) out.add(lower(victim));
  }
  return out;
}

function collectPoolLogTxs(logs: RpcLog[]): PoolLogTx[] {
  const byHash = new Map<string, PoolLogTx>();
  for (const log of logs) {
    const hash = typeof log.transactionHash === "string" ? lower(log.transactionHash) : "";
    const transactionIndex = quantityToNumber(log.transactionIndex);
    if (!isTxHash(hash) || transactionIndex === null) continue;
    const prev = byHash.get(hash);
    if (!prev || transactionIndex < prev.transactionIndex) byHash.set(hash, { hash, transactionIndex });
  }
  return [...byHash.values()].sort((a, b) =>
    compareNumbers(a.transactionIndex, b.transactionIndex) || compareStrings(a.hash, b.hash)
  );
}

function distinctLogAddresses(receipt: RpcReceipt): Set<string> {
  const out = new Set<string>();
  for (const log of receipt.logs ?? []) {
    const address = normalizeAddress(log.address);
    if (address) out.add(address);
  }
  return out;
}

function getReceiptCached(ctx: ScanContext, hash: string): Promise<RpcReceipt | null> {
  const key = lower(hash);
  const existing = ctx.receiptCache.get(key);
  if (existing) return existing;
  const promise = ctx.gate.run(() => ctx.rpc.getReceipt(key)) as Promise<RpcReceipt | null>;
  ctx.receiptCache.set(key, promise);
  return promise;
}

function getPoolLogsCached(ctx: ScanContext, pool: string, block: number): Promise<RpcLog[]> {
  const key = `${lower(pool)}:${block}`;
  const existing = ctx.logsCache.get(key);
  if (existing) return existing;
  const blockTag = toQuantity(block);
  const promise = ctx.gate.run(() =>
    ctx.rpc.getLogs({ address: pool, fromBlock: blockTag, toBlock: blockTag })
  ) as Promise<RpcLog[]>;
  ctx.logsCache.set(key, promise);
  return promise;
}

function getCodeCached(ctx: ScanContext, address: string, block: number): Promise<string> {
  const blockTag = toQuantity(block);
  const key = `${lower(address)}:${blockTag}`;
  const existing = ctx.codeCache.get(key);
  if (existing) return existing;
  const promise = ctx.gate.run(() => ctx.rpc.getCode(address, blockTag));
  ctx.codeCache.set(key, promise);
  return promise;
}

function expandedBlockWindow(blocks: number[]): number[] {
  if (blocks.length === 0) return [];
  const from = Math.max(0, blocks[0] - 1);
  const to = blocks[blocks.length - 1] + 8;
  const out: number[] = [];
  for (let block = from; block <= to; block++) out.push(block);
  return out;
}

function blockTxHashMaterials(tx: any): string[] {
  const out: string[] = [];
  addHexMaterial(out, tx);
  addHexMaterial(out, tx?.hash);
  addHexMaterial(out, tx?.raw);
  addHexMaterial(out, tx?.rawTransaction);
  addHexMaterial(out, tx?.serialized);

  if (tx && typeof tx === "object") {
    try {
      addHexMaterial(out, ethers.Transaction.from(tx).serialized);
    } catch {
      // Some RPC transaction objects are not directly accepted by ethers; tx.hash still covers them.
    }
  }

  return [...new Set(out)];
}

function blockTxRealHash(tx: any, materials: string[]): string | null {
  if (typeof tx?.hash === "string" && isTxHash(tx.hash)) return lower(tx.hash);
  if (typeof tx === "string" && isTxHash(tx)) return lower(tx);

  for (const material of materials) {
    try {
      return lower(ethers.keccak256(material));
    } catch {
      continue;
    }
  }
  return null;
}

function addHexMaterial(out: string[], value: unknown): void {
  if (typeof value === "string" && isHexBytes(value)) out.push(lower(value));
}

function compareCandidates(a: CandidateAnalysis, b: CandidateAnalysis): number {
  return (
    compareNumbers(b.distinctPools, a.distinctPools) ||
    compareNumbers(a.transactionIndex, b.transactionIndex) ||
    compareStrings(a.hash, b.hash)
  );
}

function compareDropDetails(a: DropResult, b: DropResult): number {
  return (
    compareStrings(a.reason, b.reason) ||
    compareNumbers(a.victimBlock ?? Number.MAX_SAFE_INTEGER, b.victimBlock ?? Number.MAX_SAFE_INTEGER) ||
    compareNumbers(a.index, b.index)
  );
}

function compareTriage(a: TriageItem, b: TriageItem): number {
  return (
    compareNumbers(a.block, b.block) ||
    compareNumbers(a.transactionIndex, b.transactionIndex) ||
    compareStrings(a.hash, b.hash)
  );
}

function compareNumbers(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function compareStrings(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function quantityToNumber(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return Number(BigInt(value));
  } catch {
    return null;
  }
}

function normalizeAddress(value: unknown): string | null {
  if (typeof value !== "string" || !isAddress(value)) return null;
  return lower(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function victimSourceValue(value: unknown): VictimSource {
  return value === "mev-share" || value === "mempool" ? value : "unknown";
}

function isAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isTxHash(value: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(value);
}

function isHexBytes(value: string): boolean {
  return /^0x(?:[a-fA-F0-9]{2})*$/.test(value);
}

function isContractCode(code: string): boolean {
  return code !== "0x" && code !== "0x0";
}

function lower(value: string): string {
  return value.toLowerCase();
}

class RpcGate {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}
