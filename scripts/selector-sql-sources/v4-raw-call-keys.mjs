// A public outer input may embed a PoolKey with no internal call selector.
// Its bytes nominate assets only; the same receipt must independently attest
// the five-word hash via an actual signed Swap from the official Manager.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {v4MainnetManager} from './v4-history.mjs';

const listener=new URL('../../listener/',import.meta.url);
const {build}=createRequire(new URL('package.json',listener))('esbuild');
const limits=Object.freeze({inputBytes:65536,ids:256,keys:256});
function recover(input,ids,digest,cap) {
  if(typeof input!=='string'||input.length<322||input.length>2+cap.inputBytes*2||
     input.length%2!==0||!/^0x/i.test(input)||/[^0-9a-f]/i.test(input.slice(2))||
     !Array.isArray(ids)||!ids.length||ids.length>cap.ids||
     !ids.every(x=>typeof x==='string'&&x.length===66&&/^0x[0-9a-f]{64}$/.test(x)))return [];
  const target=new Set(ids),seen=new Set(),rows=[],hex=input.slice(2).toLowerCase();
  const pad24='0'.repeat(24),pad58='0'.repeat(58),pad60='0'.repeat(60);
  for(let p=0;p+320<=hex.length;p+=2) {
    // Check high bytes before hashing. This includes offsets not aligned to
    // the outer selector (embedded bytes/nested calldata).
    if(!hex.startsWith(pad24,p)||!hex.startsWith(pad24,p+64)||!hex.startsWith(pad58,p+128)||
       !hex.startsWith(pad60,p+192)||!hex.startsWith(pad24,p+256))continue;
    const spacing=parseInt(hex.slice(p+252,p+256),16);
    if(spacing<1||spacing>32767)continue;
    const fee=parseInt(hex.slice(p+186,p+192),16);
    if(fee>1000000&&fee!==0x800000)continue;
    const c0='0x'+hex.slice(p+24,p+64),c1='0x'+hex.slice(p+88,p+128);
    if(c0>=c1)continue;
    const preimage=hex.slice(p,p+320);
    if(seen.has(preimage))continue;
    seen.add(preimage);
    if(seen.size>cap.keys)return []; // Never promote from a truncated subset.
    const poolId=digest(preimage);
    if(target.has(poolId))rows.push({poolId,c0,c1,preimage});
  }
  return rows;
}
let pendingUdf;
async function createUdf(){
  const result=await build({stdin:{resolveDir:fileURLToPath(listener),contents:
  `import {keccak_256} from '@noble/hashes/sha3';import {hexToBytes,bytesToHex} from '@noble/hashes/utils';
   const recover=${recover.toString()};export const resolve=(input,ids)=>recover(input,ids,h=>'0x'+bytesToHex(keccak_256(hexToBytes(h))),${JSON.stringify(limits)});`},
   bundle:true,write:false,platform:'browser',format:'iife',globalName:'V4CalldataKey',target:'es2020',minify:true,legalComments:'none'});
  return `CREATE TEMP FUNCTION v4CalldataReceiptKeys(input STRING, ids ARRAY<STRING>)
RETURNS ARRAY<STRUCT<poolId STRING,c0 STRING,c1 STRING,preimage STRING>> LANGUAGE js AS r'''
${result.outputFiles[0].text}
return V4CalldataKey.resolve(input,ids);
''';`;
}

// Requires source_tx from canonical headers, and v4_valid_swaps(bh,th,emitter,poolId)
// from the original signed Swap validation (not a raw topic or a pool catalog).
export async function renderV4RawCallKeys(window) {
  assert.equal(arguments.length,1,'no alternate source');
  const {fromBlock:lo,toBlock:hi}=window;
  assert.equal(window.chainId??1,1,'only mainnet Manager');
  assert(Number.isSafeInteger(lo)&&Number.isSafeInteger(hi)&&lo>0&&hi>=lo,'invalid source window');
  const evidenceCtes=`v4_calldata_receipts AS (
 SELECT bh,th,ARRAY_AGG(DISTINCT poolId LIMIT ${limits.ids+1}) ids FROM v4_valid_swaps
 WHERE emitter='${v4MainnetManager}' AND REGEXP_CONTAINS(poolId,r'^0x[0-9a-f]{64}$') GROUP BY bh,th
), v4_calldata_inputs AS (
 SELECT t.bh,t.th,IF(t.st=1,t.topLevelInput,NULL) topLevelInput,r.ids FROM source_tx t JOIN v4_calldata_receipts r USING(bh,th)
 WHERE t.number BETWEEN ${lo} AND ${hi} QUALIFY COUNT(*) OVER(PARTITION BY t.bh,t.th)=1
), v4_calldata_evidence AS (
 SELECT i.bh,i.th,'${v4MainnetManager}' manager,k.poolId,k.c0,k.c1,k.preimage FROM v4_calldata_inputs i
 CROSS JOIN UNNEST(v4CalldataReceiptKeys(i.topLevelInput,i.ids)) k
)`;
  const ctes=evidenceCtes+`, v4_nominated_keys AS (
 SELECT manager,poolId,MIN(c0) c0,MIN(c1) c1 FROM v4_calldata_evidence GROUP BY manager,poolId
 HAVING COUNT(DISTINCT preimage)=1
)`;
  return {udf:await(pendingUdf??=createUdf()),ctes,evidenceCtes};
}
