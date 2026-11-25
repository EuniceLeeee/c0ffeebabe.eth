import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {build} from '../listener/node_modules/esbuild/lib/main.js';
import {FunctionFragment} from '../listener/node_modules/ethers/lib.esm/index.js';
import {portableCrypto} from './ready-discovery-udf-build.mjs';
import {GENERATED_PRODUCTION_FAMILY_ENTRIES as entries} from '../listener/src/searcher/generated/production-family-entries.generated.ts';

// The same Family ABI decoder is bundled into BigQuery and called at intake.
// SQL owns the successful committed frame; it never exports an amount as a loan limit.
export async function renderSqlFundingSources(table,dir=resolve('listener'),{traceRead}={}){
  assert(/^[a-z][a-z0-9-]+\.[\w]+\.[\w]+$/.test(table));
  if(traceRead!==undefined)assert(typeof traceRead==='string'&&traceRead.startsWith('SELECT tx_hash,')&&!traceRead.includes(';'));
  const defs=entries.map(e=>e.module.selectorFamilyModule)
    .filter(m=>m.activation.enabled&&m.definition.domain==='funding').map(m=>m.definition);
  assert(defs.length&&new Set(defs.map(d=>d.selector)).size===defs.length);
  const rules=defs.map(d=>({selector:d.selector,callback:FunctionFragment.from(d.execution.callback.signature).selector}));
  const src=`import {fundingBindingsFromCall,selectorFundingInstanceKey} from './src/searcher/venues/selector-native-funding-definition.ts';
    import {selectorAssetOfferKey} from './src/searcher/venues/selector-execution-keys.ts';
    const defs=new Map(${JSON.stringify(defs)}.map(d=>[d.selector,d]));
    export function rows(target,input){
      const def=defs.get(input.slice(0,10));if(!def)throw Error('unknown funding selector');
      try {
        const bindings=fundingBindingsFromCall(def,1,{target,calldata:input});
        if(!bindings.length)return [JSON.stringify({failure:'no-funding-asset'})];
        return bindings.map(b=>JSON.stringify({asset:b.asset,
          offerKey:selectorAssetOfferKey(selectorFundingInstanceKey(b),{address:b.asset})}));
      } catch(error){
        // Only the known per-frame ABI/binding rejection is data. An unknown
        // UDF/implementation failure must still fail the query.
        const message=String(error.message);
        const prefix='selector funding: ';
        const rejects=['invalid funding calldata','noncanonical funding callback ABI','truncated funding callback head',
          'invalid funding callback offset','truncated funding callback bytes','invalid funded assets or amounts',
          'invalid provider or duplicate/zero asset','invalid funding asset','invalid funding pool identifier'];
        if(message==='selector execution identity: noncanonical ABI calldata')return [JSON.stringify({failure:'noncanonical ABI calldata'})];
        if(!message.startsWith(prefix)||!rejects.includes(message.slice(prefix.length)))throw error;
        return [JSON.stringify({failure:message.slice(prefix.length)})];
      }
    }`;
  const built=await build({stdin:{contents:src,resolveDir:dir,loader:'ts'},bundle:true,write:false,minify:true,
    globalName:'Funding',platform:'browser',format:'iife',target:'es2020',legalComments:'none',
    plugins:[{name:'portable-sha256',setup(b){b.onResolve({filter:/^node:crypto$/},()=>({path:'hash',namespace:'funding-sha'}));
      b.onLoad({filter:/.*/,namespace:'funding-sha'},()=>({contents:portableCrypto,resolveDir:dir}));}}]});
  const js=built.outputFiles[0].text;assert(!js.includes("'''"));
  return `CREATE TEMP FUNCTION committedFrame(path STRING, failed ARRAY<STRING>) RETURNS BOOL LANGUAGE js AS r'''
if (path==null || failed==null) return false;
// A failed frame (including the root) rolls back every descendant. Test
// complete comma-separated path components, never a lexical "1"/"10" prefix.
return !failed.some(p=>p==null || p==='' || path===p || path.indexOf(p+',')===0);
''';
CREATE TEMP FUNCTION fundingOffers(target STRING, input STRING) RETURNS ARRAY<STRING> LANGUAGE js AS r'''
${js}
return Funding.rows(target,input);
''';
WITH rules AS (SELECT * FROM UNNEST([${rules.map(r=>"STRUCT('"+r.selector+"' AS selector,'"+r.callback+"' AS callback)").join(',')}])),
txs AS (
 SELECT block_number,block_hash,tx_hash,transaction_index,traces,
   ARRAY(SELECT p.trace_address FROM UNNEST(traces) p WHERE p.status IS DISTINCT FROM 1) failed
 FROM ${traceRead===undefined?'\x60'+table+'\x60':'('+traceRead+')'} WHERE receipt_status=1
), calls AS (
 SELECT t.block_number,t.block_hash,t.tx_hash,t.transaction_index,f.trace_address,f.from_address,f.to_address,f.input,SUBSTR(f.input,1,10) sig
 FROM txs t CROSS JOIN UNNEST(t.traces) f
 WHERE f.trace_type='call' AND f.call_type='call' AND f.status=1 AND SUBSTR(f.input,1,10) IN (SELECT selector FROM rules UNION ALL SELECT callback FROM rules)
 AND committedFrame(f.trace_address,t.failed)
), funding AS (
 SELECT f.block_number,f.block_hash,f.tx_hash,f.transaction_index,f.trace_address,f.to_address provider,f.input,r.selector,r.callback
 FROM calls f JOIN rules r ON f.sig=r.selector
), owned_callbacks AS (
 SELECT f.block_hash,f.tx_hash,f.trace_address,c.trace_address callback_path
 FROM funding f JOIN calls c ON c.block_hash=f.block_hash AND c.tx_hash=f.tx_hash
   AND c.from_address=f.provider AND c.sig=f.callback AND c.trace_address!=f.trace_address
   AND (f.trace_address='' OR STARTS_WITH(c.trace_address,CONCAT(f.trace_address,',')))
 QUALIFY ROW_NUMBER() OVER(PARTITION BY c.block_hash,c.tx_hash,c.trace_address ORDER BY LENGTH(f.trace_address) DESC)=1
), frames AS (
 SELECT f.*,c.callback_path FROM funding f LEFT JOIN owned_callbacks c USING(block_hash,tx_hash,trace_address)
 QUALIFY ROW_NUMBER() OVER(PARTITION BY f.block_hash,f.tx_hash,f.trace_address ORDER BY LENGTH(c.callback_path),c.callback_path)=1
), witnessed AS (
 SELECT JSON_VALUE(o,'$.offerKey') offerKey,JSON_VALUE(o,'$.asset') asset,JSON_VALUE(o,'$.failure') failure,provider,selector,callback,
   block_number,block_hash,tx_hash,transaction_index,trace_address,callback_path,input
 FROM frames,UNNEST(IF(callback_path IS NULL,['{"failure":"no-committed-provider-callback"}'],fundingOffers(provider,input))) o
), latest AS (
 SELECT *,COUNT(*) OVER(PARTITION BY offerKey,failure,IF(failure IS NULL,NULL,provider),IF(failure IS NULL,NULL,selector)) observations FROM witnessed
 QUALIFY ROW_NUMBER() OVER(PARTITION BY offerKey,failure,IF(failure IS NULL,NULL,provider),IF(failure IS NULL,NULL,selector)
    ORDER BY block_number DESC,transaction_index DESC,trace_address)=1
)
SELECT IF(failure IS NULL,TO_JSON_STRING(STRUCT(offerKey,asset,provider,selector,callback,block_number,block_hash,tx_hash,
 transaction_index,trace_address,callback_path,input,observations)),
 TO_JSON_STRING(STRUCT(failure,provider,selector,callback,block_number,block_hash,tx_hash,transaction_index,trace_address,callback_path,observations))) body
FROM latest ORDER BY failure,offerKey,provider,selector`;
}
