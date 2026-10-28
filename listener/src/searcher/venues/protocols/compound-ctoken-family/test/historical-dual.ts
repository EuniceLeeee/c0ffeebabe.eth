// Opt-in historical quote/ENCODING diagnostic, not dual-execution acceptance.
// N-end eth_call is not the original redemption's pre-call state. The quoted
// and runtime programs below are compiled, NOT executed: their output/minimum
// fields are not measured receipts. Same-state dual execution requires a
// separate EVM run; this read-only RPC harness cannot establish it.
//
// Read-only archive RPC only: no anvil fork, no signing, no broadcast, no
// submission, no pool/flag/edge/hash insertion. Every reported integer is
// either read from the chain inside this run or produced by a production code
// path; an unread number is reported as unread.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { concatBytes } from "../../../../../encoder.js";
import { parseAtBlockJson } from "../../../../blockscan-at-block-cli.js";
import { createAdapterFamilyExactQuoteCache } from "../../../../adapter-family-exact-quote-cache.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { resolveStrictReadyRuntime } from "../../../../strict-ready-runtime.js";
import { UniverseRebuildCheckpointStore, activeReadyMemos } from "../../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring, familyDefinitionHash, familyMemoDefinitionHash } from "../../../../universe-rebuild-production.js";
import { planFragmentNodes } from "../../../../solver/plan-fragment-requirements.js";
import { assertIssuedPreparedFamilyInstance, buildFamilyExecutionFragment, buildFamilyRuntimeAmountLeg,
  executeFamilyExactQuote, type PreparedFamilyInstance } from "../../../adapter-family-runtime.js";
import { asPricedFamily } from "../../../family-capability-catalog.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../../../production-infra-actions.js";
import { CTOKEN_INTERFACE, CTOKEN_REDEEM_TOPIC } from "../abi.js";
import { CTOKEN_FAMILY_ID as ID } from "../manifest.js";
import type { CompoundCTokenDescriptor, CompoundCTokenRoute } from "../types.js";
import { assertAnchors, classifyRedeemLog, runtimeScriptEnvelope, successfulRedeemCalls, type RedeemCall } from "./history-evidence.js";

/** Argument layout comes from the OBSERVED log shape, never from a declaration. */
const REDEEM_PLAIN = new ethers.Interface(["event Redeem(address redeemer,uint256 redeemAmount,uint256 redeemTokens)"]);
const REDEEM_INDEXED = new ethers.Interface(["event Redeem(address indexed redeemer,uint256 redeemAmount,uint256 redeemTokens)"]);
assert.equal(REDEEM_PLAIN.getEvent("Redeem")!.topicHash.toLowerCase(), CTOKEN_REDEEM_TOPIC);
assert.equal(REDEEM_INDEXED.getEvent("Redeem")!.topicHash.toLowerCase(), CTOKEN_REDEEM_TOPIC);

const json = (value: unknown) => JSON.stringify(value, (_k, v) => typeof v === "bigint" ? v.toString() : v, 1);
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function main() {
  // Mirror the univ1 historical harnesses' CLI discipline: exhaustive paired
  // arguments, no unknown key, no repeat, no `--` value, no output overwrite.
  const values = new Map<string, string>();
  const names = ["--ready", "--prices", "--rpc-file", "--out"];
  for (let n = 2; n < process.argv.length; n += 2) {
    const key = process.argv[n]!, value = process.argv[n + 1];
    assert(names.includes(key) && !values.has(key) && value && !value.startsWith("--"));
    values.set(key, value);
  }
  assert.equal(values.size, names.length);
  const out = resolve(values.get("--out")!);
  const fd = openSync(out, "wx", 0o600);
  const report: any = {
    result: "failed", rows: [], errors: [],
    claim: "N-end quote and production encoding only; no historical encoded execution, no same-state TX parity, no EV or acceptance claim",
    historicalDualExecution: "NOT RUN",
    safety: { signing: false, broadcast: false, remoteSubmission: false, fork: false,
      writes: "one 0600 report file; no pool, admitted flag, graph edge or Ready hash inserted" },
  };
  const abort = new AbortController();
  const deadline = Date.now() + 300_000;
  const timer = setTimeout(() => abort.abort(new Error("historical dual deadline")), 300_000);
  const interrupt = () => abort.abort(new Error("historical dual interrupted"));
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  let secret = "", stage = "inputs", calls = 0;
  const redact = (v: unknown) => String(v instanceof Error ? v.message : v)
    .split(secret || "\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
  const failure = (e: unknown) => ({ stage, message: redact(e) });
  // Pin the family's own source and this harness across the run: a read-only
  // harness must still prove the code it measured did not move underneath it.
  const pinFamily = () => {
    const dir = resolve(import.meta.dirname, "..");
    const files = readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith(".ts"))
      .map(e => e.name).sort();
    return { files: files.map(name => ({ name, sha256: sha256(readFileSync(resolve(dir, name))) })),
      harnessSha256: sha256(readFileSync(import.meta.filename)),
      evidenceHelperSha256: sha256(readFileSync(resolve(import.meta.dirname, "history-evidence.ts"))) };
  };

  try {
    const initialPin = pinFamily();
    report.familySourcePin = initialPin;
    const readyPath = realpathSync(values.get("--ready")!);
    const pricePath = realpathSync(values.get("--prices")!);
    const provenancePath = resolve(pricePath, "..", "input.json");
    const inputPaths = [readyPath, pricePath, provenancePath];
    const inputHashes = () => inputPaths.map(path => ({ path, sha256: sha256(readFileSync(path)) }));
    report.inputHashes = inputHashes();

    const saved = parseAtBlockJson(readFileSync(pricePath, "utf8"));
    const provenance = parseAtBlockJson(readFileSync(provenancePath, "utf8"));
    assert.equal(realpathSync(provenance.readyPath), readyPath);
    assert.equal(provenance.readySha256, report.inputHashes[0]!.sha256);
    assert.equal(provenance.broadcast, false);
    assert.equal(provenance.through, "prices");
    assert.equal(provenance.executionMode, "source-block");
    const executor = ethers.getAddress(provenance.executor).toLowerCase();
    const owner = ethers.getAddress(provenance.owner).toLowerCase();
    report.actors = { executor, owner, source: "prices/input.json" };

    const envelope = await new UniverseRebuildCheckpointStore({ path: readyPath }).load();
    assert(envelope && !envelope.inProgressRun, "a completed Ready checkpoint is required");
    const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration);
    const source = ready.cutoff;
    const pin = { blockHash: source.hash, requireCanonical: true };
    const block = source.number;
    report.source = source;
    report.graphHash = ready.graphHash;
    assertAnchors(source, saved, provenance);

    stage = "strict-admission";
    const wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1/read-only",
      familyIds: [ID], executionIdentity: { executor, transactionOrigin: owner } });
    const family = asPricedFamily(catalog.forStrictFamily(ID));
    const instances = activeReadyMemos(envelope)
      .filter(memo => memo.familyId === ID && memo.candidateSnapshot !== null)
      .map(memo => {
        assert([familyDefinitionHash(ID), familyMemoDefinitionHash(ID)].includes(memo.familyDefinitionHash));
        const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: source }) as Omit<PreparedFamilyInstance, "descriptor" | "routes"> & {
          readonly descriptor: CompoundCTokenDescriptor; readonly routes: readonly CompoundCTokenRoute[];
        };
        assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
        assert(instance.descriptor.redemptionPathVerified === true);
        return { memo, instance, market: String(instance.descriptor.market).toLowerCase() };
      });
    assert(instances.length > 0, "no admitted compound cToken instance in Ready");
    report.instances = instances.map(i => ({ market: i.market, underlying: i.instance.descriptor.underlying,
      share: i.instance.descriptor.share, decimals: i.instance.descriptor.decimals,
      instanceKey: i.instance.instanceKey, routeKeys: i.instance.routes.map(r => r.routeKey) }));
    // The saved price artifact is context, not evidence: report what it holds
    // for these markets without treating a saved row as a fresh measurement.
    const pricing = saved.runtime?.pricing;
    const effectiveRows = pricing?.effectiveMids?.rows;
    const effectiveList = effectiveRows instanceof Map ? [...effectiveRows.values()]
      : Array.isArray(effectiveRows) ? effectiveRows
      : effectiveRows && typeof effectiveRows === "object" ? Object.values(effectiveRows) : [];
    const rawEntries = Array.isArray(pricing?.mids?.entries) ? pricing.mids.entries : [];
    const mentions = (list: any[]) => list.filter(r => {
      const text = json(r).toLowerCase();
      return instances.some(i => text.includes(i.market) || text.includes(String(i.instance.descriptor.underlying).toLowerCase()));
    }).length;
    report.pricesArtifact = { rawMidEntries: rawEntries.length, effectiveRows: effectiveList.length,
      rawMidEntriesMentioningAdmittedMarkets: mentions(rawEntries),
      effectiveRowsMentioningAdmittedMarkets: mentions(effectiveList),
      incompleteFamilyIds: pricing?.incompleteFamilyIds, resolvedFamilyIds: pricing?.resolvedFamilyIds,
      note: "saved N-end-state price artifact, reported for provenance only" };

    secret = JSON.parse(readFileSync(values.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL;
    assert(typeof secret === "string" && /^https?:\/\//.test(secret));
    const allowed = new Set(["web3_clientVersion", "eth_chainId", "eth_getBlockByNumber", "eth_call", "eth_getCode", "eth_getStorageAt",
      "eth_getLogs", "eth_getTransactionReceipt", "debug_traceTransaction"]);
    const rpc = async (method: string, params: unknown[]): Promise<any> => {
      assert(allowed.has(method), `unallowlisted RPC method ${method}`);
      abort.signal.throwIfAborted();
      assert(++calls <= 400 && Date.now() < deadline, "read budget exceeded");
      const res = await fetch(secret, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: calls, method, params }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) });
      assert(res.ok, `${method}: HTTP ${res.status}`);
      const body: any = await res.json();
      if (body.error) throw new Error(`${method}: ${body.error.code} ${redact(body.error.message)}`);
      return body.result;
    };
    assert.equal(BigInt(await rpc("eth_chainId", [])), 1n);
    const header = await rpc("eth_getBlockByNumber", [ethers.toQuantity(block), false]);
    assert.equal(header.hash, source.hash, "archive RPC canonical block hash differs from Ready cutoff");

    const marketSet = new Set(instances.map(i => i.market));

    // ---- Integer 4: the block's real on-chain Redeem integers ---------------
    stage = "on-chain-redeem-logs";
    const logs = await rpc("eth_getLogs", [{ fromBlock: ethers.toQuantity(block),
      toBlock: ethers.toQuantity(block), topics: [CTOKEN_REDEEM_TOPIC] }]);
    const onChain: any[] = [];
    for (const log of logs) {
      const emitter = String(log.address).toLowerCase();
      const topics: string[] = [...(log.topics ?? [])];
      const dataBytes = ethers.getBytes(log.data).length;
      const shape = topics.length === 1 && dataBytes === 96 ? "no-indexed-params"
        : topics.length === 2 && dataBytes === 64 ? "redeemer-indexed" : "undecodable";
      const row: any = { tx: log.transactionHash, logIndex: Number(BigInt(log.logIndex)), emitter,
        inAdmittedInstanceSet: marketSet.has(emitter), topics: topics.length, dataBytes, shape };
      if (shape !== "undecodable") {
        const decoded = (shape === "no-indexed-params" ? REDEEM_PLAIN : REDEEM_INDEXED)
          .decodeEventLog("Redeem", log.data, topics);
        row.redeemer = decoded.redeemer;
        row.redeemAmount = BigInt(decoded.redeemAmount);
        row.redeemTokens = BigInt(decoded.redeemTokens);
      }
      onChain.push(row);
    }
    assert(onChain.length > 0, "no Redeem log at this block to compare against");
    // Classify the INTERFACE each emitting transaction actually called. The
    // Redeem event alone cannot distinguish the two redemption interfaces.
    const interfaces = new Map<string, { calls: RedeemCall[] }>();
    for (const tx of [...new Set<string>(onChain.map(r => r.tx))]) {
      const receipt = await rpc("eth_getTransactionReceipt", [tx]);
      assert.equal(BigInt(receipt.status), 1n);
      assert.equal(String(receipt.transactionHash).toLowerCase(), tx.toLowerCase());
      assert.equal(String(receipt.blockHash).toLowerCase(), source.hash.toLowerCase());
      assert.equal(Number(BigInt(receipt.blockNumber)), block);
      for (const row of onChain.filter(r => r.tx === tx)) {
        assert(receipt.logs.some((log: any) => Number(BigInt(log.logIndex)) === row.logIndex &&
          String(log.address).toLowerCase() === row.emitter && String(log.topics?.[0]).toLowerCase() === CTOKEN_REDEEM_TOPIC));
      }
      const traced = await rpc("debug_traceTransaction", [tx, { tracer: "callTracer" }]);
      interfaces.set(tx, { calls: successfulRedeemCalls(traced, marketSet) });
    }
    for (const row of onChain) row.interfaceUsed = classifyRedeemLog(row, interfaces.get(row.tx)?.calls ?? [],
      onChain.filter(r => r.tx === row.tx && r.emitter === row.emitter).length);
    const shareInput = onChain.filter(r => r.interfaceUsed === "share-input");
    const underlyingInput = onChain.filter(r => r.interfaceUsed === "underlying-output");
    report.onChain = {
      block, blockHash: source.hash, logCount: onChain.length,
      emitters: [...new Set(onChain.map(r => r.emitter))],
      transactions: [...interfaces.entries()].map(([tx, v]) => ({ tx,
        cTokenRedemptionCalls: v.calls.map(c => ({ market: c.to, caller: c.from,
          interface: c.method, argument: c.argument })) })),
      emitted: onChain.map(r => ({ emitter: r.emitter, tx: r.tx, logIndex: r.logIndex, shape: r.shape,
        redeemer: r.redeemer, redeemAmount: r.redeemAmount, redeemTokens: r.redeemTokens,
        interfaceUsed: r.interfaceUsed })),
      rowsUsingShareInputInterface: shareInput.length,
      rowsUsingUnderlyingOutputInterface: underlyingInput.length,
      source: "archive RPC eth_getLogs + debug_traceTransaction (callTracer) at the pinned blockHash",
    };

    // ---- production runtime harness over read-only archive RPC --------------
    stage = "runtime";
    const cache = createAdapterFamilyExactQuoteCache();
    if (typeof (cache as any).advanceState === "function") (cache as any).advanceState(source);
    const reads: string[] = [];
    const runtime = createStrictCentralAdapterRuntime({
      executor, transactionOrigin: owner, exactQuoteCache: cache,
      generationFence: { assertCurrent(g: number, s: unknown) {
        assert.equal(g, source.generation); assert.deepEqual(s, source); } },
      provider: {
        async call(tx: any, b: unknown) { assert.equal(b, block); reads.push(`call:${tx.to}:${String(tx.data).slice(0, 10)}`);
          return rpc("eth_call", [tx, pin]); },
        async getCode(a: string, b: unknown) { assert.equal(b, block); reads.push(`code:${a}`);
          return rpc("eth_getCode", [a, pin]); },
        async getStorage(a: string, k: string, b: unknown) { assert.equal(b, block); reads.push(`storage:${a}:${k}`);
          return rpc("eth_getStorageAt", [a, k, pin]); },
      },
    });

    stage = "dual-interface";
    for (const { instance, market } of instances) {
      const route = instance.routes.find(r => r.direction === "redeem"
        && String(r.tokenIn).toLowerCase() === String(instance.descriptor.share).toLowerCase());
      assert(route, `no routed share-input redeem direction for ${market}`);
      const handles = instance.routeHandles.filter(h => h.routeKey === route.routeKey);
      assert.equal(handles.length, 1, "route handle must be unique");
      const edges = graph.filter(e => e.instanceKey === instance.instanceKey);
      assert(edges.length >= 1, "admitted market must carry a graph edge");
      const usages = onChain.filter(r => r.emitter === market && r.redeemTokens > 0n);
      for (const usage of usages) {
        const amountIn = usage.redeemTokens;
        const row: any = { market, underlying: instance.descriptor.underlying,
          share: instance.descriptor.share, routeKey: route.routeKey, graphEdgesForInstance: edges.length,
          statedShareAmount: amountIn, statedShareAmountSource: "archive RPC Redeem log redeemTokens (real burned shares)",
          quantityOfAdmittedInstances: instances.length };
        // (1) production specified-amount quote
        const quote = await executeFamilyExactQuote({ family, route: handles[0]!, amountIn, source,
          generation: source.generation, executor, runtimeEvidence: [], runtime,
          control: { signal: abort.signal, deadlineAtMs: deadline } });
        assert.equal(quote.status, "resolved", "production specified-amount quote did not resolve");
        const resolved = quote as Extract<typeof quote, { amountOut: bigint }>;
        assert.equal(resolved.amountIn, amountIn);
        assert(resolved.amountOut > 0n);
        row.integer1_quotedAmountOut = { value: resolved.amountOut, amountIn: resolved.amountIn,
          artifact: "production exact.methods request program over archive-RPC eth_call at the pinned blockHash",
          evidence: (resolved as any).evidenceRefs };
        // (2) production quoted fragment encoding
        const fragment = buildFamilyExecutionFragment({ family, route: handles[0]!, exact: quote as never,
          minAmountOut: resolved.amountOut, executor, runtimeEvidence: [], actionOwnership: catalog });
        assert.equal(fragment.status, "resolved", "quoted fragment did not build");
        const frag = (fragment as any).fragment;
        assert.equal(frag.nodes.length, 1);
        const node = frag.nodes[0];
        const adapters = [...(family as any).plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
        const compile = (n: any): Uint8Array => {
          const adapter = adapters.find((a: any) => a.id === n.adapterId); assert(adapter);
          return adapter.encode(n, executor, concatBytes(...n.children.map(compile)));
        };
        const planned = planFragmentNodes(frag, route.tokenIn, amountIn);
        const script = concatBytes(...planned.map(compile));
        const encoded = runtimeScriptEnvelope(script);
        assert.equal(encoded.amount, amountIn);
        row.integer2_quotedFragmentEncoding = {
          artifact: "production execution.buildFragment + the family's own action adapter + planFragmentNodes",
          plannedAdapters: planned.map((n: any) => n.adapterId), requirements: frag.requirements.length,
          amountField: node.amount, minAmountOutField: node.params.minUnderlyingOut,
          rateSourceField: node.params.rateSource,
          encodedInitialAmount: encoded.amount, programBytes: encoded.length,
          scriptKeccak256: ethers.keccak256(script),
          actualReceived: null, execution: "NOT RUN: encoding is not a receipt",
        };
        // (3) production runtime-actual leg, built under a construction guard:
        // a throwing getter on every amount-ish key and a runtime proxy that
        // throws on any service access proves no quote result is an input.
        let amountAccesses = 0, serviceAccesses = 0;
        const guarded = new Proxy(runtime as any, { get(target, property, receiver) {
          if (!["callerAuthority", "generationFence"].includes(String(property))) {
            serviceAccesses++; throw new Error("runtime service touched during runtime-leg construction");
          }
          return Reflect.get(target, property, receiver); } });
        const legInput: Record<string, unknown> = { family, route: handles[0]!, source, runtime: guarded,
          executor, runtimeEvidence: [], actionOwnership: catalog };
        for (const key of ["amountIn", "amountOut", "quotedAmountOut", "minAmountOut", "exact", "exactEvidence"]) {
          Object.defineProperty(legInput, key, { get() { amountAccesses++;
            throw new Error("quoted amount touched during runtime-leg construction"); } });
        }
        const leg = buildFamilyRuntimeAmountLeg(legInput as never);
        assert(leg, "runtime leg decline is not a pass");
        assert.equal(amountAccesses, 0);
        assert.equal(serviceAccesses, 0);
        row.integer3_runtimeActualLeg = {
          artifact: "production execution.buildRuntimeLeg through buildFamilyRuntimeAmountLeg",
          actionAdapterId: leg.actionAdapterId, programKeccak256: ethers.keccak256(leg.program),
          programHex: leg.program, amountAccesses, serviceAccesses, quotedAmountTouched: false,
          actualReceived: null, execution: "NOT RUN: construction guard proves no quote input, not actual receipt/next-hop consumption",
        };
        // (4) real on-chain integers, classified by interface
        row.integer4_onChainRedeem = {
          artifact: "archive RPC eth_getLogs + debug_traceTransaction at the pinned block",
          tx: usage.tx, logIndex: usage.logIndex, emitter: usage.emitter, redeemer: usage.redeemer,
          redeemAmount: usage.redeemAmount, redeemTokens: usage.redeemTokens,
          interfaceUsed: usage.interfaceUsed,
          isShareInputRedemption: usage.interfaceUsed === "share-input",
        };
        // Explicitly NOT parity: quantify the difference but never label it equal.
        const shareInputComparable = usage.interfaceUsed === "share-input";
        row.comparison = {
          sameState: false,
          onChainInterfaceIsShareInput: shareInputComparable,
          signedDeltaQuotedMinusOnChain: resolved.amountOut - usage.redeemAmount,
          verdict: "NOT SAME STATE: original call pre-state/prefix was not restored; N-end quote minus receipt is descriptive, not quote accuracy",
          reconciliationNote: shareInputComparable ? "same interface, different state" : "different or unverified interface as well as different state",
        };
        report.rows.push(row);
      }
    }

    report.sameStateShareInputComparison = {
      verified: false, verdict: "NOT RUN",
      missingEvidence: ["original call pre-state and prefix not restored", "quoted/runtime encoded programs not executed"],
      scope: `block ${block}; all ${report.onChain.logCount} Redeem logs at this block enumerated and every emitting transaction traced`,
    };
    report.chainReads = reads.length;
    report.rpcCalls = calls;
    assert(report.rows.length > 0, "no admitted market encoding observations");
    report.result = "encoding-only";
  } catch (error) {
    report.errors.push(failure(error));
  } finally {
    stage = "final-pins";
    try { assert.deepEqual(pinFamily(), report.familySourcePin); }
    catch (e) { report.errors.push(failure(e)); report.result = "failed"; }
    try {
      assert(Array.isArray(report.inputHashes) && report.inputHashes.length === 3);
      assert.deepEqual(report.inputHashes.map((h: any) => ({ path: h.path, sha256: sha256(readFileSync(h.path)) })),
        report.inputHashes);
    } catch (e) { report.errors.push(failure(e)); report.result = "failed"; }
    clearTimeout(timer);
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    try { writeFileSync(fd, redact(json(report)) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  }
  console.log(json({ result: report.result, rows: report.rows.length,
    onChainRedeemLogs: report.onChain?.logCount, shareInputRows: report.onChain?.rowsUsingShareInputInterface,
    underlyingOutputRows: report.onChain?.rowsUsingUnderlyingOutputInterface,
    sameStateShareInputComparison: report.sameStateShareInputComparison?.verdict, out,
    errors: report.errors }));
  for (const row of report.rows) {
    console.log(json({ market: row.market, statedShareAmount: row.statedShareAmount,
      integer1_quotedAmountOut: row.integer1_quotedAmountOut.value,
      integer2_encodedInitialAmount: row.integer2_quotedFragmentEncoding.encodedInitialAmount,
      integer2_minAmountOut: row.integer2_quotedFragmentEncoding.minAmountOutField,
      integer3_amountAccesses: row.integer3_runtimeActualLeg.amountAccesses,
      integer3_serviceAccesses: row.integer3_runtimeActualLeg.serviceAccesses,
      integer4_redeemAmount: row.integer4_onChainRedeem.redeemAmount,
      integer4_redeemTokens: row.integer4_onChainRedeem.redeemTokens,
      integer4_interfaceUsed: row.integer4_onChainRedeem.interfaceUsed,
      signedDeltaQuotedMinusOnChain: row.comparison.signedDeltaQuotedMinusOnChain,
      onChainInterfaceIsShareInput: row.comparison.onChainInterfaceIsShareInput }));
  }
  if (report.result !== "encoding-only") process.exitCode = 1;
}
main().catch(() => {
  console.error("compound cToken historical-dual invalid input; existing files not overwritten");
  process.exitCode = 1;
});
