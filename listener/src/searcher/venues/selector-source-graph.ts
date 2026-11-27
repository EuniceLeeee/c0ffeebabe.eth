import { ZeroAddress, getAddress } from 'ethers';
import { ADDR } from '../../shared/constants/addresses.js';
import { selectSingleExecution } from './selector-program-role.js';
import { selectorExecutionResourceKey } from './selector-execution-keys.js';
import type { SelectorNativeExecutionDefinition } from './selector-native-definition.js';
import type { SqlLiveEdgeCoordinates } from './selector-native-sql-live-binding.js';
import type { TokenEdge } from '../planner/token-graph.js';

/** Candidate topology only. This never reads a pool, creates a handle, or
 * treats SQL token coordinates as independent identity proof. */
export function selectorSourceGraphNomination(definition: SelectorNativeExecutionDefinition, edge: SqlLiveEdgeCoordinates) {
  const { program } = selectSingleExecution(definition);
  const state = definition.directState;
  if (!state || edge.chainId !== 1 || edge.selector !== definition.selector ||
      edge.tokenInId != null || edge.tokenOutId != null ||
      (state.poolId ? (!edge.poolId || (edge.poolNamespace != null && edge.poolNamespace !== state.poolNamespace)) : (edge.poolId != null || edge.poolNamespace != null))) {
    throw Error('source graph physical pool scope differs');
  }
  const directions = program.routes?.directions;
  if (!Array.isArray(directions) || !directions.length) throw Error('source graph lacks declared route taxonomy');
  const taxonomies = directions.map(d => d.taxonomy);
  const taxonomy = taxonomies[0];
  if (!taxonomy || taxonomies.some(t => JSON.stringify(t) !== JSON.stringify(taxonomy))) {
    throw Error('source graph taxonomy cannot be projected without identity');
  }
  const weth = ADDR.WETH.toLowerCase();
  const asset = (value: string) => {
    const normalized = getAddress(value).toLowerCase();
    if (normalized === ZeroAddress) {
      if (!definition.managerCustody) throw Error('zero token address requires manager-custody native support');
      return weth;
    }
    return normalized;
  };
  const graph = {
    tokenIn: asset(edge.tokenIn),
    tokenOut: asset(edge.tokenOut),
    slotKind: taxonomy.slotKind,
    ...(taxonomy.protocolAction ? { protocolAction: taxonomy.protocolAction } : {}),
    stateResourceKey: selectorExecutionResourceKey({
      chainId: edge.chainId,
      target: edge.poolAddress,
      ...(state.poolId ? { poolId: edge.poolId!, poolNamespace: state.poolNamespace } : {}),
    }),
  };
  if (graph.tokenIn === graph.tokenOut) throw Error('source graph asset boundary collapses the direction');
  return graph;
}

export function assertSelectorSourceGraphMatches(expected: ReturnType<typeof selectorSourceGraphNomination>, actual: TokenEdge): void {
  for (const key of ['tokenIn', 'tokenOut', 'slotKind', 'protocolAction', 'stateResourceKey'] as const) {
    if (expected[key] !== (['tokenIn', 'tokenOut'].includes(key) ? actual[key]?.toLowerCase() : actual[key])) {
      throw Error('issued route differs from source graph nomination: ' + key);
    }
  }
}
