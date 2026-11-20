// Optional historical *Swap call* evidence. The caller pins the table to the
// original discovery result (or its byte-verified restore), not a table of key
// pairs. These rows can name a corroborating receipt; they do not create a trade.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {v4MainnetManager} from './v4-history.mjs';

const listener=new URL('../../listener/',import.meta.url);
const {build}=createRequire(new URL('package.json',listener))('esbuild');
function verify(digest,manager,emitter,id,c0,c1,fee,spacing,hooks){
  const addr=x=>typeof x==='string'&&x.length===42&&/^0x[0-9a-f]{40}$/.test(x);
  const uint=x=>typeof x==='string'&&x.length<=8&&/^(?:0|[1-9][0-9]*)$/.test(x)&&!(/[^0-9]/.test(x));
  if(emitter!==manager||typeof id!=='string'||id.length!==66||!/^0x[0-9a-f]{64}$/.test(id)||
    ![c0,c1,hooks].every(addr)||c0>=c1||!uint(fee)||(+fee>1000000&&+fee!==0x800000)||
    !uint(spacing)||+spacing<1||+spacing>32767)return false;
  const addressWord=x=>x.slice(2).padStart(64,'0'),numberWord=x=>Number(x).toString(16).padStart(64,'0');
  return digest(addressWord(c0)+addressWord(c1)+numberWord(fee)+numberWord(spacing)+addressWord(hooks))===id;
}
let udfPromise;
async function buildUdf(){
  const result=await build({stdin:{resolveDir:fileURLToPath(listener),contents:`import {keccak_256} from '@noble/hashes/sha3';
import {hexToBytes,bytesToHex} from '@noble/hashes/utils';const verify=${verify.toString()};
export const check=(...a)=>verify(h=>'0x'+bytesToHex(keccak_256(hexToBytes(h))),'${v4MainnetManager}',...a);`},
    bundle:true,write:false,platform:'browser',format:'iife',globalName:'V4CallKey',target:'es2020',minify:true,legalComments:'none'});
  return `CREATE TEMP FUNCTION v4VerifySwapCallKey(manager STRING,id STRING,c0 STRING,c1 STRING,fee STRING,spacing STRING,hooks STRING)
RETURNS BOOL LANGUAGE js AS r'''
${result.outputFiles[0].text}
return V4CallKey.check(manager,id,c0,c1,fee,spacing,hooks);
''';`;
}
export async function v4WindowCandidateKeys({table,window},target){
  assert(typeof table==='string'&&!/\s/.test(table)&&/^[a-z][a-z0-9-]+\.[A-Za-z_]\w*\.[A-Za-z_]\w*$/.test(table),'invalid witness table');
  const {fromBlock:lo,toBlock:hi,headHash:h,transactions:n}=window;
  assert([lo,hi,target.fromBlock,target.toBlock].every(Number.isSafeInteger)&&0<lo&&lo<=target.fromBlock&&target.fromBlock<=target.toBlock&&target.toBlock<=hi,'invalid or non-covering source window');
  assert(typeof h==='string'&&h.length===66&&/^0x[0-9a-f]{64}$/.test(h)&&typeof n==='string'&&n.length<=19&&!/\D/.test(n)&&/^[1-9]\d*$/.test(n)&&BigInt(n)<=9223372036854775807n);
  if(target.toBlock===hi&&target.headHash!==undefined)assert.equal(target.headHash,h,'source and target head mismatch');
  const tableRef='`'+table+'`';
  const field=k=>"LOWER(JSON_VALUE(body,'$.snapshot."+k+"'))";
  // Original serialized snapshots may wrap bigint fields. Objects which merely
  // contain a "value" but are not that durable bigint encoding do not qualify.
  const numeral=k=>`COALESCE(IF(JSON_VALUE(body,'$.snapshot.${k}."$durableType"')='bigint',JSON_VALUE(body,'$.snapshot.${k}.value'),NULL),JSON_VALUE(body,'$.snapshot.${k}'))`;
  const ctes=`v4_nomination_pin AS (
 SELECT IF(COUNT(*)=1 AND COUNTIF(JSON_VALUE(body,'$.sourceRows')='${n}' AND JSON_VALUE(body,'$.minBlock')='${lo}'
  AND JSON_VALUE(body,'$.firstHead.number')='${hi}' AND JSON_VALUE(body,'$.lastHead.number')='${hi}'
  AND LOWER(JSON_VALUE(body,'$.firstHead.blockHash'))='${h}' AND LOWER(JSON_VALUE(body,'$.lastHead.blockHash'))='${h}')=1,
  TRUE,ERROR('V4 swap-call witness window mismatch')) ok FROM ${tableRef} WHERE row_kind='source'
), v4_nomination_fields AS (
 SELECT ${field('manager')} manager,${field('poolId')} poolId,${field('currency0')} c0,${field('currency1')} c1,
  ${numeral('fee')} fee,${numeral('tickSpacing')} spacing,${field('hooks')} hooks
 FROM ${tableRef} WHERE row_kind='witness' AND JSON_VALUE(body,'$.kind')='candidate'
  AND JSON_VALUE(body,'$.family') IN ('univ4','univ4-fee-hook')
  AND JSON_VALUE(body,'$.snapshot.sourceKind')='manager-swap-call'
  AND SAFE_CAST(JSON_VALUE(body,'$.block') AS INT64) BETWEEN ${lo} AND ${hi}
  AND JSON_VALUE(body,'$.block')=JSON_VALUE(body,'$.snapshot.blockNumber')
  AND REGEXP_CONTAINS(${field('blockHash')},r'^0x[0-9a-f]{64}$') AND REGEXP_CONTAINS(${field('transactionHash')},r'^0x[0-9a-f]{64}$')
), v4_nominated_keys AS (
 SELECT f.manager,f.poolId,MIN(f.c0) c0,MIN(f.c1) c1 FROM v4_nomination_fields f CROSS JOIN v4_nomination_pin
 WHERE ok AND v4VerifySwapCallKey(f.manager,f.poolId,f.c0,f.c1,f.fee,f.spacing,f.hooks)
 GROUP BY f.manager,f.poolId HAVING COUNT(DISTINCT TO_JSON_STRING(STRUCT(f.c0,f.c1,f.fee,f.spacing,f.hooks)))=1
)`;
  return {udf:await (udfPromise??=buildUdf()),ctes};
}
