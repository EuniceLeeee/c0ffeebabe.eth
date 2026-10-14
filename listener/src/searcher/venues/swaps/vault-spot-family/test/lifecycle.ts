import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { ethers } from "ethers";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { runStrictFamilyLifecycle } from "../../../../strict-family-lifecycle-runner.js";
import { buildFamilyRouteGraphView } from "../../../../adapter-family-graph-runtime.js";
import { StrictProductionRuntimeRoot } from "../../../../strict-production-runtime-session.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { ID as FAMILY } from "../manifest.js";
import { ABI } from "../codec.js";
import { SOURCE,V,A,B,E,OTHER,ROUTER,USDG,UTILS,FEED,descriptor,receipt } from "./fixtures.js";
import type { CanonicalSource } from "../../../adapter-request-program.js";
import type { Descriptor, Route } from "../types.js";
const code=JSON.parse(fs.readFileSync(new URL("./runtime-code.json",import.meta.url),"utf8")).runtime as string;

test("production strict and empty-touch heads consume each-block pricing, rebind oracle, withdraw failures and recover",async()=>{
  let tick=0,failed=false,enabled=true,feed=FEED;
  const priceReads:{number:number;target:string;swapMode:boolean}[]=[], exactReads:{number:number;amount:bigint}[]=[];
  const runtime=(source:CanonicalSource)=>createStrictCentralAdapterRuntime({executor:E,transactionOrigin:OTHER,
    generationFence:{assertCurrent(g,s){assert.deepEqual(s,source);assert.equal(g,source.generation);}},
    provider:{async getCode(a){return a.toLowerCase()===V?code:"0x60006000";},async getStorage(){throw new Error("fixture unexpected storage");},
      async call(tx){
        const p=ABI.parseTransaction(tx)!;
        if(p.name==="getPrice"){
          priceReads.push({number:source.number,target:tx.to.toLowerCase(),swapMode:p.args[3]});
          if(failed)throw new Error("fixture oracle unavailable");
          assert.equal(tx.to.toLowerCase(),feed);assert.equal(p.args[3],true);
          return ABI.encodeFunctionResult("getPrice",[(p.args[0].toLowerCase()===A?2n+BigInt(tick):4n)*10n**30n]);
        }
        const values:Record<string,unknown>={isInitialized:true,isSwapEnabled:enabled,router:ROUTER,usdg:USDG,vaultUtils:UTILS,priceFeed:feed,
          includeAmmPrice:true,whitelistedTokens:true,tokenDecimals:18n,decimals:18n,vault:V,vaults:true,
          poolAmounts:10n**24n,reservedAmounts:100n,bufferAmounts:500n,getSwapFeeBasisPoints:30n};
        assert(p.name in values,p.name);return ABI.encodeFunctionResult(p.name,[values[p.name]]);
      }},
    simulator:{executorProgramCodeHash:ethers.keccak256("0x60006000"),async simulate({request,source:actual,callerAuthority}){ try {
      assert.deepEqual(actual,source);assert.equal(callerAuthority.executor,E);assert.equal(callerAuthority.transactionOrigin,OTHER);
      assert.equal(request.call.executionMode,"executor-program");assert.equal(ABI.parseTransaction({data:request.call.data})!.name,"execSubscript");
      const balance=request.overrideIntent.tokenBalances![0],value=balance.amount;exactReads.push({number:source.number,amount:value});
      const d=descriptor(),route=catalog.forFamily(FAMILY).plugin.routes.project({descriptor:d}).find((r:any)=>r.tokenIn===balance.token) as Route;
      const result=receipt(d,route,value,100n+BigInt(tick));assert(result.ok);return {data:result.data,effects:result.effects};
    } catch(error) { console.error("fixture simulation failure",error); throw error; }
    }},
  });
  const publication=await runStrictFamilyLifecycle({catalog,familyId:FAMILY,source:SOURCE,runtime:runtime(SOURCE),observations:[{kind:"call",source:SOURCE,target:V,data:ABI.encodeFunctionData("swap",[A,B,E])}]});
  assert.equal(publication.instances.length,1,"strict must publish the actual market");
  const family=catalog.forFamily(FAMILY), graph=buildFamilyRouteGraphView({routes:publication.instances.flatMap(instance=>instance.routes.map((route,i)=>({family,descriptor:instance.descriptor,route,handle:instance.routeHandles[i]})))});
  assert.equal(graph.edges.length,2);
  const root=new StrictProductionRuntimeRoot({catalog,readySource:SOURCE,readyGraph:graph.edges,readyInstances:publication.instances,readyFundingAssets:[]});
  assert.deepEqual(root.pricingIndex().perBlockRefreshStateKeys,[publication.instances[0].descriptor.instanceKey]);
  const trials=["unchanged","oracle-address-change","oracle-failure","recovery","disabled","reenabled","unrelated-touch"] as const;
  for(const label of trials){
    tick++;failed=label==="oracle-failure";enabled=label!=="disabled";if(label==="oracle-address-change")feed="0x1000000000000000000000000000000000000004";
    const source={...SOURCE,number:SOURCE.number+tick,hash:ethers.toBeHex(tick+17,32),generation:tick+2},before=priceReads.length;
    const session=await root.createSession({source,runtime:runtime(source),fundingAssets:[],kind:"pricing",touchedPools:new Set(label==="unrelated-touch"?[OTHER]:[])});
    assert(priceReads.length>before,"no pool activity must still refresh oracle state");
    assert(priceReads.slice(before).every(x=>x.number===source.number&&x.target===feed&&x.swapMode));
    for(const edge of graph.edges){
      const priced=session.currentPricingForEdge(edge);
      if(failed||!enabled){assert.notEqual(priced?.status,"priced");continue;}
      assert.equal(priced?.status,"priced");
      const amount=71854376210288490340n,i=exactReads.length,q=await session.issueExact({edge,amountIn:amount,executor:E,runtimeEvidence:[]});
      assert.equal(q.amountOut,100n+BigInt(tick));assert(exactReads.slice(i).some(r=>r.amount===amount&&r.number===source.number));
      assert.equal(session.buildExecution({edge,exact:q,minAmountOut:q.amountOut,executor:E}).status,"resolved");
    }
  }
});
