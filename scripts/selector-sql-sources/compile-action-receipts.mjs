import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EventFragment, FunctionFragment} from '../../listener/node_modules/ethers/lib.esm/index.js';
import {loadCatalogEventRules} from '../selector-event-catalog-sql.mjs';

const layouts = JSON.parse(readFileSync(new URL('./action-receipts.json', import.meta.url)));
const selector = signature => FunctionFragment.from(signature).selector;

function eventSchema(signature) {
  const abi = EventFragment.from(signature);
  return {topic: abi.topicHash, fields: abi.inputs.map(f => ({name:f.name, type:f.type, indexed:f.indexed === true}))};
}

function validateOperands(action, schema, rule) {
  const args=FunctionFragment.from(action).inputs;
  const types=new Map(schema.fields.map(f=>[f.name,f.type]));
  assert.equal(rule.assets.length,2);
  assert.equal(rule.deltas.length,2);
  for (const side of rule.deltas) {
    assert(side.length>0);
    for (const term of side) assert(/^u?int\d+$/.test(types.get(term.replace(/^-/,''))), 'invalid receipt quantity: '+term);
  }
  for (const role of [rule.payer,rule.recipient].filter(Boolean))
    assert(role==='caller' || types.get(role)==='address','invalid settlement role: '+role);
  if (rule.reverseWhenFalse) assert.equal(types.get(rule.reverseWhenFalse),'bool');
  if (rule.transferProof) {
    const proof = rule.transferProof;
    assert.equal(proof.length,2);
    assert.equal(new Set(proof.map(side=>side.amount)).size,2);
    assert(proof.some(side=>side.amount===rule.inputAmount));
    for (const side of proof) {
      assert(['self','external'].includes(side.token) && types.get(side.amount)==='uint256');
      assert(side.from || side.to);
      for (const role of [side.from,side.to].filter(Boolean))
        assert(role==='zero' || (types.get(role)==='address' && rule.equals[role]));
    }
  }
  for (const [field,operand] of Object.entries(rule.equals)) {
    if (operand==='caller') assert.equal(types.get(field),'address');
    else if (operand==='value') assert.equal(types.get(field),'uint256');
    else {
      const ref=/^arg(\d+)(-or-caller)?$/.exec(operand);
      assert(ref && types.has(field) && args[Number(ref[1])]?.type===types.get(field),'invalid action/event binding: '+field);
      if (ref[2]) assert.equal(types.get(field),'address');
    }
  }
}

export function compileActionReceipts(root) {
  const catalog = loadCatalogEventRules(root);
  const installed = new Set(catalog.ordinaryFamilies.map(id => id.split(':')[1]));
  const out = {};
  for (const {actions, event, actionAmounts, assets, snapshot, ...fields} of layouts) {
    const schema = eventSchema(event);
    for (const [i, action] of actions.entries()) {
      const key = selector(action);
      if (!installed.has(key)) continue;
      const declared = catalog.rules.filter(r => r.familySelector === key && r.topic0 === schema.topic);
      for (const variant of declared.flatMap(r => r.variants)) {
        if (variant.fields) assert.deepEqual(variant.fields.map(([,t,ix]) => [t,ix]),
          schema.fields.map(f => [f.type,f.indexed]), 'event ABI disagrees with Family JSON: '+action);
      }
      const equals = {...fields.equals};
      if (actionAmounts) equals[actionAmounts[i]] = 'arg0';
      assert(!out[key], 'duplicate action receipt declaration: '+action);
      out[key] = {...fields, equals, ...schema, assets: assets.map(x => x.includes('(') ? selector(x) : x)};
      if (fields.transferProof) out[key].inputAmount = actionAmounts[i];
      validateOperands(action,schema,out[key]);
      if (snapshot) out[key].snapshot = {...eventSchema(snapshot.event), balances:snapshot.balances, read:selector(snapshot.read)};
    }
  }
  return out;
}
