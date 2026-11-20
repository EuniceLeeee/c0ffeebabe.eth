// Independent trace experiment: the receipt-only discovery export and comparison
// graph are not inputs. An observed method alone is never a conversion.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {scanDiscoveryPackages} from './ready-discovery-udf-build.mjs';
import {normalizeSelectorNativeExecutionDefinition,selectorNativeFamilyId} from '../listener/src/searcher/venues/selector-native-definition.ts';

export function traceOrdinaryRegistry(root,rules,identity){
  const l=join(root,'listener'),published=new Map(rules.map(r=>[r.familyId,r]));
  const inv=scanDiscoveryPackages(join(l,'src/searcher/generated/family-capability-shadow.generated.json'),l);
  const rows=[];
  for(const r of inv.roots){
    const files=r.additionalSourceFiles.filter(f=>f.endsWith('.json'));assert.equal(files.length,1);
    const raw=JSON.parse(readFileSync(files[0]));
    if(['funding','credit'].includes(raw.domain))continue;
    const d=normalizeSelectorNativeExecutionDefinition(raw);
    if(d.unsupportedReason||!d.programs?.length)continue;
    const familyId=selectorNativeFamilyId(d);assert.equal(familyId,r.familyId);
    assert(published.get(familyId)?.callPatterns.some(p=>p.selector.toLowerCase()===d.selector),'registered executable not in published ABI');
    rows.push({selector:d.selector,familyId,...(identity?{identityKind:identity(raw)}:{})});
  }
  assert(rows.length&&new Set(rows.map(r=>r.familyId)).size===rows.length);return rows.sort((a,b)=>a.familyId.localeCompare(b.familyId));
}
export function traceTable(t){assert(/^[a-z][a-z0-9-]+\.[a-zA-Z_]\w*\.[a-zA-Z_]\w*$/.test(t),'unsafe materialized trace table');return '`'+t+'`';}
export function renderTraceCoverageSql(source){
 return `SELECT COUNT(*) transactions,COUNT(DISTINCT tx_hash) distinctTx,COUNT(DISTINCT block_hash) activeHashes,
 MIN(block_number) firstBlock,MAX(block_number) lastBlock,ARRAY_AGG(block_hash ORDER BY block_number DESC LIMIT 1)[OFFSET(0)] head,
 COUNTIF(NOT trace_rows_present OR ARRAY_LENGTH(traces)=0) missingTraces,SUM(ARRAY_LENGTH(traces)) frames,
 SUM(ARRAY_LENGTH(logs)) logs,SUM(IF(receipt_status=1,1,0)) successfulTx FROM ${traceTable(source)}`;
}
export function renderTraceLedgerSql(table,kind){
  assert.equal(kind,'flow');
  return `SELECT TO_JSON_STRING(STRUCT(
 CAST(JSON_VALUE(edge,'$.chainId') AS INT64) AS chainId,JSON_VALUE(edge,'$.familyId') AS familyId,
 JSON_VALUE(edge,'$.selector') AS familySelector,JSON_VALUE(edge,'$.target') AS poolAddress,JSON_VALUE(edge,'$.poolId') AS poolId,
 JSON_VALUE(edge,'$.poolNamespace') AS poolNamespace,JSON_VALUE(edge,'$.tokenIn') AS tokenIn,JSON_VALUE(edge,'$.tokenOut') AS tokenOut,
 JSON_VALUE(edge,'$.tokenInId') AS tokenInId,JSON_VALUE(edge,'$.tokenOutId') AS tokenOutId,TRUE AS observedTargetSelector)) body
FROM ${traceTable(table)}
WHERE kind='flow' AND JSON_VALUE(edge,'$.tokenIn') IS NOT NULL AND JSON_VALUE(edge,'$.tokenOut') IS NOT NULL
 AND NOT(JSON_VALUE(edge,'$.tokenIn')=JSON_VALUE(edge,'$.tokenOut') AND JSON_VALUE(edge,'$.tokenInId') IS NOT DISTINCT FROM JSON_VALUE(edge,'$.tokenOutId'))`;
}
