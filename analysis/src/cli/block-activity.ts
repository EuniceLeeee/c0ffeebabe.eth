// block-activity — "what did OUR live searcher do at block N?" Reads the live structured events JSONL
// and summarizes our funnel at a target_block: seen / dropped (stage × reason) / submitted, plus an
// optional cross-reference of a competitor's venue ids against our whole run (did we ever touch them).
//
// Zero-CU on the events (pure JSONL read). The events live on the NODE — this defaults to the node
// path so it runs there directly; point --events at a fetched slice to run locally.
//
// Usage: npm run block-activity -- --block <N> [--events <path>] [--blockscan-log <path>]
//   [--route-events <path>] [--mid-history <path>] [--mid-out <path>]
//   [--venues <id,id,...>]
//   default --events /var/log/mev/events/searcher-live.jsonl (the live node path; the OLD
//   analysis/events + /tmp/mev-live-*.log defaults are stale — the node moved to /var/log/mev).
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  blockScanActivityAtBlock,
  blockScanSourceBlockForTarget,
} from "./bundle-postmortem.js";

const DEFAULT_EVENTS = "/var/log/mev/events/searcher-live.jsonl";
const DEFAULT_BLOCKSCAN_LOG = "/var/log/mev-live.log";

type JsonRecord = Record<string, unknown>;
type CompactMid = Record<string, string | number>;

interface MidAnchor {
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  readonly generation: number;
  readonly graphFingerprint: string;
}

interface ReconstructedMidTable extends MidAnchor {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly baselineSourceBlock: number;
  readonly appliedDeltas: number;
  readonly mids: readonly (readonly [string, CompactMid])[];
}

interface RouteCatalogEntry {
  runId: string;
  catalogEpoch: number;
  routeRef: number;
  routeId: string;
  edgeIds: string[] | null;
  tokenRing: string[];
  venuePath: Array<[string, string]>;
  flashToken: string;
}

interface RouteLifecycle {
  schemaVersion: 1 | 2;
  runId: string;
  catalogEpoch: number;
  sourceBlock: number;
  sourceBlockHash: string | null;
  midSourceBlock: number | null;
  midSourceBlockHash: string | null;
  pricingMode: string | null;
  passOutcome: string;
  passReason: string | null;
  enumeration: number[];
  exact: RouteExactDiagnostic[] | null;
  planner: number[] | null;
  solver: number[];
  droppedBatches: number;
  firstDroppedBlock: number | null;
  lastDroppedBlock: number | null;
}

interface RouteExactDiagnostic {
  routeRef: number;
  status: "positive" | "negative" | "failed" | "unprobed";
  attempted: boolean;
  marginBps: number | null;
  reason:
    | "exact_not_admitted"
    | "family_circuit_open"
    | "instance_circuit_open"
    | "composite_circuit_open"
    | "probe_timeout"
    | "global_deadline"
    | "quote_error"
    | null;
}

interface ScopedFinalEvents {
  withRouteId: JsonRecord[];
  missingRouteId: number;
}

interface ParsedRouteEvents {
  catalogs: Map<string, RouteCatalogEntry>;
  lifecycles: RouteLifecycle[];
  malformedLines: number;
  invalidRecords: number;
  conflictingCatalogs: number;
  trailingFragment: boolean;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const blockStr = arg("--block");
  if (!blockStr) {
    console.error(
      "usage: npm run block-activity -- --block <N> [--events <path>] " +
        "[--route-events <path>] [--mid-history <path>] [--mid-out <path>] " +
        "[--blockscan-log <path>] [--venues <id,...>]",
    );
    process.exit(1);
  }
  const block = Number(blockStr);
  const eventsPath = arg("--events") ?? DEFAULT_EVENTS;
  const blockScanLogPath = arg("--blockscan-log") ?? DEFAULT_BLOCKSCAN_LOG;
  const routeEventsPath = arg("--route-events");
  const midHistoryPath = arg("--mid-history");
  const midOutPath = arg("--mid-out");
  if (
    (midHistoryPath !== undefined && routeEventsPath === undefined) ||
    (midOutPath !== undefined && midHistoryPath === undefined)
  ) {
    console.error("--mid-history requires --route-events; --mid-out requires --mid-history");
    process.exit(1);
  }
  const venues = (arg("--venues") ?? "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  if (!existsSync(eventsPath)) {
    console.error(`events file not found: ${eventsPath} (on the node it is ${DEFAULT_EVENTS}; fetch a slice or run on the node)`);
    process.exit(1);
  }

  const dropCounts = new Map<string, number>(); // "stage|reason" -> n
  const submittedAt: string[] = [];
  const venueHits = new Map<string, number>();
  let seen = 0, dropped = 0, submitted = 0;
  let totalLines = 0;
  let malformedEventLines = 0;
  const formalEvents: JsonRecord[] = [];

  for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
    if (!line) continue;
    totalLines++;
    let o: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) {
        malformedEventLines++;
        continue;
      }
      o = parsed;
    } catch {
      malformedEventLines++;
      continue;
    }
    if (routeEventsPath !== undefined) formalEvents.push(o);
    // whole-run venue cross-ref (not block-scoped): did we ever emit these ids?
    if (venues.length > 0) {
      const lower = line.toLowerCase();
      for (const v of venues) if (lower.includes(v)) venueHits.set(v, (venueHits.get(v) ?? 0) + 1);
    }
    if (o.target_block !== block) continue;
    const type = String(o.type ?? "");
    if (type === "opportunity_seen") seen++;
    else if (type === "pipeline_dropped") {
      dropped++;
      const key = `${o.stage ?? "?"}|${o.reason ?? "?"}`;
      dropCounts.set(key, (dropCounts.get(key) ?? 0) + 1);
    } else if (type === "bundle_submitted") { submitted++; submittedAt.push(String(o.opportunity_id ?? "").slice(0, 14)); }
  }

  console.log(`[block-activity] block ${block} — events=${eventsPath} (${totalLines} lines)`);
  console.log(`  opportunity_seen: ${seen}`);
  console.log(`  pipeline_dropped: ${dropped}`);
  for (const [k, n] of [...dropCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const [stage, reason] = k.split("|");
    console.log(`      stage=${stage} reason=${reason}: ${n}`);
  }
  console.log(`  bundle_submitted: ${submitted}${submittedAt.length ? " " + submittedAt.join(",") : ""}`);
  if (venues.length > 0) {
    console.log(`  competitor venue cross-ref (whole run):`);
    for (const v of venues) console.log(`      ${v}: ${venueHits.get(v) ?? 0} mentions${(venueHits.get(v) ?? 0) === 0 ? "  <- NEVER seen" : ""}`);
  }

  const sourceBlock = blockScanSourceBlockForTarget(block);
  if (routeEventsPath !== undefined) {
    await printStructuredRouteActivity({
      targetBlock: block,
      sourceBlock,
      routeEventsPath,
      midHistoryPath,
      midOutPath,
      formalEvents,
      malformedEventLines,
    });
    return;
  }

  let blockScanLog: string;
  try {
    blockScanLog = readFileSync(blockScanLogPath, "utf8");
  } catch {
    console.log(`  blockscan: target_block=${block} source_block=${sourceBlock} status=unknown_log_unavailable log=${blockScanLogPath}`);
    console.log("      solve_rings: unknown");
    console.log("      solve_ring_tokens: unknown");
    return;
  }

  const activity = blockScanActivityAtBlock(blockScanLog, sourceBlock);
  const tokens = [...activity.scannedTokens].sort();
  console.log(`  blockscan: target_block=${block} source_block=${sourceBlock} status=${activity.status} log=${blockScanLogPath}`);
  console.log(`      solve_rings: ${activity.ringCount}`);
  for (const ring of activity.rings) {
    console.log(`          ring=${ring.ring} net=${ring.net ?? "null"}${ring.error ? ` error=${ring.error}` : ""}`);
  }
  console.log(`      solve_ring_tokens: ${tokens.length}${tokens.length > 0 ? ` ${tokens.join(",")}` : ""}`);
}

async function printStructuredRouteActivity(input: {
  targetBlock: number;
  sourceBlock: number;
  routeEventsPath: string;
  midHistoryPath?: string;
  midOutPath?: string;
  formalEvents: JsonRecord[];
  malformedEventLines: number;
}): Promise<void> {
  const { targetBlock, sourceBlock, routeEventsPath } = input;
  let routeEventsText: string;
  try {
    routeEventsText = readFileSync(routeEventsPath, "utf8");
  } catch {
    console.log(
      `  blockscan-routes: target_block=${targetBlock} source_block=${sourceBlock} ` +
        `status=unknown_route_events_unavailable route_events=${routeEventsPath}`,
    );
    return;
  }

  const parsed = parseRouteEvents(routeEventsText);
  if (
    parsed.malformedLines > 0 ||
    parsed.invalidRecords > 0 ||
    parsed.conflictingCatalogs > 0
  ) {
    console.log(
      `  blockscan-routes: target_block=${targetBlock} source_block=${sourceBlock} ` +
        `status=unknown_invalid_route_events route_events=${routeEventsPath}`,
    );
    console.log(
      `      malformed_lines=${parsed.malformedLines} ` +
        `invalid_records=${parsed.invalidRecords} ` +
        `conflicting_catalogs=${parsed.conflictingCatalogs}`,
    );
    return;
  }

  const matching = parsed.lifecycles.filter(
    (lifecycle) => lifecycle.sourceBlock === sourceBlock,
  );
  if (matching.length === 0) {
    const coveringGap = parsed.lifecycles.find(
      (lifecycle) =>
        lifecycle.droppedBatches > 0 &&
        lifecycle.firstDroppedBlock !== null &&
        lifecycle.lastDroppedBlock !== null &&
        sourceBlock >= lifecycle.firstDroppedBlock &&
        sourceBlock <= lifecycle.lastDroppedBlock,
    );
    const status = coveringGap
      ? "unknown_writer_gap"
      : parsed.trailingFragment
        ? "unknown_writer_tail_in_progress"
        : "unknown_missing_block_record";
    console.log(
      `  blockscan-routes: target_block=${targetBlock} source_block=${sourceBlock} ` +
        `status=${status} route_events=${routeEventsPath}`,
    );
    if (coveringGap) printWriterGap(coveringGap);
    return;
  }
  if (matching.length !== 1) {
    console.log(
      `  blockscan-routes: target_block=${targetBlock} source_block=${sourceBlock} ` +
        `status=unknown_duplicate_block_records count=${matching.length} ` +
        `route_events=${routeEventsPath}`,
    );
    return;
  }

  const lifecycle = matching[0]!;
  const plannerRefs = lifecycle.planner ?? [];
  const refs = [
    ...lifecycle.enumeration,
    ...plannerRefs,
    ...lifecycle.solver,
  ];
  const unresolvedRefs = [...new Set(refs)].filter(
    (routeRef) =>
      !parsed.catalogs.has(
        catalogKey(lifecycle.runId, lifecycle.catalogEpoch, routeRef),
      ),
  );
  const enumerationSet = new Set(lifecycle.enumeration);
  const duplicateEnumeration =
    enumerationSet.size !== lifecycle.enumeration.length;
  const plannerSet = new Set(plannerRefs);
  const duplicatePlanner = plannerSet.size !== plannerRefs.length;
  const plannerOutsideEnumeration = plannerRefs.filter(
    (routeRef) => !enumerationSet.has(routeRef),
  );
  const solverOutsideParent = lifecycle.solver.filter(
    (routeRef) =>
      !(lifecycle.schemaVersion === 2 ? plannerSet : enumerationSet).has(
        routeRef,
      ),
  );
  const exactByRouteRef = new Map(
    (lifecycle.exact ?? []).map((diagnostic) => [
      diagnostic.routeRef,
      diagnostic,
    ]),
  );
  const plannerWithoutPositiveExact = lifecycle.schemaVersion === 2
    ? plannerRefs.filter(
        (routeRef) => exactByRouteRef.get(routeRef)?.status !== "positive",
      )
    : [];
  const lifecycleInvariant =
    duplicateEnumeration ||
    duplicatePlanner ||
    plannerOutsideEnumeration.length > 0 ||
    solverOutsideParent.length > 0 ||
    plannerWithoutPositiveExact.length > 0;
  const evidenceStatus =
    unresolvedRefs.length > 0
      ? "unknown_catalog_reference"
      : lifecycleInvariant
        ? "unknown_lifecycle_invariant"
        : lifecycle.passOutcome === "not_started"
          ? "not_started"
          : lifecycle.droppedBatches > 0
            ? "complete_with_writer_gap"
            : "complete";
  console.log(
    `  blockscan-routes: target_block=${targetBlock} source_block=${sourceBlock} ` +
      `status=${evidenceStatus} route_events=${routeEventsPath}`,
  );
  if (parsed.trailingFragment) {
    console.log("      writer_tail: status=in_progress");
  }
  console.log(
    `      run_id=${bounded(lifecycle.runId)} ` +
      `schema_version=${lifecycle.schemaVersion} ` +
      `catalog_epoch=${lifecycle.catalogEpoch} ` +
      `source_block_hash=${lifecycle.sourceBlockHash ?? "null"} ` +
      `mid_source_block=${formatMidSource(lifecycle)} ` +
      `mid_source_block_hash=${formatMidSourceHash(lifecycle)} ` +
      `pricing_mode=${lifecycle.pricingMode === null ? "null" : bounded(lifecycle.pricingMode)} ` +
      `pass_outcome=${bounded(lifecycle.passOutcome)} ` +
      `pass_reason=${lifecycle.passReason === null ? "null" : bounded(lifecycle.passReason)}`,
  );
  const midTable = await loadMidTable(input, lifecycle);
  const midLookup = input.midHistoryPath === undefined
    ? undefined
    : midTable === null
      ? null
      : new Map(midTable.mids);
  if (lifecycle.droppedBatches > 0) printWriterGap(lifecycle);
  if (unresolvedRefs.length > 0) {
    console.log(`      unresolved_route_refs: ${unresolvedRefs.join(",")}`);
  }
  if (duplicateEnumeration) {
    console.log("      invariant: duplicate_enumeration_refs");
  }
  if (duplicatePlanner) {
    console.log("      invariant: duplicate_planner_refs");
  }
  if (plannerOutsideEnumeration.length > 0) {
    console.log(
      `      invariant: planner_refs_outside_enumeration=${plannerOutsideEnumeration.join(",")}`,
    );
  }
  if (solverOutsideParent.length > 0) {
    console.log(
      `      invariant: solver_refs_outside_${
        lifecycle.schemaVersion === 2 ? "planner" : "enumeration"
      }=${solverOutsideParent.join(",")}`,
    );
  }
  if (plannerWithoutPositiveExact.length > 0) {
    console.log(
      `      invariant: planner_refs_without_positive_exact=${
        plannerWithoutPositiveExact.join(",")
      }`,
    );
  }

  const scopedFinal = collectScopedFinalEvents(input, lifecycle);
  const finalEventsByRouteId = new Map<string, JsonRecord[]>();
  for (const event of scopedFinal.withRouteId) {
    const routeId = String(event.route_id);
    const events = finalEventsByRouteId.get(routeId) ?? [];
    events.push(event);
    finalEventsByRouteId.set(routeId, events);
  }

  console.log(`      Enumeration: ${lifecycle.enumeration.length}`);
  lifecycle.enumeration.forEach((routeRef, index) => {
    const route = resolveCatalog(parsed, lifecycle, routeRef);
    const exact = lifecycle.exact?.[index] ?? null;
    const plannerCall = lifecycle.planner?.indexOf(routeRef) ?? -1;
    const solverCall = lifecycle.solver.indexOf(routeRef);
    const final = summarizeFinalEvents(
      route === null ? [] : finalEventsByRouteId.get(route.routeId) ?? [],
    );
    console.log(
      `          rank=${index + 1} ref=${routeRef} ` +
        `${formatRoute(route, midLookup)} ${formatExact(lifecycle, exact)} ` +
        `planner_entered=${
          lifecycle.schemaVersion === 1 ? "unknown_schema_v1" : plannerCall >= 0
        } planner_call=${plannerCall >= 0 ? plannerCall + 1 : "null"} ` +
        `solver_entered=${solverCall >= 0} ` +
        `solver_call=${solverCall >= 0 ? solverCall + 1 : "null"} ` +
        `selected_for_solver=${solverCall >= 0} ` +
        `final_sim_status=${final.finalSimStatus} ` +
        `final_sim_profit=${final.finalSimProfit} ` +
        `ev_decision=${final.evDecision} ` +
        `ev_reason=${final.evReason} net_ev_wei=${final.netEvWei}`,
    );
  });

  if (lifecycle.schemaVersion === 1) {
    console.log("      Planner entered: unknown_schema_v1");
  } else {
    console.log(`      Planner entered: ${plannerRefs.length}`);
    plannerRefs.forEach((routeRef, index) => {
      console.log(
        `          call=${index + 1} ref=${routeRef} ` +
          formatRoute(resolveCatalog(parsed, lifecycle, routeRef)),
      );
    });
  }

  console.log(`      Solver entered: ${lifecycle.solver.length}`);
  lifecycle.solver.forEach((routeRef, index) => {
    console.log(
      `          call=${index + 1} ref=${routeRef} ` +
        formatRoute(resolveCatalog(parsed, lifecycle, routeRef)),
    );
  });

  const solverSet = new Set(lifecycle.solver);
  const notEntered = lifecycle.enumeration.filter(
    (routeRef) => !solverSet.has(routeRef),
  );
  console.log(`      Enumerated not solver: ${notEntered.length}`);
  notEntered.forEach((routeRef) => {
    console.log(
      `          ref=${routeRef} ` +
        formatRoute(resolveCatalog(parsed, lifecycle, routeRef)),
    );
  });

  printFinalEventJoins(input, lifecycle, parsed, scopedFinal);
}

async function loadMidTable(
  input: {
    readonly midHistoryPath?: string;
    readonly midOutPath?: string;
  },
  lifecycle: RouteLifecycle,
): Promise<ReconstructedMidTable | null> {
  if (input.midHistoryPath === undefined) return null;
  if (
    lifecycle.schemaVersion !== 2 ||
    lifecycle.midSourceBlock === null ||
    lifecycle.midSourceBlockHash === null
  ) {
    console.log(
      `      Mid table: status=unknown_source_anchor history=${input.midHistoryPath}`,
    );
    return null;
  }
  try {
    const table = await reconstructMidHistory(
      resolve(input.midHistoryPath),
      lifecycle.midSourceBlock,
    );
    if (
      table.runId !== lifecycle.runId ||
      table.sourceBlockHash.toLowerCase() !==
        lifecycle.midSourceBlockHash.toLowerCase()
    ) {
      throw new Error("mid history anchor does not match route lifecycle");
    }
    if (input.midOutPath !== undefined) {
      await writeFile(
        resolve(input.midOutPath),
        `${JSON.stringify(midTableRecord(table))}\n`,
        { mode: 0o600 },
      );
    }
    console.log(
      `      Mid table: status=complete source_block=${table.sourceBlock} ` +
        `source_block_hash=${table.sourceBlockHash} mids=${table.mids.length} ` +
        `baseline=${table.baselineSourceBlock} deltas=${table.appliedDeltas}` +
        (input.midOutPath === undefined
          ? ""
          : ` out=${resolve(input.midOutPath)}`),
    );
    return table;
  } catch (error) {
    console.log(
      `      Mid table: status=unknown_not_reconstructable ` +
        `history=${input.midHistoryPath} reason=${bounded(message(error))}`,
    );
    return null;
  }
}

function midTableRecord(table: ReconstructedMidTable): JsonRecord {
  return {
    schema_version: table.schemaVersion,
    run_id: table.runId,
    source_block: table.sourceBlock,
    source_block_hash: table.sourceBlockHash,
    generation: table.generation,
    graph_fingerprint: table.graphFingerprint,
    baseline_source_block: table.baselineSourceBlock,
    applied_deltas: table.appliedDeltas,
    mid_count: table.mids.length,
    mids: table.mids,
  };
}

function collectScopedFinalEvents(
  input: {
    targetBlock: number;
    sourceBlock: number;
    formalEvents: JsonRecord[];
  },
  lifecycle: RouteLifecycle,
): ScopedFinalEvents {
  const finalTypes = new Set([
    "simulation_result",
    "pipeline_dropped",
    "bundle_submitted",
  ]);
  const scoped = input.formalEvents.filter(
    (event) =>
      finalTypes.has(stringValue(event.type) ?? "") &&
      event.opportunity_kind === "block-scan-arb" &&
      event.target_block === input.targetBlock &&
      event.source_block === input.sourceBlock &&
      event.run_id === lifecycle.runId,
  );
  const withRouteId = scoped.filter(
    (event) => typeof event.route_id === "string" && event.route_id.length > 0,
  );
  return {
    withRouteId,
    missingRouteId: scoped.length - withRouteId.length,
  };
}

function formatMidSource(lifecycle: RouteLifecycle): string {
  return lifecycle.schemaVersion === 1
    ? "unknown_schema_v1"
    : String(lifecycle.midSourceBlock ?? "null");
}

function formatMidSourceHash(lifecycle: RouteLifecycle): string {
  return lifecycle.schemaVersion === 1
    ? "unknown_schema_v1"
    : lifecycle.midSourceBlockHash ?? "null";
}

function formatExact(
  lifecycle: RouteLifecycle,
  diagnostic: RouteExactDiagnostic | null,
): string {
  if (lifecycle.schemaVersion === 1) {
    return (
      "exact_status=unknown_schema_v1 exact_attempted=unknown " +
      "exact_margin_bps=null exact_reason=unknown_schema_v1"
    );
  }
  if (lifecycle.exact === null) {
    return (
      "exact_status=not_reached exact_attempted=false " +
      "exact_margin_bps=null exact_reason=null"
    );
  }
  if (diagnostic === null) {
    return (
      "exact_status=unknown_missing exact_attempted=unknown " +
      "exact_margin_bps=null exact_reason=unknown_missing"
    );
  }
  return (
    `exact_status=${diagnostic.status} ` +
    `exact_attempted=${diagnostic.attempted} ` +
    `exact_margin_bps=${diagnostic.marginBps ?? "null"} ` +
    `exact_reason=${diagnostic.reason ?? "null"}`
  );
}

function summarizeFinalEvents(events: readonly JsonRecord[]): {
  finalSimStatus: string;
  finalSimProfit: string;
  evDecision: string;
  evReason: string;
  netEvWei: string;
} {
  const simulations = events.filter(
    (event) => event.type === "simulation_result",
  );
  const simOutcomes = simulations.map((event) => event.ok);
  const finalSimStatus = simOutcomes.length === 0
    ? "not_recorded"
    : simOutcomes.every((value) => value === true)
      ? "pass"
      : simOutcomes.every((value) => value === false)
        ? "fail"
        : "mixed_or_unknown";
  const profits = simulations
    .map((event) => printableEventValue(event.simulated_profit))
    .filter((value): value is string => value !== null);
  const submitted = [...events].reverse().find(
    (event) => event.type === "bundle_submitted",
  );
  const rejected = [...events].reverse().find(
    (event) =>
      event.type === "pipeline_dropped" &&
      printableEventValue(event.net_ev_wei) !== null,
  );
  const evEvent = submitted ?? rejected;
  return {
    finalSimStatus,
    finalSimProfit: profits.length > 0 ? profits.map(bounded).join("|") : "null",
    evDecision: submitted ? "allow" : rejected ? "reject" : "not_recorded",
    evReason: submitted
      ? "bundle_submitted"
      : rejected
        ? bounded(String(rejected.reason ?? "unknown"))
        : "null",
    netEvWei: printableEventValue(evEvent?.net_ev_wei) ?? "null",
  };
}

function printableEventValue(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : null;
}

function printFinalEventJoins(
  input: {
    targetBlock: number;
    sourceBlock: number;
    formalEvents: JsonRecord[];
    malformedEventLines: number;
  },
  lifecycle: RouteLifecycle,
  parsed: ParsedRouteEvents,
  scopedFinal: ScopedFinalEvents,
): void {
  const { withRouteId, missingRouteId } = scopedFinal;
  const routeIds = new Set<string>();
  for (const routeRef of lifecycle.enumeration) {
    const catalog = resolveCatalog(parsed, lifecycle, routeRef);
    if (catalog) routeIds.add(catalog.routeId);
  }
  const unmatched = withRouteId.filter(
    (event) => !routeIds.has(String(event.route_id)),
  );

  console.log(`      Final events joined: ${withRouteId.length - unmatched.length}`);
  for (const routeId of routeIds) {
    const joined = withRouteId.filter((event) => event.route_id === routeId);
    if (joined.length === 0) {
      if (
        lifecycle.solver.some(
          (routeRef) =>
            resolveCatalog(parsed, lifecycle, routeRef)?.routeId === routeId,
        )
      ) {
        console.log(
          `          route_id=${bounded(routeId)} events=0 ` +
            "status=unknown_no_formal_event",
        );
      }
      continue;
    }
    console.log(
      `          route_id=${bounded(routeId)} events=${joined.length} status=joined`,
    );
    for (const event of joined) {
      console.log(`              ${formatFormalEvent(event)}`);
    }
  }
  console.log(`      Final events unmatched: ${unmatched.length}`);
  for (const event of unmatched) {
    console.log(
      `          route_id=${bounded(String(event.route_id))} ` +
        formatFormalEvent(event),
    );
  }
  if (missingRouteId > 0) {
    console.log(
      `      Final events missing route_id: ${missingRouteId} status=unknown_unjoinable`,
    );
  }
  if (input.malformedEventLines > 0) {
    console.log(
      `      Final event stream: status=unknown_malformed_lines ` +
        `count=${input.malformedEventLines}`,
    );
  }
}

function parseRouteEvents(text: string): ParsedRouteEvents {
  const catalogs = new Map<string, RouteCatalogEntry>();
  const catalogsByRouteId = new Map<string, RouteCatalogEntry>();
  const lifecycles: RouteLifecycle[] = [];
  let malformedLines = 0;
  let invalidRecords = 0;
  let conflictingCatalogs = 0;
  let trailingFragment = false;
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (index === lines.length - 1 && !text.endsWith("\n")) {
        trailingFragment = true;
        continue;
      }
      malformedLines++;
      continue;
    }
    if (!isRecord(value)) {
      invalidRecords++;
      continue;
    }
    if (value.type === "block_scan_route_catalog") {
      const catalog = parseCatalog(value);
      if (!catalog) {
        invalidRecords++;
        continue;
      }
      const key = catalogKey(
        catalog.runId,
        catalog.catalogEpoch,
        catalog.routeRef,
      );
      const existing = catalogs.get(key);
      const routeKey = catalogRouteKey(
        catalog.runId,
        catalog.catalogEpoch,
        catalog.routeId,
      );
      const existingRoute = catalogsByRouteId.get(routeKey);
      if (
        (existing && JSON.stringify(existing) !== JSON.stringify(catalog)) ||
        (
          existingRoute &&
          JSON.stringify(existingRoute) !== JSON.stringify(catalog)
        )
      ) {
        conflictingCatalogs++;
        continue;
      }
      catalogs.set(key, catalog);
      catalogsByRouteId.set(routeKey, catalog);
    } else if (value.type === "block_scan_enumeration_solver") {
      const lifecycle = parseLifecycle(value);
      if (!lifecycle) {
        invalidRecords++;
        continue;
      }
      lifecycles.push(lifecycle);
    }
  }
  return {
    catalogs,
    lifecycles,
    malformedLines,
    invalidRecords,
    conflictingCatalogs,
    trailingFragment,
  };
}

function parseCatalog(value: JsonRecord): RouteCatalogEntry | null {
  const schemaVersion = nonnegativeInteger(value.schema_version);
  const runId = stringValue(value.run_id);
  const catalogEpoch = nonnegativeInteger(value.catalog_epoch);
  const routeRef = nonnegativeInteger(value.route_ref);
  const routeId = stringValue(value.route_id);
  const hasEdgeIds = Object.hasOwn(value, "edge_ids");
  const edgeIds = hasEdgeIds ? stringArray(value.edge_ids) : null;
  const flashToken = stringValue(value.flash_token);
  const tokenRing = stringArray(value.token_ring);
  const venuePath = venuePathValue(value.venue_path);
  if (
    (schemaVersion !== 1 && schemaVersion !== 2) ||
    runId === null ||
    catalogEpoch === null ||
    catalogEpoch <= 0 ||
    routeRef === null ||
    routeRef <= 0 ||
    routeId === null ||
    (hasEdgeIds && edgeIds === null) ||
    flashToken === null ||
    tokenRing === null ||
    venuePath === null ||
    (edgeIds !== null && edgeIds.length !== venuePath.length)
  ) {
    return null;
  }
  return {
    runId,
    catalogEpoch,
    routeRef,
    routeId,
    edgeIds,
    tokenRing,
    venuePath,
    flashToken,
  };
}

function parseLifecycle(value: JsonRecord): RouteLifecycle | null {
  const rawSchemaVersion = nonnegativeInteger(value.schema_version);
  if (rawSchemaVersion !== 1 && rawSchemaVersion !== 2) return null;
  const schemaVersion = rawSchemaVersion as 1 | 2;
  const runId = stringValue(value.run_id);
  const catalogEpoch = nonnegativeInteger(value.catalog_epoch);
  const sourceBlock = nonnegativeInteger(value.source_block);
  const sourceBlockHash = nullableStringValue(value.source_block_hash);
  const pricingMode = nullableStringValue(value.pricing_mode);
  const passOutcome = stringValue(value.pass_outcome);
  const passReason = nullableStringValue(value.pass_reason);
  const enumeration = integerArray(value.enumeration);
  const midSourceBlock = schemaVersion === 2 &&
      Object.hasOwn(value, "mid_source_block")
    ? nullableNonnegativeInteger(value.mid_source_block)
    : schemaVersion === 1
      ? null
      : undefined;
  const midSourceBlockHash = schemaVersion === 2 &&
      Object.hasOwn(value, "mid_source_block_hash")
    ? nullableStringValue(value.mid_source_block_hash)
    : schemaVersion === 1
      ? null
      : undefined;
  const exact = schemaVersion === 2
    ? parseExactDiagnostics(value.exact, enumeration ?? [])
    : null;
  const planner = schemaVersion === 2 ? integerArray(value.planner) : null;
  const solver = integerArray(value.solver);
  const droppedBatches =
    value.dropped_batches === undefined
      ? 0
      : nonnegativeInteger(value.dropped_batches);
  const firstDroppedBlock = nullableNonnegativeInteger(
    value.first_dropped_block,
  );
  const lastDroppedBlock = nullableNonnegativeInteger(value.last_dropped_block);
  if (
    runId === null ||
    catalogEpoch === null ||
    catalogEpoch <= 0 ||
    sourceBlock === null ||
    sourceBlockHash === undefined ||
    pricingMode === undefined ||
    passOutcome === null ||
    passReason === undefined ||
    enumeration === null ||
    midSourceBlock === undefined ||
    midSourceBlockHash === undefined ||
    ((midSourceBlock === null) !== (midSourceBlockHash === null)) ||
    exact === undefined ||
    (schemaVersion === 2 && planner === null) ||
    solver === null ||
    droppedBatches === null ||
    firstDroppedBlock === undefined ||
    lastDroppedBlock === undefined ||
    (
      droppedBatches > 0 &&
      (
        firstDroppedBlock === null ||
        lastDroppedBlock === null ||
        firstDroppedBlock > lastDroppedBlock
      )
    ) ||
    (
      droppedBatches === 0 &&
      (firstDroppedBlock !== null || lastDroppedBlock !== null)
    )
  ) {
    return null;
  }
  return {
    schemaVersion,
    runId,
    catalogEpoch,
    sourceBlock,
    sourceBlockHash,
    midSourceBlock,
    midSourceBlockHash,
    pricingMode,
    passOutcome,
    passReason,
    enumeration,
    exact,
    planner,
    solver,
    droppedBatches,
    firstDroppedBlock,
    lastDroppedBlock,
  };
}

function parseExactDiagnostics(
  value: unknown,
  enumeration: readonly number[],
): RouteExactDiagnostic[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== enumeration.length * 4) {
    return undefined;
  }
  const statuses = ["positive", "negative", "failed", "unprobed"] as const;
  const reasons = [
    null,
    "exact_not_admitted",
    "family_circuit_open",
    "instance_circuit_open",
    "composite_circuit_open",
    "probe_timeout",
    "global_deadline",
    "quote_error",
  ] as const;
  const result: RouteExactDiagnostic[] = [];
  for (let index = 0; index < enumeration.length; index++) {
    const offset = index * 4;
    const statusCode = nonnegativeInteger(value[offset]);
    const attemptedCode = nonnegativeInteger(value[offset + 1]);
    const marginBps = value[offset + 2] === null
      ? null
      : typeof value[offset + 2] === "number" &&
          Number.isFinite(value[offset + 2])
        ? value[offset + 2] as number
        : undefined;
    const reasonCode = nonnegativeInteger(value[offset + 3]);
    if (
      statusCode === null ||
      statusCode < 1 ||
      statusCode > statuses.length ||
      (attemptedCode !== 0 && attemptedCode !== 1) ||
      marginBps === undefined ||
      reasonCode === null ||
      reasonCode >= reasons.length
    ) return undefined;
    const status = statuses[statusCode - 1]!;
    const reason = reasons[reasonCode]!;
    if (
      ((status === "positive" || status === "negative") &&
        (attemptedCode !== 1 || marginBps === null || reason !== null)) ||
      ((status === "failed" || status === "unprobed") &&
        (marginBps !== null || reason === null))
    ) return undefined;
    result.push({
      routeRef: enumeration[index]!,
      status,
      attempted: attemptedCode === 1,
      marginBps,
      reason,
    });
  }
  return result;
}

function resolveCatalog(
  parsed: ParsedRouteEvents,
  lifecycle: RouteLifecycle,
  routeRef: number,
): RouteCatalogEntry | null {
  return parsed.catalogs.get(
    catalogKey(lifecycle.runId, lifecycle.catalogEpoch, routeRef),
  ) ?? null;
}

function catalogKey(runId: string, catalogEpoch: number, routeRef: number): string {
  return JSON.stringify([runId, catalogEpoch, routeRef]);
}

function catalogRouteKey(
  runId: string,
  catalogEpoch: number,
  routeId: string,
): string {
  return JSON.stringify([runId, catalogEpoch, routeId]);
}

function formatRoute(
  route: RouteCatalogEntry | null,
  mids?: ReadonlyMap<string, CompactMid> | null,
): string {
  if (!route) return "route=unknown";
  const ring = route.tokenRing.map(bounded).join("->");
  const venues = route.venuePath
    .map(([adapter, venue]) => `${bounded(adapter)}@${bounded(venue)}`)
    .join(">");
  return (
    `route_id=${bounded(route.routeId)} ring=${ring} ` +
    `venues=${venues} flash=${bounded(route.flashToken)} ` +
    `edge_ids=${route.edgeIds === null ? "unknown" : JSON.stringify(route.edgeIds)}` +
    formatRouteMids(route, mids)
  );
}

function formatRouteMids(
  route: RouteCatalogEntry,
  mids?: ReadonlyMap<string, CompactMid> | null,
): string {
  if (mids === undefined) return "";
  if (mids === null) return " edge_mids=unknown_mid_table";
  if (route.edgeIds === null) return " edge_mids=unknown_catalog_schema";
  const missing = route.edgeIds.filter((edgeId) => !mids.has(edgeId));
  if (missing.length > 0) {
    return ` edge_mids=missing:${JSON.stringify(missing)}`;
  }
  return ` edge_mids=${JSON.stringify(route.edgeIds.map((edgeId) => [
    edgeId,
    mids.get(edgeId)!.mid,
  ]))}`;
}

function formatFormalEvent(event: JsonRecord): string {
  const type = bounded(String(event.type ?? "unknown"));
  if (type === "simulation_result") {
    return (
      `type=${type} ok=${String(event.ok ?? "unknown")} ` +
      `simulated_profit=${bounded(String(event.simulated_profit ?? "null"))}` +
      (
        event.failure_reason === undefined
          ? ""
          : ` failure_reason=${bounded(String(event.failure_reason))}`
      )
    );
  }
  if (type === "pipeline_dropped") {
    return (
      `type=${type} stage=${bounded(String(event.stage ?? "unknown"))} ` +
      `reason=${bounded(String(event.reason ?? "unknown"))}` +
      (
        event.net_ev_wei === undefined
          ? ""
          : ` net_ev_wei=${bounded(String(event.net_ev_wei))}`
      )
    );
  }
  return (
    `type=${type} tx_hash=${bounded(String(event.tx_hash ?? "unknown"))}` +
    (
      event.net_ev_wei === undefined
        ? ""
        : ` net_ev_wei=${bounded(String(event.net_ev_wei))}`
    )
  );
}

function printWriterGap(lifecycle: RouteLifecycle): void {
  console.log(
    `      writer_gap: dropped_batches=${lifecycle.droppedBatches} ` +
      `first_dropped_block=${lifecycle.firstDroppedBlock ?? "null"} ` +
      `last_dropped_block=${lifecycle.lastDroppedBlock ?? "null"}`,
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableStringValue(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return stringValue(value) ?? undefined;
}

function nonnegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}

function nullableNonnegativeInteger(
  value: unknown,
): number | null | undefined {
  if (value === undefined || value === null) return null;
  return nonnegativeInteger(value) ?? undefined;
}

function integerArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const result: number[] = [];
  for (const entry of value) {
    const parsed = nonnegativeInteger(entry);
    if (parsed === null) return null;
    result.push(parsed);
  }
  return result;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const entry of value) {
    const parsed = stringValue(entry);
    if (parsed === null) return null;
    result.push(parsed);
  }
  return result;
}

function venuePathValue(value: unknown): Array<[string, string]> | null {
  if (!Array.isArray(value)) return null;
  const result: Array<[string, string]> = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const adapter = stringValue(entry[0]);
    const venue = stringValue(entry[1]);
    if (adapter === null || venue === null) return null;
    result.push([adapter, venue]);
  }
  return result;
}

async function reconstructMidHistory(
  historyPath: string,
  targetBlock: number,
): Promise<ReconstructedMidTable> {
  const lines = createInterface({
    input: createReadStream(historyPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let runId: string | null = null;
  let anchor: MidAnchor | null = null;
  let mids: Map<string, CompactMid> | null = null;
  let baselineSourceBlock: number | null = null;
  let appliedDeltas = 0;
  let previousSequence = 0;
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber++;
    if (!line) continue;
    let record: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) throw new Error("record is not an object");
      record = parsed;
    } catch (error) {
      throw new Error(
        `invalid mid history JSON at line ${lineNumber}: ${message(error)}`,
      );
    }
    if (
      record.type !== "block_scan_mid_baseline" &&
      record.type !== "block_scan_mid_delta"
    ) continue;
    const common = parseMidCommon(record, lineNumber);
    if (runId === null) runId = common.runId;
    if (common.runId !== runId) {
      throw new Error(`mid history changes run_id at line ${lineNumber}`);
    }
    if (common.sequence <= previousSequence) {
      throw new Error(`mid history sequence is not increasing at line ${lineNumber}`);
    }
    previousSequence = common.sequence;
    if (common.sourceBlock > targetBlock) continue;
    if (record.type === "block_scan_mid_baseline") {
      const entries = parseMidEntries(record.mids, "mids", lineNumber);
      const declaredCount = requiredInteger(
        record.mid_count,
        "mid_count",
        lineNumber,
      );
      if (declaredCount !== entries.length) {
        throw new Error(`mid_count mismatch at line ${lineNumber}`);
      }
      mids = new Map(entries);
      anchor = common;
      baselineSourceBlock = common.sourceBlock;
      appliedDeltas = 0;
      continue;
    }
    if (anchor === null || mids === null || baselineSourceBlock === null) {
      continue;
    }
    const previousSourceBlock = requiredInteger(
      record.previous_source_block,
      "previous_source_block",
      lineNumber,
    );
    const previousGeneration = requiredInteger(
      record.previous_generation,
      "previous_generation",
      lineNumber,
    );
    const previousSourceBlockHash = requiredText(
      record.previous_source_block_hash,
      "previous_source_block_hash",
      lineNumber,
    );
    if (
      previousSourceBlock !== anchor.sourceBlock ||
      previousGeneration !== anchor.generation ||
      previousSourceBlockHash.toLowerCase() !==
        anchor.sourceBlockHash.toLowerCase() ||
      common.graphFingerprint !== anchor.graphFingerprint
    ) {
      anchor = null;
      mids = null;
      baselineSourceBlock = null;
      appliedDeltas = 0;
      continue;
    }
    const updates = parseMidEntries(record.updates, "updates", lineNumber);
    const removals = parseMidStringArray(
      record.removals,
      "removals",
      lineNumber,
    );
    if (
      requiredInteger(record.update_count, "update_count", lineNumber) !==
        updates.length ||
      requiredInteger(record.removal_count, "removal_count", lineNumber) !==
        removals.length
    ) {
      throw new Error(`delta count mismatch at line ${lineNumber}`);
    }
    const updateKeys = new Set(updates.map(([edgeKey]) => edgeKey));
    if (removals.some((edgeKey) => updateKeys.has(edgeKey))) {
      throw new Error(`delta update/removal overlap at line ${lineNumber}`);
    }
    for (const [edgeKey, mid] of updates) mids.set(edgeKey, mid);
    for (const edgeKey of removals) mids.delete(edgeKey);
    anchor = common;
    appliedDeltas++;
  }
  if (
    runId === null ||
    anchor === null ||
    mids === null ||
    baselineSourceBlock === null ||
    anchor.sourceBlock !== targetBlock
  ) {
    throw new Error(`block ${targetBlock} is not reconstructable`);
  }
  const sortedMids = Object.freeze(
    [...mids.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([edgeKey, mid]) => Object.freeze([edgeKey, mid] as const)),
  );
  return Object.freeze({
    schemaVersion: 1 as const,
    runId,
    ...anchor,
    baselineSourceBlock,
    appliedDeltas,
    mids: sortedMids,
  });
}

function parseMidCommon(
  record: JsonRecord,
  lineNumber: number,
): MidAnchor & { readonly runId: string; readonly sequence: number } {
  if (record.schema_version !== 1) {
    throw new Error(`unsupported mid history schema at line ${lineNumber}`);
  }
  return Object.freeze({
    runId: requiredText(record.run_id, "run_id", lineNumber),
    sequence: requiredInteger(record.sequence, "sequence", lineNumber),
    sourceBlock: requiredInteger(
      record.source_block,
      "source_block",
      lineNumber,
    ),
    sourceBlockHash: requiredText(
      record.source_block_hash,
      "source_block_hash",
      lineNumber,
    ),
    generation: requiredInteger(record.generation, "generation", lineNumber),
    graphFingerprint: requiredText(
      record.graph_fingerprint,
      "graph_fingerprint",
      lineNumber,
    ),
  });
}

function parseMidEntries(
  value: unknown,
  label: string,
  lineNumber: number,
): Array<readonly [string, CompactMid]> {
  if (!Array.isArray(value)) {
    throw new Error(`${label} is not an array at line ${lineNumber}`);
  }
  const entries: Array<readonly [string, CompactMid]> = [];
  const keys = new Set<string>();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error(`invalid ${label} entry at line ${lineNumber}`);
    }
    const edgeKey = requiredText(entry[0], `${label}.edge_key`, lineNumber);
    if (keys.has(edgeKey) || !isCompactMid(entry[1])) {
      throw new Error(`invalid ${label} entry at line ${lineNumber}`);
    }
    keys.add(edgeKey);
    entries.push(Object.freeze([edgeKey, Object.freeze({ ...entry[1] })]));
  }
  return entries;
}

function isCompactMid(value: unknown): value is CompactMid {
  return isRecord(value) &&
    typeof value.kind === "string" &&
    typeof value.mid === "number" && Number.isFinite(value.mid) &&
    typeof value.fee_bps === "number" && Number.isFinite(value.fee_bps) &&
    typeof value.depth_proxy === "number" &&
    Number.isFinite(value.depth_proxy);
}

function parseMidStringArray(
  value: unknown,
  label: string,
  lineNumber: number,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} is not an array at line ${lineNumber}`);
  }
  const result = value.map((entry) =>
    requiredText(entry, label, lineNumber)
  );
  if (new Set(result).size !== result.length) {
    throw new Error(`${label} contains duplicates at line ${lineNumber}`);
  }
  return result;
}

function requiredInteger(
  value: unknown,
  label: string,
  lineNumber: number,
): number {
  const parsed = nonnegativeInteger(value);
  if (parsed === null) {
    throw new Error(`invalid ${label} at line ${lineNumber}`);
  }
  return parsed;
}

function requiredText(
  value: unknown,
  label: string,
  lineNumber: number,
): string {
  const parsed = stringValue(value);
  if (parsed === null) {
    throw new Error(`invalid ${label} at line ${lineNumber}`);
  }
  return parsed;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bounded(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 240);
}

void main().catch((error) => {
  console.error(`[block-activity] ${message(error)}`);
  process.exitCode = 1;
});
