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
import {compileSettlementEvidence} from './selector-sql-sources/compile-settlement-evidence.mjs';
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
  const {enabledConversionDefinitions} = await import('./selector-live-conversions.mjs');
  const selectors = enabledConversionDefinitions().map(definition => definition.selector).sort();
  for (const selector of selectors) assert.match(selector, /^0x[0-9a-f]{8}$/);
  return selectors.length ? '\nWHERE selector IN (' + selectors.map(s => "'" + s + "'").join(',') + ')' : '\nWHERE FALSE';
}

export async function renderIndependentTraceEdges(window, options = {}) {
  const {renderDirectSqlEdges} = await import('./selector-direct-f3-sql.mjs');
  return renderDirectSqlEdges(window, options, flowConfig, liveSelectorPredicate);
}

// Research only. No production CLI / live projection selects this renderer.
export async function renderExperimentalTraceEdges(window, {liveSelectorsOnly = false, legacyCoordinates = false, fixedSource} = {}) {
  // Old query bytes are still needed to attest archived receipts offline.
  // A paid invocation always supplies a coverage-checked fixed source.
  let preamble='', canonicalCte='';
  if(fixedSource===undefined)preamble=renderSelectorTraceSourceSql({window,materialize:true})+';\n';
  else {
    assert(typeof fixedSource?.snapshotAt==='string'&&fixedSource.snapshotAt,'fixed trace snapshot required');
    const {fixedTraceRead}=await import('./selector-trace-store.mjs');
    canonicalCte='canonical_trace AS (\n'+fixedTraceRead(window,fixedSource.snapshotAt)+'\n), ';
  }
  const {build}=createRequire(new URL('../listener/package.json',import.meta.url))('esbuild');
  const bundle=await build({entryPoints:[fileURLToPath(new URL('./selector-sql-sources/trace-call-flows.mjs',import.meta.url))],
    bundle:true,platform:'browser',target:'es2020',format:'iife',globalName:'Discovery',minify:true,legalComments:'none',write:false});
  const quoted=values=>values.map(v=>"'"+v+"'").join(',');
  const poolCalls=poolIdLayouts.map(l=>"(f.to_address='"+l.emitter+"' AND LEFT(f.input,10)='"+l.action+"')").join(' OR ');
  const root=fileURLToPath(new URL('../',import.meta.url));
  const actionReceipts=compileActionReceipts(root);
  const {balanceActions,settlementProofs}=compileSettlementEvidence(root);
  const layouts=Object.values(actionReceipts);
  const actionTopics=[...new Set([...layouts.map(r=>r.topic),...Object.values(balanceActions).map(r=>r.topic)])];
  const getters=[...new Set(layouts.flatMap(r=>[...r.assets,r.snapshot?.read]).filter(s=>s?.startsWith('0x')))];
  const addressGetterMethods=quoted([...new Set(layouts.flatMap(r=>r.assets).filter(s=>s.startsWith('0x')))]);
  const readMethods=quoted(getters), actionMethods=quoted(Object.keys(actionReceipts));
  const outputMethods=quoted([...new Set([...getters,
    ...Object.keys(settlementProofs),
    ...Object.keys(actionReceipts).filter(selector=>actionReceipts[selector].transferProof)])]);
  const argIndices=layouts.flatMap(r=>Object.values(r.equals)).flatMap(ref=>/^arg(\d+)/.exec(ref)?.[1] ?? []);
  const actionPrefix=10 + 64*(1+Math.max(-1,...argIndices.map(Number)));
  const balanceInputs=Object.entries(balanceActions).map(([s,r])=>
    "WHEN LEFT(f.input,10)='"+s+"' THEN LEFT(f.input,"+Math.max(10+64*(1+r.recipientArg),actionReceipts[s]?actionPrefix:10)+")").join('\n        ');
  const settlementInputs=[...new Set(Object.values(settlementProofs).map(p=>p.batch?.take).filter(Boolean))]
    .map(s=>"WHEN LEFT(f.input,10)='"+s+"' THEN LEFT(f.input,202)").join('\n        ');
  const topics=quoted([...new Set([flowConfig.transferTopic, flowConfig.amountSwapTopic,...poolIdLayouts.map(l=>l.topic),
    ...actionTopics,...layouts.map(r=>r.snapshot?.topic).filter(Boolean)])]);
  return `${preamble}CREATE TEMP FUNCTION traceFlows(
  frames ARRAY<STRUCT<path STRING, ok BOOL, kind STRING, sender STRING, target STRING, input STRING, value STRING, output STRING>>,
  logs ARRAY<STRUCT<idx FLOAT64, emitter STRING, topics ARRAY<STRING>, data STRING>>
) RETURNS ARRAY<STRUCT<selector STRING, poolAddress STRING, poolId STRING, tokenIn STRING, tokenOut STRING,
  evidence STRING, callPath STRING, receiptIndices STRING, selectorTarget STRING, innerSwapPath STRING,
  amountPoolOutRaw STRING, amountReceivedOutRaw STRING, amountVenueInRaw STRING, amountPayerInRaw STRING,
  conflictingFlow STRUCT<tokenIn STRING,tokenOut STRING,evidence STRING,receiptIndices STRING>>>
LANGUAGE js AS r'''
${bundle.outputFiles[0].text}
return Discovery.traceCallFlows(frames, logs, ${JSON.stringify({...flowConfig,actionReceipts,balanceActions,settlementProofs})});
''';

WITH ${canonicalCte}${legacyCoordinates ? 'observations' : 'observedCalls'} AS (
  SELECT t.tx_hash AS txHash, e.*
  FROM canonical_trace AS t
  CROSS JOIN UNNEST(traceFlows(
    ARRAY(SELECT AS STRUCT f.trace_address, f.status=1, IF(f.trace_type='call',f.call_type,f.trace_type),
      f.from_address, f.to_address,
      CASE WHEN ${poolCalls} THEN f.input
        ${settlementInputs}
        ${balanceInputs}
        WHEN LEFT(f.input,10) IN (${actionMethods}) THEN LEFT(f.input,${actionPrefix})
        WHEN LEFT(f.input,10) IN (${readMethods}) THEN LEFT(f.input,75)
        WHEN LEFT(f.input,10) IN ('0xa9059cbb','0x23b872dd') THEN LEFT(f.input,203)
        WHEN LEFT(f.input,10)='${flowConfig.amountSwapSelector}' THEN LEFT(f.input,202)
        ELSE LEFT(f.input,10) END, f.value,
      CASE WHEN f.input IN (${addressGetterMethods}) AND f.call_type='staticcall'
        AND REGEXP_CONTAINS(f.output,r'^0x0{24}[0-9a-f]{40}(?:00)*$') THEN LEFT(f.output,66)
        WHEN LEFT(f.input,10) IN ('0xa9059cbb','0x23b872dd',${outputMethods}) THEN LEFT(f.output,67)
        ELSE NULL END
      FROM UNNEST(t.traces) f WITH OFFSET AS ord ORDER BY ord),
    ARRAY(SELECT AS STRUCT CAST(l.log_index AS FLOAT64), l.log_address,
        IF(keepBody,l.topics,ARRAY<STRING>[]), IF(keepBody,l.data,NULL)
      FROM UNNEST(t.logs) l
      CROSS JOIN UNNEST([LOWER(l.topics[SAFE_OFFSET(0)]) IN (${topics})]) AS keepBody
      ORDER BY l.log_index)
  )) e WHERE t.receipt_status=1
)${legacyCoordinates ? '' : `, observations AS (
  SELECT o.* REPLACE(IF(poolId IS NULL, poolAddress, selectorTarget) AS poolAddress),
    o.poolAddress AS observedPoolAddress
  FROM observedCalls AS o
)`}
SELECT selector, poolAddress, poolId, tokenIn, tokenOut,${legacyCoordinates ? '' : '\n  IF(MIN(selectorTarget) = MAX(selectorTarget), MIN(selectorTarget), NULL) AS callTarget,'}
  TRUE AS observedTargetSelector, FALSE AS verified, COUNT(*) AS observations,
  ARRAY_AGG(DISTINCT evidence ORDER BY evidence) AS evidenceTypes,
  ARRAY_AGG(STRUCT(txHash,selectorTarget,${legacyCoordinates ? '' : 'observedPoolAddress,'}callPath,innerSwapPath,receiptIndices,evidence,amountPoolOutRaw,amountReceivedOutRaw,amountVenueInRaw,amountPayerInRaw,conflictingFlow)
    ORDER BY conflictingFlow.tokenIn IS NULL,txHash,callPath,receiptIndices LIMIT 1)[OFFSET(0)] AS example
FROM observations${liveSelectorsOnly ? await liveSelectorPredicate() : ''}
GROUP BY selector,poolAddress,poolId,tokenIn,tokenOut
ORDER BY selector,poolAddress,poolId,tokenIn,tokenOut;`;
}

async function main() {
  const {values:v} = parseArgs({options:{window:{type:'string'},out:{type:'string'},'sql-only':{type:'boolean'},
    'live-selectors-only':{type:'boolean',default:false},'snapshot-at':{type:'string'},'max-bytes':{type:'string'}}});
  const window = v.window ? JSON.parse(readFileSync(v.window)) : ready21Window;
  const liveSelectorsOnly = v['live-selectors-only'], asOf=v['snapshot-at'];
  const maximumBytesBilled=v['max-bytes']??String(16*2**30);
  assert(/^[1-9][0-9]{0,18}$/.test(maximumBytesBilled)&&BigInt(maximumBytesBilled)<=9223372036854775807n,'invalid positive --max-bytes ceiling');
  if (v['sql-only']) {
    const fixedSource=asOf===undefined?undefined:{snapshotAt:asOf};
    process.stdout.write(await renderIndependentTraceEdges(window,{liveSelectorsOnly,fixedSource})+'\n');return;
  }
  assert(v.out,'Specify --out <output directory>');
  const dir=resolve(v.out);
  const projectId=process.env.SELECTOR_BQ_PROJECT??'eth-token-480803', location='US';
  assert(/^[a-z][a-z0-9-]+$/.test(projectId));
  const {fixedTraceRead,pinTraceWindow}=await import('./selector-trace-store.mjs');
  if(asOf!==undefined)fixedTraceRead(window,asOf); // reject malformed explicit pins before touching credentials
  const api=googleApi();
  const pinned=await pinTraceWindow(window,{api,asOf,cap:BigInt(maximumBytesBilled)});
  assert(pinned?.snapshotAt&&pinned.coverage,'independent discovery requires proven fixed trace coverage');
  const sql=await renderIndependentTraceEdges(window,{liveSelectorsOnly,fixedSource:pinned});
  mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'query.sql'),sql,{flag:'wx'});
  const jobId='independent_edges_'+sha(sql).slice(0,20)+'_'+Date.now();
  console.error(jobId);
  const query={query:sql,useLegacySql:false,maximumBytesBilled};
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
  const summary={window,sourceSnapshotAt:pinned.snapshotAt,sourceCoverage:pinned.coverage,sourceCoverageJobId:pinned.jobId,jobId,maximumBytesBilled,sqlSha256:sha(sql),edgesSha256:sha(bytes),total,liveSelectorsOnly,
    observations:edges.reduce((count,e)=>count+Number(e.observations),0),
    bytesBilled:job.statistics.query.totalBytesBilled,
    elapsedMs:Number(job.statistics.endTime)-Number(job.statistics.startTime)};
  writeFileSync(join(dir,'manifest.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(summary));
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(e=>{console.error(e.message);process.exitCode=1;});
