import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/aqua-swapvm.production.js";
import { ABI, AQUA, CODE_HASH, AQUA_TRAITS, binding, orderHash, profile, takerData, encodeOrder, stateRequests, decodeState } from "../codec.js";
import { exactProgram } from "../exact.js";
import { SHIP, SWAP, decodeSwapLog } from "../discovery.js";
import { createBlockScanSimAmountSelector } from "../../../../simulator/blockscan-sim-amount-selector.js";
import { RuntimeAmountProgram } from "../../../../../adapters/runtime-amount-program.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import type { Candidate, Descriptor, Evidence, Route } from "../types.js";
const fixture=JSON.parse(readFileSync(new URL("./historical-fixtures.json",import.meta.url),"utf8"));
const E="0xd1e500860893b64ba12b7b6afddb131b5c75a657",O="0xb8578b6de173c8554ff0390db5a7effa567dda3c";
const sample=fixture.samples[0],SOURCE:CanonicalSource={number:sample.blockNumber,hash:sample.blockHash,generation:1};
const b=binding(sample.app,sample.order,sample.tokens);
const returned=(id:string,data:string,source=SOURCE):AdapterRequestResult=>({id,ok:true,source,completion:"returned",data});
function answer(r:AdapterRequest):AdapterRequestResult{
 if(r.kind==="get-code")return returned(r.id,r.id==="router-code"?fixture.routerRuntimeCode:"0x6000");
 assert.equal(r.kind,"eth-call");if(r.kind!=="eth-call")throw Error("fixture transport");
 const p=ABI.parseTransaction({data:r.data})!;
 if(p.name==="AQUA")return returned(r.id,ABI.encodeFunctionResult(p.name,[AQUA]));
 if(p.name==="hash")return returned(r.id,ABI.encodeFunctionResult(p.name,[b.strategyHash]));
 const index=Number(r.id.split(":")[1]);
 if(p.name==="quote")return returned(r.id,ABI.encodeFunctionResult(p.name,[p.args.amount,97n,b.strategyHash]));
 const field=({rawBalances:"raw",balanceOf:"balance",allowance:"allowance",decimals:"decimals"} as Record<string,string>)[p.name];
 return returned(r.id,ABI.encodeFunctionResult(p.name,sample.states[index][field].values));
}
function descriptor(change=(r:AdapterRequestResult)=>r):Descriptor{
 const candidate:Candidate={candidateKind:"aqua-registered-strategy",...b},v=plugin.identity.variants[0];let evidence:unknown;
 for(let step=0;step<3;step++){
  const i={candidate,evidence,step},decision=v.decide(i);
  if(decision.status==="verified"){const draft=plugin.instance.compileDraft(decision.identity);return plugin.instance.finalizeDescriptor({draft,sharedBindings:[]}) as Descriptor;}
  assert.equal(decision.status,"continue");evidence=v.decode({step:i,results:v.buildRequests(i).map(answer).map(change)});
 }
 throw Error("missing verified identity");
}
const input=(d:Descriptor,r:Route,n=91n)=>({descriptor:d,route:r,amountIn:n,source:SOURCE,executor:E,transactionOrigin:O,runtimeEvidence:[]});
test("deployed v1 profile, actual registered order hash and pair reverse identity",()=>{
 assert.equal(ethers.keccak256(fixture.routerRuntimeCode),CODE_HASH);
 for(const s of fixture.samples){const x=binding(s.app,s.order,s.tokens);assert.equal(x.strategyHash,s.strategyHash);assert(profile(x.order));}
 const d=descriptor();assert.equal(plugin.routes.project({descriptor:d}).length,2);
 const wrong="0x"+"1".repeat(64);
 assert.throws(()=>descriptor(r=>r.id==="hash"?returned(r.id,ABI.encodeFunctionResult("hash",[wrong])):r),/mismatch/);
 assert.throws(()=>descriptor(r=>r.id==="aqua"?returned(r.id,ABI.encodeFunctionResult("AQUA",[E])):r),/mismatch/);
 assert.throws(()=>descriptor(r=>r.id==="raw:0"?returned(r.id,ABI.encodeFunctionResult("rawBalances",[9n,0n])):r),/retryable/);
 assert.throws(()=>descriptor(r=>r.id==="decimals:0"?returned(r.id,ABI.encodeFunctionResult("decimals",[78n])):r),/metadata/);
 assert.throws(()=>descriptor(r=>r.id==="hash"?{...r,source:{...SOURCE,number:SOURCE.number+1}}:r),/source/);
 const c={candidateKind:"aqua-registered-strategy" as const,...b},v=plugin.identity.variants[0],i={candidate:c,step:0};
 const evidence=v.decode({step:i,results:[returned("router-code","0x6000")]});assert.equal(v.decide({...i,evidence}).status,"chain-proven-rejected");
 assert.throws(()=>v.decode({step:i,results:[{id:"router-code",ok:false,source:SOURCE,failure:"transport"}]}));
});
test("strategy support is explicit: hooks, signatures, origin guards and unknown programs are not admitted",()=>{
 assert.equal(profile({...b.order,traits:"0"}),null);
 assert.equal(profile({...b.order,traits:(AQUA_TRAITS|(1n<<252n)).toString()}),null);
 assert.equal(profile({...b.order,data:"0x2114"+E.slice(2)+b.order.data.slice(2)}),null);
 assert.equal(profile({...b.order,data:b.order.data+"1100"}),null);
 const other=binding(b.router,{...b.order,data:b.order.data.slice(0,-2)+"ab"},b.tokens);
 assert.notEqual(other.strategyHash,b.strategyHash);assert(profile(other.order));
 const d=descriptor(),r=plugin.routes.project({descriptor:d})[0];
 const graph=plugin.routes.projectGraph({descriptor:d,route:r});assert.equal((graph.venueIdentity as any).strategyHash,b.strategyHash);
 assert.throws(()=>plugin.routes.project({descriptor:{...d,strategyHash:other.strategyHash}}),/descriptor/);
});
test("canonical real registration/call discovery and receipt-bound successful trace nomination",async()=>{
 const s=fixture.samples[0],o={kind:"call" as const,source:SOURCE,target:AQUA,sender:s.order.maker,data:s.shipInput,transactionHash:s.transactionHash};
 assert.deepEqual(plugin.discovery.decodeCandidate({observation:o,matchedPatternId:SHIP}),{candidateKind:"aqua-registered-strategy",...b});
 assert.equal(plugin.discovery.decodeCandidate({observation:{...o,data:o.data+"00"},matchedPatternId:SHIP}),null);
 const swapped=ABI.encodeFunctionData("swap",[b.order,b.tokens[0],b.tokens[1],91n,takerData(1n)]);
 assert.deepEqual(plugin.discovery.decodeCandidate({observation:{...o,target:b.router,sender:E,data:swapped},matchedPatternId:SWAP}),{candidateKind:"aqua-registered-strategy",...b});
 const event={address:AQUA,...ABI.encodeEventLog(ABI.getEvent("Shipped")!,[b.order.maker,b.router,b.strategyHash,encodeOrder(b.order)])};
 let trace:any={type:"CALL",to:AQUA,from:b.order.maker,input:s.shipInput};
 const provider={async getTransactionReceipt(){return{blockNumber:SOURCE.number,logs:[event]};},async traceTransaction(){return trace;}} as never;
 const nominations=[{address:b.router,opaque:{transactionHash:s.transactionHash,blockNumber:SOURCE.number}}];
 assert.equal((await plugin.discovery.nominate!.nominate({nominations,source:SOURCE,provider})).length,1);
 trace={type:"CALL",error:"execution reverted",calls:[trace]};
 assert.equal((await plugin.discovery.nominate!.nominate({nominations,source:SOURCE,provider})).length,0);
 assert.equal((await plugin.discovery.nominate!.nominate({nominations:[{...nominations[0],opaque:{transactionHash:s.transactionHash,blockNumber:SOURCE.number-1}}],source:SOURCE,provider})).length,0);
});
test("Exact preserves requested input, checks returned hash/full input/capacity and binds actor/source",()=>{
 const d=descriptor();
 for(const r of plugin.routes.project({descriptor:d}))for(const n of [1n,91n,5575843886952894314n,11151687773905788628n]){
  const i=input(d,r,n),rs=exactProgram.buildRequests(i).map(answer),q=exactProgram.decode({programInput:i,initialResults:rs,dependentEvidence:[]});
  assert.equal(q.evidence.amountIn,n);assert.equal(q.amountOut,97n);
  const req=exactProgram.buildRequests(i).find(x=>x.id==="quote")!;assert(req.kind==="eth-call");assert.deepEqual(req.caller,{kind:"executor"});
  assert.equal(ABI.decodeFunctionData("quote",req.data).amount,n);
  for(const values of [[n-1n,97n,b.strategyHash],[n,0n,b.strategyHash],[n,97n,"0x"+"2".repeat(64)]])
   assert.throws(()=>exactProgram.decode({programInput:i,initialResults:rs.map(x=>x.id==="quote"?returned(x.id,ABI.encodeFunctionResult("quote",values)):x),dependentEvidence:[]}));
  const fragment=plugin.execution.buildFragment({...i,quotedAmountOut:q.amountOut,minAmountOut:97n,exactEvidence:q.evidence});assert.equal(fragment.nodes?.length,1);
  assert.throws(()=>plugin.execution.buildFragment({...i,quotedAmountOut:97n,minAmountOut:97n,exactEvidence:{...q.evidence,transactionOrigin:E}}),/evidence/);
 }
 const r=plugin.routes.project({descriptor:d})[0];assert.deepEqual(exactProgram.buildRequests(input(d,r,0n)),[]);assert.throws(()=>exactProgram.buildRequests(input(d,r,-1n)));
});
test("quoted and actual-input programs require exact debit/receipt, clear approval, protect old balances and reject zero",()=>{
 const d=descriptor();
 for(const r of plugin.routes.project({descriptor:d})){
  const i=input(d,r),e:Evidence={kind:"aqua-swapvm-quote",source:SOURCE,executor:E,transactionOrigin:O,binding:r.bindingRef.fingerprint,routeKey:r.routeKey,amountIn:91n,amountOut:97n};
  const f=plugin.execution.buildFragment({...i,quotedAmountOut:97n,minAmountOut:97n,exactEvidence:e});
  const script=plugin.actionAdapters[0].encode(f.nodes![0],E,new Uint8Array()),quoted=ethers.hexlify(script.slice(36));
  const runtime=plugin.execution.buildRuntimeLeg!(i)!.program;
  function run(program:string,n:bigint,opts:{debit?:bigint;credit?:bigint;reported?:bigint;hash?:string;native?:bigint;clear?:boolean}={}){
   let swapped=false,allowance=0n;const debit=opts.debit??n,credit=opts.credit??97n;
   const x=inspectRuntime(program,n,{nativeBalance:()=>17n+(swapped?(opts.native??0n):0n),call:c=>{
    const a=ABI.parseTransaction({data:c.data})!;
    if(a.name==="balanceOf"){assert.equal(a.args[0].toLowerCase(),E);const incoming=c.target.toLowerCase()===r.tokenIn;return ABI.encodeFunctionResult(a.name,[incoming?101n+n-(swapped?debit:0n):103n+(swapped?credit:0n)]);}
    if(a.name==="approve"){assert.equal(a.args[0].toLowerCase(),d.router);if(!swapped||opts.clear!==false)allowance=a.args[1];return ABI.encodeFunctionResult(a.name,[true]);}
    if(a.name==="allowance")return ABI.encodeFunctionResult(a.name,[allowance]);
    assert.equal(a.name,"swap");assert.equal(a.args.amount,n);assert.equal(a.args.tokenIn.toLowerCase(),r.tokenIn);assert.equal(a.args.tokenOut.toLowerCase(),r.tokenOut);
    assert.equal(orderHash({maker:a.args[0].maker,traits:a.args[0].traits.toString(),data:a.args[0].data}),d.strategyHash);
    const td=ethers.getBytes(a.args.takerTraitsAndData);assert.equal(BigInt(ethers.hexlify(td.slice(0,22)))&65535n,0x61n);assert.equal(allowance,n);
    swapped=true;return ABI.encodeFunctionResult("swap",[n,opts.reported??credit,opts.hash??d.strategyHash]);
   }});assert.equal(x.registers[0],n);assert.equal(allowance,0n);return x;
  }
  run(quoted,91n);run(runtime,108n);
  for(const p of [quoted,runtime]){
   assert.throws(()=>run(p,0n));for(const debit of [0n,90n,92n])assert.throws(()=>run(p,91n,{debit}));
   for(const opts of [{credit:0n},{reported:98n},{hash:"0x"+"2".repeat(64)},{native:1n},{clear:false}])assert.throws(()=>run(p,91n,opts));
  }
  assert.throws(()=>run(quoted,91n,{credit:96n}));
 }
});
test("raw pricing uses chain points, handles mutable maker capacity, and keeps failed prices withdrawn",()=>{
 const d=descriptor(),routes=plugin.routes.project({descriptor:d}),i={descriptor:d,routes,source:SOURCE};
 const initial=plugin.pricing.current.buildRequests(i).map(answer),round=plugin.pricing.current.buildDependentProgram!({current:i,completedRound:0,initialResults:initial,priorEvidence:[]})!;
 const results=round.requests.map(answer),decode=(rs:readonly AdapterRequestResult[])=>plugin.pricing.current.decodeSnapshot({descriptor:d,initialResults:initial,dependentEvidence:[round.decode(rs)]});
 const snapshot=decode(results);assert.equal(plugin.pricing.current.deriveMids({descriptor:d,routes,snapshot}).size,2);assert.equal(plugin.pricing.refreshPolicy,"each-block");
 const rejected=decode(results.map(x=>x.id==="point:0"?{id:x.id,ok:true,source:SOURCE,completion:"reverted-as-declared",data:"0xdeadbeef"}:x));
 assert.equal(plugin.pricing.current.deriveMids({descriptor:d,routes,snapshot:rejected}).size,1);
 assert.equal(plugin.pricing.current.classifyUnavailable!({descriptor:d,routes,snapshot:rejected}).size,1);
 const noAllowance=initial.map(x=>x.id==="allowance:1"?returned(x.id,ABI.encodeFunctionResult("allowance",[0n])):x);
 assert.equal(decodeState(d,noAllowance).capacities[1],0n);
 assert.throws(()=>decode(results.map(x=>({...x,source:{...SOURCE,generation:2}}))),/source/);
 const actor={kind:"log" as const,source:SOURCE,address:d.tokens[1],topics:[],data:"0x"};
 assert.deepEqual(plugin.pricing.mutation!.affectedStateKeys({descriptor:d,routes,observation:actor}),[d.instanceKey]);
 assert.deepEqual(plugin.pricing.mutation!.affectedStateKeys({descriptor:d,routes,observation:{...actor,address:E}}),[]);
});

test("production sim amount selector builds Aqua from actual receipts with zero Exact and zero quoted fallback",async()=>{
 const d=descriptor();
 for(const route of plugin.routes.project({descriptor:d})){
  const build=()=>plugin.execution.buildRuntimeLeg!(input(d,route))!;
  const edges:any[]=[{adapterId:"aqua-test-leg",target:d.router,tokenIn:route.tokenIn,tokenOut:route.tokenOut},
   {adapterId:"fixture-return",target:E,tokenIn:route.tokenOut,tokenOut:route.tokenIn}];
  let exact=0,quoted=0,simulated=0;const events:any[]=[];
  const session:any={source:SOURCE,fundingActionIds:()=>["verified-fixture-funding"],
   buildRuntimeAmountLeg({edge}:any){return edge===edges[0]?build():{actionAdapterId:"fixture-return",program:ethers.hexlify(new RuntimeAmountProgram().constant(1,1n).bytes())};},
   issueExact(){exact++;throw Error("unexpected Exact");},buildExecution(){quoted++;throw Error("quoted fallback");},
   buildFundingRoot(i:any){return{adapterId:"fixture",target:E,tokenIn:route.tokenIn,tokenOut:route.tokenIn,amount:i.amount,params:{},children:i.children};}};
  const selector=createBlockScanSimAmountSelector({source:SOURCE,executor:E,record:e=>events.push(e),async simulate(plan){
   simulated++;const flow=plan.root.children[0]!;assert.equal(flow.adapterId,"runtime-amount-flow");
   assert.equal(JSON.parse(flow.params.legs as string)[0].program,build().program);
   return{success:true,netProfit:1n,grossProfit:1n,gasUsed:1n,profitToken:route.tokenIn,calldata:"0x"};}});
  await selector.solve({opportunity:{kind:"block-scan-arb",searchSeed:{searchCenter:10n},flashToken:route.tokenIn,profitToken:route.tokenIn},
   tokenPath:{edges},maxFlashAmount:10000n,templateName:"aqua-construction-contract"} as any,
   {call(){throw Error("unexpected RPC");}} as any,{executor:E} as any,
   {strictSession:session,deferPhase2Sim:true,gssMaxTries:2,deadlineAtMs:Date.now()+10000});
  assert.equal(exact,0);assert.equal(quoted,0);assert(simulated>=4);
  assert(events.filter(e=>e.type==="sim_amount_construction").every(e=>e.mode==="runtime-actual"));
 }
});

import { assertChainQuoteRevert } from "./evidence.js";
test("historical boundaries cannot label transport, decode or unresolved quote failures as state rejection",()=>{
 assertChainQuoteRevert({id:"q",source:SOURCE,ok:true,completion:"reverted-as-declared",data:"0xdeadbeef"});
 assert.throws(()=>assertChainQuoteRevert({id:"q",source:SOURCE,ok:false,failure:"transport"}));
 assert.throws(()=>assertChainQuoteRevert({id:"q",source:SOURCE,ok:true,completion:"returned",data:"0xdeadbeef"}));
 assert.throws(()=>assertChainQuoteRevert({id:"q",source:SOURCE,ok:true,completion:"reverted-as-declared",data:"0x"}));
});

test("RPC boundary preserves real call reverts and excludes transport errors",async()=>{
 const { rpcResult }=await import("./evidence.js");
 const result=(error:unknown)=>({jsonrpc:"2.0",id:7,error});
 assert.equal(rpcResult("eth_call",7,{jsonrpc:"2.0",id:7,result:"0x01"}),"0x01");
 for(const code of [3,-32000,-32015,-32603]){
  assert.throws(()=>rpcResult("eth_call",7,result({code,message:"execution reverted",data:"0x39c4052c"})),
   (e:any)=>e.code===code&&e.data==="0x39c4052c");
 }
 for(const [method,code,message] of [["eth_call",429,"rate limited"],["eth_call",-32000,"timeout"],["eth_getCode",3,"execution reverted"]] as const){
  assert.throws(()=>rpcResult(method,7,result({code,message,data:"0x39c4052c"})),(e:any)=>e.data===undefined&&e.code===code);
 }
 for(const value of [null,{},result({code:"3",message:"execution reverted"}),{...result({code:3,message:"execution reverted"}),result:"0x"},{jsonrpc:"2.0",id:8,result:"0x"}])
  assert.throws(()=>rpcResult("eth_call",7,value));
});

test("production request declarations match each identity/current/Exact round including empty capacity",async()=>{
 const { declareRequestProgram }=await import("../../../adapter-request-program.js");
 const d=descriptor(),routes=plugin.routes.project({descriptor:d});
 const current={descriptor:d,routes,source:SOURCE},pricing=plugin.pricing.current;
 const first=declareRequestProgram({requirements:pricing.requirements,buildRequests:pricing.buildRequests,decode:({results})=>results},current);
 assert.equal(first.requirements.caller,undefined);
 const initial=first.requests.map(answer);
 for(const result of [initial,initial.map(r=>r.id.startsWith("raw:")?returned(r.id,ABI.encodeFunctionResult("rawBalances",[0n,0n])):r)]){
  const round=pricing.buildDependentProgram!({current,completedRound:0,initialResults:result})!;
  const checked=declareRequestProgram({requirements:()=>round.requirements,buildRequests:()=>round.requests,decode:({results})=>results},undefined);
  assert.equal(checked.requirements.caller,checked.requests.length?"executor":undefined);
  const state=pricing.decodeSnapshot({descriptor:d,initialResults:result,dependentEvidence:[round.decode(checked.requests.map(answer))]});
  assert.equal(pricing.deriveMids({descriptor:d,routes,snapshot:state}).size,checked.requests.length);
 }
 for(const route of routes){
  const i=input(d,route),requests=declareRequestProgram({requirements:exactProgram.requirements,buildRequests:exactProgram.buildRequests,decode:({results})=>results},i);
  assert.equal(requests.requirements.caller,"executor");
 }
});

test("independent on-chain rejection probe declares only observed completion effects",async()=>{
 const { declareRequestProgram }=await import("../../../adapter-request-program.js");
 const { quoteRequest }=await import("../codec.js");
 const { quoteBoundaryRequirements }=await import("./evidence.js");
 const d=descriptor(),request={...quoteRequest(d,0,1n,"boundary"),required:false,completion:"return-or-revert-data" as const};
 const program={requirements:()=>quoteBoundaryRequirements,buildRequests:()=>[request],decode:({results}:any)=>results};
 assert.equal(declareRequestProgram(program,undefined).requests.length,1);
 assert.throws(()=>declareRequestProgram({...program,requirements:()=>({...quoteBoundaryRequirements,effects:["return-data","revert-data"] as const})},undefined),/return-data is not observed/);
});
