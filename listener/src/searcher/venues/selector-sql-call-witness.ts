import { readySelectorCensusFromTransaction,type ReadySelectorCensusTransaction } from '../ready-selector-census.js';
import type { CanonicalSource } from './adapter-request-program.js';
import type { UnifiedObservation } from './adapter-family-plugin.js';
import type { CanonicalValue } from './canonical-value.js';
import type { SqlLiveEdgeCoordinates } from './selector-native-sql-live-binding.js';

type Locator={txHash:string;callPath:string;signal?:AbortSignal};
export type SqlCallWitnessReader=(input:Locator)=>Promise<ReadySelectorCensusTransaction>;
type WitnessMethod='eth_getTransactionByHash'|'eth_getTransactionReceipt'|'eth_getBlockByNumber';
type WitnessTransport={send:(method:WitnessMethod,params:unknown[],signal?:AbortSignal)=>Promise<unknown>};
const observations=new WeakSet<ReadySelectorCensusTransaction>();
function need(ok:unknown,msg:string):asserts ok {if(!ok)throw Error('SQL observed call: '+msg);}
const obj=(v:unknown):Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const word=/^0x[a-f0-9]{64}$/,address=/^0x[a-f0-9]{40}$/,quantity=/^0x(?:0|[1-9a-f][0-9a-f]*)$/;

/** Trust boundary: observations come from the existing pinned provider, not
 * from SQL. The SQL row supplies only a locator. Root-only, no guessed trace
 * paths, no calls to the nominated contract and no historical amount replay. */
export function createSqlRootCallWitnessReader(rpc:WitnessTransport):SqlCallWitnessReader {
  return async ({txHash,callPath,signal})=>{
    need(word.test(txHash)&&callPath==='','requires a canonical root call; inner frame unavailable');
    const read=async(method:WitnessMethod,params:unknown[])=>{
      signal?.throwIfAborted();
      try{return await rpc.send(method,params,signal);}
      catch{signal?.throwIfAborted();throw Error('SQL observed call: historical RPC unavailable for '+method);}
    };
    const [t,r]=await Promise.all([read('eth_getTransactionByHash',[txHash]),read('eth_getTransactionReceipt',[txHash])]);
    const tx=obj(t),rc=obj(r);
    need(tx.hash===txHash&&rc.transactionHash===txHash&&rc.status==='0x1'&&tx.chainId==='0x1','wrong transaction, chain or failed receipt');
    need(word.test(tx.blockHash)&&quantity.test(tx.blockNumber)&&quantity.test(tx.transactionIndex)&&tx.blockHash===rc.blockHash&&
      tx.blockNumber===rc.blockNumber&&tx.transactionIndex===rc.transactionIndex,'inconsistent inclusion');
    need(address.test(tx.to)&&address.test(tx.from)&&rc.to===tx.to&&rc.from===tx.from&&typeof tx.input==='string'&&
      tx.input.length<=524290&&/^0x[a-f0-9]{8}(?:[a-f0-9]{2})*$/.test(tx.input)&&quantity.test(tx.value),'incomplete root call');
    const n=Number(BigInt(tx.blockNumber)),index=Number(BigInt(tx.transactionIndex));
    need(Number.isSafeInteger(n)&&Number.isSafeInteger(index)&&Array.isArray(rc.logs)&&rc.logs.length<=32768,'invalid receipt');
    let last=-1;
    for(const raw of rc.logs){const l=obj(raw);need(l.transactionHash===txHash&&l.blockHash===tx.blockHash&&l.blockNumber===tx.blockNumber&&
      l.transactionIndex===tx.transactionIndex&&l.removed!==true&&address.test(l.address)&&quantity.test(l.logIndex)&&
      Number.isSafeInteger(Number(BigInt(l.logIndex)))&&Number(BigInt(l.logIndex))>last&&Array.isArray(l.topics)&&l.topics.length<=4&&
      l.topics.every((topic:unknown)=>typeof topic==='string'&&word.test(topic))&&typeof l.data==='string'&&/^0x(?:[a-f0-9]{2})*$/.test(l.data),
      'foreign, removed, malformed or unordered receipt log');last=Number(BigInt(l.logIndex));}
    signal?.throwIfAborted();
    const block=obj(await read('eth_getBlockByNumber',[tx.blockNumber,false]));
    need(block.hash===tx.blockHash&&block.number===tx.blockNumber&&Array.isArray(block.transactions)&&block.transactions[index]===txHash,
      'historical transaction is not canonical at its index');
    const census=readySelectorCensusFromTransaction({from:tx.from,to:tx.to,input:tx.input,value:tx.value,logs:rc.logs,traces:[],
      chainId:1,transactionHash:txHash,transactionIndex:index,blockNumber:n,blockHash:tx.blockHash,status:1});
    signal?.throwIfAborted();observations.add(census);return census;
  };
}
export function sqlHistoricalCallObservation(census:ReadySelectorCensusTransaction,ref:Locator,edge:SqlLiveEdgeCoordinates,source:CanonicalSource):UnifiedObservation {
  const call=census.calls[0];
  need(observations.has(census)&&census.chainId===edge.chainId&&census.receiptStatus===1&&census.transactionHash===ref.txHash&&ref.callPath===''&&
    census.blockNumber!==null&&census.blockHash!==null&&census.blockNumber<=source.number&&(census.blockNumber!==source.number||census.blockHash===source.hash)&&
    census.calls.length===1&&call?.kind==='transaction'&&call.traceAddress?.length===0&&call.executionStatus==='success'&&
    call.target===edge.poolAddress&&call.selector===edge.selector&&call.sender&&call.calldata,'unverified, mismatched or future call');
  return {kind:'call',source,evidenceSource:{number:census.blockNumber,hash:census.blockHash,generation:source.generation},
    target:call.target,sender:call.sender,data:call.calldata,transactionHash:ref.txHash,traceAddress:[],opaque:{selectorCensus:census,callId:call.id} as unknown as CanonicalValue};
}
