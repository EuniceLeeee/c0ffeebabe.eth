// A physical payment may be the output of one conversion and the input of the next.
// Only explicit, same-side settlement claims compete. Native value uses its
// successful value-carrying call path; ETH has no Transfer receipt index.
export function resolveActionClaims(rows) {
  if(!rows.some(e=>e.settlementClaims||e.independentDirection))return rows;
  const owners=new Map();
  const id=c=>c.asset+'/'+c.side+'/'+(c.valuePath===undefined?'log:'+c.logIndex:'value:'+c.valuePath);
  for(const e of rows) for(const c of e.settlementClaims??[]){
    const log=Number.isSafeInteger(c.logIndex)&&c.logIndex>=0&&c.valuePath===undefined;
    const value=c.logIndex===undefined&&typeof c.valuePath==='string'&&/^(?:\d+(?:,\d+)*)?$/.test(c.valuePath);
    if(c.asset!==(c.side==='in'?e.tokenIn:e.tokenOut)||!['in','out'].includes(c.side)||(!log&&!value))
      throw Error('invalid settlement reference');
    const k=id(c);let s=owners.get(k);if(!s)owners.set(k,s=new Set());s.add(e);
  }
  // Looking at the caller's net position is not an independent conversion
  // if a descendant venue actually took/paid the very same side. Remove the
  // forwarding observation before deciding if any real actions compete.
  const shadowed=new Set();
  for(const e of rows) if(e.evidence==='caller-receipt-net-flow') {
    const parent=e.callPath;
    for(const c of e.settlementClaims??[])for(const other of owners.get(id(c))){
      const p=other.innerSwapPath??other.callPath;
      if(other!==e && other.venuePayments===true && p!=null && p!==parent && (parent===''||p.startsWith(parent+',')))shadowed.add(e);
    }
  }
  for(const e of shadowed)for(const c of e.settlementClaims) owners.get(id(c)).delete(e);
  const out=[];
  for(const e of rows){
    if(shadowed.has(e))continue;
    let excluded=false;
    for(const c of e.settlementClaims??[]) if(owners.get(id(c)).size>1){
      if(!e.independentDirection&&!e.decodedVenueDirection){excluded=true;break;}
      // A separate observation proves the direction, but the shared payment
      // cannot prove either beneficiary's actual fill.
      if(c.side==='in')e.amountPayerInRaw=null;else e.amountReceivedOutRaw=null;
    }
    delete e.settlementClaims;delete e.independentDirection;delete e.decodedVenueDirection;delete e.venuePayments;
    if(!excluded)out.push(e);
  }
  return out;
}
