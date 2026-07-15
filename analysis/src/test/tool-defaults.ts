import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_INPUT_LOCATIONS,
  resolveInputPaths,
  type InputLocations,
} from "../cli/redact-live-run.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

test("live-run defaults name the current node artifacts", () => {
  assert.equal(DEFAULT_INPUT_LOCATIONS.currentLog, "/var/log/mev-live.log");
  assert.equal(
    DEFAULT_INPUT_LOCATIONS.currentEvents,
    "/var/log/mev/events/searcher-live.jsonl",
  );
});

test("current node artifacts take priority over newer legacy files", async () => {
  await withLocations(async (locations) => {
    await write(locations.currentLog);
    await write(locations.currentEvents);
    const legacyLog = join(locations.legacyLogDir, "mev-live-legacy.log");
    const legacyEvents = join(locations.legacyEventsDir, "searcher-legacy.jsonl");
    await write(legacyLog);
    await write(legacyEvents);
    const newer = new Date(Date.now() + 60_000);
    await utimes(legacyLog, newer, newer);
    await utimes(legacyEvents, newer, newer);

    assert.deepEqual(await resolveInputPaths({}, locations), {
      logPath: locations.currentLog,
      eventsPath: locations.currentEvents,
    });
  });
});

test("missing node artifacts safely fall back to the newest legacy files", async () => {
  await withLocations(async (locations) => {
    const oldLog = join(locations.legacyLogDir, "mev-live-old.log");
    const newLog = join(locations.legacyLogDir, "mev-live-new.log");
    const events = join(locations.legacyEventsDir, "searcher-local.jsonl");
    await write(oldLog);
    await write(newLog);
    await write(events);
    const old = new Date(1_000);
    const newer = new Date(2_000);
    await utimes(oldLog, old, old);
    await utimes(newLog, newer, newer);

    assert.deepEqual(await resolveInputPaths({}, locations), {
      logPath: newLog,
      eventsPath: events,
    });
  });
});

test("explicit paths override defaults and events remain optional", async () => {
  await withLocations(async (locations) => {
    assert.deepEqual(
      await resolveInputPaths({ log: "/chosen/run.log", events: "/chosen/events.jsonl" }, locations),
      { logPath: "/chosen/run.log", eventsPath: "/chosen/events.jsonl" },
    );

    const fallbackLog = join(locations.legacyLogDir, "mev-live-only.log");
    await write(fallbackLog);
    await mkdir(join(locations.legacyEventsDir, "searcher-directory.jsonl"));
    assert.deepEqual(await resolveInputPaths({}, locations), {
      logPath: fallbackLog,
      eventsPath: undefined,
    });
  });
});

test("census-gap defaults to the runtime block-scan pool view", async () => {
  const script = await readFile(join(repoRoot, "scripts", "census-gap.sh"), "utf8");
  assert.match(
    script,
    /^GRAPH=\$\{GRAPH:-\/opt\/MEV\/listener\/searcher\/pools\/runtime-blockscan-pools\.json\}$/m,
  );
  assert.match(script, /^BLOCKSCAN_LOG=\$\{BLOCKSCAN_LOG:-\}$/m);
  assert.match(script, /BLOCKSCAN_LOG=\$\{UNIT_LOG:-\/var\/log\/mev-live\.log\}/);
  assert.match(script, /EVENTS=\$\{EVENTS:-\/var\/log\/mev\/events\/searcher-live\.jsonl\}/);
  assert.match(script, /events file unreadable: \$EVENTS/);
  assert.match(script, /--blockscan-log "\$BLOCKSCAN_INPUT"/);
  assert.match(script, /WATCH_CONFIG=\$\{WATCH_CONFIG:-\$ANALYSIS_ROOT\/analysis\/config\/live-competitors\.json\}/);
  assert.match(script, /WATCH_ARGS=\(--watch-config "\$WATCH_CONFIG"\)/);
  assert.doesNotMatch(script, /0xae2fc483527b8ef99eb5d9b44875f005ba1fae13/i);
});

test("census-gap excludes stale and failed postmortem artifacts", async () => {
  const script = await readFile(join(repoRoot, "scripts", "census-gap.sh"), "utf8");
  assert.match(script, /^set -euo pipefail$/m);
  assert.match(script, /census output missing summary or matched competitor list/);
  assert.match(script, /rm -f .*pm-0x\*\.json/s);
  assert.match(script, /PM_FILES=\(\)/);
  assert.match(script, /rm -f "\$pm"/);
  assert.match(script, /jq -r -s[\s\S]*"\$\{PM_FILES\[@\]\}"/);
  assert.doesNotMatch(script, /jq -r -s[\s\S]*"\$OUT"\/pm-0x\*\.json/);
  assert.match(script, /incomplete: \$PM_FAILURES postmortem\(s\) failed/);
  assert.doesNotMatch(script, /scan_submitted_lost/);
  assert.match(script, /scan_related_submission_seen/);
  assert.match(script, /scan_pass_had_submission/);
  assert.match(script, /routing_unverified\(tokenedge-index-required/);
  assert.match(script, /manual_required:route_incomplete/);
  assert.ok(
    script.indexOf('($ra.status // "") == "manual_required"') < script.indexOf('elif $oog > 0'),
    "an unresolved non-swap route must stop for manual review before any all-touch pool-gap verdict",
  );
  assert.match(script, /unknown_competitor_tokens/);
  assert.ok(
    script.indexOf("unknown_competitor_tokens") < script.indexOf("scan_candidate_token_gap"),
    "unknown token sets must not be reported as a candidate-token coverage gap",
  );
});

test("node deploy installs and verifies production analysis tooling before restart", async () => {
  const script = await readFile(join(repoRoot, "scripts", "deploy-node.sh"), "utf8");
  const searcher = await readFile(join(repoRoot, "listener", "src", "searcher", "main.ts"), "utf8");
  const revmClient = await readFile(
    join(repoRoot, "listener", "src", "searcher", "revm-sim-client.ts"),
    "utf8",
  );
  assert.match(script, /cd "\$REPO\/analysis"/);
  assert.match(script, /npm ci --include=dev --prefer-offline --no-audit --no-fund/);
  assert.match(script, /npm run build/);
  assert.match(
    script,
    /node --import tsx --test src\/test\/blockscan-log-join\.ts src\/test\/block-activity\.ts[\s\\]*src\/test\/live-loss-blockscan\.ts/,
  );
  assert.ok(
    script.indexOf("analysis preflight failed") < script.indexOf("systemctl restart mev-searcher"),
    "analysis verification must fail before the live service restart",
  );
  assert.match(script, /echo "SEARCHER_EVENTS_PATH=\$EVENTS_PATH"/);
  assert.match(script, /events telemetry banner missing for \$EVENTS_PATH/);
  assert.match(script, /victim-source markers require \.backrun/);
  assert.match(script, /\.backrun requires \.mempool and\/or \.mev-share/);
  assert.match(script, /echo "SEARCHER_ENABLE_MEMPOOL=\$MEMPOOL_VAL"/);
  assert.match(script, /echo "SEARCHER_ENABLE_MEV_SHARE=\$MEV_SHARE_VAL"/);
  assert.match(script, /echo "SEARCHER_ANVIL_PORT=\$ANVIL_PORT"/);
  assert.match(script, /echo "SEARCHER_BLOCKSCAN_ANVIL_PORT=\$BLOCKSCAN_ANVIL_PORT"/);
  assert.match(script, /echo "SEARCHER_EAGER_STATE_BACKEND=\$BACKRUN_VAL"/);
  assert.match(script, /AUTHORIZED_MAX_WALLET_ETH=0\.2/);
  assert.ok(
    script.indexOf("PK=$(env_value PRIVATE_KEY") < script.indexOf("PK=$(env_value OWNER_PRIVATE_KEY"),
    "deploy guard must use the same PRIVATE_KEY-first signer precedence as the searcher",
  );
  assert.match(script, /canonicalize_env "\$tmp"/);
  assert.match(script, /unique SEARCHER_EV_GATE=1 required/);
  assert.match(script, /effective signer changed after restart/);
  assert.match(script, /effective signer is not the on-chain BotVM owner/);
  assert.match(script, /challenger unit is not fully stopped/);
  assert.match(script, /trusted close\/reap is required before deploying A/);
  assert.match(script, /SEARCHER_LIVE_RPC_URL=\$LOCAL_RPC/);
  assert.match(script, /SEARCHER_LIVE_WS_URL=\$LOCAL_WS/);
  assert.match(script, /SEARCHER_RUNTIME_COMMIT=\$DEPLOY_COMMIT/);
  assert.match(script, /SEARCHER_FORCE_INCLUDE_ROUTERS_PATH=\$ROUTER_SNAPSHOT/);
  assert.match(script, /router allowlist pinned: hash=\$ROUTER_HASH/);
  assert.match(script, /REVM_CARGO=\$\{REVM_CARGO:-\/root\/\.cargo\/bin\/cargo\}/);
  assert.match(script, /CARGO_TARGET_DIR="\$REVM_BUILD_DIR" "\$REVM_CARGO" build --release --locked/);
  assert.match(script, /REVM_RUNTIME_BIN="\$REVM_RUNTIME_DIR\/revm-sim-\$REVM_RUNTIME_HASH"/);
  assert.match(script, /install -m 0555 "\$REVM_BUILD_BIN" "\$REVM_RUNTIME_TMP"/);
  assert.match(script, /echo "SEARCHER_REVM_SIM_BIN=\$REVM_RUNTIME_BIN"/);
  assert.match(script, /restarted process did not retain the verified revm-sim artifact/);
  assert.ok(
    script.indexOf("analysis preflight failed") <
      script.indexOf('echo "SEARCHER_REVM_SIM_BIN=$REVM_RUNTIME_BIN"'),
    "the live environment must not select the staged daemon before preflight passes",
  );
  assert.match(searcher, /executablePath: process\.env\.SEARCHER_REVM_SIM_BIN/);
  assert.match(revmClient, /configured revm-sim executable missing/);
  assert.match(revmClient, /this\.executablePath \?\? \(useBinary \? binary : "cargo"\)/);
  assert.match(script, /searcher stop verified and live marker removed/);
  assert.match(script, /systemctl kill --kill-who=all --signal=KILL mev-searcher/);
  assert.match(script, /mempool startup banner does not match marker-controlled posture/);
  assert.ok(
    searcher.indexOf("await validateLiveEnvelope(") < searcher.indexOf("new ProductionBundleRouter("),
    "effective live envelope must be validated before the production router exists",
  );
});

test("A/B wrapper keeps blockscan-only as default and gates explicit dual mode", async () => {
  const script = await readFile(join(repoRoot, "scripts", "deploy-ab-challenger.sh"), "utf8");
  assert.match(script, /mode=\$\(env_get AB_LANE_MODE\); mode=\$\{mode:-blockscan-only\}/);
  assert.match(script, /blockscan-only\|dual/);
  assert.match(script, /SEARCHER_ENABLE_BACKRUN=\$expected_backrun/);
  assert.match(script, /SEARCHER_ENABLE_MEMPOOL=\$expected_mempool/);
  assert.match(script, /SEARCHER_ENABLE_MEV_SHARE=\$expected_mev_share/);
  assert.match(script, /AB_VICTIM_MODE must be public-only\|both/);
  assert.match(script, /SEARCHER_ANVIL_PORT=8566/);
  assert.match(script, /SEARCHER_EAGER_STATE_BACKEND=\$expected_backrun/);
  assert.match(script, /challenger_victim_stream_timeout/);
  assert.match(script, /infrastructure shakedown must run identical searcher code/);
  assert.match(script, /replay_top_n=.*SEARCHER_POOL_UNIVERSE_TOP_N/);
  assert.match(script, /--pool-universe-top-n "\$replay_top_n"/);
  assert.match(script, /--expected-challenger "\$expected_b"/);
  assert.match(script, /A\/B candidate config deltas are forbidden/);
  assert.match(script, /B challenger may not modify the trusted state\/port backend/);
  assert.match(script, /frozen challenger is not an ancestor of the report branch tip/);
  assert.match(script, /challenger branch changed non-evidence file after frozen code SHA/);
  assert.match(script, /reset --hard "\$b_commit"/);
  assert.match(script, /clean -fdx/);
  assert.match(script, /champion canonical revm-sim artifact missing/);
  assert.match(script, /A\/B revm-sim paths differ/);
  assert.match(script, /a_revm_hash "\$a_revm_hash" b_revm_hash "\$b_revm_hash"/);
  assert.match(script, /champion revm-sim artifact drift/);
  assert.match(script, /challenger revm-sim artifact drift/);
  assert.match(script, /a_revm_hash_after/);
  assert.match(script, /b_revm_hash_after/);
  assert.ok(
    script.indexOf('a_revm_hash=$(hash_file "$a_revm_path")') <
      script.indexOf('systemd-run --unit="$UNIT"'),
    "the challenger must bind the champion revm artifact before it starts",
  );
  assert.match(script, /Environment=PATH=\/root\/\.cargo\/bin:/);
  assert.match(script, /prepare_trusted_base "\$a_commit"/);
  assert.match(script, /--base-root "\$TRUSTED_BASE"/);
  assert.match(script, /AUTHORIZED_MAX_WALLET_ETH=0\.2/);
  assert.match(script, /allowed = \{"PRIVATE_KEY", "OWNER_PRIVATE_KEY", "BOTVM_ADDRESS", "BOTVM_OWNER"\}/);
  assert.match(script, /--property="EnvironmentFile=\$B_PROCESS_ENV"/);
  assert.match(script, /MEV_LIVE_MAX_WALLET_ETH=%s/);
  assert.doesNotMatch(script, /\/bin\/bash -lc/);
  assert.match(script, /challenger MEV_SHARE_SSE_URL must match champion/);
  assert.match(script, /victim_feed_endpoints_differ/);
  assert.match(script, /run_preflight_safely/);
  assert.match(script, /SAFETY_ABORTING=1/);
  assert.match(script, /champion_pid_changed_during_challenger_warmup/);
  assert.match(script, /current_generation_hash/);
  assert.match(script, /current_generation_mempool_state/);
  assert.match(script, /AB_MEMPOOL_READY_TIMEOUT_SECONDS:-60/);
  assert.match(script, /wait_current_generation_mempool_connected/);
  assert.doesNotMatch(
    script,
    /\[ "\$\(current_generation_mempool_state "\$a_log"\)" = "connected" \]/,
  );
  assert.match(script, /champion public mempool subscription is not currently connected/);
  assert.match(script, /challenger_mempool_stream_timeout/);
  assert.match(script, /challenger_unexpected_mev_share_connection/);
  assert.match(script, /champion running commit does not match checkout HEAD/);
  assert.match(script, /router_snapshot_hash/);
  assert.match(script, /validate_running_pair/);
  assert.match(script, /RuntimeMaxSec=\$\{LEASE_SECONDS\}s/);
  assert.match(script, /Restart=no/);
  assert.match(script, /extend_runtime_deadline/);
  assert.ok(
    script.indexOf("if ! extend_runtime_deadline; then") <
      script.indexOf('(state_update lease_until "$((now + LEASE_SECONDS))")'),
    "renewal must extend the hard deadline before persisting a later journal lease",
  );
  assert.match(script, /RENEW_UNSUPPORTED: systemd cannot extend the active B runtime; A\/B remain running/);
  assert.doesNotMatch(script, /safety_abort runtime_deadline_renewal_failed/);
  assert.match(script, /A\/B stop verified and champion live marker removed/);
  assert.match(script, /stop_unit_verified "\$A_UNIT"/);
  assert.match(script, /systemctl kill --kill-who=all --signal=KILL/);
  assert.match(script, /assert_no_port_owner "\$b_pid_now" challenger 8555 8556/);
  assert.match(script, /assert_no_port_owner "\$a_pid_now" champion 8566 8567/);
  assert.match(script, /assert_port_owned "\$a_pid_now" champion 8555/);
  assert.match(script, /assert_port_owned "\$a_pid_now" champion 8556/);
  assert.match(script, /assert_port_owned "\$b_pid_now" challenger 8566/);
  assert.match(script, /assert_port_owned "\$b_pid_now" challenger 8567/);
});

async function withLocations(run: (locations: InputLocations) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mev-tool-defaults-"));
  const locations: InputLocations = {
    currentLog: join(root, "var", "log", "mev-live.log"),
    currentEvents: join(root, "var", "log", "mev", "events", "searcher-live.jsonl"),
    legacyLogDir: join(root, "tmp"),
    legacyEventsDir: join(root, "analysis", "events"),
  };
  await mkdir(locations.legacyLogDir, { recursive: true });
  await mkdir(locations.legacyEventsDir, { recursive: true });
  try {
    await run(locations);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function write(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "fixture\n");
}
