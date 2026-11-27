import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {Interface} from "ethers";
import {hashCanonical} from "../venues/canonical-value.js";
import {selectorNativeProgramKey} from "../venues/selector-native-definition.js";
import {normalizeSelectorNativeExecutionDefinition} from "../venues/selector-native-definition.js";
import {createSqlEdgePriceLogScopes} from "../venues/sql-edge-price-log-scopes.js";
import {PoolLegRefreshIndex, observePoolLegRefresh, observePoolBalanceRefresh} from "../pool-leg-refresh.js";
import {compileDeclarativeSwap} from "../venues/declarative-swap-domain.js";
import {compileDeclarativeValues} from "../venues/declarative-values.js";

// Frozen public pre-source V4 program 0. These tests intentionally exercise the
// legacy independently-pinned nomination contract, not source execution rules.
const raw=JSON.parse(readFileSync(new URL("./fixtures/legacy-selector-48c89491.json",import.meta.url),"utf8"));
const def=normalizeSelectorNativeExecutionDefinition(raw),lookup=createSqlEdgePriceLogScopes([def]);
const emitter="0x000000000004444c5dc75cb358380d2e3de08a90",sender="0x"+"3".repeat(40),pool="0x"+"ab".repeat(32);
const abi=new Interface(raw.programs[0].observations.events.map((e:any)=>e.signature));
test("all typed events that name a logical pool use the same manager+ID lookup, regardless of event name or indexed position",()=>{
  const signature="event ParamChanged(address indexed operator,bytes32 indexed market,uint256 value)";
  const source=structuredClone(raw);
  source.physicalPoolActivity.push({signature,indexedPoolId:"market"});
  const decode=createSqlEdgePriceLogScopes([normalizeSelectorNativeExecutionDefinition(source)]);
  const other="0x"+"cc".repeat(32),manager2="0x"+"dd".repeat(20);
  const index=new PoolLegRefreshIndex([[emitter,pool,"buy"],[emitter,pool,"sell"],[emitter,other,"sibling"],[manager2,pool,"other-manager"]]
    .map(([poolAddress,poolId,legId])=>({poolAddress:poolAddress!,poolId:poolId!,legId:legId!,stateKey:legId!})),true);
  const param=new Interface([signature]).encodeEventLog("ParamChanged",[sender,pool,5]);
  const swapped=abi.encodeEventLog("Swap",[pool,sender,-12,18,20,30,-1,5]);
  const fee=new Interface([raw.physicalPoolActivity[0].signature]).encodeEventLog("ProtocolFeeUpdated",[pool,5]);
  for (const log of [param,swapped,fee]) {
    const hit=observePoolLegRefresh(index,{kind:"log",address:emitter,...log},decode);
    assert.deepEqual(hit.directPools,[{poolAddress:emitter,poolId:pool}]);
    assert.deepEqual(hit.directLegIds,["buy","sell"]);
    assert.equal(hit.fallbackManagers.length,0);
  }
});
test("fee mutation scopes only local pool work, never discovers a trade; ambiguous roles or malformed evidence remain broad",()=>{
  const fee="event ProtocolFeeUpdated(bytes32 indexed id,uint24 protocolFee)",af=new Interface([fee]);
  const e={address:emitter,...af.encodeEventLog("ProtocolFeeUpdated",[pool,0x3e83e8])};
  assert.deepEqual(lookup(e),[pool]);const foreign="0x"+"cd".repeat(32);
  const idx=new PoolLegRefreshIndex([[pool,"forward"],[pool,"other-selector"],[foreign,"sibling"]].map(([poolId,legId])=>({poolAddress:emitter,poolId,legId:legId!,stateKey:legId!})),true);
  const changed=observePoolLegRefresh(idx,{kind:"log",...e},lookup);assert.deepEqual(changed.directLegIds,["forward","other-selector"]);assert.deepEqual(changed.fallbackManagers,[]);
  const mk=(f:(v:any)=>void)=>{const x=structuredClone(raw);f(x);return normalizeSelectorNativeExecutionDefinition(x);};
  assert(lookup.settlementBalanceOnly(emitter));assert.equal(lookup({...e,address:sender}),null);
  assert.equal(lookup({...e,data:"0x"}),null);assert.equal(lookup({...e,data:"0x"+"ff".repeat(32)}),null);assert.equal(lookup({...e,topics:[...e.topics,pool]}),null);
  const missing=mk(d=>{delete d.physicalPoolActivity;});
  for(const ds of [[def,missing],[missing,def]])assert.equal(createSqlEdgePriceLogScopes(ds)(e),null);
  const declareConflict=(d:any)=>d.programs[0].observations.events.push({...d.programs[0].observations.events[0],id:"conflicting-other-meaning",signature:fee});
  assert.throws(()=>mk(declareConflict),/conflicting physical activity/);
  const conflict=mk(d=>{delete d.physicalPoolActivity;declareConflict(d);});
  assert.equal(createSqlEdgePriceLogScopes([def,conflict])(e),null);
  const nominate=(d:any)=>d.programs[0].binding.nomination.poolIdLogs.push({emitter:"call-target",topic:e.topics[0],topicIndex:2});
  assert.throws(()=>mk(nominate),/conflicting physical activity/);
  const nomination=mk(d=>{delete d.physicalPoolActivity;nominate(d);});assert.equal(createSqlEdgePriceLogScopes([def,nomination])(e),null);
  const unpinned=mk(d=>d.programs.forEach((p:any)=>{delete p.binding.stateBinding;p.routes.checks=[];}));assert.equal(createSqlEdgePriceLogScopes([unpinned])(e),null);
  const falseField=structuredClone(raw);falseField.physicalPoolActivity[0].indexedPoolId="protocolFee";assert.throws(()=>normalizeSelectorNativeExecutionDefinition(falseField));
  assert(!JSON.stringify(raw.programs).includes("ProtocolFeeUpdated"),"state-only events cannot become nominations, candidates or execution legs");
});
test("physical activity is separate from executable identity; relabels cannot hide old execution or discovery evidence",()=>{
  const edit=(change:(value:any)=>void)=>{const v=structuredClone(raw);change(v);return normalizeSelectorNativeExecutionDefinition(v);};
  const original=edit(v=>delete v.physicalPoolActivity),equal=(v:any)=>hashCanonical(v as any);
  assert.equal(equal(def),equal(original));assert.deepEqual(def.programs.map(selectorNativeProgramKey),original.programs.map(selectorNativeProgramKey));
  assert.deepEqual(def,original);assert(!JSON.stringify(def).includes("ProtocolFeeUpdated"));
  const af=new Interface([raw.physicalPoolActivity[0].signature]),fee={address:emitter,...af.encodeEventLog("ProtocolFeeUpdated",[pool,1])};
  assert.deepEqual(createSqlEdgePriceLogScopes([normalizeSelectorNativeExecutionDefinition(def)])(fee),[pool]);
  assert.equal(createSqlEdgePriceLogScopes([normalizeSelectorNativeExecutionDefinition(JSON.parse(JSON.stringify(def)))])(fee),null);
  assert.equal(createSqlEdgePriceLogScopes([original])(fee),null);
  for(const value of [null,[],[{signature:raw.physicalPoolActivity[0].signature,indexedPoolId:"id",stateOnly:true}]])
    assert.throws(()=>edit(v=>v.physicalPoolActivity=value));
  assert.throws(()=>edit(v=>{v.physicalPoolActivity=v.managerCustody.physicalPoolEvents;delete v.managerCustody.physicalPoolEvents;}),/conflicting physical activity/);
  assert.throws(()=>edit(v=>v.managerCustody.physicalPoolEvents[0].stateOnly=true));
  assert.notEqual(equal(def),equal(edit(v=>delete v.managerCustody.physicalPoolEvents)));
  assert.notEqual(equal(def),equal(edit(v=>v.programs[0].refreshPolicy=v.programs[0].refreshPolicy==="each-block"?"on-touch":"each-block")));
});
const swap=(a0:bigint,a1:bigint)=>({address:emitter,...abi.encodeEventLog("Swap",[pool,sender,a0,a1,20,30,-1,5])});
test("source physical readers cannot override a conflicting legacy reader for the same emitter/topic",()=>{
  const source=JSON.parse(readFileSync(new URL("../venues/selector-native/selector-48c89491-family/selector-48c89491.json",import.meta.url),"utf8"));
  // Keep declarations identical so a null cannot be explained by a different
  // physicalConsensus shape; only the competing legacy reader veto is tested.
  source.managerCustody=structuredClone(raw.managerCustody);
  source.physicalPoolActivity=structuredClone(raw.physicalPoolActivity);
  const current=normalizeSelectorNativeExecutionDefinition(source);
  assert.equal(current.directState?.poolId,"edge.poolId");
  const log=swap(-10n,20n),bad=structuredClone(raw);
  bad.programs[0].binding.nomination.poolIdLogs.find((n:any)=>n.topic===log.topics[0]).topicIndex=2;
  const conflict=normalizeSelectorNativeExecutionDefinition(bad);
  assert.deepEqual(createSqlEdgePriceLogScopes([current])(log),[pool]);
  assert.equal(createSqlEdgePriceLogScopes([conflict])(log),null);
  for(const definitions of [[current,conflict],[conflict,current]])
    assert.equal(createSqlEdgePriceLogScopes(definitions)(log),null,"source reader must append, not replace a veto");
});
test("qualified signed Swap and explicit mutation yield only this pool, independent of other graph entries",()=>{
  assert.deepEqual(lookup(swap(-12n,18n)),[pool]);assert.deepEqual(lookup(swap(21n,-17n)),[pool]);
  assert.deepEqual(lookup({address:emitter,...abi.encodeEventLog("ModifyLiquidity",[pool,sender,-4,4,1,"0x"+"ef".repeat(32)])}),[pool]);
});
test("unknown, permissive, wrong emitter and noncanonical logs do not narrow the scope",()=>{
  const l=swap(21n,-17n);
  for(const x of [{...l,address:sender},{...l,address:raw.programs[0].observations.canonicalIntakeTargets[1]},{...l,data:l.data+"00"},
      {...l,topics:l.topics.slice(0,2)},{...l,topics:["0x"+"fe".repeat(32),pool]},{...l,topics:[]}])assert.equal(lookup(x),null);
  const minimal=structuredClone(raw);minimal.programs=[minimal.programs[0]];
  // Merely listing an emitter as a canonical intake target is not a pin.
  delete minimal.programs[0].binding.stateBinding; // a valid state nomination itself requires checked directions
  minimal.programs[0].routes.checks=[];minimal.programs[0].observations.events[0].valid={op:"or",args:[
    {op:"sameAddress",args:["$log.address",emitter]},true]};
  assert.equal(createSqlEdgePriceLogScopes([normalizeSelectorNativeExecutionDefinition(minimal)])(l),null);
});
test("physical pool identity is independent of conversion quantities, never a general validity override",()=>{
  const zero=swap(0n,0n),p=def.programs[0]!;
  assert.deepEqual(lookup(zero),[pool]);
  const observer=compileDeclarativeSwap(p.observations!,compileDeclarativeValues({abi:{},constants:{},expressions:{},...p.values}),{familyId:"physical-test",edgeAdapterIds:["venue"]});
  const decode=(l:typeof zero)=>observer.observation!.decode({observation:{kind:"log",...l}} as any);
  for(const l of [zero,swap(0n,3n),swap(4n,0n),swap(1n,2n),swap(-1n,-2n)]){
    assert.deepEqual(lookup(l),[pool]);assert.deepEqual(decode(l),[]);
  }
  assert.equal(decode(swap(-10n,20n)).length,1);
  const changed=(mutate:(doc:any)=>void)=>{const doc=structuredClone(raw);doc.programs=doc.programs.slice(0,1);mutate(doc);return normalizeSelectorNativeExecutionDefinition(doc);};
  const denied=[
    changed(d=>delete d.managerCustody.physicalPoolEvents),
    changed(d=>{delete d.managerCustody.physicalPoolEvents;d.programs[0].binding.nomination.poolIdLogs=[];}),
    changed(d=>{const p=d.managerCustody.physicalPoolEvents[0];p.signature=p.signature.replace("indexed sender","indexed recipient");}),
    changed(d=>{d.programs[0].observations.events[0].payload.amountIn.args[2]={op:"uint",args:[99]};}),
    changed(d=>d.programs[0].observations.events[0].valid.args.push({op:"eq",args:["$args.fee",500]})),
    changed(d=>d.programs[0].binding.nomination.poolIdLogs.find((x:any)=>x.topic===zero.topics[0]).topicIndex=2),
  ];
  for(const d of denied)assert.equal(createSqlEdgePriceLogScopes([def,d])(zero),null);
  for(const l of [{...zero,address:sender},{...zero,data:zero.data+"00"},{...zero,topics:zero.topics.slice(0,2)}])assert.equal(lookup(l),null);
});
test("no nomination or conflict between declared ABI field and slot fails conservatively",()=>{
  const l=swap(21n,-17n),doc=structuredClone(raw);doc.programs=[doc.programs[0]];
  const noms=doc.programs[0].binding.nomination.poolIdLogs;
  const candidate=noms.find((n:any)=>n.topic===l.topics[0]);candidate.topicIndex=2;
  assert.equal(createSqlEdgePriceLogScopes([def,normalizeSelectorNativeExecutionDefinition(doc)])(l),null);
  doc.programs[0].binding.nomination.poolIdLogs=[];
  assert.equal(createSqlEdgePriceLogScopes([normalizeSelectorNativeExecutionDefinition(doc)])(l),null);
});
test("shared custody transfers are not pool ID writes; exact pool, independent owners and unknown events stay distinct",()=>{
  const foreign="0x"+"7".repeat(40),p2="0x"+"cd".repeat(32),token="0x"+"8".repeat(40);
  const index=new PoolLegRefreshIndex([[emitter,pool,"1a"],[emitter,pool,"1b"],[emitter,p2,"2"],[emitter,null,"address-only"],[sender,null,"single"],[foreign,pool,"other"]]
    .map(([poolAddress,poolId,id])=>({poolAddress:poolAddress!,poolId,legId:id!,stateKey:id!})));
  const hit=(log:{address:string;topics:readonly string[];data:string},f=lookup)=>observePoolLegRefresh(index,{kind:"log",...log} as any,f);
  const transfer=new Interface(["event Transfer(address indexed from,address indexed to,uint256 amount)"]).encodeEventLog("Transfer",[sender,emitter,1n]);
  const claim=new Interface(raw.managerCustody.ledgerEvents).encodeEventLog("Transfer",[token,sender,emitter,BigInt(pool),5n]);
  assert.deepEqual(new Set(hit(swap(-1n,2n)).legIds),new Set(["1a","1b","address-only"]));
  assert.deepEqual(hit({address:token,...transfer}).fallbackLegIds,[]);
  assert.deepEqual(new Set(hit({address:token,...transfer}).legIds),new Set(["single","address-only"]));
  assert.deepEqual(hit({address:emitter,...claim}).legIds,["address-only"],"a claim id is not a logical pool id");
  assert.deepEqual(hit({address:foreign,...claim}).fallbackLegIds,["other"]);
  for(const l of [{address:emitter,...claim,data:"0x"},{address:emitter,topics:[p2],data:"0x"},
      {address:token,...transfer,data:"0x"},{address:token,...transfer,topics:[transfer.topics[0]!,p2,transfer.topics[2]!]}])
    assert.deepEqual(new Set(hit(l).fallbackLegIds),new Set(["1a","1b","2"]));
  assert.deepEqual(new Set(observePoolBalanceRefresh(index,[emitter]).fallbackLegIds),new Set(["1a","1b","2"]));
  const other=structuredClone(raw);delete other.managerCustody;
  assert.throws(()=>normalizeSelectorNativeExecutionDefinition(other),/manager custody/);
  delete other.physicalPoolActivity;
  const mixed=createSqlEdgePriceLogScopes([def,normalizeSelectorNativeExecutionDefinition(other)]);
  assert.deepEqual(new Set(hit({address:token,...transfer},mixed).fallbackLegIds),new Set(["1a","1b","2"]));
  assert.equal(mixed({address:emitter,...claim}),null);
});
