import type { TokenQueryBackend } from "../planner/token-graph.js";
import type {
  ProtocolCandidate,
  ProtocolConversionAdapter,
  ProtocolRoute,
  RouteProbeResult,
} from "./route-leg-adapter.js";

/**
 * Shadow-mode discovery coordinator (discovery plan §3 Slice B).
 *
 * Pipeline: discoverInstances → attestIdentity → enumerateRoutes → probeRoute.
 * Shadow by construction: this module has no access to the graph, the pool
 * registry, or the runtime refresh sink — it can only return a report and emit
 * `protocol_discovery` log lines. Admission changes are Slice C (Hermes A/B).
 *
 * Enforced here, not left to adapters:
 * - attestIdentity null/throw → quarantine; the candidate never reaches
 *   enumerate/probe.
 * - any probe call revert → that route is not produced (fail-closed).
 * - requiresProtocolEdgesFlag is re-executed on the coordinator side (P0-3):
 *   flag off → would_admit=false even for a fully verified route.
 * - would_admit additionally requires receipt-level verification; preview-only
 *   probes report `receipt_verification_pending`.
 */
export interface ProtocolDiscoveryShadowInput {
  readonly adapters: readonly ProtocolConversionAdapter[];
  readonly backend: TokenQueryBackend;
  readonly universeTokens: readonly string[];
  readonly enableProtocolEdges: boolean;
  readonly parkedCandidates?: readonly string[];
  readonly log?: (line: string) => void;
}

export interface ShadowRouteVerdict {
  readonly route: ProtocolRoute;
  readonly probe: RouteProbeResult;
  readonly wouldAdmit: boolean;
  readonly wouldAdmitReason: string;
}

export interface ShadowAdapterReport {
  readonly adapterId: string;
  readonly candidates: number;
  readonly attested: number;
  readonly quarantined: number;
  readonly routes: readonly ShadowRouteVerdict[];
  readonly parkedWouldDequeue: readonly string[];
}

export interface ProtocolDiscoveryShadowReport {
  readonly adapters: readonly ShadowAdapterReport[];
}

export async function runProtocolDiscoveryShadow(
  input: ProtocolDiscoveryShadowInput,
): Promise<ProtocolDiscoveryShadowReport> {
  const log = input.log ?? ((line: string) => console.log(line));
  const emit = (event: string, fields: Record<string, unknown>): void => {
    log(`protocol_discovery ${JSON.stringify({ event, ...fields })}`);
  };
  const reports: ShadowAdapterReport[] = [];

  for (const adapter of input.adapters) {
    const discovery = adapter.discovery;
    if (!discovery) continue;

    const probeCtx = { backend: input.backend };
    let candidates: ProtocolCandidate[] = [];
    try {
      candidates = await discovery.discoverInstances({
        backend: input.backend,
        universeTokens: input.universeTokens,
      });
    } catch (err) {
      emit("discover_failed", { adapter: adapter.id, reason: String(err) });
      reports.push({
        adapterId: adapter.id,
        candidates: 0,
        attested: 0,
        quarantined: 0,
        routes: [],
        parkedWouldDequeue: [],
      });
      continue;
    }
    const seen = new Set<string>();
    const deduped = candidates.filter((candidate) => {
      const key = candidate.target.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    let attested = 0;
    let quarantined = 0;
    const verdicts: ShadowRouteVerdict[] = [];
    for (const candidate of deduped) {
      let instance = null;
      try {
        instance = await discovery.attestIdentity(candidate, probeCtx);
      } catch {
        instance = null;
      }
      if (instance === null) {
        quarantined++;
        continue;
      }
      attested++;

      let routes: ProtocolRoute[] = [];
      try {
        routes = await discovery.enumerateRoutes(instance, probeCtx);
      } catch (err) {
        emit("enumerate_failed", { adapter: adapter.id, target: instance.target, reason: String(err) });
        continue;
      }
      for (const route of routes) {
        let probe: RouteProbeResult;
        try {
          probe = await discovery.probeRoute(route, probeCtx);
        } catch (err) {
          probe = { ok: false, reason: `probe_reverted: ${String(err)}`, receiptVerified: false };
        }
        const flagGate = !adapter.requiresProtocolEdgesFlag || input.enableProtocolEdges;
        const wouldAdmit = probe.ok && probe.receiptVerified && flagGate;
        const wouldAdmitReason = wouldAdmit
          ? "admissible"
          : !probe.ok
            ? `probe_failed: ${probe.reason ?? "unknown"}`
            : !probe.receiptVerified
              ? "receipt_verification_pending"
              : "protocol_edges_flag_off";
        verdicts.push({ route, probe, wouldAdmit, wouldAdmitReason });
        emit("route_verdict", {
          adapter: adapter.id,
          target: route.target,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          edgeAdapterId: route.edgeAdapterId,
          probe_ok: probe.ok,
          would_admit: wouldAdmit,
          reason: wouldAdmitReason,
        });
      }
    }

    const parkedWouldDequeue: string[] = [];
    for (const parked of input.parkedCandidates ?? []) {
      try {
        const instance = await discovery.attestIdentity(
          { target: parked, source: "parked" },
          probeCtx,
        );
        if (instance !== null) {
          parkedWouldDequeue.push(parked);
          emit("parked_would_dequeue", { adapter: adapter.id, target: parked });
        }
      } catch {
        // Parked candidates that fail attest stay parked; no event.
      }
    }

    emit("adapter_summary", {
      adapter: adapter.id,
      candidates: deduped.length,
      attested,
      quarantined,
      routes: verdicts.length,
      would_admit: verdicts.filter((verdict) => verdict.wouldAdmit).length,
      parked_would_dequeue: parkedWouldDequeue.length,
    });
    reports.push({
      adapterId: adapter.id,
      candidates: deduped.length,
      attested,
      quarantined,
      routes: verdicts,
      parkedWouldDequeue,
    });
  }

  return { adapters: reports };
}
