import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { discoveryRules, checkCatalogMatches, renderQuery } from './ready-discovery-query.mjs';

const topic = '0x' + 'A'.repeat(64);
const plugin = (familyId, discovery) => ({ plugin: { manifest: { familyId }, discovery } });
test('shared signatures keep all Families; duplicate declarations only dedupe within a Family', () => {
  const {rules, families} = discoveryRules({listAll:()=>[
    plugin('first', {callPatterns:[{selector:'0xABCDEF01'},{selector:'0xabcdef01'}],logPatterns:[{topic}]}),
    plugin('second', {callPatterns:[{selector:'0xabcdef01'}]}),
    plugin('address-only', {addressSurfaces:[{kind:'interface'}],candidateSources:['startup']}),
    plugin('funding', undefined)
  ]});
  assert.equal(rules.length, 3);
  assert.deepEqual(rules.filter(rule=>rule.kind==='call').map(rule=>rule.family_id), ['first','second']);
  assert(rules.every(rule=>rule.signature===rule.signature.toLowerCase()));
  assert.equal(families.find(f=>f.familyId==='address-only').addressSurfaces, 1);
  assert.equal(families.find(f=>f.familyId==='funding').logCallDeclarations, 0);
});
test('invalid declarations cannot silently narrow the query', () => {
  for (const discovery of [{callPatterns:[{selector:'0x123'}]}, {logPatterns:[{topic:'bad'}]}])
    assert.throws(()=>discoveryRules({listAll:()=>[plugin('bad',discovery)]}), /Invalid/);
});
test('catalog check retains collisions and detects omitted Family matches', () => {
  const rules = ['first','second'].map(family_id=>({family_id,kind:'call',signature:'0xabcdef01'}));
  const catalog = {matches: observation => {
    assert.equal(observation.kind,'call'); assert.equal(observation.data,'0xabcdef01');
    return [{familyId:'first'},{familyId:'second'},{familyId:'first'}];
  }};
  assert.equal(checkCatalogMatches(catalog,rules),1);
  assert.throws(()=>checkCatalogMatches(catalog,rules.slice(0,1)), /disagrees/);
});
test('one query renders only a validated source table and preserves unmatched transactions', () => {
  const template = readFileSync(new URL('./ready-discovery-query.sql',import.meta.url),'utf8');
  const sql=renderQuery(template,'eth-token-480803.Ready.1008-1015');
  assert(sql.includes('`eth-token-480803.Ready.1008-1015`'));
  assert(!sql.includes('__SOURCE_TABLE__'));
  assert(sql.includes('@discovery_rules_json'));
  assert(sql.includes('FROM transaction_signatures AS tx\nCROSS JOIN discovery_rules AS declarations;'));
  assert(sql.includes('SELECT ARRAY('), 'An empty rule list must still produce one parameter row');
  for(const table of ['bad','p.d.t` WHERE TRUE --','project1.dataset.table;DROP'])
    assert.throws(()=>renderQuery(template,table),/Invalid/);
});
