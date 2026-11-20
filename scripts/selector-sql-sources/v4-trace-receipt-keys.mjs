import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {id} from '../../listener/node_modules/ethers/lib.esm/index.js';
import {traceTable} from '../selector-trace-window-sql.mjs';
import {canonicalSwapTopics} from './canonical-swap-census.mjs';
import {v4MainnetManager} from './v4-history.mjs';
import {renderV4RawCallKeys} from './v4-raw-call-keys.mjs';

const unlockSelector=id('unlock(bytes)').slice(0,10);
const swapSelector=id('swap((address,address,uint24,int24,address),(bool,int256,uint160),bytes)').slice(0,10);

export async function renderV4TraceReceiptKeys({window,source,rules}){
  const families=rules.filter(r=>r.callPatterns.some(p=>p.selector===unlockSelector)
    &&r.logPatterns.some(p=>p.topic===canonicalSwapTopics.v4));
  assert.equal(families.length,1,'Expected the declared Manager Swap binding');
  const family=families[0].familyId;
  assert(new RegExp('^execution:'+unlockSelector+':abi-[0-9a-f]{64}$').test(family));
  const projection=`SELECT DISTINCT 'witness' AS row_kind, TO_JSON_STRING(STRUCT(
    1 AS chainId, '${family}' AS familyId, '${unlockSelector}' AS selector, manager AS target, poolId,
    IF(zeroForOne, c0, c1) AS tokenIn, IF(zeroForOne, c1, c0) AS tokenOut,
    'trace-signed-swap-poolkey' AS evidence
  )) AS body FROM v4_trace_receipt_keys`;
  const {udf}=await renderV4RawCallKeys(window);
  const quote=s=>"'"+s+"'";
  const values={
    TRACE_TABLE:traceTable(source),MANAGER:quote(v4MainnetManager),V4:quote(canonicalSwapTopics.v4),
    UNLOCK_SELECTOR:quote(unlockSelector),SWAP_SELECTOR:quote(swapSelector),PROJECTION:projection,
  };
  const query=readFileSync(new URL('./v4-trace-receipt-keys.sql',import.meta.url),'utf8')
    .replace('@V4_VALID_SWAPS',()=>readFileSync(new URL('./v4-valid-swap.sql',import.meta.url),'utf8').trim())
    .replace(/@(\w+)/g,(_,k)=>{assert(Object.hasOwn(values,k));return values[k];});
  return `CREATE TEMP FUNCTION addr(w STRING) AS (IF(REGEXP_CONTAINS(w,r'^0x0{24}[0-9a-f]{40}$'),CONCAT('0x',RIGHT(w,40)),NULL));
CREATE TEMP FUNCTION word(d STRING, i INT64) AS (SUBSTR(d,3+64*i,64));
CREATE TEMP FUNCTION signw(w STRING) AS (CASE WHEN w=REPEAT('0',64) THEN 0 WHEN LEFT(w,1) IN ('8','9','a','b','c','d','e','f') THEN -1 ELSE 1 END);
${udf}
${query}`;
}
