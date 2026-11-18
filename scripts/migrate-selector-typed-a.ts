/** One-time fdb859a execution migration. Production consumes only emitted v2 JSON. */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { FunctionFragment, Interface, ZeroAddress, MaxUint256 } from "../listener/node_modules/ethers/lib.esm/index.js";
import { E, R, U, check, read, approval, effects, execution, model, math, mathStep, root, upsert, type Data } from "./selector-typed-migration-utils.js";

const report: Data[] = [];
const observedInterfaces:Data[]=[];
const emit = (signature: string, program: Data, family: string, recipe: string, domain: "swap"|"protocol" = "protocol") =>
  report.push(upsert(signature, program, family, recipe, false, domain));
const addr = (v:any) => E("lower", E("address", v));
const positive = (v:any) => E("gt", v, U(0));
const assert = (condition:any,error:string) => ({assert:condition,error});
const get = (v:any,key:any) => E("get",v,key);
const at = (v:any,index:any) => E("at",v,index);
const same = (a:any,b:any) => E("sameAddress",a,b);
const unchanged = (token:any,account:any="$executor",when?:any) => ({kind:"unchanged-token",token,account,...(when===undefined?{}:{when})});
const balance = (id:string,token:any,account:any,capture:string,checks?:any[]) =>
  read(id,token,"function balanceOf(address) view returns(uint256)",[account],{[capture]:0},checks);
const supply = (id:string,token:any,capture:string,checks?:any[]) =>
  read(id,token,"function totalSupply() view returns(uint256)",[],{[capture]:0},checks);
const guard = (id:string,token:any,account:any,expected:any) => balance(id,token,account,id,[check(R(id),"eq",expected)]);
function flow(abi:Data,rows:{id:string,target:any,signature:string,args?:any[],optional?:boolean}[],result:Data):Data {
  for(const row of rows) abi[row.id]=[row.signature];
  return {version:1,steps:[{id:"parameters",requirements:{transports:["eth-call"]},
    requests:rows.map(row=>({id:row.id,kind:"eth-call",to:row.target,data:E("encode",row.id,FunctionFragment.from(row.signature).name,row.args??[]),
      completion:row.optional?"return-or-revert-data":"return-data",required:!row.optional})),result}],result:"$steps.parameters"};
}
const decoded = (id:string,signature:string,optional=false):any => {
  const value=E("decodeCanonical",id,FunctionFragment.from(signature).name,get(E("returned",id),"data"),0);
  return optional?E("if",E("eq",E("shape",id),"returned"),value,null):value;
};
function callStep(id:string,target:any,signature:string,args:any[],save?:Data):Data {
  return {id,call:{target,signature,args,...(save?{save}:{})}};
}
function eventLogs(address:any,topic:string):any {
  return E("filter",E("coalesce","$result.effects.logs",[]),"eventLog",E("and",same("$eventLog.address",address),E("eq",E("lower",at("$eventLog.topics",0)),topic.toLowerCase())));
}
function oneEvent(abiName:string,signature:string,address:any,fields:Data):Data {
  const iface=new Interface([signature]),name=iface.fragments[0].name,topic=iface.getEvent(name)!.topicHash;
  return {observe:["logs"],checks:[assert(E("eq",E("length",eventLogs(address,topic)),1),"exactly one operation event required"),
    assert(E("event",{abi:abiName,name,address,result:"$result",fields}),"operation event and actual balances disagree")]};
}
function domainFor(signature:string):"swap"|"protocol" {
  const selector=FunctionFragment.from(signature).selector.slice(2),file=resolve(root,`listener/src/searcher/venues/selector-native/selector-${selector}-family/selector-${selector}.json`);
  return existsSync(file)?JSON.parse(readFileSync(file,"utf8")).domain??"swap":"protocol";
}
function direction(signature:string,id:string,extra:Data={}):Data {
  return {id,tokenIn:"$descriptor.tokenIn",tokenOut:"$descriptor.tokenOut",taxonomy:domainFor(signature)==="swap"?{slotKind:"swap"}:{slotKind:"protocol",protocolAction:id==="mint"?"convert":id},...extra};
}

function yieldbasis():void {
  const metadata={asset:"function ASSET_TOKEN() view returns(address)",stable:"function STABLECOIN() view returns(address)",
    cryptopool:"function CRYPTOPOOL() view returns(address)",amm:"function amm() view returns(address)",staker:"function staker() view returns(address)"};
  for(const deposit of [false,true])for(const receiver of [false,true]) {
    const signature=deposit?`function deposit(uint256,uint256,uint256${receiver?",address":""}) returns(uint256)`:
      `function withdraw(uint256,uint256${receiver?",address":""}) returns(uint256)`;
    const abi:Data={},result:Data={};
    for(const [id,sig] of Object.entries(metadata))result[id]=addr(decoded(id,sig));
    const depositEvent="event Deposit(address indexed sender,address indexed owner,uint256 assets,uint256 shares)";
    abi.events=[depositEvent];
    const binding={flow:flow(abi,Object.entries(metadata).map(([id,signature])=>({id,target:"$target",signature})),result),
      descriptor:{asset:"$binding.asset",stable:"$binding.stable",cryptopool:"$binding.cryptopool",amm:"$binding.amm",staker:"$binding.staker",
        tokenIn:deposit?"$binding.asset":"$target",tokenOut:deposit?"$target":"$binding.asset"}};
    const direct=receiver,steps:Data[]=[];
    if(deposit)steps.push(read("stableReserve","$descriptor.cryptopool","function balances(uint256) view returns(uint256)",[U(0)],{stableReserve:0},[check(R("stableReserve"),"gte",U(1))]),
      read("assetReserve","$descriptor.cryptopool","function balances(uint256) view returns(uint256)",[U(1)],{assetReserve:0},[check(R("assetReserve"),"gte",U(1))]),
      mathStep("borrowPolicy","balancedDebt",{assets:R("amountIn"),stable:R("stableReserve"),asset:R("assetReserve")},{debt:"debt"},[check(R("debt"),"gte",U(1))]));
    const args=deposit?[R("amountIn"),R("debt"),"$minAmountOut"]:[R("amountIn"),"$minAmountOut"];
    if(receiver)args.push("$recipient");
    const execute=callStep("execute","$target",signature,args,{output:0});
    if(deposit)execute.approval=approval("$target",true);
    steps.push(execute);
    const exec=execution(steps,direct);
    exec.protectedAddresses=["$target","$descriptor.asset","$descriptor.stable","$descriptor.cryptopool","$descriptor.amm","$descriptor.staker"];
    exec.effects[1].equals=R("output");
    exec.effects.push(unchanged("$descriptor.stable"),...(direct?[unchanged("$descriptor.stable","$recipient","$externalRecipient")]:[]));
    const program:Data={parameters:[{path:[0],role:"amountIn"},{path:[deposit?2:1],role:"minimumOut"},...(receiver?[{path:[deposit?3:2],role:"recipient"}]:[])],
      values:{abi},binding,routes:{resources:[{target:"$target"},{target:"$descriptor.cryptopool"},{target:"$descriptor.amm"}]},
      dependencies:["$descriptor.asset","$descriptor.stable","$descriptor.cryptopool","$descriptor.amm","$descriptor.staker"],execution:exec};
    if(deposit){program.runtimeMath=math([model("balancedDebt",["assets","stable","asset"],[["product","mul","assets","stable"],["debt","div","product","asset"]],["debt"])]);
      program.receiptChecks={...oneEvent("events",depositEvent,"$target",{sender:E("address","$executor"),owner:E("address","$executor"),assets:"$amountIn",shares:"$amountOut"}),tokenBalances:[{token:"$descriptor.stable",account:"$executor"}]};}
    emit(signature,program,"yieldbasis-lt",`yieldbasis-lt:${deposit?"deposit":"withdraw"}:${receiver?"receiver":"executor"}`);
  }
}

function balancer():void {
  const signature="function swapSingleTokenExactIn(address pool,address tokenIn,address tokenOut,uint256 exactAmountIn,uint256 minAmountOut,uint256 deadline,bool wethIsEth,bytes userData) payable returns(uint256 amountOut)";
  const abi:Data={},permit="function getPermit2() view returns(address)",vault="function getVault() view returns(address)";
  const getFlow=flow(abi,[{id:"permit",target:"$target",signature:permit},{id:"vault",target:at("$args",0),signature:vault}],{permit2:addr(decoded("permit",permit)),vault:addr(decoded("vault",vault))});
  const steps:Data[]=[mathStep("amountWidth","uint160Bound",{amount:R("amountIn")},{high:"high"},[check(R("high"),"eq",U(0))])];
  for(const [id,amount]of[["clearBefore",U(0)],["setAllowance",R("amountIn")]]as const){steps.push(callStep(id,"$route.tokenIn","function approve(address,uint256) returns(bool)",["$descriptor.permit2",amount],{[`${id}Ok`]:0}));
    steps.at(-1)!.call.checks=[check(R(`${id}Ok`),"eq",U(1))];}
  steps.push(read("inputAllowance","$route.tokenIn","function allowance(address,address) view returns(uint256)",["$executor","$descriptor.permit2"],{inputAllowance:0},[check(R("inputAllowance"),"eq",R("amountIn"))]),
    callStep("permit","$descriptor.permit2","function approve(address,address,uint160,uint48)",["$route.tokenIn","$candidate.target",R("amountIn"),U((1n<<48n)-1n)]),
    callStep("execute","$candidate.target",signature,["$descriptor.pool","$route.tokenIn","$route.tokenOut",R("amountIn"),"$minAmountOut",U(MaxUint256),false,"0x"],{output:0}),
    callStep("clearPermit","$descriptor.permit2","function approve(address,address,uint160,uint48)",["$route.tokenIn","$candidate.target",U(0),U(0)]),
    callStep("clearAfter","$route.tokenIn","function approve(address,uint256) returns(bool)",["$descriptor.permit2",U(0)],{clearAfterOk:0}),
    read("remainingAllowance","$route.tokenIn","function allowance(address,address) view returns(uint256)",["$executor","$descriptor.permit2"],{remainingAllowance:0},[check(R("remainingAllowance"),"eq",U(0))]));
  steps.at(-2)!.call.checks=[check(R("clearAfterOk"),"eq",U(1))];
  const exec=execution(steps,false);exec.effects[1].equals=R("output");
  exec.protectedAddresses=["$candidate.target","$descriptor.pool","$descriptor.permit2","$descriptor.vault","$route.tokenIn","$route.tokenOut"];
  const event="event Swap(address indexed pool,address indexed tokenIn,address indexed tokenOut,uint256 amountIn,uint256 amountOut,uint256 swapFeePercentage,uint256 swapFeeAmount)";
  const program:Data={parameters:[{path:[0],role:"poolId"},{path:[1],role:"tokenIn"},{path:[2],role:"tokenOut"},{path:[3],role:"amountIn"},{path:[4],role:"minimumOut"}],values:{abi},
    binding:{nomination:{poolNamespace:"address-pool"},flow:getFlow,descriptor:{target:at("$args",0),pool:addr(at("$args",0)),permit2:"$binding.permit2",vault:"$binding.vault"}},
    routes:{resource:{target:"$descriptor.vault",poolId:"$descriptor.pool",poolNamespace:"address-pool"}},dependencies:["$candidate.target","$descriptor.permit2","$descriptor.vault","$descriptor.pool"],
    runtimeMath:math([model("uint160Bound",["amount"],[["high","shr","amount",160]],["high"])]),execution:exec,
    observations:{version:1,canonicalIntakeTargets:[],victimSupport:"detect-only",events:[{id:"swap",signature:event,classification:"swap",pool:addr("$args.pool"),
      payload:{pool:addr("$args.pool"),tokenIn:addr("$args.tokenIn"),tokenOut:addr("$args.tokenOut"),amountIn:"$args.amountIn",amountOut:"$args.amountOut"},
      valid:E("and",positive("$args.amountIn"),positive("$args.amountOut"),E("lt","$args.swapFeePercentage",U(10n**18n)),E("lte","$args.swapFeeAmount","$args.amountIn")),requireReadyBinding:true,
      match:E("and",same("$log.address","$descriptor.vault"),same("$pool","$descriptor.pool"),same("$args.tokenIn","$edge.tokenIn"),same("$args.tokenOut","$edge.tokenOut")),
      impact:{pool:"$pool",poolId:E("coalesce","$edge.observationPoolId","$edge.poolId"),tokenIn:addr("$args.tokenIn"),tokenOut:addr("$args.tokenOut"),amountIn:"$args.amountIn",amountOut:"$args.amountOut",matchedAdapterId:"$edge.adapterId"}}]}};
  emit(signature,program,"balancer-v3","balancer-v3:router-exact-input","swap");
  const nested="function swap((uint8 kind,address pool,address tokenIn,address tokenOut,uint256 amountGivenRaw,uint256 limitRaw,bytes userData) params) returns(uint256 amountCalculatedRaw,uint256 amountInRaw,uint256 amountOutRaw)",fn=FunctionFragment.from(nested),selector=fn.selector;
  const file=resolve(root,`listener/src/searcher/venues/selector-native/selector-${selector.slice(2)}-family/selector-${selector.slice(2)}.json`);
  const reason="Observed Vault interface requires its caller's unlock/settle/sendTo transaction context. The fdb Exact encoder executes swapSingleTokenExactIn; no independent Vault-swap execution proof is claimed.";
  const raw={format:"selector-family/v2",selector,signature:fn.format("full"),domain:"swap",activation:{enabled:false,envKey:`SEARCHER_FAMILY_SELECTOR_${selector.slice(2).toUpperCase()}_ENABLED`},
    programs:[],unsupportedReason:reason,meta:{sourceFamily:"balancer-v3",sourceCommit:"fdb859a9b9b606a38c3b7afa52452752849ee465",role:"nested observation interface"}};
  if(!existsSync(file)||!JSON.parse(readFileSync(file,"utf8")).programs?.length){mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(raw,null,2)+"\n");}
  observedInterfaces.push({selector,signature:fn.format("full"),file:file.slice(root.length+1),reason});
}

const NATIVE="0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",WETH="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const poolToken="function lp_token() view returns(address)",poolTokenAlt="function token() view returns(address)",
  coinUint="function coins(uint256) view returns(address)",coinSigned="function coins(int128) view returns(address)",
  basePool="function base_pool() view returns(address)",metaPool="function pool() view returns(address)";
const nonzeroAddress=(value:any)=>E("if",E("and",E("defined",value),E("ne",E("lower",value),ZeroAddress)),addr(value),null);
const choice=(...values:any[]):any=>values.reduceRight((next,value)=>E("coalesce",value,next),null);
const poolAsset=(value:any)=>E("if",same(value,NATIVE),WETH,value);
function curveBinding(signature:string,mint:boolean,index:any,length:number|undefined):Data {
  const abi:Data={},rows=[{id:"lp",target:"$target",signature:poolToken,optional:true},{id:"token",target:"$target",signature:poolTokenAlt,optional:true},
    {id:"coinU",target:"$target",signature:coinUint,args:[index],optional:true},{id:"coinI",target:"$target",signature:coinSigned,args:[index],optional:true},
    {id:"basePool",target:"$target",signature:basePool,optional:true},{id:"metaPool",target:"$target",signature:metaPool,optional:true}];
  const coin=choice(nonzeroAddress(decoded("coinU",coinUint,true)),nonzeroAddress(decoded("coinI",coinSigned,true)),mint?"$scope.tokenIn":"$scope.tokenOut");
  const lp=choice(nonzeroAddress(decoded("lp",poolToken,true)),nonzeroAddress(decoded("token",poolTokenAlt,true)),mint?"$scope.tokenOut":"$scope.tokenIn","$target");
  const binding={flow:flow(abi,rows,{coin,lp,basePool:nonzeroAddress(decoded("basePool",basePool,true)),metaPool:nonzeroAddress(decoded("metaPool",metaPool,true)),
      hasTokenGetter:nonzeroAddress(decoded("token",poolTokenAlt,true))}),
    descriptor:{coin:"$binding.coin",lp:"$binding.lp",basePool:"$binding.basePool",metaPool:"$binding.metaPool",hasTokenGetter:"$binding.hasTokenGetter",index,
      tokenIn:mint?poolAsset("$binding.coin"):"$binding.lp",tokenOut:mint?"$binding.lp":poolAsset("$binding.coin")},
    match:mint?E("and",...(length===undefined?[E("gte",E("length",at("$descriptor.args",0)),2),E("lte",E("length",at("$descriptor.args",0)),8)]:[E("eq",E("length",at("$descriptor.args",0)),length)]),
      E("every",at("$descriptor.args",0),"amount",E("if",E("eq","$index",E("number","$descriptor.index")),positive("$amount"),E("eq","$amount",U(0))))):
      E("and",E("gte",E("uint","$descriptor.index"),U(0)),E("lte",E("uint","$descriptor.index"),U(7)))};
  return {abi,binding};
}
function curveParams(mint:boolean,index:number|undefined,receiver:boolean,booleanReceiver:boolean):Data[] {
  return [{path:mint?[0,index!]:[0],role:"amountIn"},{path:[mint?1:2],role:"minimumOut"},
    ...(!mint?[{path:[1],role:"bound"}]:[]),...(receiver?[{path:[mint?(booleanReceiver?3:2):(booleanReceiver?4:3)],role:"recipient"}]:[])];
}
function curveArgs(mint:boolean,index:any,length:number|undefined,receiver:boolean,booleanReceiver:boolean):any[] {
  const amounts=length===undefined?E("map",at("$descriptor.args",0),"ignored",E("if",E("eq","$index",E("number","$descriptor.index")),R("amountIn"),U(0))):
    Array.from({length},(_,i)=>typeof index==="number"?i===index?R("amountIn"):U(0):E("if",E("eq",E("uint","$descriptor.index"),U(i)),R("amountIn"),U(0)));
  return [...(mint?[amounts,"$minAmountOut"]:[R("amountIn"),"$descriptor.index","$minAmountOut"]),...(booleanReceiver?[false]:[]),...(receiver?["$recipient"]:[])];
}
function curveGeneric(signature:string,mint:boolean,index:number|undefined,length:number|undefined,receiver:boolean,booleanReceiver:boolean):Data {
  const bound=curveBinding(signature,mint,mint?U(index!):at("$args",1),length),assets={input:mint?E("if",same("$descriptor.coin",NATIVE),"native","erc20"):"erc20",output:mint?"erc20":E("if",same("$descriptor.coin",NATIVE),"native","erc20")};
  const native=E("eq",mint?"$route.executionAssets.input":"$route.executionAssets.output","native");
  const call=callStep("execute","$target",signature,curveArgs(mint,index,length,receiver,booleanReceiver));
  if(mint)call.call.value=E("if",native,R("amountIn"),U(0));
  // A real composite zap has both child-pool getters and a separate LP token.
  // Its sweep/accounting recipe below owns these calls; this is an executable
  // parameter shape, not a factory/code identity gate.
  bound.binding.match=E("and",bound.binding.match,E("not",E("and",E("defined","$descriptor.basePool"),E("defined","$descriptor.metaPool"),E("defined","$descriptor.hasTokenGetter"))));
  const steps:Data[]=[];
  if(mint)steps.push({id:"executeErc20",when:E("not",native),approval:approval("$target",false),call:{...call.call,value:U(0)}},
    {...call,id:"executeNative",when:native});
  else steps.push({...call,approval:approval("$target",false)});
  const exec=execution(steps,receiver);if(receiver)exec.settlement.directOutputWhen=E("not",native);
  exec.effects=[E("if",E("eq",assets.input,"native"),[{kind:"debit",asset:"native",account:"$executor",equals:R("amountIn")}],[{kind:"debit",token:"$route.tokenIn",account:"$executor",equals:R("amountIn")}]),
    E("if",E("eq",assets.output,"native"),[{kind:"credit",asset:"native",account:"$executor",minimum:"$minAmountOut"}],[{kind:"credit",token:"$route.tokenOut",account:receiver?"$recipient":"$executor",minimum:"$minAmountOut"}]),
    {kind:"unchanged-native",when:E("not",native)},...(receiver?[unchanged("$route.tokenOut","$executor","$externalRecipient"),unchanged("$route.tokenIn","$recipient","$externalRecipient")]:[])];
  return {parameters:curveParams(mint,index,receiver,booleanReceiver),values:{abi:bound.abi},binding:bound.binding,
    routes:{directions:[direction(signature,mint?"mint":"redeem",{executionAssets:assets})]},
    
    dependencies:["$descriptor.lp",E("if",same("$descriptor.coin",NATIVE),WETH,"$descriptor.coin"),E("if",E("defined","$descriptor.basePool"),"$descriptor.basePool","$target")],execution:exec};
}
function curveNg(signature:string,mint:boolean,index:number|undefined,length:number|undefined,receiver:boolean):Data {
  const p=curveGeneric(signature,mint,index,length,receiver,false);
  const baseMatch=p.binding.match;p.binding.match=E("and",baseMatch,E("not",same("$descriptor.coin",NATIVE)));
  const direct=receiver,outAccount=direct?"$recipient":"$executor",steps:Data[]=[
    balance("inputBefore","$route.tokenIn","$executor","inputBefore"),balance("outputBefore","$route.tokenOut",outAccount,"outputBefore")];
  const execute=callStep("execute","$target",signature,curveArgs(mint,index,length,receiver,false),{returnedOutput:0});
  if(mint)execute.approval=approval("$target",false);
  steps.push(execute,balance("inputAfter","$route.tokenIn","$executor","inputAfter"),balance("outputAfter","$route.tokenOut",outAccount,"outputAfter"),
    mathStep("boundedRounding","boundedRounding",{requested:R("amountIn"),beforeIn:R("inputBefore"),afterIn:R("inputAfter"),beforeOut:R("outputBefore"),afterOut:R("outputAfter"),returned:R("returnedOutput"),tolerance:"$executionPolicy.executionRoundingRawUnits"},
      {spent:"spent",received:"received",remaining:"remaining",outLower:"outLower",returnLower:"returnLower"},[check(R("spent"),"gte",U(1)),check(R("received"),"gte","$minAmountOut"),check(R("returnedOutput"),"gte",U(1))]));
  const exec=execution(steps,direct);exec.effects[0]={kind:"debit",token:"$route.tokenIn",account:"$executor",equals:R("spent"),maximum:R("amountIn")};exec.effects[1].equals=R("received");
  p.execution=exec;
  p.runtimeMath=math([model("boundedRounding",["requested","beforeIn","afterIn","beforeOut","afterOut","returned","tolerance"],[
    ["spent","sub","beforeIn","afterIn"],["dust","sub","requested","spent"],["remaining","sub","tolerance","dust"],
    ["received","sub","afterOut","beforeOut"],["outPlus","add","received","tolerance"],["outLower","sub","outPlus","returned"],
    ["returnPlus","add","returned","tolerance"],["returnLower","sub","returnPlus","received"]],["spent","received","remaining","outLower","returnLower"])]);
  return p;
}
function curveZap(signature:string,mint:boolean,index:number|undefined):Data {
  const abi:Data={},rows=[{id:"meta",target:"$target",signature:metaPool},{id:"base",target:"$target",signature:basePool},
    {id:"lp",target:"$target",signature:poolTokenAlt},{id:"baseLp",target:"$target",signature:coinUint,args:[U(1)]},
    {id:"metaCoin",target:"$target",signature:coinUint,args:[U(0)]},
    ...[0,1,2].map(i=>({id:`baseCoin${i}`,target:"$target",signature:"function base_coins(uint256) view returns(address)",args:[U(i)]}))];
  const result=Object.fromEntries(rows.map(row=>[row.id,addr(decoded(row.id,row.signature))]));
  const ix=mint?U(index!):at("$args",1),coin=at(["$binding.metaCoin","$binding.baseCoin0","$binding.baseCoin1","$binding.baseCoin2"],E("number",ix));
  const binding={flow:flow(abi,rows,result),descriptor:{index:ix,metaPool:"$binding.meta",basePool:"$binding.base",baseLp:"$binding.baseLp",lp:"$binding.lp",
    tokenIn:mint?coin:"$binding.lp",tokenOut:mint?"$binding.lp":coin},
    match:mint?E("every",at("$descriptor.args",0),"amount",E("if",E("eq","$index",index),positive("$amount"),E("eq","$amount",U(0)))):E("and",E("gte",E("uint","$descriptor.index"),U(0)),E("lte",E("uint","$descriptor.index"),U(3)))};
  const steps:Data[]=[guard("emptyBaseBefore","$descriptor.baseLp","$target",U(0)),guard("emptyOutputBefore","$route.tokenOut","$target",U(0)),
    supply("baseSupplyBefore","$descriptor.baseLp","baseSupplyBefore")];
  const execute=callStep("execute","$target",signature,curveArgs(mint,index,4,false,false),{output:0});execute.approval=approval("$target",false);steps.push(execute,
    guard("emptyBaseAfter","$descriptor.baseLp","$target",U(0)),guard("emptyOutputAfter","$route.tokenOut","$target",U(0)),
    supply("baseSupplyAfter","$descriptor.baseLp","baseSupplyAfter"),
    {id:"baseSupplyUnchanged",when:E("eq",E("uint","$descriptor.index"),U(0)),static:true,call:{target:"$descriptor.baseLp",signature:"function totalSupply() view returns(uint256)",args:[],save:{baseSupplyCheck:0},checks:[check(R("baseSupplyCheck"),"eq",R("baseSupplyBefore"))]}},
    {id:"baseSupplyChanged",when:E("gt",E("uint","$descriptor.index"),U(0)),math:{model:"supplyMovement",inputs:{before:R("baseSupplyBefore"),after:R("baseSupplyAfter")},outputs:{delta:"baseMovement"},checks:[check(R("baseMovement"),"gte",U(1))]}});
  const exec=execution(steps,false);exec.effects[1].equals=R("output");exec.effects.push(unchanged("$descriptor.baseLp"),unchanged("$route.tokenIn","$target"),
    {kind:"supply",token:"$descriptor.lp",direction:mint?"increase":"decrease",equals:R(mint?"output":"amountIn")});
  exec.protectedAddresses=["$target","$descriptor.metaPool","$descriptor.basePool","$descriptor.baseLp","$descriptor.lp","$route.tokenIn","$route.tokenOut"];
  return {parameters:curveParams(mint,index,false,false),values:{abi},binding,routes:{resources:[{target:"$descriptor.metaPool"},{target:"$descriptor.basePool"}]},
    dependencies:["$descriptor.metaPool","$descriptor.basePool","$descriptor.baseLp","$descriptor.lp"],runtimeMath:math([model("supplyMovement",["before","after"],[["delta","sub",mint?"after":"before",mint?"before":"after"]],["delta"])]),execution:exec};
}
function curveClaim(signature:string,receiver:boolean,booleanReceiver:boolean):Data {
  const p=curveGeneric(signature,false,undefined,undefined,receiver,booleanReceiver),abi=p.values.abi,step=p.binding.flow.steps[0];
  const feeGetter="function fee_receiver() view returns(address)",factoryGetter="function factory() view returns(address)";
  for(const row of [{id:"coin0",target:"$target",signature:coinUint,args:[U(0)]},{id:"coin1",target:"$target",signature:coinUint,args:[U(1)]},
    {id:"feeReceiver",target:"$target",signature:feeGetter,args:[]},{id:"factory",target:"$target",signature:factoryGetter,args:[]}]){
    abi[row.id]=[row.signature];step.requests.push({id:row.id,kind:"eth-call",to:row.target,data:E("encode",row.id,FunctionFragment.from(row.signature).name,row.args),completion:"return-data",required:true});
    step.result[row.id]=addr(decoded(row.id,row.signature));p.binding.descriptor[row.id]=`$binding.${row.id}`;
  }
  p.binding.match=E("and",p.binding.match,same("$descriptor.lp","$descriptor.target"),E("lte",E("uint","$descriptor.index"),U(1)),
    E("not",same("$descriptor.coin0",NATIVE)),E("not",same("$descriptor.coin1",NATIVE)),
    same("$descriptor.coin",at(["$descriptor.coin0","$descriptor.coin1"],E("number","$descriptor.index"))));
  const account=receiver?"$recipient":"$executor",steps:Data[]=[read("feeBefore","$target",feeGetter,[],{feeBefore:0},[check(R("feeBefore"),"eq",E("uint","$descriptor.feeReceiver"))]),
    balance("outputBefore","$route.tokenOut",account,"outputBefore")];
  for(const i of [0,1])steps.push(balance(`poolBefore${i}`,`$descriptor.coin${i}`,"$target",`poolBefore${i}`),balance(`feeBefore${i}`,`$descriptor.coin${i}`,"$descriptor.feeReceiver",`feeBefore${i}`));
  steps.push(...p.execution.steps,balance("outputAfter","$route.tokenOut",account,"outputAfter"),
    mathStep("actualReceipt","actualReceipt",{before:R("outputBefore"),after:R("outputAfter")},{output:"actualOutput"},[check(R("actualOutput"),"gte","$minAmountOut")]));
  for(const i of [0,1])steps.push(balance(`poolAfter${i}`,`$descriptor.coin${i}`,"$target",`poolAfter${i}`),balance(`feeAfter${i}`,`$descriptor.coin${i}`,"$descriptor.feeReceiver",`feeAfter${i}`),
    mathStep(`accounting${i}`,"poolAccounting",{poolBefore:R(`poolBefore${i}`),poolAfter:R(`poolAfter${i}`),feeBefore:R(`feeBefore${i}`),feeAfter:R(`feeAfter${i}`),
      output:E("if",E("eq",E("uint","$descriptor.index"),U(i)),R("actualOutput"),U(0))},{poolDebit:`poolDebit${i}`,feeCredit:`feeCredit${i}`,expectedDebit:`expectedDebit${i}`},[check(R(`poolDebit${i}`),"eq",R(`expectedDebit${i}`))]));
  steps.push(read("feeAfter","$target",feeGetter,[],{feeAfter:0},[check(R("feeAfter"),"eq",R("feeBefore"))]));
  const exec=execution(steps,receiver);exec.effects[1].equals=R("actualOutput");exec.effects.push({kind:"supply",token:"$descriptor.lp",direction:"decrease",equals:R("amountIn")},
    unchanged("$descriptor.lp","$target"),unchanged("$descriptor.lp","$descriptor.feeReceiver"),
    unchanged(E("if",E("eq",E("uint","$descriptor.index"),U(0)),"$descriptor.coin1","$descriptor.coin0")),
    ...(receiver?[unchanged(E("if",E("eq",E("uint","$descriptor.index"),U(0)),"$descriptor.coin1","$descriptor.coin0"),"$recipient","$externalRecipient")]:[]));
  exec.envelopes=[{effects:exec.effects.slice(5,8)},{effects:exec.effects.slice(8)},{effects:exec.effects.slice(2,4)}].filter(group=>group.effects.length);
  exec.effects=[exec.effects[0],exec.effects[1],exec.effects[4]];
  exec.protectedAddresses=["$target","$descriptor.coin0","$descriptor.coin1","$descriptor.feeReceiver","$descriptor.factory"];
  p.execution=exec;p.runtimeMath=math([model("actualReceipt",["before","after"],[["output","sub","after","before"]],["output"]),
    model("poolAccounting",["poolBefore","poolAfter","feeBefore","feeAfter","output"],[["poolDebit","sub","poolBefore","poolAfter"],["feeCredit","sub","feeAfter","feeBefore"],["expectedDebit","add","feeCredit","output"]],["poolDebit","feeCredit","expectedDebit"])]);
  p.dependencies.push("$descriptor.coin0","$descriptor.coin1","$descriptor.feeReceiver","$descriptor.factory");
  const claimSignature="event ClaimAdminFee(address indexed admin,uint256[2] tokens)",transferSignature="event Transfer(address indexed sender,address indexed receiver,uint256 value)";
  abi.claims=[claimSignature,transferSignature];const events=new Interface(abi.claims),claimTopic=events.getEvent("ClaimAdminFee")!.topicHash,transferTopic=events.getEvent("Transfer")!.topicHash;
  const claims=eventLogs("$target",claimTopic),claim=E("decodeEventCanonical","claims","ClaimAdminFee",at(claims,0));
  const fees=E("if",E("eq",E("length",claims),0),[U(0),U(0)],get(claim,"tokens"));
  const transfers=E("filter",E("coalesce","$result.effects.logs",[]),"transferLog",E("and",E("some",["$descriptor.coin0","$descriptor.coin1","$descriptor.lp"],"coin",same("$coin","$transferLog.address")),E("eq",E("lower",at("$transferLog.topics",0)),transferTopic.toLowerCase())));
  const expected=[{token:"$descriptor.lp",from:"$executor",to:ZeroAddress,value:"$amountIn"},
    ...[0,1].map(i=>({token:`$descriptor.coin${i}`,from:"$target",to:"$descriptor.feeReceiver",value:at(fees,i)})),
    {token:"$route.tokenOut",from:"$target",to:"$executor",value:"$amountOut"}];
  const decodedTransfer=E("decodeEventCanonical","claims","Transfer","$transferLog");
  const matchesExpected=E("and",same("$transferLog.address","$expected.token"),same(get(decodedTransfer,"sender"),"$expected.from"),same(get(decodedTransfer,"receiver"),"$expected.to"));
  const tokenRows=E("flatMap",["$descriptor.coin0","$descriptor.coin1","$descriptor.lp"],"coin",E("map",["$target","$descriptor.feeReceiver","$executor"],"account",{token:"$coin",account:"$account"}));
  const delta=(token:any,account:any)=>get(at(E("filter","$result.effects.tokenDeltas","observed",E("and",same("$observed.token",token),same("$observed.account",account))),0),"delta");
  // Exact source receipt: every nominated account/token pair is present once;
  // arbitrary extra transfers and supply changes cannot hide behind a quote.
  p.receiptChecks={observe:["logs","total-supply-delta"],tokenBalances:tokenRows,totalSupplies:["$descriptor.lp"],checks:[
    assert(E("lte",E("length",claims),1),"duplicate fee claim event"),
    assert(E("if",E("eq",E("length",claims),0),true,E("and",same(get(claim,"admin"),"$descriptor.feeReceiver"),E("not",same("$descriptor.feeReceiver",ZeroAddress)))) ,"fee claim recipient mismatch"),
    assert(E("every",transfers,"transferLog",E("some",expected,"expected",matchesExpected)),"unexplained fee, burn or output transfer"),
    assert(E("every",expected,"expected",E("eq",E("sumUint",E("map",E("filter",transfers,"transferLog",matchesExpected),"transferLog",get(decodedTransfer,"value"))),"$expected.value")),"fee/burn transfer amounts disagree"),
    assert(E("eq",get(at(E("filter","$result.effects.totalSupplyDeltas","observed",same("$observed.token","$descriptor.lp")),0),"delta"),E("sub",U(0),"$amountIn")),"LP supply differs from burn") ]};
  for(const i of [0,1])p.receiptChecks.checks.push(
    assert(E("eq",delta(`$descriptor.coin${i}`,"$descriptor.feeReceiver"),at(fees,i)),"actual fee receipt differs from event"),
    assert(E("eq",delta(`$descriptor.coin${i}`,"$target"),E("sub",U(0),E("add",at(fees,i),E("if",E("eq",E("uint","$descriptor.index"),U(i)),"$amountOut",U(0))))),"pool debit differs from output plus fees"));
  p.receiptChecks.checks.push(assert(E("eq",delta("$descriptor.lp","$target"),U(0)),"pool LP inventory changed"),
    assert(E("eq",delta("$descriptor.lp","$descriptor.feeReceiver"),U(0)),"fee account LP inventory changed"));
  return p;
}
function curve():void {
  for(const length of [2,3,4])for(const mode of ["none","receiver","booleanReceiver"]){
    const receiver=mode!=="none",booleanReceiver=mode==="booleanReceiver",signature=`function add_liquidity(uint256[${length}],uint256${booleanReceiver?",bool":""}${receiver?",address":""})`;
    for(let index=0;index<length;index++)emit(signature,curveGeneric(signature,true,index,length,receiver,booleanReceiver),"curve-lp",`curve-lp:fixed${length}:${mode}:mint:${index}`);
    if(length===2&&mode==="none")for(let index=0;index<2;index++){
      const p=curveGeneric(signature+" returns(uint256)",true,index,2,false,false);p.execution.steps[0].approval.requireBool=true;
      p.execution.steps.forEach((s:Data)=>s.call.save={output:0});p.execution.effects[1]=E("map",p.execution.effects[1],"effect",E("merge","$effect",{equals:R("output")}));
      emit(signature,p,"curve-lp",`curve-lp:stable-base:mint:${index}`);
    }
    if(length===2&&mode==="receiver")for(let index=0;index<2;index++)emit(signature,curveNg(signature+" returns(uint256)",true,index,2,true),"curve-lp",`curve-lp:ng-fixed2:mint:${index}`);
    if(length===4&&mode==="none")for(let index=0;index<4;index++)emit(signature,curveZap(signature+" returns(uint256)",true,index),"curve-lp",`curve-lp:zap:mint:${index}`);
  }
  for(const receiver of [false,true]){const signature=`function add_liquidity(uint256[],uint256${receiver?",address":""}) returns(uint256)`;
    for(let index=0;index<8;index++)emit(signature,curveNg(signature,true,index,undefined,receiver),"curve-lp",`curve-lp:ng-dynamic:${receiver?"receiver":"executor"}:mint:${index}`);}
  for(const indexType of ["int128","uint256"])for(const mode of ["none","receiver","booleanReceiver"]){
    const receiver=mode!=="none",booleanReceiver=mode==="booleanReceiver",signature=`function remove_liquidity_one_coin(uint256,${indexType},uint256${booleanReceiver?",bool":""}${receiver?",address":""})`;
    emit(signature,curveGeneric(signature,false,undefined,undefined,receiver,booleanReceiver),"curve-lp",`curve-lp:${indexType}:${mode}:redeem`);
    if(indexType==="int128"&&mode==="receiver")emit(signature,curveNg(signature+" returns(uint256)",false,undefined,undefined,true),"curve-lp","curve-lp:ng:redeem");
    if(indexType==="int128"&&mode==="none")emit(signature,curveZap(signature+" returns(uint256)",false,undefined),"curve-lp","curve-lp:zap:redeem");
    if(indexType==="uint256")emit(signature,curveClaim(signature,receiver,booleanReceiver),"curve-lp",`curve-lp:fee-claim:${mode}:redeem`);
    if(indexType==="int128"&&mode==="none"){
      const p=curveGeneric(signature+" returns(uint256)",false,undefined,undefined,false,false);delete p.execution.steps[0].approval;p.execution.steps[0].call.save={output:0};
      p.execution.effects[1]=E("map",p.execution.effects[1],"effect",E("merge","$effect",{equals:R("output")}));emit(signature,p,"curve-lp","curve-lp:stable-base:redeem");
    }
  }
}

yieldbasis();
balancer();
curve();
const output=resolve(root,"listener/src/searcher/generated/selector-typed-a-migration.generated.json");
mkdirSync(dirname(output),{recursive:true});
const sourceMappings=[
  {sourceFiles:["listener/src/searcher/venues/protocols/yieldbasis-lt-family/execution.ts","listener/src/searcher/venues/protocols/yieldbasis-lt-family/deposit.ts"],
    functions:["withdraw(uint256,uint256)","withdraw(uint256,uint256,address)","deposit(uint256,uint256,uint256)","deposit(uint256,uint256,uint256,address)"],recipes:report.filter(r=>r.sourceFamily==="yieldbasis-lt").map(r=>r.recipe),
    preserved:["four actual entry selectors and executor/explicit receiver settlement","exact caller asset debit and returned output/actual receipt equality","current cryptopool reserve-derived checked uint256 deposit debt","exact bool-checked approval and cleanup","stable/native/external inventory conservation","unique Deposit receipt matching actual assets and minted shares"],
    decisions:["no false totalSupply=userMint equality: the old LT can rebase staker shares","emergency_withdraw was already excluded: signed stable debt/output and a second caller asset are not silently converted to a one-input route"]},
  {sourceFiles:["listener/src/searcher/venues/swaps/balancer-v3-family/execution.ts","listener/src/searcher/venues/swaps/balancer-v3-family/action.ts","listener/src/searcher/venues/swaps/balancer-v3-family/discovery.ts"],
    functions:["swapSingleTokenExactIn(address,address,address,uint256,uint256,uint256,bool,bytes)"],recipes:report.filter(r=>r.sourceFamily==="balancer-v3").map(r=>r.recipe),
    preserved:["uint160 input width","token-to-Permit2 allowance and Permit2-to-router allowance cleared after execution","deadline and ERC20-mode/userData execution policy","pool/vault physical resource and Ready-bound Swap observation","actual output returned by router and fresh executor receipt"],
    decisions:["Vault.swap tuple ABI was discovery-only in fdb; Router owns unlock, Permit2 transfer, settle and sendTo. Retained as explicit non-entry, not counted as a lost Exact."]},
  {sourceFiles:["listener/src/searcher/venues/protocols/curve-lp-family/execution.ts"],functions:["lpProgram: two-coin base mint/redeem"],recipes:report.filter(r=>r.recipe.includes(":stable-base:")).map(r=>r.recipe),
    preserved:["single nonzero fixed-array input","base return word equals fresh LP/coin receipt","bool-checked mint approval and cleanup","exact input debit and minimum output"]},
  {sourceFiles:["listener/src/searcher/venues/protocols/curve-lp-family/generic.ts","listener/src/searcher/venues/protocols/curve-lp-family/tricrypto-ng.ts"],functions:["genericRawProgram: fixed2/3/4 add","genericRawProgram: signed/unsigned one-coin remove","none/address/bool-address receivers"],recipes:report.filter(r=>/^curve-lp:(fixed|int128:|uint256:)/.test(r.recipe)).map(r=>r.recipe),
    preserved:["all fixed ABI array lengths and one-input index directions","ordinary no-return variants","exact approval/allowance cleanup","native coin-WETH boundary and no external settlement on native sides","current actual SIM replaces analytical prices; Tricrypto admin-fee LP mint does not imply userMint=supplyDelta"]},
  {sourceFiles:["listener/src/searcher/venues/protocols/curve-lp-family/ng.ts"],functions:["ngProgram: dynamic 2..8-coin add","ngProgram: fixed2 meta add","ngProgram: signed one-coin remove"],recipes:report.filter(r=>r.recipe.startsWith("curve-lp:ng")).map(r=>r.recipe),
    preserved:["positive spent<=requested, no old inventory, central 0/1 raw-unit remainder bound","positive actual output and bounded return/receipt rounding","receiver-side inventory guards","zero/set/clear allowance verification"],
    decisions:["index-specific parameter recipes prevent ABI dynamic-array directions from deduplicating before token metadata exists","central rounding is a sealed binding policy; JSON cannot enlarge it"]},
  {sourceFiles:["listener/src/searcher/venues/protocols/curve-lp-family/zap.ts"],functions:["zapProgram: four mint indices","zapProgram: one-coin redeem"],recipes:report.filter(r=>r.recipe.includes(":zap:")).map(r=>r.recipe),
    preserved:["meta/base physical resources","real zap baseLP/output inventories must be zero before and after execution","caller baseLP and zap input inventory unchanged","LP total supply change equals actual mint/burn","baseLP supply direction/zero condition follows selected underlying index","actual output equals return and input is exact"]},
  {sourceFiles:["listener/src/searcher/venues/protocols/curve-lp-family/generic-effects.ts"],functions:["cryptoClaimProgram","decodeCryptoClaim"],recipes:report.filter(r=>r.recipe.includes(":fee-claim:")).map(r=>r.recipe),
    preserved:["current fee receiver stable across execution and distinct from actors/pool/coins","per-coin pool debit equals actual fee receipt plus actual user output","exact LP supply burn and unchanged pool/fee LP inventories","canonical unique optional ClaimAdminFee and complete burn/fee/output Transfer sums","complete requested token/account/supply receipt scopes","external receiver inventory via nested independent register scopes"]}
];
writeFileSync(output,JSON.stringify({sourceCommit:"fdb859a9b9b606a38c3b7afa52452752849ee465",format:"selector-family/v2",executionRecipes:report.length,executionSelectors:new Set(report.map(r=>r.selector)).size,
  sourceMappings,observedInterfaces,activationPolicy:"All three original typed families were disabled. New selector families remain disabled; appending to an existing selector preserves its prior activation.",entries:report},null,2)+"\n");
console.log(JSON.stringify({programs:report.length,selectors:new Set(report.map(row=>row.selector)).size,report:output.slice(root.length+1)}));
