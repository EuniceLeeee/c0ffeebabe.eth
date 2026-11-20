// A packed currency/fee/spacing and the other currency/hook of a proven
// sibling only nominate a preimage. A different signed pool in this exact
// receipt must independently attest the complete hash. No recursive seeds.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {v4MainnetManager} from './v4-history.mjs';

const listener=new URL('../../listener/',import.meta.url);
const {build}=createRequire(new URL('package.json',listener))('esbuild');
const caps=Object.freeze({bytes:65536,ids:64,packed:256,preimages:2048});
function recover(input,slots,digest,cap){
 if(typeof input!=='string'||input.length<54||input.length>2+2*cap.bytes||input.length%2!==0||
    !input.startsWith('0x')||/[^0-9a-f]/i.test(input.slice(2))||!Array.isArray(slots)||slots.length<2||slots.length>cap.ids)return [];
 const target=new Set(),ids=new Set(),anchors=new Set(),zero='0'.repeat(40),pad='0'.repeat(24),numPad='0'.repeat(58);
 for(const s of slots){
  if(!s||typeof s.poolId!=='string'||s.poolId.length!==66||!/^0x[0-9a-f]{64}$/.test(s.poolId)||ids.has(s.poolId))return [];
  ids.add(s.poolId);
  if(s.preimage===null&&s.c0===null&&s.c1===null){target.add(s.poolId);continue;}
  const q=s.preimage;
  if(typeof q!=='string'||q.length!==320||/[^a-f0-9]/.test(q)||![0,64,256].every(i=>q.startsWith(pad,i))||
     !q.startsWith(numPad,128)||!q.startsWith('0'.repeat(60),192))return [];
  const a=q.slice(24,64),b=q.slice(88,128),fee=parseInt(q.slice(186,192),16),spacing=parseInt(q.slice(252,256),16);
  if(a>=b||s.c0!=='0x'+a||s.c1!=='0x'+b||(fee>1000000&&fee!==0x800000)||spacing<1||spacing>32767||digest(q)!==s.poolId)return [];
  const hook=q.slice(-40);
  // Keep the hook paired with the sibling that supplied this currency.
  for(const x of [a,b])if(x!==zero)anchors.add(x+hook);
 }
 if(!target.size||!anchors.size)return [];
 const hex=input.slice(2).toLowerCase(),windows=new Set(),tested=new Set(),found=new Map();
 for(let i=0;i+52<=hex.length;i+=2){
  if(!hex.startsWith('00',i+46))continue;
  const packed=hex.slice(i,i+52),token=packed.slice(0,40),fee=parseInt(packed.slice(40,46),16),spacing=parseInt(packed.slice(46),16);
  if(token===zero||(fee>1000000&&fee!==0x800000)||spacing<1||spacing>32767||windows.has(packed))continue;
  windows.add(packed);if(windows.size>cap.packed)return [];
  const tail=numPad+packed.slice(40,46)+numPad+packed.slice(46,52)+pad;
  for(const anchor of anchors){
   const other=anchor.slice(0,40);if(other===token)continue;
   const [c0,c1]=other<token?[other,token]:[token,other],preimage=pad+c0+pad+c1+tail+anchor.slice(40);
   if(tested.has(preimage))continue;
   tested.add(preimage);if(tested.size>cap.preimages)return [];
   const poolId=digest(preimage);if(!target.has(poolId))continue;
   if(found.has(poolId))return []; // Two distinct matching preimages are ambiguous.
   found.set(poolId,{poolId,c0:'0x'+c0,c1:'0x'+c1,preimage});
  }
 }
 return Array.from(found.values());
}

async function buildUdf(){
 const result=await build({stdin:{resolveDir:fileURLToPath(listener),contents:`import {keccak_256} from '@noble/hashes/sha3';
 import {hexToBytes,bytesToHex} from '@noble/hashes/utils';const recover=${recover.toString()};
 export const find=(i,s)=>recover(i,s,x=>'0x'+bytesToHex(keccak_256(hexToBytes(x))),${JSON.stringify(caps)});`},
  bundle:true,write:false,format:'iife',globalName:'V4SiblingPacked',platform:'browser',target:'es2020',minify:true,legalComments:'none'});
 return `CREATE TEMP FUNCTION v4SiblingPackedKeys(input STRING, slots ARRAY<STRUCT<poolId STRING,preimage STRING,c0 STRING,c1 STRING>>)
RETURNS ARRAY<STRUCT<poolId STRING,c0 STRING,c1 STRING,preimage STRING>> LANGUAGE js AS r'''
${result.outputFiles[0].text}
return V4SiblingPacked.find(input,slots);
''';`;
}
let cached;
export async function renderV4SiblingPacked(){
 assert.equal(arguments.length,0,'no external source');
 const ctes=`v4_sib_seed AS (
 SELECT manager,poolId,MIN(preimage) preimage,MIN(c0) c0,MIN(c1) c1,
 COUNT(DISTINCT TO_JSON_STRING(STRUCT(preimage,c0,c1)))=1 AND COUNTIF(preimage IS NULL OR c0 IS NULL OR c1 IS NULL)=0 isUnique
 FROM v4_calldata_evidence WHERE manager='${v4MainnetManager}' GROUP BY manager,poolId
), v4_sib_distinct_slots AS (
 SELECT DISTINCT bh,th,emitter AS manager,poolId FROM v4_valid_swaps WHERE emitter='${v4MainnetManager}'
), v4_sib_receipts AS (
 SELECT s.bh,s.th,s.manager,ARRAY_AGG(STRUCT(s.poolId AS poolId,k.preimage AS preimage,k.c0 AS c0,k.c1 AS c1) LIMIT ${caps.ids+1}) slots
 FROM v4_sib_distinct_slots s LEFT JOIN v4_sib_seed k USING(manager,poolId)
 GROUP BY s.bh,s.th,s.manager HAVING COUNT(*) BETWEEN 2 AND ${caps.ids} AND COUNTIF(k.isUnique=FALSE)=0
 AND COUNTIF(k.isUnique=TRUE)>0 AND COUNTIF(k.isUnique IS NULL)>0
), v4_sib_inputs AS (
 SELECT r.bh,r.th,r.manager,r.slots,IF(t.st=1,t.topLevelInput,NULL) calldata FROM v4_sib_receipts r JOIN source_tx t USING(bh,th)
 QUALIFY COUNT(*) OVER(PARTITION BY t.bh,t.th)=1
), v4_sibling_packed_evidence AS (
 SELECT i.bh,i.th,i.manager,k.poolId,k.c0,k.c1,k.preimage FROM v4_sib_inputs i
 CROSS JOIN UNNEST(v4SiblingPackedKeys(i.calldata,i.slots)) k
)`;
 return {udf:await(cached??=buildUdf()),ctes};
}
