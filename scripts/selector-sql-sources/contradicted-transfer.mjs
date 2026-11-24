import {receiptCallOwners,possibleReceiptOwners} from './receipt-call-owners.mjs';

// The dataset may omit returndata; some legacy fungible tokens return no
// bytes on success. Neither is an explicit negative. Nonempty returndata must
// encode true, not false, a malformed word, or a true word with trailing data.
export function contradictedTransfer(output){
  return output!=null&&output!=='0x'&&!/^0x0{63}1$/.test(output);
}

// Preserve the receipt in the full timeline and as a competing movement; just
// do not allow it to serve as positive proof. A successful unrelated payment
// at this same token, if disjoint, stays usable.
export function rejectedReceiptEvidence(bad,paths,logs,transferTopic){
  if(!bad.size)return null;
  const assets=new Set([...bad].map(n=>n.target)),marked=new Map();
  const timeline=receiptCallOwners([...paths.values()],logs,new Set([transferTopic]));
  for(const l of logs){
    if(!assets.has(l.emitter)||l.topics[0]!==transferTopic)continue;
    const range=timeline?.placements.get(l),owners=range&&possibleReceiptOwners(range);
    if(!owners?.size||[...owners].some(n=>bad.has(n)))marked.set(l.idx,l.emitter);
  }
  return marked;
}

export function screenRejectedPayments(rows,marked){
  if(!marked?.size)return rows;
  return rows.filter(e=>{
    const ids=(e.receiptIndices??'').split(',').filter(Boolean).map(Number),bad=ids.filter(i=>marked.has(i));
    if(!bad.length)return true;
    if(!e.independentDirection)return false;
    for(const i of bad){
      if(marked.get(i)===e.tokenIn)e.amountPayerInRaw=null;
      if(marked.get(i)===e.tokenOut)e.amountReceivedOutRaw=null;
    }
    e.receiptIndices=ids.filter(i=>!marked.has(i)).join(',');
    if(e.settlementClaims)e.settlementClaims=e.settlementClaims.filter(c=>!marked.has(c.logIndex));
    return true;
  });
}
