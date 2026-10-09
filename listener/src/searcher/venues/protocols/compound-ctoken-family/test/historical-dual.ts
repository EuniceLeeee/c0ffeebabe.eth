// Opt-in same-block dual-interface evidence for the Compound cToken family.
//
// For ONE pinned block this drives the family's production specified-amount
// quote, its production quoted-fragment encoding and its production
// runtime-actual leg, and reports the four integers side by side with the
// block's real on-chain `Redeem` integers, naming the artifact each came from.
//
// It exists to answer one question with integers instead of prose: at this
// block, is the family's share-input `redeem` route comparable, state for
// state, against a real share-input redemption? The on-chain leg is therefore
// CLASSIFIED by tracing the emitting transaction, because
// `redeemUnderlying(uint256)` emits the very same `Redeem` event as
// `redeem(uint256)`. An underlying-output integer is never presented here as
// share-input parity, and quote-vs-quote is never presented as on-chain parity.
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
import { ID } from "../manifest.js";

/** Argument layout comes from the OBSERVED log shape, never from a declaration. */
const REDEEM_PLAIN = new ethers.Interface(["event Redeem(address redeemer,uint256 redeemAmount,uint256 redeemTokens)"]);
const REDEEM_INDEXED = new ethers.Interface(["event Redeem(address indexed redeemer,uint256 redeemAmount,uint256 redeemTokens)"]);
assert.equal(REDEEM_PLAIN.getEvent("Redeem")!.topicHash.toLowerCase(), CTOKEN_REDEEM_TOPIC);
assert.equal(REDEEM_INDEXED.getEvent("Redeem")!.topicHash.toLowerCase(), CTOKEN_REDEEM_TOPIC);
const REDEEM_SELECTOR = CTOKEN_INTERFACE.getFunction("redeem")!.selector.toLowerCase();
const REDEEM_UNDERLYING_SELECTOR = CTOKEN_INTERFACE.getFunction("redeemUnderlying")!.selector.toLowerCase();

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
    claim: "same-block, N end-state dual-interface integers for the family's share-input redeem route; NOT pre-call parity, NOT route EV, NOT an acceptance or ranking claim",
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
      harnessSha256: sha256(readFileSync(import.meta.filename)) };
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
    for (const [kind, observed] of [["prices.runtime.sourceBlock", saved.runtime?.sourceBlock],
      ["prices.runtime.sourceBlockHash", saved.runtime?.sourceBlockHash],
      ["provenance.stateSource.number", provenance.stateSource?.number],
      ["provenance.stateSource.hash", provenance.stateSource?.hash]]) {
      assert.equal(observed, kind.endsWith("Hash") ? source.hash : source.number, `${kind} mismatch`);
    }
    assert.equal(Number(BigInt(provenance.sourceHeader.number)), source.number);

    stage = "strict-admission";
    const wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1/read-only",
      familyIds: [ID], executionIdentity: { executor, transactionOrigin: owner } });
    const family = asPricedFamily(catalog.forStrictFamily(ID));
    const instances = activeReadyMemos(envelope)
      .filter(memo => memo.familyId === ID && memo.candidateSnapshot !== null)
      .map(memo => {
        assert([familyDefinitionHash(ID), familyMemoDefinitionHash(ID)].includes(memo.familyDefinitionHash));
        const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: source }) as PreparedFamilyInstance;
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
      const text = JSON.stringify(r).toLowerCase();
      return instances.some(i => text.includes(i.market) || text.includes(String(i.instance.descriptor.underlying).toLowerCase()));
    }).length;
    report.pricesArtifact = { rawMidEntries: rawEntries.length, effectiveRows: effectiveList.length,
      rawMidEntriesMentioningAdmittedMarkets: mentions(rawEntries),
      effectiveRowsMentioningAdmittedMarkets: mentions(effectiveList),
      incompleteFamilyIds: pricing?.incompleteFamilyIds, resolvedFamilyIds: pricing?.resolvedFamilyIds,
      note: "saved N-end-state price artifact, reported for provenance only" };

    secret = JSON.parse(readFileSync(values.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL;
    assert(typeof secret === "string" && /^https?:\/\//.test(secret));
    const allowed = new Set(["web3_clientVersion", "eth_chainId", "eth_getBlockByNumber", "eth_call",
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
    const uint = (hex: string, index: number) => BigInt(ethers.dataSlice(hex, 32 * index, 32 * index + 32));

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
    const interfaces = new Map<string, { calls: { to: string; selector: string; argument: bigint }[] }>();
    for (const tx of [...new Set<string>(onChain.map(r => r.tx))]) {
      const traced = await rpc("debug_traceTransaction", [tx, { tracer: "callTracer" }]);
      const found: { to: string; selector: string; argument: bigint }[] = [];
      const walk = (frame: any): void => {
        if (!frame || typeof frame !== "object") return;
        const to = String(frame.to ?? "").toLowerCase();
        const input = String(frame.input ?? "");
        if (marketSet.has(to) && input.length >= 10) {
          const selector = input.slice(0, 10).toLowerCase();
          if (selector === REDEEM_SELECTOR || selector === REDEEM_UNDERLYING_SELECTOR) {
            found.push({ to, selector, argument: uint(input, 0) });
          }
        }
        for (const child of frame.calls ?? []) walk(child);
      };
      walk(traced);
      interfaces.set(tx, { calls: found });
    }
    const shareInput = onChain.filter(r => (interfaces.get(r.tx)?.calls ?? [])
      .some(c => c.to === r.emitter && c.selector === REDEEM_SELECTOR));
    const underlyingInput = onChain.filter(r => (interfaces.get(r.tx)?.calls ?? [])
      .some(c => c.to === r.emitter && c.selector === REDEEM_UNDERLYING_SELECTOR));
    report.onChain = {
      block, blockHash: source.hash, logCount: onChain.length,
      emitters: [...new Set(onChain.map(r => r.emitter))],
      transactions: [...interfaces.entries()].map(([tx, v]) => ({ tx,
        cTokenRedemptionCalls: v.calls.map(c => ({ market: c.to,
          interface: c.selector === REDEEM_SELECTOR ? "redeem(uint256) share-input"
            : "redeemUnderlying(uint256) underlying-output", selector: c.selector, argument: c.argument })) })),
      emitted: onChain.map(r => ({ emitter: r.emitter, tx: r.tx, logIndex: r.logIndex, shape: r.shape,
        redeemer: r.redeemer, redeemAmount: r.redeemAmount, redeemTokens: r.redeemTokens,
        interfaceUsed: (interfaces.get(r.tx)?.calls ?? []).some(c => c.to === r.emitter && c.selector === REDEEM_SELECTOR)
          ? "redeem(uint256) share-input" : "redeemUnderlying(uint256) underlying-output" })),
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
        const payloadLength = (script[21]! << 16) | (script[22]! << 8) | script[23]!;
        const payload = ethers.hexlify(script.slice(24, 24 + payloadLength));
        row.integer2_quotedFragmentEncoding = {
          artifact: "production execution.buildFragment + the family's own action adapter + planFragmentNodes",
          plannedAdapters: planned.map((n: any) => n.adapterId), requirements: frag.requirements.length,
          amountField: node.amount, minAmountOutField: node.params.minUnderlyingOut,
          rateSourceField: node.params.rateSource,
          encodedSelector: payload.slice(0, 10),
          encodedArgument: CTOKEN_INTERFACE.decodeFunctionData("redeem", payload)[0],
          scriptSha256: ethers.keccak256(script),
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
        const program = ethers.getBytes(leg.program);
        const patchCountOffset = 2 + 20 + 1 + 1 + 3 + 3;
        const patchCount = program[patchCountOffset]!;
        const patches = Array.from({ length: patchCount }, (_v, i) => {
          const b = patchCountOffset + 1 + i * 4;
          return { offset: (program[b]! << 16) | (program[b + 1]! << 8) | program[b + 2]!, reg: program[b + 3]! };
        });
        const calldataLen = (program[program.length - 39]! << 16) | (program[program.length - 38]! << 8)
          | program[program.length - 37]!;
        const embedded = ethers.hexlify(program.slice(program.length - calldataLen));
        assert.equal(embedded.slice(0, 10), REDEEM_SELECTOR, "runtime leg must call the routed share-input interface");
        assert.deepEqual(patches, [{ offset: 4, reg: 0 }]);
        assert.equal(amountAccesses, 0);
        assert.equal(serviceAccesses, 0);
        row.integer3_runtimeActualLeg = {
          artifact: "production execution.buildRuntimeLeg through buildFamilyRuntimeAmountLeg",
          actionAdapterId: leg.actionAdapterId, programSha256: ethers.keccak256(leg.program),
          programHex: leg.program, embeddedSelector: embedded.slice(0, 10),
          embeddedArgumentPlaceholder: CTOKEN_INTERFACE.decodeFunctionData("redeem", embedded)[0],
          patches, amountAccesses, serviceAccesses, quotedAmountTouched: false,
          consumesPreviousHopActual: patches.some(p => p.offset === 4 && p.reg === 0),
          consumptionNote: "the first ABI argument word (offset 4) is patched from register r0, which the enclosing runtime flow primes with the previous hop's actually-received cToken amount; the embedded placeholder is 0, so no quoted amount is an input",
        };
        // (4) real on-chain integers, classified by interface
        row.integer4_onChainRedeem = {
          artifact: "archive RPC eth_getLogs + debug_traceTransaction at the pinned block",
          tx: usage.tx, logIndex: usage.logIndex, emitter: usage.emitter, redeemer: usage.redeemer,
          redeemAmount: usage.redeemAmount, redeemTokens: usage.redeemTokens,
          interfaceUsed: usage.interfaceUsed,
          isShareInputRedemption: usage.interfaceUsed === "redeem(uint256) share-input",
        };
        // Explicitly NOT parity: quantify the difference but never label it equal.
        const shareInputComparable = usage.interfaceUsed === "redeem(uint256) share-input";
        row.comparison = {
          sameState: true,
          onChainInterfaceIsShareInput: shareInputComparable,
          signedDeltaQuotedMinusOnChain: resolved.amountOut - usage.redeemAmount,
          verdict: shareInputComparable
            ? "comparable: on-chain leg used the same share-input interface"
            : "NOT COMPARABLE: the on-chain redemption used redeemUnderlying(uint256) (underlying-output), so this integer pair is a quote-vs-different-interface observation, not share-input parity",
          reconciliationNote: shareInputComparable ? "n/a" : "the delta above mixes two different rounding paths (mul-then-div from shares vs div-then-mul from an underlying target) and must not be read as quote accuracy",
        };
        report.rows.push(row);
      }
    }

    const missing: string[] = [];
    if (report.onChain.rowsUsingShareInputInterface === 0) {
      missing.push("no transaction in this block calls redeem(uint256) on any admitted cToken market, so no real share-input redemption exists to compare against state-for-state");
      missing.push("the only Redeem-emitting transactions in this block call redeemUnderlying(uint256)");
    }
    report.sameStateShareInputComparison = {
      possible: report.onChain.rowsUsingShareInputInterface > 0,
      verdict: report.onChain.rowsUsingShareInputInterface > 0
        ? "possible: a share-input redemption exists at this block"
        : "IMPOSSIBLE at this block",
      missingEvidence: missing,
      scope: `block ${block}; all ${report.onChain.logCount} Redeem logs at this block enumerated and every emitting transaction traced`,
    };
    report.chainReads = reads.length;
    report.rpcCalls = calls;
    report.result = "pass";
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
      integer2_encodedArgument: row.integer2_quotedFragmentEncoding.encodedArgument,
      integer2_minAmountOut: row.integer2_quotedFragmentEncoding.minAmountOutField,
      integer3_patches: row.integer3_runtimeActualLeg.patches,
      integer3_embeddedArgumentPlaceholder: row.integer3_runtimeActualLeg.embeddedArgumentPlaceholder,
      integer3_amountAccesses: row.integer3_runtimeActualLeg.amountAccesses,
      integer3_serviceAccesses: row.integer3_runtimeActualLeg.serviceAccesses,
      integer4_redeemAmount: row.integer4_onChainRedeem.redeemAmount,
      integer4_redeemTokens: row.integer4_onChainRedeem.redeemTokens,
      integer4_interfaceUsed: row.integer4_onChainRedeem.interfaceUsed,
      signedDeltaQuotedMinusOnChain: row.comparison.signedDeltaQuotedMinusOnChain,
      onChainInterfaceIsShareInput: row.comparison.onChainInterfaceIsShareInput }));
  }
  if (report.result !== "pass") process.exitCode = 1;
}
main().catch(() => {
  console.error("compound cToken historical-dual invalid input; existing files not overwritten");
  process.exitCode = 1;
});
