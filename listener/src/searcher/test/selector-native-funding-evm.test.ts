import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ContractFactory, Interface, JsonRpcProvider, getBytes, toBeHex } from "ethers";
import { compileSelectorNativeFundingFamily, selectorFundingFee } from "../venues/selector-native-funding.js";
import { executeFundingFamilyLiquidity, buildFundingBorrowFragment } from "../adapter-funding-runtime.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { buildExecuteCalldata } from "../../shared/executor/botvm-executor.js";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../adapters/runtime-amount-program.js";
import { concatBytes } from "../../encoder.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../venues/production-infra-actions.js";
import { defineFundingFamily, definedFamilyPluginContractSummary } from "../venues/adapter-family-plugin.js";
import { FamilyCapabilityCatalog,FAMILY_CAPABILITY_NAMES,capabilityManifestHash } from "../venues/family-capability-catalog.js";
import { createHash } from "node:crypto";
import type { ResolvedPlanNode } from "../../types.js";
const a=(n:number)=>toBeHex(n,20);
test("local EVM: both selector funding templates borrow, authenticate callback children and repay",{skip:process.env.SELECTOR_FUNDING_EVM_TEST!=="1",timeout:120000},async t=>{
 const root=new URL("../../../../",import.meta.url),require=createRequire(import.meta.url),solc=require(process.env.OBSERVED_CALL_SOLC_MODULE??"solc");
 const file="listener/src/searcher/test/fixtures/SelectorFunding.sol";
 const files=[file,"src/BotVM.sol","src/Constants.sol","src/RuntimeAmountVM.sol","src/RuntimeAmountKernel.sol","src/RuntimeCallSequence.sol","src/interfaces/IERC20.sol"];
 const compiled=JSON.parse(solc.compile(JSON.stringify({language:"Solidity",sources:Object.fromEntries(files.map(name=>[name,{content:readFileSync(new URL(name,root),"utf8")}])) ,settings:{optimizer:{enabled:true,runs:200},viaIR:true,evmVersion:"cancun",outputSelection:{"*":{"*":["abi","evm.bytecode.object","evm.deployedBytecode.object"]}}}})));
 assert.deepEqual((compiled.errors??[]).filter((e:any)=>e.severity==="error"),[]);
 const code=(name:string)=>"0x"+compiled.contracts[file][name].evm.deployedBytecode.object;
 const socket=createServer();await new Promise<void>(r=>socket.listen(0,"127.0.0.1",r));const port=(socket.address() as {port:number}).port;await new Promise<void>(r=>socket.close(()=>r()));
 const child=spawn(process.env.OBSERVED_CALL_ANVIL_BIN??"anvil",["--host","127.0.0.1","--port",String(port),"--chain-id","31337","--hardfork","cancun","--disable-code-size-limit","--gas-limit","60000000","--silent"],{stdio:"ignore"});
 const provider=new JsonRpcProvider(`http://127.0.0.1:${port}`,31337,{staticNetwork:true,cacheTimeout:-1});provider.pollingInterval=10;
 t.after(async()=>{provider.destroy();if(child.exitCode===null){const stopped=new Promise<void>(r=>child.once("close",()=>r()));child.kill("SIGKILL");await stopped;}});
 let ready=false;for(let i=0;i<60;i++){try{if(await provider.send("eth_chainId",[])==="0x7a69"){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert(ready);
 const signer=await provider.getSigner(0),owner=await signer.getAddress(),artifact=compiled.contracts["src/BotVM.sol"].BotVM;
 const deployed=await new ContractFactory(artifact.abi,"0x"+artifact.evm.bytecode.object,signer).deploy();await deployed.waitForDeployment();
 const executor=(await deployed.getAddress()).toLowerCase(),asset=a(9002),lender=a(9003),second=a(9004);
 for(const [target,bytes] of [[asset,code("SelectorFundingToken")],[lender,code("SelectorFundingProvider")],[second,code("SelectorFundingProvider")],[a(0xf00d),code("SelectorFundingRelay")]])await provider.send("anvil_setCode",[target,bytes]);
 const token=new Interface(["function mint(address,uint256)","function balanceOf(address) view returns(uint256)"]),settings=new Interface(["function configure(uint256,uint256)"]);
 const send=async(to:string,data:string)=>{const receipt=await(await signer.sendTransaction({to,data,gasLimit:16000000})).wait();assert.equal(receipt?.status,1);};
 const balance=async(who:string)=>BigInt(await provider.call({to:asset,data:token.encodeFunctionData("balanceOf",[who])}));
 await send(asset,token.encodeFunctionData("mint",[lender,100000n]));await send(asset,token.encodeFunctionData("mint",[second,100000n]));await send(asset,token.encodeFunctionData("mint",[executor,7n]));
 for(const selector of ["e0232b42","5c38449e"]){
  const definition=JSON.parse(readFileSync(new URL(`../venues/selector-native/selector-${selector}-family/selector-${selector}.json`,import.meta.url),"utf8"));
  const plugin=defineFundingFamily(compileSelectorNativeFundingFamily(definition));
  const entries=FAMILY_CAPABILITY_NAMES.map(capability=>({familyId:plugin.manifest.familyId,capability,contractVersion:"adapter-family-test-v2",contentHash:createHash("sha256").update(plugin.manifest.familyId+capability).digest("hex"),semanticDependencies:[`contract:${capability}`],provenanceCommit:"a".repeat(40)}));
  const catalog=new FamilyCapabilityCatalog({modules:[{sourceFile:"fixture/native-funding.production.ts",definitionBoundaryHash:definedFamilyPluginContractSummary(plugin).definitionBoundaryHash,plugin}],generatedManifest:{format:"adapter-family-capabilities-v1",entries,manifestHash:capabilityManifestHash(entries)}}),family=catalog.forStrictFamily(plugin.manifest.familyId);
  for(const target of [lender,second]){
   const rate=selector==="5c38449e"?10n**15n:0n;await send(target,settings.encodeFunctionData("configure",[rate,0]));
   const block=await provider.getBlock("latest");assert(block?.hash);const source={number:block.number,hash:block.hash,generation:block.number};
   const runtime=createStrictCentralAdapterRuntime({executor,transactionOrigin:owner,generationFence:{assertCurrent(g,s){assert.equal(g,source.generation);assert.deepEqual(s,source);}},provider:{call:async(tx,b)=>provider.call({...tx,blockTag:b}),getCode:async()=>{assert.fail("no identity read");},getStorage:async()=>{assert.fail("no storage read");}}});
   const result=await executeFundingFamilyLiquidity({family,assets:[asset],bindings:[{chainId:31337,provider:target,asset,selector:definition.selector,signature:definition.signature}],source,generation:source.generation,runtime,publisher:{publish(){}}});
   const offer=result.offers[0];assert(offer,JSON.stringify(result.outcomes));const amount=101n,fee=selectorFundingFee(offer,amount),beforeExecutor=await balance(executor),beforeLender=await balance(target);
   const rootNode=buildFundingBorrowFragment({family,offer,source,generation:source.generation,amount,minProfit:2n,children:[]}).nodes[0]!;
   const adapters=[...plugin.actionAdapters,...PRODUCTION_INFRA_ACTION_ADAPTERS];
   const encode=(node:ResolvedPlanNode):Uint8Array=>adapters.find(a=>a.id===node.adapterId)!.encode(node,executor,concatBytes(...(node===rootNode?[runtimeProgramScript(new RuntimeAmountProgram().call(asset,token.encodeFunctionData("mint",[executor,fee+2n])).bytes())]:[]),...node.children.map(encode)));
   const data=buildExecuteCalldata(encode(rootNode));await send(executor,data);
   assert.equal(await balance(executor),beforeExecutor+2n);assert.equal(await balance(target),beforeLender+fee);
   for(const mode of [1,2,3]){await send(target,settings.encodeFunctionData("configure",[rate,mode]));const before=await balance(executor);
    await assert.rejects(provider.call({from:owner,to:executor,data,gasLimit:16000000}),/revert|CALL_EXCEPTION/);assert.equal(await balance(executor),before,"a rejected callback cannot run children or spend inventory");}
   await send(target,settings.encodeFunctionData("configure",[rate,0]));
   if(rate>0n){await send(target,settings.encodeFunctionData("configure",[rate*20n,0]));await assert.rejects(provider.call({from:owner,to:executor,data,gasLimit:16000000}),/revert|CALL_EXCEPTION/,"fee liability changed since the pinned offer must revert");}
  }
 }
});
