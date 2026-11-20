// A contiguous byte sequence can nominate a zero-hook (native, ERC20) key.
// Only a complete preimage match against a signed Manager Swap in that same
// canonical receipt can bind currencies. No router/inner selector is inferred.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {v4MainnetManager} from './v4-history.mjs';

const listener=new URL('../../listener/',import.meta.url);
const {build}=createRequire(new URL('package.json',listener))('esbuild');
const limits=Object.freeze({inputBytes:65536,ids:256,keys:256});

function recover(input,ids,digest,cap){
 if(typeof input!=='string'||input.length<54||input.length>2+2*cap.inputBytes||
    input.length%2!==0||input.slice(0,2)!=='0x'||/[^a-f0-9]/i.test(input.slice(2))||
    !Array.isArray(ids)||!ids.length||ids.length>cap.ids||
    !ids.every(x=>typeof x==='string'&&x.length===66&&/^0x[0-9a-f]{64}$/.test(x)))return [];
 const hex=input.slice(2).toLowerCase(),targets=new Set(ids),seen=new Set(),out=[];
 const zw='0'.repeat(64),za='0'.repeat(40),padding='0'.repeat(58);
 for(let p=0;p+52<=hex.length;p+=2){
  // int24 spacing must be positive and within the Manager's supported range.
  if(hex.slice(p+46,p+48)!=='00')continue;
  const spacing=parseInt(hex.slice(p+48,p+52),16);if(spacing===0||spacing>32767)continue;
  const fee=parseInt(hex.slice(p+40,p+46),16);if(fee>1000000&&fee!==0x800000)continue;
  const currency=hex.slice(p,p+40);if(currency===za)continue;
  const packed=hex.slice(p,p+52);if(seen.has(packed))continue;
  seen.add(packed);if(seen.size>cap.keys)return []; // Reject the whole tx, including any earlier hit.
  const preimage=zw+'0'.repeat(24)+currency+padding+packed.slice(40,46)+padding+packed.slice(46,52)+zw;
  const poolId=digest(preimage);
  if(targets.has(poolId))out.push({poolId,c0:'0x'+za,c1:'0x'+currency,preimage});
 }
 return out;
}

let pending;
async function buildUdf(){
 const res=await build({stdin:{resolveDir:fileURLToPath(listener),contents:
 `import {keccak_256} from '@noble/hashes/sha3';import {hexToBytes,bytesToHex} from '@noble/hashes/utils';
 const recover=${recover.toString()};export const resolve=(input,ids)=>recover(input,ids,
 h=>'0x'+bytesToHex(keccak_256(hexToBytes(h))),${JSON.stringify(limits)});`},
 bundle:true,write:false,platform:'browser',format:'iife',globalName:'V4NativePacked',target:'es2020',minify:true,legalComments:'none'});
 return `CREATE TEMP FUNCTION v4NativePackedKeys(input STRING, ids ARRAY<STRING>)
RETURNS ARRAY<STRUCT<poolId STRING,c0 STRING,c1 STRING,preimage STRING>> LANGUAGE js AS r'''
${res.outputFiles[0].text}
return V4NativePacked.resolve(input,ids);
''';`;
}

export async function renderV4NativePacked(){
 assert.equal(arguments.length,0,'only canonical source transactions and their signed Manager Swaps are supported');
 const ctes=`v4_native_packed_ids AS (
 SELECT bh,th,ARRAY_AGG(DISTINCT poolId LIMIT ${limits.ids+1}) ids FROM v4_native_unresolved_swaps
 WHERE manager='${v4MainnetManager}' GROUP BY bh,th
), v4_native_packed_inputs AS (
 SELECT t.bh,t.th,t.st,t.topLevelInput,r.ids,COUNT(*) OVER(PARTITION BY t.bh,t.th) copies
 FROM source_tx t JOIN v4_native_packed_ids r USING(bh,th)
), v4_native_packed_rows AS (
 SELECT i.bh,i.th,'${v4MainnetManager}' manager,k.poolId,k.c0,k.c1,k.preimage
 FROM v4_native_packed_inputs i CROSS JOIN UNNEST(v4NativePackedKeys(IF(i.copies=1 AND i.st=1,i.topLevelInput,NULL),i.ids)) k
), v4_native_packed_evidence AS (
 SELECT manager,poolId,MIN(c0) c0,MIN(c1) c1,MIN(preimage) preimage
 FROM v4_native_packed_rows AS r GROUP BY manager,poolId HAVING COUNT(DISTINCT r.preimage)=1
)`;
 return {udf:await(pending??=buildUdf()),ctes};
}
