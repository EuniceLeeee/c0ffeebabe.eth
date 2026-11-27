// Direct SQL edge decoder from f3f19f425ca63d266af2d3d83eb4776f6b2f0e34.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {poolIdLayouts} from './selector-direct-f3/trace-pool-id.mjs';
import {compileActionReceipts} from './selector-sql-sources/compile-action-receipts.mjs';
import {renderSelectorTraceSourceSql} from './selector-trace-source-sql.mjs';
import {fixedTraceRead} from './selector-trace-store.mjs';
export async function renderDirectSqlEdges(window, {liveSelectorsOnly = false, legacyCoordinates = false, fixedSource, executionParams = !!fixedSource, familyDiscovery = true} = {}, flowConfig, liveSelectorPredicate) {
  const source = fixedSource ? '' : renderSelectorTraceSourceSql({window,materialize:true})+';\n';
  const cte = fixedSource ? 'canonical_trace AS (\n'+fixedTraceRead(window,fixedSource.snapshotAt)+'\n), ' : '';
  const {build}=createRequire(new URL('../listener/package.json',import.meta.url))('esbuild');
  const bundle=await build({entryPoints:[fileURLToPath(new URL('./selector-direct-f3/trace-call-flows.mjs',import.meta.url))],
    bundle:true,platform:'browser',target:'es2020',format:'iife',globalName:'Discovery',minify:true,legalComments:'none',write:false});
  const quoted=values=>values.map(v=>"'"+v+"'").join(',');
  let parameterCode='',parameterFrameType='',parameterFrameInput='',parameterSelect='',parameterReturn='';
  if(executionParams){
    const {compileSqlExecutionParamPlan}=await import('./selector-execution-param-plan.mjs');
    const {enabledConversionDefinitions}=await import('./selector-live-conversions.mjs');
    const {FunctionFragment}=createRequire(new URL('../listener/package.json',import.meta.url))('ethers');
    const plans=Object.fromEntries(enabledConversionDefinitions().map(d=>[d.selector,{...compileSqlExecutionParamPlan(d),
      definitionSha256:createHash('sha256').update(JSON.stringify(d)).digest('hex')}]));
    const methods=new Set(Object.keys(plans));
    for(const p of Object.values(plans))for(const r of p.recipes)for(const field of r.requirements)for(const src of field.sources){
      if(['argument','pool-id-tuple','direction-asset'].includes(src.kind)&&src.signature)methods.add(FunctionFragment.from(src.signature).selector);
    }
    const eligible=methods.size?'LEFT(f.input,10) IN ('+quoted([...methods].sort())+')':'FALSE';
    const paramBundle=await build({entryPoints:[fileURLToPath(new URL('./selector-execution-param-observation.mjs',import.meta.url))],
      bundle:true,platform:'browser',target:'es2020',format:'iife',globalName:'ExecutionParams',minify:true,legalComments:'none',write:false});
    parameterCode=paramBundle.outputFiles[0].text;
    parameterFrameType=', paramInput STRING';
    // Preserve the exact legacy bytes passed to discovery. A separate view can
    // see full declared ABI payloads; oversize/absent data are never zero words.
    parameterFrameInput=',\n      IF('+eligible+' AND LENGTH(f.input)<=131074,f.input,NULL)';
    parameterReturn=', paramPayload STRING';
    // Distinct bindings under one physical direction must not become a lottery
    // decided by example ordering. Field defaults remain owned by the JSON.
    parameterSelect=`\n  CASE WHEN COUNTIF(paramPayload IS NOT NULL)=0 THEN 'not-declared'
    WHEN COUNTIF(paramPayload IS NULL)>0 OR MIN(TO_HEX(SHA256(paramPayload)))!=MAX(TO_HEX(SHA256(paramPayload))) THEN 'nonuniform'
    ELSE 'uniform' END AS paramConsensus,
  IF(COUNTIF(paramPayload IS NULL)=0 AND MIN(TO_HEX(SHA256(paramPayload)))=MAX(TO_HEX(SHA256(paramPayload))),
     ANY_VALUE(paramPayload), NULL) AS executionParams,`;
    // Backslashes/quotes in catalog literals must survive the JS UDF string.
    const wire=JSON.stringify(plans).replaceAll("'",'\\u0027');
    parameterCode+='\nconst paramPlans='+wire+';\n';
  }
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
  const legacyTopics=[...new Set([flowConfig.transferTopic, flowConfig.amountSwapTopic,...poolIdLayouts.map(l=>l.topic),
    ...actionTopics,...layouts.map(r=>r.snapshot?.topic).filter(Boolean)])];
  let topics=quoted(legacyTopics),familyFrameType='',familyFrameInput='',hookDataReturn='',hookDataSelect='',hookDataExample='';
  const cfg=JSON.stringify({...flowConfig,actionReceipts});
  let result=executionParams?'return ExecutionParams.annotateExecutionParams(Discovery.traceCallFlows(frames, logs, '+cfg+'), frames, paramPlans);':'return Discovery.traceCallFlows(frames, logs, '+cfg+');';
  if(familyDiscovery){
    const withHookData=familyDiscovery===true||Number(familyDiscovery)>=2;
    const {familyDiscoveryCatalog}=await import('./selector-family-discovery-sql.mjs');
    const {rules,methods,topics:extra,outputs,modules}=familyDiscoveryCatalog();
    const registered=Object.entries(modules);
    const source=registered.map(([id,path],i)=>'import {discover as d'+i+'} from '+JSON.stringify(path)+';').join('\n')+
      '\nimport {composeFamilyObservations as compose} from "./scripts/selector-family-discovery-compose.mjs";'+
      '\nconst modules={'+registered.map(([id],i)=>JSON.stringify(id)+':d'+i).join(',')+'};'+
      '\nexport const composeFamilyObservations=(old,frames,logs,rules)=>compose(old,frames,logs,rules,modules);';
    const family=await build({stdin:{contents:source,resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'js'},
      bundle:true,platform:'browser',target:'es2020',format:'iife',globalName:'FamilyDiscovery',minify:true,legalComments:'none',write:false});
    familyFrameType=', discoveryInput STRING, discoveryOutput STRING';
    const eligible=methods.length?'LEFT(f.input,10) IN ('+quoted(methods)+')':'FALSE';
    familyFrameInput=',\n      IF('+eligible+' AND LENGTH(f.input)<=131074,f.input,NULL),'+
      '\n      IF('+(outputs.length?'LEFT(f.input,10) IN ('+quoted(outputs)+')':'FALSE')+' AND LENGTH(f.output)=66,f.output,NULL)';
    if(withHookData){
      hookDataReturn=', hookData STRING';
      hookDataSelect='\n  IF(COUNTIF(hookData IS NOT NULL)>0 AND MIN(hookData)=MAX(hookData), MIN(hookData), NULL) AS hookData,';
      hookDataExample='hookData,';
    }
    topics=quoted([...new Set([...legacyTopics,...extra])]);
    const extraOnly=extra.filter(t=>!legacyTopics.includes(t));
    const expr='FamilyDiscovery.composeFamilyObservations(Discovery.traceCallFlows(frames, legacyLogs, '+cfg+'),frames,logs,familyRules)';
    result=family.outputFiles[0].text+'\nconst familyRules='+JSON.stringify(rules).replaceAll("'",'\\u0027')+';\n'+
      'const extraTopics='+JSON.stringify(extraOnly)+'; const legacyLogs=logs.map(l=>extraTopics.includes(l.topics[0])?{...l,topics:[],data:null}:l);\n'+
      (executionParams?'return ExecutionParams.annotateExecutionParams('+expr+', frames, paramPlans);':'return '+expr+';');
  }
  return `${source}CREATE TEMP FUNCTION traceFlows(
  frames ARRAY<STRUCT<path STRING, ok BOOL, kind STRING, sender STRING, target STRING, input STRING, value STRING, output STRING${parameterFrameType}${familyFrameType}>>,
  logs ARRAY<STRUCT<idx FLOAT64, emitter STRING, topics ARRAY<STRING>, data STRING>>
) RETURNS ARRAY<STRUCT<selector STRING, poolAddress STRING, poolId STRING, tokenIn STRING, tokenOut STRING,
  evidence STRING, callPath STRING, receiptIndices STRING, selectorTarget STRING, innerSwapPath STRING,
  amountPoolOutRaw STRING, amountReceivedOutRaw STRING, amountVenueInRaw STRING, amountPayerInRaw STRING,
  conflictingFlow STRUCT<tokenIn STRING,tokenOut STRING,evidence STRING,receiptIndices STRING>${hookDataReturn}${parameterReturn}>>
LANGUAGE js AS r'''
${bundle.outputFiles[0].text}
${parameterCode}${result}
''';

WITH ${cte}${legacyCoordinates ? 'observations' : 'observedCalls'} AS (
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
      IF(LEFT(f.input,10) IN (${outputMethods}),LEFT(f.output,67),NULL)${parameterFrameInput}${familyFrameInput}
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
  TRUE AS observedTargetSelector, FALSE AS verified, COUNT(*) AS observations,${hookDataSelect}${parameterSelect}
  ARRAY_AGG(DISTINCT evidence ORDER BY evidence) AS evidenceTypes,
  ARRAY_AGG(STRUCT(txHash,selectorTarget,${legacyCoordinates ? '' : 'observedPoolAddress,'}callPath,innerSwapPath,${hookDataExample}receiptIndices,evidence,amountPoolOutRaw,amountReceivedOutRaw,amountVenueInRaw,amountPayerInRaw,conflictingFlow)
    ORDER BY conflictingFlow.tokenIn IS NULL,txHash,callPath,receiptIndices LIMIT 1)[OFFSET(0)] AS example
FROM observations${liveSelectorsOnly ? await liveSelectorPredicate() : ''}
GROUP BY selector,poolAddress,poolId,tokenIn,tokenOut
ORDER BY selector,poolAddress,poolId,tokenIn,tokenOut;`;
}
