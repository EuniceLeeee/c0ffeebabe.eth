import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { createConnection, createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider } from "ethers";
import {
  DEFAULT_INPUT_LOCATIONS,
  resolveInputPaths,
  type InputLocations,
} from "../cli/redact-live-run.js";
import { resolveRpcUrl } from "../util.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

test("read-only tools prefer explicit loopback RPC and otherwise use standard secret env", () => {
  assert.equal(resolveRpcUrl({ rpc: "http://127.0.0.1:8545" }, {}), "http://127.0.0.1:8545");
  assert.equal(
    resolveRpcUrl({}, { READONLY_RPC_URL: "https://readonly.example/secret", MAINNET_RPC_URL: "fallback" }),
    "https://readonly.example/secret",
  );
  assert.equal(resolveRpcUrl({}, { MAINNET_RPC_URL: "https://mainnet.example/secret" }), "https://mainnet.example/secret");
  assert.equal(resolveRpcUrl({}, {}), "");
});

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
  assert.match(script, /READONLY_RPC_URL=\$\{READONLY_RPC_URL:-\$\{RPC:-http:\/\/127\.0\.0\.1:8545\}\}/);
  assert.match(script, /export READONLY_RPC_URL/);
  assert.doesNotMatch(script, /--rpc "\$RPC"/);
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
  assert.match(script, /manual_required:" \+ \(\$ra\.reason \/\/ "route_incomplete"\)/);
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
  assert.match(
    script,
    /export POOL_UNIVERSE_HISTORY_LOG_RPC_URL="\$archive"/,
    "pool-universe deploy refresh must use the configured archive only for historical logs",
  );
  assert.match(
    script,
    /searcher fatal before startup banner/,
    "deploy must fail immediately when startup logs a fatal error",
  );
  assert.match(
    script,
    /CURRENT_PID.*NEWPID/s,
    "deploy must reject a restarted/replaced process before the startup banner",
  );
  assert.match(script, /router allowlist pinned: hash=\$ROUTER_HASH/);
  assert.match(script, /V2_LINEAGE_PINNED_PATH/);
  assert.match(script, /loadV2Lineages/);
  assert.match(script, /selected V2 lineage snapshot failed production validation/);
  assert.match(script, /V2 lineages pinned: hash=\$V2_LINEAGE_HASH/);
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
    searcher.indexOf("await validateLiveEnvelope(") < searcher.indexOf("createBundleRouter({"),
    "effective live envelope must be validated before the production router exists",
  );
});

test("A/B deploy keeps hard safety checks while six-step acceptance is independent", async () => {
  const script = await readFile(join(repoRoot, "scripts", "deploy-ab-challenger.sh"), "utf8");
  const promotion = await readFile(join(repoRoot, "analysis/src/ab-promotion-close.ts"), "utf8");
  const deployBody = script.slice(script.indexOf("deploy() {"), script.indexOf("\npause_experiment()"));
  const closeBody = script.slice(script.indexOf("close_experiment() {"), script.indexOf("\nrenew()"));
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
  assert.doesNotMatch(deployBody, /AB_REQUIRE_STAGE_ADVANCE|--require-stage-advance/);
  assert.match(script, /get\("require_stage_advance", True\)/);
  assert.match(script, /--require-stage-advance "\$require_stage_advance"/);
  assert.match(script, /replay_top_n=.*SEARCHER_POOL_UNIVERSE_TOP_N/);
  assert.match(script, /--pool-universe-top-n "\$replay_top_n"/);
  assert.match(script, /evidence_rpc=\$\(file_env_get "\$A_PROCESS_ENV" MAINNET_RPC_URL\)/);
  assert.match(script, /champion MAINNET_RPC_URL must be a private HTTPS archive endpoint/);
  assert.match(script, /EVIDENCE_PROXY_PORT=8576/);
  assert.match(script, /printf '%s' "\$evidence_rpc" \| MEV_AB_EVIDENCE_PROXY_PORT=/);
  assert.match(script, /server\.listen\(Number\(process\.env\.MEV_AB_EVIDENCE_PROXY_PORT\), "127\.0\.0\.1"\)/);
  assert.match(script, /run_six_step_acceptance_worker/);
  assert.match(script, /AB_SIX_STEP_ACCEPTANCE_TIMEOUT_SECONDS:-9000/);
  assert.match(script, /AB_SIX_STEP_ACCEPTANCE_TIMEOUT_SECONDS must be 300\.\.9000/);
  assert.doesNotMatch(script, /require_stage_advance" = "0".*acceptance_timeout" -lt 9000/s);
  assert.match(script, /six_step_acceptance_status not_run/);
  assert.match(script, /replay_top_n=\$\{replay_top_n:-20000\}/);
  assert.match(script, /new https\.Agent\(\{ keepAlive: true, maxSockets: 8 \}\)/);
  assert.match(script, /const retryableStatuses = new Set\(\[502, 503, 504\]\)/);
  assert.match(script, /const maxAttempts = 5/);
  assert.match(script, /const jsonRpcInspectionLimitBytes = 1024 \* 1024/);
  assert.match(script, /MEV_AB_EVIDENCE_REQUEST_TIMEOUT_MS \?\? "300000"/);
  assert.match(script, /const isJsonRpcRateLimit = \(body\) =>/);
  assert.match(script, /code === 429/);
  assert.match(script, /saturationMessage && \(code === -32005 \|\| !Number\.isFinite\(code\)\)/);
  assert.match(script, /const responseStatus = rateLimited \? 429 : status/);
  assert.match(script, /"content-length": String\(body\.length\)/);
  assert.match(script, /for \(const name of \["content-encoding", "content-length", "retry-after"\]\)/);
  assert.match(script, /upstreamResponse\.pipe\(response\)/);
  assert.match(script, /const absoluteTimeout = setTimeout/);
  assert.match(script, /upstreamResponse\.once\("aborted", \(\) => settleAttempt\(finishUnavailable\)\)/);
  assert.match(script, /EVIDENCE_TIMEOUT_PID=\$!/);
  assert.match(script, /EVIDENCE_PROXY_PID=\$!/);
  assert.match(script, /libc\.prctl\(1, signal\.SIGTERM/);
  assert.match(script, /os\.setsid\(\)/);
  assert.match(script, /kill -TERM -- "-\$pid"/);
  assert.match(script, /ACCEPTANCE_WORKER_PID=\$!/);
  assert.match(script, /trap cleanup_evidence_proxy EXIT/);
  assert.match(script, /trap cleanup_ab_wrapper EXIT/);
  assert.match(script, /trap 'exit 130' INT/);
  assert.match(script, /trap 'exit 143' TERM/);
  assert.match(script, /--rpc "\$acceptance_rpc"/);
  assert.match(script, /for port in 8568 8569 8570 8571 8572 8573 8574 8575 "\$EVIDENCE_PROXY_PORT"/);
  assert.doesNotMatch(script, /--rpc "\$evidence_rpc"/);
  assert.doesNotMatch(script, /SEARCHER_LIVE_RPC_URL: requiredArg\("--rpc"\).*evidence_rpc/);
  assert.doesNotMatch(script, /npm run ab-canary-gate/);
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
  assert.match(script, /ACCEPTANCE_TOOL=\$ROOT\/acceptance-tool/);
  assert.match(script, /prepare_acceptance_tooling "\$acceptance_tool_commit" "\$a_commit"/);
  assert.match(script, /analysis\/package\.json analysis\/package-lock\.json listener\/package-lock\.json/);
  assert.match(script, /"\$ACCEPTANCE_TOOL\/listener\/node_modules"/);
  assert.doesNotMatch(script, /mev-ab-gate-tool-build\.log/);
  assert.match(script, /"\$ACCEPTANCE_TOOL\/analysis" "\$EVIDENCE_PROXY_PORT"/);
  assert.doesNotMatch(script, /"\$TRUSTED_BASE\/analysis" "\$EVIDENCE_PROXY_PORT"/);
  assert.match(script, /--base-root "\$TRUSTED_BASE"/);
  assert.match(deployBody, /--phase binding/);
  assert.doesNotMatch(deployBody, /--phase (?:candidate|acceptance)/);
  assert.doesNotMatch(deployBody, /AB_SIX_STEP_ACCEPTANCE_TIMEOUT_SECONDS must be/);
  assert.doesNotMatch(deployBody, /run_six_step_acceptance_worker/);
  assert.doesNotMatch(deployBody, /prepare_trusted_base|prepare_acceptance_tooling/);
  assert.doesNotMatch(deployBody, /acceptance_tool_commit/);
  assert.doesNotMatch(closeBody, /six_step_acceptance_status|--phase acceptance|validateAbProductionCandidate/);
  assert.doesNotMatch(promotion, /six_step_acceptance_status|--phase acceptance|validateAbProductionCandidate/);
  assert.match(script, /fetch origin main "\$branch"/);
  assert.match(script, /diff --name-only "\$b_commit\.\.\$acceptance_report_commit"/);
  assert.match(script, /acceptance branch changed runtime\/non-evidence file after frozen challenger/);
  assert.ok(
    deployBody.indexOf("--phase binding") < deployBody.indexOf('systemd-run --unit="$UNIT"'),
    "fast report binding must precede challenger start",
  );
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

test("archive evidence proxy preserves JSON-RPC with one saturation retry owner", async (t) => {
  const script = await readFile(join(repoRoot, "scripts", "deploy-ab-challenger.sh"), "utf8");
  const proxySource = script.match(
    /node -e '\n([\s\S]*?)\n  ' >\/tmp\/mev-ab-evidence-proxy\.log/,
  )?.[1];
  assert.ok(proxySource, "inline archive proxy source must be extractable for behavior tests");

  const root = await mkdtemp(join(tmpdir(), "mev-archive-proxy-"));
  const keyPath = join(root, "key.pem");
  const certPath = join(root, "cert.pem");
  const certificate = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=127.0.0.1",
  ], { stdio: "ignore" });
  assert.equal(certificate.status, 0, "openssl must create the local HTTPS test certificate");

  const calls = new Map<string, number>();
  let active = 0;
  let maxActive = 0;
  let contentLengthMatched = true;
  let hungUpstreamClosed = 0;
  const upstream = createHttpsServer({
    key: await readFile(keyPath),
    cert: await readFile(certPath),
  }, async (request, response) => {
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      contentLengthMatched &&= request.headers["content-length"] === String(body.length);
      const rpc = JSON.parse(body.toString("utf8")) as { id: number; method: string };
      calls.set(rpc.method, (calls.get(rpc.method) ?? 0) + 1);

      if (rpc.method === "rate_limited") {
        const payload = calls.get(rpc.method)! < 3
          ? Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: 429 } }))
          : Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: "0x2a" }));
        response.writeHead(calls.get(rpc.method)! < 3 ? 429 : 200, {
          "content-type": "application/json",
          "content-length": String(payload.length),
          "retry-after": "0",
        });
        response.end(payload);
        return;
      }
      if (rpc.method === "always_rate_limited") {
        const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: 429 } }));
        response.writeHead(429, {
          "content-type": "application/json",
          "content-length": String(payload.length),
          "retry-after": "0",
        });
        response.end(payload);
        return;
      }
      if (rpc.method === "json_rate_limited") {
        const payload = calls.get(rpc.method)! < 3
          ? Buffer.from(JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            error: { code: -32005, message: "compute units capacity exceeded" },
          }))
          : Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: "0x2b" }));
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(payload.length),
          "retry-after": "0",
        });
        response.end(payload);
        return;
      }
      if (rpc.method === "permanent_json_limit") {
        const payload = Buffer.from(JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32005, message: "query returned more than 10000 results" },
        }));
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(payload.length),
        });
        response.end(payload);
        return;
      }
      if (rpc.method === "mixed_batch_rate_limited") {
        const payload = Buffer.from(JSON.stringify([
          { jsonrpc: "2.0", id: rpc.id, result: "0x1" },
          { jsonrpc: "2.0", id: rpc.id + 1, error: { code: -32005, message: "compute units capacity exceeded" } },
        ]));
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(payload.length),
          "retry-after": "0",
        });
        response.end(payload);
        return;
      }
      if (rpc.method === "revert") {
        const payload = Buffer.from(JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: 3, message: "execution reverted", data: "0xdeadbeef" },
        }));
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(payload.length),
        });
        response.end(payload);
        return;
      }
      if (rpc.method === "evm_capacity_revert") {
        const payload = Buffer.from(JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: 3, message: "execution reverted: capacity exceeded", data: "0xdeadbeef" },
        }));
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(payload.length),
        });
        response.end(payload);
        return;
      }
      if (rpc.method === "transport_retry" && calls.get(rpc.method)! < 3) {
        response.writeHead(503, { "content-type": "text/plain", "retry-after": "0" });
        response.end("try later");
        return;
      }
      if (rpc.method === "always_503") {
        response.writeHead(503, { "content-type": "text/plain", "retry-after": "0" });
        response.end("still unavailable");
        return;
      }
      if (rpc.method === "hang") {
        response.once("close", () => { hungUpstreamClosed++; });
        return;
      }
      if (rpc.method === "partial_abort") {
        const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: "complete" }));
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(payload.length),
        });
        response.flushHeaders();
        response.write(payload.subarray(0, 8));
        await pause(5);
        response.destroy();
        return;
      }
      if (rpc.method === "large_chunked") {
        const payload = Buffer.alloc((1024 * 1024) + 17, "x");
        response.writeHead(200, { "content-type": "application/json" });
        response.write(payload.subarray(0, 700_000));
        response.end(payload.subarray(700_000));
        return;
      }

      await pause(15);
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(body.length),
      });
      response.end(body);
    } finally {
      active--;
    }
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });

  const upstreamPort = (upstream.address() as AddressInfo).port;
  const proxyPort = await reservePort();
  const proxy = spawn(process.execPath, ["-e", proxySource], {
    env: {
      ...process.env,
      MEV_AB_EVIDENCE_PROXY_PORT: String(proxyPort),
      // Leave enough headroom for the 32-request queue when the full Node test suite runs concurrently;
      // this still exercises and bounds the deliberately hung upstream call.
      MEV_AB_EVIDENCE_REQUEST_TIMEOUT_MS: "500",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let proxyStderr = "";
  proxy.stderr.on("data", (chunk) => { proxyStderr += String(chunk); });
  proxy.stdin.end(`https://127.0.0.1:${upstreamPort}/rpc`);

  t.after(async () => {
    proxy.kill("SIGTERM");
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await waitForPort(proxyPort, () => proxyStderr);

  const request = async (id: number, method: string): Promise<Response> => {
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params: [] });
    return fetch(`http://127.0.0.1:${proxyPort}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  };
  const provider = new JsonRpcProvider(
    `http://127.0.0.1:${proxyPort}`,
    1,
    { staticNetwork: true, batchMaxCount: 1 },
  );
  t.after(() => provider.destroy());

  const concurrentBodies = Array.from({ length: 32 }, (_, index) =>
    JSON.stringify({ jsonrpc: "2.0", id: index + 1, method: `echo_${index}`, params: [] }));
  const concurrentResponses = await Promise.all(concurrentBodies.map((body) =>
    fetch(`http://127.0.0.1:${proxyPort}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }).then(async (response) => ({ status: response.status, body: await response.text() }))));
  assert.deepEqual(concurrentResponses, concurrentBodies.map((body) => ({ status: 200, body })));
  assert.ok(maxActive <= 8, `archive upstream concurrency must stay <=8, observed ${maxActive}`);
  assert.equal(contentLengthMatched, true);

  assert.equal(await provider.send("rate_limited", []), "0x2a");
  assert.equal(calls.get("rate_limited"), 3);

  const persistentlyLimited = await request(109, "always_rate_limited");
  assert.equal(persistentlyLimited.status, 429);
  assert.equal(persistentlyLimited.headers.get("retry-after"), "0");
  assert.equal(
    await persistentlyLimited.text(),
    JSON.stringify({ jsonrpc: "2.0", id: 109, error: { code: 429 } }),
  );
  assert.equal(calls.get("always_rate_limited"), 1, "the proxy must not multiply the ethers 429 budget");

  assert.equal(await provider.send("json_rate_limited", []), "0x2b");
  assert.equal(calls.get("json_rate_limited"), 3);

  const mixedBatchBody = JSON.stringify([
    { jsonrpc: "2.0", id: 110, result: "0x1" },
    { jsonrpc: "2.0", id: 111, error: { code: -32005, message: "compute units capacity exceeded" } },
  ]);
  const mixedBatch = await request(110, "mixed_batch_rate_limited");
  assert.equal(mixedBatch.status, 429);
  assert.equal(await mixedBatch.text(), mixedBatchBody);
  assert.equal(calls.get("mixed_batch_rate_limited"), 1);

  const permanentLimit = await request(114, "permanent_json_limit");
  assert.equal(permanentLimit.status, 200);
  assert.equal(await permanentLimit.text(), JSON.stringify({
    jsonrpc: "2.0",
    id: 114,
    error: { code: -32005, message: "query returned more than 10000 results" },
  }));
  assert.equal(calls.get("permanent_json_limit"), 1);

  const reverted = await request(102, "revert");
  assert.equal(reverted.status, 200);
  assert.equal(await reverted.text(), JSON.stringify({
    jsonrpc: "2.0",
    id: 102,
    error: { code: 3, message: "execution reverted", data: "0xdeadbeef" },
  }));

  const capacityRevert = await request(112, "evm_capacity_revert");
  assert.equal(capacityRevert.status, 200);
  assert.equal(await capacityRevert.text(), JSON.stringify({
    jsonrpc: "2.0",
    id: 112,
    error: { code: 3, message: "execution reverted: capacity exceeded", data: "0xdeadbeef" },
  }));
  assert.equal(calls.get("evm_capacity_revert"), 1);

  const retried = await request(103, "transport_retry");
  assert.equal(retried.status, 200);
  assert.equal(JSON.parse(await retried.text()).id, 103);
  assert.equal(calls.get("transport_retry"), 3);

  const unavailable = await request(106, "always_503");
  assert.equal(unavailable.status, 503);
  assert.equal(await unavailable.text(), "still unavailable");
  assert.equal(calls.get("always_503"), 5, "transport retries must be finite and exact");

  const timedOut = await request(104, "hang");
  assert.equal(timedOut.status, 502);
  assert.equal(await timedOut.text(), "archive rpc unavailable");
  await pause(10);
  assert.equal(hungUpstreamClosed, 1, "a timed-out proxy call must close its upstream request");

  const partial = await request(107, "partial_abort");
  assert.equal(partial.status, 502);
  assert.equal(await partial.text(), "archive rpc unavailable");
  const large = await request(113, "large_chunked");
  assert.equal(large.status, 200);
  const largeBody = Buffer.from(await large.arrayBuffer());
  assert.equal(largeBody.length, (1024 * 1024) + 17);
  assert.equal(largeBody.equals(Buffer.alloc((1024 * 1024) + 17, "x")), true);
  assert.equal(calls.get("large_chunked"), 1);
  const afterTimeout = await request(105, "after_timeout");
  assert.equal(afterTimeout.status, 200);
  assert.equal(JSON.parse(await afterTimeout.text()).id, 105);
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

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

async function waitForPort(port: number, stderr: () => string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    await pause(20);
  }
  throw new Error(`archive proxy did not listen: ${stderr()}`);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
