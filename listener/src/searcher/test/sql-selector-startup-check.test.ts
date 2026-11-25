import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {sqlSelectorModules} from "../sql-edge-live-producer.js";
import {sqlDirectionId,type SqlPriceEdge} from "../sql-edge-price-index.js";
import {sqlSelectorRepresentatives,planSqlSelectorSamplePrices,assertSqlSelectorSamplePrices,type SqlSelectorSampleResult} from "../sql-selector-startup-check.js";
import {prepareSqlStartupPriceInputs} from "../sql-startup-price-input.js";
import {compileSqlExecutionParamPlan} from "../venues/selector-native-execution-param-plan.js";
import {buildEffectiveMids,effectiveExecutionReceiptHash,exportEffectiveMidReplayState,restoreEffectiveMidReplayState,type EffectiveMidRow} from "../blockscan-effective-mid.js";
import type {TokenEdge} from "../planner/token-graph.js";
import {ADDR} from "../../shared/constants/addresses.js";
const addr=(digit:string)=>"0x"+digit.repeat(40), sha=(d:string)=>"0x"+d.repeat(64);
const src={number:600,generation:100,hash:sha("1")},actors={executor:addr("7"),transactionOrigin:addr("8")};
const a=ADDR.WETH.toLowerCase(),b=addr("d"),pool=addr("3");
function row(at=pool,selector="0x128acb08"):SqlPriceEdge {
  const d=sqlSelectorModules.get(selector)!.definition;
  assert(d.domain==="swap"||d.domain==="protocol");
  const keys=compileSqlExecutionParamPlan(d).recipes.map(({index,requirements})=>({
    index, observed:requirements.filter(r=>r.sources.some(s=>s.kind==="direction-asset")).map(r=>({
      key:r.key,kind:"direction-asset" as const,value:r.key==="descriptor.token0"?a:b})),
    missing:requirements.filter(r=>!r.sources.some(s=>["runtime","edge","fixed","direction-asset"].includes(s.kind))).map(r=>r.key),
  }));
  const edge={chainId:1 as const,selector,poolAddress:at,tokenIn:a,tokenInId:null,tokenOut:b,tokenOutId:null,
    poolId:null,poolNamespace:null,executionParamEvidence:{consensus:"uniform" as const,definitionSha256:createHash("sha256").update(JSON.stringify(d)).digest("hex"),
      txHash:sha("2"),callPath:"0",innerSwapPath:null,recipes:keys}};
  return {...edge,candidateInstanceKey:sqlDirectionId(edge)};
}
test("choose one deterministic uniform row per enabled selector, independent of order or ability to pass",()=>{
  const rows=[row(),row(addr("4")),row(addr("5")),row(addr("9"),"0x022c0d9f")];
  const [small,medium]=[...rows.slice(0,3)].sort((x,y)=>x.candidateInstanceKey.localeCompare(y.candidateInstanceKey));
  const modified=rows.map(x=>x===small?{...x,executionParamEvidence:{consensus:"nonuniform" as const}}:x);
  const expected=[rows[3]!.candidateInstanceKey,medium!.candidateInstanceKey];
  for(const e of [modified,[...modified].reverse()])assert.deepEqual(sqlSelectorRepresentatives(e).map(v=>v.candidateInstanceKey),expected);
});
test("select sample before compilation; unavailable winner never falls back to a different encodable pool",async()=>{
  const rows=[row(),row(addr("4"))].sort((x,y)=>x.candidateInstanceKey.localeCompare(y.candidateInstanceKey));
  const reps=sqlSelectorRepresentatives(rows),{markets}=await prepareSqlStartupPriceInputs({edges:rows,source:src,...actors});
  const chosen=rows[0]!,original=planSqlSelectorSamplePrices(reps,markets);
  assert.equal(original[0]!.edgeId,chosen.candidateInstanceKey);assert(original[0]!.variantIds.length);
  assert(markets.delete(chosen.candidateInstanceKey));assert(markets.size);
  const unavailable=planSqlSelectorSamplePrices(reps,markets);assert.equal(unavailable[0]!.edgeId,chosen.candidateInstanceKey);
  assert.deepEqual(unavailable[0]!.variantIds,[]);
});
test("sample needs producer's fresh exact-direction paid SQL variant; a later unavailable sample preserves results of earlier samples",async()=>{
  const sql=row(),key=sql.candidateInstanceKey,{markets}=await prepareSqlStartupPriceInputs({edges:[sql],source:src,...actors});
  const [sample]=planSqlSelectorSamplePrices(sqlSelectorRepresentatives([sql]),markets);assert(sample);const variantId=sample.variantIds[0]!;
  const edge:TokenEdge={instanceKey:key,canonicalEdgeId:key as TokenEdge["canonicalEdgeId"],adapterId:"fixture",target:pool,slotKind:"swap",
    tokenIn:a,tokenOut:b,edgeKind:"swap",leavesStandingPosition:false,executionVerification:"startup-simulation"};
  const effective=await buildEffectiveMids({pricing:{sourceBlock:src.number,sourceBlockHash:src.hash,generation:src.generation,
    graph:{edges:[edge]},coverage:{resolvedEdgeKeys:[key]},mids:new Map(),pricingStateKeyByEdgeKey:new Map([[key,"pool"]])},
    weth:a,fixedWethInput:100n,maxInputPathHops:4,gasCostWei:null,enumerationSpreadBps:0,control:{},concurrency:1,quote:async q=>{
      const receipt:EffectiveMidRow={edgeId:key,instanceKey:key,tokenIn:a,tokenOut:b,quotedAt:src,status:"quoted",
        amountIn:q.amountIn,amountSpent:q.amountIn,amountOut:2n*q.amountIn,effectiveMid:2,pricingMethod:"startup-simulation"};
      const proof={kind:"startup-simulation" as const,variantId,targetBlock:src.number+1,scriptHash:sha("4"),
        receiptHash:effectiveExecutionReceiptHash(receipt,{amountIn:q.amountIn,path:[]},4,src.number+1,sha("4"),variantId)};
      return {source:src,amountIn:q.amountIn,amountOut:2n*q.amountIn,amountSpent:q.amountIn,pricingMethod:"startup-simulation",executionVerification:proof};
    }});
  assert.equal(effective.rows.get(key)?.status,"quoted");
  assertSqlSelectorSamplePrices([sample],effective,[edge]);
  assert.throws(()=>assertSqlSelectorSamplePrices([sample,sample],effective,[edge]),/duplicate selector/);
  const disk=structuredClone(effective),lineage=structuredClone(exportEffectiveMidReplayState(effective));
  restoreEffectiveMidReplayState(disk,lineage,[edge],a);
  assert.throws(()=>assertSqlSelectorSamplePrices([sample],disk,[edge]),/not issued by the required price producer/);
  const carried={...structuredClone(effective),rows:new Map(structuredClone(effective.rows))};
  carried.rows.set(key,{...carried.rows.get(key)!,carried:true});
  restoreEffectiveMidReplayState(carried,lineage,[edge],a);
  assert.throws(()=>assertSqlSelectorSamplePrices([sample],carried,[edge]),/not fresh/);
  assert.throws(()=>assertSqlSelectorSamplePrices([sample],{...effective,source:{...src,number:src.number+1}},[edge]));
  assert.throws(()=>assertSqlSelectorSamplePrices([sample],{...effective,rows:new Map()},[edge]));
  assert.throws(()=>assertSqlSelectorSamplePrices([sample],effective,[]));
  assert.throws(()=>assertSqlSelectorSamplePrices([{...sample,variantIds:["foreign"]}],effective,[edge]),/variant/);
  for(const extra of [{target:addr("6")},{poolId:"logical:other"},{tokenIn:b,tokenOut:a},{instanceKey:"sibling"}])
    assert.throws(()=>assertSqlSelectorSamplePrices([sample],effective,[{...edge,...extra}]),/graph direction or pool/);
  assert.throws(()=>assertSqlSelectorSamplePrices([sample],effective,[edge,edge]),/graph direction or pool/);
  const outcomes:SqlSelectorSampleResult[]=[],missing={...sample,selector:"0x12345678",edgeId:"missing",variantIds:[]};
  assert.throws(()=>assertSqlSelectorSamplePrices([sample,missing,{...missing,selector:"0x22345678"}],effective,[edge],r=>outcomes.push(r)),/2\/3.*no encodable SQL execution program/);
  assert.deepEqual(outcomes.map(r=>[r.status,r.remainingUnchecked]),[["passed",2],["stopped",1]]);
  assert.throws(()=>assertSqlSelectorSamplePrices([sample],{...effective,referenceWethInput:200n,rows:new Map(effective.rows)},[edge]));
});

test("unreachable input is not an EVM revert; report a revert only on the producer's actual observation",async()=>{
  for(const scenario of ["unreachable","revert","transport"] as const){
    const sqlBase=row(),coords=scenario==="unreachable"?{...sqlBase,tokenIn:b,tokenOut:a}:sqlBase;
    const sql={...coords,candidateInstanceKey:sqlDirectionId(coords)},key=sql.candidateInstanceKey;
    const {markets}=await prepareSqlStartupPriceInputs({edges:[sql],source:src,...actors});
    const samples=planSqlSelectorSamplePrices([sql],markets);assert(samples[0]!.variantIds.length);
    const edge:TokenEdge={instanceKey:key,canonicalEdgeId:key as TokenEdge["canonicalEdgeId"],adapterId:"fixture",target:pool,
      slotKind:"swap",tokenIn:sql.tokenIn,tokenOut:sql.tokenOut,edgeKind:"swap",leavesStandingPosition:false,executionVerification:"startup-simulation"};
    let calls=0;
    const effective=await buildEffectiveMids({pricing:{sourceBlock:src.number,sourceBlockHash:src.hash,generation:src.generation,
      graph:{edges:[edge]},coverage:{resolvedEdgeKeys:[key]},mids:new Map(),pricingStateKeyByEdgeKey:new Map([[key,"pool"]])},
      weth:a,fixedWethInput:100n,maxInputPathHops:4,gasCostWei:null,enumerationSpreadBps:0,control:{},concurrency:1,quote:async()=>{
        calls++;throw Object.assign(Error("failed"),scenario==="revert"?{code:"STARTUP_EXECUTION_REVERT"}:{});
      }});
    assert.throws(()=>assertSqlSelectorSamplePrices(samples,effective,[edge]),scenario==="unreachable"?/not simulated: no funded input path/:
      scenario==="revert"?/EVM revert observed/:/producer status quote-failed/);
    assert.equal(calls,scenario==="unreachable"?0:1);
  }
});
