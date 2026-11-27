import { assertVerifiedSelectorSourceCall, type VerifiedSelectorSourceCall } from './selector-source-call-witness.js';
import { issueSqlFamilyAlternatives } from './selector-native-sql-live-materializer.js';
import { compileSqlTrialLegs } from './selector-native-sql-trial.js';
import { readSelectorSourceIdentity, issueDirectSelectorSourceIdentity, createSelectorIdentityRequestReader } from './selector-source-identity.js';
import { selectSingleExecution } from './selector-program-role.js';
import { hashCanonical } from './canonical-value.js';
import { buildFamilyRouteGraphView } from '../adapter-family-graph-runtime.js';
import { selectorSourceGraphNomination, assertSelectorSourceGraphMatches } from './selector-source-graph.js';

export class SelectorSourceRouteUnavailable extends Error {}

const definitionHashes = new WeakMap<object, string>();
const edgeHashes = new WeakMap<object, string>();
function memoCanonicalHash(cache: WeakMap<object, string>, value: object): string {
  const hit = cache.get(value);
  if (hit !== undefined) return hit;
  const digest = hashCanonical(value as any);
  if (Object.isFrozen(value)) cache.set(value, digest);
  return digest;
}

/** Cache only routes already issued by the normal current-source lifecycle.
 * No SQL row can populate this cache; a different pin drops all old entries. */
export function createSelectorCurrentSourceRouteCache() {
  let pin = '', pending = new Map<string, Promise<Awaited<ReturnType<typeof issueSelectorCurrentSourceRoutes>>>>();
  return (input: Parameters<typeof issueSelectorCurrentSourceRoutes>[0]) => {
    input.signal?.throwIfAborted();
    const at = `${input.source.number}:${input.source.hash.toLowerCase()}:${input.source.generation}`;
    if (at !== pin) { pin = at; pending = new Map(); }
    const owned = pending;
    const key = `${memoCanonicalHash(definitionHashes, input.definition)}:${memoCanonicalHash(edgeHashes, input.edge)}:` +
      `${input.catalog.catalogHash}:${input.executor.toLowerCase()}:${input.transactionOrigin.toLowerCase()}:${input.directExecution ? 'direct' : 'identity'}`;
    let result = owned.get(key);
    if (!result) {
      result = issueSelectorCurrentSourceRoutes(input);
      owned.set(key, result);
      void result.catch(() => { if (owned.get(key) === result) owned.delete(key); });
    }
    return result.then(value => { input.signal?.throwIfAborted(); return value; });
  };
}

/** Current independent identity confirms pool ownership and direction only;
 * execution is uniquely determined by the selector's single execution template. */
export async function issueSelectorCurrentSourceRoutes(input: Parameters<typeof issueSqlFamilyAlternatives>[0] & {
  readonly readIdentityRequests?: ReturnType<typeof createSelectorIdentityRequestReader>;
  readonly directExecution?: boolean;
}) {
  const single = selectSingleExecution(input.definition);
  const hasIdentity = input.definition.programs.some(p => p.type === 'independentIdentity');
  let result: Awaited<ReturnType<typeof issueSqlFamilyAlternatives>>;
  const issues: string[] = [];
  if (input.directExecution) {
    const identity = issueDirectSelectorSourceIdentity({
      definition: input.definition,
      edge: input.edge,
      source: input.source,
    });
    issues.push(...identity.issues);
    if (identity.matches.length !== 1) {
      return {
        alternatives: [] as Awaited<ReturnType<typeof issueSqlFamilyAlternatives>>['alternatives'],
        issues: issues.length ? issues : ['edge did not match direct execution binding'],
      };
    }
    result = await issueSqlFamilyAlternatives({
      ...input,
      sourceIdentity: identity.matches[0],
      sourceWitness: undefined,
      matchPriceTrial: false,
    });
    issues.push(...result.issues);
  } else if (!hasIdentity) {
    result = await issueSqlFamilyAlternatives({
      ...input,
      directSourceEdge: true,
      sourceIdentity: undefined,
      sourceWitness: undefined,
      matchPriceTrial: false,
    });
    issues.push(...result.issues);
  } else {
    const identity = await readSelectorSourceIdentity({
      definition: input.definition,
      edge: input.edge,
      source: input.source,
      signal: input.signal,
      readRequests: input.readIdentityRequests ?? createSelectorIdentityRequestReader(input),
    });
    issues.push(...identity.issues);
    if (identity.matches.length !== 1) {
      return {
        alternatives: [] as Awaited<ReturnType<typeof issueSqlFamilyAlternatives>>['alternatives'],
        issues: issues.length ? issues : ['edge did not match selector identity'],
      };
    }
    result = await issueSqlFamilyAlternatives({
      ...input,
      sourceIdentity: identity.matches[0],
      sourceWitness: undefined,
      matchPriceTrial: false,
    });
    issues.push(...result.issues);
  }
  const alternatives: Awaited<ReturnType<typeof issueSqlFamilyAlternatives>>['alternatives'] = [];
  for (const route of result.alternatives) {
    if (route.programKey !== single.programKey || alternatives.length) {
      throw Error('source issuer returned more than its single execution template');
    }
    const family = input.catalog.forFamily(route.instance.familyId);
    const graph = buildFamilyRouteGraphView({
      routes: route.instance.routes.map((r, i) => ({
        family, descriptor: route.instance.descriptor, route: r, handle: route.instance.routeHandles[i]!,
      })),
    }).edges;
    if (graph.length !== 1) throw new SelectorSourceRouteUnavailable('source execution did not produce one direction');
    if (input.definition.directState) {
      try { assertSelectorSourceGraphMatches(selectorSourceGraphNomination(input.definition, input.edge), graph[0]!); }
      catch (error) { throw new SelectorSourceRouteUnavailable(String(error)); }
    }
    alternatives.push(route);
  }
  return { alternatives, issues };
}

/** Source-declared execution authenticated by an independent mined action. */
export async function issueSelectorSourceRoutes(input: Parameters<typeof issueSqlFamilyAlternatives>[0] & {
  readonly sourceWitness: VerifiedSelectorSourceCall;
}) {
  if (!input.definition.directState) throw Error('source execution is not declared');
  selectSingleExecution(input.definition);
  assertVerifiedSelectorSourceCall(input.sourceWitness, {
    edge: input.edge,
    source: input.source,
    discoveryRuleHash: input.definition.directState.discoveryRuleHash,
  });
  const locator = input.edge.executionParamEvidence;
  if (locator?.consensus !== 'uniform' || locator.txHash !== input.sourceWitness.txHash || locator.callPath !== input.sourceWitness.callPath) {
    throw Error('source execution locator differs from independently verified action');
  }
  const trial = compileSqlTrialLegs(input);
  if (trial.legs.length !== 1) {
    throw new SelectorSourceRouteUnavailable('source execution has no encodable price variant: ' + trial.issues.join('; '));
  }
  const expected = trial.legs[0]!;
  const result = await issueSqlFamilyAlternatives({
    ...input,
    matchPriceTrial: true,
    read: async () => { throw Error('source execution must not read legacy binding getters'); },
  });
  for (const issued of result.alternatives) {
    if (issued.programKey !== expected.programKey || issued.program !== expected.leg.program) {
      throw Error('source-issued execution differs from the startup-price program');
    }
  }
  return result;
}
