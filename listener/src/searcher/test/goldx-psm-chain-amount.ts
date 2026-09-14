import assert from "node:assert/strict";
import { ADDR } from "../../shared/constants/addresses.js";
import { executeAdapterWork } from "../adapter-work-intent.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import type { AdapterRequestResult, CanonicalSource } from "../venues/adapter-request-program.js";
import { goldxExact, goldxExecution, goldxFamilyManifest, goldxInstance, goldxRoutes } from "../venues/protocols/goldx-family-plugin.js";
import { GOLDX_INTERFACE, goldxQuote } from "../venues/protocols/goldx-family/codec.js";
import { psmExact, psmExecution, psmFamilyManifest, psmInstance, psmRoutes } from "../venues/protocols/psm-family-plugin.js";
import { PSM_INTERFACE, psmSellQuote } from "../venues/protocols/psm-family/codec.js";
import { MAX_UINT256 } from "../venues/protocols/standard-family/common.js";

// Recorded actual pre-change simulation outputs at the same pinned source.
// Golden amounts are observed token deltas, not regenerated test expectations.
const source: CanonicalSource = { number: 25953652,
  hash: "0x72bca773ab1206a690591ef67c144879aadc0cf08d9bf59650f4049852d57b19", generation: 25953652 };
const executor = "0x4af9495c4ac24c5cd3b0c90611550a1996415bce";
const goldx = goldxInstance.compileDraft({ familyId: goldxFamilyManifest.familyId,
  lineageId: goldxFamilyManifest.supportedLineages[0]!, subject: ADDR.GOLDX, provenance: [], unit: 31103476800000000000n });
const psm = psmInstance.compileDraft({ familyId: psmFamilyManifest.familyId,
  lineageId: psmFamilyManifest.supportedLineages[0]!, subject: ADDR.SKY_PSM_LITE, provenance: [], gem: ADDR.USDC, dai: ADDR.DAI });
const fixtures = [
  { name: "GOLDx", descriptor: goldx, route: goldxRoutes.project({descriptor:goldx})[0]!,
    exact: goldxExact, execution: goldxExecution, abi: GOLDX_INTERFACE, getter: "unit", parameter: 31103476800000000000n,
    points: [[569296218431425n,17707091722309559n],[569296218431426n,17707091722309590n],[5692962184314250n,177070917223095598n]] },
  { name: "PSM", descriptor: psm, route: psmRoutes.project({descriptor:psm})[0]!,
    exact: psmExact, execution: psmExecution, abi: PSM_INTERFACE, getter: "tin", parameter: 0n,
    points: [[2475687n,2475687000000000000n],[2475688n,2475688000000000000n],[24756870n,24756870000000000000n]] },
];
for (const f of fixtures) {
  // Each Family is independently typed in its semantic modules; the test matrix
  // uses their common callable shape rather than manufacturing runtime authority.
  const methods = f.exact.methods();
  const method = methods.find(m=>m.kind==="request-program")!;
  assert(method.kind==="request-program");
  assert(!("chainAmountQuote" in method), "parameter reads do not return amountOut");
  const program = method.program as any;
  const id = "exact-" + f.getter;
  const result = (data = f.abi.encodeFunctionResult(f.getter,[f.parameter])) => ({
    id, ok:true as const, source, provenance:{kind:"test",fingerprint:id}, completion:"returned" as const, data,
  });
  let calls=0;
  const runtime=createStrictCentralAdapterRuntime({executor,
    provider:{ call:async(tx,block)=>{
      calls++; assert.equal(block,source.number); assert.equal(tx.to,f.descriptor.target);
      assert.equal(tx.data,f.abi.encodeFunctionData(f.getter)); return result().data;
    },getCode:async()=>assert.fail("unexpected code read"),getStorage:async()=>assert.fail("unexpected storage read")},
    simulator:{simulate:async()=>assert.fail("amount quote must not perform local simulation")},
    generationFence:{assertCurrent(g,s){assert.equal(g,source.generation);assert.deepEqual(s,source);}},
  });
  for (const [amountIn,expected] of f.points) {
    const input={descriptor:f.descriptor,route:f.route,amountIn,source,executor,runtimeEvidence:[]};
    assert.deepEqual(program.requirements(input),{transports:["eth-call"]});
    assert.equal(program.buildRequests(input).length,1);
    assert.equal(program.buildRequests(input)[0].kind,"eth-call");
    const work=await executeAdapterWork({runtime,intent:{stage:"exact-refine",familyId:f.descriptor.familyId,
      instanceKey:f.descriptor.instanceKey,routeKey:f.route.routeKey,source,generation:source.generation,programInput:input,
      program:{requirements:program.requirements,buildRequests:program.buildRequests,
        decode({programInput,results}){return program.decode({programInput,initialResults:results,dependentEvidence:[]});}}}});
    assert(work.status==="resolved"); const quote=work.executed.evidence as any;
    assert.equal(quote.amountOut,expected); assert.equal(quote.evidence.amountIn,amountIn);
    assert.deepEqual(quote.evidence.source,source);
    const fragment=f.execution.buildFragment({...input,quotedAmountOut:expected,minAmountOut:expected,exactEvidence:quote.evidence} as never);
    assert.equal(fragment.nodes[0].amount,amountIn);
  }
  assert.equal(calls,3,"one fee/rate read per quote and no simulation");
  const input={descriptor:f.descriptor,route:f.route,amountIn:f.points[0][0],source,executor,runtimeEvidence:[]};
  const decode=(results:readonly AdapterRequestResult[], patch={})=>program.decode({
    programInput:{...input,...patch},initialResults:results,dependentEvidence:[]});
  for (const results of [[],[result(),result()],[{...result(),id:"other"}]]) assert.throws(()=>decode(results),/missing|ambiguous/);
  for (const patch of [{data:"0x"},{data:"0x01"},{completion:"reverted-as-declared" as const},
    {source:{...source,number:source.number+1}},{source:{...source,hash:"0x"+"12".repeat(32)}},{source:{...source,generation:0}}]) {
    assert.throws(()=>decode([{...result(),...patch}]));
  }
  for(const failure of ["rpc","deadline","aborted"] as const) assert.throws(()=>decode([{id,ok:false,source,failure}]),/unresolved/);
  assert.throws(()=>decode([result()],{amountIn:-1n}),/range/);
  assert.throws(()=>program.buildRequests({...input,amountIn:MAX_UINT256+1n}),/uint256/);
  const zero={...input,amountIn:0n};
  assert.deepEqual(program.requirements(zero),{transports:[]});
  assert.deepEqual(program.buildRequests(zero),[]);
  assert.equal(decode([],{amountIn:0n}).amountOut,0n);
  const badParameter=f.getter==="unit"?0n:10n**18n+1n;
  assert.throws(()=>decode([result(f.abi.encodeFunctionResult(f.getter,[badParameter]))]),/unit|fee/);
}
assert.equal(psmSellQuote(137n,13n*10n**15n,10n**12n),135219000000000n);
assert.equal(psmSellQuote(1n,1n,1n),1n,"fee is floored before subtraction");
assert.equal(goldxQuote(137n,10n**18n+1n),137n,"mint output rounds down");
assert.throws(()=>goldxQuote(MAX_UINT256,2n),/overflow/);
assert.throws(()=>psmSellQuote(MAX_UINT256,0n,10n**12n),/overflow/);
assert.throws(()=>psmSellQuote(MAX_UINT256,2n,1n),/overflow/);
console.log("goldx-psm source-parameter quotes PASS (6 recorded simulation equality points; no local simulator in quote)");
