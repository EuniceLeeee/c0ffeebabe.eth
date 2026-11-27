import assert from "node:assert/strict";
import { isEnabledSqlExecutionLeg } from "./sql-execution-selectors.js";
import { getAddress } from "ethers";
import { buildFamilyRouteGraphView } from "./adapter-family-graph-runtime.js";
import type { TokenEdge } from "./planner/token-graph.js";
import { sqlDirectionId, type SqlPriceEdge } from "./sql-edge-price-index.js";
import type { CanonicalSource } from "./venues/adapter-request-program.js";
import { StrictProductionRuntimeRoot, strictReadyGraphContractFingerprint, type StrictReadyFundingAsset } from "./strict-production-runtime-session.js";
import { StrictReadyGraphViewCoordinator } from "./strict-ready-graph-view.js";
import { assertIssuedPreparedFamilyInstance, type PreparedFamilyInstance } from "./venues/adapter-family-runtime.js";
import { hashCanonical, type CanonicalValue } from "./venues/canonical-value.js";
import { productionPoolLogScopes } from "./venues/production-pool-log-scopes.js";
import { settlementAssetRankingActors } from "./venues/settlement-asset-ranking-activity.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "./venues/production-family-composition.js";
import { assertSqlLiveRouteBinding } from "./venues/selector-native-sql-live-binding.js";
import { issuedSqlTrialVariant } from "./venues/selector-native-sql-live-materializer.js";
import { GENERATED_PRODUCTION_FAMILY_ENTRIES } from "./generated/production-family-entries.generated.js";
import { selectorExecutionResourceKey } from "./venues/selector-execution-keys.js";
import type { CanonicalEdgeId } from "./venues/blockscan-state-capability.js";
import { deriveEdgeTaxonomy } from "./strategy-taxonomy.js";
import type { PoolActivityRule } from "./pool-leg-refresh.js";

export const sqlSelectorModules: ReadonlyMap<string,(typeof GENERATED_PRODUCTION_FAMILY_ENTRIES)[number]["module"]["selectorFamilyModule"]> =
  new Map(GENERATED_PRODUCTION_FAMILY_ENTRIES.map(e => {
    const m=e.module.selectorFamilyModule; return [m.definition.selector,m] as const;
  }));
assert.equal(sqlSelectorModules.size,GENERATED_PRODUCTION_FAMILY_ENTRIES.length,"ambiguous registered SQL selector ownership");

/** A registered conversion has one public identity before any recipe is considered.
 * Token graph settlement aliases (e.g. a native-currency boundary) are allowed
 * only where ALL issued recipes agree; the literal SQL id is never re-derived. */
export type SqlTrialGraphMetadata=Pick<TokenEdge,"tokenIn"|"tokenOut"|"slotKind"|"protocolAction"|"stateResourceKey">;
export type SqlTrialMarket={readonly graph:SqlTrialGraphMetadata;readonly variants:ReadonlyMap<string,"on-touch"|"each-block">};
function sqlGraphDirection(sql:SqlPriceEdge, alternatives:readonly TokenEdge[],trial?:SqlTrialGraphMetadata):TokenEdge {
  const id=sql.candidateInstanceKey,m=sqlSelectorModules.get(sql.selector);
  assert(m && isEnabledSqlExecutionLeg(m),"SQL row is not an enabled execution leg");
  assert.equal(id,sqlDirectionId(sql),"SQL leg ID differs from pool, asset or direction");
  const {domain,ownedActionAdapterIds}=m.plugin.manifest;
  assert((domain==="swap"||domain==="protocol")&&ownedActionAdapterIds.length===1,"SQL direction lacks a unique conversion action owner");
  const adapterId=ownedActionAdapterIds[0]!, exemplar=alternatives[0]??trial;
  const tokenIn=exemplar?.tokenIn??sql.tokenIn,tokenOut=exemplar?.tokenOut??sql.tokenOut;
  const slotKind=exemplar?.slotKind??domain,protocolAction=exemplar?.protocolAction;
  const stateResourceKey=exemplar?.stateResourceKey??selectorExecutionResourceKey({chainId:sql.chainId,target:sql.poolAddress,
    ...(sql.poolId===null?{}:{poolId:sql.poolId,...(sql.poolNamespace===null?{}:{poolNamespace:sql.poolNamespace})})});
  for(const e of alternatives){
    assert(e.adapterId===adapterId&&e.slotKind===slotKind&&e.protocolAction===protocolAction&&
      e.tokenIn.toLowerCase()===tokenIn.toLowerCase()&&e.tokenOut.toLowerCase()===tokenOut.toLowerCase()&&
      e.stateResourceKey===stateResourceKey,"private recipes disagree about the public SQL direction");
  }
  return Object.freeze({canonicalEdgeId:id as CanonicalEdgeId,instanceKey:id,adapterId,
    target:sql.poolAddress,observationTarget:sql.poolAddress,...(sql.poolId===null?{}:{observationPoolId:sql.poolId,poolId:sql.poolId}),
    stateResourceKey,tokenIn,tokenOut,slotKind,...(protocolAction===undefined?{}:{protocolAction}),
    ...deriveEdgeTaxonomy(slotKind,protocolAction),executionVerification:"startup-simulation"});
}

/** The issuer, not the SQL row, grants a route capability. The materializer
 * authenticates the exact selector/program, resource scope and asset pair.
 * Only an issuer-owned handle can cross the execution boundary below. */
export interface SqlLiveMaterializedRoute {
  readonly sqlEdgeKey: string;
  readonly instance: PreparedFamilyInstance;
  readonly routeKey: string;
  readonly programKey: string;
}

const verifiedFundingBindingCache = new WeakMap<StrictReadyFundingAsset, string>();

/** Build the existing live graph/root. This producer owns neither a head loop
 * nor a price solver, and cannot submit, sign or issue a Ready checkpoint. */
export function buildSqlEdgeLiveProducer(input: {
  readonly source: CanonicalSource;
  readonly edges: readonly SqlPriceEdge[];
  readonly swapTableSha256: string;
  readonly fundingAssets: readonly StrictReadyFundingAsset[];
  readonly fundingTableSha256: string;
  readonly currentHead: number;
  readonly materialized: readonly SqlLiveMaterializedRoute[];
  readonly unavailable: readonly {readonly sqlEdgeKey:string; readonly reason:string}[];
  readonly trialMarkets?:ReadonlyMap<string,SqlTrialMarket>;
  readonly retainedUnavailableMarkets?:ReadonlyMap<string,SqlTrialGraphMetadata>;
  readonly runtimeRootOnly?: boolean;
}) {
  const { source,edges,swapTableSha256,fundingAssets,fundingTableSha256,materialized,unavailable } = input;
  assert(Number.isSafeInteger(input.currentHead) && input.currentHead >= source.number, "SQL topology is ahead of the current source");
  assert(/^[a-f0-9]{64}$/.test(swapTableSha256),"missing authenticated SQL swap table");
  assert(/^[a-f0-9]{64}$/.test(fundingTableSha256), "missing authenticated SQL funding table");
  assert(fundingAssets.length > 0, "SQL live input has no funding source");
  const fundingBindings = new Set<string>();
  for (const f of fundingAssets) {
    let key = verifiedFundingBindingCache.get(f);
    if (key === undefined) {
      assert(f.binding && f.binding.chainId === 1 && getAddress(f.asset) === getAddress(f.binding.asset), "SQL funding provider/asset binding is required");
      assert(catalog.forStrictFamily(f.familyId).plugin.manifest.domain === "funding", "non-funding Family in SQL funding table");
      key = hashCanonical([f.familyId, f.binding as unknown as CanonicalValue]);
      if (Object.isFrozen(f) && Object.isFrozen(f.binding)) {
        verifiedFundingBindingCache.set(f, key);
      }
    }
    assert(!fundingBindings.has(key), "duplicate SQL funding binding");
    fundingBindings.add(key);
  }
  const inputEdges = new Map(edges.map(e => [e.candidateInstanceKey,e]));
  assert(edges.length>0 && inputEdges.size===edges.length,"duplicate or empty SQL directions");
  const unavailableKeys = new Set<string>(), causes = new Map<string,number>();
  for(const {sqlEdgeKey,reason} of unavailable) {
    assert(inputEdges.has(sqlEdgeKey) && !unavailableKeys.has(sqlEdgeKey) && reason.trim().length>0,"foreign, duplicate or unexplained SQL exclusion");
    unavailableKeys.add(sqlEdgeKey);causes.set(reason,(causes.get(reason)??0)+1);
  }
  const instances = new Map<string, PreparedFamilyInstance>();
  const sqlByRoute = new Map<PreparedFamilyInstance, Map<string,{key:string;programKey:string}>>();
  const seenKeys = new Set<string>();
  for (const { sqlEdgeKey, instance, routeKey,programKey } of materialized) {
    assert(inputEdges.has(sqlEdgeKey) && !unavailableKeys.has(sqlEdgeKey), "foreign or excluded SQL live binding");
    seenKeys.add(sqlEdgeKey);
    const family = catalog.forStrictFamily(instance.familyId);
    assert(["swap","protocol"].includes(family.plugin.manifest.domain), "non-conversion Family in SQL swap table");
    const k = JSON.stringify([instance.familyId, instance.instanceKey]), prior = instances.get(k);
    if (!prior) {
      assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
      instances.set(k,instance);
      sqlByRoute.set(instance,new Map());
    } else assert(prior === instance, "conflicting issued instances for one SQL binding");
    const owned = sqlByRoute.get(instance)!;
    assert(!owned.has(routeKey), "one live route cannot stand in for multiple SQL edges");
    owned.set(routeKey,{key:sqlEdgeKey,programKey});
  }
  const trials=input.trialMarkets??new Map<string,SqlTrialMarket>();
  const retained=input.retainedUnavailableMarkets??new Map<string,SqlTrialGraphMetadata>();
  for(const id of retained.keys())assert(unavailableKeys.has(id)&&!seenKeys.has(id)&&!trials.has(id),
    "retained SQL nomination must have an explicit current-source refusal and no authority");
  for(const [id,entry] of trials)assert(inputEdges.has(id)&&!seenKeys.has(id)&&!unavailableKeys.has(id)&&entry.variants.size>0,
    "SQL trial price candidate is foreign, empty, duplicated or already admitted");
  assert(seenKeys.size+unavailableKeys.size+trials.size===edges.length,"SQL directions missing a binding or disposition");
  const bySql = new Map<string, TokenEdge[]>();
  const byCanonical = new Map<string,string>();
  const paidAliases = new Map<string,ReadonlyMap<string,string>>();
  for (const [instance, owned] of sqlByRoute) {
    const family = catalog.forFamily(instance.familyId);
    const projected = buildFamilyRouteGraphView({routes: instance.routes.map((route, index) => ({
      family, descriptor: instance.descriptor, route, handle: instance.routeHandles[index]!,
    }))});
    assert(owned.size === projected.routes.length, "unobserved or missing direction in SQL Family projection");
    for (const {handle, edge} of projected.routes) {
      const binding = owned.get(handle.routeKey), sql = binding && inputEdges.get(binding.key);
      assert(binding && sql && !byCanonical.has(edge.canonicalEdgeId), "SQL live projection has no unique source row");
      const key=binding.key;
      const matched = assertSqlLiveRouteBinding({edge:sql, programKey:binding.programKey,
        source, family, instance, routeKey:handle.routeKey});
      assert.equal(matched,handle,"SQL live graph did not retain its bound handle");
      assert(!edge.leavesStandingPosition && edge.executionVerification === "startup-simulation", "SQL direction lacks funded execution policy");
      assert(catalog.ownerOfAction(edge.adapterId) === family.plugin.manifest.familyId, "SQL action ownership changed");
      const alternatives=bySql.get(key)??[]; alternatives.push(edge); bySql.set(key,alternatives); byCanonical.set(edge.canonicalEdgeId,key);
      const alias=issuedSqlTrialVariant(instance,handle.routeKey,binding.programKey);
      if(alias){
        const aliases=new Map(paidAliases.get(key));assert(!aliases.has(alias),"ambiguous issued encoding for SQL price receipt");
        aliases.set(alias,edge.canonicalEdgeId);paidAliases.set(key,aliases);
      }
    }
  }
  assert.equal(byCanonical.size,materialized.length,"SQL projection lost issued routes");
  assert.equal(bySql.size,seenKeys.size,"SQL projection lost observed directions");
  // The graph is projected from the SQL table, never by enumerating recipes.
  const logicalRoutes=new Map<string,readonly TokenEdge[]>(), graph:TokenEdge[]=[];
  let disabled=0,notConversion=0,unavailableEnabledDirections=0,retainedUnavailableDirections=0;
  for(const sql of edges){
    const id=sql.candidateInstanceKey,m=sqlSelectorModules.get(sql.selector);
    if(!m||!isEnabledSqlExecutionLeg(m)){
      assert(unavailableKeys.has(id),"inactive SQL direction acquired an executable recipe");
      if(m&&!m.activation.enabled)disabled++;else notConversion++;
      continue;
    }
    assert.equal(id,sqlDirectionId(sql),"SQL leg ID differs from pool, asset or direction");
    if(unavailableKeys.has(id)){
      unavailableEnabledDirections++;
      if(!retained.has(id))continue;
      retainedUnavailableDirections++;
    }
    const recipes=Object.freeze((bySql.get(id)??[]).sort((a,b)=>a.canonicalEdgeId!<b.canonicalEdgeId!?-1:1));
    logicalRoutes.set(id,recipes);graph.push(sqlGraphDirection(sql,recipes,trials.get(id)?.graph??retained.get(id)));
  }
  assert(graph.length===edges.length-disabled-notConversion-unavailableEnabledDirections+retainedUnavailableDirections,"SQL graph does not conserve admitted directions and exclusions");
  assert(graph.length>0,"SQL swap table has no enabled conversion direction");
  const sqlPoolActivity=new Map<string,PoolActivityRule>();
  for(const edge of edges){
    if(!logicalRoutes.has(edge.candidateInstanceKey))continue;
    const module=sqlSelectorModules.get(edge.selector);
    if(!module||!isEnabledSqlExecutionLeg(module)||!module.definition.directState)continue;
    const state=module.definition.directState;
    assert(state.poolId?edge.poolId!==null&&(edge.poolNamespace===null||edge.poolNamespace===state.poolNamespace):
      edge.poolId===null&&edge.poolNamespace===null,"source state differs from the SQL physical pool scope");
    sqlPoolActivity.set(edge.candidateInstanceKey,Object.freeze({on:state.on,assets:Object.freeze([edge.tokenIn,edge.tokenOut])}));
  }
  const runtimeRoot = new StrictProductionRuntimeRoot({catalog,poolLogScopes:productionPoolLogScopes(),sqlPoolActivity,historicalAssetLogActors:settlementAssetRankingActors,
    readySource:source,readyGraph:graph,readyInstances:[...instances.values()],readyFundingAssets:fundingAssets,logicalRoutes,paidAliases,
    ...(trials.size?{sqlTrialMarkets:new Map([...trials].map(([id,m])=>[id,m.variants]))}:{})});
  if (input.runtimeRootOnly) {
    return { runtimeRoot, graph, graphViewCoordinator: undefined as unknown as StrictReadyGraphViewCoordinator,
      fingerprint: "", inputSummary: { rows: edges.length, enabledDirections: graph.length, boundDirections: seenKeys.size,
        issuedLegs: seenKeys.size, privateRecipes: materialized.length, trialDirections: trials.size, disabled, notConversion,
        unavailableEnabledDirections, retainedUnavailableDirections, unboundDirections: graph.length - seenKeys.size,
        reasons: Object.fromEntries(causes) },
      topologyKey: "", flashTokens: Object.freeze([] as readonly string[]), selectorMode: true, instanceCount: graph.length,
      lineage: Object.freeze({ generation: source.generation, graphHash: "", catalogHash: catalog.catalogHash, cutoffNumber: source.number,
        appliedThroughNumber: source.number, appliedThroughHash: source.hash, sourceCount: 0 }),
      baselineSummary: Object.freeze({ generation: source.generation, cutoffNumber: source.number, activeInstanceCount: graph.length, observationScanFrom: source.number }) };
  }
  const graphHash = strictReadyGraphContractFingerprint(graph);
  const familyOwners = new Set(graph.map(e=>catalog.ownerOfAction(e.adapterId)));
  const sourceCoverage = [
    ...[...familyOwners].sort().map(familyId => ({familyId,sourceId:"swap:"+swapTableSha256})),
    ...[...new Set(fundingAssets.map(f => f.familyId))].sort().map(familyId => ({familyId,sourceId:"funding:"+fundingTableSha256})),
  ];
  const fingerprint = hashCanonical([trials.size?"sql-edge-live/direct-trial-v1":"sql-edge-live/v3", source.number, source.hash, graphHash, catalog.catalogHash,
    swapTableSha256,fundingTableSha256,[...fundingBindings].sort(),
    [...byCanonical].sort(([a],[b]) => a.localeCompare(b))]);
  const graphViewCoordinator = new StrictReadyGraphViewCoordinator({catalog,publicationKind:"sql-edges",
    ready:{generation:source.generation,graphHash,catalogHash:catalog.catalogHash,sourceCoverage},edges:graph});
  return { runtimeRoot, graph, graphViewCoordinator, fingerprint,
    inputSummary:{rows:edges.length,enabledDirections:graph.length,boundDirections:seenKeys.size,issuedLegs:seenKeys.size,
      privateRecipes:materialized.length,trialDirections:trials.size,disabled,notConversion,unavailableEnabledDirections,retainedUnavailableDirections,unboundDirections:graph.length-seenKeys.size,reasons:Object.fromEntries(causes)},
    topologyKey:`sql-edges:${source.generation}:${graphHash}`,
    flashTokens:Object.freeze([...new Set(fundingAssets.map(f=>getAddress(f.asset).toLowerCase()))].sort()),
    selectorMode:true,instanceCount:graph.length,
    lineage:Object.freeze({generation:source.generation,graphHash,catalogHash:catalog.catalogHash,cutoffNumber:source.number,
      appliedThroughNumber:source.number,appliedThroughHash:source.hash,sourceCount:sourceCoverage.length}),
    baselineSummary:Object.freeze({generation:source.generation,cutoffNumber:source.number,activeInstanceCount:graph.length,observationScanFrom:source.number}) };
}
