// Standalone diagnostic: reads transaction rows and an explicit selector registry, never a target graph.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildTree} from './trace-tree.mjs';
import {corroborate} from './corroborate.mjs';
import {extractEdges} from './action-edges.mjs';
import {extractPairActions} from './pair-actions.mjs';
import {extractPoolActions,observeKeyedActions} from './keyed-actions.mjs';
const coord=e=>[e.selector,e.poolAddress,e.poolId??'',e.tokenIn,e.tokenOut];
const A=/^0x[0-9a-f]{40}$/,S=/^0x[0-9a-f]{8}$/;
const add=(m,k)=>m.set(k,(m.get(k)??0)+1);
export function reconcile(tree,enabled,results) {
  const paths=new Map(tree.nodes.map(n=>[n.path,n])), receiptIndexes=new Set(tree.logs.map(l=>l.idx)), rows=results.flatMap(x=>x.edges);
  const claims=new Map(),reported=new Map(),out=[],unresolved=[];
  const claimIds=r=>[...(r.evidenceLogIndices??[]).map(i=>'event:'+i),...(r.evidenceCallPaths??[]).map(p=>'payment:'+p)];
  for (const r of rows) {
    const f=paths.get(r.path);
    assert(f&&f.committed&&!f.staticContext&&f.kind==='call'&&f.input?.slice(0,10)===r.selector&&enabled.has(r.selector),'edge selector not proven by committed entry');
    assert([r.poolAddress,r.tokenIn,r.tokenOut].every(v=>A.test(v))&&r.tokenIn!==r.tokenOut&&(!r.poolId||/^0x[0-9a-f]{64}$/.test(r.poolId)),'bad coordinates');
    assert(BigInt(r.amountInRaw)>0n&&BigInt(r.amountOutRaw)>0n,'unproven amount');
    assert((r.evidenceLogIndices??[]).every(i=>receiptIndexes.has(i))&&(r.evidenceCallPaths??[]).every(p=>paths.get(p)?.committed),'unbound evidence reference');
    assert(claimIds(r).length>0,'missing receipts');
    for(const v of new Set(claimIds(r)))add(claims,v);
  }
  for(const r of rows){
    if(claimIds(r).some(k=>claims.get(k)>1))unresolved.push({path:r.path,selector:r.selector,reason:'competing-actions-claim-same-settlement'});
    else out.push({...r,txHash:tree.txHash,edgeKey:coord(r)});
  }
  const produced=new Set(out.map(e=>e.path+'|'+e.selector));
  for(const r of [...unresolved,...results.flatMap(x=>x.unresolved)]){
    const id=r.path+'|'+r.selector;
    if(!produced.has(id)) { const q=reported.get(id)??[];q.push(r);reported.set(id,q); }
  }
  const gaps=[];
  for(const n of tree.nodes){
    const s=n.input?.slice(0,10);if(n.kind!=='call'||!n.committed||n.staticContext||!enabled.has(s))continue;
    const id=n.path+'|'+s;if(produced.has(id))continue;
    let v=reported.get(id)??[];
    const explanatory=v.filter(r=>!/(unknown|unsupported|unmodel|not-declared|no-declara|no-action-declara)/i.test(r.reason));
    if(explanatory.length)v=explanatory;
    gaps.push({path:n.path,target:n.to,selector:s,reasons:[...new Set(v.length?v.map(r=>r.reason):['no-proven-conversion-rule'])],details:v});
  }
  return {txHash:tree.txHash,ownershipSource:tree.ownershipSource,edgeDirections:[...new Map(out.map(e=>[JSON.stringify(e.edgeKey),e.edgeKey])).values()],observations:out,unresolved:gaps};
}
export function discover(tx,selectors,witness=null){
  assert(selectors&&typeof selectors!=='string'&&typeof selectors[Symbol.iterator]==='function','provide enabled execution selectors');
  const enabled=new Set(selectors);assert(enabled.size&&[...enabled].every(x=>S.test(x)),'invalid enabled selector registry');
  const tree=witness?corroborate(tx,witness):buildTree(tx), opts={enabledSelectors:enabled}, assets=extractEdges(tree,opts);const report=reconcile(tree,enabled,[assets,extractPairActions(tree,opts),extractPoolActions(tree,opts)]);
  const inventory=new Map(),ownership=new Map();
  for(const n of tree.nodes){const s=n.input?.slice(0,10);if(n.committed&&n.kind==='call'&&!n.staticContext&&S.test(s))add(inventory,s);}
  for(const l of tree.logs)add(ownership,l.ownership);
  return {...report,observedAssetActions:assets.observedActions??[],observedKeyedActions:observeKeyedActions(tree,opts),alignment:tree.alignment,logOwnerCounts:Object.fromEntries(ownership),committedSelectorCounts:Object.fromEntries(inventory)};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  if(process.argv.includes('--help')){console.log('Offline experimental extractor.\nnode discover.mjs TX.ndjson SELECTORS.json [ONE_BOUND_WITNESS.json]\nTX.ndjson: one canonical BigQuery trace row per line (transaction-traces.sql), or a {trace,receipt} witness pair. Selectors: explicit JSON array of permitted execution selectors or a manifest with admittedSelectors. A witness is optional and must match the precise SQL transaction+block+receipt. Prints transaction-scoped observations, deduped edge coordinates and unresolved calls. No network, database writes, Ready publication or broadcast.');process.exit(0);}
  const [rowFile,registryFile,witnessFile]=process.argv.slice(2);if(!rowFile||!registryFile)throw Error('Usage: node discover.mjs TX.ndjson SELECTORS.json [ONE_BOUND_WITNESS.json]');
  const config=JSON.parse(readFileSync(registryFile,'utf8')), enabled=Array.isArray(config)?config:config.admittedSelectors;
  const {createReadStream}=await import('node:fs'),{createInterface}=await import('node:readline');
  const witness=witnessFile?JSON.parse(readFileSync(witnessFile,'utf8')):null;
  for await(const line of createInterface({input:createReadStream(rowFile),crlfDelay:Infinity}))if(line.trim())console.log(JSON.stringify(discover(JSON.parse(line),enabled,witness)));
}
