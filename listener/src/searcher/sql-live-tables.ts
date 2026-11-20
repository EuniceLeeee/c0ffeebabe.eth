import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { FunctionFragment } from "ethers";
import { loadSqlPriceEdges } from "./sql-edge-price-index.js";
import { GENERATED_PRODUCTION_FAMILY_ENTRIES } from "./generated/production-family-entries.generated.js";
import { fundingBindingsFromCall, selectorFundingInstanceKey, selectorNativeFundingFamilyId } from "./venues/selector-native-funding-definition.js";
import { selectorAssetOfferKey } from "./venues/selector-execution-keys.js";
import type { StrictReadyFundingAsset } from "./strict-production-runtime-session.js";

const sha=(v:Buffer)=>createHash("sha256").update(v).digest("hex");
const digest=(s:unknown):s is string=>typeof s==="string"&&/^[a-f0-9]{64}$/.test(s);
const word=(s:unknown):s is string=>typeof s==="string"&&/^0x[a-f0-9]{64}$/.test(s);
const tracePath=(s:unknown):s is string=>typeof s==="string"&&(s===""||/^(?:0|[1-9]\d*)(?:,(?:0|[1-9]\d*))*$/.test(s));
async function document(path:string, expected:unknown){
  assert(digest(expected),"missing SQL artifact digest");
  const bytes=await readFile(path);assert.equal(sha(bytes),expected,"SQL artifact content differs: "+path);
  return JSON.parse(bytes.toString("utf8"));
}
export function readSqlFundingRows(doc:Record<string,any>,window:{fromBlock:number;toBlock:number;cutoffHash:string}){
  assert(doc.format==="sql-live-funding/v1"&&doc.chainId===1&&Array.isArray(doc.rows)&&Array.isArray(doc.failures),"invalid SQL funding table");
  assert(doc.window?.fromBlock===window.fromBlock&&doc.window?.toBlock===window.toBlock&&doc.window?.headHash===window.cutoffHash,
    "SQL funding and swap windows differ");
  const coverage=doc.sourceCoverage??doc.provenance?.trace?.coverage;
  assert(coverage&&/^[1-9]\d*$/.test(coverage.transactions)&&coverage.transactions===coverage.distinctTx&&
    Number(coverage.firstBlock)===window.fromBlock&&Number(coverage.lastBlock)===window.toBlock&&coverage.head===window.cutoffHash&&
    Number(coverage.activeHashes)===window.toBlock-window.fromBlock+1&&coverage.missingTraces==="0",
    "SQL funding trace coverage incomplete");
  // Dispositions never nominate a provider/asset pair. Reject a mixed table
  // rather than allowing an accidentally promoted failure to reach Solver.
  for(const failure of doc.failures)assert(failure&&typeof failure.failure==="string"&&failure.failure.length>0&&
    !Object.hasOwn(failure,"offerKey")&&!Object.hasOwn(failure,"asset")&&!Object.hasOwn(failure,"input"),"SQL funding failure carries an offer");
  const registry=new Map(GENERATED_PRODUCTION_FAMILY_ENTRIES.map(e=>e.module.selectorFamilyModule).map(m=>[m.definition.selector,m]));
  const seen=new Set<string>(),assets:StrictReadyFundingAsset[]=[];
  for(const r of doc.rows){
    assert(!Object.hasOwn(r,"failure"),"SQL funding failure mixed into offers");
    const m=registry.get(r.selector);
    assert(m&&m.definition.domain==="funding","unregistered SQL funding selector");
    const def=m.definition;
    assert(Number.isSafeInteger(r.block_number)&&r.block_number>=window.fromBlock&&r.block_number<=window.toBlock&&
      word(r.block_hash)&&word(r.tx_hash)&&Number.isSafeInteger(r.transaction_index)&&r.transaction_index>=0&&
      Number.isSafeInteger(r.observations)&&r.observations>=1&&tracePath(r.trace_address)&&tracePath(r.callback_path)&&
      r.callback_path!==r.trace_address&&(r.trace_address===""||r.callback_path.startsWith(r.trace_address+",")),
      "invalid SQL funding call witness");
    if(r.block_number===window.toBlock)assert.equal(r.block_hash,window.cutoffHash);
    assert(typeof r.input==="string"&&r.input.slice(0,10)===r.selector&&r.callback===FunctionFragment.from(def.execution.callback.signature).selector,"funding ABI changed");
    const binding=fundingBindingsFromCall(def,1,{target:r.provider,calldata:r.input}).find(b=>b.asset===r.asset);
    assert(binding&&binding.provider===r.provider,"funding call does not bind this provider and asset");
    const id=selectorAssetOfferKey(selectorFundingInstanceKey(binding),{address:binding.asset});
    assert.equal(id,r.offerKey,"funding identity differs from SQL");
    assert(!seen.has(id),"duplicate SQL funding source");seen.add(id);
    if(m.activation.enabled)assets.push(Object.freeze({familyId:selectorNativeFundingFamilyId(def),asset:binding.asset,binding}));
  }
  assert(assets.length,"no enabled funding source in SQL window");
  return Object.freeze(assets);
}

/** Discovery is not pricing. Only the raw SQL edge table and the matching
 * funding table may enter the live driver; a price checkpoint is not an input. */
export async function loadLiveSqlTables(path:string, expected:string){
  const p=resolve(path),dir=dirname(p),d=await document(p,expected);
  assert.equal(d.format,"sql-live-input/v2");assert.equal(d.chainId,1);
  const keys=(v:unknown,ks:string[])=>{assert(v&&typeof v==="object"&&!Array.isArray(v));assert.deepEqual(Object.keys(v).sort(),ks.sort(),"unexpected SQL input fields");};
  keys(d,["format","chainId","swaps","funding"]);
  keys(d.swaps,["manifest","manifestSha256","edgeSha256","fromBlock","toBlock","cutoffHash","rows"]);
  keys(d.funding,["path","sha256"]);
  const file=(s:unknown)=>{assert(typeof s==="string"&&s.length>0,"missing SQL artifact path");return resolve(dir,s);};
  const mp=file(d.swaps.manifest),m=await document(mp,d.swaps.manifestSha256);
  const {edges,manifest}=await loadSqlPriceEdges(mp);
  for(const k of ["edgeSha256","fromBlock","toBlock","cutoffHash","rows"] as const){
    assert.equal(m[k],d.swaps[k],"sealed swap manifest differs: "+k);assert.equal(manifest[k],m[k],"loaded swap manifest changed: "+k);
  }
  const fundingAssets=readSqlFundingRows(await document(file(d.funding.path),d.funding.sha256),manifest);
  return Object.freeze({manifest:Object.freeze(manifest),edges:Object.freeze(edges.map(e=>Object.freeze(e))),fundingAssets,fundingTableSha256:d.funding.sha256 as string});
}
