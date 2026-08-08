import { deriveEdgeTaxonomy } from "./strategy-taxonomy.js";
import type { TokenEdge } from "./planner/token-graph.js";
import {
  assertFamilyRouteRuntimeHandleBinding,
  assertIssuedFamilyRouteRuntimeHandle,
  assertIssuedFamilyRouteRuntimeHandleAtSource,
  type FamilyRouteRuntimeHandle,
} from "./venues/adapter-family-runtime.js";
import type {
  CompiledInstanceDescriptor,
  FamilyGraphProjection,
  FamilyRouteDescriptor,
  RouteProjectionSemantics,
} from "./venues/adapter-family-plugin.js";
import {
  canonicalEdgeId,
  type CanonicalEdgeId,
} from "./venues/blockscan-state-capability.js";
import {
  hashCanonical,
  type CanonicalValue,
} from "./venues/canonical-value.js";
import {
  assertIssuedLoadedFamilyBox,
  type LoadedFamilyPlugin,
} from "./venues/family-capability-catalog.js";
import {
  assertIssuedProjectedCreditRoute,
  type CreditRouteRuntimeHandle,
  type ProjectedCreditRouteGraph,
} from "./adapter-credit-runtime.js";

export interface FamilyRouteGraphInput {
  readonly family: LoadedFamilyPlugin;
  readonly descriptor: CompiledInstanceDescriptor;
  readonly route: FamilyRouteDescriptor;
  readonly handle: FamilyRouteRuntimeHandle;
}

export interface ProjectedFamilyRouteGraph {
  readonly edge: TokenEdge & { readonly canonicalEdgeId: CanonicalEdgeId };
  readonly graph: FamilyGraphProjection;
  readonly venueIdentityHash: string;
  readonly handle: FamilyRouteRuntimeHandle;
}

interface ProjectedFamilyRouteGraphIssue {
  readonly family: LoadedFamilyPlugin;
  readonly handle: FamilyRouteRuntimeHandle;
}

const issuedProjectedFamilyRouteGraphs = new WeakMap<
  object,
  ProjectedFamilyRouteGraphIssue
>();

export type CommonProjectedFamilyRouteGraph =
  | ProjectedFamilyRouteGraph
  | ProjectedCreditRouteGraph;

export type CommonFamilyRouteRuntimeHandle =
  | FamilyRouteRuntimeHandle
  | CreditRouteRuntimeHandle;

export interface FamilyRouteGraphView {
  readonly routes: readonly CommonProjectedFamilyRouteGraph[];
  readonly edges: readonly (TokenEdge & {
    readonly canonicalEdgeId: CanonicalEdgeId;
  })[];
  readonly handleByCanonicalEdgeId: ReadonlyMap<
    CanonicalEdgeId,
    CommonFamilyRouteRuntimeHandle
  >;
}

/**
 * Project issuer handles into the legacy-compatible TokenEdge shell. Raw
 * protocol route fields remain in the issuer store; the compatibility edge
 * carries only kernel fields and a venue/binding-bound canonical identity.
 */
export function buildFamilyRouteGraphView(input: {
  readonly routes: readonly FamilyRouteGraphInput[];
  readonly creditRoutes?: readonly ProjectedCreditRouteGraph[];
  readonly centralScores?: ReadonlyMap<string, number>;
}): FamilyRouteGraphView {
  const creditRoutes = (input.creditRoutes ?? []).map((route) => {
    assertIssuedProjectedCreditRoute(route);
    return route;
  });
  const routes: CommonProjectedFamilyRouteGraph[] = [
    ...input.routes.map((route) =>
      projectFamilyRouteGraph(route, input.centralScores)
    ),
    ...creditRoutes,
  ];
  const anchor = routes[0]?.handle;
  if (anchor !== undefined) {
    for (const projected of routes.slice(1)) {
      const handle = projected.handle;
      if (
        handle.generation !== anchor.generation ||
        handle.source.number !== anchor.source.number ||
        handle.source.hash.toLowerCase() !== anchor.source.hash.toLowerCase() ||
        handle.source.generation !== anchor.source.generation
      ) {
        throw new Error("Family graph view cannot mix publication sources");
      }
    }
  }
  const handles = new Map<CanonicalEdgeId, CommonFamilyRouteRuntimeHandle>();
  for (const projected of routes) {
    const edgeId = projected.edge.canonicalEdgeId;
    if (handles.has(edgeId)) {
      throw new Error(`duplicate canonical Family edge ${edgeId}`);
    }
    handles.set(edgeId, projected.handle);
  }
  return Object.freeze({
    routes: Object.freeze(routes),
    edges: Object.freeze(routes.map((item) => item.edge)),
    handleByCanonicalEdgeId: new SealedReadonlyMap(handles),
  });
}

export function projectFamilyRouteGraph(
  input: FamilyRouteGraphInput,
  centralScores?: ReadonlyMap<string, number>,
): ProjectedFamilyRouteGraph {
  assertIssuedLoadedFamilyBox(input.family);
  const manifest = input.family.plugin.manifest;
  assertIssuedFamilyRouteRuntimeHandle(input.family, input.handle);
  assertFamilyRouteRuntimeHandleBinding(
    input.family,
    input.handle,
    input.descriptor,
    input.route,
  );
  assertRouteAuthority(input);

  const semantics = (
    input.family.plugin as unknown as {
      readonly routes: RouteProjectionSemantics<
        CompiledInstanceDescriptor,
        FamilyRouteDescriptor
      >;
    }
  ).routes;
  const first = validateGraphProjection(
    semantics.projectGraph({
      descriptor: input.descriptor,
      route: input.route,
    }),
  );
  const second = validateGraphProjection(
    semantics.projectGraph({
      descriptor: input.descriptor,
      route: input.route,
    }),
  );
  assertFamilyRouteRuntimeHandleBinding(
    input.family,
    input.handle,
    input.descriptor,
    input.route,
  );
  if (graphProjectionHash(first) !== graphProjectionHash(second)) {
    throw new Error(`route ${input.route.routeKey} graph projection is unstable`);
  }
  if (!manifest.ownedActionAdapterIds.includes(first.routeActionAdapterId)) {
    throw new Error(
      `route ${input.route.routeKey} projected non-owned root ` +
        first.routeActionAdapterId,
    );
  }

  const taxonomy = input.route.taxonomy;
  const protocolAction = taxonomy.slotKind === "protocol"
    ? taxonomy.protocolAction
    : undefined;
  const venueIdentityHash = hashCanonical(first.venueIdentity);
  const executionVariantKey = familyRouteGraphExecutionVariantKey({
    route: input.route,
    graph: first,
  });
  const score = first.centralScoreKey === undefined
    ? 0
    : centralScores?.get(first.centralScoreKey) ?? 0;
  if (!Number.isFinite(score) || score < 0) {
    throw new Error(
      `central score ${first.centralScoreKey} must be finite and non-negative`,
    );
  }
  const unboundEdge: TokenEdge = {
    instanceKey: input.route.instanceKey,
    executionVariantKey,
    adapterId: first.routeActionAdapterId,
    target: first.executionTarget,
    tokenIn: input.route.tokenIn,
    tokenOut: input.route.tokenOut,
    slotKind: taxonomy.slotKind,
    ...(protocolAction === undefined ? {} : { protocolAction }),
    ...deriveEdgeTaxonomy(taxonomy.slotKind, protocolAction),
    score,
  };
  const edge = Object.freeze({
    ...unboundEdge,
    canonicalEdgeId: familyRouteCanonicalEdgeId({
      route: input.route,
      graph: first,
    }),
  });
  const projected = Object.freeze({
    edge,
    graph: first,
    venueIdentityHash,
    handle: input.handle,
  });
  issuedProjectedFamilyRouteGraphs.set(projected, Object.freeze({
    family: input.family,
    handle: input.handle,
  }));
  return projected;
}

/** Runtime authenticity/source check for all-catalog publication. */
export function assertIssuedProjectedFamilyRouteGraph(input: {
  readonly family: LoadedFamilyPlugin;
  readonly projected: ProjectedFamilyRouteGraph;
  readonly source: import("./venues/adapter-request-program.js").CanonicalSource;
}): void {
  assertIssuedLoadedFamilyBox(input.family);
  const issue = issuedProjectedFamilyRouteGraphs.get(input.projected);
  if (
    issue === undefined ||
    issue.family !== input.family ||
    issue.handle !== input.projected.handle ||
    !Object.isFrozen(input.projected) ||
    !Object.isFrozen(input.projected.edge) ||
    !Object.isFrozen(input.projected.graph)
  ) {
    throw new Error(
      "Family Graph route must be issued by the central Graph runtime",
    );
  }
  assertIssuedFamilyRouteRuntimeHandleAtSource({
    family: input.family,
    handle: input.projected.handle,
    source: input.source,
    generation: input.source.generation,
  });
}

/** Protocol-neutral identity component shared by Graph projection and CAS. */
export function familyRouteGraphExecutionVariantKey(input: {
  readonly route: FamilyRouteDescriptor;
  readonly graph: FamilyGraphProjection;
}): string {
  return hashCanonical({
    namespace: "adapter-family-graph-route-v1",
    routeKey: input.route.routeKey,
    routeBindingFingerprint: input.route.bindingRef.fingerprint,
    venueIdentityHash: hashCanonical(input.graph.venueIdentity),
  });
}

/**
 * Compute the canonical ID from public route/Graph identity only. Authority is
 * still enforced by projectFamilyRouteGraph before an edge is published.
 */
export function familyRouteCanonicalEdgeId(input: {
  readonly route: FamilyRouteDescriptor;
  readonly graph: FamilyGraphProjection;
}): CanonicalEdgeId {
  const taxonomy = input.route.taxonomy;
  const protocolAction = taxonomy.slotKind === "protocol"
    ? taxonomy.protocolAction
    : undefined;
  const identityEdge: TokenEdge = {
    instanceKey: input.route.instanceKey,
    executionVariantKey: familyRouteGraphExecutionVariantKey(input),
    adapterId: input.graph.routeActionAdapterId,
    target: input.graph.executionTarget,
    tokenIn: input.route.tokenIn,
    tokenOut: input.route.tokenOut,
    slotKind: taxonomy.slotKind,
    ...(protocolAction === undefined ? {} : { protocolAction }),
    ...deriveEdgeTaxonomy(taxonomy.slotKind, protocolAction),
    score: 0,
  };
  return canonicalEdgeId(input.route.familyId, identityEdge);
}

function assertRouteAuthority(input: FamilyRouteGraphInput): void {
  const familyId = input.family.plugin.manifest.familyId;
  if (
    input.descriptor.familyId !== familyId ||
    input.route.familyId !== familyId ||
    input.handle.familyId !== familyId
  ) {
    throw new Error("Family graph route escaped its catalog owner");
  }
  if (
    input.route.lineageId !== input.descriptor.lineageId ||
    input.handle.lineageId !== input.route.lineageId
  ) {
    throw new Error("Family graph route lineage mismatch");
  }
  if (
    input.route.instanceKey !== input.descriptor.instanceKey ||
    input.handle.instanceKey !== input.route.instanceKey
  ) {
    throw new Error("Family graph route instance mismatch");
  }
  if (input.handle.routeKey !== input.route.routeKey) {
    throw new Error("Family graph route handle key mismatch");
  }
  if (!Number.isSafeInteger(input.handle.generation) || input.handle.generation < 0) {
    throw new Error("Family graph route handle generation is invalid");
  }
  assertAddress(input.route.tokenIn, "route tokenIn");
  assertAddress(input.route.tokenOut, "route tokenOut");
  if (input.route.tokenIn.toLowerCase() === input.route.tokenOut.toLowerCase()) {
    throw new Error("Family graph route must change token");
  }
  if (
    typeof input.route.bindingRef?.fingerprint !== "string" ||
    input.route.bindingRef.fingerprint.length === 0
  ) {
    throw new Error("Family graph route binding fingerprint is required");
  }
  const taxonomyKey = JSON.stringify([
    input.route.taxonomy.slotKind,
    input.route.taxonomy.protocolAction ?? null,
  ]);
  const allowed = input.family.plugin.manifest.allowedTaxonomy.some((item) =>
    JSON.stringify([item.slotKind, item.protocolAction ?? null]) === taxonomyKey
  );
  if (!allowed) throw new Error("Family graph route taxonomy is not allowed");
}

function validateGraphProjection(value: unknown): FamilyGraphProjection {
  if (!isPlainRecord(value)) {
    throw new Error("Family graph projection must be a plain record");
  }
  const allowed = new Set([
    "centralScoreKey",
    "executionTarget",
    "routeActionAdapterId",
    "venueIdentity",
  ]);
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new Error(`unsupported Family graph projection field ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new Error(
        `Family graph projection field ${key} must be enumerable data`,
      );
    }
  }
  for (const key of [
    "executionTarget",
    "routeActionAdapterId",
    "venueIdentity",
  ]) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`Family graph projection omitted ${key}`);
    }
  }
  if (
    typeof value.routeActionAdapterId !== "string" ||
    value.routeActionAdapterId.length === 0
  ) {
    throw new Error("Family graph root ActionAdapter id is required");
  }
  if (typeof value.executionTarget !== "string") {
    throw new Error("Family graph execution target is required");
  }
  assertAddress(value.executionTarget, "Family graph execution target");
  if (
    value.centralScoreKey !== undefined &&
    (typeof value.centralScoreKey !== "string" ||
      value.centralScoreKey.length === 0)
  ) {
    throw new Error("Family graph central score key must be non-empty");
  }
  // Validate the Family-owned value before copying it so accessors, symbols,
  // sparse arrays, cycles and unsupported values fail closed.
  hashCanonical(value.venueIdentity as CanonicalValue);
  const venueIdentity = sealCanonicalValue(value.venueIdentity);
  return Object.freeze({
    routeActionAdapterId: value.routeActionAdapterId,
    executionTarget: value.executionTarget,
    venueIdentity,
    ...(value.centralScoreKey === undefined
      ? {}
      : { centralScoreKey: value.centralScoreKey }),
  });
}

function graphProjectionHash(value: FamilyGraphProjection): string {
  return hashCanonical({
    routeActionAdapterId: value.routeActionAdapterId,
    executionTarget: value.executionTarget.toLowerCase(),
    venueIdentity: value.venueIdentity,
    centralScoreKey: value.centralScoreKey ?? null,
  });
}

function sealCanonicalValue(value: unknown): CanonicalValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Family graph canonical numbers must be finite");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map(sealCanonicalValue));
  }
  if (!isPlainRecord(value)) {
    throw new Error("Family graph venue identity must be canonical");
  }
  const output: Record<string, CanonicalValue> = {};
  for (const key of Object.keys(value).sort()) {
    output[key] = sealCanonicalValue(value[key]);
  }
  return Object.freeze(output);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertAddress(value: string, label: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${label} must be a 20-byte address`);
  }
}

class SealedReadonlyMap<Key, Value> implements ReadonlyMap<Key, Value> {
  readonly #values: Map<Key, Value>;

  constructor(values: ReadonlyMap<Key, Value>) {
    this.#values = new Map(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  get(key: Key): Value | undefined {
    return this.#values.get(key);
  }

  has(key: Key): boolean {
    return this.#values.has(key);
  }

  entries(): MapIterator<[Key, Value]> {
    return this.#values.entries();
  }

  keys(): MapIterator<Key> {
    return this.#values.keys();
  }

  values(): MapIterator<Value> {
    return this.#values.values();
  }

  forEach(
    callbackfn: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
    thisArg?: unknown,
  ): void {
    this.#values.forEach((value, key) => {
      callbackfn.call(thisArg, value, key, this);
    });
  }

  [Symbol.iterator](): MapIterator<[Key, Value]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return "SealedReadonlyMap";
  }
}

Object.freeze(SealedReadonlyMap.prototype);
