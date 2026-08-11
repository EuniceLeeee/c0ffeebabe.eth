import assert from "node:assert/strict";
import {
  catalogDiscoverySourceFingerprint,
  catalogInstancePublicationKey,
  createCatalogPublicationValueAuthority,
  createCatalogSourceTransitionIssuer,
  createCatalogTerminalRemovalIssuer,
  prepareAdapterFamilyCatalogPublication,
  type AdapterFamilyCatalogDefinition,
  type AdapterFamilyCatalogPublicationEnvelope,
  type CatalogDiscoverySourceAnchor,
  type CatalogDiscoveryAuthority,
  type CatalogFamilyStage,
  type CatalogPublicationValueAuthority,
  type CatalogStagedInstance,
  type CatalogStagedInstanceBundle,
} from "../adapter-family-catalog-publication.js";
import { familyId } from "../venues/adapter-family-identifiers.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";

const SWAP = familyId("swap:state-carry-proof-fixture");
const FUNDING = familyId("funding:state-carry-proof-fixture");
const SOURCE_ID = "factory-log";
const CATALOG_HASH = "state-carry-proof-fixture-v1";
const CHAIN_ID = "1";

interface InstanceValue {
  label: string;
  nested?: { count: number };
  boundGeneration?: number;
}

interface OpaqueValue {
  label: string;
  nested?: { count: number };
}

type Envelope = AdapterFamilyCatalogPublicationEnvelope<
  InstanceValue,
  OpaqueValue,
  OpaqueValue,
  OpaqueValue
>;
type Stage = CatalogFamilyStage<
  InstanceValue,
  OpaqueValue,
  OpaqueValue,
  OpaqueValue
>;
type Bundle = CatalogStagedInstanceBundle<
  InstanceValue,
  OpaqueValue,
  OpaqueValue,
  OpaqueValue
>;
type ValueAuthority = CatalogPublicationValueAuthority<
  InstanceValue,
  OpaqueValue,
  OpaqueValue,
  OpaqueValue
>;

const TERMINAL_ISSUER = createCatalogTerminalRemovalIssuer();
const TRANSITION_ISSUER = createCatalogSourceTransitionIssuer();
const DEEP_AUTHORITY = deepAuthority();
const SHALLOW_CARRY_AUTHORITY = shallowCarryAuthority();
const SHALLOW_SEAL_AUTHORITY = shallowSealAuthority();

const DEFINITION: AdapterFamilyCatalogDefinition = Object.freeze({
  catalogHash: CATALOG_HASH,
  families: Object.freeze([
    Object.freeze({
      familyId: SWAP,
      domain: "swap" as const,
      sourceIds: Object.freeze([SOURCE_ID]),
      requiresGraphProjection: true,
      requiresPricingProjection: true,
    }),
    Object.freeze({
      familyId: FUNDING,
      domain: "funding" as const,
      sourceIds: Object.freeze([]),
      requiresGraphProjection: false,
      requiresPricingProjection: false,
    }),
  ]),
  terminalRemovalAuthority: TERMINAL_ISSUER.authority,
  sourceTransitionAuthority: TRANSITION_ISSUER.authority,
});

function source(
  number = 25_700_100,
  generation = number - 25_700_000,
): CanonicalSource {
  return Object.freeze({
    number,
    hash: `0x${number.toString(16).padStart(64, "0")}`,
    generation,
  });
}

function descriptor(
  label: string,
  value?: InstanceValue,
): CatalogStagedInstance<InstanceValue> {
  return {
    familyId: SWAP,
    lineageId: "univ2",
    instanceKey: `pool:${label}`,
    fingerprint: `fingerprint:${label}`,
    value: value ?? { label },
  };
}

function bundle(
  canonical: CanonicalSource,
  label: string,
  value?: InstanceValue,
): Bundle {
  const instance = descriptor(label, value);
  const publicationKey = catalogInstancePublicationKey(instance);
  const routeKey = `edge:${label}`;
  return {
    instancePublicationKey: publicationKey,
    source: canonical,
    instance,
    routeHandles: new Map([[routeKey, {
      fingerprint: `route:${label}`,
      value: { label: `route:${label}` },
    }]]),
    graphEntries: new Map([[routeKey, {
      fingerprint: `graph:${label}`,
      value: { label: `graph:${label}` },
    }]]),
    pricingEntries: new Map([[`pricing:${label}`, {
      fingerprint: `pricing:${label}`,
      value: { label: `pricing:${label}` },
    }]]),
  };
}

function fundingBundle(canonical: CanonicalSource): Bundle {
  const instance: CatalogStagedInstance<InstanceValue> = {
    familyId: FUNDING,
    lineageId: "funding-state",
    instanceKey: "state:funding",
    fingerprint: "funding-state:v1",
    value: { label: "funding-state" },
  };
  return {
    instancePublicationKey: catalogInstancePublicationKey(instance),
    source: canonical,
    instance,
    routeHandles: new Map(),
    graphEntries: new Map(),
    pricingEntries: new Map(),
  };
}

function anchor(
  canonical: CanonicalSource,
  options: {
    readonly status?: "complete" | "partial";
    readonly authority?: CatalogDiscoveryAuthority;
  } = {},
): CatalogDiscoverySourceAnchor {
  const status = options.status ?? "complete";
  return Object.freeze({
    familyId: SWAP,
    sourceId: SOURCE_ID,
    sourceFingerprint: catalogDiscoverySourceFingerprint({
      familyId: SWAP,
      sourceId: SOURCE_ID,
      source: canonical,
    }),
    authority: options.authority ?? "append-only-nomination",
    status,
    completeThroughBlock: status === "complete" ? canonical.number : -1,
    completeThroughHash: status === "complete" ? canonical.hash : null,
  });
}

function swapStage(
  canonical: CanonicalSource,
  instances: readonly Bundle[] = [],
): Stage {
  return Object.freeze({
    familyId: SWAP,
    domain: "swap",
    source: canonical,
    status: "resolved",
    inventoryMode: "append-only-delta",
    instances,
  });
}

function fundingStage(canonical: CanonicalSource): Stage {
  return Object.freeze({
    familyId: FUNDING,
    domain: "funding",
    source: canonical,
    status: "resolved",
    inventoryMode: "complete-snapshot",
    instances: [fundingBundle(canonical)],
  });
}

function prepare(input: {
  readonly canonical: CanonicalSource;
  readonly previous?: Envelope | null;
  readonly swap?: Stage;
  readonly valueAuthority?: ValueAuthority;
}): Envelope {
  return prepareAdapterFamilyCatalogPublication({
    definition: DEFINITION,
    chainId: CHAIN_ID,
    source: input.canonical,
    previous: input.previous ?? null,
    stages: [
      input.swap ?? swapStage(input.canonical),
      fundingStage(input.canonical),
    ],
    sourceAnchors: [anchor(input.canonical)],
    valueAuthority: input.valueAuthority ?? DEEP_AUTHORITY,
  });
}

function deepCloneAndFreezePlain<Value>(value: Value): Value {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => deepCloneAndFreezePlain(item))) as Value;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("plain fixture authority rejects opaque non-plain values");
  }
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = deepCloneAndFreezePlain(item);
  }
  return Object.freeze(copy) as Value;
}

function assertDeepFrozenPlain(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true, "fixture value must be frozen");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("fixture value must remain plain");
  }
  for (const item of Object.values(value)) assertDeepFrozenPlain(item);
}

function plainValueContract<Value>() {
  return {
    seal: (value: Value): Value => deepCloneAndFreezePlain(value),
    carry: (value: Value): Value => deepCloneAndFreezePlain(value),
    assertValid: (value: Value): void => assertDeepFrozenPlain(value),
  };
}

function deepAuthority(): ValueAuthority {
  return createCatalogPublicationValueAuthority({
    instance: {
      seal: (
        value: InstanceValue,
        binding: { readonly source: CanonicalSource },
      ): InstanceValue => deepCloneAndFreezePlain({
        ...value,
        boundGeneration: binding.source.generation,
      }),
      carry: (
        value: InstanceValue,
        binding: {
          readonly current: { readonly source: CanonicalSource };
        },
      ): InstanceValue => deepCloneAndFreezePlain({
        ...value,
        boundGeneration: binding.current.source.generation,
      }),
      assertValid: (
        value: InstanceValue,
        binding: { readonly source: CanonicalSource },
      ): void => {
        assertDeepFrozenPlain(value);
        if (value.boundGeneration !== binding.source.generation) {
          throw new Error(
            `value remains bound to generation ${String(value.boundGeneration)}; ` +
              `expected ${binding.source.generation}`,
          );
        }
      },
    },
    routeHandle: plainValueContract<OpaqueValue>(),
    graphEntry: plainValueContract<OpaqueValue>(),
    pricingEntry: plainValueContract<OpaqueValue>(),
  });
}

/**
 * Seal is deep-correct, but carry returns a top-frozen clone whose nested
 * object is a fresh mutable object. Only the central deep-seal gate can
 * reject this; the contract's own assertValid deliberately skips deep checks.
 */
function shallowCarryAuthority(): ValueAuthority {
  return createCatalogPublicationValueAuthority({
    instance: {
      seal: (
        value: InstanceValue,
        binding: { readonly source: CanonicalSource },
      ): InstanceValue => deepCloneAndFreezePlain({
        ...value,
        boundGeneration: binding.source.generation,
      }),
      carry: (
        value: InstanceValue,
        binding: {
          readonly current: { readonly source: CanonicalSource };
        },
      ): InstanceValue => Object.freeze({
        ...value,
        nested: { count: value.nested?.count ?? 1 },
        boundGeneration: binding.current.source.generation,
      }),
      assertValid: (
        value: InstanceValue,
        binding: { readonly source: CanonicalSource },
      ): void => {
        if (value.boundGeneration !== binding.source.generation) {
          throw new Error(
            `value remains bound to generation ${String(value.boundGeneration)}; ` +
              `expected ${binding.source.generation}`,
          );
        }
      },
    },
    routeHandle: plainValueContract<OpaqueValue>(),
    graphEntry: plainValueContract<OpaqueValue>(),
    pricingEntry: plainValueContract<OpaqueValue>(),
  });
}

function shallowSealAuthority(): ValueAuthority {
  return createCatalogPublicationValueAuthority({
    instance: {
      seal: (value: InstanceValue): InstanceValue => Object.freeze({
        ...value,
        nested: { count: value.nested?.count ?? 1 },
      }),
      carry: (value: InstanceValue): InstanceValue => value,
      assertValid: (): void => {},
    },
    routeHandle: plainValueContract<OpaqueValue>(),
    graphEntry: plainValueContract<OpaqueValue>(),
    pricingEntry: plainValueContract<OpaqueValue>(),
  });
}

function capturePublishedValues(envelope: Envelope): string {
  return JSON.stringify({
    instances: [...envelope.privateState.instances.entries()].map(
      ([key, entry]) => [key, entry.value],
    ),
    routeHandles: [...envelope.privateState.routeHandles.entries()].map(
      ([key, entry]) => [key, entry.value],
    ),
  });
}

function testSealRejectsNestedMutableValue(): void {
  const canonical = source();
  assert.throws(() => prepare({
    canonical,
    valueAuthority: SHALLOW_SEAL_AUTHORITY,
    swap: swapStage(canonical, [
      bundle(canonical, "nested-mutable", { label: "x", nested: { count: 1 } }),
    ]),
  }), /authority returned an unsealed value/);
}

function testCarryRejectsShallowFrozenCloneAndKeepsPreviousUnchanged(): void {
  const firstSource = source();
  const first = prepare({
    canonical: firstSource,
    valueAuthority: SHALLOW_CARRY_AUTHORITY,
    swap: swapStage(firstSource, [
      bundle(firstSource, "incumbent", { label: "incumbent", nested: { count: 1 } }),
    ]),
  });
  const before = capturePublishedValues(first);
  const nextSource = source(25_700_101);
  assert.throws(() => prepare({
    canonical: nextSource,
    previous: first,
    valueAuthority: SHALLOW_CARRY_AUTHORITY,
  }), /authority returned an unsealed value/);
  assert.equal(capturePublishedValues(first), before);
}

function testCarryRebindsGenerationAndKeepsPreviousImmutable(): void {
  const firstSource = source();
  const stagedValue: InstanceValue = { label: "incumbent", nested: { count: 1 } };
  const first = prepare({
    canonical: firstSource,
    swap: swapStage(firstSource, [
      bundle(firstSource, "incumbent", stagedValue),
    ]),
  });
  stagedValue.nested!.count = 999;
  stagedValue.label = "mutated-after-seal";
  const key = catalogInstancePublicationKey(descriptor("incumbent"));
  const firstValue = first.privateState.instances.get(key)?.value;
  assert.equal(firstValue?.label, "incumbent");
  assert.equal(firstValue?.nested?.count, 1);
  assert.equal(firstValue?.boundGeneration, firstSource.generation);
  assert.equal(Object.isFrozen(firstValue?.nested), true);

  const nextSource = source(25_700_101);
  const carried = prepare({ canonical: nextSource, previous: first });
  const carriedValue = carried.privateState.instances.get(key)?.value;
  assert.equal(carriedValue?.label, "incumbent");
  assert.equal(carriedValue?.nested?.count, 1);
  assert.equal(carriedValue?.boundGeneration, nextSource.generation);
  assert.equal(Object.isFrozen(carriedValue?.nested), true);
  assert.deepEqual(carried.snapshot.source, nextSource);
  assert.deepEqual(
    carried.privateState.routeHandles.get("edge:incumbent")?.source,
    nextSource,
  );

  const afterFirstValue = first.privateState.instances.get(key)?.value;
  assert.equal(afterFirstValue?.label, "incumbent");
  assert.equal(afterFirstValue?.boundGeneration, firstSource.generation);
  assert.equal(afterFirstValue?.nested?.count, 1);
}

function testCyclicFrozenValueAcceptedAndMutableContainerRejected(): void {
  const canonical = source();
  const cyclicRoot: Record<string, unknown> = { label: "cycle" };
  cyclicRoot.self = cyclicRoot;
  Object.freeze(cyclicRoot);
  const cyclicAuthority = createCatalogPublicationValueAuthority({
    instance: {
      seal: (): InstanceValue => cyclicRoot as unknown as InstanceValue,
      carry: (value: InstanceValue): InstanceValue => value,
      assertValid: (): void => {},
    },
    routeHandle: plainValueContract<OpaqueValue>(),
    graphEntry: plainValueContract<OpaqueValue>(),
    pricingEntry: plainValueContract<OpaqueValue>(),
  });
  const accepted = prepare({
    canonical,
    valueAuthority: cyclicAuthority,
    swap: swapStage(canonical, [
      bundle(canonical, "cycle", cyclicRoot as unknown as InstanceValue),
    ]),
  });
  assert.equal(
    accepted.privateState.instances.has(
      catalogInstancePublicationKey(descriptor("cycle")),
    ),
    true,
  );

  const mapContainer = Object.freeze({
    label: "map",
    container: Object.freeze(new Map([["k", 1]])),
  });
  const mapAuthority = createCatalogPublicationValueAuthority({
    instance: {
      seal: (): InstanceValue => mapContainer as unknown as InstanceValue,
      carry: (value: InstanceValue): InstanceValue => value,
      assertValid: (): void => {},
    },
    routeHandle: plainValueContract<OpaqueValue>(),
    graphEntry: plainValueContract<OpaqueValue>(),
    pricingEntry: plainValueContract<OpaqueValue>(),
  });
  assert.throws(() => prepare({
    canonical,
    valueAuthority: mapAuthority,
    swap: swapStage(canonical, [
      bundle(canonical, "map", mapContainer as unknown as InstanceValue),
    ]),
  }), /unsupported mutable container/);
}

async function main(): Promise<void> {
  testSealRejectsNestedMutableValue();
  testCarryRejectsShallowFrozenCloneAndKeepsPreviousUnchanged();
  testCarryRebindsGenerationAndKeepsPreviousImmutable();
  testCyclicFrozenValueAcceptedAndMutableContainerRejected();
  console.log("adapter-family state carry/mutation proof tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
