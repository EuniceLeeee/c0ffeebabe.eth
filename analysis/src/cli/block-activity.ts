// block-activity — "what did OUR live searcher do at block N?" Reads the live structured events JSONL
// and summarizes our funnel at a target_block: seen / dropped (stage × reason) / submitted, plus an
// optional cross-reference of a competitor's venue ids against our whole run (did we ever touch them).
//
// Zero-CU on the events (pure JSONL read). The events live on the NODE — this defaults to the node
// path so it runs there directly; point --events at a fetched slice to run locally.
//
// Usage: npm run block-activity -- --block <N> [--events <path>] [--blockscan-log <path>]
//   [--route-events <path>]
//   [--venues <id,id,...>]
//   default --events /var/log/mev/events/searcher-live.jsonl (the live node path; the OLD
//   analysis/events + /tmp/mev-live-*.log defaults are stale — the node moved to /var/log/mev).
import { existsSync, readFileSync } from "node:fs";
import {
  blockScanActivityAtBlock,
  blockScanSourceBlockForTarget,
} from "./bundle-postmortem.js";

const DEFAULT_EVENTS = "/var/log/mev/events/searcher-live.jsonl";
const DEFAULT_BLOCKSCAN_LOG = "/var/log/mev-live.log";

type JsonRecord = Record<string, unknown>;

interface RouteCatalogEntry {
  runId: string;
  catalogEpoch: number;
  routeRef: number;
  routeId: string;
  tokenRing: string[];
  venuePath: Array<[string, string]>;
  flashToken: string;
}

interface RouteLifecycle {
  runId: string;
  catalogEpoch: number;
  sourceBlock: number;
  sourceBlockHash: string | null;
  pricingMode: string | null;
  passOutcome: string;
  passReason: string | null;
  enumeration: number[];
  solver: number[];
  droppedBatches: number;
  firstDroppedBlock: number | null;
  lastDroppedBlock: number | null;
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

function main(): void {
  const blockStr = arg("--block");
  if (!blockStr) {
    console.error(
      "usage: npm run block-activity -- --block <N> [--events <path>] " +
        "[--route-events <path>] [--blockscan-log <path>] [--venues <id,...>]",
    );
    process.exit(1);
  }
  const block = Number(blockStr);
  const eventsPath = arg("--events") ?? DEFAULT_EVENTS;
  const blockScanLogPath = arg("--blockscan-log") ?? DEFAULT_BLOCKSCAN_LOG;
  const routeEventsPath = arg("--route-events");
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
    printStructuredRouteActivity({
      targetBlock: block,
      sourceBlock,
      routeEventsPath,
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

function printStructuredRouteActivity(input: {
  targetBlock: number;
  sourceBlock: number;
  routeEventsPath: string;
  formalEvents: JsonRecord[];
  malformedEventLines: number;
}): void {
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
  const refs = [...lifecycle.enumeration, ...lifecycle.solver];
  const unresolvedRefs = [...new Set(refs)].filter(
    (routeRef) =>
      !parsed.catalogs.has(
        catalogKey(lifecycle.runId, lifecycle.catalogEpoch, routeRef),
      ),
  );
  const enumerationSet = new Set(lifecycle.enumeration);
  const duplicateEnumeration =
    enumerationSet.size !== lifecycle.enumeration.length;
  const solverOutsideEnumeration = lifecycle.solver.filter(
    (routeRef) => !enumerationSet.has(routeRef),
  );
  const evidenceStatus =
    unresolvedRefs.length > 0
      ? "unknown_catalog_reference"
      : duplicateEnumeration || solverOutsideEnumeration.length > 0
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
      `catalog_epoch=${lifecycle.catalogEpoch} ` +
      `source_block_hash=${lifecycle.sourceBlockHash ?? "null"} ` +
      `pricing_mode=${lifecycle.pricingMode === null ? "null" : bounded(lifecycle.pricingMode)} ` +
      `pass_outcome=${bounded(lifecycle.passOutcome)} ` +
      `pass_reason=${lifecycle.passReason === null ? "null" : bounded(lifecycle.passReason)}`,
  );
  if (lifecycle.droppedBatches > 0) printWriterGap(lifecycle);
  if (unresolvedRefs.length > 0) {
    console.log(`      unresolved_route_refs: ${unresolvedRefs.join(",")}`);
  }
  if (duplicateEnumeration) {
    console.log("      invariant: duplicate_enumeration_refs");
  }
  if (solverOutsideEnumeration.length > 0) {
    console.log(
      `      invariant: solver_refs_outside_enumeration=${solverOutsideEnumeration.join(",")}`,
    );
  }

  console.log(`      Enumeration: ${lifecycle.enumeration.length}`);
  lifecycle.enumeration.forEach((routeRef, index) => {
    console.log(
      `          rank=${index + 1} ref=${routeRef} ` +
        formatRoute(resolveCatalog(parsed, lifecycle, routeRef)),
    );
  });

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

  printFinalEventJoins(input, lifecycle, parsed);
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
): void {
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
  const missingRouteId = scoped.length - withRouteId.length;
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
  const flashToken = stringValue(value.flash_token);
  const tokenRing = stringArray(value.token_ring);
  const venuePath = venuePathValue(value.venue_path);
  if (
    schemaVersion !== 1 ||
    runId === null ||
    catalogEpoch === null ||
    catalogEpoch <= 0 ||
    routeRef === null ||
    routeRef <= 0 ||
    routeId === null ||
    flashToken === null ||
    tokenRing === null ||
    venuePath === null
  ) {
    return null;
  }
  return {
    runId,
    catalogEpoch,
    routeRef,
    routeId,
    tokenRing,
    venuePath,
    flashToken,
  };
}

function parseLifecycle(value: JsonRecord): RouteLifecycle | null {
  const schemaVersion = nonnegativeInteger(value.schema_version);
  const runId = stringValue(value.run_id);
  const catalogEpoch = nonnegativeInteger(value.catalog_epoch);
  const sourceBlock = nonnegativeInteger(value.source_block);
  const sourceBlockHash = nullableStringValue(value.source_block_hash);
  const pricingMode = nullableStringValue(value.pricing_mode);
  const passOutcome = stringValue(value.pass_outcome);
  const passReason = nullableStringValue(value.pass_reason);
  const enumeration = integerArray(value.enumeration);
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
    schemaVersion !== 1 ||
    runId === null ||
    catalogEpoch === null ||
    catalogEpoch <= 0 ||
    sourceBlock === null ||
    sourceBlockHash === undefined ||
    pricingMode === undefined ||
    passOutcome === null ||
    passReason === undefined ||
    enumeration === null ||
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
    runId,
    catalogEpoch,
    sourceBlock,
    sourceBlockHash,
    pricingMode,
    passOutcome,
    passReason,
    enumeration,
    solver,
    droppedBatches,
    firstDroppedBlock,
    lastDroppedBlock,
  };
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

function formatRoute(route: RouteCatalogEntry | null): string {
  if (!route) return "route=unknown";
  const ring = route.tokenRing.map(bounded).join("->");
  const venues = route.venuePath
    .map(([adapter, venue]) => `${bounded(adapter)}@${bounded(venue)}`)
    .join(">");
  return (
    `route_id=${bounded(route.routeId)} ring=${ring} ` +
    `venues=${venues} flash=${bounded(route.flashToken)}`
  );
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

function bounded(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 240);
}

main();
