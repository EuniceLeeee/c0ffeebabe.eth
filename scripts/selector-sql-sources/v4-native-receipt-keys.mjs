// A Transfer nominates a currency, never a swap, its direction or execution selector.
// The full five-word PoolKey must hash to an independently observed signed Swap.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {v4MainnetManager} from './v4-history.mjs';

const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const native='0x'+'0'.repeat(40);
const listener=new URL('../../listener/',import.meta.url);
const {build}=createRequire(new URL('package.json',listener))('esbuild');
let pending;
async function buildUdf(){
 const compiled=await build({stdin:{resolveDir:fileURLToPath(listener),contents:`import {keccak_256} from '@noble/hashes/sha3';
 import {hexToBytes,bytesToHex} from '@noble/hashes/utils';
 export function id(s){
  if(typeof s!=='string'||s.length!==320||/[^a-f0-9]/.test(s))return null;
  const c0=s.slice(24,64),c1=s.slice(88,128),fee=parseInt(s.slice(186,192),16),spacing=parseInt(s.slice(252,256),16);
  if(![0,64,256].every(i=>s.startsWith('0'.repeat(24),i))||!s.startsWith('0'.repeat(58),128)||
     !s.startsWith('0'.repeat(60),192)||c0>=c1||(fee>1000000&&fee!==0x800000)||spacing<1||spacing>32767)return null;
  return '0x'+bytesToHex(keccak_256(hexToBytes(s)));
 }`},bundle:true,write:false,platform:'browser',format:'iife',globalName:'V4NativePoolKey',target:'es2020',minify:true,legalComments:'none'});
 return `CREATE TEMP FUNCTION v4ReceiptKeyId(image STRING) RETURNS STRING LANGUAGE js AS r'''
${compiled.outputFiles[0].text}
return V4NativePoolKey.id(image);
''';`;
}

export async function renderV4NativeReceiptKeys() {
 assert.equal(arguments.length,0,'native receipt evidence does not accept external sources');
 const ctes=`v4_native_source_keys AS (
 SELECT DISTINCT manager,poolId,preimage FROM v4_calldata_evidence
 WHERE manager='${v4MainnetManager}' AND c0=CONCAT('0x',SUBSTR(preimage,25,40))
 AND c1=CONCAT('0x',SUBSTR(preimage,89,40))
), v4_native_templates AS (
 SELECT DISTINCT SUBSTR(preimage,129) tail FROM v4_native_source_keys WHERE v4ReceiptKeyId(preimage)=poolId
), v4_native_unresolved_swaps AS (
 SELECT DISTINCT s.bh,s.th,s.emitter manager,s.poolId FROM v4_valid_swaps s
 WHERE s.emitter='${v4MainnetManager}' AND REGEXP_CONTAINS(s.poolId,r'^0x[0-9a-f]{64}$')
 AND NOT EXISTS(SELECT 1 FROM v4_calldata_evidence e WHERE e.manager=s.emitter AND e.poolId=s.poolId)
), v4_native_log_slots AS (
 SELECT bh,th,emitter,topic0,topics,d,li,ti,logTi,n,COUNT(*) OVER(PARTITION BY bh,li) slotRows FROM logs
), v4_native_valid_transfers AS (
 SELECT bh,th,emitter c1,addr(LOWER(topics[SAFE_OFFSET(1)])) src,addr(LOWER(topics[SAFE_OFFSET(2)])) dst FROM v4_native_log_slots
 WHERE slotRows=1 AND li>=0 AND ti=logTi AND ti>=0 AND ti<n
 AND topic0='${transfer}' AND ARRAY_LENGTH(topics)=3
 AND REGEXP_CONTAINS(emitter,r'^0x[0-9a-f]{40}$') AND emitter!='${native}'
 AND REGEXP_CONTAINS(d,r'^0x[0-9a-f]{64}$') AND d!='0x${'0'.repeat(64)}'
 AND addr(LOWER(topics[SAFE_OFFSET(1)])) IS NOT NULL AND addr(LOWER(topics[SAFE_OFFSET(2)])) IS NOT NULL
 AND addr(LOWER(topics[SAFE_OFFSET(1)]))!=addr(LOWER(topics[SAFE_OFFSET(2)]))
), v4_native_transfer_tokens AS (
 SELECT DISTINCT bh,th,c1 FROM v4_native_valid_transfers WHERE '${v4MainnetManager}' IN (src,dst)
), v4_native_pool_tokens AS (
 SELECT DISTINCT s.manager,s.poolId,t.c1 FROM v4_native_unresolved_swaps s JOIN v4_native_transfer_tokens t USING(bh,th)
), v4_native_token_images AS (
 SELECT t.c1,CONCAT(REPEAT('0',88),SUBSTR(t.c1,3),p.tail) preimage
 FROM (SELECT DISTINCT c1 FROM v4_native_pool_tokens) t CROSS JOIN v4_native_templates p
), v4_native_hashed AS (
 SELECT c1,preimage,v4ReceiptKeyId(preimage) poolId FROM v4_native_token_images
), v4_native_receipt_evidence AS (
 SELECT s.manager,s.poolId,'${native}' c0,MIN(s.c1) c1,MIN(k.preimage) preimage
 FROM v4_native_pool_tokens s JOIN v4_native_hashed k USING(c1,poolId)
 GROUP BY s.manager,s.poolId HAVING COUNT(DISTINCT k.preimage)=1
)`;
 return {udf:await(pending??=buildUdf()),ctes};
}

// Input bytes only nominate currencies. Reuse an already proven three-word
// tail intact: do not cross-multiply fees, spacings and hooks.
export function renderV4NativeInputKeys() {
 assert.equal(arguments.length,0,'native input evidence does not accept external sources');
 return `v4_input_target_receipts AS (
 SELECT bh,th,ARRAY_AGG(DISTINCT poolId) ids FROM v4_native_unresolved_swaps GROUP BY bh,th
), v4_input_manager_transfers AS (
 SELECT bh,th,ARRAY_AGG(DISTINCT c1) directTokens FROM v4_native_transfer_tokens GROUP BY bh,th
), v4_input_receipts AS (
 SELECT s.ids,t.st,IF(LENGTH(t.topLevelInput) BETWEEN 42 AND 131074 AND MOD(LENGTH(t.topLevelInput),2)=0
 AND REGEXP_CONTAINS(t.topLevelInput,r'^0x[0-9A-Fa-f]+$'),LOWER(t.topLevelInput),NULL) calldata,
 COALESCE(d.directTokens,ARRAY<STRING>[]) directTokens
 FROM v4_input_target_receipts s JOIN source_tx t USING(bh,th) LEFT JOIN v4_input_manager_transfers d USING(bh,th)
 QUALIFY COUNT(*) OVER(PARTITION BY t.bh,t.th)=1
), v4_input_occurrences AS (
 SELECT r.ids,c1 FROM v4_input_receipts r CROSS JOIN UNNEST(ARRAY_CONCAT(r.directTokens,
 ARRAY(SELECT DISTINCT CONCAT('0x',SUBSTR(r.calldata,bytePos,40))
 FROM UNNEST(GENERATE_ARRAY(3,IFNULL(LENGTH(r.calldata)-39,0),2)) bytePos))) c1 WHERE r.st=1
), v4_input_coin_targets AS (
 SELECT o.c1,ARRAY_AGG(DISTINCT id) targets FROM v4_input_occurrences o
 JOIN (SELECT DISTINCT c1 FROM v4_native_valid_transfers) dictionary USING(c1)
 CROSS JOIN UNNEST(o.ids) id GROUP BY o.c1
), v4_input_coins AS (
 SELECT *,COUNT(*) OVER() coinCount FROM v4_input_coin_targets
), v4_input_probes AS (
 SELECT c.c1,c.targets,CONCAT(REPEAT('0',88),SUBSTR(c.c1,3),p.tail) preimage
 FROM v4_input_coins c CROSS JOIN (SELECT tail,COUNT(*) OVER() tailCount FROM v4_native_templates) p
 WHERE IF(SAFE_MULTIPLY(c.coinCount,p.tailCount)<=2000000,TRUE,ERROR('Native input hash budget exceeded'))
), v4_input_matches AS (
 SELECT c1,targets,preimage,v4ReceiptKeyId(preimage) poolId FROM v4_input_probes
), v4_native_input_evidence AS (
 SELECT '${v4MainnetManager}' manager,poolId,'${native}' c0,MIN(c1) c1,MIN(preimage) preimage
 FROM v4_input_matches AS m WHERE poolId IN UNNEST(targets) GROUP BY poolId HAVING COUNT(DISTINCT m.preimage)=1
)`;
}
