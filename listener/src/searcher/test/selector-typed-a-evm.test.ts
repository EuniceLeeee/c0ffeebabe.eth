import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { ContractFactory, Interface, JsonRpcProvider, getBytes, toBeHex, type Contract } from "ethers";
import { runtimeProgramScript } from "../../adapters/runtime-amount-program.js";
import { buildExecuteCalldata } from "../../shared/executor/botvm-executor.js";
import { readySelectorCensusFromTransaction } from "../ready-selector-census.js";
import { normalizeSelectorNativeExecutionDefinition } from "../venues/selector-native-definition.js";
import { selectorNativeCandidateFromCensus } from "../venues/selector-native-discovery.js";
import { createSelectorNativeRuntime } from "../venues/selector-native-runtime.js";

const root=new URL("../../../../",import.meta.url),fixture="listener/src/searcher/test/fixtures/SelectorTypedAFixture.sol";
const stringify=(v:unknown)=>JSON.stringify(v,(_k,x)=>typeof x==="bigint"?String(x):x);
const migrations=JSON.parse(readFileSync(new URL("../generated/selector-typed-a-migration.generated.json",import.meta.url),"utf8"));
/** Loopback only; actual BotVM execution and balance/allowance/supply receipts.
 * This is a deterministic encoder/guard regression, not a live protocol claim. */
test("typed v2 programs execute current amounts, nested approvals, rounding, fee claims and zap conservation on a real local EVM",{
  skip:process.env.SELECTOR_TYPED_A_EVM_TEST!=="1",timeout:240_000,
},async t=>{
  const require=createRequire(import.meta.url),solc=require(process.env.OBSERVED_CALL_SOLC_MODULE??"solc");
  const files=["src/BotVM.sol","src/Constants.sol","src/RuntimeAmountVM.sol","src/RuntimeAmountKernel.sol","src/RuntimeCallSequence.sol","src/interfaces/IERC20.sol",fixture];
  const compiled=JSON.parse(solc.compile(JSON.stringify({language:"Solidity",sources:Object.fromEntries(files.map(file=>[file,{content:readFileSync(new URL(file,root),"utf8")} ])),
    settings:{optimizer:{enabled:true,runs:200},viaIR:true,evmVersion:"cancun",outputSelection:{"*":{"*":["abi","evm.bytecode.object"]}}}})));
  assert.deepEqual((compiled.errors??[]).filter((e:any)=>e.severity==="error"),[]);
  const socket=createServer();await new Promise<void>((resolve,reject)=>{socket.once("error",reject);socket.listen(0,"127.0.0.1",resolve);});
  const port=(socket.address() as {port:number}).port;await new Promise<void>(resolve=>socket.close(()=>resolve()));
  const child=spawn(process.env.OBSERVED_CALL_ANVIL_BIN??"anvil",["--host","127.0.0.1","--port",String(port),"--chain-id","31337","--hardfork","cancun","--disable-code-size-limit","--silent"],{stdio:["ignore","ignore","pipe"]});
  let failed:Error|undefined;child.once("error",e=>failed=e);const provider=new JsonRpcProvider(`http://127.0.0.1:${port}`,31337,{staticNetwork:true,cacheTimeout:-1});provider.pollingInterval=10;
  t.after(async()=>{provider.destroy();if(child.exitCode===null&&child.signalCode===null){const closed=new Promise<void>(resolve=>child.once("close",()=>resolve()));child.kill("SIGKILL");await closed;}});
  let ready=false;for(let i=0;i<60;i++){if(failed)throw failed;try{assert.equal(await provider.send("eth_chainId",[]),"0x7a69");ready=true;break;}catch{await new Promise(r=>setTimeout(r,100));}}
  assert(ready,"new loopback chain unavailable");const owner=await provider.getSigner(0),origin=await owner.getAddress(),external=await (await provider.getSigner(1)).getAddress();
  async function deploy(name:string,args:unknown[]=[],file=fixture):Promise<Contract>{const c=compiled.contracts[file][name],d=await new ContractFactory(c.abi,`0x${c.evm.bytecode.object}`,owner).deploy(...args);await d.waitForDeployment();return d as unknown as Contract;}
  const send=async(c:Contract,name:string,args:unknown[])=>{const tx=await c.getFunction(name)(...args);const receipt=await tx.wait();assert.equal(receipt.status,1);return receipt;};
  const token0=await deploy("TypedToken"),token1=await deploy("TypedToken"),token2=await deploy("TypedToken"),token3=await deploy("TypedToken"),baseLp=await deploy("TypedToken"),lp=await deploy("TypedToken");
  const tokenA=await token0.getAddress(),tokenB=await token1.getAddress(),executorContract=await deploy("BotVM",[],"src/BotVM.sol"),executor=await executorContract.getAddress();
  const reserves=await deploy("TypedReserves"),liquidity=await deploy("TypedReserves"),staking=await deploy("TypedReserves");
  const y=await deploy("TypedYield",[tokenA,tokenB,await reserves.getAddress(),await liquidity.getAddress(),await staking.getAddress()]);
  const curve=await deploy("TypedCurve",[tokenA,tokenB,await (await provider.getSigner(2)).getAddress(),await liquidity.getAddress()]);
  const permit=await deploy("TypedPermit"),vault=await deploy("TypedVault"),pool=await deploy("TypedPool",[await vault.getAddress()]),router=await deploy("TypedRouter",[await permit.getAddress()]);
  const zap=await deploy("TypedZap",[await liquidity.getAddress(),await reserves.getAddress(),await lp.getAddress(),await baseLp.getAddress(),[tokenA,tokenB,await token2.getAddress(),await token3.getAddress()]]);
  for(const c of [token0,token1,y,curve])await send(c,"issue",[executor,100_000n]);
  for(const recipient of [await y.getAddress(),await curve.getAddress(),await vault.getAddress()]){await send(token0,"issue",[recipient,1_000_000n]);await send(token1,"issue",[recipient,1_000_000n]);}
  const tokenAbi=new Interface(["function balanceOf(address) view returns(uint256)","function totalSupply() view returns(uint256)"]);
  async function bind(recipe:string,target:string,args:unknown[],tolerance=1n){
    const row=migrations.entries.find((r:any)=>r.recipe===recipe);assert(row,recipe);const raw=JSON.parse(readFileSync(new URL(row.file,root),"utf8"));
    const definition=normalizeSelectorNativeExecutionDefinition({...raw,programs:raw.programs.filter((p:any)=>p.meta?.migrationKey===recipe)}),runtime=createSelectorNativeRuntime(definition,definition.programs[0]!);
    const header=await provider.send("eth_getBlockByNumber",["latest",false]),source={number:Number(BigInt(header.number)),hash:header.hash,generation:1};
    const census=readySelectorCensusFromTransaction({chainId:31337,transactionHash:toBeHex(1,32),blockNumber:source.number,blockHash:source.hash,status:1,from:origin,to:target,input:new Interface([definition.signature]).encodeFunctionData(definition.selector,args),logs:[],traces:[]});
    const candidate=selectorNativeCandidateFromCensus(definition,census,census.calls[0]!.id)!;assert(candidate);let proof:any;
    for(let n=0;n<8;n++){const step=runtime.step({candidate,source,executor,executionRoundingRawUnits:tolerance,evidence:proof}),results=[];
      for(const request of step.requests as any[]){assert.equal(request.kind,"eth-call");try{const data=await provider.send("eth_call",[{to:request.to,data:request.data},toBeHex(source.number)]);results.push({id:request.id,ok:true,completion:"returned",source,data,provenance:{kind:"fixture-rpc",fingerprint:source.hash}});}catch(error){if(request.required!==false)throw error;results.push({id:request.id,ok:true,completion:"reverted",source,data:"0x",provenance:{kind:"fixture-rpc",fingerprint:source.hash}});}}
      proof=step.decode(results as any);if(proof.stage==="complete")break;}
    assert.equal(proof.stage,"complete",recipe);const bound=runtime.verify(candidate,proof);return {runtime,input:{candidate,descriptor:bound.descriptor,route:bound.innerRoutes[0],source,executor,amountIn:77n,runtimeEvidence:[]},recipe};
  }
  async function execute(p:Awaited<ReturnType<typeof bind>>,amountIn=77n,recipient?:string){
    const input={...p.input,amountIn,...(recipient?{settlement:{kind:"direct-output" as const,recipient}}:{})},leg=p.runtime.buildRuntimeLeg(input);assert(leg,p.recipe);
    const data=buildExecuteCalldata(runtimeProgramScript(getBytes(leg.program),amountIn));
    await provider.send("eth_call",[{from:origin,to:executor,data},"latest"]);
    const beforeIn=BigInt(await provider.call({to:input.route.tokenIn,data:tokenAbi.encodeFunctionData("balanceOf",[executor])})),receiver=recipient??executor;
    const beforeOut=BigInt(await provider.call({to:input.route.tokenOut,data:tokenAbi.encodeFunctionData("balanceOf",[receiver])}));
    const receipt=await (await owner.sendTransaction({to:executor,data,gasLimit:15_000_000})).wait();assert.equal(receipt?.status,1,p.recipe);
    const afterIn=BigInt(await provider.call({to:input.route.tokenIn,data:tokenAbi.encodeFunctionData("balanceOf",[executor])})),afterOut=BigInt(await provider.call({to:input.route.tokenOut,data:tokenAbi.encodeFunctionData("balanceOf",[receiver])}));
    return {spent:beforeIn-afterIn,output:afterOut-beforeOut,receipt};
  }
  async function rejects(p:Awaited<ReturnType<typeof bind>>){const leg=p.runtime.buildRuntimeLeg(p.input);assert(leg);await assert.rejects(provider.send("eth_call",[{from:origin,to:executor,data:buildExecuteCalldata(runtimeProgramScript(getBytes(leg.program),77n))},"latest"]));}
  for(const recipe of ["yieldbasis-lt:deposit:executor","yieldbasis-lt:deposit:receiver","yieldbasis-lt:withdraw:executor","yieldbasis-lt:withdraw:receiver"]){
    const deposit=recipe.includes("deposit"),receiver=recipe.endsWith("receiver"),p=await bind(recipe,await y.getAddress(),[7n,...(deposit?[1n]:[]),1n,...(receiver?[origin]:[])]);
    if(deposit)await send(reserves,"set",[500n,200n]); // Same VM bytes derive the new debt from current reserves.
    const result=await execute(p,77n,receiver?external:undefined);assert.equal(result.spent,77n);assert.equal(result.output,154n);
    if(deposit)assert.equal(await token0.allowance(executor,await y.getAddress()),0n);
  }
  const b=await bind("balancer-v3:router-exact-input",await router.getAddress(),[await pool.getAddress(),tokenA,tokenB,7n,1n,1000n,false,"0x"]);
  const bs=await execute(b);assert.equal(bs.spent,77n);assert.equal(bs.output,154n);assert.equal(await token0.allowance(executor,await permit.getAddress()),0n);assert.equal(await permit.permitted(executor,tokenA,await router.getAddress()),0n);
  await send(curve,"setRounding",[1n,0n]);const ng=await bind("curve-lp:ng-fixed2:mint:0",await curve.getAddress(),[[7n,0n],1n,origin]);
  const ngs=await execute(ng);assert.equal(ngs.spent,76n);assert.equal(ngs.output,152n);
  await rejects(await bind("curve-lp:ng-fixed2:mint:0",await curve.getAddress(),[[7n,0n],1n,origin],0n));
  await send(curve,"setRounding",[1n,2n]);await rejects(ng);await send(curve,"setRounding",[0n,0n]);
  for(const receiver of [false,true]){const claim=await bind(`curve-lp:fee-claim:${receiver?"receiver":"none"}:redeem`,await curve.getAddress(),[7n,1n,1n,...(receiver?[origin]:[])]);
    const c=await execute(claim,77n,receiver?external:undefined);assert.equal(c.spent,77n);assert.equal(c.output,154n);}
  const z=await bind("curve-lp:zap:mint:1",await zap.getAddress(),[[0n,7n,0n,0n],1n]),zs=await execute(z);assert.equal(zs.spent,77n);assert.equal(zs.output,154n);
  await send(baseLp,"issue",[await zap.getAddress(),1n]);await rejects(z);
});
