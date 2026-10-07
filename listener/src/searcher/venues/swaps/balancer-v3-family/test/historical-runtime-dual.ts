// Opt-in, Family-local single-leg evidence. Not a Ready writer, full-route sim,
// original-TX replay, latency benchmark, or adapter/production acceptance gate.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { concatBytes } from "../../../../../encoder.js";
import type { ResolvedPlanNode } from "../../../../../types.js";
import { AnvilStateBackend } from "../../../../../shared/state/state-backend.js";
import { buildExecuteCalldata, loadBotVmRuntimeCode } from "../../../../../shared/executor/botvm-executor.js";
import { parseAtBlockJson } from "../../../../blockscan-at-block-cli.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { resolveStrictReadyRuntime } from "../../../../strict-ready-runtime.js";
import { UniverseRebuildCheckpointStore, activeReadyMemos } from "../../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring, familyDefinitionHash, familyMemoDefinitionHash } from "../../../../universe-rebuild-production.js";
import { balanceStorageKey, resolveErc20BalanceSlot } from "../../../../solver/balance-slots.js";
import { familyId } from "../../../adapter-family-identifiers.js";
import type { CanonicalSource } from "../../../adapter-request-program.js";
import { assertIssuedPreparedFamilyInstance, buildFamilyExecutionFragment, buildFamilyRuntimeAmountLeg,
  executeFamilyExactQuote, type PreparedFamilyInstance } from "../../../adapter-family-runtime.js";
import { asPricedFamily } from "../../../family-capability-catalog.js";
import { blockScanEdgeKey } from "../../../blockscan-state-capability.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../../../production-infra-actions.js";
import { lower, same, PERMIT2, ROUTER, VAULT, MAX_INPUT, ROUTER_ABI, hasSwapHooks } from "../codec.js";
import type { BalancerV3Descriptor } from "../types.js";

const ROOT = fileURLToPath(new URL("../../../../../../../", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const OWNER = "0x1000000000000000000000000000000000000001";
const EXECUTOR = "0x1000000000000000000000000000000000000002";
const ERC20 = new ethers.Interface(["function balanceOf(address) view returns(uint256)",
  "function allowance(address,address) view returns(uint256)"]);
const ALLOWANCE = new ethers.Interface(["function allowance(address,address,address) view returns(uint160,uint48,uint48)"]);
type Overrides = Record<string, { code?: string; balance?: string; stateDiff?: Record<string, string> }>;
type Rpc = (method: string, params: unknown[]) => Promise<any>;
const json = (value: unknown) => JSON.stringify(value, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const word = (value: string | bigint) => ethers.toBeHex(BigInt(value), 32).toLowerCase();
const git = (...args: string[]) => execFileSync("git", ["-c", `safe.directory=${ROOT.replace(/\/$/, "")}`, ...args],
  { cwd: ROOT, encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

// Hash the actual working source, including uncommitted/untracked source, not
// just HEAD. Tests/reports may be committed independently without changing it.
function sourcePin() {
  const files = git("ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "listener/src", "src")
    .split("\0").filter(p => /\.(ts|sol)$/.test(p) && !p.includes("/test/")).sort();
  return { sourceSha256: sha(files.map(p => `${p}\0${sha(readFileSync(resolve(ROOT, p)))}`).join("\n")),
    fileCount: files.length, testSha256: sha(readFileSync(SELF)),
    artifactSha256: sha(readFileSync(resolve(ROOT, "out/BotVM.sol/BotVM.json"))),
    familyDefinitionHash: familyDefinitionHash("balancer-v3"), familyMemoDefinitionHash: familyMemoDefinitionHash("balancer-v3") };
}

function options(argv: string[]) {
  const names = ["--ready", "--prices", "--pool", "--rpc-file", "--out", "--port"];
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    assert(names.includes(argv[i]) && !values.has(argv[i]), "unknown/duplicate option");
    assert(argv[i + 1] && !argv[i + 1].startsWith("--"), "missing option value");
    values.set(argv[i], argv[i + 1]);
  }
  assert.equal(values.size, names.length, "required: --ready --prices --pool --rpc-file --out --port");
  assert.equal(values.get("--port"), "8591", "this narrow test owns only loopback port 8591");
  const out = resolve(values.get("--out")!);
  const parent = realpathSync(dirname(out)), logs = realpathSync(resolve(ROOT, "logs"));
  assert(parent === logs || parent.startsWith(logs + sep), "output parent must already exist under this repo's logs/");
  assert(!existsSync(out), "output exists; choose a new receipt path (never overwrite failures)");
  assert.equal(git("check-ignore", "--", out).trim(), out, "output must be gitignored");
  return { ready: realpathSync(values.get("--ready")!), prices: realpathSync(values.get("--prices")!),
    rpcFile: realpathSync(values.get("--rpc-file")!), pool: lower(ethers.getAddress(
      values.get("--pool")!.startsWith("0x") ? values.get("--pool")! : `0x${values.get("--pool")!}`)), out };
}

function currentBotVm() {
  const artifact = JSON.parse(readFileSync(resolve(ROOT, "out/BotVM.sol/BotVM.json"), "utf8"));
  const metadata = typeof artifact.metadata === "string" ? JSON.parse(artifact.metadata) : artifact.metadata;
  assert.equal(metadata?.settings?.compilationTarget?.["src/BotVM.sol"], "BotVM");
  assert(Object.keys(metadata.sources).length > 0, "artifact lacks source hashes");
  for (const [name, entry] of Object.entries(metadata.sources) as [string, { keccak256: string }][]) {
    const path = resolve(ROOT, name);
    assert(!relative(ROOT, path).startsWith(".."), "artifact source outside repo");
    assert.equal(ethers.keccak256(readFileSync(path)), entry.keccak256, `stale BotVM artifact: ${name}`);
  }
  const groups = Object.values(artifact.deployedBytecode.immutableReferences) as { start: number; length: number }[][];
  assert.equal(groups.length, 1, "only BotVM.owner may be patched");
  assert(groups[0].length > 0 && groups[0].every(ref => ref.length === 32));
  return loadBotVmRuntimeCode(OWNER);
}

// diffMode omits unchanged slots from BOTH sides. Absence is zero only when
// the other side proves this exact slot was created/deleted.
function storage(diff: any, side: "pre" | "post", address: string): Record<string, string> {
  const account = Object.entries(diff[side]).find(([key]) => same(key, address))?.[1] as any;
  return Object.fromEntries(Object.entries(account?.storage ?? {}).map(([key, value]) => [word(key), word(String(value))]));
}
function observed(diff: any, address: string, slot: string, initial: bigint) {
  const pre = storage(diff, "pre", address), post = storage(diff, "post", address);
  const before = slot in pre ? BigInt(pre[slot]) : slot in post ? 0n : initial;
  const after = slot in post ? BigInt(post[slot]) : slot in pre ? 0n : initial;
  assert.equal(before, initial, "trace prestate disagrees with independently read balance");
  assert(slot in pre || slot in post, "actor balance did not change in prestate trace");
  return { before, after, delta: after - before };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = options(argv);
  // Reserve before any fork; write once in finally, including failed attempts.
  const fd = openSync(args.out, "wx", 0o600);
  const report: Record<string, any> = { schemaVersion: 1, result: "failed", pool: args.pool,
    claim: "Family-local single-leg quote/old-fragment/runtime-program parity at N; NOT full-route sim, original-TX replay, latency or merge acceptance",
    actor: { executor: EXECUTOR, owner: OWNER }, samples: [], errors: [],
    safety: { broadcast: false, signing: false, remoteSubmission: false, minedBlocks: 0,
      executionOverrides: "test actor code/native gas and actor ERC20 balances only; no pool/Vault/hook overrides" } };
  let backend: AnvilStateBackend | undefined, secret = "", stage = "offline-inputs";
  const abort = new AbortController(), deadline = Date.now() + 240_000;
  const timer = setTimeout(() => abort.abort(new Error("test wall budget exceeded")), 240_000);
  const interrupt = () => abort.abort(new Error("test interrupted"));
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const redact = (value: unknown) => String(value).split(secret || "\0").join("[REDACTED]")
    .replace(/https?:\/\/[^\s\"'<>]+/gi, "[REDACTED_URL]").slice(0, 4000);
  const failure = (error: unknown) => ({ stage, message: redact(error instanceof Error ? error.message : error) });
  let calls = 0, constructing = false, constructionAttempts = 0;
  try {
    const startPin = sourcePin(); report.code = { headAtStart: git("rev-parse", "HEAD").trim(), ...startPin };
    const readyBytes = readFileSync(args.ready), priceBytes = readFileSync(args.prices);
    const saved = parseAtBlockJson(priceBytes.toString());
    assert.equal(saved.readySha256, sha(readyBytes), "prices are not from this immutable Ready");
    assert.equal(realpathSync(saved.readyPath), args.ready);
    const envelope = await new UniverseRebuildCheckpointStore({ path: args.ready }).load();
    assert(envelope && !envelope.inProgressRun, "completed Ready required; no rebuild/revalidation here");
    const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration);
    assert.equal(ready.universeRange.fromBlock, ready.cutoff.number, "single-block Ready required");
    const source: CanonicalSource = ready.cutoff, pin = { blockHash: source.hash, requireCanonical: true };
    const sameBlock = (number: number, hash: string) => {
      assert.equal(number, source.number); assert.equal(hash.toLowerCase(), source.hash.toLowerCase());
    };
    sameBlock(saved.header.number, saved.header.hash);
    sameBlock(saved.runtime.sourceBlock, saved.runtime.sourceBlockHash);
    sameBlock(saved.runtime.pricing.sourceBlock, saved.runtime.pricing.sourceBlockHash);
    const family = asPricedFamily(catalog.forStrictFamily(familyId("balancer-v3")));
    const memos = activeReadyMemos(envelope).filter(m => m.familyId === "balancer-v3" && same(m.instanceKey, args.pool));
    assert.equal(memos.length, 1, "exactly one active admitted pool memo required");
    const memo = memos[0];
    assert([startPin.familyDefinitionHash, startPin.familyMemoDefinitionHash].includes(memo.familyDefinitionHash),
      "stale Family fingerprint: use existing selective revalidation, not this test");
    const loopback = "http://127.0.0.1:8591";
    const wiring = createRebuildWiring({ rpcUrl: loopback, familyIds: ["balancer-v3"],
      executionIdentity: { executor: EXECUTOR, transactionOrigin: OWNER } });
    const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: source }) as PreparedFamilyInstance;
    assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
    const descriptor = instance.descriptor as BalancerV3Descriptor;
    assert(same(descriptor.pool, args.pool));
    assert.equal(descriptor.binding.tokens.length, 2, "narrow two-token test, not a multi-pool harness");
    const edges = graph.filter(e => e.instanceKey === instance.instanceKey && same(e.target, args.pool));
    assert.equal(edges.length, 2, "both directions must already be in production Ready graph");
    const rows = edges.map(edge => {
      const key = blockScanEdgeKey(edge), row = saved.runtime.pricing.effectiveMids.rows.get(key);
      assert(saved.runtime.graph.edges.some((e: any) => blockScanEdgeKey(e) === key), "price graph lacks Ready edge");
      assert(row && row.edgeId === key && row.status === "quoted", "actual quoted production price row required");
      assert(same(row.tokenIn, edge.tokenIn) && same(row.tokenOut, edge.tokenOut));
      assert(typeof row.amountIn === "bigint" && row.amountIn > 0n && row.amountIn * 10n <= MAX_INPUT);
      assert(typeof row.amountOut === "bigint" && row.amountOut > 0n);
      sameBlock(row.quotedAt.number, row.quotedAt.hash);
      assert.equal(row.quotedAt.generation, saved.runtime.generation);
      const routes = instance.routes.filter(r => same(r.tokenIn, row.tokenIn) && same(r.tokenOut, row.tokenOut));
      assert.equal(routes.length, 1);
      const handles = instance.routeHandles.filter(h => h.routeKey === routes[0].routeKey);
      assert.equal(handles.length, 1);
      return { row, route: handles[0] };
    });
    assert(same(rows[0].row.tokenIn, rows[1].row.tokenOut) && same(rows[0].row.tokenOut, rows[1].row.tokenIn));
    const botvm = currentBotVm();
    report.inputs = { ready: args.ready, prices: args.prices, readySha256: sha(readyBytes), pricesSha256: sha(priceBytes),
      source, priceGeneration: saved.runtime.generation, timestamp: saved.header.timestamp,
      memoFingerprint: memo.memoFingerprint, familyDefinitionHash: memo.familyDefinitionHash,
      hooks: descriptor.binding.hooks, hasSwapHooks: hasSwapHooks(descriptor.binding.hooks),
      localModel: descriptor.binding.localModel ?? null, runtimeCodeHash: botvm.keccak256 };
    const privateConfig = JSON.parse(readFileSync(args.rpcFile, "utf8"));
    assert(typeof privateConfig.MAINNET_RPC_URL === "string", "rpc-file requires MAINNET_RPC_URL");
    secret = privateConfig.MAINNET_RPC_URL;
    assert(["http:", "https:"].includes(new URL(secret).protocol), "HTTP archive RPC required");
    const allowed = new Set(["web3_clientVersion", "eth_chainId", "eth_getBlockByNumber", "eth_call",
      "eth_getCode", "eth_getStorageAt", "eth_createAccessList", "debug_traceCall"]);
    const rpc: Rpc = async (method, params) => {
      if (constructing) { constructionAttempts++; throw new Error("RPC during runtime construction"); }
      assert(allowed.has(method), "non-read-only method blocked");
      abort.signal.throwIfAborted(); assert(Date.now() < deadline && ++calls <= 240, "test read budget exceeded");
      const response = await fetch(loopback, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: calls, method, params }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) });
      assert(response.ok, `${method}: loopback HTTP ${response.status}`);
      const body = await response.json() as any;
      if (body.error) throw new Error(`${method}: ${body.error.code} ${redact(body.error.message)}`);
      assert(Object.hasOwn(body, "result"), `${method}: missing result`);
      return body.result;
    };
    const headerCheck = async () => {
      const h = await rpc("eth_getBlockByNumber", ["latest", false]);
      sameBlock(Number(BigInt(h.number)), h.hash);
      assert.equal(Number(BigInt(h.timestamp)), saved.header.timestamp, "N timestamp changed");
      assert.equal(BigInt(h.baseFeePerGas), BigInt(saved.header.baseFeePerGas));
      return { number: source.number, hash: h.hash, timestamp: Number(BigInt(h.timestamp)), baseFeePerGas: h.baseFeePerGas };
    };
    stage = "owned-fork-start";
    backend = new AnvilStateBackend(secret, loopback, 8591);
    await backend.forkAt(source.number, { signal: abort.signal, deadlineAtMs: deadline });
    report.client = await rpc("web3_clientVersion", []); assert(/anvil/i.test(report.client));
    assert.equal(BigInt(await rpc("eth_chainId", [])), 1n);
    report.headerBefore = await headerCheck();
    const call = (to: string, data: string, overrides: Overrides = {}) => rpc("eth_call", [{ to, data, from: OWNER }, pin, overrides]);
    const balance = async (token: string, holder: string, overrides: Overrides = {}) =>
      BigInt(await call(token, ERC20.encodeFunctionData("balanceOf", [holder]), overrides));
    stage = "actor-balance-mapping";
    for (const actor of [OWNER, EXECUTOR]) assert.equal(await rpc("eth_getCode", [actor, pin]), "0x", "actor already has source code");
    const slots = new Map<string, string>();
    report.balanceMappings = [];
    for (const token of descriptor.binding.tokens) {
      assert(![OWNER, EXECUTOR, VAULT, ROUTER, PERMIT2, args.pool, descriptor.binding.hooks.address].some(a => same(a, token)),
        "actor/token/protocol addresses must not alias");
      assert.equal(await balance(token, EXECUTOR), 0n, "actor already has source inventory");
      const vaultBalance = await balance(token, VAULT); assert(vaultBalance > 0n);
      const index = await resolveErc20BalanceSlot(token, VAULT, { balanceOf: balance,
        getStorage: async (t, key) => BigInt(await rpc("eth_getStorageAt", [t, key, pin])) });
      assert(index !== null, "production balance-slot probe unresolved; do not guess layout");
      const key = balanceStorageKey(EXECUTOR, index).toLowerCase();
      for (const probe of [717171717171n, 919191919193n]) {
        const override = { [lower(token)]: { stateDiff: { [key]: word(probe) } } };
        assert.equal(await balance(token, EXECUTOR, override), probe, "actor balance mapping not independently verified");
        assert.equal(await balance(token, VAULT, override), vaultBalance, "actor override changed Vault balance");
      }
      slots.set(lower(token), key); report.balanceMappings.push({ token, slotIndex: index, actorStorageKey: key, verifiedProbes: 2 });
    }
    const adapters = [...family.plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
    const compile = (node: ResolvedPlanNode): Uint8Array => {
      const adapter = adapters.find(a => a.id === node.adapterId); assert(adapter, "missing production action encoder");
      return adapter.encode(node, EXECUTOR, concatBytes(...node.children.map(compile)));
    };
    for (const { row, route } of rows) {
      let overrides: Overrides = {};
      const queryCalls: any[] = [];
      const runtime = createStrictCentralAdapterRuntime({ executor: EXECUTOR, transactionOrigin: OWNER,
        generationFence: { assertCurrent(generation, requested) {
          assert.equal(generation, source.generation); assert.deepEqual(requested, source);
        } }, provider: {
          async call(tx, block) {
            assert.equal(block, source.number, "quote must request N");
            if (same(tx.to, ROUTER)) {
              const decoded = ROUTER_ABI.parseTransaction({ data: tx.data });
              assert(decoded?.name === "querySwapSingleTokenExactIn");
              assert(same(String(decoded.args[0]), args.pool) && same(String(decoded.args[4]), EXECUTOR));
              // Router query receives the simulated sender as an ABI argument.
              // Preserve the production eth_call envelope; do not inject from.
              assert.equal(tx.from, undefined, "production query leaves outer from unset");
              queryCalls.push({ from: tx.from ?? null, sender: String(decoded.args[4]), amountIn: String(decoded.args[3]) });
            }
            return rpc("eth_call", [{ ...tx, gas: "0x800000" }, pin, overrides]);
          },
          async getCode(address, block) { assert.equal(block, source.number); return rpc("eth_getCode", [address, pin]); },
          async getStorage(address, key, block) { assert.equal(block, source.number); return rpc("eth_getStorageAt", [address, key, pin]); },
        } });
      stage = "runtime-construction";
      const beforeCalls = calls;
      constructing = true;
      let leg: ReturnType<typeof buildFamilyRuntimeAmountLeg>;
      try {
        // Deliberately before Exact and before selecting P/10P. These forbidden
        // getters also detect accidental future coupling at the central API.
        const input = { family, route, source, runtime, executor: EXECUTOR, runtimeEvidence: [], actionOwnership: catalog };
        Object.defineProperties(input, { amountIn: { get() { throw new Error("runtime builder accessed amountIn"); } },
          exact: { get() { throw new Error("runtime builder accessed Exact"); } } });
        leg = buildFamilyRuntimeAmountLeg(input);
      } finally { constructing = false; }
      assert(leg, "Family returned null runtime leg");
      assert.equal(calls - beforeCalls, 0); assert.equal(constructionAttempts, 0);
      for (const multiplier of [1n, 10n]) {
        const amountIn = row.amountIn * multiplier, inputSentinel = 101n, outputSentinel = 103n;
        const tokenIn = lower(row.tokenIn), tokenOut = lower(row.tokenOut);
        const inSlot = slots.get(tokenIn)!, outSlot = slots.get(tokenOut)!;
        overrides = { [OWNER]: { balance: ethers.toQuantity(100n * 10n ** 18n) }, [EXECUTOR]: { code: botvm.code },
          [tokenIn]: { stateDiff: { [inSlot]: word(amountIn + inputSentinel) } },
          [tokenOut]: { stateDiff: { [outSlot]: word(outputSentinel) } } };
        const sample: Record<string, any> = { edgeId: row.edgeId, routeKey: route.routeKey, tokenIn, tokenOut,
          multiplier, amountIn, productionP: row.amountIn, savedPriceOut: row.amountOut,
          runtimeConstructionRpc: 0, programHash: ethers.keccak256(leg.program), status: "failed", executions: [] };
        report.samples.push(sample);
        try {
          stage = "production-exact";
          const queryStart = queryCalls.length;
          const quote = await executeFamilyExactQuote({ family, route, amountIn, source, generation: source.generation,
            executor: EXECUTOR, runtimeEvidence: [], runtime, requireChainAmountQuote: true });
          sample.quote = { status: quote.status, outcome: quote.outcome, queryCalls: queryCalls.slice(queryStart) };
          assert.equal(quote.status, "resolved", "production Exact unresolved");
          if (quote.status !== "resolved") throw new Error("production Exact unresolved");
          assert(quote.amountOut > 0n); sample.quote.amountOut = quote.amountOut;
          assert(queryCalls.length > queryStart, "chain Exact must actually query this sample amount");
          if (multiplier === 1n) assert.equal(quote.amountOut, row.amountOut, "fresh P quote differs from saved production price");
          const fragment = buildFamilyExecutionFragment({ family, route, exact: quote, minAmountOut: quote.amountOut,
            executor: EXECUTOR, runtimeEvidence: [], actionOwnership: catalog });
          assert.equal(fragment.status, "resolved");
          if (fragment.status !== "resolved") throw new Error("production fragment unresolved");
          assert.equal(fragment.fragment.requirements.length, 0, "unfulfilled fragment requirements");
          const scripts = [ ["old-fragment", concatBytes(...fragment.fragment.nodes.map(compile))],
            ["runtime-program", runtimeProgramScript(ethers.getBytes(leg.program), amountIn)] ] as const;
          const allowanceCalls = [{ to: tokenIn, data: ERC20.encodeFunctionData("allowance", [EXECUTOR, PERMIT2]), size: 1 },
            { to: lower(PERMIT2), data: ALLOWANCE.encodeFunctionData("allowance", [EXECUTOR, tokenIn, ROUTER]), size: 3 }];
          const readAllowances = async (state: Overrides) => {
            const result: bigint[][] = [];
            for (const check of allowanceCalls) {
              const bytes = await call(check.to, check.data, state);
              assert(ethers.isHexString(bytes, 32 * check.size));
              result.push(Array.from({ length: check.size }, (_, i) => BigInt(`0x${bytes.slice(2 + i * 64, 66 + i * 64)}`)));
            }
            return result;
          };
          assert.deepEqual(await readAllowances(overrides), [[0n], [0n, 0n, 0n]], "test actor has standing source allowances");
          // Discover ONLY allowance getter read slots. Poststate observation
          // overlays below contain trace-derived values for these slots and the
          // actor's two balance slots, never protocol liquidity/hook state.
          const allowanceSlots = new Map<string, Set<string>>();
          for (const check of allowanceCalls) {
            const access = await rpc("eth_createAccessList", [{ from: OWNER, to: check.to, data: check.data, gas: "0x100000" },
              ethers.toQuantity(source.number)]);
            assert(!access.error && Array.isArray(access.accessList), "allowance access list unavailable");
            const keys = access.accessList.filter((a: any) => same(a.address, check.to)).flatMap((a: any) => a.storageKeys);
            assert(keys.length > 0, "allowance getter read no storage");
            allowanceSlots.set(check.to, new Set(keys.map((key: string) => word(key))));
          }
          for (const [encoding, script] of scripts) {
            stage = encoding;
            const result: Record<string, any> = { encoding, status: "failed", scriptHash: ethers.keccak256(script) };
            sample.executions.push(result);
            try {
              assert.equal(await balance(tokenIn, EXECUTOR, overrides), amountIn + inputSentinel);
              assert.equal(await balance(tokenOut, EXECUTOR, overrides), outputSentinel);
              const tx = { from: OWNER, to: EXECUTOR, data: buildExecuteCalldata(script), gas: "0x800000",
                gasPrice: ethers.toQuantity(saved.header.baseFeePerGas) };
              result.callTrace = await rpc("debug_traceCall", [tx, pin, { tracer: "callTracer", timeout: "30s", stateOverrides: overrides }]);
              assert(!result.callTrace.error, "encoded BotVM execution reverted");
              result.stateDiff = await rpc("debug_traceCall", [tx, pin,
                { tracer: "prestateTracer", tracerConfig: { diffMode: true }, timeout: "30s", stateOverrides: overrides }]);
              const diff = result.stateDiff; assert(diff?.pre && diff?.post, "independent prestate diff unavailable");
              const input = observed(diff, tokenIn, inSlot, amountIn + inputSentinel);
              const output = observed(diff, tokenOut, outSlot, outputSentinel);
              result.balances = { input, output }; // Save mismatch evidence before asserting.
              assert.equal(input.delta, -amountIn); assert.equal(output.delta, quote.amountOut);
              assert.equal(input.after, inputSentinel); assert.equal(output.after, outputSentinel + quote.amountOut);
              const post: Overrides = structuredClone(overrides);
              for (const [token, keys] of allowanceSlots) {
                const preStorage = storage(diff, "pre", token), postStorage = storage(diff, "post", token);
                const changes = post[token] ??= {}; changes.stateDiff ??= {};
                for (const key of keys) {
                  if (key in postStorage) changes.stateDiff[key] = postStorage[key];
                  else if (key in preStorage) changes.stateDiff[key] = word(0n);
                }
              }
              post[tokenIn].stateDiff![inSlot] = word(input.after);
              post[tokenOut].stateDiff![outSlot] = word(output.after);
              assert.equal(await balance(tokenIn, EXECUTOR, post), input.after);
              assert.equal(await balance(tokenOut, EXECUTOR, post), output.after);
              result.finalAllowances = await readAllowances(post);
              // Permit2 approve(..., amount=0, expiration=0) stores the current
              // block timestamp as expiration; it leaves the nonce unchanged.
              // Revocation is zero spendable amount, not an all-zero packed slot.
              assert.deepEqual(result.finalAllowances, [[0n], [0n, BigInt(saved.header.timestamp), 0n]],
                "ERC20/Permit2 spendable allowance or cleanup metadata mismatch");
              result.oldInventoryConsumed = 0n; result.status = "pass";
            } catch (error) { result.error = failure(error); }
          }
          assert(sample.executions.length === 2 && sample.executions.every((e: any) => e.status === "pass"));
          sample.status = "pass";
        } catch (error) { sample.error = failure(error); }
        abort.signal.throwIfAborted();
      }
    }
    stage = "final-pins";
    report.headerAfter = await headerCheck();
    for (const token of descriptor.binding.tokens) assert.equal(await balance(token, EXECUTOR), 0n, "trace persisted state");
    assert.equal(await rpc("eth_getCode", [EXECUTOR, pin]), "0x", "actor code override persisted");
    assert.equal(sha(readFileSync(args.ready)), report.inputs.readySha256);
    assert.equal(sha(readFileSync(args.prices)), report.inputs.pricesSha256);
    assert.deepEqual(sourcePin(), startPin, "source/code changed during test");
    assert.equal(constructionAttempts, 0);
    assert(report.samples.length === 4 && report.samples.every((s: any) => s.status === "pass"), "one or more samples failed; retained in receipt");
    report.result = "pass";
  } catch (error) { report.errors.push(failure(error)); }
  finally {
    stage = "owned-fork-cleanup";
    try { if (backend) await backend.stopAndWait(); report.forkStopped = true; }
    catch (error) { report.errors.push(failure(error)); report.result = "failed"; }
    finally { backend?.provider.destroy(); }
    clearTimeout(timer); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    report.rpcCalls = calls; report.runtimeConstructionRpcAttempts = constructionAttempts;
    // Never serialize private configuration, upstream URL, or provider errors.
    const output = json(report).split(secret || "\0").join("[REDACTED]")
      .replace(/https?:\/\/[^\s\"<>]+/gi, "[REDACTED_URL]") + "\n";
    try { writeFileSync(fd, output); fsyncSync(fd); } finally { closeSync(fd); }
  }
  console.log(json({ result: report.result, samples: report.samples.length,
    executionsPassed: report.samples.flatMap((s: any) => s.executions).filter((e: any) => e.status === "pass").length,
    out: args.out, forkStopped: report.forkStopped }));
  if (report.result !== "pass") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).includes("--help")) console.log("--ready FILE --prices FILE --pool ADDRESS --rpc-file FILE --out NEW_IGNORED_JSON --port 8591");
  else main().catch(() => { console.error("historical-runtime-dual: input/output setup failed; no RPC started if no receipt was reserved"); process.exitCode = 1; });
}
