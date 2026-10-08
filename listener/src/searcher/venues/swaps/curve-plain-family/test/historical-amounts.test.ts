import assert from "node:assert/strict";
import test from "node:test";
import { curveHistoricalAmounts } from "./historical-amounts.js";
const source={number:123,hash:"0x"+"ab".repeat(32),generation:1};
const input={source,pool:"pool",family:"curve-underlying",row:{tokenIn:"in",tokenOut:"out",amountIn:11n}};
const reference=()=>({schemaVersion:1,pool:"pool",scope:{family:"curve-underlying"},inputs:{source},
 headerBefore:source,headerAfter:source,safety:{broadcast:false,signing:false},runtimeConstructionRpcAttempts:0,
 samples:[1,10].map(multiplier=>({tokenIn:"in",tokenOut:"out",multiplier:String(multiplier),amountIn:String(7*multiplier),
 productionP:"7",executions:[{encoding:"runtime-program",status:"failed",evmSucceeded:true,executionChecks:"pass",
 oldInventoryConsumed:"0",balances:{input:{delta:String(-7*multiplier)},output:{delta:String(6*multiplier)}}}]}))});
test("default always uses actual current production P/10P",()=>assert.deepEqual(curveHistoricalAmounts(input),
 [{multiplier:1n,amountIn:11n},{multiplier:10n,amountIn:110n}]));
test("reference preserves old inputs and independent outputs without changing current P",()=>{
 const data=reference();assert.deepEqual(curveHistoricalAmounts({...input,reference:data}),
 [{multiplier:1n,amountIn:7n,priorActualOut:6n},{multiplier:10n,amountIn:70n,priorActualOut:60n}]);assert.equal(input.row.amountIn,11n);
});
test("foreign state, pool or missing pinned final header is rejected",()=>{
 for(const mutate of [(r:any)=>r.pool="other",(r:any)=>r.headerAfter={...source,number:124},
 (r:any)=>delete r.headerBefore,(r:any)=>r.inputs.source={...source,hash:"foreign"}]){
 const r=reference();mutate(r);assert.throws(()=>curveHistoricalAmounts({...input,reference:r}));}
});
test("missing, duplicate, malformed and invented amount points are rejected",()=>{
 for(const mutate of [(r:any)=>r.samples.pop(),(r:any)=>r.samples[1]=r.samples[0],
 (r:any)=>r.samples[0].amountIn="8",(r:any)=>r.samples[0].amountIn="1e18",
 (r:any)=>r.samples[0].tokenOut="foreign"]){
 const r=reference();mutate(r);assert.throws(()=>curveHistoricalAmounts({...input,reference:r}));}
});
test("quote values or failed observations cannot substitute for independently executed output",()=>{
 for(const mutate of [(r:any)=>delete r.samples[0].executions,(r:any)=>r.samples[0].executions[0].evmSucceeded=false,
 (r:any)=>r.samples[0].executions[0].executionChecks="failed",(r:any)=>r.samples[0].executions[0].oldInventoryConsumed="1",
 (r:any)=>r.samples[0].executions[0].balances.input.delta="0",(r:any)=>r.samples[0].executions[0].balances.output.delta="0"]){
 const r=reference();mutate(r);assert.throws(()=>curveHistoricalAmounts({...input,reference:r}));}
});
