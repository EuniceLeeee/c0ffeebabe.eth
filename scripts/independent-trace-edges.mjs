// Standalone, read-only trace/receipt discovery. No candidate table or Graph input.
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {googleApi,sha} from './selector-query-client.mjs';
import {openReadyDiscoveryJob} from './ready-bigquery-sql.mjs';
import {decodeRow} from './bigquery-table.mjs';
import {renderSelectorTraceSourceSql} from './selector-trace-source-sql.mjs';
import {createRequire} from 'node:module';
import {poolIdLayouts} from './selector-sql-sources/trace-pool-id.mjs';
import {compileActionReceipts} from './selector-sql-sources/compile-action-receipts.mjs';
import {canonicalSwapTopics} from './selector-sql-sources/canonical-swap-decode.mjs';

export const ready21Window = {
  chainId:1, fromBlock:26377878, toBlock:26378389, transactions:'168648',
  firstTime:'2026-11-09T14:17:23.000000Z', lastTime:'2026-11-09T15:59:59.000000Z',
  headHash:'0x62b23cae3b410e09f24910f072a94e2a65b68917a91168dda8648e0d5375c618',
};
export const flowConfig = {
  native:'0x'+'0'.repeat(40),
  amountSwapSelector:'0x022c0d9f',amountSwapTopic:canonicalSwapTopics.v2,
  transferTopic:'0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
};

// Resolve activation at query generation with the same environment as live.
async function liveSelectorPredicate() {
  const {GENERATED_PRODUCTION_FAMILY_ENTRIES} = await import(
    '../listener/src/searcher/generated/production-family-entries.generated.ts');
  const selectors = GENERATED_PRODUCTION_FAMILY_ENTRIES.map(entry => entry.module.selectorFamilyModule)
    .filter(({activation, definition}) => activation.enabled && ['swap', 'protocol'].includes(definition.domain))
    .map(({definition}) => definition.selector).sort();
  for (const selector of selectors) assert.match(selector, /^0x[0-9a-f]{8}$/);
  return selectors.length ? '\nWHERE selector IN (' + selectors.map(s => "'" + s + "'").join(',') + ')' : '\nWHERE FALSE';
}

export async function renderIndependentTraceEdges(window, {liveSelectorsOnly = false} = {}) {
  const source = renderSelectorTraceSourceSql({window,materialize:true});
  const {build}=createRequire(new URL('../listener/package.json',import.meta.url))('esbuild');
  const bundle=await build({entryPoints:[fileURLToPath(new URL('./selector-sql-sources/trace-call-flows.mjs',import.meta.url))],
    bundle:true,platform:'browser',target:'es2020',format:'iife',globalName:'Discovery',minify:true,legalComments:'none',write:false});
  const quoted=values=>values.map(v=>"'"+v+"'").join(',');
  const poolCalls=poolIdLayouts.map(l=>"(f.to_address='"+l.emitter+"' AND LEFT(f.input,10)='"+l.action+"')").join(' OR ');
  const actionReceipts=compileActionReceipts(fileURLToPath(new URL('../',import.meta.url)));
  const layouts=Object.values(actionReceipts);
  const actionTopics=[...new Set(layouts.map(r=>r.topic))];
  const getters=[...new Set(layouts.flatMap(r=>[...r.assets,r.snapshot?.read]).filter(s=>s?.startsWith('0x')))];
  const readMethods=quoted(getters), actionMethods=quoted(Object.keys(actionReceipts));
  const outputMethods=quoted([...new Set([...getters,
    ...Object.keys(actionReceipts).filter(selector=>actionReceipts[selector].transferProof)])]);
  const argIndices=layouts.flatMap(r=>Object.values(r.equals)).flatMap(ref=>/^arg(\d+)/.exec(ref)?.[1] ?? []);
  const actionPrefix=10 + 64*(1+Math.max(-1,...argIndices.map(Number)));
  const topics=quoted([...new Set([flowConfig.transferTopic, flowConfig.amountSwapTopic,...poolIdLayouts.map(l=>l.topic),
    ...actionTopics,...layouts.map(r=>r.snapshot?.topic).filter(Boolean)])]);
  return `${source};
CREATE TEMP FUNCTION traceFlows(
  frames ARRAY<STRUCT<path STRING, ok BOOL, kind STRING, sender STRING, target STRING, input STRING, value STRING, output STRING>>,
  logs ARRAY<STRUCT<idx FLOAT64, emitter STRING, topics ARRAY<STRING>, data STRING>>
) RETURNS ARRAY<STRUCT<selector STRING, poolAddress STRING, poolId STRING, tokenIn STRING, tokenOut STRING,
  evidence STRING, callPath STRING, receiptIndices STRING, selectorTarget STRING, innerSwapPath STRING,
  amountPoolOutRaw STRING, amountReceivedOutRaw STRING, amountVenueInRaw STRING, amountPayerInRaw STRING,
  conflictingFlow STRUCT<tokenIn STRING,tokenOut STRING,evidence STRING,receiptIndices STRING>>>
LANGUAGE js AS r'''
${bundle.outputFiles[0].text}
return Discovery.traceCallFlows(frames, logs, ${JSON.stringify({...flowConfig,actionReceipts})});
''';

WITH observations AS (
  SELECT t.tx_hash AS txHash, e.*
  FROM canonical_trace AS t
  CROSS JOIN UNNEST(traceFlows(
    ARRAY(SELECT AS STRUCT f.trace_address, f.status=1, IF(f.trace_type='call',f.call_type,f.trace_type),
      f.from_address, f.to_address,
      CASE WHEN ${poolCalls} THEN f.input
        WHEN LEFT(f.input,10) IN (${actionMethods}) THEN LEFT(f.input,${actionPrefix})
        WHEN LEFT(f.input,10) IN (${readMethods}) THEN LEFT(f.input,75)
        WHEN LEFT(f.input,10) IN ('0xa9059cbb','0x23b872dd','${flowConfig.amountSwapSelector}') THEN LEFT(f.input,202)
        ELSE LEFT(f.input,10) END, f.value,
      IF(LEFT(f.input,10) IN (${outputMethods}),LEFT(f.output,67),NULL)
      FROM UNNEST(t.traces) f WITH OFFSET AS ord ORDER BY ord),
    ARRAY(SELECT AS STRUCT CAST(l.log_index AS FLOAT64), l.log_address,
        IF(keepBody,l.topics,ARRAY<STRING>[]), IF(keepBody,l.data,NULL)
      FROM UNNEST(t.logs) l
      CROSS JOIN UNNEST([LOWER(l.topics[SAFE_OFFSET(0)]) IN (${topics})]) AS keepBody
      ORDER BY l.log_index)
  )) e WHERE t.receipt_status=1
)
SELECT selector, poolAddress, poolId, tokenIn, tokenOut,
  TRUE AS observedTargetSelector, FALSE AS verified, COUNT(*) AS observations,
  ARRAY_AGG(DISTINCT evidence ORDER BY evidence) AS evidenceTypes,
  ARRAY_AGG(STRUCT(txHash,selectorTarget,callPath,innerSwapPath,receiptIndices,evidence,amountPoolOutRaw,amountReceivedOutRaw,amountVenueInRaw,amountPayerInRaw,conflictingFlow)
    ORDER BY conflictingFlow.tokenIn IS NULL,txHash,callPath,receiptIndices LIMIT 1)[OFFSET(0)] AS example
FROM observations${liveSelectorsOnly ? await liveSelectorPredicate() : ''}
GROUP BY selector,poolAddress,poolId,tokenIn,tokenOut
ORDER BY selector,poolAddress,poolId,tokenIn,tokenOut;`;
}

async function main() {
  const {values:v} = parseArgs({options:{window:{type:'string'},out:{type:'string'},'sql-only':{type:'boolean'},
    'live-selectors-only':{type:'boolean',default:false}}});
  const window = v.window ? JSON.parse(readFileSync(v.window)) : ready21Window;
  const liveSelectorsOnly = v['live-selectors-only'];
  const sql = await renderIndependentTraceEdges(window, {liveSelectorsOnly});
  if (v['sql-only']) { process.stdout.write(sql+'\n'); return; }
  assert(v.out,'Specify --out <output directory>');
  const dir=resolve(v.out);
  mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'query.sql'),sql,{flag:'wx'});
  const projectId=process.env.SELECTOR_BQ_PROJECT??'eth-token-480803', location='US';
  assert(/^[a-z][a-z0-9-]+$/.test(projectId));
  const jobId='independent_edges_'+sha(sql).slice(0,20)+'_'+Date.now();
  console.error(jobId);
  const api=googleApi();
  const query={query:sql,useLegacySql:false,maximumBytesBilled:String(16*2**30)};
  const read=await openReadyDiscoveryJob(api,{projectId},{location,query,jobId},[],{waitForCompletion:true});
  const edges=[];
  let token,total;
  do {
    const page=await read(4000,token);
    total??=Number(page.totalRows);
    assert.equal(Number(page.totalRows),total);
    for (const row of page.rows??[]) edges.push(decodeRow(page.schema.fields,row));
    token=page.pageToken;
  } while(token);
  assert.equal(edges.length,total);
  const job=await api('https://bigquery.googleapis.com/bigquery/v2/projects/'+projectId+'/jobs/'+jobId+'?location=US');
  assert.equal(job.status.state,'DONE');
  assert(!job.status.errorResult);
  const bytes=JSON.stringify(edges,null,2)+'\n';
  writeFileSync(join(dir,'edges.json'),bytes,{flag:'wx'});
  const summary={window,jobId,sqlSha256:sha(sql),edgesSha256:sha(bytes),total,liveSelectorsOnly,
    observations:edges.reduce((count,e)=>count+Number(e.observations),0),
    bytesBilled:job.statistics.query.totalBytesBilled,
    elapsedMs:Number(job.statistics.endTime)-Number(job.statistics.startTime)};
  writeFileSync(join(dir,'manifest.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(summary));
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(e=>{console.error(e.message);process.exitCode=1;});
