import {getAddress} from 'ethers';
import {createBlockScanActivityTransport} from './blockscan-activity-transport.js';
import type {RethTransportScheduler} from './reth-transport-scheduler.js';
import type {CanonicalSource} from './venues/adapter-request-program.js';

/** Lazy storage-only view of the existing controlled read transport. No new
 * scheduler or retries; every call uses the same canonical EIP-1898 pin. */
export function createSqlIdentityStorageTransport(rpcUrl:string,scheduler:RethTransportScheduler,source:CanonicalSource,
 lifetime:AbortSignal,deadlineAtMs?:number,createTransport:typeof createBlockScanActivityTransport=createBlockScanActivityTransport){
 if(!/^0x[a-f0-9]{64}$/.test(source.hash))throw Error('identity storage needs a canonical source hash');
 const pin=Object.freeze({blockHash:source.hash,requireCanonical:true});
 let transport:ReturnType<typeof createTransport>|undefined,closed=false;
 const pending=new Set<Promise<string>>();
 function readStorage(address:string,slot:string):Promise<string>{
  lifetime.throwIfAborted();if(closed)throw Error('identity storage transport is closed');
  if(!/^0x[a-f0-9]{64}$/i.test(slot))throw Error('identity storage slot must be bytes32');
  transport??=createTransport(rpcUrl,{scheduler,signal:lifetime});
  const task=transport.sendWithControl('eth_getStorageAt',[getAddress(address).toLowerCase(),slot.toLowerCase(),pin],{signal:lifetime,deadlineAtMs})
   .then(value=>{lifetime.throwIfAborted();if(typeof value!=='string'||!/^0x[a-f0-9]{64}$/i.test(value))throw Error('identity storage response must be bytes32');return value.toLowerCase();});
  pending.add(task);void task.then(()=>pending.delete(task),()=>pending.delete(task));return task;
 }
 async function close(){closed=true;transport?.destroy();await Promise.allSettled([...pending]);}
 return {readStorage,close};
}
