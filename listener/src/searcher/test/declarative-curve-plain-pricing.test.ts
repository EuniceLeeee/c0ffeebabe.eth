import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Interface, AbiCoder, getAddress, getBytes, hexlify, keccak256, toBeHex } from "ethers";
import { createDeclarativeSwapRuntime } from "../venues/declarative-swap.js";
import { inspectRuntime } from "./runtime-program-testkit.js";
import { buildEffectiveMids } from "../blockscan-effective-mid.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";

// The independent host executes generated RuntimeAmount bytecode. Its receipts
// are synthetic contract observations, never EVM, fork, or live admission proof.
test("[family=curve-plain] JSON prices one direction by actual execution and re-simulates Exact amounts", async () => {
  const definitionUrl = new URL("../venues/swaps/curve-plain-family/curve-plain.json", import.meta.url);
  const root = JSON.parse(readFileSync(definitionUrl, "utf8"));
  const children = root.variantFiles.map((file: string) => JSON.parse(readFileSync(new URL(file, definitionUrl), "utf8")));
  const runtime = createDeclarativeSwapRuntime(root, children);
  const A = (n: number) => getAddress(toBeHex(n, 20));
  const pool = A(400), executor = A(500), alternateExecutor = A(501), coins = Array.from({ length: 8 }, (_, i) => A(100 + i));
  const source = { number: 26389549, hash: toBeHex(26389549, 32), generation: 1 };
  // This fixture starts after synthetic admission; it does not prove that these
  // addresses are deployed Curve pools. All pricing/Exact code is the real JSON.
  const directions = coins.flatMap((tokenIn, i) => coins.flatMap((tokenOut, j) => i === j ? [] : [{
    i, j, tokenIn, tokenOut, executionMode: "exchange", executionAssets: { input: "erc20", output: "erc20" },
  }]));
  const identity: any = {
    familyId: root.scope.family, lineageId: root.standard.lineageId, subject: pool,
    provenance: [{ kind: "synthetic-pricing-fixture", subject: pool, evidenceHash: toBeHex(901, 32) }],
    facts: { pool, binding: { registry: root.standard.constants.registry, handlers: [A(601)], coins,
      decimals: coins.map(() => 18n), coinAbi: "uint256", balanceAbi: "uint256", codeHash: toBeHex(900, 32), classKind: "registry" }, directions },
  };
  const descriptor: any = runtime.definition.instance.compileDraft(identity);
  const definition:any=runtime.definition, routes:any[]=definition.routes.project({descriptor});
  assert.equal(routes.length,56);
  const pricing=definition.pricing;
  const route=routes[0];
  const draft=pricing.compileDraft({descriptor,routes:[route],stateKey:route.routeKey});
  assert.equal(draft.routes.length,1);
  assert.throws(()=>pricing.compileDraft({descriptor,routes,stateKey:route.routeKey}),/one behavior-proven state group/);
  const pd=pricing.finalizePricingDescriptor({draft,staticEvidence:pricing.staticEvidence.decode({draft,results:[],source})});
  const token=new Interface(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)',
    'function approve(address,uint256) returns(bool)','function transfer(address,uint256) returns(bool)']);
  const pair=new Interface(['function exchange(int128,int128,uint256,uint256) returns(uint256)','function balances(uint256) view returns(uint256)']);
  const poolBalance=1_000_000_000_000_000_000_000_000n;
  const liquidity=poolBalance/100000n;
  const output=(dx:bigint)=>dx*liquidity/(liquidity+dx)*99n/100n;
  function result(id:string,data:string,extra:any={},bound=source):any {
    return {id,ok:true,completion:'returned',data,source:bound,provenance:{kind:'synthetic-independent-runtime-host',fingerprint:'not-EVM-or-live'},...extra};
  }
  function firstResults(requests:any[],actor=executor,bound=source):any[] {
    assert.deepEqual(requests.map(r=>r.id),['probe-executor','pricing-input-balance']);
    assert.deepEqual(requests[0].overrideIntent,{caller:{kind:'executor'}});
    assert.equal(requests[0].call.executionMode,'impersonated-call-frame');
    assert.equal(token.decodeFunctionData('balanceOf',requests[0].call.data)[0],root.standard.constants.curvePricingZero);
    assert.equal(pair.decodeFunctionData('balances',requests[1].data)[0],BigInt(route.i));
    return [result('probe-executor',token.encodeFunctionResult('balanceOf',[0n]),{
      effects:{tokenDeltas:[{token:root.standard.constants.curvePricingWeth,account:actor,delta:0n}],nativeDeltas:[{account:actor,delta:0n}]}
    },bound),result('pricing-input-balance',pair.encodeFunctionResult('balances',[poolBalance]),{},bound)];
  }
  function unpack(data:string){
    const script=AbiCoder.defaultAbiCoder().decode(['bytes'],'0x'+data.slice(10))[0],b=getBytes(script);
    assert.equal(b[0],14);assert.equal(Number(BigInt(hexlify(b.slice(33,36)))),b.length-36);
    return {program:hexlify(b.slice(36)),amount:BigInt(hexlify(b.slice(1,33)))};
  }
  function tradeResult(request:any,expectedAmount:bigint,actor=executor,bound=source):any {
    assert.equal(request.call.executionMode,'executor-program');assert.equal(request.call.to,actor);
    assert.deepEqual(request.overrideIntent,{caller:{kind:'executor'},tokenBalances:[{token:route.tokenIn,amount:expectedAmount}]});
    const p=unpack(request.call.data);assert.equal(p.amount,expectedAmount);
    let inputBalance=expectedAmount+123n,outputBalance=456n,allowance=0n,exchangeCount=0;
    const startIn=inputBalance,startOut=outputBalance;
    const executed=inspectRuntime(p.program,p.amount,{nativeBalance:()=>0n,call(c:any){
      if(c.target===pool){
        const parsed=pair.parseTransaction({data:c.data});assert(parsed);assert.equal(parsed.name,'exchange');
        assert.deepEqual([...parsed.args],[BigInt(route.i),BigInt(route.j),expectedAmount,1n]);
        assert.equal(allowance,expectedAmount);inputBalance-=expectedAmount;outputBalance+=output(expectedAmount);exchangeCount++;
        // Pool-reported output is deliberately greater than wallet credit; token
        // output tax is included only by observing wallet delta.
        return pair.encodeFunctionResult('exchange',[expectedAmount*liquidity/(liquidity+expectedAmount)]);
      }
      const parsed=token.parseTransaction({data:c.data});assert(parsed);
      if(parsed.name==='balanceOf'){
        assert.equal(parsed.args[0],actor);return token.encodeFunctionResult('balanceOf',[c.target===route.tokenIn?inputBalance:c.target===route.tokenOut?outputBalance:789n]);
      }
      if(parsed.name==='allowance')return token.encodeFunctionResult('allowance',[allowance]);
      assert.equal(parsed.name,'approve');assert.equal(parsed.args[0],pool);allowance=parsed.args[1];return token.encodeFunctionResult('approve',[true]);
    }});
    assert.equal(exchangeCount,1);assert.equal(allowance,0n);assert.equal(executed.registers[0],expectedAmount);
    return result(request.id,'0x',{effects:{tokenDeltas:request.observeTokenBalances.map((row:any)=>({token:row.token,account:actor,
      delta:row.token.toLowerCase()===route.tokenIn.toLowerCase()?inputBalance-startIn:row.token.toLowerCase()===route.tokenOut.toLowerCase()?outputBalance-startOut:0n})),
      nativeDeltas:[{account:actor,delta:0n}]}},bound);
  }
  function price(actor=executor,bound=source){
    const current={descriptor:pd,routes:[route],source:bound};
    const initialRequests=pricing.current.buildRequests(current);assert.equal(initialRequests.length,2);
    const initialResults=firstResults(initialRequests,actor,bound);
    const dependent=pricing.current.buildDependentProgram({current,completedRound:0,initialResults,priorEvidence:[]});
    assert.equal(dependent.requests.length,1);
    assert.equal(dependent.requests[0].observeTokenBalances.length,8);
    const sample=poolBalance/1_000_000n;
    const returned=tradeResult(dependent.requests[0],sample,actor,bound);
    const dependentEvidence=[dependent.decode([returned])];
    assert.equal(pricing.current.buildDependentProgram({current,completedRound:1,initialResults,priorEvidence:dependentEvidence}),null);
    const snapshot=pricing.current.decodeSnapshot({descriptor:pd,initialResults,dependentEvidence});
    assert.equal(snapshot.quotes[route.routeKey].amountIn,sample);
    assert.equal(snapshot.quotes[route.routeKey].amountOut,output(sample));
    assert.equal(snapshot.executor,actor);assert.deepEqual(snapshot.source,bound);
    const mids=pricing.current.deriveMids({descriptor:pd,snapshot,routes:[route]});
    assert.equal(mids.size,1);assert.equal(mids.get(route.routeKey).kind,'curve');
    assert.equal(mids.get(route.routeKey).edges[0].edgeKind,'swap');
    assert.equal(mids.get(route.routeKey).feeBps,0);assert.equal(mids.get(route.routeKey).mid,Number(output(sample))/Number(sample));
    return {current,initialResults,dependent,dependentEvidence,snapshot,returned,sample};
  }
  const baseline=price();
  const nextSource={...source,number:source.number+1,hash:toBeHex(source.number+1,32)};
  price(alternateExecutor,nextSource);
  const exactInput:any={descriptor,route,source,executor,amountIn:baseline.sample*2n,runtimeEvidence:[]};
  const methods=definition.exact.methods(exactInput);
  const exact=methods.find((m:any)=>m.program&&m.id!=='zero');assert(exact);
  const exactRequests=exact.program.buildRequests(exactInput);assert.equal(exactRequests.length,1);
  const exactResponse=tradeResult(exactRequests[0],exactInput.amountIn);
  const exactOutput=exact.program.decode({programInput:exactInput,initialResults:[exactResponse],dependentEvidence:[]});
  assert.equal(exactOutput.amountOut,output(exactInput.amountIn));
  assert.notEqual(exactOutput.amountOut,baseline.snapshot.quotes[route.routeKey].amountOut*2n);
  const rawMid=pricing.current.deriveMids({descriptor:pd,snapshot:baseline.snapshot,routes:[route]}).get(route.routeKey);
  const edge=rawMid.edges[0],edgeKey=blockScanEdgeKey(edge);let effectiveCalls=0;
  const effective=await buildEffectiveMids({pricing:{sourceBlock:source.number,sourceBlockHash:source.hash,generation:source.generation,
    graph:{edges:[edge]},pricingStateKeyByEdgeKey:new Map([[edgeKey,route.routeKey]]),coverage:{resolvedEdgeKeys:[edgeKey]},
    mids:new Map([[edgeKey,{mid:123456789,feeBps:9999}]])},weth:route.tokenIn,gasCostWei:null,fixedWethInput:exactInput.amountIn,
    enumerationSpreadBps:50,control:{},concurrency:1,quote:async ({amountIn})=>{
      effectiveCalls++;const input={...exactInput,amountIn};const request=exact.program.buildRequests(input)[0];
      const receipt=tradeResult(request,amountIn);
      const decoded=exact.program.decode({programInput:input,initialResults:[receipt],dependentEvidence:[]});
      return {source,amountIn,amountOut:decoded.amountOut};
    }});
  assert(effective.complete);assert.equal(effectiveCalls,1);assert.equal(effective.rows.get(edgeKey)?.status,'quoted');
  assert.equal(effective.rows.get(edgeKey)?.amountOut,output(exactInput.amountIn));
  assert.equal(effective.rows.get(edgeKey)?.effectiveMid,Number(output(exactInput.amountIn))/Number(exactInput.amountIn));
  let rejected=0;
  for(const mutate of [
    (r:any[])=>{r[0].effects.tokenDeltas[0].delta=1n;},
    (r:any[])=>{r[0].effects.nativeDeltas[0].account=A(999);},
    (r:any[])=>{r[0].effects.tokenDeltas[0].account=pool;r[0].effects.nativeDeltas[0].account=pool;},
    (r:any[])=>{r[0].source=nextSource;},
    (r:any[])=>{r[1].data='0x';},
    (r:any[])=>{r[1].data=toBeHex(0,32);}
  ]){
    const bad=structuredClone(baseline.initialResults);mutate(bad);
    assert.throws(()=>pricing.current.buildDependentProgram({current:baseline.current,completedRound:0,initialResults:bad,priorEvidence:[]}));rejected++;
  }
  for(const mutate of [
    (r:any)=>{r.effects.tokenDeltas[0].delta++;},
    (r:any)=>{r.effects.tokenDeltas[1].account=alternateExecutor;},
    (r:any)=>{r.effects.tokenDeltas[1].delta=0n;},
    (r:any)=>{r.effects.tokenDeltas[2].delta=-1n;},
    (r:any)=>{r.effects.nativeDeltas[0].delta=-1n;},
    (r:any)=>{r.source=nextSource;},
    (r:any)=>{r.completion='reverted';}
  ]){
    const bad=structuredClone(baseline.returned);mutate(bad);
    assert.throws(()=>{const de=[baseline.dependent.decode([bad])];return pricing.current.decodeSnapshot({descriptor:pd,initialResults:baseline.initialResults,dependentEvidence:de});});rejected++;
  }
  assert.equal(rejected, 13);
});

test("[family=curve-plain] clone pricing consumes the first balance word of its 4096-byte return", () => {
  const definitionUrl = new URL("../venues/swaps/curve-plain-family/curve-plain.json", import.meta.url);
  const load = (url: URL) => JSON.parse(readFileSync(url, "utf8"));
  const root = load(definitionUrl);
  const children = root.variantFiles.map((file: string) => load(new URL(file, definitionUrl)));
  const family: any = createDeclarativeSwapRuntime(root, children).definition;
  const fixture = load(new URL("../venues/swaps/curve-plain-family/test/fixtures/noteusd-clone.json", import.meta.url));
  assert.equal((fixture.proxyRuntime.length - 2) / 2, 51);
  assert.equal(keccak256(fixture.proxyRuntime), fixture.proxyCodeHash);
  assert.equal(keccak256(fixture.implementationCode), fixture.implementationCodeHash);
  // The observed clone ends in PUSH2 0x1000 / PUSH1 0 / RETURN. Its successful
  // scalar calls therefore expose 4096 bytes, while the scalar is word zero.
  assert(fixture.proxyRuntime.endsWith("6110006000f3"));
  const source = { number: fixture.block, hash: fixture.blockHash, generation: 1 };
  const executor = getAddress(toBeHex(700, 20));
  // Admission is synthetic; the runtime bytes are the recorded clone fixture.
  const identity = { familyId: root.scope.family, lineageId: root.standard.constants.cloneLineage,
    subject: fixture.pool, provenance: [{ kind: "synthetic-clone-pricing", subject: fixture.pool, evidenceHash: fixture.proxyCodeHash }],
    facts: { pool: fixture.pool, binding: { registry: fixture.implementation, handlers: [], coins: fixture.coins,
      decimals: fixture.decimals.map(BigInt), coinAbi: "uint256", balanceAbi: "uint256", classKind: "clone",
      codeHash: fixture.proxyCodeHash, implementationCodeHash: fixture.implementationCodeHash },
      directions: [{ i: 0, j: 1, tokenIn: fixture.coins[0], tokenOut: fixture.coins[1], executionMode: "exchange",
        executionAssets: { input: "erc20", output: "erc20" } }] } };
  const descriptor = family.instance.compileDraft(identity), route = family.routes.project({ descriptor })[0];
  const pricing = family.pricing;
  const draft = pricing.compileDraft({ descriptor, routes: [route], stateKey: route.routeKey });
  const pd = pricing.finalizePricingDescriptor({ draft, staticEvidence: {} });
  const current = { descriptor: pd, routes: [route], source };
  const requests = pricing.current.buildRequests(current);
  assert.deepEqual(requests.map((request: any) => request.id), ["probe-executor", "pricing-input-balance"]);
  const balance = BigInt(fixture.balances[0]), firstWord = toBeHex(balance, 32);
  const expectedSample = balance / 1_000_000n < 10n ** 18n ? balance / 1_000_000n : 10n ** 18n;
  const result = (request: any, data: string, effects?: any) => ({ id: request.id, ok: true, source,
    completion: "returned", data, provenance: { kind: "synthetic-clone-pricing", fingerprint: "not-live-admission" },
    ...(effects ? { effects } : {}) });
  const actor = result(requests[0], toBeHex(0, 32), {
    tokenDeltas: [{ token: root.standard.constants.curvePricingWeth, account: executor, delta: 0n }],
    nativeDeltas: [{ account: executor, delta: 0n }],
  });
  // Trailing valid bytes are intentionally ignored, including nonzero memory.
  for (const tailByte of ["00", "ff"]) {
    const data = firstWord + tailByte.repeat(4096 - 32);
    assert.equal((data.length - 2) / 2, 4096);
    const initialResults = [actor, result(requests[1], data)];
    const dependent = pricing.current.buildDependentProgram({ current, completedRound: 0, initialResults, priorEvidence: [] });
    assert.equal(dependent.requests.length, 1);
    const request = dependent.requests[0];
    assert.equal(request.call.executionMode, "executor-program");
    assert.equal(request.overrideIntent.tokenBalances[0].amount, expectedSample);
    const receipt = result(request, "0x", {
      tokenDeltas: [{ token: route.tokenIn, account: executor, delta: -expectedSample },
        { token: route.tokenOut, account: executor, delta: expectedSample * 2n }],
      nativeDeltas: [{ account: executor, delta: 0n }],
    });
    const snapshot = pricing.current.decodeSnapshot({ descriptor: pd, initialResults,
      dependentEvidence: [dependent.decode([receipt])] });
    assert.equal(snapshot.balanceIn, balance);
    assert.equal(snapshot.quotes[route.routeKey].amountIn, expectedSample);
    assert.equal(snapshot.quotes[route.routeKey].amountOut, expectedSample * 2n);
  }
  for (const data of ["0x", firstWord.slice(0, -2), firstWord + "0", firstWord + "gg", "0xg" + firstWord.slice(3)]) {
    assert.throws(() => pricing.current.buildDependentProgram({ current, completedRound: 0,
      initialResults: [actor, result(requests[1], data)], priorEvidence: [] }), /balance return shape/);
  }
  // The actor probe targets WETH itself, so its exact-word contract is retained.
  assert.throws(() => pricing.current.buildDependentProgram({ current, completedRound: 0,
    initialResults: [{ ...actor, data: actor.data + "00" }, result(requests[1], firstWord)], priorEvidence: [] }), /authority probe uint256 return/);
});
