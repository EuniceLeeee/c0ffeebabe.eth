import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { PoolLegRefreshIndex } from "./pool-leg-refresh.js";

/** The SQL instance key identifies one directed, selector-specific leg. Asset
 * and resource IDs are opaque; the zero token address stays native ETH. */
export interface SqlPriceEdge {
  readonly candidateInstanceKey: string;
  readonly chainId: 1;
  readonly selector: string;
  readonly poolAddress: string;
  readonly poolNamespace: string | null;
  readonly poolId: string | null;
  readonly tokenIn: string;
  readonly tokenInId: string | null;
  readonly tokenOut: string;
  readonly tokenOutId: string | null;
  /** Optional historical inputs from the pinned SQL artifact. Not a price,
   * signed program or permission to supersede Family-configured values. */
  readonly executionParamEvidence?: SqlExecutionParamEvidence;
}
type ParamRecipe=Readonly<{index:number;observed:readonly Readonly<{key:string;kind:'argument'|'pool-id-tuple'|'direction-asset';value:string|boolean}>[];missing:readonly string[]}>;
type SqlExecutionParamEvidence=Readonly<{consensus:'nonuniform'|'not-declared'}>|Readonly<{
  consensus:'uniform';definitionSha256:string;recipes:readonly ParamRecipe[];txHash:string;callPath:string;innerSwapPath:string|null
}>;
export interface SqlPriceLogicalTouch {
  readonly poolAddress: string;
  readonly poolId: string;
  readonly poolNamespace?: string | null;
}
export type SqlPricePoolTouch =
  | { readonly poolAddress: string; readonly poolId?: null; readonly poolNamespace?: null }
  | SqlPriceLogicalTouch;

const maxBytes = 256 * 1024 * 1024;
const maxRows = 2_000_000;
const zeroAddress = "0x" + "0".repeat(40);
const isHash = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
const isAddress = (x: unknown): x is string => typeof x === "string" && /^0x[0-9a-f]{40}$/.test(x);
const isId = (x: unknown): x is string | null => x === null || (typeof x === "string" && x.length > 0 && x.length <= 256);
const sha256 = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");
function record(x: unknown): Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) throw Error("invalid SQL input record");
  return x as Record<string, unknown>;
}
function paramEvidence(x:unknown):SqlExecutionParamEvidence {
  const e=record(x);
  if(e.consensus==='nonuniform'||e.consensus==='not-declared'){
    if(Object.keys(e).length!==1)throw Error('ambiguous SQL execution evidence');
    return Object.freeze({consensus:e.consensus});
  }
  const path=(s:unknown):s is string=>typeof s==='string'&&s.length<=4096&&/^(?:|(?:0|[1-9]\d*)(?:,(?:0|[1-9]\d*))*)$/.test(s);
  if(e.consensus!=='uniform'||!isHash(e.definitionSha256)||!Array.isArray(e.recipes)||e.recipes.length>256||
    typeof e.txHash!=='string'||!/^0x[0-9a-f]{64}$/.test(e.txHash)||!path(e.callPath)||!(e.innerSwapPath===null||path(e.innerSwapPath)))throw Error('invalid SQL execution evidence');
  const recipes=e.recipes.map((r:unknown,index:number)=>{
    const row=record(r);if(row.index!==index||!Array.isArray(row.observed)||!Array.isArray(row.missing)||
      row.observed.length+row.missing.length>1024)throw Error('invalid SQL recipe parameters');
    const ks=new Set<string>(),key=(k:unknown)=>{if(typeof k!=='string'||!k||k.length>1024||ks.has(k))throw Error('invalid SQL parameter key');ks.add(k);return k;};
    const observed=row.observed.map((raw:unknown)=>{const v=record(raw);if(!(v.kind==='argument'||v.kind==='pool-id-tuple'||v.kind==='direction-asset')||
      (typeof v.value!=='boolean'&&!(typeof v.value==='string'&&v.value.length<=1024)))throw Error('invalid observed execution parameter');
      return Object.freeze({key:key(v.key),kind:v.kind,value:v.value});});
    return Object.freeze({index,observed:Object.freeze(observed),missing:Object.freeze(row.missing.map(key))});
  });
  return Object.freeze({consensus:'uniform',definitionSha256:e.definitionSha256,recipes:Object.freeze(recipes),txHash:e.txHash,callPath:e.callPath,innerSwapPath:e.innerSwapPath});
}

/** BigQuery TO_JSON_STRING of this ordered, nullable tuple is the sole public leg id. */
export function sqlDirectionId(edge: Omit<SqlPriceEdge,"candidateInstanceKey">):string {
  const {chainId,selector,poolAddress,poolNamespace,poolId,tokenIn,tokenInId,tokenOut,tokenOutId}=edge;
  return "candidate-edge:v1:"+sha256(JSON.stringify([String(chainId),selector,poolAddress,poolNamespace,poolId,tokenIn,tokenInId,tokenOut,tokenOutId]));
}
function parseEdge(x: unknown): SqlPriceEdge {
  const {chainId, selector, poolAddress, poolNamespace, poolId, tokenIn, tokenInId, tokenOut, tokenOutId, candidateInstanceKey} = record(x);
  if (chainId !== 1 || !isAddress(poolAddress) || poolAddress === zeroAddress ||
    typeof selector !== "string" || !/^0x[0-9a-f]{8}$/.test(selector) ||
    !isAddress(tokenIn) || !isAddress(tokenOut) || !isId(tokenInId) || !isId(tokenOutId) ||
    !isId(poolNamespace) || !isId(poolId) || (poolNamespace !== null && poolId === null) ||
    (tokenIn === tokenOut && tokenInId === tokenOutId)) throw Error("invalid SQL price edge coordinates");
  // Match BigQuery TO_JSON_STRING([CAST(chainId AS STRING), ...]); never
  // reconstruct an adapter/Ready key from these coordinates.
  if (candidateInstanceKey !== sqlDirectionId({chainId,selector,poolAddress,poolNamespace,poolId,tokenIn,tokenInId,tokenOut,tokenOutId})) throw Error("SQL candidate instance key mismatch");
  const extra=Object.hasOwn(record(x),'executionParamEvidence')?{executionParamEvidence:paramEvidence(record(x).executionParamEvidence)}:{};
  return {candidateInstanceKey: candidateInstanceKey as string, chainId, selector, poolAddress, poolNamespace, poolId, tokenIn, tokenInId, tokenOut, tokenOutId,...extra};
}

/** Offline artifact integrity only. No Ready/admission, Family lookup or RPC. */
export async function loadSqlPriceEdges(manifestPath: string): Promise<{
  edges: SqlPriceEdge[];
  manifest: {edgeSha256: string; cutoffHash: string; fromBlock: number; toBlock: number; rows: number};
}> {
  const m = record(JSON.parse(await readFile(manifestPath, "utf8")));
  if (m.format !== "ready-fixed-edges/v1" || !isHash(m.edgeSha256) || typeof m.edgeFile !== "string" || !m.edgeFile ||
    typeof m.cutoffHash !== "string" || !/^0x[0-9a-f]{64}$/.test(m.cutoffHash) ||
    typeof m.fromBlock !== "number" || !Number.isSafeInteger(m.fromBlock) || m.fromBlock < 0 ||
    typeof m.toBlock !== "number" || !Number.isSafeInteger(m.toBlock) || m.toBlock < m.fromBlock ||
    typeof m.rows !== "number" || !Number.isSafeInteger(m.rows) || m.rows <= 0 || m.rows > maxRows)
    throw Error("invalid SQL price edge manifest");
  const fd = await open(resolve(dirname(manifestPath), m.edgeFile), "r");
  let bytes: Buffer;
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw Error("SQL price edge artifact exceeds file limit");
    bytes = await fd.readFile();
  } finally { await fd.close(); }
  if (bytes.length > maxBytes || sha256(bytes) !== m.edgeSha256) throw Error("SQL price edge artifact SHA-256 mismatch");
  // Parse directly from the buffer, so the large real input doesn't need a
  // second whole-file decoded string or an array containing every raw line.
  const data = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, {maxOutputLength: maxBytes}) : bytes;
  const edges: SqlPriceEdge[] = [], seen = new Set<string>();
  for (let start = 0; start < data.length;) {
    const nl = data.indexOf(10, start), end = nl < 0 ? data.length : nl;
    if (edges.length >= m.rows) throw Error("SQL price edge row count mismatch");
    const edge = parseEdge(JSON.parse(data.toString("utf8", start, end)));
    if (seen.has(edge.candidateInstanceKey)) throw Error("duplicate SQL candidate instance key");
    seen.add(edge.candidateInstanceKey); edges.push(edge); start = end + 1;
  }
  if (edges.length !== m.rows) throw Error("SQL price edge row count mismatch");
  return {edges, manifest: {edgeSha256: m.edgeSha256, cutoffHash: m.cutoffHash, fromBlock:m.fromBlock, toBlock: m.toBlock, rows: m.rows}};
}

/** Pool invalidation scope only. A manager address is NOT a wildcard for all
 * logical pools, and a pool touching ETH never causes every ETH leg to reprice. */
export class SqlEdgePoolIndex {
  readonly #pools = new Map<string, Set<string | null>>();
  readonly #refresh: PoolLegRefreshIndex;
  readonly #logicalIds = new Map<string, Set<string>>();
  readonly count: number;
  readonly qualifiedPoolCount: number;
  constructor(edges: readonly SqlPriceEdge[]) {
    const seen = new Set<string>();
    let qualified = 0;
    for (const e of edges) {
      if (e.chainId !== 1 || !isAddress(e.poolAddress) || e.poolAddress === zeroAddress || !isId(e.poolId) ||
        !isId(e.poolNamespace) || (e.poolId === null && e.poolNamespace !== null)) throw Error("invalid indexed SQL pool scope");
      if (seen.has(e.candidateInstanceKey)) throw Error("duplicate indexed SQL leg");
      seen.add(e.candidateInstanceKey);
      const key = JSON.stringify([e.poolAddress, e.poolId]);
      let group = this.#pools.get(key);
      if (!group) {
        group = new Set(); this.#pools.set(key, group);
        if (e.poolId !== null) {
          let ids = this.#logicalIds.get(e.poolAddress);
          if (!ids) { ids = new Set(); this.#logicalIds.set(e.poolAddress, ids); }
          ids.add(e.poolId);
        }
      }
      if (!group.has(e.poolNamespace)) { group.add(e.poolNamespace); qualified++; }
    }
    this.#refresh = new PoolLegRefreshIndex(edges.map(e=>({poolAddress:e.poolAddress,poolId:e.poolId,poolNamespace:e.poolNamespace,
      legId:e.candidateInstanceKey,stateKey:e.candidateInstanceKey})));
    this.count = seen.size; this.qualifiedPoolCount = qualified;
  }
  get poolCount(): number { return this.#pools.size; }

  /** The canonical activity reader supplies touched accounts (including pool
   * balance endpoints); only known physical pool addresses become direct touches.
   * A caller may additionally supply evidence-scoped logical touches. A single
   * recognized poolId never proves it was the *only* affected ID in a manager.
   * Complete managers must be independently covered for the entire block. */
  poolTouchesForActivity(touchedAddresses: ReadonlySet<string>, logicalTouches: Iterable<SqlPriceLogicalTouch>,
    completeManagers: ReadonlySet<string> = new Set()): {touches: readonly SqlPricePoolTouch[]; unresolvedManagers: readonly string[]} {
    const touches: SqlPricePoolTouch[] = [], unresolved = new Set<string>(), seen = new Set<string>();
    const normalized = (s: string) => {
      if (typeof s !== "string" || !/^0x[0-9a-f]{40}$/i.test(s)) throw Error("invalid SQL activity address");
      return s.toLowerCase();
    };
    const complete = new Set(Array.from(completeManagers,normalized));
    for (const account of touchedAddresses) {
      const poolAddress = normalized(account), key = JSON.stringify([poolAddress, null]);
      if (this.#pools.has(key) && !seen.has(key)) { touches.push({poolAddress}); seen.add(key); }
      if (this.#logicalIds.has(poolAddress) && !complete.has(poolAddress)) unresolved.add(poolAddress);
    }
    for (const t of logicalTouches) {
      if (!t || typeof t.poolId !== "string" || !isId(t.poolId) || (t.poolNamespace !== undefined && !isId(t.poolNamespace)))
        throw Error("invalid qualified SQL activity pool");
      const poolAddress = normalized(t.poolAddress), group = this.#pools.get(JSON.stringify([poolAddress, t.poolId]));
      if (!group || (t.poolNamespace !== undefined && !group.has(t.poolNamespace))) continue;
      const key = JSON.stringify([poolAddress,t.poolId,t.poolNamespace === undefined ? [] : t.poolNamespace]);
      if (!seen.has(key)) { touches.push({...t,poolAddress}); seen.add(key); }
    }
    return {touches,unresolvedManagers:[...unresolved]};
  }

  /** Conservative refresh when no complete per-pool activity is proven. Only
   * that manager's indexed logical IDs are returned; no global address/ID scan. */
  logicalTouchesForManagers(managers: Iterable<string>): readonly SqlPriceLogicalTouch[] {
    const touches: SqlPriceLogicalTouch[] = [], seen = new Set<string>();
    for (const raw of managers) {
      if (typeof raw !== "string" || !/^0x[0-9a-f]{40}$/i.test(raw)) throw Error("invalid SQL manager address");
      const poolAddress = raw.toLowerCase(); if (seen.has(poolAddress)) continue; seen.add(poolAddress);
      for (const poolId of this.#logicalIds.get(poolAddress) ?? []) touches.push({poolAddress,poolId});
    }
    return touches;
  }

  /** A known namespace (including explicit null) is exact. An unspecified
   * namespace on a logical ID invalidates all namespace representations of
   * just that (manager,id). It does not assert that they are interchangeable
   * for quoting or collapse their original SQL keys. */
  legsForTouched(pools: Iterable<SqlPricePoolTouch>): {legIds: readonly string[]; count: number} {
    const out = new Set<string>();
    for (const p of pools) {
      if (!p || typeof p.poolAddress !== "string") throw Error("invalid touched SQL pool");
      const address = p.poolAddress.toLowerCase(), id = p.poolId ?? null, ns = p.poolNamespace;
      if (!isAddress(address) || address === zeroAddress || !isId(id) || (ns !== undefined && !isId(ns)) ||
        (id === null && ns != null)) throw Error("invalid touched SQL pool scope");
      for(const leg of this.#refresh.forPool(address,id,ns).legIds)out.add(leg);
    }
    return {legIds: [...out], count: out.size};
  }
}
