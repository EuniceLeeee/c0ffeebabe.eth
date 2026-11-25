import {buildSqlExecutionFrameIndex,resolveSqlExecutionTraceParams} from './selector-execution-param-trace.mjs';

// Receipts/flow own discovery. This pass annotates existing observations only;
// nothing returned by this module can nominate another edge or admit a trade.
export function annotateExecutionParams(rows,frames,plans) {
  if(!rows.some(r=>Object.hasOwn(plans,r.selector)))return rows.map(r=>({...r,paramPayload:null}));
  const index=buildSqlExecutionFrameIndex(frames.map(f=>({...f,input:f.input?.slice(0,10)??'0x',fullInput:f.paramInput??'0x'})));
  return rows.map(edge=>{
    const plan=Object.hasOwn(plans,edge.selector)?plans[edge.selector]:null;
    if(!plan)return {...edge,paramPayload:null};
    const physical={...edge,chainId:1,poolAddress:edge.poolId==null?edge.poolAddress:edge.selectorTarget};
    const recipes=plan.recipes.map(recipe=>{
      const r=resolveSqlExecutionTraceParams({edge:physical,index,recipe});
      // Fixed literals, runtime inputs and existing edge coordinates have
      // canonical owners. Never duplicate them as per-pool historical data.
      // Keep missing obligations explicit without repeating the entire recipe.
      return {index:recipe.index,observed:r.values.filter(v=>['argument','pool-id-tuple','direction-asset'].includes(v.kind)),
        missing:r.unresolved.map(v=>v.key)};
    });
    return {...edge,paramPayload:JSON.stringify({definitionSha256:plan.definitionSha256,recipes})};
  });
}
