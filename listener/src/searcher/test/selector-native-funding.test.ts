import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Interface, toBeHex, getAddress } from "ethers";
import { compileSelectorNativeFundingFamily, selectorFundingFee } from "../venues/selector-native-funding.js";
import { normalizeSelectorNativeFundingDefinition, selectorNativeFundingCandidateFromCensus, assertSelectorNativeFundingCandidate, selectorFundingCallArguments } from "../venues/selector-native-funding-definition.js";
import { defineFundingFamily, definedFamilyPluginContractSummary, type AnyDefinedStrictFamilyPlugin, type FundingExecutionBinding } from "../venues/adapter-family-plugin.js";
import { FamilyCapabilityCatalog, FAMILY_CAPABILITY_NAMES, capabilityManifestHash } from "../venues/family-capability-catalog.js";
import { executeFundingFamilyLiquidity, buildFundingBorrowFragment, buildFundingRepaymentFragment } from "../adapter-funding-runtime.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { StrictProductionRuntimeRoot } from "../strict-production-runtime-session.js";
import { readySelectorCensusFromTransaction } from "../ready-selector-census.js";
import { strictFundingExecutionResource, strictFundingPrewarmAddresses } from "../strict-execution-projection.js";
const a=(n:number)=>toBeHex(n,20), h=(n:number)=>toBeHex(n,32);
const asset=a(101), secondAsset=a(102), provider=a(201), otherProvider=a(202), executor=a(301), owner=a(302), collector=a(401);
const source={number:123,hash:h(123),generation:123};
const balance=new Interface(["function balanceOf(address) view returns(uint256)"]);
const collect=new Interface(["function getProtocolFeesCollector() view returns(address)"]);
const percentage=new Interface(["function getFlashLoanFeePercentage() view returns(uint256)"]);
export const fundingDefinition=(selector:string)=>normalizeSelectorNativeFundingDefinition(JSON.parse(readFileSync(new URL(`../venues/selector-native/selector-${selector}-family/selector-${selector}.json`,import.meta.url),"utf8")));
export function loadedFunding(plugin:AnyDefinedStrictFamilyPlugin) {
 const entries=FAMILY_CAPABILITY_NAMES.map(capability=>({familyId:plugin.manifest.familyId,capability,contractVersion:"adapter-family-test-v2",contentHash:createHash("sha256").update(plugin.manifest.familyId+capability).digest("hex"),semanticDependencies:[`contract:${capability}`],provenanceCommit:"a".repeat(40)}));
 const catalog=new FamilyCapabilityCatalog({modules:[{sourceFile:`fixture/${plugin.manifest.familyId}.production.ts`,definitionBoundaryHash:definedFamilyPluginContractSummary(plugin).definitionBoundaryHash,plugin}],generatedManifest:{format:"adapter-family-capabilities-v1",entries,manifestHash:capabilityManifestHash(entries)}});
 return {catalog,family:catalog.forStrictFamily(plugin.manifest.familyId)};
}
function binding(selector:string,target=provider,token=asset):FundingExecutionBinding {
 const def=fundingDefinition(selector);return {chainId:1,provider:target,selector:def.selector,signature:def.signature,asset:token};
}
function harness(input:{rate?:bigint; failProvider?:string; missingCollector?:boolean}={}) {
 const reads:any[]=[];
 const runtime=createStrictCentralAdapterRuntime({executor,transactionOrigin:owner,generationFence:{assertCurrent(g,s){assert.equal(g,source.generation);assert.deepEqual(s,source);}},provider:{
  async getCode(){assert.fail("no identity RPC");},async getStorage(){assert.fail("no storage RPC");},
  async call(tx,block){assert.equal(block??tx.blockTag,source.number);reads.push(tx);
   if(tx.data.startsWith(balance.getFunction("balanceOf")!.selector)) {
    const holder=String(balance.decodeFunctionData("balanceOf",tx.data)[0]).toLowerCase();
    if(holder===input.failProvider)throw new Error("synthetic source failure");
    return balance.encodeFunctionResult("balanceOf",[holder===otherProvider?2000n:1000n]);
   }
   if(tx.data.startsWith(collect.getFunction("getProtocolFeesCollector")!.selector)) {
    if(input.missingCollector)throw new Error("missing declared fee getter");
    return collect.encodeFunctionResult("getProtocolFeesCollector",[collector]);
   }
   assert.equal(String(tx.to).toLowerCase(),collector);assert.equal(tx.data,percentage.encodeFunctionData("getFlashLoanFeePercentage"));
   return percentage.encodeFunctionResult("getFlashLoanFeePercentage",[input.rate??0n]);
  }
 }});
 return {runtime,reads};
}
async function offers(selector:string,bindings:FundingExecutionBinding[],options:Parameters<typeof harness>[0]={}) {
 const plugin=defineFundingFamily(compileSelectorNativeFundingFamily(fundingDefinition(selector))),loaded=loadedFunding(plugin),transport=harness(options);
 const result=await executeFundingFamilyLiquidity({family:loaded.family,assets:[...new Set(bindings.map(b=>b.asset))],bindings,source,generation:source.generation,runtime:transport.runtime,publisher:{publish(){}}});
 return {...loaded,plugin,...transport,result};
}
test("funding schema rejects old formats and selector ABI mismatches",()=>{
 const def=fundingDefinition("5c38449e");assert.throws(()=>normalizeSelectorNativeFundingDefinition({...def,format:"bindings-v1"}));
 assert.throws(()=>normalizeSelectorNativeFundingDefinition({...def,format:"selector-native-funding/v1"}),/retired format/);
 assert.throws(()=>normalizeSelectorNativeFundingDefinition({...def,selector:"0xe0232b42"}));
 assert.throws(()=>normalizeSelectorNativeFundingDefinition({...def,repayment:{mode:"auto"}}));
 const {format:_format,...short}=def;assert.deepEqual(normalizeSelectorNativeFundingDefinition(short),def);
 for(const key of ["params","identity","observation","callback","liquidity","fee","priority"])
  assert.throws(()=>normalizeSelectorNativeFundingDefinition({...def,[key]:{}}),/definition fields/);
 assert.throws(()=>normalizeSelectorNativeFundingDefinition({...def,parameters:def.parameters.slice(1)}),/every ABI parameter/);
 assert.throws(()=>normalizeSelectorNativeFundingDefinition({...def,parameters:def.parameters.map(p=>p.role==="amountIn"?{...p,role:"recipient"}:p)}),/role differs/);
 assert.equal(compileSelectorNativeFundingFamily(def).funding.repayment.target,undefined);
 assert.equal(def.activation?.envKey,"SEARCHER_FAMILY_BALANCER_FLASH_ENABLED");
});
test("funding metadata is absent from declaration, candidate, module contract and encoded arguments",()=>{
 const definition=fundingDefinition("5c38449e"),author={...definition,meta:{label:"Former protocol label",identity:{name:"optional"},notes:["one",{two:true}]}};
 const normalized=normalizeSelectorNativeFundingDefinition(author);assert.deepEqual(normalized,definition);assert(!Object.hasOwn(normalized,"meta"));
 const abi=new Interface([definition.signature]),census=readySelectorCensusFromTransaction({chain_id:1,tx_hash:h(99),block_number:source.number,block_hash:source.hash,receipt_status:1,from:owner,to:provider,
  input:abi.encodeFunctionData("flashLoan",[owner,[asset,secondAsset],["100","200"],"0x1234"]),logs:[],traces:[]});
 const before=selectorNativeFundingCandidateFromCensus(definition,census,census.calls[0]!.id),after=selectorNativeFundingCandidateFromCensus(author,census,census.calls[0]!.id);assert(before&&after);
 assert.deepEqual(after,before);assertSelectorNativeFundingCandidate(before,author);
 const contract=(raw:unknown)=>definedFamilyPluginContractSummary(defineFundingFamily(compileSelectorNativeFundingFamily(raw)));
 assert.deepEqual(contract(author),contract(definition));
 const args=selectorFundingCallArguments(normalized,{provider,tokenIn:secondAsset,amountIn:7n,executor,children:"0xbeef",args:before.fundingBindings[0]!.arguments});
 assert.deepEqual(args,[getAddress(executor),[getAddress(secondAsset)],[7n],"0xbeef"]);
 assert.throws(()=>assertSelectorNativeFundingCandidate(before,{...definition,funding:{...definition.funding,fee:{kind:"constant",amount:"2"}}}),/candidate binding differs/);
});
test("successful selector census retains arbitrary providers and every borrowed asset without identity",()=>{
 const def=fundingDefinition("5c38449e"),abi=new Interface([def.signature]);
 const census=readySelectorCensusFromTransaction({chain_id:1,tx_hash:h(99),block_number:source.number,block_hash:source.hash,receipt_status:1,from:owner,to:otherProvider,
  input:abi.encodeFunctionData("flashLoan",[executor,[asset,secondAsset],["100","20"],"0x"]),logs:[],traces:[]});
 const candidate=selectorNativeFundingCandidateFromCensus(def,census,census.calls[0]!.id);assert(candidate);
 assert.deepEqual(candidate.assets,[asset,secondAsset]);assert.equal(candidate.provider,otherProvider);assert.equal(candidate.fundingBindings.length,2);
 assertSelectorNativeFundingCandidate(candidate,def);
 const plugin=compileSelectorNativeFundingFamily(def),observation={kind:"call" as const,source,target:otherProvider,sender:owner,data:census.calls[0]!.calldata!,transactionHash:census.transactionHash!,traceAddress:[],opaque:{selectorCensus:census,callId:census.calls[0]!.id}};
 const nominate=(row:any)=>plugin.discovery.decodeCandidate({observation:row,matchedPatternId:plugin.discovery.callPatterns![0]!.id});
 assert(nominate(observation));assert.equal(nominate({...observation,sender:executor}),null);assert.equal(nominate({...observation,transactionHash:h(100)}),null);assert.equal(nominate({...observation,traceAddress:[1]}),null);
 assert.equal(nominate({...observation,sender:undefined}),null);assert.equal(nominate({...observation,transactionHash:undefined}),null);assert.equal(nominate({...observation,source:{...source,generation:-1}}),null);
 assert.equal(selectorNativeFundingCandidateFromCensus({...def,funding:{...def.funding,scope:{poolIdPath:[999]}}},census,census.calls[0]!.id),null);
 assert.equal(selectorNativeFundingCandidateFromCensus({...def,funding:{...def.funding,scope:{poolIdPath:[1]}}},census,census.calls[0]!.id),null);
 assert.throws(()=>assertSelectorNativeFundingCandidate({...candidate,provider},def));
 assert.equal(selectorNativeFundingCandidateFromCensus(def,{...census,receiptStatus:0},census.calls[0]!.id),null);
});
test("funding copies of observed ABI parameters enter typed instance keys automatically",()=>{
 const signature="function flashLoan(address,uint256,string,bytes)",abi=new Interface([signature]);
 const definition=normalizeSelectorNativeFundingDefinition({...fundingDefinition("e0232b42"),signature,selector:abi.getFunction("flashLoan")!.selector,
  parameters:[{path:[0],role:"tokenIn"},{path:[1],role:"amountIn"},{path:[2],role:"bound"},{path:[3],role:"children"}]});
 const plugin=compileSelectorNativeFundingFamily(definition);
 const candidate=(label:string,amount:bigint)=>{
  const census=readySelectorCensusFromTransaction({chain_id:1,tx_hash:h(99),block_number:source.number,block_hash:source.hash,receipt_status:1,from:owner,to:provider,
   input:abi.encodeFunctionData("flashLoan",[asset,amount,label,"0x"]),logs:[],traces:[]});
  const found=selectorNativeFundingCandidateFromCensus(definition,census,census.calls[0]!.id);assert(found);return found;
 };
 const upper=candidate("PoolA",100n),lower=candidate("poola",100n),newAmount=candidate("PoolA",200n);
 assert.deepEqual(upper.fundingBindings[0]!.immutableParameters,[{path:[2],type:"string",value:"PoolA"}]);
 assert.notEqual(plugin.discovery.candidateKey(upper),plugin.discovery.candidateKey(lower));
 assert.equal(plugin.discovery.candidateKey(upper),plugin.discovery.candidateKey(newAmount));
 assert.equal(plugin.funding.liquidity.sources([asset],[upper.fundingBindings[0]!]).length,1);
 assert.throws(()=>plugin.funding.liquidity.sources([asset],[{...upper.fundingBindings[0]!,immutableParameters:[]}]),/bound ABI/);
});
test("same selector multi-provider offers survive Ready, choice and repayment without first-provider fallback",async()=>{
 const bindings=[binding("e0232b42"),binding("e0232b42",otherProvider)];
 const {catalog,family,result,runtime}=await offers("e0232b42",bindings);
 assert.deepEqual(result.outcomes.map(o=>o.status),["verified","verified"]);assert.equal(new Set(result.offers.map(o=>o.fundingId)).size,2);
 const root=new StrictProductionRuntimeRoot({catalog,readySource:source,readyGraph:[],readyInstances:[],readyFundingAssets:bindings.map(binding=>({familyId:family.plugin.manifest.familyId,asset,binding}))});
 const session=await root.createSession({source,runtime,fundingAssets:[asset]});
 assert.equal(session.fundingProjection().sources.get(asset)!.amount,2000n,"capacity is maximum single source, never a sum");
 const choices=session.fundingChoices(asset,100n);assert.equal(choices.length,2);assert.equal(session.fundingActionIds(asset).length,1);
 assert.throws(()=>session.buildFundingRoot({actionAdapterId:choices[0]!.actionAdapterId,asset,amount:100n,minProfit:0n,children:[]}),/ambiguous/);
 for(const choice of choices){const node=session.buildFundingRoot({...choice,asset,amount:100n,minProfit:0n,children:[]});const offer=result.offers.find(o=>o.fundingId===choice.fundingId)!;
  assert.equal(node.target,offer.binding!.provider);assert.equal(node.children.at(-1)!.params.spender,offer.binding!.provider);
 }
 assert.throws(()=>session.buildFundingRoot({...choices[0]!,fundingId:"missing",asset,amount:100n,minProfit:0n,children:[]}),/no Funding offer/);
});
test("selected funding resource projection keeps provider and declared holder distinct and rejects forged roots",async()=>{
 const holder=a(901),original=fundingDefinition("e0232b42"),definition={...original,funding:{...original.funding,liquidity:{...original.funding.liquidity,args:[holder]}}};
 const plugin=defineFundingFamily(compileSelectorNativeFundingFamily(definition)),{catalog,family}=loadedFunding(plugin),{runtime}=harness();
 const result=await executeFundingFamilyLiquidity({family,assets:[asset],bindings:[binding("e0232b42"),binding("e0232b42",otherProvider)],source,generation:source.generation,runtime,publisher:{publish(){}}});
 assert.equal(result.offers.length,2);
 const selectedRoots=result.offers.map(offer=>buildFundingBorrowFragment({family,offer,source,generation:source.generation,amount:100n,minProfit:0n,children:[]}).nodes[0]!);
 assert.deepEqual(strictFundingPrewarmAddresses({catalog}),[],"catalog alone cannot select a provider");
 assert.deepEqual(strictFundingPrewarmAddresses({catalog,selectedRoots,executor}),[provider,otherProvider,holder].sort());
 for(const node of selectedRoots){const projected=strictFundingExecutionResource({catalog,node,executor});
  assert.equal(projected.target,node.target);assert.equal(projected.liquidityHolder,holder);assert.equal(projected.amount,100n);assert.equal(projected.asset,asset);
 }
 const node=selectedRoots[0]!;
 assert.throws(()=>strictFundingExecutionResource({catalog,executor,node:{...node,target:a(902)}}),/encoded root resource/);
 assert.throws(()=>strictFundingExecutionResource({catalog,executor,node:{...node,params:{...node.params,fundingId:"forged"}}}),/encoded root resource/);
 assert.throws(()=>strictFundingExecutionResource({catalog,executor,node:{...node,params:{...node.params,fundingResourceKey:"forged"}}}),/encoded root resource/);
 assert.throws(()=>strictFundingExecutionResource({catalog,executor,node:{...node,params:{...node.params,fee:"not-a-uint"}}}),/uint256/,
  "resource projection must run the real encoder, not merely parse binding metadata");
});
test("declared dynamic fee reads are pinned and ceil depends on selected amount",async()=>{
 const {result,reads,family}=await offers("5c38449e",[binding("5c38449e")],{rate:10n**15n});
 assert.equal(result.offers.length,1,JSON.stringify(result.outcomes));assert.equal(reads.length,3);
 const offer=result.offers[0]!;assert.equal(offer.feeRate,10n**15n);assert.equal(offer.evidenceRefs.length,2);
 assert.equal(selectorFundingFee(offer,1n),1n);assert.equal(selectorFundingFee(offer,1000n),1n);assert.equal(selectorFundingFee(offer,1001n),2n);
 const repayment=buildFundingRepaymentFragment({family,offer,source,generation:source.generation,amount:101n});assert.equal(repayment.nodes[0]!.amount,102n);
 const root=buildFundingBorrowFragment({family,offer,source,generation:source.generation,amount:101n,minProfit:3n,children:[]});assert.equal(root.nodes[0]!.children[0]!.amount,105n);
 assert.throws(()=>buildFundingBorrowFragment({family,offer:{...offer},source,generation:source.generation,amount:1n,minProfit:0n,children:[]}),/issued by/);
 assert.throws(()=>buildFundingRepaymentFragment({family,offer,source:{...source,generation:124},generation:124,amount:1n}),/source\/generation/);
});
test("unknown compatible selector provider with missing declared fee read stays unresolved",async()=>{
 const {result}=await offers("5c38449e",[binding("5c38449e",otherProvider)],{missingCollector:true});
 assert.equal(result.offers.length,0);assert.equal(result.outcomes[0]!.status,"unresolved");assert.equal(result.publication,null);
});
test("source failure is isolated per provider",async()=>{
 const {result}=await offers("e0232b42",[binding("e0232b42"),binding("e0232b42",otherProvider)],{failProvider:provider});
 assert.equal(result.offers.length,1);assert.equal(result.offers[0]!.binding!.provider,otherProvider);assert.equal(result.outcomes.filter(o=>o.status==="unresolved").length,1);
});
test("one holder ERC20 balance cannot be duplicated by logical pools or selectors",async()=>{
 const first=await offers("e0232b42",[{...binding("e0232b42"),poolId:"PoolA",poolNamespace:"factory"},{...binding("e0232b42"),poolId:"PoolB",poolNamespace:"factory"}]);
 const [a,b]=first.result.offers;assert(a&&b);assert.notEqual(a.fundingId,b.fundingId);assert.equal(a.liquidityResourceKey,b.liquidityResourceKey);
 const second=await offers("5c38449e",[binding("5c38449e")]);assert.equal(second.result.offers[0]!.liquidityResourceKey,a.liquidityResourceKey);
 const inner=buildFundingBorrowFragment({family:first.family,offer:b,source,generation:source.generation,amount:10n,minProfit:0n,children:[]});
 assert.throws(()=>buildFundingBorrowFragment({family:first.family,offer:a,source,generation:source.generation,amount:10n,minProfit:0n,children:[inner]}),/same physical liquidity/);
});
