// Supplemental evidence for the selector SQL. A receipt action starts each
// row; a transfer or a caller-supplied pool catalog cannot start one.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {id} from '../../listener/node_modules/ethers/lib.esm/index.js';
import {receiptV4Source,v4ReceiptKeyConsensus} from './v4-receipt-bindings.mjs';
import {v4WindowCandidateKeys} from './v4-window-candidate-keys.mjs';
import {renderV2ReceiptComponent} from './v2-receipt-component.mjs';
import {renderV3ReceiptPairProof} from './v3-receipt-pair-proof.mjs';
import {v3LineageReceiptEvidence} from './v3-factory-assets.mjs';

const topics=Object.fromEntries(Object.entries({
 V2:'Swap(address,uint256,uint256,uint256,uint256,address)', V3:'Swap(address,address,int256,int256,uint160,uint128,int24)',
 V3ALT:'Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)',
 V4:'Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)',
 BAL:'Swap(bytes32,address,address,uint256,uint256)', TRANSFER:'Transfer(address,address,uint256)',
}).map(([k,v])=>[k,id(v)]));
const quote=x=>"'"+x+"'";
const manager='0x000000000004444c5dc75cb358380d2e3de08a90';
export async function renderSelectorReceiptLayouts(window,options={}) {
 assert(Object.keys(options).every(k=>['scope','v4SwapCallSource','v4CalldataKeys','v4NativeReceiptKeys'].includes(k)),'unsupported receipt source');
 assert(options.v4CalldataKeys===undefined||typeof options.v4CalldataKeys==='boolean');
 assert(options.v4NativeReceiptKeys===undefined||typeof options.v4NativeReceiptKeys==='boolean');
 assert(!options.v4NativeReceiptKeys||options.v4CalldataKeys,'native receipt evidence requires independent calldata templates');
 assert(!(options.v4CalldataKeys&&options.v4SwapCallSource),'choose one pool currency evidence source');
 const {scope='all'}=options;
 assert(['all','v2','v3','v4'].includes(scope));
 const enabled=k=>scope==='all'||scope===k;
 const {fromBlock:lo,toBlock:hi,firstTime,lastTime}=window;
 assert(Number.isSafeInteger(lo)&&Number.isSafeInteger(hi)&&lo>0&&lo<=hi);
 const ts=s=>{assert(typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(s)&&Number.isFinite(Date.parse(s)));return "TIMESTAMP('"+s+"')";};
 assert(firstTime<=lastTime);
 const v2=enabled('v2')?await renderV2ReceiptComponent(window):null;
 const v3=enabled('v3')?await renderV3ReceiptPairProof(window):null;
 const v4=enabled('v4')?await receiptV4Source():null;
 assert(!(options.v4CalldataKeys||options.v4SwapCallSource)||v4,'call evidence needs a V4-bearing scope');
 let key=options.v4CalldataKeys?await (await import('./v4-raw-call-keys.mjs')).renderV4RawCallKeys(window):
   options.v4SwapCallSource?await v4WindowCandidateKeys(options.v4SwapCallSource,window):null;
 let keyEvidence=quote(options.v4CalldataKeys?'swap+calldata-poolkey-hash':'swap+manager-swap-call-poolkey');
 let sibling=null;
 if(options.v4NativeReceiptKeys){
   const nativeModule=await import('./v4-native-receipt-keys.mjs');
   const native=await nativeModule.renderV4NativeReceiptKeys();
   const input=await nativeModule.renderV4NativeInputKeys();
   const packed=await (await import('./v4-native-packed.mjs')).renderV4NativePacked();
   sibling=await (await import('./v4-sibling-packed.mjs')).renderV4SiblingPacked();
   const pairs=(await import('./v4-transfer-pair-keys.mjs')).renderV4TransferPairKeys();
   key={udf:[key.udf,native.udf,packed.udf].join('\n'),
     ctes:[key.evidenceCtes,native.ctes,input,packed.ctes,sibling.ctes,pairs.ctes,v4ReceiptKeyConsensus()].join(',\n')};
   keyEvidence='k.evidence';
 }
 const joined=sibling?' LEFT JOIN v4_scoped_receipt_keys k ON k.bh=s.bh AND k.th=s.th AND k.manager=s.emitter AND k.poolId=s.poolId':
   key?' LEFT JOIN v4_nominated_keys k ON k.manager=s.emitter AND k.poolId=s.poolId':'';
 const sign="signw(word(s.d,0))=-1";
 const asset=(a,b)=>`IF(${sign},k.${a},k.${b})`;
 // Count alternate swaps before weak transfer matching even in a standard-only export.
 const readTopics={v2:[topics.V2,topics.TRANSFER],v3:[topics.V3,topics.V3ALT,topics.TRANSFER],v4:options.v4NativeReceiptKeys?[topics.V4,topics.TRANSFER]:[topics.V4],all:Object.values(topics)};
 const eventRows={v2:'SELECT * FROM v2_resolved',v3:'SELECT * FROM pair_with_receipt WHERE topic0='+quote(topics.V3),v4:'SELECT * FROM v4',
  all:['SELECT * FROM v2_resolved','SELECT * REPLACE(CAST(NULL AS STRING) AS sourceDirection) FROM pair_with_receipt',
       'SELECT * REPLACE(CAST(NULL AS STRING) AS sourceDirection) FROM v4','SELECT *,CAST(NULL AS STRING) sourceDirection FROM bal'].join(' UNION ALL ')};
 const values={...Object.fromEntries(Object.entries({...topics,VAULT:'0xba12222222228d8ba445958a75a0704d566bf2c8',MANAGER:manager}).map(([k,v])=>[k,quote(v)])),
   lo,hi,start:ts(firstTime),end:ts(lastTime),V3_UDF:v3?.udf,V3_CTES:v3?.ctes,V3_LINEAGE_TAG:quote(v3LineageReceiptEvidence.tag),V4_CTES:v4?.ctes,V2_UDF:v2?.udf,V2_CTES:v2?.ctes,
   KEY_UDF:[key?.udf,sibling?.udf].filter(Boolean).join('\n'),KEY_CTES:key?key.ctes+',':'',
   KEY_JOIN:joined,
   V4_ASSETS:key?`${asset('c0','c1')} tokenIn,${asset('c1','c0')} tokenOut,IF(k.poolId IS NULL,'swap-assets-unresolved',${keyEvidence}) evidence`:
     "CAST(NULL AS STRING) tokenIn,CAST(NULL AS STRING) tokenOut,'swap-assets-unresolved' evidence",
   READ_TOPICS:readTopics[scope].map(quote).join(','),MANAGER_FILTER:scope==='v4'&&!options.v4NativeReceiptKeys?' AND LOWER(l.address)='+quote(manager):'',EVENT_ROWS:eventRows[scope]};
 return readFileSync(new URL('./receipt-layouts.sql',import.meta.url),'utf8')
   .replace(/^-- begin (v2|v3|v4|bal)\n([\s\S]*?)^-- end \1\n/gm,(_,section,body)=>enabled(section)?body:'')
   .replace(/@(\w+)/g,(_,k)=>{assert(values[k]!=null,'missing template value '+k);return values[k];});
}
