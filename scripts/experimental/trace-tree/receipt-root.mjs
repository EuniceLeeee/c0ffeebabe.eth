// Offline post-Byzantium receipt commitment verifier. No discovery rules,
// trace-derived LOG ownership, or reference edge set are used as input.
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const {encodeRlp,keccak256}=createRequire(new URL('../../../listener/package.json',import.meta.url))('ethers');
const chk=(x,s)=>{if(!x)throw Error(s);};
const sha256=b=>createHash('sha256').update(b).digest('hex');
function hex(x,len){
  chk(typeof x==='string'&&/^0x(?:[0-9a-f]{2})*$/i.test(x)&&(len==null||x.length===2+2*len),'invalid hex/length');
  return x.toLowerCase();
}
function uint(x){
  chk((typeof x==='string'&&/^(0|[1-9][0-9]*|0x[0-9a-f]+)$/i.test(x))||(typeof x==='number'&&Number.isSafeInteger(x)&&x>=0),'invalid integer');
  return BigInt(x);
}
function idx(x){const n=uint(x);chk(n<=BigInt(Number.MAX_SAFE_INTEGER),'invalid index');return Number(n);}
const q=n=>{if(n===0n)return '0x';const s=n.toString(16);return '0x'+(s.length%2?'0':'')+s;};
const bytes=b=>Buffer.from(b.slice(2),'hex');
const asHex=b=>'0x'+b.toString('hex');
export function computeLogBloom(raw){
  const bits=Buffer.alloc(256);
  for(const [address,topics] of raw){
    for(const atom of [hex(address,20),...topics.map(t=>hex(t,32))]){
      const h=bytes(keccak256(atom));
      for(let i=0;i<6;i+=2){const b=((h[i]<<8)|h[i+1])&2047;bits[255-(b>>3)]|=(1<<(b&7));}
    }
  }
  return bits;
}
const nib=s=>[...s.slice(2)].map(c=>parseInt(c,16));
function compact(path,leaf) {
  const flag=(leaf?2:0)+(path.length%2), packed=path.length%2?[flag,...path]:[flag,0,...path];
  return '0x'+packed.map(n=>n.toString(16)).join('');
}
// Ethereum non-secure indexed MPT: trie key = RLP(minimal unsigned tx index);
// child references are embedded RLP lists below 32 bytes, hashes otherwise.
export function indexedTrieRoot(values){
  if(!values.length)return keccak256(encodeRlp('0x'));
  const pairs=values.map((v,i)=>({k:nib(encodeRlp(q(BigInt(i)))),v:hex(v)}));
  const ref=n=>{const enc=encodeRlp(n);return enc.length<66?n:keccak256(enc);};
  function build(entries,at){
    if(entries.length===1)return [compact(entries[0].k.slice(at),true),entries[0].v];
    const first=entries[0].k;
    let end=at;while(first[end]!=null&&entries.every(e=>e.k[end]===first[end]))end++;
    if(end>at)return [compact(first.slice(at,end),false),ref(build(entries,end))];
    const n=new Array(17).fill('0x'),children=new Map();
    for(const e of entries){if(e.k.length===at){n[16]=e.v;continue;}
      const next=e.k[at];if(!children.has(next))children.set(next,[]);children.get(next).push(e);}
    for(const [i,es] of children)n[i]=ref(build(es,at+1));return n;
  }
  return keccak256(encodeRlp(build(pairs,0)));
}
export function verifyReceiptRoot(rows) {
  const groups=Map.groupBy(rows,row=>row.row_kind),decode=k=>(groups.get(k)??[]).map(r=>typeof r.raw_json==='string'?JSON.parse(r.raw_json):r.raw_json);
  const heads=decode('header');chk(heads.length===1,'expected one header');
  const h=heads[0],block=idx(h.number),hash=hex(h.hash,32);
  const txs=decode('transaction').sort((a,b)=>idx(a.transaction_index)-idx(b.transaction_index));
  chk(txs.length===idx(h.transaction_count),'wrong transaction count');
  const seen=new Set();
  function bound(x){chk(idx(x.block_number)===block&&hex(x.block_hash,32)===hash,'row belongs to a different block');}
  const perTx=txs.map((t,i)=>{bound(t);chk(idx(t.transaction_index)===i,'missing/duplicate transaction index');const txHash=hex(t.hash,32);
    chk(!seen.has(txHash),'duplicate transaction hash');seen.add(txHash);return [];});
  const logs=decode('receipt_log').sort((a,b)=>idx(a.log_index)-idx(b.log_index));let prev=-1;
  for(const [j,l] of logs.entries()){
    bound(l);const i=idx(l.transaction_index);
    chk(idx(l.log_index)===j,'missing/duplicate global log index');
    chk(i>=prev&&i<txs.length&&hex(l.transaction_hash,32)===hex(txs[i].hash,32),'log belongs to wrong transaction or out of order');prev=i;
    chk(Array.isArray(l.topics)&&l.topics.length<=4,'invalid topics');
    perTx[i].push([hex(l.address,20),l.topics.map(t=>hex(t,32)),hex(l.data)]);
  }
  let cumulative=0n;const logBloom=Buffer.alloc(256),types={},statusCounts={};
  const encoded=txs.map((t,i)=>{
    const used=uint(t.receipt_gas_used),cum=uint(t.receipt_cumulative_gas_used);
    chk(cum===cumulative+used,'cumulative gas does not equal sum of receipts');cumulative=cum;
    const status=idx(t.receipt_status),type=idx(t.transaction_type);
    chk((status===0||status===1)&&type<=127,'unsupported status or envelope type');
    chk(t.receipt_root==null,'pre-Byzantium receipt root unsupported');chk(status!==0||perTx[i].length===0,'reverted receipt contains logs');
    types[type]=(types[type]??0)+1;statusCounts[status]=(statusCounts[status]??0)+1;
    const b=computeLogBloom(perTx[i]);for(let j=0;j<256;j++)logBloom[j]|=b[j];
    const r=encodeRlp([q(BigInt(status)),q(cum),asHex(b),perTx[i]]);
    return type===0?r:'0x'+type.toString(16).padStart(2,'0')+r.slice(2);
  });
  chk(cumulative===uint(h.gas_used),'header gas_used differs from receipt total');
  const computedRoot=indexedTrieRoot(encoded),headerRoot=hex(h.receipts_root,32),computedBloom=asHex(logBloom),headerBloom=hex(h.logs_bloom,256);
  const result={block,blockHash:hash,transactions:txs.length,receiptLogs:logs.length,byType:types,byStatus:statusCounts,cumulativeGasUsed:String(cumulative),
    receiptsRoot:{header:headerRoot,computed:computedRoot,match:computedRoot===headerRoot},logsBloom:{header:headerBloom,computed:computedBloom,match:computedBloom===headerBloom,
    setBits:[...logBloom].reduce((n,x)=>n+x.toString(2).replaceAll('0','').length,0)},scope:'Matches receipt bodies and log order/content, envelope type, transaction position and cumulative gas against the supplied header. Does not attest public-chain header canonicality, receipt tx hashes independently of the transaction table, trace facts or economic actions.'};
  result.valid=result.receiptsRoot.match&&result.logsBloom.match;return result;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const [, ,source,out]=process.argv;if(!source)throw Error('usage: receipt-root.mjs raw-block.ndjson.gz [report.json]');
  const file=readFileSync(source),raw=gunzipSync(file),rows=raw.toString().trim().split('\n').map(JSON.parse);
  const result=verifyReceiptRoot(rows);result.inputGzipSha256=sha256(file);result.inputNdjsonSha256=sha256(raw);result.verifierSha256=sha256(readFileSync(new URL(import.meta.url)));
  const s=JSON.stringify(result,null,2)+'\n';if(out)writeFileSync(out,s);else process.stdout.write(s);
  if(!result.valid)process.exitCode=1;
}
