// Labels the observed four bytes after discovery. A public signature can
// collide; retain every matching signature and never use one to admit an edge.
import {readFileSync,writeFileSync,globSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {id} from '../listener/node_modules/ethers/lib.esm/index.js';

const {values:v}=parseArgs({options:{edges:{type:'string'},out:{type:'string'},openchain:{type:'boolean'}}});
const root=fileURLToPath(new URL('../listener/src/searcher/venues/selector-native/',import.meta.url));
const local=new Map();
for (const path of globSync(root+'/*/*.json')) {
  const d=JSON.parse(readFileSync(path));
  if (d.selector && d.signature) local.set(d.selector,d.signature);
}
const rows=new Map();
for(const edge of JSON.parse(readFileSync(v.edges))){
  const selector=edge.selector;
  if (!rows.has(selector)) rows.set(selector,{selector,edges:0,local:local.get(selector)??null});
  rows.get(selector).edges++;
}
if(v.openchain){
  const unknown=[...rows.values()].filter(r=>!r.local);
  for(let i=0;i<unknown.length;i+=25){
    const batch=unknown.slice(i,i+25);
    const url=new URL('https://api.4byte.sourcify.dev/signature-database/v1/lookup');
    url.searchParams.set('function',batch.map(r=>r.selector).join(','));
    try {
      const reply=await fetch(url,{signal:AbortSignal.timeout(12000)});
      if(!reply.ok) throw Error('HTTP '+reply.status);
      const result=await reply.json();
      if(!result.ok || !result.result?.function) throw Error('Malformed signature lookup');
      for(const r of batch){
        const names=(result.result.function[r.selector]??[]).map(x=>x.name);
        r.signatures=[...new Set(names.filter(s=>typeof s==='string' && id(s).slice(0,10)===r.selector))].sort();
        r.lookup=r.signatures.length?'matched-hash':'unresolved';
      }
    } catch {
      for(const r of batch) r.lookup='unavailable';
    }
  }
}
writeFileSync(v.out,JSON.stringify([...rows.values()].sort((a,b)=>b.edges-a.edges||a.selector.localeCompare(b.selector)),null,2)+'\n',{flag:'wx'});
