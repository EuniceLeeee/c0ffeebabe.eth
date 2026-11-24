import {possibleReceiptOwners} from './receipt-call-owners.mjs';

const zero='0x'+'0'.repeat(40);
const addr=w=>/^0{24}[a-f0-9]{40}$/.test(w||'')?'0x'+w.slice(-40):null;
const tokenTransfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const word=(s,i)=>s.slice(10+64*i,74+64*i);
const below=(n,ancestor)=>{for(let p=n;p;p=p.parent)if(p===ancestor)return true;return false;};
function caller(n){while(n&&(n.kind==='delegatecall'||n.kind==='callcode'))n=n.parent;return n;}
function payment(n,allowMissingOutput=false){
  const method=n.input?.slice(0,10),direct=method==='0xa9059cbb';
  if(!n.valid||n.kind!=='call'||!direct&&method!=='0x23b872dd')return;
  if(n.input.length!==(direct?138:202)||!/^0x[a-f0-9]+$/.test(n.input))return;
  if(n.output!=='0x'&&!(allowMissingOutput&&n.output==null)&&!/^0x0{63}1$/.test(n.output||''))return;
  const from=direct?n.sender:addr(word(n.input,0)),to=addr(word(n.input,direct?0:1));
  if(!from||!to||from===to||from===zero||to===zero)return;
  return {node:n,asset:n.target,from,to,qty:BigInt('0x'+word(n.input,direct?1:2))};
}

export function confirmedPaymentOwner(m){
  if(m.owners.size!==1)return;
  const [owner]=m.owners,p=payment(owner);
  if(p&&p.asset===m.asset&&p.from===m.from&&p.to===m.to&&p.qty===m.amount)return owner;
}

// The action event already established nominal quantity, side and parties. To
// identify currency, require a single direct payment BY the venue (possibly via
// its own delegate), and an actual positive credit in the very same token call.
// Colocated token activity, calldata alone and an isolated fee transfer do not suffice.
// This proof deliberately does not turn the nominal quantity into a measured fill.
export function actionAssetIdentity(call,nodes,context,{incoming,qty,payer,recipient}){
  if(!context?.timeline?.placements||!context.transferReceipts||qty<=0n)return;
  const from=incoming?payer:call.target,to=incoming?call.target:recipient;
  if(!from||!to||from===to)return;
  const moves=[];
  for(const n of nodes){
    if(n.sender!==call.target||!below(n,call))continue;
    const p=payment(n);if(p&&p.from===from&&p.to===to)moves.push(p);
  }
  if(moves.length!==1)return;
  const p=moves[0];if(p.qty!==qty||p.asset===zero||caller(p.node.parent)!==call)return;
  const credits=[],indices=[],placements=context.timeline.placements;let totalDebit=0n;
  for(const l of context.logs){
    if(l.topics[0]!==tokenTransfer)continue;
    const m=context.transferReceipts.get(l),place=placements.get(l);
    // For this currency malformed/non-fungible records touching a principal
    // cannot serve as a credited value or silently displace a competing transfer.
    const affected=m?(m.from===from||m.to===to||m.from===to||m.to===from):
      l.emitter===p.asset&&[l.topics[1],l.topics[2]].some(t=>[from,to].includes(addr(t?.slice(2))));
    if(!affected)continue;
    const owners=place?possibleReceiptOwners(place):null;
    if(owners?.size&&[...owners].every(n=>!below(n,call)))continue;
    if(m&&m.from===from&&m.to===to&&m.asset!==p.asset)return;
    if(l.emitter!==p.asset)continue;
    if(!m||!owners||!owners.size||[...owners].some(n=>n!==p.node))return;
    // The proceeds can be split between payee and a fee address in that
    // one physical payment. Do not silently ignore refunds or onward spends.
    if(m.from===to||m.to===from||(m.to===to&&m.from!==from))return;
    if(m.from===from){totalDebit+=m.amount;indices.push(l.idx);if(m.to===to)credits.push({amount:m.amount,index:l.idx});}
  }
  if(credits.length!==1||credits[0].amount<=0n||totalDebit>qty)return;
  return {asset:p.asset,indices,creditIndex:credits[0].index};
}

// When a newly recovered side is combined with an old inferred counter-side,
// require an independently real, physically scoped counter-movement. An exact
// amount from an arbitrary sibling is not authority to name the second asset.
export function provedCounterMovement(m,call,nodes,context,{incoming,payer,recipient}){
  if(m.index==null) return m.asset===zero&&m.node.valid&&m.node.kind==='call'&&below(m.node,call)&&
    (incoming?m.to===call.target&&(!payer||m.from===payer):m.from===call.target&&(!recipient||m.to===recipient));
  if(incoming?(m.to!==call.target||(payer&&m.from!==payer)):(m.from!==call.target||(recipient&&m.to!==recipient)))return false;
  const l=context.logs.find(l=>l.idx===m.index),place=l&&context.timeline.placements.get(l),p=payment(m.node,true);
  if(!p||p.asset!==m.asset||p.qty!==m.amount||p.from!==m.from||p.to!==m.to||!below(m.node,call)||!place)return false;
  const owners=possibleReceiptOwners(place);
  if(owners.size!==1||!owners.has(m.node))return false;
  for(const other of context.logs){
    if(other===l||other.emitter!==m.asset||other.topics[0]!==tokenTransfer)continue;
    if(![other.topics[1],other.topics[2]].some(t=>addr(t?.slice(2))===call.target))continue;
    const range=context.timeline.placements.get(other);
    if(!range)return false;
    const otherOwners=possibleReceiptOwners(range);
    if(!otherOwners.size||[...otherOwners].some(n=>below(n,call)))return false;
  }
  if(m.node.output!=null)return true;
  // Some trace sources omit returndata entirely. The receipt alone must not
  // stand in for an unknown return: corroborate with the venue's own before/
  // after balance reads bracketing exactly this one write to this token.
  const signature='0x70a08231'+'0'.repeat(24)+call.target.slice(2),reads=nodes.filter(n=>
    n.kind==='staticcall'&&n.ok&&n.parent?.valid&&caller(n.parent)===call&&n.sender===call.target&&
    n.target===m.asset&&n.input===signature&&/^0x[a-f0-9]{64}$/.test(n.output||''));
  const left=reads.filter(n=>n.order<m.node.order).at(-1),right=reads.find(n=>n.order>m.node.order);
  if(!left||!right||nodes.some(n=>n!==m.node&&n.valid&&n.kind!=='staticcall'&&(!below(m.node,n)||n.target===m.asset)&&
    n.order>left.order&&n.order<right.order))return false;
  return BigInt(right.output)-BigInt(left.output)===(incoming?m.amount:-m.amount);
}
