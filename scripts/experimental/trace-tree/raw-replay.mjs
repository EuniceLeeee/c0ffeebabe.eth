// From the WHOLE raw SQL export to local evidence. No reference graph, native witness or RPC input.
import fs from 'node:fs';import {gunzipSync} from 'node:zlib';import {pathToFileURL} from 'node:url';import path from 'node:path';
import {createHash} from 'node:crypto';import assert from 'node:assert/strict';
import {verifyRawBlock} from './raw-input.mjs';import {verifyReceiptRoot} from './receipt-root.mjs';import {discover} from './discover.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
function rows(p){const b=fs.readFileSync(p),raw=b[0]===31&&b[1]===139?gunzipSync(b):b;return{rows:raw.toString('utf8').trimEnd().split('\n').map(JSON.parse),sha:sha(raw)};}
export function replayBlock(raw,control,registry,pin){
 const verified=verifyRawBlock(raw,{...pin,control}),root=verifyReceiptRoot(raw);assert(root.valid,'receiptsRoot or bloom disagrees with block header');
 const enabled=new Set(registry),entries=verified.rows.map(tx=>discover(tx,enabled)),settled=new Set(),scanned=new Map(),acts=new Set();
 const key=e=>JSON.stringify([e.selector,e.poolAddress,e.poolId??'',e.tokenIn,e.tokenOut]);
 for(const tx of entries){
   for(const e of tx.observations)settled.add(key(e));
   for(const e of [...tx.observedKeyedActions,...tx.observedAssetActions]){if(e.selector&&e.poolAddress&&e.tokenIn&&e.tokenOut)acts.add(key(e));}
   for(const [s,c] of Object.entries(tx.committedSelectorCounts)){
     const item=scanned.get(s)??{selector:s,enabledForExecution:enabled.has(s),transactions:0,calls:0};item.calls+=c;item.transactions++;scanned.set(s,item);
   }
 }
 return {summary:{...verified.summary,receiptCommitmentVerified:true,enabledSelectorCount:enabled.size,actualCommittedSelectors:[...scanned.values()].sort((a,b)=>a.selector.localeCompare(b.selector)),settledDirections:settled.size,observedButNotSettledDirections:[...acts].filter(k=>!settled.has(k)).length},transactions:entries};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const [raw,counts,selectors,block,hash,out]=process.argv.slice(2);
 if(!out||process.argv.includes('--help')){console.log('Offline one-block replay: node raw-replay.mjs raw-export.ndjson.gz control.ndjson.gz enabled.json HEIGHT HASH OUTPUT-NEW.json. Export raw-block.sql and raw-block-counts.sql with @day (UTC) and @block. No filtered inputs, injected MJS, RPC, signing or live.');process.exit(out?0:process.argv.includes('--help')?0:2);}
 const b=rows(raw),c=rows(counts),s=JSON.parse(fs.readFileSync(selectors,'utf8'));assert(c.rows.length===1);
 const result=replayBlock(b.rows,c.rows[0],Array.isArray(s)?s:s.admittedSelectors,{height:Number(block),hash});
 result.summary.rawInputSha256=b.sha;result.summary.controlInputSha256=c.sha;result.summary.enabledSelectorSetSha256=sha(JSON.stringify([...new Set(Array.isArray(s)?s:s.admittedSelectors)].sort()));fs.writeFileSync(out,JSON.stringify(result)+'\n',{flag:'wx'});console.log(JSON.stringify({...result.summary,actualCommittedSelectors:result.summary.actualCommittedSelectors.length}));
}
