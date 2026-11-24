import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {receiptComponents,matchingPaymentStream} from './payment-stream.mjs';
import {receiptCallOwners,possibleReceiptOwners} from './receipt-call-owners.mjs';
import {traceCallFlows} from './trace-call-flows.mjs';
const a=i=>'0x'+i.toString(16).padStart(40,'0'),w=i=>BigInt(i).toString(16).padStart(64,'0');
const T='0x'+'a'.repeat(64),dst=a(21),src=a(20),root={valid:true,kind:'call',target:src};
// BigQuery supplies calldata/topics as input strings, not long chains of JS
// padStart/concatenation intermediates. Materialize each row independently;
// do not intern duplicate keys, shrink payloads, or change input cardinality.
const flat=s=>Buffer.from(s,'ascii').toString('ascii');
function framesAndLogs(size,duplicate,raw=false){
  const frames=[raw?{path:'',kind:'call',sender:a(14),target:src,input:'0x',output:null,value:'0',ok:true}:root],
    logs=[],token=a(1),unrelated=a(2);
  for(let i=0;i<size+2;i++){
    const issuer=i<size?token:unrelated,amount=i<size&&duplicate?1:i+1;
    const input=flat('0xa9059cbb'+w(dst)+w(amount));
    frames.push(raw?{path:String(i),kind:'call',sender:src,target:issuer,input,output:'0x',value:'0',ok:true}:
      {valid:true,kind:'call',parent:root,target:issuer,sender:src,input,output:'0x'});
    logs.push({idx:i,emitter:issuer,topics:[T,flat('0x'+w(src)),flat('0x'+w(dst))],data:flat('0x'+w(amount))});
  }
  return {frames,logs};
}
function stress(size,duplicate){
  const {frames,logs}=framesAndLogs(size,duplicate),t0=performance.now(),t=receiptCallOwners(frames,logs,new Set([T]));
  const first=possibleReceiptOwners(t.placements.get(logs[0]));
  assert.equal(first.size,size);assert.equal(first.has(frames[size]),true);
  const hints=matchingPaymentStream(t,T);assert.equal(hints.size,duplicate?2:size+2);
  for(let i=size;i<size+2;i++)assert.equal(hints.get(logs[i]),frames[i+1]);
  const pinned=t.constrain(hints);assert(pinned);
  for(const [e,n] of hints){const ps=possibleReceiptOwners(pinned.placements.get(e));assert.equal(ps.size,1);assert(ps.has(n));}
  return {size,duplicate,possiblePairs:size*size,hints:hints.size,ms:Math.round(performance.now()-t0),heapUsed:process.memoryUsage().heapUsed};
}
function fullStress(size){
  const {frames:f,logs}=framesAndLogs(size,true,true),v=a(11),actor=a(12),asset=a(13),sel='0x12345678';
  f.length=size+1;
  const c=(path,sender,target,input)=>({path,sender,target,input,output:'0x',value:'0',kind:'call',ok:true});
  f.push(c(String(size),src,v,sel),c(size+',0',v,asset,'0x23b872dd'+w(src)+w(v)+w(4)));
  // Bulk transfers must not involve the separate converter's user.
  f[size+1].sender=actor;f[size+2].input='0x23b872dd'+w(actor)+w(v)+w(4);
  const l=(idx,emitter,from,to,amount)=>({idx,emitter,topics:[T,'0x'+w(from),'0x'+w(to)],data:'0x'+w(amount)});
  logs.splice(size,2,l(size,asset,actor,v,4),l(size+1,v,a(0),actor,9));
  const out=traceCallFlows(f,logs,{native:a(0),transferTopic:T});
  assert.deepEqual(out.filter(e=>e.selector===sel).map(e=>[e.tokenIn,e.tokenOut,e.amountReceivedOutRaw]),[[asset,v,'9']]);
  return {size,fullUdf:true,observations:out.length};
}
const cases={duplicate:()=>stress(12000,true),distinct:()=>stress(12000,false),full:()=>fullStress(12000)};
function measure(){return Object.keys(cases).map(name=>{
  try{return JSON.parse(execFileSync(process.execPath,['--max-old-space-size=64',fileURLToPath(import.meta.url),'--measure',name],{encoding:'utf8',timeout:30000}));}
  catch(err){throw new Error('64 MiB / 12,000 case failed: '+name,{cause:err});}
});}
if(process.argv[2]==='--measure'){
  console.log(JSON.stringify(process.argv[3]?cases[process.argv[3]]():measure()));
}else{
  test('12k same-emitter receipts x 12k slots stay within 64 MiB V8 heap; equal payments stay unresolved but unrelated action is pinned',()=>{
    const [dup,distinct,full]=measure();assert.deepEqual([dup.hints,distinct.hints,full.observations],[2,12002,1]);
  });
  test('range component membership agrees with an independent exact bipartite oracle, including resumed owners and explicit pins',()=>{
    let state=18764;const rand=n=>((state=(Math.imul(1664525,state)+1013904223)>>>0)%n);
    for(let round=0;round<300;round++){
      const owners=Array.from({length:10},(_,i)=>({i})),slots=Array.from({length:20},()=>({owner:owners[rand(10)]}));
      const items=Array.from({length:1+rand(14)},(_,e)=>{const first=rand(slots.length),last=first+rand(slots.length-first);
        const only=rand(4)===0?slots[first+rand(last-first+1)].owner:null;
        return {e,owners:possibleReceiptOwners({slots,first,last,only})};
      });
      const incidence=items.map(({owners:ps})=>{
        const p=ps.range,os=p.only?[p.only]:[...new Set(slots.slice(p.first,p.last+1).map(x=>x.owner))];
        assert.deepEqual([...ps],os);assert.equal(ps.size,os.length);for(const n of owners)assert.equal(ps.has(n),os.includes(n));
        return os;
      });
      const todo=new Set(items.map(x=>x.e)),want=[];
      while(todo.size){const e=todo.values().next().value,q=[e],group=new Set([e]);todo.delete(e);
        for(let i=0;i<q.length;i++)for(const other of todo)if(incidence[q[i]].some(n=>incidence[other].includes(n))){
          q.push(other);group.add(other);todo.delete(other);
        }
        want.push([...group].sort((a,b)=>a-b).join(','));
      }
      const got=[...receiptComponents(items)].map(g=>g.items.map(x=>x.e).sort((a,b)=>a-b).join(','));
      assert.deepEqual(got.sort(),want.sort());
    }
  });
}
