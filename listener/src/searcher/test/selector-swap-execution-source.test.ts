import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {AbiCoder,Interface,keccak256,toBeHex} from 'ethers';
import {compileSelectorExecutionSource} from '../build-selector-execution-source.js';
import {normalizeSelectorNativeExecutionDefinition as normalize} from '../venues/selector-native-definition.js';
import {selectSingleExecution} from '../venues/selector-program-role.js';
import {compileSqlExecutionParamPlan} from '../venues/selector-native-execution-param-plan.js';
import {compileSqlTrialLegs} from '../venues/selector-native-sql-trial.js';
import {inspectRuntime} from './runtime-program-testkit.js';

const read=(s:string)=>JSON.parse(readFileSync(new URL('../venues/selector-native/selector-'+s+'-family/execution.source.json',import.meta.url),'utf8'));
const h=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const hash='a'.repeat(64),v2=read('022c0d9f'),v3=read('128acb08'),v4=read('48c89491'),psmSell=read('95991276'),psmBuy=read('8d7ef9bb');
const a=(n:number)=>toBeHex(n,20),coin0=a(1),coin1=a(2),pool=a(3),executor=a(4),origin=a(5);
const manager='0x000000000004444c5dc75cb358380d2e3de08a90';
const source={number:100,generation:1,hash:toBeHex(100,32)};

function fixture(raw:any,reverse=false,tuple?:readonly string[],hookData?:string){
 const definition=normalize(compileSelectorExecutionSource(raw,hash));
 const recipes=compileSqlExecutionParamPlan(definition).recipes.map(({index,requirements})=>{
  const observed:any[]=[],missing:string[]=[];
  for(const {key,sources} of requirements){
   const t=sources.find(s=>s.kind==='pool-id-tuple');
   if(t&&tuple)observed.push({key,kind:t.kind,value:tuple[t.member]!});
   else if(sources.some(s=>s.kind==='direction-asset'))observed.push({key,kind:'direction-asset',value:/\.(token0|tokenX)$/.test(key)?coin0:coin1});
   else if(!sources.some(s=>['runtime','edge','fixed'].includes(s.kind)))missing.push(key);
  }
  return {index,observed,missing};
 });
 const poolId=tuple?keccak256(AbiCoder.defaultAbiCoder().encode(['address','address','uint24','int24','address'],tuple)):undefined;
 const edge={
  chainId:1 as const,
  selector:raw.selector,
  poolAddress:tuple?manager:pool,
  ...(poolId?{poolId,poolNamespace:'contract-pool-id'}:{}),
  tokenIn:reverse?coin1:coin0,
  tokenOut:reverse?coin0:coin1,
  ...(hookData!==undefined?{hookData}:{}),
  executionParamEvidence:{consensus:'uniform',definitionSha256:h(definition),txHash:toBeHex(200,32),callPath:'',innerSwapPath:tuple?'0,1':null,recipes},
 };
 return {definition,edge,source,executor,transactionOrigin:origin};
}

test('all 5 migrated selectors compile to a single pure execution program with no binding flow',()=>{
 for(const raw of [v2,v3,v4,psmSell,psmBuy]){
  const d=normalize(compileSelectorExecutionSource(raw,hash));
  assert.equal(d.programs.length,1);
  const p=selectSingleExecution(d).program;
  assert.equal(p.type,'execution');assert(p.execution);assert(p.projection?.descriptor);
  assert.equal(p.binding,undefined);assert.equal((p as any).executionProgramKeys,undefined);
  assert.equal(p.projection.flow,undefined);assert.equal(p.projection.descriptorReads,undefined);
  assert.equal(p.observations,undefined);
  assert.equal(p.refreshPolicy,'on-touch');
 }
 for(const raw of [v2,v3]){
  for(const reverse of [false,true]){
   const f=fixture(raw,reverse),r=compileSqlTrialLegs(f);
   assert.equal(r.legs.length,1,r.issues.join('; '));assert.equal(r.complete,true);assert.deepEqual(r.issues,[]);
   assert.equal(r.legs[0]!.tokenIn,f.edge.tokenIn);assert.equal(r.legs[0]!.tokenOut,f.edge.tokenOut);
  }
 }
});

test('V3 keeps original callback authentication, receipt effects and fixed price limits byte for byte',()=>{
 const p=selectSingleExecution(normalize(compileSelectorExecutionSource(v3,hash))).program;
 assert.equal(h(p.execution),'8805b59983820dbfe016be0c658fad78366c9bd2cded919e2a1d1efbccc63731');
 assert.equal(p.projection!.descriptor.fee,undefined);
 assert.equal(p.projection!.descriptor.tickSpacing,undefined);
});

const v2Abi=new Interface(['function balanceOf(address) view returns(uint256)','function getReserves() view returns(uint112,uint112,uint32)',
 'function transfer(address,uint256) returns(bool)','function swap(uint256,uint256,address,bytes)']);

for(const reverse of [false,true])for(const taxed of [false,true])
test(`V2 single 30bps template reverse=${reverse} taxed=${taxed} uses actual paid input and received output`,()=>{
 const f=fixture(v2,reverse),r=compileSqlTrialLegs(f),leg=r.legs[0]!;
 assert(leg,r.issues.join('; '));
 const amount=10000n,reserveIn=1_000_000n,reserveOut=2_000_000n;
 const credit=taxed?amount*9n/10n:amount,fee=30n;
 const expectedGross=credit*(10000n-fee)*reserveOut/(reserveIn*10000n+credit*(10000n-fee));
 const expectedReceipt=taxed?expectedGross*8n/10n:expectedGross;
 let walletIn=100000n,walletOut=0n,poolInput=reserveIn,poolOutput=reserveOut,swaps=0;
 inspectRuntime(leg.leg.program,amount,{nativeBalance:()=>0n,call(c){
  const tx=v2Abi.parseTransaction({data:c.data})!;
  if(tx.name==='balanceOf')return toBeHex(tx.args[0].toLowerCase()===pool?(c.target.toLowerCase()===f.edge.tokenIn?poolInput:poolOutput):
   c.target.toLowerCase()===f.edge.tokenIn?walletIn:walletOut,32);
  if(tx.name==='getReserves')return v2Abi.encodeFunctionResult('getReserves',reverse?[reserveOut,reserveIn,0]:[reserveIn,reserveOut,0]);
  if(tx.name==='transfer'){assert.equal(c.target.toLowerCase(),f.edge.tokenIn);assert.equal(tx.args[0].toLowerCase(),pool);assert.equal(tx.args[1],amount);
   walletIn-=amount;poolInput+=credit;return toBeHex(1,32);}
  assert.equal(tx.name,'swap');assert.equal(c.target.toLowerCase(),pool);
  assert.equal(tx.args[reverse?0:1],expectedGross);assert.equal(tx.args[reverse?1:0],0n);assert.equal(tx.args[2].toLowerCase(),executor);
  poolOutput-=expectedGross;walletOut+=expectedReceipt;swaps++;return '0x';
 }});
 assert.equal(swaps,1);assert.equal(walletOut,expectedReceipt);assert.equal(walletIn,100000n-amount);
});

test('PSM buyGem single template computes Gem output from DAI budget, scale and tout fee with zero residual allowance',()=>{
 const f=fixture(psmBuy,false),r=compileSqlTrialLegs(f),leg=r.legs[0]!;
 assert(leg,r.issues.join('; '));
 const psmAbi=new Interface([
  'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)',
  'function tout() view returns(uint256)',
  'function to18ConversionFactor() view returns(uint256)',
  'function buyGem(address,uint256)',
 ]);
 const scale=10n**12n,tout=10n**15n; // 10 bps fee, 6-decimal USDC
 const daiBudget=1001n*10n**18n+777n; // leaves dust because of 1e12 scale + 10 bps fee
 let daiWallet=10_000n*10n**18n,gemWallet=0n,allowance=99n,bought=0n;
 inspectRuntime(leg.leg.program,daiBudget,{nativeBalance:()=>0n,call(c){
  const tx=psmAbi.parseTransaction({data:c.data})!;
  if(tx.name==='balanceOf')return toBeHex(c.target.toLowerCase()===f.edge.tokenIn?daiWallet:gemWallet,32);
  if(tx.name==='allowance')return toBeHex(allowance,32);
  if(tx.name==='approve'){allowance=BigInt(tx.args[1]);return toBeHex(1,32);}
  if(tx.name==='tout')return toBeHex(tout,32);
  if(tx.name==='to18ConversionFactor')return toBeHex(scale,32);
  assert.equal(tx.name,'buyGem');
  const gemAmt=BigInt(tx.args[1]);
  const gem18=gemAmt*scale,fee=gem18*tout/(10n**18n),spend=gem18+fee;
  assert(allowance>=spend);allowance-=spend;daiWallet-=spend;gemWallet+=gemAmt;bought=gemAmt;
  return '0x';
 }});
 assert(bought>0n);
 assert.equal(allowance,0n);
 assert(10_000n*10n**18n-daiWallet<=daiBudget);
 assert.equal(gemWallet,bought);
});

test('V4 single template encodes dynamic hookData from SQL edge into PoolManager.swap',()=>{
 const tuple=[coin0,coin1,'3000','60',a(99)];
 const hookHex='beadedbeadeadbeadedbeadeddeabeadbeadbeadbeadadedbeadeddeabeadaed';
 const emptyLeg=compileSqlTrialLegs(fixture(v4,false,tuple,'0x')).legs[0]!;
 const hookedLeg=compileSqlTrialLegs(fixture(v4,false,tuple,'0x'+hookHex)).legs[0]!;
 assert(emptyLeg&&hookedLeg);
 assert.notEqual(emptyLeg.leg.program,hookedLeg.leg.program);
 assert(hookedLeg.leg.program.toLowerCase().includes(hookHex));
});

test('source recipes cannot smuggle old RPC binding or authored discovery authority',()=>{
 const compiledV3=selectSingleExecution(normalize(compileSelectorExecutionSource(v3,hash))).program;
 for(const extra of [{flow:{}},{binding:{flow:{}}},{descriptorReads:[]},{ethCall:{}},
   {stateBinding:{poolNamespace:'contract-pool-id',authority:{version:1,steps:[]}}}]){
  assert.throws(()=>compileSelectorExecutionSource({...v3,...extra},hash));
  const legacyTemplate={format:'simulated-execution-recipes/v1',selector:v3.selector,signature:v3.signature,domain:'swap',
   activation:v3.activation,state:v3.state,recipes:[{...compiledV3,...extra}]};
  assert.throws(()=>compileSelectorExecutionSource(legacyTemplate,hash));
 }
 assert.throws(()=>compileSelectorExecutionSource({...v3,state:{...v3.state,discoveryRuleHash:hash}},hash));
});
