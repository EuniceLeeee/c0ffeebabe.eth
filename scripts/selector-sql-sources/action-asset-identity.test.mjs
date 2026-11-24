import assert from 'node:assert/strict';
import test from 'node:test';
import {actionAssetIdentity,provedCounterMovement} from './action-asset-identity.mjs';

const A=i=>'0x'+i.toString(16).padStart(40,'0'), W=i=>BigInt(i).toString(16).padStart(64,'0');
const [venue,payer,recipient,token,fee,other]=[1,2,3,4,5,6].map(A);
const topic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',yes='0x'+W(1);
function scenario({incoming=false,delegate=false,output=yes}={}) {
  const call={target:venue,sender:payer,kind:'call',valid:true}, parent=delegate?
    {target:other,sender:venue,kind:'delegatecall',parent:call,valid:true}:call;
  const from=incoming?payer:venue,to=incoming?venue:recipient;
  const move={target:token,sender:venue,kind:'call',valid:true,parent,output,input:incoming?
    '0x23b872dd'+W(from)+W(to)+W(100):'0xa9059cbb'+W(to)+W(100)};
  const nodes=[call,...(delegate?[parent]:[]),move],logs=[],transferReceipts=new Map(),placements=new Map();
  const add=(from,to,amount,owners=[move],asset=token)=>{
    const l={idx:logs.length,emitter:asset,topics:[topic,'0x'+W(from),'0x'+W(to)]};logs.push(l);
    transferReceipts.set(l,{from,to,amount:BigInt(amount),asset});
    placements.set(l,{first:0,last:owners.length-1,slots:owners.map(owner=>({owner}))});return l;
  };
  const prove=()=>actionAssetIdentity(call,nodes,{logs,transferReceipts,timeline:{placements}},
    {incoming,qty:100n,payer,recipient});
  return {call,move,nodes,add,prove,from,to,transferReceipts,context:{logs,transferReceipts,timeline:{placements}}};
}

test('one fully attributed payment identifies currency, not actual price, even with fee subtransfers',()=>{
  for(const incoming of [true,false])for(const delegate of [true,false])for(const output of [yes,'0x']){
    const x=scenario({incoming,delegate,output});x.add(x.from,fee,15);x.add(x.from,x.to,85);
    assert.deepEqual(x.prove(),{asset:token,indices:[0,1],creditIndex:1});
  }
});
test('call data, a fee alone, ambiguous sibling, nonfungible and failed/no-return-data calls are not transfer proof',()=>{
  for(const kind of ['no-movement','fee-only','ambiguous','unplaced','non-fungible','false-return','missing-result','malformed-result','trailing-data','reverted','amount-mismatch']){
    const x=scenario();
    if(kind==='fee-only')x.add(x.from,fee,100);
    else if(kind!=='no-movement'){
      const sibling={target:token,kind:'call'};
      const l=x.add(x.from,x.to,100,kind==='ambiguous'?[sibling,x.move]:kind==='unplaced'?[]:[x.move]);
      if(kind==='non-fungible'){l.topics.push('0x'+W(100));x.transferReceipts.delete(l);}
    }
    if(kind==='false-return')x.move.output='0x'+W(0);
    if(kind==='missing-result')x.move.output=null;
    if(kind==='malformed-result')x.move.output='0x01';
    if(kind==='trailing-data')x.move.input+='00';
    if(kind==='reverted')x.move.valid=false;
    if(kind==='amount-mismatch')x.move.input=x.move.input.slice(0,-64)+W(99);
    assert.equal(x.prove(),undefined,kind);
  }
});
test('duplicates, different assets, contradictory transfers, excess or other-principal credits reject',()=>{
  for(const kind of ['duplicate-payment','second-credit','refund','recipient-spend','competing-currency','extra-debit','other-source','zero']){
    const x=scenario();x.add(x.from,x.to,kind==='zero'?0:85);
    if(kind==='duplicate-payment')x.nodes.push({...x.move});
    if(kind==='second-credit')x.add(x.from,x.to,1);
    if(kind==='refund')x.add(x.to,x.from,1);
    if(kind==='recipient-spend')x.add(x.to,fee,1);
    if(kind==='competing-currency')x.add(x.from,x.to,85,[{target:other,parent:x.call}],other);
    if(kind==='extra-debit')x.add(x.from,fee,16);
    if(kind==='other-source')x.add(fee,x.to,11);
    assert.equal(x.prove(),undefined,kind);
  }
});
test('separate external action cannot supply settlement; provably disjoint unrelated receipt cannot disqualify actual transfer',()=>{
  const x=scenario();x.add(x.from,x.to,100);x.move.parent={kind:'call',target:other,parent:x.call};
  assert.equal(x.prove(),undefined);
  x.move.parent=x.call;x.add(x.from,x.to,100,[{kind:'call',target:token}]);assert.deepEqual(x.prove(),{asset:token,indices:[0],creditIndex:0});
});
test('when returndata is absent the counter-asset requires before and after venue balances around an isolated transfer',()=>{
  for(const change of ['none','wrong-after','extra-token-write','nested-other-scope','missing-receipt','false-result','misowned-balance','refund','wrong-payer']){
    const x=scenario({incoming:true});x.move.output=null;x.move.order=3;
    const l=x.add(x.from,x.to,100),m={...x.transferReceipts.get(l),index:l.idx,node:x.move};
    const read=(order,n)=>({kind:'staticcall',ok:true,parent:x.call,sender:venue,target:token,order,
      input:'0x70a08231'+W(venue),output:'0x'+W(n)});
    const before=read(1,500),after=read(5,600);x.nodes.push(before,after);
    if(change==='wrong-after')after.output='0x'+W(599);
    if(change==='extra-token-write')x.nodes.push({...x.move,order:2});
    if(change==='nested-other-scope')x.nodes.push({...x.move,order:4,target:other,input:'0x11223344'});
    if(change==='missing-receipt')x.context.timeline.placements.delete(l);
    if(change==='false-result')x.move.output='0x'+W(0);
    if(change==='misowned-balance')before.sender=payer;
    if(change==='refund')x.add(venue,payer,17);
    const received=provedCounterMovement(m,x.call,x.nodes,x.context,{incoming:true,payer:change==='wrong-payer'?fee:payer,recipient});
    assert.equal(received,change==='none',change);
  }
});
