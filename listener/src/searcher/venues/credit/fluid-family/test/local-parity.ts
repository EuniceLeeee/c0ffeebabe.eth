// Opt-in quote-only acceptance. No Ready admission, strategy enablement or broadcast.
import assert from "node:assert/strict";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { ethers } from "ethers";
import { executeAdapterWork } from "../../../../adapter-work-intent.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { createRevmStrictSourceSimulation } from "../../../../revm-strict-source-simulation.js";
import { RevmSimClient } from "../../../../revm-sim-client.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource, RequestRequirements } from "../../../adapter-request-program.js";
import type { ExactQuoteInput, ExactQuoteResult, ExactRequestProgram } from "../../../adapter-family-plugin.js";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../../../production-infra-actions.js";
import { plugin } from "../../../production-families/fluid-credit.production.js";
import { FLUID_CREDIT_FACTORY_LINEAGE_ID, FLUID_CREDIT_FAMILY_ID } from "../manifest.js";
import { decodeFactoryVault, decodeFluidVaultConstants, FLUID_ERC20_INTERFACE, FLUID_VAULT_FACTORY_INTERFACE,
  FLUID_VAULT_INTERFACE, sameAddress, tokenDelta } from "../codec.js";
import { fluidCreditRoutes } from "../routes.js";
import { fluidCreditExecution } from "../execution.js";
import { fluidCreditBorrowProgram, fluidCreditLocalExactProgram } from "../exact.js";
import { decodeFluidCapacity, fluidCapacityRequests } from "../capacity.js";
import { fluidMaxInputForBorrowCapacity } from "../borrow-math.js";
import { fluidLocalModelForCode } from "../model.js";
import type { FluidCreditDescriptor, FluidCreditRoute } from "../types.js";
import type { ResolvedPlanNode } from "../../../../../types.js";

type QuoteInput = ExactQuoteInput<FluidCreditDescriptor, FluidCreditRoute>;
type Outcome = { ok: true; quote: ExactQuoteResult<any> } | { ok: false; error: string };

async function firstLine(path: string): Promise<any> {
  const stream = createReadStream(path), lines = createInterface({ input: stream, crlfDelay: Infinity });
  try { for await (const line of lines) if (line.trim()) return JSON.parse(line); }
  finally { lines.close(); stream.destroy(); }
  throw new Error("empty mids file");
}

async function run(): Promise<void> {
  const started = Date.now();
  const midsPath = resolve(process.env.FLUID_MIDS ?? "../logs/live-balancer-local.smU1vv/mids.jsonl");
  const output = process.env.FLUID_REPORT;
  assert(output, "FLUID_REPORT required (new output path)");
  const reportPath = resolve(output);
  assert(!existsSync(reportPath), "refusing to overwrite an existing parity report");
  const baseline = await firstLine(midsPath);
  const rows: any[] = baseline.effective_mids.rows.filter((entry: any[]) => entry[0].startsWith("credit:fluid\u001f"))
    .map((entry: any[]) => entry[1]);
  assert.equal(rows.length, 13, "this acceptance is the recorded thirteen-Fluid cohort");
  assert.equal(rows.filter(row => row.status === "quoted").length, 7);
  assert.equal(rows.filter(row => row.status === "quote-failed").length, 6);
  const source: CanonicalSource = { number: baseline.source_block, hash: baseline.source_block_hash,
    generation: baseline.effective_mids.source.generation };
  assert.equal(source.number, 26037420);
  assert.equal(source.hash, "0x54550a05bf1f353f9df1da8f44349d3723201adc42c8e46dd7895114a2979696");
  const envFile = process.env.FLUID_RPC_ENV_FILE ?? "/Users/eunice/src/MEV/.env";
  const envLine = readFileSync(envFile, "utf8").split(/\r?\n/)
    .find(line => /^(?:export\s+)?MAINNET_RPC_URL=/.test(line.trim()));
  assert(envLine, "MAINNET_RPC_URL missing from the selected environment file");
  const rpcUrl = envLine.trim().split("=").slice(1).join("=").replace(/^["']|["']$/g, "");
  const redact = (error: unknown) => String(error instanceof Error ? error.message : error)
    .replaceAll(rpcUrl, "[RPC_REDACTED]").replace(/https?:\/\/[^\s"']+/g, "[URL_REDACTED]");
  const controller = new AbortController();
  const control = { deadlineAtMs: started + 570_000, signal: controller.signal };
  const report: any = { claim: "quote-only, reverse-checked getters; not strict lifecycle or Ready admission",
    source, midsPath, broadcast: false, signing: false, concurrency: 1, capacityControls: process.argv.includes("--capacity"),
    startedAt: new Date(started).toISOString(), samples: [], rpc: [], codes: {}, complete: false };
  mkdirSync(dirname(reportPath), { recursive: true });
  const save = () => writeFileSync(reportPath, JSON.stringify(report, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value, 2), { mode: 0o600 });
  save();
  const deadline = setTimeout(() => controller.abort(new Error("parity deadline")), Math.max(1, started + 570_000 - Date.now()));
  const watchdog = setTimeout(() => {
    report.fatal = "ten-minute outer deadline"; save(); process.exit(1);
  }, Math.max(1, started + 600_000 - Date.now()));
  const executor = "0x1000000000000000000000000000000000000002";
  const transactionOrigin = "0x1000000000000000000000000000000000000001";
  report.executor = executor; report.transactionOrigin = transactionOrigin;
  const simulation = createRevmStrictSourceSimulation({ identity: { source, rpcUrl, chainId: 1 }, control,
    executionGasLimit: 3_000_000, createClient: ({ onFatal }) => new RevmSimClient({
      executablePath: process.env.FLUID_REVM_BIN ?? resolve("revm-sim/target/release/revm-sim"), timeoutMs: 60_000, onFatal }),
    onFatal: reason => { report.simulationFatal = redact(JSON.stringify(reason)); controller.abort(reason); save(); } });
  let rpcCount = 0, rpcTail = Promise.resolve();
  const pin = { blockHash: source.hash, requireCanonical: true };
  function check(): void {
    if (controller.signal.aborted || Date.now() >= control.deadlineAtMs) throw new Error("parity stopped or deadline reached");
  }
  function rpc(method: string, params: readonly unknown[]): Promise<any> {
    const pending = rpcTail.then(async () => {
      check(); assert(++rpcCount <= 500, "bounded read request cap");
      const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcCount, method, params }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
      const text = await response.text();
      if (response.status === 429 || /too many requests|rate.?limit|compute units/i.test(text)) {
        report.rateLimited = true; controller.abort(new Error("RPC throttle")); save(); throw new Error("RPC throttle; no retry");
      }
      const body = JSON.parse(text);
      report.rpc.push({ method, params, status: response.status, ...(body.error ? { error: redact(JSON.stringify(body.error)) } : {}) });
      save();
      if (!response.ok || body.error) throw new Error(redact(JSON.stringify(body.error ?? { status: response.status })));
      return body.result;
    });
    rpcTail = pending.then(() => {}, () => {});
    return pending;
  }
  const provider = { call: (tx: any) => rpc("eth_call", [tx, pin]), getCode: (address: string) => rpc("eth_getCode", [address, pin]),
    getStorage: (address: string, slot: string) => rpc("eth_getStorageAt", [address, slot, pin]) };
  const runtime = createStrictCentralAdapterRuntime({ provider, simulator: simulation.transport, executor, transactionOrigin,
    exactCallBackend: provider, generationFence: { assertCurrent(generation, bound) {
      check(); assert.equal(generation, source.generation); assert.deepEqual(bound, source);
    } } });
  async function requestRound(requirements: RequestRequirements, requests: readonly AdapterRequest[]): Promise<readonly AdapterRequestResult[]> {
    check();
    const work = await executeAdapterWork({ runtime, control, intent: { stage: "exact-refine", familyId: FLUID_CREDIT_FAMILY_ID,
      source, generation: source.generation, programInput: null, program: { requirements: () => requirements,
        buildRequests: () => requests, decode: ({ results }) => results } } });
    if (work.status !== "resolved") throw new Error(`${work.failure.code}: ${work.failure.message}`);
    return work.executed.evidence;
  }
  async function quote(program: ExactRequestProgram<FluidCreditDescriptor, FluidCreditRoute, any>, input: QuoteInput): Promise<Outcome> {
    try {
      const initialResults = await requestRound(program.requirements(input), program.buildRequests(input));
      const dependentEvidence: unknown[] = [];
      for (let completedRound = 0; completedRound < 8; completedRound++) {
        const round = program.buildDependentProgram?.({ programInput: input, completedRound, initialResults,
          priorEvidence: dependentEvidence });
        if (!round) return { ok: true, quote: program.decode({ programInput: input, initialResults, dependentEvidence }) };
        dependentEvidence.push(round.decode(await requestRound(round.requirements, round.requests)));
      }
      throw new Error("dependent round cap");
    } catch (error) {
      const message = redact(error);
      if (/429|too many requests|rate.?limit|compute units|rpc.throttle/i.test(message)) {
        report.rateLimited = true; controller.abort(new Error("RPC throttle"));
      }
      return { ok: false, error: message };
    }
  }
  async function code(address: string): Promise<string> {
    const key = address.toLowerCase(); if (report.codes[key]) return report.codes[key].bytecode;
    const bytecode = await provider.getCode(address);
    report.codes[key] = { hash: ethers.keccak256(bytecode), bytecode }; save();
    return bytecode;
  }
  async function tinyOperate(input: QuoteInput, positiveDebt: bigint): Promise<any> {
    assert(positiveDebt > 0n);
    // This is deliberately NOT a candidate quote: the normal amount methods
    // reject before simulation. Independently ask operate about tiny collateral.
    const request: Extract<AdapterRequest, { kind: "effect-delta-simulation" | "state-override-simulation" }> = {
      id: "independent-tiny-collateral-rejection", kind: "effect-delta-simulation",
      preCalls: [{ caller: { kind: "executor" }, to: input.descriptor.supplyToken,
        data: FLUID_ERC20_INTERFACE.encodeFunctionData("approve", [input.descriptor.vault, input.amountIn]) }],
      call: { caller: { kind: "executor" }, executionMode: "impersonated-call-frame", to: input.descriptor.vault,
        data: FLUID_VAULT_INTERFACE.encodeFunctionData("operate", [0n, input.amountIn, positiveDebt, executor]) },
      overrideIntent: { caller: { kind: "executor" }, tokenBalances: [{ token: input.descriptor.supplyToken, amount: input.amountIn }] },
      observe: ["return-data", "revert-data", "token-delta"],
      observeTokenBalances: [input.descriptor.supplyToken, input.descriptor.borrowToken].map(token => ({ token, account: executor })) };
    const [result] = await requestRound({ transports: ["effect-delta-simulation"], caller: "executor",
      effects: ["return-data", "revert-data", "token-delta"] }, [request]);
    return { requestedDebt: positiveDebt, quoteClaim: false, request, result,
      reverted: result.ok && result.completion === "reverted-as-declared" };
  }
  async function encoded(input: QuoteInput, quoteResult: ExactQuoteResult<any>): Promise<any> {
    const fragment = fluidCreditExecution.buildFragment({ ...input, quotedAmountOut: quoteResult.amountOut,
      minAmountOut: quoteResult.amountOut, exactEvidence: quoteResult.evidence });
    const nodes: ResolvedPlanNode[] = fragment.requirements.map(requirement => {
      assert.equal(requirement.kind, "approve");
      if (requirement.kind !== "approve") throw new Error("unexpected execution requirement");
      return { adapterId: "erc20-approve", target: requirement.token, tokenIn: requirement.token, tokenOut: requirement.token,
        amount: requirement.amount, params: { spender: requirement.spender, amount: requirement.amount }, children: [] };
    });
    nodes.push(...fragment.nodes);
    const actions = [...plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
    const wire = nodes.map(node => {
      const adapter = actions.find(action => action.id === node.adapterId); assert(adapter);
      const data = adapter.encode(node, executor, new Uint8Array()); assert.equal(data[0], 0);
      assert.equal(((data[21] << 16) | (data[22] << 8) | data[23]) + 24, data.length);
      return { caller: { kind: "executor" as const }, to: ethers.hexlify(data.slice(1, 21)), data: ethers.hexlify(data.slice(24)) };
    });
    const request: Extract<AdapterRequest, { kind: "effect-delta-simulation" | "state-override-simulation" }> = {
      id: "independent-encoded-operate", kind: "effect-delta-simulation", preCalls: wire.slice(0, -1),
      call: { ...wire.at(-1)!, executionMode: "impersonated-call-frame" },
      overrideIntent: { caller: { kind: "executor" }, tokenBalances: [{ token: input.descriptor.supplyToken, amount: input.amountIn }] },
      observe: ["return-data", "token-delta"], observeTokenBalances: [input.descriptor.supplyToken, input.descriptor.borrowToken]
        .map(token => ({ token, account: executor })) };
    const [result] = await requestRound({ transports: ["effect-delta-simulation"], caller: "executor",
      effects: ["return-data", "token-delta"] }, [request]);
    if (!result.ok) return { ok: false, request, result };
    const collateralDelta = tokenDelta(result, input.descriptor.supplyToken, executor);
    const debtDelta = tokenDelta(result, input.descriptor.borrowToken, executor);
    return { ok: result.completion === "returned" && collateralDelta === -input.amountIn && debtDelta === quoteResult.amountOut,
      request, result, collateralDelta, debtDelta };
  }
  try {
    const header = await rpc("eth_getBlockByHash", [source.hash, false]);
    assert.equal(Number(header.number), source.number); assert.equal(header.hash, source.hash);
    report.block = { number: Number(header.number), hash: header.hash, timestamp: Number(header.timestamp), stateRoot: header.stateRoot };
    for (const row of rows) {
      check();
      const sample: any = { original: row, cases: [] }; report.samples.push(sample); save();
      try {
        const vault = ethers.getAddress(row.instance_key);
        const constants = decodeFluidVaultConstants(await provider.call({ to: vault, data: FLUID_VAULT_INTERFACE.encodeFunctionData("constantsView") }));
        const reverse = decodeFactoryVault(await provider.call({ to: constants.factory,
          data: FLUID_VAULT_FACTORY_INTERFACE.encodeFunctionData("getVaultAddress", [constants.vaultId]) }));
        assert(sameAddress(reverse, vault)); assert(sameAddress(constants.supplyToken, row.token_in));
        assert(sameAddress(constants.borrowToken, row.token_out));
        const localQuoteModel = fluidLocalModelForCode(await code(vault));
        sample.localQuoteModel = localQuoteModel; save();
        if (row.status === "quoted") assert.equal(localQuoteModel, "t1-view-v1", "positive local quote requires a supported code model");
        const descriptor: FluidCreditDescriptor = { ...constants, vault, familyId: FLUID_CREDIT_FAMILY_ID,
          lineageId: FLUID_CREDIT_FACTORY_LINEAGE_ID, instanceKey: instanceKey(vault.toLowerCase()), provenance: [], runtimeRequirements: [],
          ...(localQuoteModel === null ? {} : { localQuoteModel }),
          factoryBinding: { factory: constants.factory, vaultId: constants.vaultId, reverseVault: reverse } };
        const route = fluidCreditRoutes.project({ descriptor })[0];
        sample.descriptor = descriptor; sample.route = route;
        const capacity = decodeFluidCapacity(descriptor, await requestRound({ transports: ["eth-call"] }, fluidCapacityRequests(vault)), source);
        sample.capacity = capacity; await code(capacity.oracle); save();
        const productionInput = BigInt(row.amount_in);
        const cases: { label: string; amountIn: bigint }[] = [{ label: "production-effective", amountIn: productionInput }];
        if (report.capacityControls) {
          const maximum = fluidMaxInputForBorrowCapacity(capacity, capacity.borrowable);
          sample.capacityMaximumInput = maximum;
          const expanded = productionInput * 10n;
          if (expanded <= maximum) cases.push({ label: "expanded-10x", amountIn: expanded });
          if (maximum > 0n) cases.push({ label: "view-capacity-max", amountIn: maximum },
            { label: "view-capacity-plus-one-conservative", amountIn: maximum + 1n },
            { label: "above-view-capacity-10ppm", amountIn: fluidMaxInputForBorrowCapacity(capacity,
              capacity.borrowable * 100001n / 100000n) + 1n });
        }
        for (const test of cases) {
          check(); const entry: any = { ...test }; sample.cases.push(entry); save();
          const input: QuoteInput = { descriptor, route, amountIn: test.amountIn, source, executor, transactionOrigin, runtimeEvidence: [] };
          let roundStarted = Date.now();
          entry.local = await quote(fluidCreditLocalExactProgram, input); entry.localWallMs = Date.now() - roundStarted; save(); check();
          roundStarted = Date.now();
          entry.simulated = await quote(fluidCreditBorrowProgram, input); entry.simulatedWallMs = Date.now() - roundStarted; save(); check();
          if (entry.local.ok) {
            roundStarted = Date.now();
            try { entry.encoded = await encoded(input, entry.local.quote); }
            catch (error) { entry.encoded = { ok: false, error: redact(error) }; }
            entry.encodedWallMs = Date.now() - roundStarted;
          }
          if (test.amountIn < 10_000n) {
            roundStarted = Date.now();
            try { entry.tinyOperate = await tinyOperate(input, capacity.minimumBorrowing); }
            catch (error) { entry.tinyOperate = { reverted: false, error: redact(error) }; }
            entry.tinyOperateWallMs = Date.now() - roundStarted;
          }
          entry.equal = entry.local.ok && entry.simulated.ok && entry.local.quote.amountOut === entry.simulated.quote.amountOut && entry.encoded?.ok;
          entry.correctMinimumRejection = test.amountIn < 10_000n && !entry.local.ok && !entry.simulated.ok &&
            /at least 10000/.test(entry.local.error) && /at least 10000/.test(entry.simulated.error) && entry.tinyOperate?.reverted === true;
          entry.conservativeViewRejection = !entry.local.ok && /capacity exceeded/.test(entry.local.error) && entry.simulated.ok;
          if (test.label === "production-effective") entry.pass = row.status === "quoted" ? entry.equal : entry.correctMinimumRejection;
          console.log(JSON.stringify({ vault, label: test.label, local: entry.local.ok, simulated: entry.simulated.ok,
            encoded: entry.encoded?.ok ?? null, equal: Boolean(entry.equal), minimumRejection: entry.correctMinimumRejection })); save();
        }
      } catch (error) { sample.error = redact(error); save(); }
      check();
    }
    const canonical = await rpc("eth_getBlockByNumber", [ethers.toQuantity(source.number), false]);
    assert.equal(canonical.hash, source.hash);
    report.complete = true;
    report.productionPassed = report.samples.length === 13 && report.samples.every((sample: any) =>
      !sample.error && sample.cases.find((test: any) => test.label === "production-effective")?.pass === true);
    if (!report.productionPassed) process.exitCode = 1;
  } catch (error) { report.failure = redact(error); process.exitCode = 1; }
  finally {
    controller.abort(new Error("parity complete"));
    try { await simulation.closeAndDrain(); } catch (error) { report.closeFailure = redact(error); process.exitCode = 1; }
    clearTimeout(deadline); clearTimeout(watchdog); report.wallMs = Date.now() - started; save();
  }
}

if (process.argv.includes("--run")) await run();
