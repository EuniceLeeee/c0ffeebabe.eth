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
import { decodeSwapLog } from "../discovery.js";
import { productionAmount, splicedProductionAmount, assertPriceInput } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
import { sourcePin as productionSourcePin } from "../../../../test/family-integration/kyber-yb-compound/historical-dual.js";
import { proveActorBalanceSlot } from "./balance-slot-proof.js";
import { supportsLocalPricing } from "../local-state.js";

const ROOT = fileURLToPath(new URL("../../../../../../../", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const OWNER = "0x1000000000000000000000000000000000000001";
const EXECUTOR = "0x1000000000000000000000000000000000000002";
const ERC20 = new ethers.Interface(["function balanceOf(address) view returns(uint256)",
  "function allowance(address,address) view returns(uint256)"]);
const ALLOWANCE = new ethers.Interface(["function allowance(address,address,address) view returns(uint160,uint48,uint48)"]);
type Overrides = Record<string, { code?: string; balance?: string; stateDiff?: Record<string, string> }>;
type Rpc = (method: string, params: unknown[]) => Promise<any>;
export function assertOriginalReceipt(receipt: { blockNumber: string; blockHash: string; status: string }, source: CanonicalSource): void {
  assert(ethers.isHexString(receipt.blockHash, 32) && ethers.isHexString(source.hash, 32));
  assert.equal(Number(BigInt(receipt.blockNumber)), source.number);
  assert.equal(receipt.blockHash.toLowerCase(), source.hash.toLowerCase());
  assert.equal(BigInt(receipt.status), 1n);
}
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
    sourceTreeSha256: productionSourcePin().sourceTreeSha256,
    fileCount: files.length, testSha256: sha(readFileSync(SELF)),
    artifactSha256: sha(readFileSync(resolve(ROOT, "out/BotVM.sol/BotVM.json"))),
    familyDefinitionHash: familyDefinitionHash("balancer-v3"), familyMemoDefinitionHash: familyMemoDefinitionHash("balancer-v3") };
}

function options(argv: string[]) {
  const required = ["--ready", "--prices", "--pool", "--rpc-file", "--out", "--port"];
  const names = [...required, "--receipt", "--reference-prices", "--reference-edges"];
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    assert(names.includes(argv[i]) && !values.has(argv[i]), "unknown/duplicate option");
    assert(argv[i + 1] && !argv[i + 1].startsWith("--"), "missing option value");
    values.set(argv[i], argv[i + 1]);
  }
  assert(required.every(key => values.has(key)), "required: --ready --prices --pool --rpc-file --out --port");
  assert.equal(values.has("--reference-prices"), values.has("--reference-edges"));
  const referenceEdges = values.has("--reference-edges") ? JSON.parse(values.get("--reference-edges")!) : [];
  assert(Array.isArray(referenceEdges) && referenceEdges.every(key => typeof key === "string" && key.length > 0));
  assert.equal(new Set(referenceEdges).size, referenceEdges.length);
  if (values.has("--reference-prices")) assert(referenceEdges.length > 0);
  assert.equal(values.get("--port"), "8591", "this narrow test owns only loopback port 8591");
  const out = resolve(values.get("--out")!);
  const parent = realpathSync(dirname(out)), logs = realpathSync(resolve(ROOT, "logs"));
  assert(parent === logs || parent.startsWith(logs + sep), "output parent must already exist under this repo's logs/");
  assert(!existsSync(out), "output exists; choose a new receipt path (never overwrite failures)");
  assert.equal(git("check-ignore", "--", out).trim(), out, "output must be gitignored");
  return { ready: realpathSync(values.get("--ready")!), prices: realpathSync(values.get("--prices")!),
    rpcFile: realpathSync(values.get("--rpc-file")!), receipt: values.has("--receipt") ? realpathSync(values.get("--receipt")!) : undefined,
    referencePrices: values.has("--reference-prices") ? realpathSync(values.get("--reference-prices")!) : undefined,
    referenceEdges: referenceEdges as string[], pool: lower(ethers.getAddress(
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
    actor: { executor: EXECUTOR, owner: OWNER }, samples: [], errors: [], unmeasuredDirections: [], referenceGaps: [],
    safety: { broadcast: false, signing: false, remoteSubmission: false, minedBlocks: 0,
      executionOverrides: "test actor code/native gas and actor ERC20 balances only; no pool/Vault/hook overrides" } };
  let backend: AnvilStateBackend | undefined, secret = "", stage = "offline-inputs";
  const abort = new AbortController(), deadline = Date.now() + 480_000;
  const timer = setTimeout(() => abort.abort(new Error("test wall budget exceeded")), 480_000);
  const interrupt = () => abort.abort(new Error("test interrupted"));
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const redact = (value: unknown) => String(value).split(secret || "\0").join("[REDACTED]")
    .replace(/https?:\/\/[^\s\"'<>]+/gi, "[REDACTED_URL]").slice(0, 4000);
  const failure = (error: unknown) => ({ stage, message: redact(error instanceof Error ? error.message : error),
    ...(error instanceof Error && error.stack ? { stack: redact(error.stack) } : {}) });
  let calls = 0, constructing = false, constructionAttempts = 0;
  try {
    const startPin = sourcePin(); report.code = { headAtStart: git("rev-parse", "HEAD").trim(), ...startPin };
    const readyBytes = readFileSync(args.ready), priceBytes = readFileSync(args.prices);
    const saved = parseAtBlockJson(priceBytes.toString());
    const inputPath = resolve(dirname(args.prices), "input.json");
    const provenance = parseAtBlockJson(readFileSync(inputPath, "utf8"));
    const header = provenance.sourceHeader;
    const extraPaths = [inputPath, ...(args.receipt ? [args.receipt] : []),
      ...(args.referencePrices ? [args.referencePrices, resolve(dirname(args.referencePrices), "declaration.json")] : [])];
    const extraPins = () => extraPaths.map(path => ({ path, sha256: sha(readFileSync(path)) }));
    report.extraInputs = extraPins();
    const donor = args.referencePrices ? { saved: parseAtBlockJson(readFileSync(args.referencePrices, "utf8")),
      declaration: parseAtBlockJson(readFileSync(resolve(dirname(args.referencePrices), "declaration.json"), "utf8")) } : null;
    assert.equal(saved.readySha256, sha(readyBytes), "prices are not from this immutable Ready");
    assert.equal(realpathSync(saved.readyPath), args.ready);
    const envelope = await new UniverseRebuildCheckpointStore({ path: args.ready }).load();
    assert(envelope && !envelope.inProgressRun, "completed Ready required; no rebuild/revalidation here");
    const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration);
    assert.equal(ready.universeRange.fromBlock, ready.cutoff.number, "single-block Ready required");
    const source: CanonicalSource = ready.cutoff, pin = { blockHash: source.hash, requireCanonical: true };
    assertPriceInput(saved, provenance, ready, { readySha256: sha(readyBytes), sourceTreeSha256: startPin.sourceTreeSha256,
      number: source.number });
    assert(same(provenance.executor, EXECUTOR) && same(provenance.owner, OWNER));
    const receipt = args.receipt ? JSON.parse(readFileSync(args.receipt, "utf8")) : null;
    if (receipt) assertOriginalReceipt(receipt, source);
    const original = receipt ? receipt.logs.map(decodeSwapLog).filter((swap: any) => swap && same(swap.pool, args.pool)) : [];
    const sameBlock = (number: number, hash: string) => {
      assert.equal(number, source.number); assert.equal(hash.toLowerCase(), source.hash.toLowerCase());
    };
    sameBlock(Number(BigInt(header.number)), header.hash);
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
    const requireChainQuote = !supportsLocalPricing(descriptor);
    assert(same(descriptor.pool, args.pool));
    assert(descriptor.binding.tokens.length >= 2);
    const edges = graph.filter(e => e.instanceKey === instance.instanceKey && same(e.target, args.pool));
    assert.equal(edges.length, descriptor.binding.tokens.length * (descriptor.binding.tokens.length - 1),
      "all directions must already be in production Ready graph");
    const rows = edges.flatMap(edge => {
      const key = blockScanEdgeKey(edge), row = saved.runtime.pricing.effectiveMids.rows.get(key);
      assert(saved.runtime.graph.edges.some((e: any) => blockScanEdgeKey(e) === key), "price graph lacks Ready edge");
      assert(row && row.edgeId === key, "production effective row required, even if unquoted");
      assert(same(row.tokenIn, edge.tokenIn) && same(row.tokenOut, edge.tokenOut));
      const gate = productionAmount(row, saved.runtime.pricing.mids.get(key), edge, source, saved.runtime.generation);
      const hasDonorInput = donor && args.referenceEdges.some(key => {
        const candidate = donor.saved.runtime.pricing.effectiveMids.rows.get(key);
        return candidate && same(candidate.tokenIn, edge.tokenIn);
      });
      const splice = gate.status !== "met" && hasDonorInput ? splicedProductionAmount(donor!.saved, donor!.declaration, args.referenceEdges, edge.tokenIn) : null;
      const originalIn = original.find((swap: any) => same(swap.tokenIn, edge.tokenIn));
      const originalOut = original.find((swap: any) => same(swap.tokenOut, edge.tokenIn));
      const txAmount: bigint | undefined = originalIn?.amountIn ?? originalOut?.amountOut;
      const reference = gate.status === "met" ? { kind: "target-production-reference", amountIn: gate.amountIn }
        : splice ? { kind: "donor-input-only", amountIn: splice.amountIn } : null;
      if (gate.status !== "met") report.referenceGaps.push({ edgeId: key, status: gate.reason, donorInput: splice });
      const trials: { label: string; amountIn: bigint }[] = [];
      const add = (label: string, amountIn: bigint) => { assert(amountIn > 0n && amountIn <= MAX_INPUT);
        if (!trials.some(t => t.amountIn === amountIn)) trials.push({ label, amountIn }); };
      if (reference) { add(reference.kind, reference.amountIn); add(reference.kind + "-half", reference.amountIn / 2n || 1n); }
      if (txAmount) { add("original-leg-amount-at-N-not-original-prestate", txAmount); add("original-leg-half", txAmount / 2n || 1n); }
      if (!trials.length) { report.unmeasuredDirections.push({ edgeId: key, reason: "no-production-donor-or-original-token-input" }); return []; }
      const routes = instance.routes.filter(r => same(r.tokenIn, row.tokenIn) && same(r.tokenOut, row.tokenOut));
      assert.equal(routes.length, 1);
      const handles = instance.routeHandles.filter(h => h.routeKey === routes[0].routeKey);
      assert.equal(handles.length, 1);
      return [{ row, route: handles[0], trials, reference, splice }];
    });
    assert(rows.length >= 2, "need at least two real measured directions");
    report.plannedDirections = edges.length; report.measuredDirections = rows.length;
    report.productionReferenceComplete = rows.every(r => r.reference !== null) && rows.length === edges.length;
    const botvm = currentBotVm();
    report.inputs = { ready: args.ready, prices: args.prices, readySha256: sha(readyBytes), pricesSha256: sha(priceBytes),
      source, priceGeneration: saved.runtime.generation, timestamp: Number(BigInt(header.timestamp)),
      memoFingerprint: memo.memoFingerprint, familyDefinitionHash: memo.familyDefinitionHash,
      hooks: descriptor.binding.hooks, hasSwapHooks: hasSwapHooks(descriptor.binding.hooks),
      localModel: descriptor.binding.localModel ?? null, stableSurgePoolModel: descriptor.binding.stableSurgePoolModel ?? null,
      runtimeCodeHash: botvm.keccak256 };
    const privateConfig = JSON.parse(readFileSync(args.rpcFile, "utf8"));
    assert(typeof privateConfig.MAINNET_RPC_URL === "string", "rpc-file requires MAINNET_RPC_URL");
    secret = privateConfig.MAINNET_RPC_URL;
    assert(["http:", "https:"].includes(new URL(secret).protocol), "HTTP archive RPC required");
    const allowed = new Set(["web3_clientVersion", "eth_chainId", "eth_getBlockByNumber", "eth_call",
      "eth_getCode", "eth_getStorageAt", "eth_createAccessList", "debug_traceCall", "anvil_setCoinbase"]);
    const rpc: Rpc = async (method, params) => {
      if (constructing) { constructionAttempts++; throw new Error("RPC during runtime construction"); }
      assert(allowed.has(method), "non-read-only method blocked");
      abort.signal.throwIfAborted(); assert(Date.now() < deadline && ++calls <= 1800, "test read budget exceeded");
      const response = await fetch(loopback, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: calls, method, params }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) });
      assert(response.ok, `${method}: loopback HTTP ${response.status}`);
      const body = await response.json() as any;
      if (body.error) {
        const error = new Error(`${method}: ${body.error.code} ${redact(body.error.message)}`);
        if (method === "eth_call" && body.error.code === 3 && ethers.isHexString(body.error.data, true)) {
          Object.assign(error, { localCall: true, rpcCode: 3, returnData: body.error.data });
        }
        throw error;
      }
      assert(Object.hasOwn(body, "result"), `${method}: missing result`);
      return body.result;
    };
    const headerCheck = async () => {
      const h = await rpc("eth_getBlockByNumber", ["latest", false]);
      sameBlock(Number(BigInt(h.number)), h.hash);
      assert.equal(BigInt(h.timestamp), BigInt(header.timestamp), "N timestamp changed");
      assert.equal(BigInt(h.baseFeePerGas), BigInt(header.baseFeePerGas));
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
    const environment = async () => [...ethers.AbiCoder.defaultAbiCoder().decode(Array(7).fill("uint256"),
      await call(EXECUTOR, "0x", { [EXECUTOR]: { code: "0x43600052426020524860405241606052456080524460a0524660c05260e06000f3" } }))] as bigint[];
    const expectedEnvironment = [BigInt(header.number), BigInt(header.timestamp), BigInt(header.baseFeePerGas),
      BigInt(header.miner), BigInt(header.gasLimit), BigInt(header.mixHash), 1n];
    const initialEnvironment = await environment();
    assert.deepEqual(initialEnvironment.filter((_, i) => i !== 3), expectedEnvironment.filter((_, i) => i !== 3));
    if (initialEnvironment[3] !== expectedEnvironment[3]) {
      await rpc("anvil_setCoinbase", [header.miner]); report.coinbaseRestored = header.miner;
    }
    assert.deepEqual(await environment(), expectedEnvironment); report.observedEnvironment = expectedEnvironment;
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
      let key: string;
      if (index !== null) key = balanceStorageKey(EXECUTOR, index).toLowerCase();
      else {
        const access = await rpc("eth_createAccessList", [{ from: OWNER, to: token,
          data: ERC20.encodeFunctionData("balanceOf", [EXECUTOR]), gas: "0x100000" }, ethers.toQuantity(source.number)]);
        assert(!access.error && Array.isArray(access.accessList), "actor balance access list unavailable");
        const proof = await proveActorBalanceSlot({ token, actor: EXECUTOR, protectedAccount: VAULT, call,
          candidates: access.accessList.filter((entry: any) => same(entry.address, token)).flatMap((entry: any) => entry.storageKeys) });
        key = proof.slot; (report.accessListBalanceProofs ??= []).push({ token, ...proof });
      }
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
    for (const { row, route, trials, reference, splice } of rows) {
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
      for (const trial of trials) {
        const amountIn = trial.amountIn, inputSentinel = 101n, outputSentinel = 103n;
        const tokenIn = lower(row.tokenIn), tokenOut = lower(row.tokenOut);
        const inSlot = slots.get(tokenIn)!, outSlot = slots.get(tokenOut)!;
        overrides = { [OWNER]: { balance: ethers.toQuantity(100n * 10n ** 18n) }, [EXECUTOR]: { code: botvm.code },
          [tokenIn]: { stateDiff: { [inSlot]: word(amountIn + inputSentinel) } },
          [tokenOut]: { stateDiff: { [outSlot]: word(outputSentinel) } } };
        const sample: Record<string, any> = { edgeId: row.edgeId, routeKey: route.routeKey, tokenIn, tokenOut,
          amountKind: trial.label, amountIn, productionP: reference?.amountIn ?? null, referenceInput: splice,
          savedPriceOut: row.amountOut ?? null, targetEffectiveStatus: row.status,
          runtimeConstructionRpc: 0, programHash: ethers.keccak256(leg.program), status: "failed", executions: [] };
        report.samples.push(sample);
        try {
          stage = "production-exact";
          const queryStart = queryCalls.length;
          const quote = await executeFamilyExactQuote({ family, route, amountIn, source, generation: source.generation,
            executor: EXECUTOR, runtimeEvidence: [], runtime, requireChainAmountQuote: requireChainQuote });
          sample.quote = { status: quote.status, outcome: quote.outcome, queryCalls: queryCalls.slice(queryStart) };
          assert.equal(quote.status, "resolved", "production Exact unresolved");
          if (quote.status !== "resolved") throw new Error("production Exact unresolved");
          assert(quote.amountOut > 0n); sample.quote.amountOut = quote.amountOut;
          if (requireChainQuote) assert(queryCalls.length > queryStart, "chain Exact must actually query this sample amount");
          else assert.equal(queryCalls.length, queryStart, "proven local quote must not silently fall back to Router");
          if (row.status === "quoted" && amountIn === row.amountIn) {
            assert.equal(quote.amountOut, row.amountOut, "fresh P quote differs from saved production price");
          }
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
                gasPrice: ethers.toQuantity(BigInt(header.baseFeePerGas)) };
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
              assert.deepEqual(result.finalAllowances, [[0n], [0n, BigInt(header.timestamp), 0n]],
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
    assert.deepEqual(await environment(), expectedEnvironment);
    for (const token of descriptor.binding.tokens) assert.equal(await balance(token, EXECUTOR), 0n, "trace persisted state");
    assert.equal(await rpc("eth_getCode", [EXECUTOR, pin]), "0x", "actor code override persisted");
    assert.equal(sha(readFileSync(args.ready)), report.inputs.readySha256);
    assert.equal(sha(readFileSync(args.prices)), report.inputs.pricesSha256);
    assert.deepEqual(extraPins(), report.extraInputs);
    assert.deepEqual(sourcePin(), startPin, "source/code changed during test");
    assert.equal(constructionAttempts, 0);
    assert(report.samples.length === rows.reduce((n, r) => n + r.trials.length, 0) &&
      report.samples.every((s: any) => s.status === "pass"), "one or more samples failed; retained in receipt");
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
    unmeasuredDirections: report.unmeasuredDirections.length, productionReferenceComplete: report.productionReferenceComplete,
    out: args.out, forkStopped: report.forkStopped }));
  if (report.result !== "pass") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).includes("--help")) console.log("--ready FILE --prices FILE --pool ADDRESS --rpc-file FILE --out NEW_IGNORED_JSON --port 8591 [--receipt FILE] [--reference-prices FILE --reference-edges JSON_ARRAY]");
  else main().catch(() => { console.error("historical-runtime-dual: input/output setup failed; no RPC started if no receipt was reserved"); process.exitCode = 1; });
}
