import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {normalizeSelectorNativeExecutionDefinition,selectorNativeProgramKey} from '../venues/selector-native-definition.js';
import {selectorExecutionPrograms} from '../venues/selector-program-role.js';
import {compileSqlExecutionParamPlan} from '../venues/selector-native-execution-param-plan.js';
import {validateSqlExecutionParamHints} from '../venues/selector-native-sql-param-hints.js';
import {compileSqlTrialLegs} from '../venues/selector-native-sql-trial.js';
import {createSelectorNativeRuntime} from '../venues/selector-native-runtime.js';
import {isEnabledSqlExecutionLeg} from '../sql-execution-selectors.js';
const addr=(n:string)=>'0x'+n.repeat(40),hash=(n:string)=>'0x'+n.repeat(64);
const source={number:123,hash:hash('a'),generation:1},executor=addr('8'),transactionOrigin=addr('9');
const load=(selector:string)=>JSON.parse(readFileSync(new URL('../venues/selector-native/selector-'+selector+'-family/selector-'+selector+'.json',import.meta.url),'utf8'));
test('identity placement does not change execution indexes, keys, trial bytes or SQL eligibility',()=>{
 const raw=load('95991276'),identity=raw.programs.find((p:any)=>p.type==='independentIdentity'),execution=raw.programs.find((p:any)=>p.type==='execution');
 assert(identity&&!identity.execution&&execution&&!execution.binding);
 let prior:string|undefined;
 for(const programs of [[identity,execution],[execution,identity]]){
  const definition=normalizeSelectorNativeExecutionDefinition({...raw,programs});
  const plan=compileSqlExecutionParamPlan(definition);
  assert.equal(plan.recipes.length,1);assert.equal(plan.recipes[0]!.index,0);
  const edge={chainId:1,selector:definition.selector,poolAddress:addr('3'),poolId:null,tokenIn:addr('4'),tokenOut:addr('5')};
  const executionParamEvidence={consensus:'uniform',txHash:hash('b'),callPath:'0',innerSwapPath:null,definitionSha256:createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
   recipes:plan.recipes.map(r=>({index:r.index,observed:[],missing:[]}))};
  const hints=validateSqlExecutionParamHints({definition,edge,evidence:executionParamEvidence})!;
  assert.equal(hints.recipes.length,1);assert.equal(hints.recipes[0]!.programKey,selectorNativeProgramKey(selectorExecutionPrograms(definition)[0]!));
  const result=compileSqlTrialLegs({definition,edge:{...edge,executionParamEvidence},source,executor,transactionOrigin});
  assert.equal(result.legs.length,1,result.issues.join('; '));
  const bytes=result.legs[0]!.leg.program;if(prior)assert.equal(bytes,prior);prior=bytes;
  assert(isEnabledSqlExecutionLeg({definition,activation:{enabled:true}} as any));
  assert.throws(()=>createSelectorNativeRuntime(definition,definition.programs.find(p=>p.type==='independentIdentity')!),/identity program/);
 }
 const {directState,...withoutExecutionState}=raw;
 assert.throws(()=>normalizeSelectorNativeExecutionDefinition({...withoutExecutionState,programs:[identity]}),/execution program/);
 assert.equal(selectorExecutionPrograms({...withoutExecutionState,programs:[identity]}).length,0);
 assert.equal(isEnabledSqlExecutionLeg({definition:{...withoutExecutionState,programs:[identity]},activation:{enabled:true}} as any),false);
});
test('all five generated families separate read-only identity options and single executable template',()=>{
 for(const [selector,count,identityCount] of [['95991276',1,1],['8d7ef9bb',1,1],['022c0d9f',1,2],['128acb08',1,2],['48c89491',1,2]] as const){
  const definition=normalizeSelectorNativeExecutionDefinition(load(selector));
  assert.equal(selectorExecutionPrograms(definition).length,count);
  assert.equal(definition.programs.filter(p=>p.type==='independentIdentity').length,identityCount);
  for(const p of definition.programs){
   if(p.type==='independentIdentity'){assert(p.binding?.flow);assert.equal(p.execution,undefined);assert.equal(p.routes,undefined);}
   else{assert.equal(p.type,'execution');assert(p.execution);assert(p.projection);assert.equal(p.binding,undefined);}
  }
  assert.equal(compileSqlExecutionParamPlan(definition).recipes.length,count);
 }
});
