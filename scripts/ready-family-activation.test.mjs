import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { activationKeys, enableReadyFamilies } from './ready-family-activation.mjs';

test('identifier, single/double quoted keys and formatting produce the same activation', () => {
  for (const key of ['envKey', '"envKey"', "'envKey'"])
    assert.deepEqual(activationKeys(`export const activation = defineFamilyActivation({enabled:true, ${key} \n : 'SEARCHER_FAMILY_TEST_ENABLED'});`), ['SEARCHER_FAMILY_TEST_ENABLED']);
  assert.deepEqual(activationKeys('// defineFamilyActivation({envKey:"SEARCHER_FAMILY_FALSE_ENABLED"})'), []);
  assert.throws(() => activationKeys('defineFamilyActivation({envKey: process.env.OTHER})'), /literal/);
});
test('all discovered declarations are enabled before import and recorded, including inherited zero', t => {
  const root = mkdtempSync(join(tmpdir(),'ready-activations-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const dir=join(root,'listener/src/searcher/venues/production-families'); mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'old.production.ts'), 'defineFamilyActivation({enabled:false,envKey:"SEARCHER_FAMILY_OLD_ENABLED"})');
  writeFileSync(join(dir,'json.production.ts'), 'defineFamilyActivation({"enabled":true,"envKey":"SEARCHER_FAMILY_JSON_ENABLED"})');
  const env={SEARCHER_FAMILY_JSON_ENABLED:'0',SEARCHER_FAMILY_OLD_ENABLED:'0'};
  assert.deepEqual(enableReadyFamilies(root,env),['SEARCHER_FAMILY_JSON_ENABLED','SEARCHER_FAMILY_OLD_ENABLED']);
  assert.deepEqual(Object.values(env),['1','1']);
});
