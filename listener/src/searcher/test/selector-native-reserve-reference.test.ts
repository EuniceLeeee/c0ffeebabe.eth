import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {Interface,FunctionFragment,hexlify,id} from 'ethers';
import {compileDeclarativeValues} from '../venues/declarative-values.js';
import {buildDeclarativeExecutionProgram,declarativeStaticReturnWords} from '../venues/declarative-execution.js';
import {createDeclarativeRuntimeMathRegistry} from '../venues/declarative-runtime-math.js';
import {inspectRuntime,RuntimeProgramGuardError,type RuntimeCall} from './runtime-program-testkit.js';

const definition=JSON.parse(readFileSync(new URL('../venues/selector-native/selector-022c0d9f-family/selector-022c0d9f.json',import.meta.url),'utf8'));
const declaration=definition.programs.find((p:any)=>p.meta?.label==='ammalgam-pair:current-reserve-reference-execution');
assert(declaration,'reserve-reference program must migrate with the other programs sharing swap selector');
const {models,...binding}=declaration.runtimeMath;
const math=createDeclarativeRuntimeMathRegistry(models).bind(binding);
const values=compileDeclarativeValues(declaration.values);
const addr=(s:string)=>'0x'+s.repeat(40);
const pair=addr('1'),tokenX=addr('2'),tokenY=addr('3'),executor=addr('4');
const source={number:1,generation:1,hash:'0x'+'ab'.repeat(32)};
const abi=new Interface([
 'function getReserves() view returns(uint112,uint112,uint32)',
 'function referenceReserves() view returns(uint112,uint112)',
 'function totalAssetsAndShares(bool) view returns(uint112[6],uint112[6])',
 'function balanceOf(address) view returns(uint256)', 'function totalSupply() view returns(uint256)',
 'function transfer(address,uint256) returns(bool)',
 'function swap(uint256,uint256,address,bytes)',
 'event Swap(address indexed sender,uint256 amountXIn,uint256 amountYIn,uint256 amountXOut,uint256 amountYOut,address indexed to)',
]);
function context(xForY:boolean){return {descriptor:{pair,tokenX,tokenY},route:{xForY,tokenIn:xForY?tokenX:tokenY,tokenOut:xForY?tokenY:tokenX,target:pair},executor,recipient:executor,source,minAmountOut:1n};}
// Independent closed-form calculation of the former VM's conservative branch.
function expected(input:bigint,reserveIn:bigint,reserveOut:bigint,reference:bigint):bigint {
 const slope=0x7d00000000000000000n,scale=0x27100000000000000000n,min=0x1999999999999999n;
 const delta=reserveIn>reference?reserveIn-reference:0n;
 const past=input+reserveIn>reference?input+reserveIn-reference:0n;
 const raw=delta===0n?(past*slope/reference)*past/input:(2n*delta+input)*slope/reference;
 const fee=raw>min?raw:min;
 const balance=((reserveIn+input)*scale-input*fee)/scale;
 return reserveOut-(reserveIn*reserveOut+balance-1n)/balance;
}
function run(xForY:boolean,amount:bigint,options:{references?:[bigint,bigint];reserves?:[bigint,bigint];borrow?:[bigint,bigint];netDrift?:bigint;shortInput?:boolean;shortOutput?:boolean;supplyMove?:boolean;nativeMove?:boolean}={}){
 const input=context(xForY),reserves=options.reserves??[1_000_000_000n,2_000_000_000n],references=options.references??[1_100_000_000n,1_900_000_000n];
 const borrow=options.borrow??[0n,0n];const balances=new Map<string,bigint>([[tokenX+pair,reserves[0]-borrow[0]+(options.netDrift??0n)],[tokenY+pair,reserves[1]-borrow[1]],[input.route.tokenIn+executor,amount],[input.route.tokenOut+executor,0n]]);
 const supply=new Map([[tokenX,10_000_000_000n],[tokenY,20_000_000_000n]]);let native=0n,amountOut=0n,entryCalls=0;
 const balance=(token:string,account:string)=>balances.get(token.toLowerCase()+account.toLowerCase())??0n;
 const add=(token:string,account:string,n:bigint)=>balances.set(token.toLowerCase()+account.toLowerCase(),balance(token,account)+n);
 function call(c:RuntimeCall):string {
  const parsed=abi.parseTransaction({data:c.data})!;const target=c.target.toLowerCase();
  const result=(data:any[])=>abi.encodeFunctionResult(parsed.name,data);
  switch(parsed.name){
   case 'getReserves':assert.equal(target,pair);assert(c.static);return result([...reserves,1]);
   case 'referenceReserves':assert.equal(target,pair);assert(c.static);return result(references);
   case 'totalAssetsAndShares':assert.equal(target,pair);assert(c.static);assert.equal(parsed.args[0],false);return result([[0n,0n,0n,0n,...borrow],Array(6).fill(0n)]);
   case 'balanceOf':assert(c.static);return result([balance(target,parsed.args[0])]);
   case 'totalSupply':assert(c.static);return result([supply.get(target)]);
   case 'transfer':assert(!c.static);assert.equal(target,input.route.tokenIn);assert.equal(parsed.args[0].toLowerCase(),pair);assert.equal(parsed.args[1],amount);add(target,executor,-amount);add(target,pair,options.shortInput?amount-1n:amount);if(options.nativeMove)native++;
    if(options.supplyMove)supply.set(target,supply.get(target)!+1n);return result([true]);
   case 'swap':entryCalls++;assert(!c.static);assert.equal(target,pair);assert.equal(parsed.args[3],'0x');assert.equal(parsed.args[2].toLowerCase(),executor);
    amountOut=parsed.args[xForY?1:0];assert.equal(parsed.args[xForY?0:1],0n);add(input.route.tokenOut,pair,-amountOut);add(input.route.tokenOut,executor,options.shortOutput?amountOut-1n:amountOut);return '0x';
   default:throw Error('Unexpected fixture call '+parsed.name);
  }
 }
 const program=buildDeclarativeExecutionProgram(declaration.execution,input,values,{math});
 const result=inspectRuntime(hexlify(program.bytes()),amount,{call,nativeBalance:()=>native});
 assert.equal(entryCalls,1);assert.equal(balance(input.route.tokenIn,executor),0n);assert.equal(balance(input.route.tokenOut,executor),amountOut);
 return {amountOut,reserves,references,input,result};
}

test('static ABI return captures retain fixed arrays and tuples, reject dynamic offsets and excessive arrays',()=>{
 const fn=FunctionFragment.from('function f() view returns(uint112[6],(address,bool),bytes32)');
 assert.deepEqual(declarativeStaticReturnWords(fn.outputs).map(p=>p.type),[...Array(6).fill('uint112'),'address','bool','bytes32']);
 for(const signature of ['function f() view returns(uint256[])','function f() view returns((uint256,string))','function f() view returns(bytes)','function f() view returns(uint256[257])'])
  assert.throws(()=>declarativeStaticReturnWords(FunctionFragment.from(signature).outputs),/static ABI words|word limit/);
});
for(const direction of [true,false])for(const amount of [10_000n,250_000n,200_000_000n])test(`reserve/reference swap uses new input in both fee branches: ${direction}/${amount}`,()=>{
 const actual=run(direction,amount),i=direction?0:1;
 assert.equal(actual.amountOut,expected(amount,actual.reserves[i],actual.reserves[1-i],actual.references[i]));
 assert.equal(actual.result.registers[0],amount);
});
function guard(fn:()=>unknown){assert.throws(fn,(error:unknown)=>error instanceof RuntimeProgramGuardError);}
test('current source mismatches, depleted liquidity, zero reserve and zero reference fail closed before execution',()=>{
 guard(()=>run(true,10_000n,{netDrift:1n}));guard(()=>run(true,10_000n,{borrow:[960_000_000n,0n]}));
 guard(()=>run(true,10_000n,{reserves:[0n,2_000_000_000n]}));guard(()=>run(true,10_000n,{references:[0n,2_000_000_000n]}));
});
test('execution guards reject transfer tax, short output, supply drift and native inventory use',()=>{
 for(const flag of ['shortInput','shortOutput','supplyMove','nativeMove'] as const)guard(()=>run(true,10_000n,{[flag]:true}));
});
test('receipt JSON preserves unique Swap event and actual debit/output proof without trace',()=>{
 const amountIn=10_000n,{amountOut,input}=run(true,amountIn);
 const event=abi.encodeEventLog(abi.getEvent('Swap')!,[executor,amountIn,0n,0n,amountOut,executor]);
 assert.equal(event.topics[0],id('Swap(address,uint256,uint256,uint256,uint256,address)'));
 const log={address:pair,...event},env={...input,amountIn,amountOut,result:{effects:{logs:[log]}}};
 values.run(declaration.receiptChecks.checks,env);
 assert.throws(()=>values.run(declaration.receiptChecks.checks,{...env,result:{effects:{logs:[]}}}),/Swap/);
 assert.throws(()=>values.run(declaration.receiptChecks.checks,{...env,result:{effects:{logs:[log,log]}}}),/unique/);
 assert.throws(()=>values.run(declaration.receiptChecks.checks,{...env,amountOut:amountOut+1n}),/differs/);
});
