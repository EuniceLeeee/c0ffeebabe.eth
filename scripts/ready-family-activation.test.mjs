import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { FunctionFragment } from '../listener/node_modules/ethers/lib.esm/index.js';
import { activationKeys, enableReadyFamilies } from './ready-family-activation.mjs';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'ready-v2-activations-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const dir=join(root,'listener/src/searcher/venues/production-families');mkdirSync(dir,{recursive:true});
  const signature='function activationFixture(address input,address output,uint256 amount) returns(uint256)';
  const selector=FunctionFragment.from(signature).selector;
  const write=(name,activation)=>{
    const path=join(dir,name+'.production.ts');
    const source='import {defineSelectorFamilyModule} from "../selector-family-module.js";\nimport definition from "./'+name+'.json";\nexport const selectorFamilyModule=defineSelectorFamilyModule(definition);\n';
    writeFileSync(path,source);
    writeFileSync(join(dir,name+'.json'),JSON.stringify({selector,signature,domain:'protocol',
      parameters:['tokenIn','tokenOut','amountIn'].map((role,index)=>({path:[index],role})),payment:{kind:'none'},...(activation?{activation}:{})}));
    return {path,source};
  };
  return {root,write,selector};
}

test('activation comes from the v2 JSON bound to the exported module before import', t=>{
  const f=fixture(t),entry=f.write('declared',{enabled:false,envKey:'SEARCHER_FAMILY_TEST_ENABLED'});
  assert.deepEqual(activationKeys(entry.source,entry.path),['SEARCHER_FAMILY_TEST_ENABLED']);
  const defaults=f.write('default');
  assert.deepEqual(activationKeys(defaults.source,defaults.path),['SEARCHER_FAMILY_SELECTOR_'+f.selector.slice(2).toUpperCase()+'_ENABLED']);
  assert.throws(()=>activationKeys('export const activation = defineFamilyActivation({enabled:true,envKey:"SEARCHER_FAMILY_OLD_ENABLED"});',entry.path),/Retired/);
  assert.throws(()=>activationKeys(entry.source.replace('(definition)','({})'),entry.path),/Invalid v2/);
  assert.throws(()=>activationKeys(entry.source.replace('selector-family-module.js','other-module.js'),entry.path),/Invalid v2 module factory/);
});

test('all discovered v2 declarations are enabled before import including inherited zero', t=>{
  const f=fixture(t);
  f.write('a',{enabled:false,envKey:'SEARCHER_FAMILY_FIRST_ENABLED'});
  f.write('b',{enabled:true,envKey:'SEARCHER_FAMILY_SECOND_ENABLED'});
  const env={SEARCHER_FAMILY_FIRST_ENABLED:'0',SEARCHER_FAMILY_SECOND_ENABLED:'0'};
  assert.deepEqual(enableReadyFamilies(f.root,env),['SEARCHER_FAMILY_FIRST_ENABLED','SEARCHER_FAMILY_SECOND_ENABLED']);
  assert.deepEqual(Object.values(env),['1','1']);
});
