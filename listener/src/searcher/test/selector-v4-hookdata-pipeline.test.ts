import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AbiCoder,Interface,ZeroAddress,keccak256,toBeHex} from 'ethers';
import {discoverFamilyEventEdges} from '../../../../scripts/selector-family-event-discovery.mjs';
import {renderIndependentTraceEdges,ready21Window} from '../../../../scripts/independent-trace-edges.mjs';
import {exportIndependentLive} from '../../../../scripts/selector-independent-live-export.mjs';
import {loadSqlPriceEdges,sqlDirectionId} from '../sql-edge-price-index.js';
import {normalizeSelectorNativeExecutionDefinition} from '../venues/selector-native-definition.js';
import {PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog} from '../venues/production-family-composition.js';
import {issueSelectorCurrentSourceRoutes} from '../venues/selector-source-issued-route.js';
import {inspectRuntime} from './runtime-program-testkit.js';
import v4Rule from '../venues/selector-native/selector-48c89491-family/edge-discovery.json';
import {discover as discoverV4} from '../venues/selector-native/selector-48c89491-family/discover.mjs';
import v4DefRaw from '../venues/selector-native/selector-48c89491-family/selector-48c89491.json';
import buyGemRule from '../venues/selector-native/selector-8d7ef9bb-family/edge-discovery.json';
import {discover as discoverBuyGem} from '../venues/selector-native/selector-8d7ef9bb-family/discover.mjs';

const sha=(x:Buffer|string)=>createHash('sha256').update(x).digest('hex');
const addr=(n:number)=>toBeHex(n,20).toLowerCase();
const word=(n:bigint|number)=>BigInt(n).toString(16).padStart(64,'0');
const coder=AbiCoder.defaultAbiCoder();
const manager='0x000000000004444c5dc75cb358380d2e3de08a90';
const positionManager='0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e';

const v4Iface=new Interface([
 'function unlock(bytes) returns (bytes)',
 'function unlockCallback(bytes) returns (bytes)',
 'function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params,bytes hookData) returns (int256)',
 'function take(address currency,address recipient,uint256 amount)',
 'function sync(address currency)',
 'function settle() payable returns (uint256)',
 'function poolKeys(bytes25) view returns (address,address,uint24,int24,address)',
 'function transfer(address,uint256) returns (bool)',
 'function balanceOf(address) view returns (uint256)',
 'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)',
]);

test('V4 discover.mjs extracts and disambiguates hookData across swaps with settlement receipts',()=>{
 const router=addr(1),wallet=addr(2),tokA=addr(0x10),tokB=addr(0x20),tokC=addr(0x30),hook1=addr(0x88),hook2=addr(0x99);
 const key1=[tokA,tokB,3000,60,hook1] as const,key2=[tokB,tokC,500,10,hook2] as const;
 const id1=keccak256(coder.encode(['address','address','uint24','int24','address'],key1));
 const id2=keccak256(coder.encode(['address','address','uint24','int24','address'],key2));
 const hookData1='0xbeadedbeadeadbeadedbeadeddeabeadbeadbeadbeadadedbeadeddeabeadaed';
 const hookData2='0x1122334455';
 const erc20=new Interface(['function transfer(address,uint256) returns (bool)','event Transfer(address indexed from,address indexed to,uint256 amount)']);

 function runOneTx(key:readonly [string,string,number,number,string],poolId:string,hookData:string,amtIn:bigint,amtOut:bigint){
  const swapData=v4Iface.encodeFunctionData('swap',[key,[true,-amtIn,4295128740n],hookData]).toLowerCase();
  const frames=[
   {path:'',sender:wallet,target:router,input:'0x',ok:true,kind:'call',value:'0'},
   {path:'0',sender:router,target:manager,input:'0x48c89491'+'00'.repeat(64),ok:true,kind:'call',value:'0'},
   {path:'0,0',sender:manager,target:router,input:'0x91dd7346'+'00'.repeat(64),ok:true,kind:'call',value:'0'},
   {path:'0,0,0',sender:router,target:manager,input:swapData,ok:true,kind:'call',value:'0'},
   {path:'0,0,1',sender:router,target:key[0],input:erc20.encodeFunctionData('transfer',[manager,amtIn]).toLowerCase(),ok:true,kind:'call',value:'0'},
   {path:'0,0,2',sender:manager,target:key[1],input:erc20.encodeFunctionData('transfer',[wallet,amtOut]).toLowerCase(),ok:true,kind:'call',value:'0'},
  ];
  const swapLog=v4Iface.encodeEventLog('Swap',[poolId,router,-amtIn,amtOut,1000n,5000n,0,key[2]]);
  const trIn=erc20.encodeEventLog('Transfer',[router,manager,amtIn]);
  const trOut=erc20.encodeEventLog('Transfer',[manager,wallet,amtOut]);
  const logs=[
   {idx:0,emitter:manager,topics:swapLog.topics.map(t=>t.toLowerCase()),data:swapLog.data.toLowerCase()},
   {idx:1,emitter:key[0],topics:trIn.topics.map(t=>t.toLowerCase()),data:trIn.data.toLowerCase()},
   {idx:2,emitter:key[1],topics:trOut.topics.map(t=>t.toLowerCase()),data:trOut.data.toLowerCase()},
  ];
  return discoverFamilyEventEdges(frames,logs,{'0x48c89491':v4Rule},{'0x48c89491':discoverV4});
 }

 const e1=runOneTx(key1,id1,hookData1,100n,95n);
 assert.equal(e1.length,1);
 assert.equal(e1[0].poolId,id1);
 assert.equal(e1[0].innerSwapPath,'0,0,0');
 assert.equal(e1[0].hookData,hookData1);

 const e2=runOneTx(key2,id2,hookData2,200n,190n);
 assert.equal(e2.length,1);
 assert.equal(e2[0].poolId,id2);
 assert.equal(e2[0].innerSwapPath,'0,0,0');
 assert.equal(e2[0].hookData,hookData2);

 const eEmpty=runOneTx(key1,id1,'0x',300n,285n);
 assert.equal(eEmpty.length,1);
 assert.equal(eEmpty[0].hookData,'0x');
});

test('SQL UDF v2 projects uniform hookData -> export -> loadSqlPriceEdges -> single v4-unlock VM execution',async t=>{
 const sqlV2=await renderIndependentTraceEdges(ready21Window,{liveSelectorsOnly:true,familyDiscovery:2});
 assert.match(sqlV2,/hookData STRING/);
 assert.match(sqlV2,/MIN\(hookData\)=MAX\(hookData\), MIN\(hookData\), NULL\) AS hookData/);
 const sqlV1=await renderIndependentTraceEdges(ready21Window,{liveSelectorsOnly:true,familyDiscovery:1});
 assert.doesNotMatch(sqlV1,/AS hookData/);

 const temp=await mkdtemp(join(tmpdir(),'v4-hookdata-export-'));
 t.after(()=>rm(temp,{recursive:true,force:true}));
 const tok0=addr(0x11),tok1=addr(0x22),hook=addr(0x888);
 const tuple=[tok0,tok1,3000,60,hook] as const;
 const poolId=keccak256(coder.encode(['address','address','uint24','int24','address'],tuple));
 const hookData='0x275b003635cd83131a90325a34cbf697172117e8ce82261452b4b4beafa88e31';
 const window=ready21Window;
 const renderedSql=await renderIndependentTraceEdges(window,{liveSelectorsOnly:true,executionParams:false,familyDiscovery:2});

 const edgeRows=[{
  selector:'0x48c89491',
  poolAddress:manager,
  callTarget:manager,
  poolId,
  tokenIn:tok0,
  tokenOut:tok1,
  observations:'3',
  verified:false,
  observedTargetSelector:true,
  evidenceTypes:['v4-pool-manager-swap'],
  hookData,
  example:{
   txHash:'0x'+'bb'.repeat(32),
   callPath:'0',
   innerSwapPath:'0,0,0',
   selectorTarget:manager,
   observedPoolAddress:manager,
   evidence:'v4-pool-manager-swap',
   hookData,
  },
 }];
 const edgesBytes=Buffer.from(JSON.stringify(edgeRows,null,2)+'\n');
 const upstreamManifest={
  window,
  liveSelectorsOnly:true,
  familyDiscoveryVersion:2,
  sqlSha256:sha(renderedSql),
  edgesSha256:sha(edgesBytes),
  total:1,
  observations:3,
 };
 const upstreamDir=join(temp,'upstream'),outDir=join(temp,'out');
 await mkdtemp(join(temp,'unused-'));
 const {mkdir}=await import('node:fs/promises');
 await mkdir(upstreamDir,{recursive:true});
 const upstreamPath=join(upstreamDir,'manifest.json');
 const mb=Buffer.from(JSON.stringify(upstreamManifest,null,2)+'\n');
 await writeFile(upstreamPath,mb);
 await writeFile(join(upstreamDir,'edges.json'),edgesBytes);

 await exportIndependentLive({
  upstream:upstreamPath,
  upstreamSha256:sha(mb),
  out:outDir,
  swapsOnly:true,
  noPrior:true,
 });

 const loaded=await loadSqlPriceEdges(join(outDir,'fixed-edge-manifest.json'));
 assert.equal(loaded.edges.length,1);
 const exportedEdge=loaded.edges[0]!;
 assert.equal(exportedEdge.hookData,hookData);
 assert.equal(exportedEdge.candidateInstanceKey,sqlDirectionId({
  chainId:1,selector:'0x48c89491',poolAddress:manager,poolNamespace:'contract-pool-id',
  poolId,tokenIn:tok0,tokenInId:null,tokenOut:tok1,tokenOutId:null,
 }));

 // Now issue live single-execution route from exportedEdge and simulate in BotVM!
 const definition=normalizeSelectorNativeExecutionDefinition(v4DefRaw);
 const source={number:window.toBlock,hash:window.headHash,generation:1};
 const executor=addr(0x44),origin=addr(0x55);
 const issued=await issueSelectorCurrentSourceRoutes({
  catalog,
  definition,
  edge:exportedEdge,
  source,
  executor,
  transactionOrigin:origin,
  readCode:async()=> '0x6000',
  read:async(to,data)=>{
   assert.equal(to,positionManager);
   const fn=v4Iface.parseTransaction({data})!;
   assert.equal(fn.name,'poolKeys');
   assert.equal(fn.args[0],poolId.slice(0,52));
   return v4Iface.encodeFunctionResult('poolKeys',tuple);
  },
 });
 assert.equal(issued.alternatives.length,1,issued.issues.join('; '));
 const program=issued.alternatives[0]!.program;

 // Execute the compiled BotVM program and verify PoolManager.swap receives exact hookData and prices by actual delta!
 const {getBytes,hexlify}=await import('ethers');
 let balIn=10_000n,balOut=0n,managerBalIn=50_000n,syncedBal=0n,seenHookData='';
 const amountIn=1_000n,expectedOut=2_450n;
 const host={
  nativeBalance:()=>0n,
  call(c:{target:string;data:string}):string{
   const tx=v4Iface.parseTransaction({data:c.data})!;
   if(tx.name==='balanceOf'){
    const who=String(tx.args[0]).toLowerCase();
    return toBeHex(c.target.toLowerCase()===tok0?(who===executor?balIn:managerBalIn):balOut,32);
   }
   if(tx.name==='unlock'){
    const raw=getBytes(tx.args[0]);
    assert.equal(raw[0],0x0e);
    const childAmount=BigInt(hexlify(raw.slice(1,33)));
    const childLen=(raw[33]!<<16)|(raw[34]!<<8)|raw[35]!;
    const childProgram=hexlify(raw.slice(36,36+childLen));
    inspectRuntime(childProgram,childAmount,{...host,calldata:v4Iface.encodeFunctionData('unlockCallback',[tx.args[0]])});
    return v4Iface.encodeFunctionResult('unlock',['0x']);
   }
   if(tx.name==='swap'){
    seenHookData=String(tx.args[2]).toLowerCase();
    const negIn=BigInt.asUintN(128,-amountIn);
    const posOut=BigInt.asUintN(128,expectedOut);
    const packed=(negIn<<128n)|posOut;
    return toBeHex(packed,32);
   }
   if(tx.name==='take'){
    assert.equal(String(tx.args[0]).toLowerCase(),tok1);
    assert.equal(String(tx.args[1]).toLowerCase(),executor);
    balOut+=BigInt(tx.args[2]);
    return '0x';
   }
   if(tx.name==='sync'){
    assert.equal(String(tx.args[0]).toLowerCase(),tok0);
    syncedBal=managerBalIn;
    return '0x';
   }
   if(tx.name==='transfer'){
    assert.equal(c.target.toLowerCase(),tok0);
    assert.equal(String(tx.args[0]).toLowerCase(),manager);
    const amt=BigInt(tx.args[1]);
    balIn-=amt;managerBalIn+=amt;
    return toBeHex(1,32);
   }
   if(tx.name==='settle'){
    return toBeHex(managerBalIn-syncedBal,32);
   }
   assert.fail('unexpected call '+tx.name);
  },
 };
 inspectRuntime(program,amountIn,host);
 assert.equal(seenHookData,hookData);
 assert.equal(balIn,10_000n-amountIn);
 assert.equal(balOut,expectedOut);
});

test('PSM buyGem (0x8d7ef9bb) discover.mjs proves ordered DAI transferFrom + gem transfer + BuyGem event',()=>{
 const psmIface=new Interface([
  'function buyGem(address usr,uint256 gemAmt)',
  'function transferFrom(address,address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'event Transfer(address indexed from,address indexed to,uint256 amount)',
  'event BuyGem(address indexed usr,uint256 value,uint256 fee)',
 ]);
 const caller=addr(1),psm=addr(2),dai=addr(3),usdc=addr(4),pocket=addr(5),usr=addr(6);
 const gemOut=500_000_000n,daiIn=500_500_000_000_000_000_000n,fee=500_000_000_000_000_000n;
 const frames=[
  {path:'',sender:caller,target:psm,input:psmIface.encodeFunctionData('buyGem',[usr,gemOut]).toLowerCase(),ok:true,kind:'call',value:'0'},
  {path:'0',sender:psm,target:dai,input:psmIface.encodeFunctionData('transferFrom',[caller,pocket,daiIn]).toLowerCase(),ok:true,kind:'call',value:'0'},
  {path:'1',sender:psm,target:usdc,input:psmIface.encodeFunctionData('transfer',[usr,gemOut]).toLowerCase(),ok:true,kind:'call',value:'0'},
 ];
 const l0=psmIface.encodeEventLog('Transfer',[caller,pocket,daiIn]);
 const l1=psmIface.encodeEventLog('Transfer',[psm,usr,gemOut]);
 const l2=psmIface.encodeEventLog('BuyGem',[usr,gemOut,fee]);
 const logs=[
  {idx:0,emitter:dai,topics:l0.topics.map(t=>t.toLowerCase()),data:l0.data.toLowerCase()},
  {idx:1,emitter:usdc,topics:l1.topics.map(t=>t.toLowerCase()),data:l1.data.toLowerCase()},
  {idx:2,emitter:psm,topics:l2.topics.map(t=>t.toLowerCase()),data:l2.data.toLowerCase()},
 ];
 const edges=discoverFamilyEventEdges(frames,logs,{'0x8d7ef9bb':buyGemRule},{'0x8d7ef9bb':discoverBuyGem});
 assert.equal(edges.length,1);
 assert.deepEqual({
  selector:edges[0].selector,
  poolAddress:edges[0].poolAddress,
  tokenIn:edges[0].tokenIn,
  tokenOut:edges[0].tokenOut,
  amountPayerInRaw:edges[0].amountPayerInRaw,
  amountReceivedOutRaw:edges[0].amountReceivedOutRaw,
 },{
  selector:'0x8d7ef9bb',
  poolAddress:psm,
  tokenIn:dai,
  tokenOut:usdc,
  amountPayerInRaw:String(daiIn),
  amountReceivedOutRaw:String(gemOut),
 });

 // Wrong BuyGem gemAmt rejects
 const badLog=psmIface.encodeEventLog('BuyGem',[usr,gemOut+1n,fee]);
 const badLogs=[logs[0]!,logs[1]!,{idx:2,emitter:psm,topics:badLog.topics.map(t=>t.toLowerCase()),data:badLog.data.toLowerCase()}];
 assert.deepEqual(discoverFamilyEventEdges(frames,badLogs,{'0x8d7ef9bb':buyGemRule},{'0x8d7ef9bb':discoverBuyGem}),[]);
});
