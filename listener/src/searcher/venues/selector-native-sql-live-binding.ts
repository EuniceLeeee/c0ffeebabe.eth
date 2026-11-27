import { ZeroAddress } from 'ethers';
import type { CanonicalSource } from './adapter-request-program.js';
import { assertFamilyRouteRuntimeHandleBinding, assertIssuedFamilyRouteRuntimeHandleAtSource,
  assertIssuedPreparedFamilyInstance, type FamilyRouteRuntimeHandle, type PreparedFamilyInstance } from './adapter-family-runtime.js';
import { type LoadedPricedFamilyPlugin } from './family-capability-catalog.js';
import { selectorFamilyIdentity } from './selector-execution-keys.js';

export interface SqlLiveEdgeCoordinates {
  readonly chainId: number; readonly selector: string; readonly poolAddress: string;
  readonly familyIds?: readonly string[];
  readonly poolId?: string | null; readonly poolNamespace?: string | null;
  readonly tokenIn: string; readonly tokenOut: string; readonly tokenInId?: string | null; readonly tokenOutId?: string | null;
  readonly hookData?: string | null;
}
const obj = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
const addrEqual = (a: unknown, b: unknown) => typeof a === 'string' && /^0x[\da-f]{40}$/i.test(a) && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
function requireBinding(ok: unknown, reason: string): asserts ok { if (!ok) throw new Error('SQL live route binding: ' + reason); }

export class MissingSqlPricingPoolOwner extends Error {
  constructor(){super("SQL live route binding: Family has no declared pricing-pool owner");}
}

/** Match a funded SQL price to an already-issued selector Family route. These are two
 * independent inputs: the SQL row supplies no authority, and the caller cannot mint a
 * route by making an object in the shape of a descriptor or a runtime handle. */
export function assertSqlLiveRouteBinding(input: {
  readonly edge: SqlLiveEdgeCoordinates; readonly programKey: string; readonly source: CanonicalSource;
  readonly family: LoadedPricedFamilyPlugin; readonly instance: PreparedFamilyInstance; readonly routeKey: string;
}): FamilyRouteRuntimeHandle {
  const { edge, programKey, source, family, instance, routeKey } = input;
  assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
  const routes = instance.routes.filter(r => r.routeKey === routeKey);
  const handles = instance.routeHandles.filter(h => h.routeKey === routeKey);
  requireBinding(routes.length === 1 && handles.length === 1, 'absent or ambiguous issued direction');
  const route = routes[0]!, handle = handles[0]!;
  assertIssuedFamilyRouteRuntimeHandleAtSource({ family, handle, source, generation: source.generation });
  assertFamilyRouteRuntimeHandleBinding(family, handle, instance.descriptor, route);
  const args = { descriptor: instance.descriptor, route };
  const projection = family.plugin.routes.projectGraph(args), identity = obj(projection.venueIdentity);
  requireBinding(identity && typeof identity.signature === 'string' && identity.selector === edge.selector &&
    selectorFamilyIdentity(identity.signature, edge.selector).familyId === instance.familyId &&
    (edge.familyIds === undefined || edge.familyIds.includes(instance.familyId)), 'selector/ABI owner differs');
  requireBinding(/^parameters:[a-f0-9]{64}$/.test(programKey) && identity.programKey === programKey &&
    projection.executionVerification === 'startup-simulation', 'winning execution recipe differs');
  const resource = obj(identity.resource), scope = obj(identity.scope);
  requireBinding(edge.chainId === 1 && scope?.chainId === edge.chainId && resource?.chainId === edge.chainId &&
    identity.resources === undefined && addrEqual(resource.target, edge.poolAddress) &&
    (resource.poolId ?? null) === (edge.poolId ?? null) &&
    (edge.poolNamespace == null || edge.poolNamespace === resource.poolNamespace), 'physical pool differs or is composite');
  for (const [token, side, address, assetId, scopeId] of [
    [edge.tokenIn, route.executionAssets?.input, route.tokenIn, edge.tokenInId, scope.tokenInId],
    [edge.tokenOut, route.executionAssets?.output, route.tokenOut, edge.tokenOutId, scope.tokenOutId],
  ] as const) {
    requireBinding(side === 'native' ? addrEqual(token, ZeroAddress) : !addrEqual(token, ZeroAddress) && addrEqual(token, address), 'asset or direction differs');
    requireBinding((assetId ?? null) === (scopeId ?? null), 'token identifier differs');
  }
  const pools = family.plugin.routes.pricingPools?.(args);
  if(!pools?.length)throw new MissingSqlPricingPoolOwner();
  requireBinding(pools.length === 1 && addrEqual(pools[0]!.poolAddress, edge.poolAddress) &&
    (pools[0]!.poolId ?? null) === (edge.poolId ?? null) &&
    (pools[0]!.poolNamespace ?? null) === (resource.poolNamespace ?? null), 'pricing-pool ownership differs');
  return handle;
}
