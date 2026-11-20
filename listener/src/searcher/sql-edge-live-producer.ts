import assert from "node:assert/strict";
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
import { GENERATED_PRODUCTION_FAMILY_ENTRIES } from "./generated/production-family-entries.generated.js";
import { selectorExecutionResourceKey } from "./venues/selector-execution-keys.js";
import type { CanonicalEdgeId } from "./venues/blockscan-state-capability.js";
import { deriveEdgeTaxonomy } from "./strategy-taxonomy.js";

export const sqlSelectorModules: ReadonlyMap<string,(typeof GENERATED_PRODUCTION_FAMILY_ENTRIES)[number]["module"]["selectorFamilyModule"]> =
  new Map(GENERATED_PRODUCTION_FAMILY_ENTRIES.map(e => {
    const m=e.module.selectorFamilyModule; return [m.definition.selector,m] as const;
  }));
assert.equal(sqlSelectorModules.size,GENERATED_PRODUCTION_FAMILY_ENTRIES.length,"ambiguous registered SQL selector ownership");

/** A registered conversion has one public identity before any recipe is considered.
 * Token graph settlement aliases (e.g. a native-currency boundary) are allowed
 * only where ALL issued recipes agree; the literal SQL id is never re-derived. */
function sqlGraphDirection(sql:SqlPriceEdge, alternatives:readonly TokenEdge[]):TokenEdge {
  const id=sql.candidateInstanceKey,m=sqlSelectorModules.get(sql.selector);
  assert(m?.activation.enabled,"SQL row is not an enabled selector");
  assert.equal(id,sqlDirectionId(sql),"SQL leg ID differs from pool, asset or direction");
  const {domain,ownedActionAdapterIds}=m.plugin.manifest;
  assert((domain==="swap"||domain==="protocol")&&ownedActionAdapterIds.length===1,"SQL direction lacks a unique conversion action owner");
  const adapterId=ownedActionAdapterIds[0]!, exemplar=alternatives[0];
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
}) {
  const { source,edges,swapTableSha256,fundingAssets,fundingTableSha256,materialized,unavailable } = input;
  assert(Number.isSafeInteger(input.currentHead) && input.currentHead >= source.number, "SQL topology is ahead of the current source");
  assert(/^[a-f0-9]{64}$/.test(swapTableSha256),"missing authenticated SQL swap table");
  assert(/^[a-f0-9]{64}$/.test(fundingTableSha256), "missing authenticated SQL funding table");
  assert(fundingAssets.length > 0, "SQL live input has no funding source");
  const fundingBindings = new Set<string>();
  for (const f of fundingAssets) {
    assert(f.binding && f.binding.chainId === 1 && getAddress(f.asset) === getAddress(f.binding.asset), "SQL funding provider/asset binding is required");
    assert(catalog.forStrictFamily(f.familyId).plugin.manifest.domain === "funding", "non-funding Family in SQL funding table");
    const key = hashCanonical([f.familyId, f.binding as unknown as CanonicalValue]);
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
  assert(seenKeys.size+unavailableKeys.size===edges.length,"SQL directions missing a binding or disposition");
  const bySql = new Map<string, TokenEdge[]>();
  const byCanonical = new Map<string,string>();
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
    }
  }
  assert.equal(byCanonical.size,materialized.length,"SQL projection lost issued routes");
  assert.equal(bySql.size,seenKeys.size,"SQL projection lost observed directions");
  // The graph is projected from the SQL table, never by enumerating recipes.
  const logicalRoutes=new Map<string,readonly TokenEdge[]>(), graph:TokenEdge[]=[];
  let disabled=0,notConversion=0;
  for(const sql of edges){
    const id=sql.candidateInstanceKey,m=sqlSelectorModules.get(sql.selector);
    if(!m||!m.activation.enabled||(m.definition.domain!=="swap"&&m.definition.domain!=="protocol")){
      assert(unavailableKeys.has(id),"inactive SQL direction acquired an executable recipe");
      if(m&&!m.activation.enabled)disabled++;else notConversion++;
      continue;
    }
    const recipes=Object.freeze((bySql.get(id)??[]).sort((a,b)=>a.canonicalEdgeId!<b.canonicalEdgeId!?-1:1));
    logicalRoutes.set(id,recipes);graph.push(sqlGraphDirection(sql,recipes));
  }
  assert(graph.length===edges.length-disabled-notConversion,"SQL graph does not conserve enabled directions");
  assert(graph.length>0,"SQL swap table has no enabled conversion direction");
  const graphHash = strictReadyGraphContractFingerprint(graph);
  const familyOwners = new Set(graph.map(e=>catalog.ownerOfAction(e.adapterId)));
  const sourceCoverage = [
    ...[...familyOwners].sort().map(familyId => ({familyId,sourceId:"swap:"+swapTableSha256})),
    ...[...new Set(fundingAssets.map(f => f.familyId))].sort().map(familyId => ({familyId,sourceId:"funding:"+fundingTableSha256})),
  ];
  const fingerprint = hashCanonical(["sql-edge-live/v3", source.number, source.hash, graphHash, catalog.catalogHash,
    swapTableSha256,fundingTableSha256,[...fundingBindings].sort(),
    [...byCanonical].sort(([a],[b]) => a.localeCompare(b))]);
  const runtimeRoot = new StrictProductionRuntimeRoot({catalog,poolLogScopes:productionPoolLogScopes(),historicalAssetLogActors:settlementAssetRankingActors,
    readySource:source,readyGraph:graph,readyInstances:[...instances.values()],readyFundingAssets:fundingAssets,logicalRoutes});
  const graphViewCoordinator = new StrictReadyGraphViewCoordinator({catalog,publicationKind:"sql-edges",
    ready:{generation:source.generation,graphHash,catalogHash:catalog.catalogHash,sourceCoverage},edges:graph});
  return { runtimeRoot, graph, graphViewCoordinator, fingerprint,
    inputSummary:{rows:edges.length,enabledDirections:graph.length,boundDirections:seenKeys.size,issuedLegs:graph.length,
      privateRecipes:materialized.length,disabled,notConversion,unboundDirections:graph.length-seenKeys.size,reasons:Object.fromEntries(causes)},
    topologyKey:`sql-edges:${source.generation}:${graphHash}`,
    flashTokens:Object.freeze([...new Set(fundingAssets.map(f=>getAddress(f.asset).toLowerCase()))].sort()),
    selectorMode:true,instanceCount:graph.length,
    lineage:Object.freeze({generation:source.generation,graphHash,catalogHash:catalog.catalogHash,cutoffNumber:source.number,
      appliedThroughNumber:source.number,appliedThroughHash:source.hash,sourceCount:sourceCoverage.length}),
    baselineSummary:Object.freeze({generation:source.generation,cutoffNumber:source.number,activeInstanceCount:graph.length,observationScanFrom:source.number}) };
}
