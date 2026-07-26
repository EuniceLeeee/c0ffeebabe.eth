import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../planner/token-graph.js";
import {
  isStateCallAbortedError,
  StateCallAbortedError,
} from "../../shared/state/state-backend.js";
import type {
  ExecutionFamilyId,
  RouteEdgeBuildControl,
  RouteLegAdapter,
} from "./route-leg-adapter.js";
import { bindRouteInstanceIdentity } from "./route-instance-identity.js";

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

  async buildEdges(
    pool: PoolEntry,
    backend: TokenQueryBackend,
    control: RouteEdgeBuildControl = {},
  ): Promise<TokenEdge[]> {
    const adapter = this.forPool(pool.adapter);
    assertBuildActive(adapter.id, control);
    const controlledBackend = withBuildControl(backend, control);
    const built = await raceBuildControl(
      adapter.buildEdges(pool, controlledBackend, control),
      adapter.id,
      control,
    );
    // This check is the late-result fence: even if a transport ignored abort,
    // its eventual result can never enter graph publication.
    assertBuildActive(adapter.id, control);
    const edges = bindRouteInstanceIdentity(
      adapter,
      pool,
      built,
    );
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

function withBuildControl(
  backend: TokenQueryBackend,
  control: RouteEdgeBuildControl,
): TokenQueryBackend {
  return {
    call(req, nested) {
      const deadlineAtMs = earliestDeadline(
        control.deadlineAtMs,
        nested?.deadlineAtMs,
      );
      const merged = mergeAbortSignals(control.signal, nested?.signal);
      try {
        assertBuildActive("backend", { deadlineAtMs, signal: merged.signal });
        return raceBuildControl(
          backend.call(req, { deadlineAtMs, signal: merged.signal }),
          "backend",
          { deadlineAtMs, signal: merged.signal },
        ).finally(merged.detach);
      } catch (error) {
        merged.detach();
        throw normalizeControlledReadError(error, "backend");
      }
    },
    ...(backend.getLogs === undefined
      ? {}
      : {
          getLogs(req, nested) {
            const deadlineAtMs = earliestDeadline(
              control.deadlineAtMs,
              nested?.deadlineAtMs,
            );
            const merged = mergeAbortSignals(control.signal, nested?.signal);
            try {
              assertBuildActive("backend", {
                deadlineAtMs,
                signal: merged.signal,
              });
              return raceBuildControl(
                backend.getLogs!(req, {
                  deadlineAtMs,
                  signal: merged.signal,
                }),
                "backend",
                { deadlineAtMs, signal: merged.signal },
              ).finally(merged.detach);
            } catch (error) {
              merged.detach();
              throw normalizeControlledReadError(error, "backend");
            }
          },
        }),
  };
}

function mergeAbortSignals(
  parent: AbortSignal | undefined,
  nested: AbortSignal | undefined,
): {
  readonly signal: AbortSignal | undefined;
  readonly detach: () => void;
} {
  if (!parent || parent === nested) {
    return Object.freeze({ signal: nested ?? parent, detach: () => {} });
  }
  if (!nested) {
    return Object.freeze({ signal: parent, detach: () => {} });
  }
  const controller = new AbortController();
  const abortFromParent = () => {
    if (!controller.signal.aborted) controller.abort(parent.reason);
  };
  const abortFromNested = () => {
    if (!controller.signal.aborted) controller.abort(nested.reason);
  };
  if (parent.aborted) abortFromParent();
  else if (nested.aborted) abortFromNested();
  else {
    parent.addEventListener("abort", abortFromParent, { once: true });
    nested.addEventListener("abort", abortFromNested, { once: true });
  }
  return Object.freeze({
    signal: controller.signal,
    detach() {
      parent.removeEventListener("abort", abortFromParent);
      nested.removeEventListener("abort", abortFromNested);
    },
  });
}

function raceBuildControl<T>(
  promise: Promise<T>,
  familyId: string,
  control: RouteEdgeBuildControl,
): Promise<T> {
  if (control.deadlineAtMs === undefined && control.signal === undefined) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      control.signal?.removeEventListener("abort", abort);
      fn();
    };
    const abort = () =>
      finish(() =>
        reject(
          buildControlError(
            familyId,
            abortKind(control.signal?.reason),
            control.signal?.reason,
          ),
        )
      );
    const timer = control.deadlineAtMs === undefined
      ? undefined
      : setTimeout(
          () =>
            finish(() =>
              reject(buildControlError(familyId, "deadline"))
            ),
          Math.max(0, control.deadlineAtMs - Date.now()),
        );
    control.signal?.addEventListener("abort", abort, { once: true });
    // Always attach the source handlers before observing an already-aborted
    // signal. An adapter may synchronously abort while constructing `promise`;
    // returning before `.then` would leave its eventual rejection unhandled.
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) =>
        finish(() => reject(normalizeControlledReadError(error, familyId))),
    );
    if (control.signal?.aborted) {
      abort();
      return;
    }
  });
}

function assertBuildActive(
  familyId: string,
  control: RouteEdgeBuildControl,
): void {
  if (control.signal?.aborted) {
    throw buildControlError(
      familyId,
      abortKind(control.signal.reason),
      control.signal.reason,
    );
  }
  if (
    control.deadlineAtMs !== undefined &&
    Date.now() >= control.deadlineAtMs
  ) {
    throw buildControlError(familyId, "deadline");
  }
}

function normalizeControlledReadError(
  error: unknown,
  familyId: string,
): unknown {
  if (isStateCallAbortedError(error)) return error;
  if (!error || typeof error !== "object" || !("code" in error)) return error;
  const code = String((error as { readonly code?: unknown }).code);
  if (code === "ABORTED") {
    return buildControlError(familyId, "signal", error);
  }
  if (code === "DEADLINE_EXCEEDED") {
    return buildControlError(familyId, "deadline", error);
  }
  return error;
}

function abortKind(reason: unknown): StateCallAbortedError["kind"] {
  if (isStateCallAbortedError(reason)) return reason.kind;
  if (
    reason &&
    typeof reason === "object" &&
    "code" in reason &&
    String((reason as { readonly code?: unknown }).code) ===
      "DEADLINE_EXCEEDED"
  ) {
    return "deadline";
  }
  const message = reason instanceof Error ? reason.message : String(reason ?? "");
  return /deadline|exceeded \d+ms/i.test(message) ? "deadline" : "signal";
}

function buildControlError(
  familyId: string,
  kind: StateCallAbortedError["kind"],
  cause?: unknown,
): StateCallAbortedError {
  const action = kind === "deadline" ? "deadline exceeded" : "aborted";
  return new StateCallAbortedError(
    `route family ${familyId} ${action}`,
    kind,
    cause === undefined ? undefined : { cause },
  );
}

function earliestDeadline(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}
