import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { runStrictFamilyLifecycle } from "../../../../strict-family-lifecycle-runner.js";
import { buildFamilyRouteGraphView } from "../../../../adapter-family-graph-runtime.js";
import { StrictProductionRuntimeRoot } from "../../../../strict-production-runtime-session.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { FAMILY } from "../manifest.js";
import { ABI } from "../codec.js";
import { SOURCE, TARGET, ASSET, FACTORY, EXECUTOR, OTHER, CODE, receipt } from "./fixtures.js";
import type { CanonicalSource } from "../../../adapter-request-program.js";

test("production issuer enforces strict transport declarations, publishes both routes and refreshes denied transfers", async () => {
  const observed: {number:number;amount:bigint;direction:string}[]=[];
  let denied=false;
  const runtime=(source:CanonicalSource)=>createStrictCentralAdapterRuntime({
    executor:EXECUTOR,transactionOrigin:OTHER,generationFence:{assertCurrent(g,s){assert.deepEqual(s,source);assert.equal(g,source.generation);}},
    provider:{
      async getCode(address){return address.toLowerCase()===TARGET.toLowerCase()?CODE:"0x60006000";},
      async getStorage(){throw new Error("unexpected fixture storage");},
      async call(tx){
        const parsed=ABI.parseTransaction(tx)!;
        const values:Record<string,string|bigint>={factory:FACTORY,token:ASSET,getWrappedToken:TARGET,decimals:18n,totalSupply:10n**24n,balanceOf:10n**24n};
        assert(values[parsed.name]!==undefined,parsed.name);
        return ABI.encodeFunctionResult(parsed.name,[values[parsed.name]]);
      },
    },
    simulator:{async simulate({request,source:actual,callerAuthority}){
      assert.deepEqual(actual,source);assert.equal(callerAuthority.executor,EXECUTOR);
      const p=ABI.parseTransaction({data:request.call.data})!;assert(p.name==="wrap"||p.name==="unwrap");
      const value=BigInt(p.args[0]);observed.push({number:source.number,amount:value,direction:p.name});
      if(denied)throw Object.assign(new Error("fixture transfer permission denied"),{code:"CALL_EXCEPTION",data:"0x"});
      const r=receipt(request.id,p.name,value,source);assert(r.ok);return {data:r.data,effects:r.effects};
    }},
  });
  const publication=await runStrictFamilyLifecycle({catalog,familyId:FAMILY,source:SOURCE,runtime:runtime(SOURCE),
    observations:[{kind:"call",source:SOURCE,target:TARGET,data:ABI.encodeFunctionData("wrap",[91n])}]});
  assert.equal(publication.instances.length,1);
  const family=catalog.forFamily(FAMILY);
  const graph=buildFamilyRouteGraphView({routes:publication.instances.flatMap(instance=>instance.routes.map((route,i)=>({family,
    descriptor:instance.descriptor,route,handle:instance.routeHandles[i]})))});
  assert.equal(graph.edges.length,2);
  const root=new StrictProductionRuntimeRoot({catalog,readySource:SOURCE,readyGraph:graph.edges,readyInstances:publication.instances,readyFundingAssets:[]});
  for(const [tick,failing] of [false,true,true,false].entries()){
    denied=failing;const source={...SOURCE,number:SOURCE.number+tick+1,hash:ethers.toBeHex(tick+17,32),generation:tick+2};
    const before=observed.length;
    const session=await root.createSession({source,runtime:runtime(source),fundingAssets:[],kind:"pricing"});
    assert(observed.length>before,"each-block transfer proof must refresh without a wrapper swap");
    for(const edge of graph.edges){
      const priced=session.currentPricingForEdge(edge);
      if(failing){assert.notEqual(priced?.status,"priced");continue;}
      assert.equal(priced?.status,"priced");
      const i=observed.length,amountIn=4387060682263585n;
      const q=await session.issueExact({edge,amountIn,executor:EXECUTOR,runtimeEvidence:[]});
      assert.equal(q.amountOut,amountIn);assert(observed.slice(i).some(r=>r.amount===amountIn));
      assert.equal(session.buildExecution({edge,exact:q,minAmountOut:amountIn,executor:EXECUTOR}).status,"resolved");
    }
  }
});
