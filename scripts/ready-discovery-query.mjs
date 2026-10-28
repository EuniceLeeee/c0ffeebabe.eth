#!/usr/bin/env node
// Preparation only. No BigQuery query, RPC, Ready mutation or production filter.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const sorted = values => [...new Set(values)].sort();

export function discoveryRules(catalog) {
  const rules = [], families = [];
  for (const family of catalog.listAll()) {
    const id = family.plugin.manifest.familyId;
    const discovery = family.plugin.discovery;
    const before = rules.length;
    for (const pattern of discovery?.logPatterns ?? []) {
      assert(/^0x[0-9a-f]{64}$/i.test(pattern.topic), 'Invalid log topic');
      rules.push({ family_id: id, kind: 'log', signature: pattern.topic.toLowerCase() });
    }
    for (const pattern of discovery?.callPatterns ?? []) {
      assert(/^0x[0-9a-f]{8}$/i.test(pattern.selector), 'Invalid call selector');
      rules.push({ family_id: id, kind: 'call', signature: pattern.selector.toLowerCase() });
    }
    families.push({ familyId: id, logCallDeclarations: rules.length - before,
      addressSurfaces: discovery?.addressSurfaces?.length ?? 0,
      candidateSources: discovery?.candidateSources ?? [],
      hasReverseBinding: discovery?.reverseBinding?.kind === 'implementation' });
  }
  const uniqueRules = [...new Map(rules.map(rule => [JSON.stringify(rule), rule])).values()]
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return { rules: uniqueRules, families };
}

export function checkCatalogMatches(catalog, rules) {
  const groups = new Map();
  for (const rule of rules) {
    const key = rule.kind + '|' + rule.signature;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rule.family_id);
  }
  // This is a declaration-export check, not a BigQuery accuracy result.
  const source = { number: 1, hash: '0x' + '0'.repeat(64), generation: 1 };
  const address = '0x' + '0'.repeat(40);
  for (const [key, families] of groups) {
    const [kind, signature] = key.split('|');
    const observation = kind === 'log'
      ? { kind, source, address, topics: [signature], data: '0x' }
      : { kind, source, target: address, data: signature, sender: address };
    assert.deepEqual(sorted(catalog.matches(observation).map(match => match.familyId)), sorted(families),
      'Declaration export disagrees with production catalog for ' + key);
  }
  return groups.size;
}

export function renderQuery(template, table) {
  assert(/^[a-z][a-z0-9-]+\.[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z0-9_-]+$/.test(table), 'Invalid table identifier');
  assert(template.includes('`__SOURCE_TABLE__`'), 'Missing source-table placeholder');
  return template.replaceAll('__SOURCE_TABLE__', table);
}

export async function prepareQuery([run, output, sqlFile]) {
  for (const path of [run, output]) assert(path?.startsWith('/'), 'Use absolute run/output paths');
  if (sqlFile !== undefined) assert(sqlFile.startsWith('/'));
  const identity = read(run + '/run-identity.json'), pin = read(run + '/input-pin.json');
  assert.deepEqual(identity.input, pin, 'Source pin differs from run identity');
  Object.assign(process.env, {
    SEARCHER_DRY_RUN: '1', SEARCHER_BLOCKSCAN_SUBMIT: '0', SEARCHER_TEST_DISABLE_DOTENV: '1',
  });
  for (const name of identity.activations) {
    assert(/^SEARCHER_FAMILY_[A-Z0-9_]+_ENABLED$/.test(name));
    process.env[name] = '1';
  }
  const modulePath = run + '/runtime/listener/src/searcher/venues/production-family-composition.ts';
  const { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: catalog } = await import(pathToFileURL(modulePath));
  const { rules, families } = discoveryRules(catalog);
  const checkedSignatures = checkCatalogMatches(catalog, rules);
  const rulesJson = JSON.stringify(rules);
  const table = [pin.table.projectId, pin.table.datasetId, pin.table.tableId].join('.');
  const sql = renderQuery(readFileSync(sqlFile ?? new URL('./ready-discovery-query.sql', import.meta.url), 'utf8'), table);
  const summary = { phase: 'query-prepared', families: families.length, rules: rules.length, checkedSignatures,
    familiesWithoutLogCallRules: families.filter(family => !family.logCallDeclarations).map(family => family.familyId),
    sqlSha256: sha256(sql), rulesSha256: sha256(rulesJson), queryExecuted: false };
  const files = {
    'discovery-rules.json': JSON.stringify(rules, null, 2) + '\n',
    'query.sql': sql,
    'query-parameters.json': JSON.stringify([{ name: 'discovery_rules_json',
      parameterType: { type: 'STRING' }, parameterValue: { value: rulesJson } }], null, 2) + '\n',
    'comparison-plan.json': JSON.stringify({ ...summary, status: 'prepared-awaiting-ingestion', run, sourcePin: pin,
      readyCodeHash: identity.codeHash, readyReaderHash: identity.readerHash,
      generatorSha256: sha256(readFileSync(new URL(import.meta.url))), families,
      executeOnlyAfter: 'Every pinned input row is read (read-complete or ready); retain completed page-chain fingerprints. Strict remains deferred unless separately authorized.',
      queryMode: 'Annotate every transaction, including zero hits; not a production input filter.',
      comparison: [
        'Bind source table, schema, row count and modification time to the completed ingestion.',
        'Dry-run SQL and record estimated bytes before its read-only SELECT job.',
        'Compare all retained log/call candidate and opaque poolId evidence family/transaction pairs; retain distinct instance identities.',
        'Check fixed complete source pages against frozen production discovery, including nonmatching and failed/ancestor-rolled-back calls.',
        'Separate extra signature hits from misses. Neither signature hits nor nominations prove identity or strict admission.',
        'Report registry/startup/address-surface discovery separately; do not claim global Family completeness from log/call SQL.',
        'Leave production input unchanged. A later filtering change needs explicit authorization and coverage verification.'
      ]
    }, null, 2) + '\n',
  };
  for (const [name, contents] of Object.entries(files))
    writeFileSync(output + '/' + name, contents, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(summary));
  return summary;
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url)
  await prepareQuery(process.argv.slice(2));
