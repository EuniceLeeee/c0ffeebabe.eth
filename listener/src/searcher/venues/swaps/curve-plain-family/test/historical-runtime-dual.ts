// Opt-in historical Curve single-leg evidence. Reuses the pinned-fork method
// validated by balancer-v3-family/test/historical-runtime-dual.ts, with Curve's
// production requirement materializer and standing-allowance semantics.
// Not a Ready writer, full-route sim,
// original-TX replay, latency benchmark, or adapter/production acceptance gate.
import { curveHistoricalAmounts } from "./historical-amounts.js";
import { curveHistoricalHeader } from "./historical-price-input.js";
import { splicedProductionAmount } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
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
import { planFragmentNodes } from "../../../../solver/plan-fragment-requirements.js";
import { lower, same, MAX_UINT, pullsInput } from "../codec.js";
import type { CurvePlainDescriptor } from "../types.js";
import type { CurveUnderlyingDescriptor } from "../../curve-underlying-family/types.js";
import { curveRefreshAddresses } from "../refresh-scope.js";
const MAX_INPUT = MAX_UINT;

const ROOT = fileURLToPath(new URL("../../../../../../../", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const OWNER = "0x1000000000000000000000000000000000000001";
const EXECUTOR = "0x1000000000000000000000000000000000000002";
const ERC20 = new ethers.Interface(["function balanceOf(address) view returns(uint256)",
  "function allowance(address,address) view returns(uint256)"]);

type Overrides = Record<string, { code?: string; balance?: string; stateDiff?: Record<string, string> }>;
type Rpc = (method: string, params: unknown[]) => Promise<any>;
const json = (value: unknown) => JSON.stringify(value, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const word = (value: string | bigint) => ethers.toBeHex(BigInt(value), 32).toLowerCase();
const git = (...args: string[]) => execFileSync("git", ["-c", `safe.directory=${ROOT.replace(/\/$/, "")}`, ...args],
  { cwd: ROOT, encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

// Hash the actual working source, including uncommitted/untracked source, not
// just HEAD. Tests/reports may be committed independently without changing it.
function sourcePin(name: string) {
  const files = git("ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "listener/src", "src")
    .split("\0").filter(p => /\.(ts|sol)$/.test(p) && !p.includes("/test/")).sort();
  return { sourceSha256: sha(files.map(p => `${p}\0${sha(readFileSync(resolve(ROOT, p)))}`).join("\n")),
    fileCount: files.length, testSha256: sha(readFileSync(SELF)),
    testSafetySha256: sha(readFileSync(new URL("./historical-runtime-dual-safety.test.ts", import.meta.url))),
    testInputHelperSha256: sha(readFileSync(new URL("./historical-amounts.ts", import.meta.url))),
    testPriceInputHelperSha256: sha(readFileSync(new URL("./historical-price-input.ts", import.meta.url))),
    testDonorHelperSha256: sha(readFileSync(new URL("../../../../test/family-integration/kyber-yb-compound/evidence.ts", import.meta.url))),
    artifactSha256: sha(readFileSync(resolve(ROOT, "out/BotVM.sol/BotVM.json"))),
    familyDefinitionHash: familyDefinitionHash(name), familyMemoDefinitionHash: familyMemoDefinitionHash(name) };
}

interface CurveManualInput {
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
}

/** Explicit CLI input, not a production price or a claim of receipt provenance. */
export function curveHistoricalManualInput(value?: string): CurveManualInput | undefined {
  if (value === undefined) return undefined;
  const input = JSON.parse(value);
  assert(input && typeof input === "object" && !Array.isArray(input), "manual input must be an object");
  assert.deepEqual(Object.keys(input).sort(), ["amountIn", "tokenIn", "tokenOut"]);
  const tokenIn = lower(ethers.getAddress(input.tokenIn)), tokenOut = lower(ethers.getAddress(input.tokenOut));
  assert(!same(tokenIn, tokenOut), "manual input requires distinct tokens");
  assert(typeof input.amountIn === "string" && /^[1-9][0-9]*$/.test(input.amountIn), "manual amount must be a positive integer string");
  const amountIn = BigInt(input.amountIn);
  assert(amountIn <= MAX_INPUT - 101n, "manual input plus old inventory exceeds uint256");
  return { tokenIn, tokenOut, amountIn };
}

function options(argv: string[]) {
  const names = ["--ready", "--prices", "--pool", "--family", "--rpc-file", "--out", "--port"];
  const allowedNames = [...names, "--executor-hardfork", "--reference-executions", "--price-input", "--reference-prices", "--reference-edges", "--manual-input", "--expect-output-error"];
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    assert(allowedNames.includes(argv[i]) && !values.has(argv[i]), "unknown/duplicate option");
    assert(argv[i + 1] && !argv[i + 1].startsWith("--"), "missing option value");
    values.set(argv[i], argv[i + 1]);
  }
  assert(names.every(name => values.has(name)), "required: --ready --prices --pool --family --rpc-file --out --port");
  assert.equal(values.has("--reference-prices"), values.has("--reference-edges"), "donor requires prices and edge keys");
  assert(!(values.has("--reference-executions") && values.has("--reference-prices")), "choose saved execution or donor inputs, not both");
  const manual = curveHistoricalManualInput(values.get("--manual-input"));
  const expectedOutputError = values.get("--expect-output-error");
  assert(expectedOutputError === undefined || (manual && expectedOutputError.length <= 160),
    "expected output rejection requires one manual direction and a bounded exact reason");
  const hardfork = values.get("--executor-hardfork");
  assert(hardfork === undefined || hardfork === "cancun", "executor hardfork must be explicit cancun");
  assert(!manual || (!values.has("--reference-executions") && !values.has("--reference-prices")), "manual input cannot mix with reference modes");
  const referenceEdges: unknown = JSON.parse(values.get("--reference-edges") ?? "[]");
  assert(Array.isArray(referenceEdges) && referenceEdges.every(key => typeof key === "string" && key.length > 0));
  assert(!values.has("--reference-prices") || referenceEdges.length > 0);
  assert.equal(new Set(referenceEdges).size, referenceEdges.length, "duplicate donor edge");
  assert.equal(values.get("--port"), "8591", "this narrow test owns only loopback port 8591");
  const name = values.get("--family")!;
  assert(name === "curve-plain" || name === "curve-underlying", "only the two Curve families are in scope");
  const out = resolve(values.get("--out")!);
  const parent = realpathSync(dirname(out)), logs = realpathSync(resolve(ROOT, "logs"));
  assert(parent === logs || parent.startsWith(logs + sep), "output parent must already exist under this repo's logs/");
  assert(!existsSync(out), "output exists; choose a new receipt path (never overwrite failures)");
  assert.equal(git("check-ignore", "--", out).trim(), out, "output must be gitignored");
  return { ready: realpathSync(values.get("--ready")!), prices: realpathSync(values.get("--prices")!),
    priceInput: values.has("--price-input") ? realpathSync(values.get("--price-input")!) : undefined,
    reference: values.has("--reference-executions") ? realpathSync(values.get("--reference-executions")!) : undefined,
    referencePrices: values.has("--reference-prices") ? realpathSync(values.get("--reference-prices")!) : undefined,
    referenceEdges: referenceEdges as string[], manual, hardfork, expectedOutputError,
    name, rpcFile: realpathSync(values.get("--rpc-file")!), pool: lower(ethers.getAddress(
      values.get("--pool")!.startsWith("0x") ? values.get("--pool")! : `0x${values.get("--pool")!}`)), out };
}

/** Keep current-executor compatibility distinct from historical EVM replay. */
export function curveHistoricalExecutionRules(requested: string | undefined, artifactTarget: unknown, actual: unknown) {
  assert(requested === undefined || requested === "cancun", "unsupported executor hardfork");
  assert(typeof artifactTarget === "string" && artifactTarget.length > 0, "missing artifact EVM target");
  assert(typeof actual === "string" && actual.length > 0, "missing node hardfork");
  if (requested) {
    assert.equal(artifactTarget, requested, "counterfactual hardfork differs from compiled executor");
    assert.equal(actual.toLowerCase(), requested, "node did not apply requested hardfork");
  }
  return { mode: requested ? "counterfactual-current-executor" : "historical-fork-default",
    artifactTarget, requestedHardfork: requested ?? null, actualHardfork: actual,
    originalTransactionReplay: false };
}

export function curveHistoricalExecutionProbe(data: string, header: { number: number; timestamp: number; baseFeePerGas: bigint }) {
  assert.equal(data.length, 2 + 5 * 64, "environment probe must return exactly five words");
  const [number, timestamp, baseFee, transientRoundTrip, opcode44] =
    ethers.AbiCoder.defaultAbiCoder().decode(["uint256", "uint256", "uint256", "uint256", "uint256"], data) as unknown as bigint[];
  assert.equal(number, BigInt(header.number), "EVM NUMBER differs from source");
  assert.equal(timestamp, BigInt(header.timestamp), "EVM TIMESTAMP differs from source");
  assert.equal(baseFee, header.baseFeePerGas, "EVM BASEFEE differs from source");
  assert.equal(transientRoundTrip, 1n, "current executor transient storage unavailable");
  return { number, timestamp, baseFee, transientRoundTrip, opcode44 };
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
  return { ...loadBotVmRuntimeCode(OWNER), compilationEvmVersion: metadata.settings.evmVersion };
}

// diffMode omits unchanged slots from BOTH sides. Absence is zero only when
// the other side proves this exact slot was created/deleted.
function storage(diff: any, side: "pre" | "post", address: string): Record<string, string> {
  const account = Object.entries(diff[side]).find(([key]) => same(key, address))?.[1] as any;
  return Object.fromEntries(Object.entries(account?.storage ?? {}).map(([key, value]) => [word(key), word(String(value))]));
}
function observed(diff: any, address: string, slot: string, initial: bigint, requireChange = true) {
  const pre = storage(diff, "pre", address), post = storage(diff, "post", address);
  const before = slot in pre ? BigInt(pre[slot]) : slot in post ? 0n : initial;
  const after = slot in post ? BigInt(post[slot]) : slot in pre ? 0n : initial;
  assert.equal(before, initial, "trace prestate disagrees with independently read balance");
  if (requireChange) assert(slot in pre || slot in post, "actor balance did not change in prestate trace");
  return { before, after, delta: after - before };
}

export function observedNativeInventory(diff: any, address: string, initial: bigint) {
  assert(diff?.pre && diff?.post, "independent prestate diff unavailable");
  const account = (side: "pre" | "post") => Object.entries(diff[side])
    .find(([key]) => same(key, address))?.[1] as { balance?: string } | undefined;
  const pre = account("pre"), post = account("post");
  // diffMode omits unchanged accounts on BOTH sides. An existing post account
  // may omit an unchanged balance; only a pre-only account proves deletion.
  const before = pre?.balance !== undefined ? BigInt(pre.balance) : pre ? initial : post ? 0n : initial;
  const after = post?.balance !== undefined ? BigInt(post.balance) : post ? before : pre ? 0n : initial;
  assert.equal(before, initial, "native prestate disagrees with actor override");
  assert.equal(after, initial, "encoded execution consumed or changed native inventory");
  return { before, after, delta: after - before };
}

export function assertNoInputRollback(input: {
  trace: { error?: string }; diff: any; tokenIn: string; inSlot: string;
  tokenOut: string; outSlot: string; outputBefore: bigint; nativeBefore: bigint;
  finalAllowances: bigint[][];
}) {
  assert.equal(input.trace?.error, "execution reverted", "zero-input control did not revert atomically");
  assert(input.diff?.pre && input.diff?.post, "negative-control prestate diff unavailable");
  const spent = observed(input.diff, input.tokenIn, input.inSlot, 0n, false);
  const received = observed(input.diff, input.tokenOut, input.outSlot, input.outputBefore, false);
  assert.equal(spent.delta, 0n); assert.equal(received.delta, 0n);
  const native = observedNativeInventory(input.diff, EXECUTOR, input.nativeBefore);
  assert.deepEqual(input.finalAllowances, [[0n]], "failed control left ERC20 authorization");
  // Actual Anvil diffMode rollback evidence may retain sender gas/nonce changes,
  // but no executor/token/protocol changes or sender code/storage changes.
  for (const side of ["pre", "post"] as const) {
    for (const [address, account] of Object.entries(input.diff[side])) {
      assert(same(address, OWNER), "failed control left non-sender state changes");
      assert(Object.keys(account as object).every(key => key === "balance" || key === "nonce"),
        "failed control changed sender code/storage");
    }
  }
  return { input: spent, output: received, native };
}

/** A source-state rejection is not a successful swap. Require the intended
 * output transfer's exact ABI revert and atomic rollback, not any root error. */
export function assertOutputRejection(input: {
  trace: any; diff: any; pool: string; tokenOut: string; expectedReason: string;
  tokenIn: string; inSlot: string; inputBefore: bigint; nativeBefore: bigint; quotedAmountOut: bigint; requestedAmountIn: bigint;
}) {
  assert.equal(input.trace?.error, "execution reverted", "expected execution did not revert");
  assert(input.diff?.pre && input.diff?.post, "negative sample lacks independent state diff");
  const expected = "0x08c379a0" + ethers.AbiCoder.defaultAbiCoder().encode(["string"], [input.expectedReason]).slice(2);
  const transferData = new ethers.Interface(["function transfer(address,uint256)"])
    .encodeFunctionData("transfer", [EXECUTOR, input.quotedAmountOut]).toLowerCase();
  const inputData = new ethers.Interface(["function transferFrom(address,address,uint256)"])
    .encodeFunctionData("transferFrom", [EXECUTOR, input.pool, input.requestedAmountIn]).toLowerCase();
  let found = false;
  function walk(frame: any) {
    if (frame?.type === "CALL" && typeof frame.to === "string" &&
        same(frame.to, input.pool) && frame.error === "execution reverted") {
      let inputTransferred = false;
      for (const child of frame.calls ?? []) {
        if (child?.type !== "CALL" || typeof child.from !== "string" ||
            typeof child.to !== "string" || !same(child.from, input.pool)) continue;
        // callTracer may omit output for tokens such as USDT that return no bytes.
        if (same(child.to, input.tokenIn) && child.input?.toLowerCase() === inputData &&
            !child.error && (child.output === undefined || child.output === "" ||
              child.output === "0x" || child.output?.toLowerCase() === word(1n))) inputTransferred = true;
        if (same(child.to, input.tokenOut) && child.input?.toLowerCase() === transferData &&
            child.error === "execution reverted" && child.output?.toLowerCase() === expected.toLowerCase()) {
          assert(inputTransferred, "expected full input transfer did not succeed before output rejection");
          found = true;
        }
      }
    }
    for (const child of frame?.calls ?? []) walk(child);
  }
  walk(input.trace); assert(found, "expected pool output transfer and exact revert were not observed");
  const balance = observed(input.diff, input.tokenIn, input.inSlot, input.inputBefore, false);
  assert.equal(balance.delta, 0n, "rejected execution consumed input");
  const native = observedNativeInventory(input.diff, EXECUTOR, input.nativeBefore);
  for (const side of ["pre", "post"] as const) for (const [address, account] of Object.entries(input.diff[side])) {
    assert(same(address, OWNER), "rejected execution left non-sender state changes");
    assert(Object.keys(account as object).every(key => key === "balance" || key === "nonce"),
      "rejected execution changed sender code/storage");
  }
  return { input: balance, native, reason: input.expectedReason, inputTransferredBeforeRevert: input.requestedAmountIn };
}

export function curveHistoricalQuoteTargets(descriptor: CurvePlainDescriptor | CurveUnderlyingDescriptor): Set<string> {
  if ("binding" in descriptor) return new Set(curveRefreshAddresses(descriptor).map(lower));
  const model = descriptor.quoteModel;
  return new Set([descriptor.pool, ...(model
    ? [model.basePool, model.baseLPToken, model.implementation, ...model.baseCoins] : [])].map(lower));
}

/** Donors supply an input only. Never replace a quoted target row or hide a
 * target quote/execution failure behind a cross-block price. */
export function curveHistoricalReferenceInput(row: any, donor?: {
  saved: any; declaration: any; edgeKeys: readonly string[];
}, manual?: CurveManualInput) {
  if (manual) {
    assert(!donor && same(row.tokenIn, manual.tokenIn) && same(row.tokenOut, manual.tokenOut), "manual direction mismatch or mixed donor");
    return { kind: "manual-cli" as const, amountIn: manual.amountIn, expectedOut: undefined, borrowed: undefined };
  }
  if (row?.status === "quoted") {
    assert(typeof row.amountIn === "bigint" && row.amountIn > 0n && row.amountIn * 10n <= MAX_INPUT);
    assert(typeof row.amountOut === "bigint" && row.amountOut > 0n);
    return { kind: "current-production-effective" as const, amountIn: row.amountIn as bigint,
      expectedOut: row.amountOut as bigint, borrowed: undefined };
  }
  assert(row?.status === "missing-valuation" && row.amountIn == null && row.amountOut == null,
    "donor may fill only a missing valuation input, not a failed target quote");
  assert(donor, "actual quoted production row or explicitly bound donor input required");
  const borrowed = splicedProductionAmount(donor.saved, donor.declaration, donor.edgeKeys, row.tokenIn);
  assert(borrowed.amountIn * 10n <= MAX_INPUT);
  return { kind: borrowed.kind, amountIn: borrowed.amountIn, expectedOut: undefined, borrowed };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = options(argv);
  // Reserve before any fork; write once in finally, including failed attempts.
  const fd = openSync(args.out, "wx", 0o600);
  const report: Record<string, any> = { schemaVersion: 1, result: "failed", pool: args.pool,
    limits: { loopbackReadCalls: 2000, wallMs: 480000 },
    claim: "Family-local single-leg quote/old-fragment/runtime-program parity at N; NOT full-route sim, original-TX replay, latency or merge acceptance",
    actor: { executor: EXECUTOR, owner: OWNER }, samples: [], errors: [],
    safety: { broadcast: false, signing: false, remoteSubmission: false, minedBlocks: 0,
      executionOverrides: "test actor code/native gas and actor ERC20 balances only; no pool/registry/liquidity overrides" } };
  let backend: AnvilStateBackend | undefined, secret = "", stage = "offline-inputs";
  const abort = new AbortController(), deadline = Date.now() + 480_000;
  const timer = setTimeout(() => abort.abort(new Error("test wall budget exceeded")), 480_000);
  const interrupt = () => abort.abort(new Error("test interrupted"));
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const redact = (value: unknown) => String(value).split(secret || "\0").join("[REDACTED]")
    .replace(/https?:\/\/[^\s\"'<>]+/gi, "[REDACTED_URL]").slice(0, 4000);
  const failure = (error: unknown) => ({ stage, message: redact(error instanceof Error ? error.message : error) });
  let calls = 0, constructing = false, constructionAttempts = 0;
  try {
    if (args.expectedOutputError) report.claim =
      "Explicit source-state output rejection through production quoted/runtime encoders; NOT successful swap, original replay or performance";
    const startPin = sourcePin(args.name); report.code = { headAtStart: git("rev-parse", "HEAD").trim(), ...startPin };
    const readyBytes = readFileSync(args.ready), priceBytes = readFileSync(args.prices);
    const saved = parseAtBlockJson(priceBytes.toString());
    const donorPaths = args.referencePrices ? [args.referencePrices, resolve(dirname(args.referencePrices), "declaration.json")] : [];
    const donorPins = () => donorPaths.map(path => ({ path, sha256: sha(readFileSync(path)) }));
    const donorInputPins = donorPins();
    const donor = args.referencePrices ? { saved: parseAtBlockJson(readFileSync(args.referencePrices, "utf8")),
      declaration: parseAtBlockJson(readFileSync(donorPaths[1], "utf8")), edgeKeys: args.referenceEdges } : undefined;
    if (donor) report.amountDonor = { inputs: donorInputPins, edgeKeys: args.referenceEdges,
      cfg: donor.saved.cfg, sourceCommit: donor.declaration.head,
      referenceWethInput: donor.saved.runtime?.pricing?.effectiveMids?.referenceWethInput,
      use: "recorded input amounts only; not target output, identity, admission or natural valuation" };
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
    const priceInputBytes = args.priceInput ? readFileSync(args.priceInput) : undefined;
    const header = curveHistoricalHeader(saved, source,
      priceInputBytes ? parseAtBlockJson(priceInputBytes.toString()) : undefined);
    if (args.priceInput) report.priceInput = { path: args.priceInput, sha256: sha(priceInputBytes!) };
    sameBlock(header.number, header.hash);
    sameBlock(saved.runtime.sourceBlock, saved.runtime.sourceBlockHash);
    sameBlock(saved.runtime.pricing.sourceBlock, saved.runtime.pricing.sourceBlockHash);
    const family = asPricedFamily(catalog.forStrictFamily(familyId(args.name)));
    const memos = activeReadyMemos(envelope).filter(m => m.familyId === args.name && same(m.instanceKey, args.pool));
    assert.equal(memos.length, 1, "exactly one active admitted pool memo required");
    const memo = memos[0];
    assert([startPin.familyDefinitionHash, startPin.familyMemoDefinitionHash].includes(memo.familyDefinitionHash),
      "stale Family fingerprint: use existing selective revalidation, not this test");
    const loopback = "http://127.0.0.1:8591";
    const wiring = createRebuildWiring({ rpcUrl: loopback, familyIds: [args.name],
      executionIdentity: { executor: EXECUTOR, transactionOrigin: OWNER } });
    const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: source }) as PreparedFamilyInstance;
    assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
    const descriptor = instance.descriptor as CurvePlainDescriptor | CurveUnderlyingDescriptor;
    const tokens = "binding" in descriptor ? descriptor.binding.coins : descriptor.coins;
    assert(same(descriptor.pool, args.pool));
    assert(tokens.length >= 2 && tokens.length <= 4, "bounded ERC20 two-to-four-token pool sample");
    const edges = graph.filter(e => e.instanceKey === instance.instanceKey && same(e.target, args.pool));
    assert.equal(edges.length, instance.routes.length, "every admitted direction must already be in the production graph");
    assert(edges.length >= 2 && edges.length <= 12);
    const selectedEdges = args.manual ? edges.filter(edge =>
      same(edge.tokenIn, args.manual!.tokenIn) && same(edge.tokenOut, args.manual!.tokenOut)) : edges;
    if (args.manual) assert.equal(selectedEdges.length, 1, "manual direction must be naturally admitted");
    const rows = selectedEdges.map(edge => {
      const key = blockScanEdgeKey(edge), row = saved.runtime.pricing.effectiveMids.rows.get(key);
      assert(saved.runtime.graph.edges.some((e: any) => blockScanEdgeKey(e) === key), "price graph lacks Ready edge");
      assert(row && row.edgeId === key, "actual target production price row required, even if unquoted");
      assert(same(row.tokenIn, edge.tokenIn) && same(row.tokenOut, edge.tokenOut));
      const referenceInput = curveHistoricalReferenceInput(row, donor, args.manual);
      if (referenceInput.kind === "current-production-effective") {
        sameBlock(row.quotedAt.number, row.quotedAt.hash);
        assert.equal(row.quotedAt.generation, saved.runtime.generation);
      }
      const amountRow = { tokenIn: row.tokenIn, tokenOut: row.tokenOut, amountIn: referenceInput.amountIn };
      const routes = instance.routes.filter(r => same(r.tokenIn, row.tokenIn) && same(r.tokenOut, row.tokenOut));
      assert.equal(routes.length, 1);
      const handles = instance.routeHandles.filter(h => h.routeKey === routes[0].routeKey);
      assert.equal(handles.length, 1);
      return { row, amountRow, referenceInput, route: handles[0], definition: routes[0] };
    });
    report.expectedSamples = rows.length * (args.manual ? 1 : 2);
    if (args.manual) report.manualInput = { ...args.manual, use: "input only; no natural valuation or original-TX output claim" };
    report.naturalProductionReferenceComplete = rows.every(r => r.referenceInput.kind === "current-production-effective");
    const reference = args.reference ? JSON.parse(readFileSync(args.reference, "utf8")) : undefined;
    if (args.reference) report.referenceExecutions = { path: args.reference,
      sha256: sha(readFileSync(args.reference)), use: "saved executed inputs and independent outputs only; not admission" };
    const pointsFor = (row: (typeof rows)[number]["amountRow"]) => args.manual
      ? [{ multiplier: 1n, amountIn: args.manual.amountIn, priorActualOut: undefined }]
      : curveHistoricalAmounts({ source, pool: args.pool, family: args.name, row, reference });
    // Validate every selected direction before opening the owned fork.
    for (const { amountRow } of rows) pointsFor(amountRow);
    const measuredTokens = [...new Set(rows.flatMap(r => [lower(r.row.tokenIn), lower(r.row.tokenOut)]))];
    assert(measuredTokens.every(token => tokens.some(t => same(t, token))), "admitted direction outside descriptor coins");
    report.scope = { family: args.name, directions: rows.map(r => r.route.routeKey),
      admittedDirections: instance.routes.map(r => r.routeKey), tokenCount: tokens.length, measuredTokens };
    const botvm = currentBotVm();
    report.inputs = { ready: args.ready, prices: args.prices, readySha256: sha(readyBytes), pricesSha256: sha(priceBytes),
      source, priceGeneration: saved.runtime.generation, timestamp: header.timestamp,
      memoFingerprint: memo.memoFingerprint, familyDefinitionHash: memo.familyDefinitionHash,
      descriptor, candidate: memo.candidateSnapshot, runtimeCodeHash: botvm.keccak256 };
    const privateConfig = JSON.parse(readFileSync(args.rpcFile, "utf8"));
    assert(typeof privateConfig.MAINNET_RPC_URL === "string", "rpc-file requires MAINNET_RPC_URL");
    secret = privateConfig.MAINNET_RPC_URL;
    assert(["http:", "https:"].includes(new URL(secret).protocol), "HTTP archive RPC required");
    const allowed = new Set(["anvil_nodeInfo", "web3_clientVersion", "eth_chainId", "eth_getBlockByNumber", "eth_call",
      "eth_getCode", "eth_getStorageAt", "eth_createAccessList", "debug_traceCall"]);
    const rpc: Rpc = async (method, params) => {
      if (constructing) { constructionAttempts++; throw new Error("RPC during runtime construction"); }
      assert(allowed.has(method), "non-read-only method blocked");
      // Additional same-source base/LP/code guards are bounded loopback reads.
      abort.signal.throwIfAborted(); assert(Date.now() < deadline && ++calls <= report.limits.loopbackReadCalls, "test read budget exceeded");
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
      assert.equal(Number(BigInt(h.timestamp)), header.timestamp, "N timestamp changed");
      assert.equal(BigInt(h.baseFeePerGas), header.baseFeePerGas);
      return { number: source.number, hash: h.hash, timestamp: Number(BigInt(h.timestamp)), baseFeePerGas: h.baseFeePerGas };
    };
    stage = "owned-fork-start";
    backend = new AnvilStateBackend(secret, loopback, 8591, args.hardfork);
    await backend.forkAt(source.number, { signal: abort.signal, deadlineAtMs: deadline });
    report.client = await rpc("web3_clientVersion", []); assert(/anvil/i.test(report.client));
    assert.equal(BigInt(await rpc("eth_chainId", [])), 1n);
    report.headerBefore = await headerCheck();
    // The node response includes its upstream URL: retain only the non-secret rule.
    const actualHardfork = (await rpc("anvil_nodeInfo", [])).hardFork;
    report.executionRules = curveHistoricalExecutionRules(args.hardfork, botvm.compilationEvmVersion, actualHardfork);
    const call = (to: string, data: string, overrides: Overrides = {}) => rpc("eth_call", [{ to, data, from: OWNER }, pin, overrides]);
    const balance = async (token: string, holder: string, overrides: Overrides = {}) =>
      BigInt(await call(token, ERC20.encodeFunctionData("balanceOf", [holder]), overrides));
    stage = "actor-balance-mapping";
    for (const actor of [OWNER, EXECUTOR]) assert.equal(await rpc("eth_getCode", [actor, pin]), "0x", "actor already has source code");
    if (args.hardfork) {
      // Read execution-visible fields and exercise Cancun TSTORE/TLOAD without
      // mining or overriding any protocol account. Opcode 0x44 is disclosed,
      // not asserted equivalent to the historical pre-merge DIFFICULTY.
      const probeCode = "0x436000524260205248604052600160005d60005c6060524460805260a06000f3";
      report.executionEnvironmentProbe = {
        ...curveHistoricalExecutionProbe(await call(EXECUTOR, "0x", { [EXECUTOR]: { code: probeCode } }), header),
        codeHash: ethers.keccak256(probeCode),
      };
    }
    const slots = new Map<string, string>();
    report.balanceMappings = [];
    for (const token of tokens) assert.equal(await balance(token, EXECUTOR), 0n, "actor already has source inventory");
    // Only admitted directions need controllable balances. An unadmitted,
    // suspended coin must not block testing the independently admitted pair.
    for (const token of measuredTokens) {
      if (args.expectedOutputError && same(token, args.manual!.tokenOut)) {
        assert.equal(await balance(token, EXECUTOR), 0n, "unseeded rejection output must have no actor inventory");
        const code = await rpc("eth_getCode", [token, pin]); assert(code !== "0x");
        report.unseededOutput = { token, actorBalance: 0n, poolBalance: await balance(token, args.pool),
          codeHash: ethers.keccak256(code), expectedError: args.expectedOutputError,
          scope: "real output state; no output balance override and no successful swap claim" };
        continue;
      }
      assert(![OWNER, EXECUTOR, args.pool].some(a => same(a, token)),
        "actor/token/protocol addresses must not alias");
      assert.equal(await balance(token, EXECUTOR), 0n, "actor already has source inventory");
      // Underlying coins may sit in a base pool. Look only among existing
      // graph targets; this supplies a positive holder, never admission or state.
      const holders = [...new Set([args.pool, ...graph.filter(e =>
        same(e.tokenIn, token) || same(e.tokenOut, token)).map(e => lower(e.target))])].slice(0, 32);
      let holder = "", holderBalance = 0n;
      for (const candidate of holders) {
        holderBalance = await balance(token, candidate);
        if (holderBalance > 0n) { holder = candidate; break; }
      }
      // A single-block Graph need not contain the underlying base pool.
      // Without a positive holder, use a second empty actor as the independence
      // control; the fast mapper returns null and actual getter slots are probed.
      if (!holder) {
        holder = OWNER; holderBalance = await balance(token, holder);
        assert.equal(holderBalance, 0n, "control actor already owns this token");
      }
      const index = await resolveErc20BalanceSlot(token, holder, { balanceOf: balance,
        getStorage: async (t, key) => BigInt(await rpc("eth_getStorageAt", [t, key, pin])) });
      // The production fast mapper intentionally returns null for nonstandard
      // layouts (e.g. Vyper). Test-only fallback uses slots actually read by
      // balanceOf(actor), not a guessed Solidity/Vyper storage index.
      const candidates: string[] = [];
      if (index !== null) candidates.push(balanceStorageKey(EXECUTOR, index).toLowerCase());
      else {
        const access = await rpc("eth_createAccessList", [{ from: OWNER, to: token,
          data: ERC20.encodeFunctionData("balanceOf", [EXECUTOR]), gas: "0x100000" }, ethers.toQuantity(source.number)]);
        assert(!access.error && Array.isArray(access.accessList), "actor balance access list unavailable");
        (report.balanceGetterReadSets ??= []).push({ token, source, access });
        candidates.push(...access.accessList.filter((a: any) => same(a.address, token))
          .flatMap((a: any) => a.storageKeys.map((key: string) => word(key))));
      }
      assert(candidates.length > 0 && candidates.length <= 16, "bounded actor balance read slots required");
      let key = "";
      for (const candidate of [...new Set(candidates)]) {
        let matches = true;
        for (const probe of [717171717171n, 919191919193n]) {
          const override = { [lower(token)]: { stateDiff: { [candidate]: word(probe) } } };
          // A wrong proxy/guard slot may revert. It must never be accepted.
          let observedBalance: bigint | undefined;
          try { observedBalance = await balance(token, EXECUTOR, override); } catch { matches = false; break; }
          if (observedBalance !== probe || await balance(token, holder, override) !== holderBalance) {
            matches = false; break;
          }
        }
        if (matches) { assert.equal(key, "", "ambiguous actor balance mapping"); key = candidate; }
      }
      assert(key, "actor balance read-slot proof unresolved; no execution overrides created");
      slots.set(lower(token), key); report.balanceMappings.push({ token, holder, holderBalance, slotIndex: index,
        discovery: index === null ? "actual-getter-access-list" : "production-fast-mapping",
        actorStorageKey: key, verifiedProbes: 2 });
    }
    const adapters = [...family.plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
    const compile = (node: ResolvedPlanNode): Uint8Array => {
      const adapter = adapters.find(a => a.id === node.adapterId); assert(adapter, "missing production action encoder");
      return adapter.encode(node, EXECUTOR, concatBytes(...node.children.map(compile)));
    };
    // Exact may compose reads of the admitted metapool's proven base, LP and
    // coins. This is a test read boundary, not another quote implementation.
    const quoteTargets = curveHistoricalQuoteTargets(descriptor);
    report.quoteReadTargets = [...quoteTargets].sort();
    for (const { row, amountRow, referenceInput, route, definition } of rows) {
      let overrides: Overrides = {};
      const queryCalls: any[] = [];
      const runtime = createStrictCentralAdapterRuntime({ executor: EXECUTOR, transactionOrigin: OWNER,
        generationFence: { assertCurrent(generation, requested) {
          assert.equal(generation, source.generation); assert.deepEqual(requested, source);
        } }, provider: {
          async call(tx, block) {
            assert.equal(block, source.number, "quote must request N");
            assert(quoteTargets.has(lower(tx.to)), "Curve Exact read outside admitted pool/bound dependencies");
            queryCalls.push({ target: tx.to, selector: tx.data.slice(0, 10), from: tx.from ?? null });
            return rpc("eth_call", [{ ...tx, gas: "0x800000" }, pin, overrides]);
          },
          async getCode(address, block) {
            assert.equal(block, source.number); assert(quoteTargets.has(lower(address)), "Curve code read outside bound dependencies");
            return rpc("eth_getCode", [address, pin]);
          },
          async getStorage(address, key, block) {
            assert.equal(block, source.number); assert(quoteTargets.has(lower(address)));
            return rpc("eth_getStorageAt", [address, key, pin]);
          },
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
      for (const point of pointsFor(amountRow)) {
        const { multiplier, amountIn, priorActualOut } = point;
        const inputSentinel = 101n, outputSentinel = 103n, nativeSentinel = 17n;
        const tokenIn = lower(row.tokenIn), tokenOut = lower(row.tokenOut);
        const inSlot = slots.get(tokenIn)!, outSlot = slots.get(tokenOut)!;
        overrides = { [OWNER]: { balance: ethers.toQuantity(100n * 10n ** 18n) },
          [EXECUTOR]: { code: botvm.code, balance: ethers.toQuantity(nativeSentinel) },
          [tokenIn]: { stateDiff: { [inSlot]: word(amountIn + inputSentinel) } },
          ...(!args.expectedOutputError ? { [tokenOut]: { stateDiff: { [outSlot]: word(outputSentinel) } } } : {}) };
        const sample: Record<string, any> = { edgeId: row.edgeId, routeKey: route.routeKey, tokenIn, tokenOut,
          amountSource: reference ? "saved-execution-reference" : referenceInput.kind, priorActualOut,
          multiplier, amountIn, productionP: args.manual ? null : amountRow.amountIn,
          referenceAmountIn: amountRow.amountIn, targetPriceAmountIn: row.amountIn, targetPriceStatus: row.status,
          savedPriceOut: row.amountOut, borrowedInput: referenceInput.borrowed,
          runtimeConstructionRpc: 0, programHash: ethers.keccak256(leg.program), status: "failed", executions: [] };
        report.samples.push(sample);
        try {
          stage = "production-exact";
          const queryStart = queryCalls.length;
          // Match production effective's original Exact selection. A proven local
          // or hybrid method is not a chain-only get_dy helper.
          const quote = await executeFamilyExactQuote({ family, route, amountIn, source, generation: source.generation,
            executor: EXECUTOR, runtimeEvidence: [], runtime });
          sample.quote = { status: quote.status, outcome: quote.outcome, queryCalls: queryCalls.slice(queryStart) };
          assert.equal(quote.status, "resolved", "production Exact unresolved");
          if (quote.status !== "resolved") throw new Error("production Exact unresolved");
          assert(quote.amountOut > 0n); sample.quote.amountOut = quote.amountOut;
          assert(queryCalls.length > 0, "quote/state source was never read for this route");
          if (!reference && multiplier === 1n && referenceInput.expectedOut !== undefined)
            assert.equal(quote.amountOut, referenceInput.expectedOut, "fresh P quote differs from saved production price");
          const fragment = buildFamilyExecutionFragment({ family, route, exact: quote, minAmountOut: quote.amountOut,
            executor: EXECUTOR, runtimeEvidence: [], actionOwnership: catalog });
          assert.equal(fragment.status, "resolved");
          if (fragment.status !== "resolved") throw new Error("production fragment unresolved");
          // This is the SAME materializer used by production quoted construction.
          // Curve requires approve or transfer-to-pool; never discard it.
          const exactNodes = planFragmentNodes(fragment.fragment, tokenIn, amountIn);
          sample.requirements = fragment.fragment.requirements;
          const scripts: [string, Uint8Array][] = [
            ["old-fragment", concatBytes(...exactNodes.map(compile))],
            ["runtime-program", runtimeProgramScript(ethers.getBytes(leg.program), amountIn)],
          ];
          // An extra isolated-leg diagnostic does NOT change the strict quote
          // comparison. It asks whether the old encoder and runtime execute the
          // same swap when both use the runtime emitter's existing minimum (1).
          // No production setting, Ready, Exact amount or acceptance tolerance changes.
          if (args.name === "curve-underlying") {
            const diagnostic = buildFamilyExecutionFragment({ family, route, exact: quote, minAmountOut: 1n,
              executor: EXECUTOR, runtimeEvidence: [], actionOwnership: catalog });
            assert.equal(diagnostic.status, "resolved");
            if (diagnostic.status !== "resolved") throw new Error("diagnostic fragment unresolved");
            scripts.push(["quoted-minimum-1-diagnostic",
              concatBytes(...planFragmentNodes(diagnostic.fragment, tokenIn, amountIn).map(compile))]);
          }
          const allowanceCalls = [{ to: tokenIn, data: ERC20.encodeFunctionData("allowance", [EXECUTOR, args.pool]), size: 1 }];
          const readAllowances = async (state: Overrides) => {
            const result: bigint[][] = [];
            for (const check of allowanceCalls) {
              const bytes = await call(check.to, check.data, state);
              assert(ethers.isHexString(bytes, 32 * check.size));
              result.push(Array.from({ length: check.size }, (_, i) => BigInt(`0x${bytes.slice(2 + i * 64, 66 + i * 64)}`)));
            }
            return result;
          };
          assert.deepEqual(await readAllowances(overrides), [[0n]], "test actor has standing source allowances");
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
              assert.equal(await balance(tokenOut, EXECUTOR, overrides), args.expectedOutputError ? 0n : outputSentinel);
              const tx = { from: OWNER, to: EXECUTOR, data: buildExecuteCalldata(script), gas: "0x800000",
                gasPrice: ethers.toQuantity(header.baseFeePerGas!) };
              result.calldataHash = ethers.keccak256(tx.data);
              result.callTrace = await rpc("debug_traceCall", [tx, pin, { tracer: "callTracer", timeout: "30s", stateOverrides: overrides }]);
              result.evmSucceeded = !result.callTrace.error;
              if (args.expectedOutputError) {
                result.stateDiff = await rpc("debug_traceCall", [tx, pin,
                  { tracer: "prestateTracer", tracerConfig: { diffMode: true }, timeout: "30s", stateOverrides: overrides }]);
                result.rejection = assertOutputRejection({ trace: result.callTrace, diff: result.stateDiff,
                  pool: args.pool, tokenOut, expectedReason: args.expectedOutputError, tokenIn, inSlot,
                  inputBefore: amountIn + inputSentinel, nativeBefore: nativeSentinel, quotedAmountOut: quote.amountOut, requestedAmountIn: amountIn });
                result.finalAllowances = await readAllowances(overrides);
                assert.deepEqual(result.finalAllowances, [[0n]]);
                assert.equal(await balance(tokenOut, EXECUTOR, overrides), 0n);
                result.status = "state-rejected";
                continue;
              }
              assert(result.evmSucceeded, "encoded BotVM execution reverted");
              result.stateDiff = await rpc("debug_traceCall", [tx, pin,
                { tracer: "prestateTracer", tracerConfig: { diffMode: true }, timeout: "30s", stateOverrides: overrides }]);
              const diff = result.stateDiff; assert(diff?.pre && diff?.post, "independent prestate diff unavailable");
              const input = observed(diff, tokenIn, inSlot, amountIn + inputSentinel);
              const output = observed(diff, tokenOut, outSlot, outputSentinel);
              result.balances = { input, output }; // Save mismatch evidence before asserting.
              result.nativeInventory = observedNativeInventory(diff, EXECUTOR, nativeSentinel);
              result.quoteDelta = output.delta - quote.amountOut;
              assert.equal(input.delta, -amountIn); assert(output.delta > 0n);
              assert.equal(input.after, inputSentinel); assert.equal(output.after, outputSentinel + output.delta);
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
              // Curve's current contract deliberately keeps its standing ERC20
              // grant. Assert both builders preserve that policy, not Balancer's
              // temporary Permit2 cleanup policy. Tokens may decrement MAX_UINT.
              const mode = "executionMode" in definition ? String(definition.executionMode) : "exchange-underlying";
              const pulls = args.name === "curve-underlying" || pullsInput(mode as any);
              const finalAllowance = result.finalAllowances[0][0];
              assert(pulls ? finalAllowance === MAX_UINT || finalAllowance === MAX_UINT - amountIn : finalAllowance === 0n,
                "Family allowance policy mismatch");
              result.allowancePolicy = pulls ? "standing-grant" : "no-grant";

              stage = `${encoding}-no-input-control`;
              // Preserve enough OLD output for either observed or quoted output,
              // including successful underlying diagnostics with quote mismatch.
              const noInputOutput = (quote.amountOut > output.delta ? quote.amountOut : output.delta) + outputSentinel;
              const noInputOverrides = structuredClone(overrides);
              noInputOverrides[tokenIn].stateDiff![inSlot] = word(0n);
              noInputOverrides[tokenOut].stateDiff![outSlot] = word(noInputOutput);
              const control: Record<string, any> = { status: "failed", calldataHash: result.calldataHash,
                inputBefore: 0n, outputBefore: noInputOutput, nativeBefore: nativeSentinel };
              result.noInputControl = control;
              assert.equal(await balance(tokenIn, EXECUTOR, noInputOverrides), 0n);
              assert.equal(await balance(tokenOut, EXECUTOR, noInputOverrides), noInputOutput);
              // Reuse the SAME tx/calldata, source, gas and native override.
              control.callTrace = await rpc("debug_traceCall", [tx, pin,
                { tracer: "callTracer", timeout: "30s", stateOverrides: noInputOverrides }]);
              control.stateDiff = await rpc("debug_traceCall", [tx, pin,
                { tracer: "prestateTracer", tracerConfig: { diffMode: true }, timeout: "30s", stateOverrides: noInputOverrides }]);
              const failedPost = structuredClone(noInputOverrides);
              for (const [token, keys] of allowanceSlots) {
                const preStorage = storage(control.stateDiff, "pre", token), postStorage = storage(control.stateDiff, "post", token);
                const changes = failedPost[token] ??= {}; changes.stateDiff ??= {};
                for (const key of keys) {
                  if (key in postStorage) changes.stateDiff[key] = postStorage[key];
                  else if (key in preStorage) changes.stateDiff[key] = word(0n);
                }
              }
              control.finalAllowances = await readAllowances(failedPost);
              control.balances = assertNoInputRollback({ trace: control.callTrace, diff: control.stateDiff,
                tokenIn, inSlot, tokenOut, outSlot, outputBefore: noInputOutput,
                nativeBefore: nativeSentinel, finalAllowances: control.finalAllowances });
              control.status = "pass";
              stage = encoding;
              result.oldInventoryConsumed = 0n; result.executionChecks = "pass";
              if (encoding !== "quoted-minimum-1-diagnostic") assert.equal(output.delta, quote.amountOut,
                "exact quote and independently observed output differ (no tolerance)");
              if (priorActualOut !== undefined) assert.equal(output.delta, priorActualOut,
                "same historical input produced a different actual output");
              result.status = "pass";
            } catch (error) { result.error = failure(error); }
          }
          if (args.expectedOutputError) {
            assert(sample.executions.length === scripts.length &&
              sample.executions.every((e: any) => e.status === "state-rejected"));
            sample.status = "state-rejected";
            continue;
          }
          if (args.name === "curve-underlying") {
            const actual = sample.executions.find((e: any) => e.encoding === "runtime-program");
            const diagnostic = sample.executions.find((e: any) => e.encoding === "quoted-minimum-1-diagnostic");
            assert.equal(actual.executionChecks, "pass"); assert.equal(diagnostic.executionChecks, "pass");
            assert.deepEqual(actual.balances, diagnostic.balances, "runtime/quoted encoder output differs");
            assert.deepEqual(actual.finalAllowances, diagnostic.finalAllowances, "runtime/quoted allowance differs");
            sample.executionEncodingParity = "pass"; // Separate from quote correctness below.
          }
          assert(sample.executions.length === scripts.length && sample.executions.every((e: any) => e.status === "pass"));
          assert.deepEqual(sample.executions[0].finalAllowances, sample.executions[1].finalAllowances,
            "quoted/runtime allowance policy differs");
          sample.status = "pass";
        } catch (error) { sample.error = failure(error); }
        abort.signal.throwIfAborted();
      }
    }
    stage = "final-pins";
    report.headerAfter = await headerCheck();
    for (const token of tokens) assert.equal(await balance(token, EXECUTOR), 0n, "trace persisted state");
    assert.equal(await rpc("eth_getCode", [EXECUTOR, pin]), "0x", "actor code override persisted");
    assert.equal(sha(readFileSync(args.ready)), report.inputs.readySha256);
    assert.equal(sha(readFileSync(args.prices)), report.inputs.pricesSha256);
    if (args.priceInput) assert.equal(sha(readFileSync(args.priceInput)), report.priceInput.sha256);
    assert.deepEqual(donorPins(), donorInputPins, "donor input files changed during test");
    assert.deepEqual(sourcePin(args.name), startPin, "source/code changed during test");
    assert.equal(constructionAttempts, 0);
    assert(report.samples.length === report.expectedSamples && report.samples.every((s: any) => s.status === (args.expectedOutputError ? "state-rejected" : "pass")),
      "one or more samples failed; retained in receipt");
    report.result = args.expectedOutputError ? "state-rejected" : "pass";
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
    noInputControlsPassed: report.samples.flatMap((s: any) => s.executions).filter((e: any) => e.noInputControl?.status === "pass").length,
    out: args.out, forkStopped: report.forkStopped }));
  if (report.result !== "pass" && report.result !== "state-rejected") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).includes("--help")) console.log("--ready FILE --prices FILE --pool ADDRESS --family curve-plain|curve-underlying --rpc-file FILE --out NEW_IGNORED_JSON --port 8591 [--executor-hardfork cancun] [--price-input INPUT_JSON] [--reference-executions SAVED_JSON | --reference-prices PRICES_JSON --reference-edges JSON_ARRAY | --manual-input JSON_TOKEN_PAIR_AND_AMOUNT] [--expect-output-error EXACT_REASON]");
  else main().catch(() => { console.error("historical-runtime-dual: input/output setup failed; no RPC started if no receipt was reserved"); process.exitCode = 1; });
}
