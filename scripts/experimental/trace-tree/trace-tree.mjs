// Standalone evidence normalizer. Physical owner = executing frame. Logical owner
// = frame which established its storage/address context (DELEGATECALL/CALLCODE
// inherit that frame); neither necessarily represents an economic action.
const bad = s=>{throw new Error('trace-tree: '+s);};
const req=(v,s)=>{if(!v)bad(s);};
const h=(v,re,s)=>{req(typeof v==='string'&&re.test(v),s);return v.toLowerCase();};
const address=v=>h(v,/^0x[\da-f]{40}$/i,'invalid address');
const hash=v=>h(v,/^0x[\da-f]{64}$/i,'invalid hash/topic');
const bytes=v=>h(v,/^0x(?:[\da-f]{2})*$/i,'invalid bytes');
function integer(v){
  req((typeof v==='number'&&Number.isSafeInteger(v)&&v>=0)||
    (typeof v==='string'&&/^(0x[\da-f]+|0|[1-9]\d*)$/i.test(v)),'invalid unsigned integer');return BigInt(v);
}
function ord(v){const a=Number(integer(v));req(Number.isSafeInteger(a),'unsafe index');return a;}
function flag(v){const t=ord(v);req(t===0||t===1,'invalid status');return !!t;}
const parent=p=>p===''?null:p.includes(',')?p.slice(0,p.lastIndexOf(',')):'';
const delegate=k=>k==='delegatecall'||k==='callcode';
const create=k=>k==='create'||k==='create2';
const kind=x=>{const y=String(x).toLowerCase(),k=y==='suicide'?'selfdestruct':y;
  req(['call','callcode','delegatecall','staticcall','create','create2','selfdestruct'].includes(k),'unsupported frame kind');return k;};
const nullableAddress=x=>x==null?null:address(x);
function payload(l){
  const emitter=address(l.address??l.log_address),data=bytes(l.data);req(Array.isArray(l.topics)&&l.topics.length<=4,'invalid log topics');
  return {emitter,topics:l.topics.map(hash),data};
}
function receipts(raw,txHash,expectedBlock){
  req(Array.isArray(raw),'receipt logs missing');return raw.map((l,i)=>{
    req(l && !l.removed,'removed/missing log');
    if(l.transactionHash!=null)req(hash(l.transactionHash)===txHash,'receipt transaction mismatch');
    if(expectedBlock&&l.blockHash!=null)req(hash(l.blockHash)===expectedBlock,'receipt block mismatch');
    const idx=ord(l.logIndex??l.log_index);
    if(i){const prior=raw[i-1];req(idx===ord(prior.logIndex??prior.log_index)+1,'gap/duplicate/unordered receipt log index');}
    return {idx,...payload(l)};
  });
}
const sameLog=(a,b)=>a.emitter===b.emitter&&a.data===b.data&&a.topics.length===b.topics.length&&a.topics.every((x,i)=>x===b.topics[i]);
function canonicalFrames(rows) {
  req(Array.isArray(rows)&&rows.length,'no root frame');const map=new Map();
  for(const r of rows){
    const p=r.trace_address??'';
    req(typeof p==='string'&&/^(?:$|(?:0|[1-9]\d*)(?:,(?:0|[1-9]\d*))*)$/.test(p),'invalid trace path');
    req(!map.has(p),'duplicate trace path');
    const k=kind(r.trace_type?.toLowerCase()==='call'?r.call_type:r.trace_type);
    map.set(p,{path:p,kind:k,ok:flag(r.status),expected:ord(r.subtraces),children:[],from:r.from_address,to:r.to_address,input:r.input,output:r.output,value:r.value});
  }
  req(map.has(''),'root missing');
  for(const [p,f] of map) if(p!==''){
    const up=map.get(parent(p)), pos=ord(p.slice(p.lastIndexOf(',')+1));
    req(up&&pos<up.expected&&pos<map.size,'missing parent or invalid child slot');
    up.children[pos]=f;
  }
  for(const f of map.values()){
    req(f.expected===f.children.length&&f.expected<map.size,'missing declared children');
    for(let i=0;i<f.expected;i++)req(f.children[i],'missing child');
  }
  return map.get('');
}
function nativeFrame(r,p=''){
  req(r&&typeof r==='object','missing nested call');const calls=r.calls??[];req(Array.isArray(calls),'invalid calls');
  const ls=r.logs;req(ls==null||Array.isArray(ls),'invalid frame logs');
  return {path:p,kind:kind(r.type),ok:!r.error,children:calls.map((c,i)=>nativeFrame(c,p===''?String(i):p+','+i)),
    from:r.from,to:r.to,input:r.input,output:r.output,value:r.value,logs:ls};
}
// EVM order provides slots before/between/after children, not a guess that a
// log belongs to the closest frame. Repeated logs can occupy the SAME slot.
function indexExecution(root,txOK) {
  const nodes=[],slots=new Map(),byPath=new Map(),physical=new Map();
  let position=0;
  function visit(f,up,staticAncestor) {
    const p=f.path,k=f.kind,committed=f.ok&&(up?up.committed:txOK),from=nullableAddress(f.from),to=nullableAddress(f.to);
    req((from&&to)||(!committed && (create(k)||k==='selfdestruct')&&from),'invalid call parties/beneficiary');
    // Trace "from" is the execution address that entered the child frame,
    // not inherited Solidity msg.sender and not the delegate implementation.
    if(up&&(committed||up.contextAddress!==null))req(from===up.contextAddress,'child sender disagrees with parent execution context');
    const logical=delegate(k)?up?.logicalOwnerPath:p, context=delegate(k)?up?.contextAddress:to;
    req(!delegate(k)||up,'delegate root');
    const value=f.value==null?null:integer(f.value).toString();
    req(value!=null||!(k==='call'||committed&&(k==='selfdestruct'||create(k))),'missing call/create/selfdestruct value');
    const node={path:p,parent:up?.path??null,kind:k,from,to,contextAddress:context??null,logicalOwnerPath:logical??null,
      input:f.input==null?null:bytes(f.input),output:f.output==null?null:bytes(f.output),value:value??'0',committed};
    node.staticContext=staticAncestor||k==='staticcall';
    nodes.push(node);byPath.set(p,node);physical.set(p,f);
    const emits=committed&&!node.staticContext&&k!=='selfdestruct'&&context;
    function slot(){if(!emits)return;let list=slots.get(context);if(!list)slots.set(context,list=[]);
      list.push({pos:position++,path:p});}
    slot();for(const c of f.children){visit(c,node,node.staticContext);slot();}
  }
  visit(root,null,false);return {nodes,slots,byPath,physical};
}
const bounds=(a,v,after=false)=>{
  let l=0,r=a.length;while(l<r){const m=(l+r)>>>1;if(after?a[m].pos<=v:a[m].pos<v)l=m+1;else r=m;}return l;
};
function ownership(l,paths,source,byPath) {
  const owner=paths.length===1?paths[0]:null;
  const logical=[...new Set(paths.map(p=>byPath.get(p).logicalOwnerPath))];
  return {...l,ownerPath:owner,candidatePaths:paths,
    ownership:!paths.length?'unattributed':source==='traced'?'traced':owner!==null?'unique':'ambiguous',
    logicalOwnerPath:logical.length===1?logical[0]:null};
}
function flatOwnership(logs,I){
  let lo=0,hi=Infinity;const ranges=[];
  for(const l of logs){
    const xs=I.slots.get(l.emitter)??[];
    req(xs.length,'mined receipt emitter has no possible committed execution frame');
    const a=bounds(xs,lo);req(a<xs.length,'impossible receipt execution order');
    lo=xs[a].pos;ranges.push({xs,a});
  }
  const out=new Array(logs.length);
  for(let i=logs.length-1;i>=0;i--){
    const r=ranges[i];
    const b=bounds(r.xs,hi,true)-1;
    req(b>=r.a,'impossible receipt execution order');
    hi=r.xs[b].pos;out[i]=ownership(logs[i],[...new Set(r.xs.slice(r.a,b+1).map(s=>s.path))],'flat',I.byPath);
  }return out;
}
function tracedOwnership(logs,I) {
  const ls=[];for(const [path,r] of I.physical){const n=I.byPath.get(path);
    // Reverted subtrees do not own mined receipt logs. Tracers that retain
    // their discarded logs are harmless: never align them to the receipt.
    if(!n.committed) continue;
    for(const [order,l] of (r.logs??[]).entries()){
      const body=payload(l);req(!n.staticContext&&n.kind!=='selfdestruct'&&body.emitter===n.contextAddress,'nested log execution context mismatch');
      const pos=l.position==null?null:ord(l.position);req(pos==null||pos<=r.children.length,'nested log position out of bounds');
      ls.push({path,body,pos,order,ordinal:l.index==null?null:ord(l.index),blockIdx:l.logIndex==null?null:ord(l.logIndex)});
    }}
  if(!ls.length && logs.length) return {method:'flat-no-frame-logs',logs:flatOwnership(logs,I)};
  req(ls.length===logs.length,'nested log/receipt count mismatch');
  const byPosition=ls.every(r=>r.pos!==null),byOrdinal=ls.every(r=>r.ordinal!==null),byBlock=ls.every(r=>r.blockIdx!==null);
  req(byPosition||byOrdinal||byBlock,'incomplete nested log ordering');
  let sorted;
  if(byPosition) {
    const groups=new Map();for(const r of ls){const key=r.path+':'+r.pos;
      if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
    sorted=[];function visit(r){for(let i=0;i<=r.children.length;i++){
      for(const row of groups.get(r.path+':'+i)??[])sorted.push(row);
      if(r.children[i])visit(r.children[i]);
    }}visit(I.physical.get(''));
  } else sorted=ls.slice().sort(byOrdinal?(a,b)=>a.ordinal-b.ordinal:(a,b)=>a.blockIdx-b.blockIdx);
  if(ls.some(x=>x.ordinal!==null)){
    const offsets=new Set(sorted.flatMap((x,i)=>x.ordinal==null?[]:[x.ordinal-i]));
    req(offsets.size===1&&(offsets.has(0)||offsets.has(logs[0].idx)),'trace log index/order mismatch');
  }
  let cursor=0;const nextInFrame=new Map();
  const normalized=sorted.map((r,i)=>{
    const l=logs[i];req(sameLog(r.body,l)&&(r.blockIdx==null||r.blockIdx===l.idx),'nested log/receipt payload or index mismatch');
    req(r.order===(nextInFrame.get(r.path)??0),'inconsistent frame log order');nextInFrame.set(r.path,r.order+1);
    if(!byPosition){const xs=I.slots.get(l.emitter)??[];
      const requiredSlot=r.pos==null?null:xs.filter(x=>x.path===r.path)[r.pos];
      let at=bounds(xs,cursor);while(at<xs.length&&(xs[at].path!==r.path||(requiredSlot&&xs[at]!==requiredSlot)))at++;
      req(at<xs.length,'trace log order impossible for call tree');cursor=xs[at].pos;}
    return ownership(l,[r.path],'traced',I.byPath);
  });
  return {method:'traced',logs:normalized};
}
export function buildTree(tx){
  req(tx&&typeof tx==='object','missing transaction');
  const native=tx.trace!=null||tx.receipt!=null;
  req(!native||tx.trace&&tx.receipt,'expected both trace and receipt');
  const hashValue=hash(native?tx.receipt.transactionHash:tx.tx_hash),ok=flag(native?tx.receipt.status:tx.receipt_status);
  const block=native?tx.receipt.blockHash:tx.block_hash;
  const ls=receipts(native?tx.receipt.logs:tx.logs,hashValue,block==null?null:hash(block));
  req(ok||!ls.length,'reverted transaction has receipts');
  const root=native?nativeFrame(tx.trace):canonicalFrames(tx.traces);
  req(ok===root.ok,'root/receipt status mismatch');
  req(root.kind==='call'||create(root.kind),'invalid root kind');
  const from=native?tx.receipt.from:tx.from_address,to=native?tx.receipt.to:tx.to_address;
  if(from!=null)req(address(from)===nullableAddress(root.from),'root/envelope sender mismatch');
  if(to!=null)req(root.kind==='call'&&address(to)===nullableAddress(root.to),'root/envelope recipient mismatch');
  if(native&&tx.receipt.contractAddress!=null)req(create(root.kind)&&address(tx.receipt.contractAddress)===nullableAddress(root.to),'contract creation address mismatch');
  if(!native&&tx.input!=null&&root.input!=null)req(bytes(tx.input)===bytes(root.input),'root/envelope calldata mismatch');
  const I=indexExecution(root,ok),result=native?tracedOwnership(ls,I):{method:'flat',logs:flatOwnership(ls,I)};
  return {txHash:hashValue,nodes:I.nodes,logs:result.logs,ownershipSource:result.method};
}
