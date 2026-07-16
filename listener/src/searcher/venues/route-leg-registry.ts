import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../planner/token-graph.js";
import type { ExecutionFamilyId, RouteLegAdapter } from "./route-leg-adapter.js";

export class RouteLegRegistry {
  private readonly byFamily = new Map<ExecutionFamilyId, RouteLegAdapter>();
  private readonly byPoolAdapter = new Map<PoolEntry["adapter"], RouteLegAdapter>();
  private readonly byEdgeAdapter = new Map<string, RouteLegAdapter>();

  constructor(adapters: readonly RouteLegAdapter[]) {
    for (const adapter of adapters) this.register(adapter);
  }

  list(): readonly RouteLegAdapter[] {
    return [...this.byFamily.values()];
  }

  forFamily(id: ExecutionFamilyId): RouteLegAdapter {
    const adapter = this.byFamily.get(id);
    if (!adapter) throw new Error(`route-leg registry: unsupported execution family ${id}`);
    return adapter;
  }

  forPool(poolAdapter: PoolEntry["adapter"]): RouteLegAdapter {
    const adapter = this.findForPool(poolAdapter);
    if (!adapter) throw new Error(`route-leg registry: unsupported pool adapter ${poolAdapter}`);
    return adapter;
  }

  forEdge(edgeAdapterId: string): RouteLegAdapter {
    const adapter = this.findForEdge(edgeAdapterId);
    if (!adapter) throw new Error(`route-leg registry: unsupported edge adapter ${edgeAdapterId}`);
    return adapter;
  }

  findForPool(poolAdapter: PoolEntry["adapter"]): RouteLegAdapter | null {
    return this.byPoolAdapter.get(poolAdapter) ?? null;
  }

  findForEdge(edgeAdapterId: string): RouteLegAdapter | null {
    return this.byEdgeAdapter.get(edgeAdapterId) ?? null;
  }

  async buildEdges(pool: PoolEntry, backend: TokenQueryBackend): Promise<TokenEdge[]> {
    const adapter = this.forPool(pool.adapter);
    const edges = await adapter.buildEdges(pool, backend);
    for (const edge of edges) this.assertEdge(adapter, edge);
    return edges;
  }

  private register(adapter: RouteLegAdapter): void {
    if (this.byFamily.has(adapter.id)) {
      throw new Error(`route-leg registry: duplicate execution family ${adapter.id}`);
    }
    this.byFamily.set(adapter.id, adapter);
    for (const poolAdapter of adapter.poolAdapters) {
      if (this.byPoolAdapter.has(poolAdapter)) {
        throw new Error(`route-leg registry: duplicate pool adapter ${poolAdapter}`);
      }
      this.byPoolAdapter.set(poolAdapter, adapter);
    }
    for (const edgeAdapterId of adapter.edgeAdapterIds) {
      if (this.byEdgeAdapter.has(edgeAdapterId)) {
        throw new Error(`route-leg registry: duplicate edge adapter ${edgeAdapterId}`);
      }
      this.byEdgeAdapter.set(edgeAdapterId, adapter);
    }
  }

  private assertEdge(adapter: RouteLegAdapter, edge: TokenEdge): void {
    if (!adapter.edgeAdapterIds.includes(edge.adapterId)) {
      throw new Error(
        `route-leg registry: ${adapter.id} emitted undeclared edge adapter ${edge.adapterId}`,
      );
    }
    const allowed = adapter.allowedTaxonomy.some((item) =>
      item.slotKind === edge.slotKind && item.protocolAction === edge.protocolAction
    );
    if (!allowed) {
      throw new Error(
        `route-leg registry: ${adapter.id} emitted disallowed taxonomy ` +
          `${edge.slotKind}/${edge.protocolAction ?? "none"}`,
      );
    }
    const derived = deriveEdgeTaxonomy(edge.slotKind, edge.protocolAction);
    if (
      edge.edgeKind !== derived.edgeKind ||
      edge.leavesStandingPosition !== derived.leavesStandingPosition
    ) {
      throw new Error(`route-leg registry: ${adapter.id} emitted inconsistent edge taxonomy`);
    }
  }
}
