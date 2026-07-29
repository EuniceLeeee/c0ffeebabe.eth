import "../../shared/adapters/index.js";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listAll } from "../../adapters/registry.js";
import {
  PRODUCTION_ADAPTER_FAMILY_ACTIVATION_MANIFEST,
  type AdapterFamilyActivationRow,
} from "../venues/adapter-family-activation-manifest.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";
import type { ProtocolConversionAdapter } from "../venues/route-leg-adapter.js";

interface BaselineFunding {
  readonly actionAdapterId: string;
  readonly lineage: string;
  readonly target: string;
  readonly liquidityHolder: string;
  readonly repayment: string;
  readonly paramShape: string;
  readonly planningPriority: number;
  readonly liquidityPriority: number;
}

interface BaselineActiveSemantic {
  readonly baselineSemanticId: string;
  readonly baselineSurface:
    | "route-registry"
    | "legacy-route-edge"
    | "compat-route"
    | "flash-provider-descriptor";
  readonly familyId: string;
  readonly kind: string;
  readonly ownedActionAdapterIds: readonly string[];
  readonly requiredInfraActionAdapterIds: readonly string[];
  readonly poolAdapters: readonly string[];
  readonly edgeAdapterIds: readonly string[];
  readonly staticDeclaredVenueCount: number;
  readonly discoveryCandidateSources: readonly string[];
  readonly pricingRequired: boolean;
  readonly funding: BaselineFunding | null;
}

interface FrozenBaseline {
  readonly schemaVersion: 1;
  readonly baselineCommit: string;
  readonly staticDeclaredVenueCount: number;
  readonly preparedQuoteFamilyIds: readonly string[];
  readonly fundingPlanningOrder: readonly string[];
  readonly fundingLiquidityOrder: readonly string[];
  readonly defaultFundingFamilyId: string;
  readonly defaultFundingActionAdapterId: string;
  readonly declaredAdditionFamilyIds: readonly string[];
  /** Explicit admission-only migrations; the frozen historical rows stay truthful. */
  readonly declaredDiscoveryMigrations: Readonly<Record<string, readonly string[]>>;
  readonly baselineActive: readonly BaselineActiveSemantic[];
}

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/adapter-family-activation-baseline-040a9cc.json",
);
const baseline = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as FrozenBaseline;
const manifest = PRODUCTION_ADAPTER_FAMILY_ACTIVATION_MANIFEST;

function unique(values: readonly string[], label: string): void {
  assert.equal(new Set(values).size, values.length, `${label} must be unique`);
}

function baselineProjection(row: AdapterFamilyActivationRow): Omit<
  BaselineActiveSemantic,
  "baselineSemanticId" | "baselineSurface"
> {
  return {
    familyId: row.familyId,
    kind: row.kind,
    ownedActionAdapterIds: row.ownedActionAdapterIds,
    requiredInfraActionAdapterIds: row.requiredInfraActionAdapterIds,
    poolAdapters: row.route?.poolAdapters ?? [],
    edgeAdapterIds: row.route?.edgeAdapterIds ?? [],
    staticDeclaredVenueCount: row.route?.staticDeclaredVenueCount ?? 0,
    discoveryCandidateSources: row.route?.discovery?.candidateSources ?? [],
    pricingRequired: row.kind === "swap" || row.kind === "protocol-conversion",
    funding: row.funding,
  };
}

function testFrozenActivationSet(): void {
  assert.equal(baseline.schemaVersion, 1, "baseline schema");
  assert.equal(
    baseline.baselineCommit,
    "040a9ccdc190c7d0b4eb31fa9ae192079920d1f6",
    "baseline commit must remain explicit",
  );
  unique(
    baseline.baselineActive.map((entry) => entry.baselineSemanticId),
    "baseline semantic ids",
  );
  unique(
    baseline.baselineActive.map((entry) => entry.familyId),
    "baseline current family ids",
  );
  unique(baseline.declaredAdditionFamilyIds, "declared addition ids");
  unique(baseline.preparedQuoteFamilyIds, "prepared quote family ids");

  const currentById = new Map(manifest.families.map((row) => [row.familyId, row]));
  for (const expected of baseline.baselineActive) {
    const current = currentById.get(expected.familyId);
    assert(current, `baseline-active semantic ${expected.baselineSemanticId} disappeared`);
    const {
      baselineSemanticId: _semanticId,
      baselineSurface: _surface,
      ...expectedProjection
    } = expected;
    const currentProjection = baselineProjection(current);
    const migratedSources = baseline.declaredDiscoveryMigrations[expected.familyId];
    if (migratedSources !== undefined) {
      assert.deepEqual(
        currentProjection.discoveryCandidateSources,
        migratedSources,
        `declared discovery migration ${expected.familyId}`,
      );
    }
    const comparableCurrent = migratedSources === undefined
      ? currentProjection
      : {
        ...currentProjection,
        discoveryCandidateSources: expectedProjection.discoveryCandidateSources,
      };
    assert.deepEqual(
      comparableCurrent,
      expectedProjection,
      `baseline-active semantic ${expected.baselineSemanticId} changed activation`,
    );
  }

  const baselineIds = new Set(baseline.baselineActive.map((entry) => entry.familyId));
  const actualAdditions = manifest.familyOrder.filter((id) => !baselineIds.has(id));
  assert.deepEqual(
    actualAdditions,
    baseline.declaredAdditionFamilyIds,
    "new family must be predeclared as an activation addition",
  );
  for (const addition of baseline.declaredAdditionFamilyIds) {
    assert(currentById.has(addition), `declared addition ${addition} is absent`);
  }

  const preparedQuoteFamilyIds = manifest.families
    .filter((row) => row.route?.pricing?.hasPreparedQuote)
    .map((row) => row.familyId);
  assert.deepEqual(
    preparedQuoteFamilyIds,
    baseline.preparedQuoteFamilyIds,
    "prepared quote family coverage changed",
  );
  console.log("[adapter-family-activation] frozen baseline-active set: PASS");
  console.log("[adapter-family-activation] frozen prepared quote coverage: PASS");
}

function testUniversalDerivedViews(): void {
  unique(manifest.familyOrder, "family order");
  unique(manifest.routeFamilyOrder, "route family order");
  assert.equal(manifest.families.length, PRODUCTION_ADAPTER_FAMILIES.list().length);
  assert.deepEqual(
    manifest.familyOrder,
    PRODUCTION_ADAPTER_FAMILIES.list().map((family) => family.id),
    "manifest family order must derive from universal registry",
  );
  assert.deepEqual(
    manifest.routeFamilyOrder,
    PRODUCTION_ADAPTER_FAMILIES.routes().list().map((family) => family.id),
    "route projection must derive from universal registry",
  );

  const projectedByKind = {
    swap: PRODUCTION_ADAPTER_FAMILIES.swaps().map((family) => family.id),
    "protocol-conversion": PRODUCTION_ADAPTER_FAMILIES.protocols().map(
      (family) => family.id,
    ),
    "flash-loan": PRODUCTION_ADAPTER_FAMILIES.funding().map((family) => family.id),
    credit: PRODUCTION_ADAPTER_FAMILIES.credits().map((family) => family.id),
    liquidity: PRODUCTION_ADAPTER_FAMILIES.liquidities().map((family) => family.id),
  };
  for (const [kind, ids] of Object.entries(projectedByKind)) {
    const expected = manifest.families
      .filter((row) => row.kind === kind)
      .map((row) => row.familyId);
    assert.deepEqual(
      new Set(ids),
      new Set(expected),
      `${kind} derived view must cover its exact family set`,
    );
    assert.equal(manifest.kindCounts[kind as keyof typeof manifest.kindCounts], ids.length);
  }
  console.log("[adapter-family-activation] universal typed views: PASS");
}

function testOwnershipAndActionClosure(): void {
  const registeredActions = new Set(listAll().map((adapter) => adapter.id));
  const expectedActions = new Set<string>();
  const owned = new Set<string>();
  for (const row of manifest.families) {
    unique(row.ownedActionAdapterIds, `${row.familyId} owned actions`);
    unique(row.requiredInfraActionAdapterIds, `${row.familyId} infra actions`);
    for (const actionId of row.ownedActionAdapterIds) {
      assert(!owned.has(actionId), `owned ActionAdapter ${actionId} has multiple owners`);
      owned.add(actionId);
      expectedActions.add(actionId);
      assert.equal(
        PRODUCTION_ADAPTER_FAMILIES.ownerForAction(actionId),
        row.familyId,
        `${actionId} owner projection`,
      );
    }
    for (const actionId of row.requiredInfraActionAdapterIds) {
      assert(
        !row.ownedActionAdapterIds.includes(actionId),
        `${row.familyId} classifies ${actionId} as owned and infra`,
      );
      assert.equal(
        PRODUCTION_ADAPTER_FAMILIES.ownerForAction(actionId),
        null,
        `${actionId} shared infra must not acquire a family owner`,
      );
      expectedActions.add(actionId);
    }
  }
  assert.deepEqual(
    [...registeredActions].sort(),
    [...expectedActions].sort(),
    "production ActionAdapter bootstrap must equal the active family closure",
  );
  console.log("[adapter-family-activation] ActionAdapter ownership/closure: PASS");
}

function testRouteAndPricingCapabilities(): void {
  for (const family of PRODUCTION_ADAPTER_FAMILIES.routes().list()) {
    const row = manifest.families.find((candidate) => candidate.familyId === family.id);
    assert(row?.route, `${family.id} route inventory missing`);
    assert.equal(row.funding, null, `${family.id} route family declares funding`);
    assert.equal(typeof family.buildEdges, "function", `${family.id} buildEdges`);
    assert.equal(typeof family.quoteExact, "function", `${family.id} quoteExact`);
    assert.equal(
      typeof family.buildPlanFragment,
      "function",
      `${family.id} buildPlanFragment`,
    );
    for (const poolAdapter of family.poolAdapters) {
      assert.equal(
        PRODUCTION_ADAPTER_FAMILIES.routes().forPool(poolAdapter),
        family,
        `${family.id} pool claim`,
      );
    }
    for (const edgeAdapterId of family.edgeAdapterIds) {
      assert.equal(
        PRODUCTION_ADAPTER_FAMILIES.routes().forEdge(edgeAdapterId),
        family,
        `${family.id} edge claim`,
      );
    }

    const pricingRequired = family.kind === "swap" ||
      family.kind === "protocol-conversion";
    assert.equal(row.route.pricing !== null, pricingRequired, `${family.id} pricing lane`);
    if (row.route.pricing) {
      assert(
        row.route.pricing.hasPricingStateCapability,
        `${family.id} must expose family-owned current-N pricingState`,
      );
    }
    if (family.kind === "protocol-conversion") {
      const protocolFamily = family as ProtocolConversionAdapter;
      assert.equal(
        row.route.discovery !== null,
        protocolFamily.discovery !== undefined,
        `${family.id} discovery inventory`,
      );
      if (protocolFamily.discovery) {
        assert(row.route.discovery?.hasIdentityResolver, `${family.id} discovery identity`);
        assert(
          (row.route.discovery?.candidateSources.length ?? 0) > 0,
          `${family.id} discovery sources`,
        );
        assert.deepEqual(
          row.route.discovery?.candidateAddressHints,
          protocolFamily.discovery.candidateAddressHints ?? [],
          `${family.id} provenance address hints`,
        );
      }
    }
  }
  console.log("[adapter-family-activation] route/pricing/discovery capabilities: PASS");
}

function testFundingAndFrameworkBoundary(): void {
  for (const family of PRODUCTION_ADAPTER_FAMILIES.funding()) {
    const row = manifest.families.find((candidate) => candidate.familyId === family.id);
    assert(row?.funding, `${family.id} funding inventory missing`);
    assert.equal(row.route, null, `${family.id} flash family must not generate TokenEdge`);
    assert(
      family.ownedActionAdapterIds.includes(family.funding.actionAdapterId),
      `${family.id} must own its flash action`,
    );
  }
  assert(
    manifest.familyOrder.every((id) => !id.toLowerCase().includes("framework")),
    "shared frameworks must never become registry owners",
  );
  assert.deepEqual(manifest.fundingPlanningOrder, baseline.fundingPlanningOrder);
  assert.deepEqual(manifest.fundingLiquidityOrder, baseline.fundingLiquidityOrder);
  assert.equal(manifest.defaultFundingFamilyId, baseline.defaultFundingFamilyId);
  assert.equal(
    manifest.defaultFundingActionAdapterId,
    baseline.defaultFundingActionAdapterId,
  );
  assert.equal(
    manifest.staticDeclaredVenueCount,
    baseline.staticDeclaredVenueCount,
    "static declared venue count",
  );
  console.log("[adapter-family-activation] funding order/default + framework boundary: PASS");
}

testFrozenActivationSet();
testUniversalDerivedViews();
testOwnershipAndActionClosure();
testRouteAndPricingCapabilities();
testFundingAndFrameworkBoundary();
console.log(
  `adapter-family-activation-manifest PASS ` +
    `(${manifest.families.length} families, ${manifest.staticDeclaredVenueCount} static venues)`,
);
