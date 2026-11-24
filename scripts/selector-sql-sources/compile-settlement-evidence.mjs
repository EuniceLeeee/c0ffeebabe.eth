import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {EventFragment,FunctionFragment} from '../../listener/node_modules/ethers/lib.esm/index.js';

// These declarations belong to execution families, not to the shared pipeline.
// The inner action is an observation, not a second enabled execution entry.
export function compileSettlementEvidence(root) {
  const base=join(root,'listener/src/searcher/venues/selector-native');
  const balanceActions={},settlementProofs={};
  for (const {name} of readdirSync(base,{withFileTypes:true}).filter(e=>e.isDirectory())) {
    const file=join(base,name,'discovery-evidence.json');
    if (!existsSync(file)) continue;
    const owner=/^selector-([0-9a-f]{8})-family$/.exec(name);
    assert(owner,'missing settlement declaration owner: '+name);
    const def=JSON.parse(readFileSync(join(base,name,'selector-'+owner[1]+'.json'),'utf8'));
    const recipe=JSON.parse(readFileSync(file,'utf8'));
    assert.equal(def.selector,'0x'+owner[1]);assert.equal(recipe.version,1);
    assert(recipe.balanceAction || recipe.innerAction);
    if(recipe.balanceAction) {
      const b=recipe.balanceAction, event=EventFragment.from(b.event), action=FunctionFragment.from(def.signature);
      assert.equal(action.selector,def.selector);
      const data=event.inputs.filter(x=>!x.indexed), indexed=event.inputs.filter(x=>x.indexed);
      assert(data.every(x=>/^(address|bool|u?int[0-9]+|bytes[0-9]+)$/.test(x.type)),'static ABI words required');
      const topicOf=f=>{const i=indexed.findIndex(x=>x.name===f&&x.type==='address');assert(i>=0);return i+1;};
      const deltaWords=b.deltas.map(f=>{const i=data.findIndex(x=>x.name===f&&x.type==='int256');assert(i>=0);return i;});
      assert.equal(deltaWords.length,2);assert.equal(new Set(deltaWords).size,2);
      assert([1,-1].includes(b.sign));assert(Number.isSafeInteger(b.recipientArg)&&b.recipientArg>=0&&b.recipientArg<32);
      assert.equal(action.inputs[b.recipientArg]?.type,'address');
      balanceActions[def.selector]={topic:event.topicHash,deltaWords,sign:b.sign,dataWords:data.length,topicCount:indexed.length+1,callerTopic:topicOf(b.caller),
        recipientTopic:topicOf(b.recipient),recipientArg:b.recipientArg};
    }
    if(recipe.innerAction) {
      const {signature,mode,returnBits,counterpartyArg,amountSign,batch}=recipe.innerAction;
      const action=FunctionFragment.from(signature);
      assert.equal(mode,'counterparty-net');assert.equal(returnBits,128);assert.equal(amountSign,'caller');
      assert(Number.isSafeInteger(counterpartyArg)&&counterpartyArg>=0&&counterpartyArg<32);
      assert(!settlementProofs[action.selector],'duplicate inner settlement decoder');
      settlementProofs[action.selector]={entrySelector:def.selector,mode,returnBits,counterpartyArg,amountSign};
      if (batch) {
        const callback=FunctionFragment.from(batch.callback),pay=FunctionFragment.from(batch.pay),take=FunctionFragment.from(batch.take);
        assert.deepEqual(callback.inputs.map(x=>x.type),['bytes']);assert.equal(pay.inputs.length,0);
        assert.deepEqual(take.inputs.map(x=>x.type),['address','address','uint256']);
        settlementProofs[action.selector].batch={callback:callback.selector,pay:pay.selector,take:take.selector};
      }
    }
  }
  return {balanceActions,settlementProofs};
}
