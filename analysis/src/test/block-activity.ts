import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const analysisRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = join(analysisRoot, "src", "cli", "block-activity.ts");
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const ROUTE_A = "sha256:route-a";
const ROUTE_B = "sha256:route-b";
const ROUTE_C = "sha256:route-c";

test("block-activity preserves the JSONL funnel and joins target N to blockscan source N-1", async () => {
  await withFixture(async ({ eventsPath, logPath }) => {
    const stdout = await runBlockActivity(eventsPath, logPath);

    assert.match(stdout, /opportunity_seen: 1/);
    assert.match(stdout, /pipeline_dropped: 1/);
    assert.match(stdout, /stage=quote reason=no_quote: 1/);
    assert.match(stdout, /bundle_submitted: 1 abcdef01234567/);
    assert.match(stdout, new RegExp(`blockscan: target_block=100 source_block=99 status=complete`));
    assert.match(stdout, /solve_rings: 1/);
    assert.match(stdout, new RegExp(`ring=${WETH}->${USDC}->${WETH} net=42`));
    assert.match(stdout, new RegExp(`solve_ring_tokens: 2 ${USDC},${WETH}`));
  });
});

test("block-activity reports unavailable blockscan logs as unknown without losing the funnel", async () => {
  await withFixture(async ({ root, eventsPath }) => {
    const missingLog = join(root, "missing-live.log");
    const stdout = await runBlockActivity(eventsPath, missingLog);

    assert.match(stdout, /opportunity_seen: 1/);
    assert.match(stdout, /bundle_submitted: 1/);
    assert.match(stdout, /blockscan: target_block=100 source_block=99 status=unknown_log_unavailable/);
    assert.match(stdout, /solve_rings: unknown/);
    assert.match(stdout, /solve_ring_tokens: unknown/);
  });
});

test("block-activity resolves catalog refs and joins structured final events without stdout inference", async () => {
  await withFixture(async ({ eventsPath, logPath, routeEventsPath }) => {
    await writeFile(eventsPath, [
      JSON.stringify({
        type: "simulation_result",
        run_id: "run-a",
        target_block: 100,
        source_block: 99,
        opportunity_kind: "block-scan-arb",
        route_id: ROUTE_A,
        ok: true,
        simulated_profit: "42",
      }),
      JSON.stringify({
        type: "pipeline_dropped",
        run_id: "run-a",
        target_block: 100,
        source_block: 99,
        opportunity_kind: "block-scan-arb",
        route_id: ROUTE_B,
        stage: "submit_gate",
        reason: "below_ev_gate",
        net_ev_wei: "-1",
      }),
    ].join("\n"));
    await writeFile(routeEventsPath, [
      routeCatalog(17, ROUTE_A, [WETH, USDC, WETH], [
        ["univ3-swap", "0xpool-a"],
        ["curve-swap", "0xpool-b"],
      ]),
      routeCatalog(4, ROUTE_B, [WETH, USDT, WETH], [
        ["univ3-swap", "0xpool-c"],
        ["univ2-swap", "0xpool-d"],
      ]),
      routeCatalog(9, ROUTE_C, [WETH, USDC, USDT, WETH], [
        ["curve-swap", "0xpool-e"],
        ["univ3-swap", "0xpool-f"],
        ["univ2-swap", "0xpool-g"],
      ]),
      JSON.stringify({
        type: "block_scan_enumeration_solver",
        schema_version: 1,
        run_id: "run-a",
        catalog_epoch: 1,
        source_block: 99,
        source_block_hash: "0xsource99",
        pricing_mode: "current-n",
        pass_outcome: "ran",
        pass_reason: null,
        enumeration: [17, 4, 9],
        solver: [17, 4],
      }),
    ].join("\n"));

    const stdout = await runBlockActivity(
      eventsPath,
      logPath,
      routeEventsPath,
    );

    assert.match(
      stdout,
      /blockscan-routes: target_block=100 source_block=99 status=complete/,
    );
    assert.match(stdout, /Enumeration: 3/);
    assert.match(
      stdout,
      new RegExp(`rank=1 ref=17 route_id=${escapeRegex(ROUTE_A)} .*univ3-swap@0xpool-a`),
    );
    assert.match(stdout, /Solver entered: 2/);
    assert.match(stdout, /call=2 ref=4/);
    assert.match(stdout, /Enumerated not solver: 1/);
    assert.match(stdout, new RegExp(`ref=9 route_id=${escapeRegex(ROUTE_C)}`));
    assert.match(stdout, /Final events joined: 2/);
    assert.match(stdout, /type=simulation_result ok=true simulated_profit=42/);
    assert.match(
      stdout,
      /type=pipeline_dropped stage=submit_gate reason=below_ev_gate net_ev_wei=-1/,
    );
    assert.doesNotMatch(stdout, /solve_rings:/);
  });
});

test("block-activity scopes route refs by catalog epoch", async () => {
  await withFixture(async ({ eventsPath, logPath, routeEventsPath }) => {
    await writeFile(routeEventsPath, [
      routeCatalog(1, ROUTE_A, [WETH, USDC, WETH], [
        ["univ3-swap", "0xold"],
      ], 1),
      routeCatalog(1, ROUTE_B, [WETH, USDT, WETH], [
        ["univ3-swap", "0xnew"],
      ], 2),
      JSON.stringify({
        type: "block_scan_enumeration_solver",
        schema_version: 1,
        run_id: "run-a",
        catalog_epoch: 2,
        source_block: 99,
        source_block_hash: "0xsource99",
        pricing_mode: "n-minus-one",
        pass_outcome: "ran",
        pass_reason: null,
        enumeration: [1],
        solver: [],
      }),
    ].join("\n"));

    const stdout = await runBlockActivity(
      eventsPath,
      logPath,
      routeEventsPath,
    );

    assert.match(stdout, new RegExp(`route_id=${escapeRegex(ROUTE_B)}`));
    assert.match(stdout, /univ3-swap@0xnew/);
    assert.doesNotMatch(stdout, /univ3-swap@0xold/);
  });
});

test("block-activity reports a persisted writer gap instead of zero routes", async () => {
  await withFixture(async ({ eventsPath, logPath, routeEventsPath }) => {
    await writeFile(routeEventsPath, JSON.stringify({
      type: "block_scan_enumeration_solver",
      schema_version: 1,
      run_id: "run-a",
      catalog_epoch: 1,
      source_block: 100,
      source_block_hash: "0xsource100",
      pricing_mode: "current-n",
      pass_outcome: "ran",
      pass_reason: null,
      enumeration: [],
      solver: [],
      dropped_batches: 1,
      first_dropped_block: 99,
      last_dropped_block: 99,
    }));

    const stdout = await runBlockActivity(
      eventsPath,
      logPath,
      routeEventsPath,
    );

    assert.match(stdout, /status=unknown_writer_gap/);
    assert.match(
      stdout,
      /writer_gap: dropped_batches=1 first_dropped_block=99 last_dropped_block=99/,
    );
    assert.doesNotMatch(stdout, /Enumeration: 0/);
    assert.doesNotMatch(stdout, /solve_rings:/);
  });
});

test("block-activity preserves scheduler coalesce as not-started evidence", async () => {
  await withFixture(async ({ eventsPath, logPath, routeEventsPath }) => {
    await writeFile(routeEventsPath, JSON.stringify({
      type: "block_scan_enumeration_solver",
      schema_version: 1,
      run_id: "run-a",
      catalog_epoch: 1,
      source_block: 99,
      source_block_hash: null,
      pricing_mode: null,
      pass_outcome: "not_started",
      pass_reason: "scheduler_coalesced",
      enumeration: [],
      solver: [],
    }));

    const stdout = await runBlockActivity(
      eventsPath,
      logPath,
      routeEventsPath,
    );

    assert.match(stdout, /status=not_started/);
    assert.match(
      stdout,
      /pass_outcome=not_started pass_reason=scheduler_coalesced/,
    );
    assert.match(stdout, /Enumeration: 0/);
    assert.match(stdout, /Solver entered: 0/);
    assert.doesNotMatch(stdout, /solve_rings:/);
  });
});

test("block-activity fails closed when a lifecycle references an absent catalog entry", async () => {
  await withFixture(async ({ eventsPath, logPath, routeEventsPath }) => {
    await writeFile(routeEventsPath, JSON.stringify({
      type: "block_scan_enumeration_solver",
      schema_version: 1,
      run_id: "run-a",
      catalog_epoch: 1,
      source_block: 99,
      source_block_hash: "0xsource99",
      pricing_mode: "current-n",
      pass_outcome: "ran",
      pass_reason: null,
      enumeration: [17],
      solver: [17],
    }));

    const stdout = await runBlockActivity(
      eventsPath,
      logPath,
      routeEventsPath,
    );

    assert.match(stdout, /status=unknown_catalog_reference/);
    assert.match(stdout, /unresolved_route_refs: 17/);
    assert.match(stdout, /ref=17 route=unknown/);
    assert.doesNotMatch(stdout, /solve_rings:/);
  });
});

test("block-activity never falls back to legacy stdout when requested route evidence is unavailable", async () => {
  await withFixture(async ({ root, eventsPath, logPath }) => {
    const missingRouteEvents = join(root, "missing-route-events.jsonl");
    const stdout = await runBlockActivity(
      eventsPath,
      logPath,
      missingRouteEvents,
    );

    assert.match(stdout, /status=unknown_route_events_unavailable/);
    assert.doesNotMatch(stdout, /solve_rings:/);
    assert.doesNotMatch(stdout, /net=42/);
  });
});

test("block-activity rejects missing and wrong route-event schema", async () => {
  await withFixture(async ({ eventsPath, logPath, routeEventsPath }) => {
    await writeFile(routeEventsPath, [
      JSON.stringify({
        type: "block_scan_route_catalog",
        schema_version: 2,
        run_id: "run-a",
        catalog_epoch: 1,
        route_ref: 1,
        route_id: ROUTE_A,
        token_ring: [WETH, USDC, WETH],
        venue_path: [["univ3-swap", "0xpool-a"]],
        flash_token: WETH,
      }),
      JSON.stringify({
        type: "block_scan_enumeration_solver",
        run_id: "run-a",
        catalog_epoch: 1,
        source_block: 99,
        enumeration: [],
        solver: [],
      }),
    ].join("\n"));

    const stdout = await runBlockActivity(
      eventsPath,
      logPath,
      routeEventsPath,
    );

    assert.match(stdout, /status=unknown_invalid_route_events/);
    assert.match(stdout, /invalid_records=2/);
  });
});

test("block-activity preserves committed blocks while the writer has a partial tail", async () => {
  await withFixture(async ({ eventsPath, logPath, routeEventsPath }) => {
    await writeFile(routeEventsPath, [
      routeCatalog(1, ROUTE_A, [WETH, USDC, WETH], [
        ["univ3-swap", "0xpool-a"],
      ]),
      JSON.stringify({
        type: "block_scan_enumeration_solver",
        schema_version: 1,
        run_id: "run-a",
        catalog_epoch: 1,
        source_block: 99,
        source_block_hash: "0xsource99",
        pricing_mode: "source_n",
        pass_outcome: "ran",
        pass_reason: null,
        enumeration: [1],
        solver: [1],
      }),
      "{\"type\":\"block_scan_route_catalog\"",
    ].join("\n"));

    const stdout = await runBlockActivity(
      eventsPath,
      logPath,
      routeEventsPath,
    );

    assert.match(stdout, /status=complete/);
    assert.match(stdout, /writer_tail: status=in_progress/);
    assert.doesNotMatch(stdout, /unknown_invalid_route_events/);
  });
});

test("block-activity rejects one route id mapped to conflicting catalog locators", async () => {
  await withFixture(async ({ eventsPath, logPath, routeEventsPath }) => {
    await writeFile(routeEventsPath, [
      routeCatalog(1, ROUTE_A, [WETH, USDC, WETH], [
        ["univ3-swap", "0xpool-a"],
      ]),
      routeCatalog(2, ROUTE_A, [WETH, USDT, WETH], [
        ["univ2-swap", "0xpool-b"],
      ]),
      JSON.stringify({
        type: "block_scan_enumeration_solver",
        schema_version: 1,
        run_id: "run-a",
        catalog_epoch: 1,
        source_block: 99,
        source_block_hash: "0xsource99",
        pricing_mode: "source_n",
        pass_outcome: "ran",
        pass_reason: null,
        enumeration: [1],
        solver: [1],
      }),
    ].join("\n"));

    const stdout = await runBlockActivity(
      eventsPath,
      logPath,
      routeEventsPath,
    );

    assert.match(stdout, /status=unknown_invalid_route_events/);
    assert.match(stdout, /conflicting_catalogs=1/);
  });
});

async function runBlockActivity(
  eventsPath: string,
  logPath: string,
  routeEventsPath?: string,
): Promise<string> {
  const args = [
    "--import",
    "tsx",
    cliPath,
    "--block",
    "100",
    "--events",
    eventsPath,
    "--blockscan-log",
    logPath,
  ];
  if (routeEventsPath !== undefined) {
    args.push("--route-events", routeEventsPath);
  }
  const result = await execFileAsync(process.execPath, args, {
    cwd: analysisRoot,
  });
  return result.stdout;
}

async function withFixture(
  run: (fixture: {
    root: string;
    eventsPath: string;
    logPath: string;
    routeEventsPath: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mev-block-activity-"));
  const eventsPath = join(root, "events.jsonl");
  const logPath = join(root, "mev-live.log");
  const routeEventsPath = join(root, "blockscan-routes.jsonl");
  await writeFile(eventsPath, [
    JSON.stringify({ type: "opportunity_seen", target_block: 100 }),
    JSON.stringify({ type: "pipeline_dropped", target_block: 100, stage: "quote", reason: "no_quote" }),
    JSON.stringify({ type: "bundle_submitted", target_block: 100, opportunity_id: "abcdef0123456789" }),
  ].join("\n"));
  await writeFile(logPath, [
    "[searcher/blockscan] block=99 warm=full reason=startup",
    `[searcher/blockscan] block=99 solve ring=${WETH}->${USDC}->${WETH} net=42 standing=false protoRing=false`,
    "[searcher/blockscan] block=99 scannedPairs=1 candidates=1 quotePositive=1 bestNet=42 warmedV2V3=1 protocolMids=0 skippedVenues=0 ms=2",
    "[searcher/blockscan] block=99 stage warm_plan=1ms solve=1ms total=2ms",
  ].join("\n"));
  try {
    await run({ root, eventsPath, logPath, routeEventsPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function routeCatalog(
  routeRef: number,
  routeId: string,
  tokenRing: string[],
  venuePath: Array<[string, string]>,
  catalogEpoch = 1,
): string {
  return JSON.stringify({
    type: "block_scan_route_catalog",
    schema_version: 1,
    run_id: "run-a",
    catalog_epoch: catalogEpoch,
    route_ref: routeRef,
    route_id: routeId,
    token_ring: tokenRing,
    venue_path: venuePath,
    flash_token: tokenRing[0],
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
