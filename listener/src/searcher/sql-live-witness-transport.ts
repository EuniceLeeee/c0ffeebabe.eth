import {createBlockScanActivityTransport} from "./blockscan-activity-transport.js";
import type {RethTransportScheduler} from "./reth-transport-scheduler.js";
import {createSqlRootCallWitnessReader} from "./venues/selector-sql-call-witness.js";
import {createSelectorSourceCallWitnessReader} from "./venues/selector-source-call-witness.js";

/** Historical evidence for a nominated sample or selected route only. Lazy:
 * state-bound recipes and bulk price preparation open no extra transport. */
export function sqlLiveWitnessTransport(rpcUrl:string,scheduler:RethTransportScheduler,lifetime:AbortSignal,deadlineAtMs?:number){
  let transport:ReturnType<typeof createBlockScanActivityTransport>|undefined;
  const rpc={send(method:string,params:unknown[],signal?:AbortSignal){
    lifetime.throwIfAborted();signal?.throwIfAborted();
    transport??=createBlockScanActivityTransport(rpcUrl,{scheduler,signal:lifetime});
    return transport.sendWithControl(method,params,{signal:signal??lifetime,deadlineAtMs});
  }};
  const readCallWitness=createSqlRootCallWitnessReader(rpc),readSourceWitness=createSelectorSourceCallWitnessReader(rpc);
  return {readCallWitness,readSourceWitness,close:()=>transport?.destroy()};
}
