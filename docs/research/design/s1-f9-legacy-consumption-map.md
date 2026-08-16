# S1 F9 Legacy Registry Consumption Map

> Dated 2026-08-17. Grounded in a full-file read of every production consumer
> plus the registry surface (production-registry.ts, adapter-family-registry.ts,
> route-leg-registry.ts, route-instance-identity.ts). Paths are the actual
> repo locations under listener/src/searcher/ (task-list paths corrected:
> planner/quoter.ts -> solver/quoter.ts; planner/plan-builder.ts ->
> solver/plan-builder.ts; solver/revm-live-backend.ts ->
> live-backends/revm-live-backend.ts; planner/path-template.ts ->
> templates/path-template.ts).

## Consumers (10 files)

| File | Lines | Registry methods consumed |
|---|---|---|
| planner/token-graph.ts | 691 | routes() findForPool 307/504, buildEdges 496, protocols() 245, POOL_REGISTRY import 243-246 |
| solver/quoter.ts | 72 | routes() findForEdge 49; quoteExact CALLED 54 |
| solver/plan-builder.ts | 162 | routes() findForEdge 102, defaultFunding() 50, findFundingByAction() 149; buildPlanFragment CALLED 106; buildFlashLoanRoot CALLED 151 |
| live-backends/revm-live-backend.ts | 596 | routes() findForEdge 459; prepared.quote CALLED 461 (legacy lane, Pair E) |
| solver/pool-state-updater.ts | 463 | routes() findForEdge 432 |
| solver/solver.ts | 1026 | routes() findForEdge 914; credits() 722/832 |
| solver/amount-propagation.ts | 186 | routes() findForEdge 159; credits() 82; creditPolicy.quoteOutputByDebtBps CALLED 86 |
| solver/flash-liquidity.ts | 137 | funding() 35, defaultFunding() 122; DEFAULT_FLASH_PROVIDERS import 34-41 |
| planner/planner.ts | 905 | defaultFunding() 190/390, findFundingByAction() 440 |
| templates/path-template.ts | 85 | routes() list 55, fundingActionIds() 61/76, creditActionIds() 62; TRADE_LEG_ADAPTERS + PathTemplate exports import 54-85 |

## Family fields read (metadata vs behavioral)

Behavioral (called functions, F9 deletion targets):
- buildEdges (token-graph 496)
- quoteExact (quoter 54)
- buildPlanFragment (plan-builder 106)
- prepared.quote (revm-live-backend 461)
- creditPolicy.quoteOutputByDebtBps (amount-propagation 86)
- buildFlashLoanRoot (plan-builder 151)

Metadata / identity-key derivation (read-only):
- id, declaredVenues, kind, livePoolState.kind, edgeAdapterIds,
  allowedTaxonomy, creditPolicy.debtBpsCandidates,
  creditPolicy.blocksPrefixInversion, prepared.quoteUnsupportedReason,
  funding.actionAdapterId / liquidityPriority / liquidityHolder / target,
  routeIdentity / planExecutionIdentity (route-instance-identity helpers:
  token-graph 313/505, inside buildEdges binding).

## Import-time (module side-effect) reads — cutover-critical

These freeze registry-derived data at FIRST IMPORT; F9 must neutralize them
with the registry cutover in the same commit:
- POOL_REGISTRY (token-graph 243-246; mergeDeclaredProtocolVenues at 249)
- DEFAULT_FLASH_PROVIDERS (flash-liquidity 34-41)
- TRADE_LEG_ADAPTERS + both PathTemplate exports (path-template 54-85)

## Strict-side equivalents (F8 status)

- ONLY live-backends/revm-live-backend.ts has real strict reads:
  strictExecutionProjectionForHop -> prewarmQuoteCalls 425-434 and
  allowanceSpender 584-588; resolveFundingPrewarmAddresses 235-243/362-368;
  strictRoutePrewarmAddresses 248-254/375-381;
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG default 239-240/366-367.
  Legacy quote (prepared.quote, findForEdge) intentionally remains until
  "Pair E" (comment 28-30).
- The other 9 files have ZERO strict-catalog identifiers. canonicalEdgeId in
  token-graph is a TokenEdge OUTPUT of the legacy buildEdges identity binding,
  not a strict read.

## Runtime/discovery consumers (16 files, second pass)

> Same-date second pass: detector, discovery, runtime coordinators and tools.
> Paths are actual repo locations under listener/src/searcher/ (task-list
> paths corrected; shared/evidence/canonical-edge-set.ts sits outside
> searcher/). Registry API surface per file below.

| File | Registry methods consumed | Classification | Strict-side |
|---|---|---|---|
| detector/detector.ts (295) | oracleVictims() L64-66 (runtime match L182-190), routes().findForEdge L137 (family.id only) | read-only | none |
| detector/blockscan-scanner.ts (151) | routes().findForEdge L136 (family.kind/id dispatch to mid-reader) | read-only dispatch (legacy facade; production = blockscan-scanner-production.ts) | none |
| detector/pool-impact.ts (1273) | swaps() L999-1003/L1019; family.observation RUNTIME (decodeReceiptImpacts L936, decodeDirectCallImpacts L608, observedPoolIdentity L1064, topics L871, anonymousLogs L873); family.id/edgeAdapterIds | **runtime observation dispatcher - deepest runtime coupling** | none |
| active-pool-discovery.ts (1096) | matureDexUniversePoolAdapters() L73 (-> factoryDiscoverySourcesForPoolAdapters capability.ts L178, FACTORIES L72-87), landedPoolDiscovery() L400 (event descriptors L589/L605) | runtime discovery; identity admission already strict | attestPoolsStrictFromProvider L493-504, STRICT_IDENTITY_ADMISSION L23-24, strict option L104/129/320/413/530-533 |
| build-active-pool-universe.ts (1076) | landedPoolDiscovery() L267/L334-339 (event labels), swaps() L325-328 (matureDexUniverseDiscovery/poolAdapters), retainVerifiedSwapFamilyInstances L344 (swap-family-inventory.ts L75-77), productionPoolUniverseSourceFingerprintsStrict L479 | offline universe builder; read-only metadata | attestPoolsStrictFromProvider L1053, strictAttestation L353-357, strict:true L281 |
| blind-production-compatibility.ts (478) | routes().findForEdge()?.id L181-182/L379-380 (throws); family fields on caller-supplied arrays L256/L258/L423-435/L451-455 | T1 frozen-baseline projection; blindCompatibilityCanonicalEdgeId is T1 identity, NOT strict canonicalEdgeId | none |
| venues/route-family-manifest.ts (85) | routes().list() L84 -> deriveRouteFamilyManifest L42-81 (kind/id/requiresProtocolEdgesFlag/poolAdapters/edgeAdapterIds/ownedActionAdapterIds/requiredInfraActionAdapterIds/discovery.candidateSources/declaredVenues) | module-load projection; PRODUCTION_ROUTE_FAMILY_MANIFEST L95; never a registration source | none |
| live-discovery-coordinator.ts (2811) | landedPoolDiscovery() L328-329/L557/L562 (consumesMaterializationRetries), routes().findForPool L704-705/L710-717, forEdge L707-708, discoverableRoutes() L954/L2169-2172/L2257 (adapters for protocol passes), PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS L955/L2259 | runtime discovery | attestPoolsStrictFromProvider L2480, strictStartupDexIdentityRetryStage L2475-2513, PRODUCTION_IDENTITY_ADMISSION L581 |
| live-backends/victim-overlay.ts (99) | victimModels().forEdge(adapterId)?.runtime?.buildOverlay L18-23/L53-57 (RUNTIME callback L80), routes().findForEdge L50-52 (family?.id fallback L58) | runtime victim overlay dispatch | none |
| discover-routers.ts (369) | landedEvents().eventsForTopic L150-152 -> observedLandedPoolIdentity L151 | runtime tool; read-only descriptors | none |
| auto-close-router-gap.ts (487) | landedEvents().eventsForTopic L295-297 -> observedLandedPoolIdentity L296 | runtime tool; read-only | none |
| shared/evidence/canonical-edge-set.ts (251, outside searcher/) | routes() L127 (forEdge L141 familyIdForEdge, forEdge L147 matureDex shard filter, list L152), swaps() L130-138 (matureDexUniverseDiscovery/poolDiscovery/id), family.discovery L160 | graph evidence artifact; read-only shard-completeness | none |
| adapter-family-graph-view-coordinator.ts (184) | routes().findForPool L58 (owner.id L59), registryBackedDiscoveryFamilies L62-63, landedPoolDiscovery().list L88-93 (exact-set check L99-107), routes().forEdge L168 | read-only completeness/ownership; produces VerifiedGraphView | none directly |
| adapter-runtime-coordinator.ts (1283) | blockScanStateFamilies() L264/L344 (RUNTIME pricing via coordinator prepare), isBlockScanPricedEdge L265/L345, fundingStateFamilies() L728 (family.describeSources L736 RUNTIME, family.prepare L808 RUNTIME; sources/offers/coverageByFundingId L929-942) | **runtime current-N pricing + funding executor** | strictDefinitionBoundaryHash carried via registry strictCatalog hook (registry-internal) |
| protocol-discovery-coordinator.ts (397) | input.registry.swaps() L275-277 (poolAdapters -> protocolCandidateAddressesFromDexUniverse L279-283), discoverableRoutes() L286 (candidateAddressHints L284-288) | read-only candidate-domain built once | none |
| venues/pool-adapter-policy.ts (41) | isRegisteredVenueId L29 (unions legacy + strict labels L33-34), isRegisteredIdentitySource L40; PRODUCTION_POOL_ADAPTERS L12-19 built from STRICT catalog (manifest.poolAdapterIds) | membership checks | **strict primary - core set already strict-catalog-sourced** |

## Cross-cutting summary (both passes)

- No consumer calls routes().buildEdges / quoteExact / prepared.quote /
  buildPlanFragment / pricingState.compileStateInstance directly - those are
  downstream (solver/quoter/plan-builder/revm-live-backend/token-graph).
- Coupling classes: (a) identity/ownership lookups findForPool/findForEdge/
  forEdge; (b) family-list projections swaps()/routes().list()/
  discoverableRoutes()/registryBackedDiscoveryFamilies(); (c) sub-registry
  projections landedPoolDiscovery()/landedEvents()/victimModels()/
  oracleVictims()/blockScanStateFamilies()/fundingStateFamilies();
  (d) membership checks isRegisteredVenueId/isRegisteredIdentitySource;
  (e) runtime callbacks executed in consumers: family.observation
  (pool-impact), victimModels().forEdge().runtime.buildOverlay
  (victim-overlay), funding describeSources/prepare
  (adapter-runtime-coordinator).
- Strict-side already present: strict identity attestation (F6 Pair B) in
  active-pool-discovery/build-active-pool-universe/live-discovery-coordinator;
  pool-adapter-policy set already strict-sourced. No consumer references
  strictQuoteSource/views.edges/canonicalEdgeId (downstream only).
- Indirect consumption via helpers: factoryDiscoverySourcesForPoolAdapters
  (capability.ts L178), retainVerifiedSwapFamilyInstances
  (swap-family-inventory.ts L35), protocolDiscoveryCandidateAddressHints
  (protocol-discovery-runtime.ts L132), shouldTraceForProtocolDiscovery
  (observed-protocol-discovery.ts L213), discoverLandedPools
  (landed-pool-discovery.ts).

## F9 implications

1. The 6 behavioral call-sites (solver pass) are the legacy runtime
   call-sites the MigrationCleanupReceipt probes track; deleting them flips
   verdict=pass. The detector/discovery pass adds two more runtime callbacks
   to neutralize in the same slice: family.observation
   (detector/pool-impact.ts) and victimModels().forEdge().runtime.buildOverlay
   (live-backends/victim-overlay.ts) plus the funding runtime executor
   (adapter-runtime-coordinator.ts describeSources/prepare) - these are the
   detector-side and funding-side legacy runtime surfaces.
2. The 3 import-time registries (POOL_REGISTRY, DEFAULT_FLASH_PROVIDERS,
   TRADE_LEG_ADAPTERS + PathTemplate exports) must be removed in the same F9
   slice (module-load freeze).
3. revm-live-backend's legacy quote lane (prepared.quote) is the Pair E
   legacy fallback; F9 removes it only after the strict quote source is
   proven in the live pipeline (F5 acceptance).
