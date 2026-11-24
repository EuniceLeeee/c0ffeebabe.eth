// Decode the result of raw-block.sql. No selector registry or target edge is accepted here.
import assert from 'node:assert/strict';
import {buildTree} from './trace-tree.mjs';
const integer=x=>{if(typeof x==='number')assert(Number.isSafeInteger(x));return BigInt(x);};
const number=x=>{const b=integer(x),n=Number(b);assert(b>=0n&&Number.isSafeInteger(n));return n;};
const stringInt=x=>x==null?null:integer(x).toString();
const hex=(x,n)=>typeof x==='string'&&new RegExp('^0x[0-9a-fA-F]{'+n+'}$').test(x);
const bytes=x=>typeof x==='string'&&/^0x(?:[\da-f]{2})*$/i.test(x);
export function verifyRawBlock(exportRows,{height,hash,control}){
  assert(Number.isSafeInteger(height)&&hex(hash,64)&&control,'pin the block and supply independently exported source counts');
  const groups={header:[],transaction:[],trace:[],receipt_log:[]};
  for(const {row_kind,raw_json} of exportRows){
    assert(Object.hasOwn(groups,row_kind)&&typeof raw_json==='string');
    // Keep exact JSON integer lexemes even when a provider emits large numeric literals.
    const item=JSON.parse(raw_json,(k,v,ctx)=>typeof v==='number'&&!Number.isSafeInteger(v)?ctx.source:v);
    assert.equal(number(row_kind==='header'?item.number:item.block_number),height);
    assert.equal(row_kind==='header'?item.hash:item.block_hash,hash);groups[row_kind].push(item);
  }
  assert.equal(groups.header.length,1);const h=groups.header[0];
  const txs=groups.transaction.sort((a,b)=>number(a.transaction_index)-number(b.transaction_index));
  assert.equal(number(h.transaction_count),txs.length);assert.equal(control.header.hash,h.hash);
  assert.equal(number(control.header.transaction_count),txs.length);
  const lookup=new Map(), rows=txs.map((t,i)=>{
    assert.equal(number(t.transaction_index),i);assert(hex(t.hash,64)&&!lookup.has(t.hash)&&bytes(t.input));
    assert([0,1].includes(number(t.receipt_status)));lookup.set(t.hash,i);
    return {tx_hash:t.hash,block_hash:hash,block_number:height,transaction_index:i,receipt_status:t.receipt_status,expected:txs.length,from_address:t.from_address,to_address:t.to_address,input:t.input,traces:[],logs:[]};
  });
  let system=0;
  for(const f of groups.trace){
    if(f.transaction_hash===null){assert(f.transaction_index===null && f.trace_type==='reward','unexpected unowned trace');system++;continue;}
    const i=lookup.get(f.transaction_hash);assert(i!==undefined&&i===number(f.transaction_index),'orphan or wrong trace index');
    assert((f.input==null||bytes(f.input))&&(f.output==null||bytes(f.output)));rows[i].traces.push({...f,value:stringInt(f.value)});
  }
  const logs=groups.receipt_log.sort((a,b)=>number(a.log_index)-number(b.log_index));
  let prev=-1;
  for(const [index,l] of logs.entries()){
    assert.equal(number(l.log_index),index);const i=lookup.get(l.transaction_hash);assert(i!==undefined&&i===number(l.transaction_index)&&i>=prev);
    assert.equal(number(rows[i].receipt_status),1);assert(bytes(l.data)&&hex(l.address,40)&&Array.isArray(l.topics)&&l.topics.length<=4&&l.topics.every(t=>hex(t,64)));prev=i;
    rows[i].logs.push({log_index:index,log_address:l.address,topics:l.topics,data:l.data});
  }
  let roots=0,failedFrames=0,frameCount=0;
  for(const [i,r] of rows.entries()){
    const root=r.traces.filter(f=>(f.trace_address??'')==='');assert.equal(root.length,1);roots++;
    assert.equal(root[0].input,r.input);assert.equal(root[0].from_address,r.from_address);
    assert.equal(stringInt(root[0].value),stringInt(txs[i].value));
    assert.equal(number(root[0].status),number(r.receipt_status),'root/receipt status mismatch');
    if(r.to_address!==null){
      assert(root[0].trace_type==='call'&&root[0].call_type==='call','transaction recipient requires a root CALL');
      assert.equal(root[0].to_address,r.to_address);
      assert(txs[i].receipt_contract_address==null,'ordinary transaction has receipt contract address');
    }else{
      assert(root[0].trace_type==='create','transaction without recipient requires a creation root');
      if(number(r.receipt_status)===1){
        assert(hex(txs[i].receipt_contract_address,40),'missing created contract in receipt');
        assert.equal(root[0].to_address,txs[i].receipt_contract_address);
      }else if(txs[i].receipt_contract_address!=null){
        assert(hex(txs[i].receipt_contract_address,40));
        if(root[0].to_address!=null)assert.equal(root[0].to_address,txs[i].receipt_contract_address);
      }
    }
    const tree=buildTree(r);assert.equal(tree.nodes.length,r.traces.length);assert.equal(tree.logs.length,r.logs.length);
    failedFrames+=r.traces.filter(f=>number(f.status)===0).length;frameCount+=tree.nodes.length;
  }
  const failedTxs=txs.filter(t=>number(t.receipt_status)===0).length;
  for(const [x,y] of [[txs.length,control.txs.n],[lookup.size,control.txs.distinct_hashes],[failedTxs,control.txs.failed],[frameCount+system,control.frames.n],[system,control.frames.system_rows],[roots,control.frames.roots],[failedFrames,control.frames.failed],[logs.length,control.receipt_logs.n],[logs.length,control.receipt_logs.distinct_indices]])assert.equal(x,number(y));
  assert.equal(control.receipt_logs.first_idx==null?null:number(control.receipt_logs.first_idx),logs.length?0:null);
  assert.equal(control.receipt_logs.last_idx==null?null:number(control.receipt_logs.last_idx),logs.length?logs.length-1:null);
  return {rows,summary:{height,hash,rawRows:exportRows.length,header:1,transactions:txs.length,failedTransactions:failedTxs,traceFrames:frameCount,failedTraceFrames:failedFrames,systemTraces:system,roots,logs:logs.length,logIndexRange:logs.length?[0,logs.length-1]:null,distinctTransactionsWithLogs:rows.filter(r=>r.logs.length).length,completeDeclaredCallTrees:roots,receiptsRoot:h.receipts_root,independentCountsMatched:true}};
}
