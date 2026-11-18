import { FunctionFragment, Interface, MaxUint256, type ParamType, getAddress, getBytes, hexlify } from "ethers";
import { concatBytes } from "../../encoder.js";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../adapters/runtime-amount-program.js";
import type { ActionAdapter, ResolvedPlanNode } from "../../types.js";
import { collectRequestProgramResults, type FundingFamilyPlugin, type FundingExecutionBinding, type FundingSourceDescriptor, type FundingOfferDescriptor, type FundingLiquidityProgramInput } from "./adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult } from "./adapter-request-program.js";
import { bindFamilyOwnedAction } from "./family-owned-action.js";
import { selectorAssetOfferKey, selectorAssetResourceKey } from "./selector-execution-keys.js";
import { compileSelectorNativeFundingDiscovery, normalizeSelectorNativeFundingDefinition, selectorNativeFundingFamilyId,
  selectorFundingInstanceKey, selectorFundingImmutableParameters, selectorFundingCallArguments, selectorFundingParameterProjection, selectorFundingValue, selectorFundingReadCall, decodeSelectorFundingRead, fundingUint, freezeFundingData,
  type SelectorFundingRead, type SelectorNativeFundingDefinition, type SelectorNativeFundingCandidate } from "./selector-native-funding-definition.js";
export { validateSelectorNativeFundingDefinition, normalizeSelectorNativeFundingDefinition, selectorNativeFundingFamilyId } from "./selector-native-funding-definition.js";

export interface SelectorFundingSource extends FundingSourceDescriptor {
  readonly binding: FundingExecutionBinding;
  readonly liquidityHolder: string;
  readonly liquidityResourceKey: string;
}
interface FundingEvidence { readonly offers: readonly FundingOfferDescriptor[] }
const MAX=(1n<<256n)-1n;
const address=(x:string)=>getAddress(x).toLowerCase();
const fail=(why:string):never=>{throw new Error(`selector funding: ${why}`);};
function result(results:readonly AdapterRequestResult[],id:string):string {
  const found=results.filter(r=>r.id===id);
  if(found.length!==1 || !found[0]!.ok || found[0]!.completion!=="returned")fail(`unresolved read ${id}`);
  return (found[0] as Extract<AdapterRequestResult,{ok:true}>).data;
}
/** Fee is evaluated for the selected amount, never reused from a probe amount. */
export function selectorFundingFee(offer: Pick<FundingOfferDescriptor,"fee"|"feeRate"|"feeScale">, amount:bigint):bigint {
  fundingUint(amount);fundingUint(offer.fee,"flat fee");
  const rate=offer.feeRate??0n,scale=offer.feeScale??1n;fundingUint(rate,"fee rate");fundingUint(scale,"fee scale");
  if(scale===0n || rate>scale)fail("fee ratio out of range");
  const product=amount*rate;if(product>MAX)fail("fee multiplication overflow");
  const fee=offer.fee+(product===0n?0n:(product-1n)/scale+1n);fundingUint(fee,"fee result");return fee;
}
function dataOffset(signature:string,index:number,data:string):number {
  const fn=FunctionFragment.from(signature);
  if(fn.inputs[index]?.type!=="bytes")fail("callback bytes ABI");
  const dynamic=(parameter:ParamType):boolean=>parameter.type==="bytes" || parameter.type==="string" ||
    parameter.baseType==="array" && (parameter.arrayLength===-1 || dynamic(parameter.arrayChildren!)) ||
    parameter.baseType==="tuple" && parameter.components!.some(dynamic);
  const words=(parameter:ParamType):number=>dynamic(parameter)?1:parameter.baseType==="tuple"?parameter.components!.reduce((sum,item)=>sum+words(item),0):
    parameter.baseType==="array"?parameter.arrayLength!*words(parameter.arrayChildren!):1;
  const head=4+32*fn.inputs.slice(0,index).reduce((sum,item)=>sum+words(item),0),bytes=getBytes(data);
  if(!Number.isSafeInteger(head)||head<4||head+32>bytes.length)fail("callback ABI head bounds");
  const offset=Number(BigInt(hexlify(bytes.slice(head,head+32))));
  const start=4+offset+32;if(!Number.isSafeInteger(start)||start<36||start>bytes.length)fail("callback payload bounds");return start;
}
function readRequest(read:SelectorFundingRead,id:string,env:Record<string,unknown>):AdapterRequest {
  return {id,kind:"eth-call",...selectorFundingReadCall(read,env),completion:"return-data"};
}
function env(source:SelectorFundingSource):Record<string,unknown> {return {provider:source.provider,tokenIn:source.asset,args:source.binding.arguments??[]};}
function feeReadId(source:SelectorFundingSource,index:number){return `${source.fundingId}:fee:${index}`;}
function validateBinding(binding:FundingExecutionBinding,definition:SelectorNativeFundingDefinition):FundingExecutionBinding {
  if(!binding || address(binding.provider)==="0x0000000000000000000000000000000000000000" || binding.tokenId!==undefined)fail("ERC20 funding resource binding required");
  if(selectorNativeFundingFamilyId(binding)!==selectorNativeFundingFamilyId(definition))fail("binding selector/ABI differs");
  if(selectorFundingInstanceKey(binding)!==selectorFundingInstanceKey({...binding,
    immutableParameters:selectorFundingImmutableParameters(definition,binding.arguments??[])}))fail("bound ABI arguments differ from instance key");
  return freezeFundingData({...binding,provider:address(binding.provider),asset:address(binding.asset),signature:FunctionFragment.from(binding.signature).format("sighash"),selector:binding.selector.toLowerCase()});
}
export function compileSelectorNativeFundingFamily(raw:unknown):FundingFamilyPlugin<SelectorFundingSource,FundingEvidence,SelectorNativeFundingCandidate> {
  const definition=normalizeSelectorNativeFundingDefinition(raw),{manifest,discovery}=compileSelectorNativeFundingDiscovery(definition),id=manifest.familyId,actionId=manifest.ownedActionAdapterIds[0]!;
  const sourceFor=(rawBinding:FundingExecutionBinding):SelectorFundingSource=>{
    const binding=validateBinding(rawBinding,definition),instance=selectorFundingInstanceKey(binding);
    const environment={provider:binding.provider,tokenIn:binding.asset,args:binding.arguments??[]};
    const read=selectorFundingReadCall(definition.funding.liquidity,environment);
    // The supported liquidity primitive is a declared ERC20 holder balance.
    if(FunctionFragment.from(definition.funding.liquidity.signature).format("sighash")!=="balanceOf(address)" || address(read.to)!==binding.asset || definition.funding.liquidity.result!==0)fail("liquidity must declare the borrowed ERC20 holder balance");
    const holder=address(String(selectorFundingValue(definition.funding.liquidity.args[0]!,environment)));
    const resourceKey=selectorAssetResourceKey({chainId:binding.chainId,target:holder},{address:binding.asset});
    const fundingId=selectorAssetOfferKey(instance,{address:binding.asset});
    return freezeFundingData({binding,provider:binding.provider,asset:binding.asset,liquidityHolder:holder,liquidityResourceKey:resourceKey,
      instanceKey:instance,fundingId,stateKey:fundingId,requiredReadKeys:["balance",...(definition.funding.fee.kind==="rate"?["fee"]:[])]});
  };
  const offerBinding=(offer:FundingOfferDescriptor):SelectorFundingSource=>{
    if(!offer.binding)fail("offer requires provider binding");const source=sourceFor(offer.binding!);
    if(source.fundingId!==offer.fundingId || source.liquidityResourceKey!==offer.liquidityResourceKey || source.liquidityHolder!==offer.liquidityHolder ||
       source.asset!==address(offer.asset) || offer.actionAdapterId!==actionId)fail("offer resource escaped family");return source;
  };
  const repayment=(offer:FundingOfferDescriptor,amount:bigint)=>{
    const source=offerBinding(offer);fundingUint(amount);if(amount===0n||amount>offer.maxBorrow)fail("repayment amount outside current offer");
    const owed=amount+selectorFundingFee(offer,amount);fundingUint(owed,"repayment");
    const node:ResolvedPlanNode=definition.execution.repayment.mode==="transfer"?{adapterId:"erc20-transfer",target:offer.asset,tokenIn:offer.asset,tokenOut:offer.asset,amount:owed,params:{to:source.provider,amount:owed},children:[]}:
      {adapterId:"erc20-approve",target:offer.asset,tokenIn:offer.asset,tokenOut:offer.asset,amount:MaxUint256,params:{spender:source.provider,amount:MaxUint256,minimumAllowance:owed},children:[]};
    return freezeFundingData({requirements:[],nodes:[node]});
  };
  const sourceForNode=(node:ResolvedPlanNode):SelectorFundingSource=>{
    if(node.adapterId!==actionId || node.tokenIn!==node.tokenOut)fail("funding root action/asset");
    const binding=validateBinding(JSON.parse(String(node.params.fundingBinding)),definition),source=sourceFor(binding);
    if(address(node.target)!==binding.provider || address(node.tokenIn)!==binding.asset ||
       node.params.fundingId!==source.fundingId || node.params.fundingResourceKey!==source.liquidityResourceKey)fail("encoded root resource differs");
    fundingUint(node.amount);if(node.amount===0n)fail("funding root amount must be positive");return source;
  };
  const action:ActionAdapter={id:actionId,isWrapper:true,field2Offset:null,
    encode(node,executor,children){
      const binding=sourceForNode(node).binding;
      const fee=selectorFundingFee({fee:fundingUint(node.params.fee),feeRate:fundingUint(node.params.feeRate??"0"),feeScale:fundingUint(node.params.feeScale??"1")},node.amount);
      const environment={provider:binding.provider,tokenIn:binding.asset,args:binding.arguments??[],executor:address(executor),amountIn:node.amount,fee,children:"0x"};
      const cb=new Interface([definition.execution.callback.signature]),cbFn=FunctionFragment.from(definition.execution.callback.signature);
      const expected=cb.encodeFunctionData(cbFn,definition.execution.callback.args.map(x=>selectorFundingValue(x,environment)));
      const incoming=dataOffset(definition.execution.callback.signature,definition.execution.callback.dataArgument,expected),prefix=getBytes(expected);
      // Authenticate ABI selector, all array heads/lengths and the borrowed asset,
      // amount and fee before invoking any child. VM authenticates sender/payload.
      const guard=new RuntimeAmountProgram().calldata(1,0).constant(2,224n).math("shr",1,1,2).constant(2,BigInt(cbFn.selector)).equal(1,2);
      for(let offset=4;offset<incoming-32;offset+=32)guard.calldata(1,offset).constant(2,BigInt(hexlify(prefix.slice(offset,offset+32)))).equal(1,2);
      const payload=concatBytes(runtimeProgramScript(guard.bytes()),children),entry=new Interface([definition.signature]),fn=FunctionFragment.from(definition.signature);
      const data=entry.encodeFunctionData(fn,selectorFundingCallArguments(definition,{...environment,children:hexlify(payload)}));
      const outgoing=dataOffset(definition.signature,selectorFundingParameterProjection(definition).childrenIndex,data);
      return runtimeProgramScript(new RuntimeAmountProgram().call(binding.provider,data,{callback:{incomingOffset:incoming,outgoingOffset:outgoing}}).bytes());
    },
    matchTrace(_target,selector){return selector.toLowerCase()===definition.selector;},
  };
  const program={
    requirements:()=>({transports:["eth-call" as const]}),
    buildRequests({sources}:FundingLiquidityProgramInput<SelectorFundingSource>){return sources.flatMap(source=>{
      sourceFor(source.binding);return [readRequest(definition.funding.liquidity,`${source.fundingId}:balance`,env(source)),
        ...(definition.funding.fee.kind==="rate"?[readRequest(definition.funding.fee.reads[0]!,feeReadId(source,0),env(source))]:[])];
    });},
    buildDependentProgram({programInput,completedRound,initialResults,priorEvidence}:{programInput:FundingLiquidityProgramInput<SelectorFundingSource>;completedRound:number;initialResults:readonly AdapterRequestResult[];priorEvidence:readonly unknown[]}){
      if(definition.funding.fee.kind!=="rate" || completedRound+1>=definition.funding.fee.reads.length)return null;
      const results=collectRequestProgramResults(initialResults,priorEvidence), index=completedRound+1;
      const requests=programInput.sources.map(source=>{
        const previous=decodeSelectorFundingRead(definition.funding.fee.kind==="rate"?definition.funding.fee.reads[index-1]!:definition.funding.liquidity,result(results,feeReadId(source,index-1)));
        return readRequest((definition.funding.fee as Extract<SelectorNativeFundingDefinition["funding"]["fee"],{kind:"rate"}>).reads[index]!,feeReadId(source,index),{...env(source),previous});
      });
      return {requirements:{transports:["eth-call" as const]},requests,decode:(results:readonly AdapterRequestResult[])=>({results})};
    },
    decode({programInput,results}:{programInput:FundingLiquidityProgramInput<SelectorFundingSource>;results:readonly AdapterRequestResult[]}):FundingEvidence {
      return freezeFundingData({offers:programInput.sources.map(source=>{
        const maxBorrow=fundingUint(decodeSelectorFundingRead(definition.funding.liquidity,result(results,`${source.fundingId}:balance`))[definition.funding.liquidity.result],"liquidity");
        const fee=definition.funding.fee.kind==="constant"?fundingUint(definition.funding.fee.amount):0n;
        const feeRate=definition.funding.fee.kind==="rate"?fundingUint(decodeSelectorFundingRead(definition.funding.fee.reads.at(-1)!,result(results,feeReadId(source,definition.funding.fee.reads.length-1)))[definition.funding.fee.reads.at(-1)!.result],"fee rate"):0n;
        const feeScale=definition.funding.fee.kind==="rate"?fundingUint(definition.funding.fee.scale):1n;
        if(feeRate>feeScale)fail("current fee exceeds declared scale");
        return {fundingId:source.fundingId,asset:source.asset,binding:source.binding,liquidityHolder:source.liquidityHolder,liquidityResourceKey:source.liquidityResourceKey,maxBorrow,fee,feeRate,feeScale,actionAdapterId:actionId,
          planningPriority:definition.funding.priority?.planning??0,liquidityPriority:definition.funding.priority?.liquidity??0};
      })});
    },
  };
  return {manifest,discovery,capture:{materialize(descriptor){
      if(descriptor.familyId!==id)fail("capture Family binding differs");
      const data=descriptor.opaqueBinding as unknown as {bindings?:readonly FundingExecutionBinding[];amount?:unknown;minProfit?:unknown};
      if(!data||!Array.isArray(data.bindings)||!data.bindings.length)fail("capture requires selector/provider resources");
      const bindings=data.bindings!.map(binding=>sourceFor(binding).binding),assets=[...new Set(bindings.map(binding=>binding.asset))];
      return freezeFundingData({kind:"funding" as const,assets,bindings,amount:fundingUint(data.amount),minProfit:fundingUint(data.minProfit)});
    }},
    actionAdapters:[bindFamilyOwnedAction({action,descriptor:{adapterId:actionId,lineage:id as never,edgeKind:"flash",action:"flash",canSendValue:false,leavesStandingPositionDefault:false}})],
    funding:{liquidity:{
      sources(assets:readonly string[],bindings?:readonly FundingExecutionBinding[]){
        if(!bindings?.length)fail("Ready must retain selector/provider resource bindings");
        const allowed=new Set(assets.map(address)),sources=new Map<string,SelectorFundingSource>();
        for(const binding of bindings!){const source=sourceFor(binding);if(allowed.has(source.asset))sources.set(source.fundingId,source);}
        if([...allowed].some(asset=>![...sources.values()].some(s=>s.asset===asset)))fail("Ready omitted requested funding asset");
        return freezeFundingData([...sources.values()].sort((a,b)=>a.fundingId.localeCompare(b.fundingId)));
      },program,
      deriveOffers({evidence,sources}:{evidence:FundingEvidence;sources:readonly SelectorFundingSource[]}){
        if(evidence.offers.some(o=>!sources.some(s=>s.fundingId===o.fundingId)))fail("unknown offer source");return evidence.offers;
      },
    },repayment:{mode:definition.execution.repayment.mode,executionResource({node}){
      const source=sourceForNode(node);
      return freezeFundingData({fundingId:source.fundingId,target:source.provider,liquidityHolder:source.liquidityHolder,
        liquidityResourceKey:source.liquidityResourceKey,asset:source.asset,amount:node.amount});
    },buildRepaymentFragment:({offer,amount})=>repayment(offer,amount),
      buildBorrowFragment({offer,amount,minProfit,children}){
        const source=offerBinding(offer);fundingUint(amount);fundingUint(minProfit);if(amount===0n||amount>offer.maxBorrow)fail("borrow amount outside current offer");
        const nodes=children.flatMap(child=>child.nodes),seen=(node:ResolvedPlanNode):void=>{if(node.params.fundingResourceKey===source.liquidityResourceKey)fail("same physical liquidity cannot be borrowed twice in one envelope");node.children.forEach(seen);};nodes.forEach(seen);
        const debt=amount+selectorFundingFee(offer,amount);fundingUint(debt+minProfit,"repayment and profit floor");
        const tail=repayment(offer,amount),guard:ResolvedPlanNode={adapterId:"assert-balance",target:offer.asset,tokenIn:offer.asset,tokenOut:offer.asset,amount:debt+minProfit,params:{},children:[]};
        return freezeFundingData({requirements:children.flatMap(c=>c.requirements),nodes:[{adapterId:actionId,target:source.provider,tokenIn:offer.asset,tokenOut:offer.asset,amount,
          params:{fundingBinding:JSON.stringify(source.binding),fundingId:source.fundingId,fundingResourceKey:source.liquidityResourceKey,fee:offer.fee,feeRate:offer.feeRate??0n,feeScale:offer.feeScale??1n},
          children:[...nodes,guard,...tail.nodes]}]});
      },
    }} };
}
