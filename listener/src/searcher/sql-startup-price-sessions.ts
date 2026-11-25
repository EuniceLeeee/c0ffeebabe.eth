import assert from "node:assert/strict";
import type {RuntimeAmountLeg} from "../adapters/runtime-amount-program.js";
import type {CanonicalSource} from "./venues/adapter-request-program.js";
import type {TokenEdge} from "./planner/token-graph.js";
import type {StartupQuoteLegSession} from "./blockscan-startup-execution-preflight.js";
import {blockScanEdgeKey} from "./venues/blockscan-state-capability.js";

export interface SqlStartupPriceTrials {
  readonly ids:ReadonlySet<string>;
  /** Quotes, not execution authorities. Recompile for this source/executor. */
  atSource(id:string,source:CanonicalSource):{
    readonly tokenIn:string;readonly tokenOut:string;readonly complete:boolean;
    readonly programs:ReadonlyMap<string,RuntimeAmountLeg>;
  };
}

/** The strict provider remains the owner of execution authority. Direct SQL
 * programs are private to the startup simulation and cannot build/send trades. */
export function startupPriceSessions(input:{
  source:CanonicalSource; executor:string; trials?:SqlStartupPriceTrials;
  strict:{prepareQuote(ids:ReadonlySet<string>):Promise<void>;sessionFor(edge:TokenEdge):StartupQuoteLegSession};
}):{prepareQuote(ids:ReadonlySet<string>):Promise<void>; sessionFor(edge:TokenEdge):StartupQuoteLegSession}{
  const {strict,trials}=input;
  if(!trials)return strict;
  const directSessions=new Map<string,StartupQuoteLegSession>();
  return {
    prepareQuote:async(ids)=>{
      const required=new Set([...ids].filter(id=>!trials.ids.has(id)));
      if(required.size)await strict.prepareQuote(required);
    },
    sessionFor:(edge)=>{
      const id=blockScanEdgeKey(edge);
      if(!trials.ids.has(id))return strict.sessionFor(edge);
      const old=directSessions.get(id);if(old)return old;
      const current=trials.atSource(id,input.source);
      assert(edge.tokenIn.toLowerCase()===current.tokenIn&&edge.tokenOut.toLowerCase()===current.tokenOut,"SQL trial graph differs from edge");
      const check=(requested:TokenEdge)=>assert(requested===edge,"SQL price session belongs to another edge");
      const owned=(variantId?:string)=>variantId?current.programs.get(variantId):undefined;
      const result:StartupQuoteLegSession={
        executionVariantIds:(e)=>{check(e);return [...current.programs.keys()];},
        buildRuntimeAmountLeg:(req)=>{
          check(req.edge);assert(req.executor.toLowerCase()===input.executor.toLowerCase()&&!req.runtimeEvidence.length&&!req.settlement,
            "SQL trial leg is for the configured startup simulation only");
          return owned(req.variantId)??null;
        },
        confirmExecutionVariant:(e,variant)=>{
          check(e);assert(owned(variant),"unrecognized SQL price variant");
        },
        hasUnresolvedVariants:(e)=>{check(e);return !current.complete;},
      };
      directSessions.set(id,result);return result;
    },
  };
}
