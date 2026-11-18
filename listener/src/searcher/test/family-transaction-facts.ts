import assert from "node:assert/strict";
import { sha256EvidenceFile } from "./family-evidence-hash.js";
import { constants, copyFileSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { familyTestSourceFingerprint } from "../../../scripts/test-family.mjs";
import { familyTransactionDirectory, familyTransactionInputFingerprint, familyTransactionLegMissing,
  getInstalledTransactionFamilies, readFamilyTransaction, type FamilyTransaction, type FamilyTransactionLeg } from "./family-transaction-registry.js";
import { registerTransactionAcceptanceSample, registerReadyTransactionAcceptanceSample, transactionSimulationCase, transactionTestActors } from "./protocol-json-sample-registration.js";
import { prepareFamilyReady, assertAcceptanceReadyTarget, readFamilyTransactionEvidence, transactionReadyRoutes } from "./family-json-ready.js";
import { acceptanceSourceFingerprint, assertAcceptanceHeader, assertAcceptanceReceipt, openFamilyAcceptanceRuntimeContext, openProtocolJsonAcceptanceContext } from "./protocol-json-acceptance-context.js";
import { basicRouteAcceptanceStages, verifyBasicRouteAcceptance } from "./protocol-json-basic-facts.js";
import { runProtocolJsonAcceptance } from "./protocol-json-acceptance.js";
import { parseFundingAcceptanceCase, runFamilyFundingAcceptance, verifyFundingAcceptanceReport,
  fundingAcceptanceStages } from "./family-funding-acceptance.js";
import { assertFundingTransactionReady, resolveFundingTransactionCase } from "./family-funding-acceptance-context.js";
import { nodeSimulateV1Environment } from "../simulator/node-simulate-v1.js";
import { UniverseRebuildCheckpointStore } from "../universe-rebuild-checkpoint.js";
import { loadBotVmRuntimeCode } from "../../shared/executor/botvm-executor.js";
import { verifyRecordedExecutionReceipts } from "./family-node-receipt-verification.js";

import { JsonRpcProvider } from "ethers";
import { selectTransactionExecutionSource, validateTransactionStateSelection, type TransactionStateSelection } from "./family-transaction-source.js";

import { familyFactCacheDirectory } from "./family-transaction-cache.js";
import { matchFamilyTransactionInput, resolveTransactionCaseBinding } from "./family-transaction-matching.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REPO = resolve(ROOT, "..");
const ORIGINAL_INPUT_REFERENCE = Object.freeze({ status: "reference-only", required: false });
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const safe = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
const json = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? { $type: "bigint", value: item.toString() } : item, 2) + "\n";
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"), (_key, value) => {
  if (value && typeof value === "object" && value.$type === "bigint") {
    assert.deepEqual(Object.keys(value).sort(), ["$type", "value"]);
    assert(typeof value.value === "string" && /^(0|-?[1-9][0-9]*)$/.test(value.value), "malformed raw integer evidence");
    return BigInt(value.value);
  }
  return value;
});
const save = (path: string, value: unknown) => {
  writeFileSync(`${path}.tmp`, json(value), { mode: 0o600 }); renameSync(`${path}.tmp`, path);
};
const fileEvidence = (path: string) => ({ file: basename(path), sha256: sha256EvidenceFile(path) });
const reportedOwner = (report: any) => ({ familyId: report.executionBinding?.familyId ?? report.familyId,
  domain: report.executionBinding?.domain ?? report.domain,
  ...(report.bindingMode === "selector" ? { referenceFamilyId: report.familyId } : {}) });

export { transactionSimulationCase };
export function transactionFundingCase(transaction: FamilyTransaction, leg: FamilyTransactionLeg,
 stateSelection:TransactionStateSelection|undefined, envelope:import("../universe-rebuild-checkpoint.js").StartupCheckpointEnvelope) {
  assert.equal(leg.domain,"funding");assert.deepEqual(familyTransactionLegMissing(leg),[]);
  familyTransactionInputFingerprint(transaction,leg);
  return resolveFundingTransactionCase(envelope,transaction,leg,stateSelection);
}

function evidenceFile(reportPath: string, evidence: any): string {
  assert(evidence && typeof evidence.file === "string" && basename(evidence.file) === evidence.file && !isAbsolute(evidence.file), "invalid evidence filename");
  const root = realpathSync(dirname(reportPath)), path = realpathSync(resolve(root, evidence.file));
  assert.equal(dirname(path), root, "evidence escaped its case directory");
  assert.equal(sha256EvidenceFile(path), evidence.sha256, "raw evidence hash mismatch");
  return path;
}

export function verifyContextEvidence(raw: any, transaction: FamilyTransaction, leg: FamilyTransactionLeg, execution: any, stateSelection: TransactionStateSelection) {
  const e = raw.evidence, actors = transactionTestActors(leg), source = stateSelection.executionSource;
  if (stateSelection.mode === "parent") {
    assert.deepEqual(e?.transactionState, stateSelection, "execution and TX source relation differs");
    assertAcceptanceReceipt(e.receipt, transaction.transactionHash, stateSelection.evidenceSource);
  }
  assert(e && e.simulator === "node-rpc", "recorded node execution evidence is missing");
  assert(execution && ["deployed", "counterfactual"].includes(execution.executorCodeMode) &&
    ["debug_traceCall", "eth_simulateV1"].includes(execution.simulationMethod), "execution mode identity missing");
  assert.equal(e.executionEnvironment?.method, execution.simulationMethod, "reported simulation method differs from the actual environment");
  assert.equal(e.executorProvisioning?.mode, execution.executorCodeMode, "reported executor mode differs from provisioning");
  if (execution.executorCodeMode === "deployed") assert.equal(e.executorProvisioning.actorOnlyCodeOverlay, false);
  assertAcceptanceHeader(e.header, source);
  assert.deepEqual(raw.source, e.source, "raw and context sources differ");
  assert(e.source && e.source.number === source.number && same(e.source.hash, source.hash));
  assert(same(e.actors?.executor, actors.executor) && same(e.actors?.owner, actors.owner), "simulation actor binding mismatch");
  assert.equal(e.code?.sourceTreeSha256, acceptanceSourceFingerprint(REPO), "production implementation changed");
  assert(Array.isArray(e.inputs) && e.inputs.length > 0 && Array.isArray(e.code.executorSources) && e.code.executorSources.length > 0);
  for (const pin of [...e.inputs, ...e.code.executorSources]) assert.equal(sha256EvidenceFile(pin.path), pin.sha256, "case/code input changed after execution");
  assert(e.executorProvisioning?.protocolOverrides === false && e.executorProvisioning.signing === false && e.executorProvisioning.broadcast === false);
  assert.equal(e.admission?.currentDefinition, true);
  assert(Array.isArray(e.simulations) && e.simulations.length > 0, "no raw node simulations were retained");
  for (const item of e.simulations) {
    const response = item.response, attestation = response?.sourceAttestation;
    assert(response?.ok === true && attestation?.kind === "node-attested", "missing completed node source attestation");
    assert.equal(attestation.chainId, transaction.chainId); assert.equal(attestation.blockNumber, source.number);
    assert(same(attestation.blockHash, source.hash) && same(attestation.stateRoot, e.header.stateRoot) && same(attestation.parentHash, e.header.parentHash));
    assert.equal(item.request.blockNumber, source.number); assert(same(item.request.sourcePin.blockHash, source.hash));
    if (e.executionEnvironment.method === "eth_simulateV1") {
      assert.deepEqual(e.executionEnvironment, nodeSimulateV1Environment(e.header));
      assert.deepEqual(response.executionObservation, e.executionEnvironment, "execution and quote environments differ");
    } else assert.equal(e.executionEnvironment.method, "debug_traceCall");
  }
  assert.equal(raw.diagnostics?.simulationErrors?.length ?? 0, 0, "simulation transport failures were retained");
}

/** Historical action/input matching is retained reference evidence. Its result
 * never substitutes for current Ready admission or independent simulation. */
export async function verifyFamilyTransactionBindingReport(reportPath: string, transaction: FamilyTransaction, leg: FamilyTransactionLeg) {
  const report = read(reportPath);
  const stateSelection = validateTransactionStateSelection(leg.source!, report.stateSelection);
  assert.equal(report.format, "family-transaction-facts-v1");
  assert.equal(report.scope, "same-state-simulation");
  assert.deepEqual(report.originalTransactionInput, ORIGINAL_INPUT_REFERENCE, "original transaction input must remain reference-only");
  assert.equal(report.transactionHash, transaction.transactionHash); assert.equal(report.legId, leg.id);
  assert.equal(report.familyId, leg.familyId); assert.equal(report.domain, leg.domain);
  assert.equal(report.sourceFingerprint, familyTestSourceFingerprint(ROOT), "test/source/seed tree changed");
  assert.equal(report.inputFingerprint, familyTransactionInputFingerprint(transaction, leg));
  assert(leg.domain === "protocol" || leg.domain === "swap" || leg.domain === "credit", "priced route TX binding required");
  assert.equal(report.bindingMode, "selector", "route facts require selector binding mode");
  const envelope = await new UniverseRebuildCheckpointStore({ path: evidenceFile(reportPath, report.evidence?.ready) }).load();
  assert(envelope);
  const evidence = read(evidenceFile(reportPath, report.evidence?.transaction));
  const routes = await transactionReadyRoutes(envelope, { source: stateSelection.executionSource, ...transactionTestActors(leg) });
  const binding = matchFamilyTransactionInput({ transactionHash: transaction.transactionHash,
    evidence, expected: leg, familyBinding: "selector", routes });
  assert.deepEqual(report.stages.transactionBinding, binding, "reported TX binding differs from raw evidence");
  const resolveBinding = async () => resolveTransactionCaseBinding({ transactionHash: transaction.transactionHash,
    evidence, expected: leg, familyBinding: "selector", routes });
  if (report.executionBinding !== undefined) {
    const current = await resolveBinding();
    assert.equal(current.selection, "selector-call");
    assert.deepEqual(report.executionBinding, current.resolved, "reported selector owner differs from Ready/TX evidence");
    assert.deepEqual(report.caseBinding, current, "reported case binding differs from Ready/TX evidence");
  } else {
    assert(["incomplete", "failed"].includes(report.result), "completed selector facts have no execution owner");
    // An unresolved reference may lack transfer attribution even when the
    // current selector owner is unique. Never mint execution authority here.
    if (["unverified-selector", "ambiguous-selector"].includes(binding.status))
      await assert.rejects(resolveBinding, /selector Ready binding absent|selector Ready binding ambiguous/);
  }
  return binding;
}

/** Called by the MAIN test command after each child. A child exit status or a
 * summary-only pass document cannot satisfy the installed Family gate. */
export async function verifyFamilyTransactionFactsReport(reportPath: string, transaction: FamilyTransaction, leg: FamilyTransactionLeg): Promise<void> {
  const report = read(reportPath);
  const stateSelection = validateTransactionStateSelection(leg.source!, report.stateSelection);
  assert.equal(report.format, "family-transaction-facts-v1"); assert.equal(report.scope, "same-state-simulation");
  assert.deepEqual(report.originalTransactionInput, ORIGINAL_INPUT_REFERENCE, "original transaction input must remain reference-only");
  assert.equal(report.result, "pass"); assert.equal(report.transactionHash, transaction.transactionHash);
  assert.equal(report.legId, leg.id); assert.equal(report.familyId, leg.familyId); assert.equal(report.domain, leg.domain);
  assert.equal(report.inputFingerprint, familyTransactionInputFingerprint(transaction, leg));
  assert.equal(report.sourceFingerprint, familyTestSourceFingerprint(ROOT), "test/source/seed tree changed");
  const rawPath = evidenceFile(reportPath, report.evidence?.acceptance), readyPath = evidenceFile(reportPath, report.evidence?.ready);
  const raw = read(rawPath), envelope = await new UniverseRebuildCheckpointStore({ path: readyPath }).load();
  assert(envelope && envelope.inProgressRun === null);
  if (leg.domain === "protocol" || leg.domain === "swap" || leg.domain === "credit") {
    await verifyFamilyTransactionBindingReport(reportPath, transaction, leg);
  }
  verifyContextEvidence(raw, transaction, leg, report.execution, stateSelection);
  const actors = transactionTestActors(leg);
  await verifyRecordedExecutionReceipts({ source: raw.source, chainId: transaction.chainId,
    stateRoot: raw.evidence.header.stateRoot, ...actors, executorRuntimeCode: loadBotVmRuntimeCode(actors.owner),
    simulations: raw.evidence.simulations,
    executions: leg.domain === "funding" ? raw.executions : raw.samples.flatMap((sample: any) => sample.executions) });
  let installed = (await getInstalledTransactionFamilies()).find(row => row.familyId === leg.familyId);
  if (leg.domain === "funding") {
    const sample = await transactionFundingCase(transaction, leg, stateSelection, envelope);
    const { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: catalog } = await import("../venues/production-family-composition.js");
    const family = catalog.forStrictFamily(sample.familyId as never);
    assert.equal(report.bindingMode,"selector");
    assert.deepEqual(report.executionBinding,{familyId:sample.familyId,domain:"funding",instanceKey:sample.instanceKey,fundingId:sample.fundingId,lineageId:sample.lineageId});
    const target = await assertFundingTransactionReady({ envelope, sample });
    assert.deepEqual(raw.source, target.source, "execution source differs from target checkpoint");
    await verifyFundingAcceptanceReport(sample, raw, family);
    assert.deepEqual(report.stages, { ...fundingAcceptanceStages(sample, raw), discoveryCheckpoint: { status: "pass", ...target } });
  } else {
    const current = leg.domain === "protocol" || leg.domain === "swap" || leg.domain === "credit"
      ? resolveTransactionCaseBinding({ transactionHash: transaction.transactionHash, expected: leg,
        evidence: read(evidenceFile(reportPath, report.evidence.transaction)),
        familyBinding: "selector",
        routes: await transactionReadyRoutes(envelope, { source: stateSelection.executionSource, ...transactionTestActors(leg) }) }) : undefined;
    if (current) {
      assert.deepEqual(report.caseBinding, current, "reported case binding differs from Ready/TX evidence");
      if (current.selection === "selector-call") {
        assert.deepEqual(report.executionBinding, current.resolved, "reported selector owner differs from Ready/TX evidence");
        installed = (await getInstalledTransactionFamilies()).find(row => row.familyId === current.resolved.familyId);
        assert(installed?.selectorExecution && installed.enabled && installed.domain === current.resolved.domain,
          "resolved execution owner is not an active selector Family");
      }
    }
    assert(installed, "execution owner unavailable");
    const sample = transactionSimulationCase(transaction, leg, stateSelection, current?.resolved), target = await assertAcceptanceReadyTarget(envelope, sample);
    assert.deepEqual(raw.source, target.source, "execution source differs from target checkpoint");
    assert.deepEqual(report.stages, { discoveryCheckpoint: { status: "pass", ...target },
      ...verifyBasicRouteAcceptance(sample, raw, installed!.ordinaryRuntimeLeg),
      ...(leg.domain === "protocol" || leg.domain === "swap" || leg.domain === "credit" ? { transactionBinding: report.stages.transactionBinding } : {}) });
  }
}

export async function familyTransactionFactsMain(argv = process.argv.slice(2)) {
  if (argv[0] === "--verify-report" || argv[0] === "--verify-binding") {
    const verifyArgs = new Map<string, string>();
    for (let i = 0; i < argv.length; i += 2) {
      assert([argv[0], "--transaction", "--leg"].includes(argv[i]!) && !verifyArgs.has(argv[i]!) &&
        argv[i + 1] && !argv[i + 1]!.startsWith("--"), "invalid raw verification option");
      verifyArgs.set(argv[i]!, argv[i + 1]!);
    }
    assert.equal(verifyArgs.size, 3, "raw verification requires --verify-report --transaction --leg");
    const transactionPath = realpathSync(resolve(verifyArgs.get("--transaction")!));
    assert.equal(dirname(transactionPath), realpathSync(resolve(ROOT, familyTransactionDirectory)), "TX must be registered in the central directory");
    const transaction = readFamilyTransaction(transactionPath), leg = transaction.legs.find(item => item.id === verifyArgs.get("--leg"));
    assert(leg, "unknown registered transaction leg");
    const reportPath = realpathSync(resolve(verifyArgs.get(argv[0]!)!));
    if (argv[0] === "--verify-binding") {
      const binding = await verifyFamilyTransactionBindingReport(reportPath, transaction, leg);
      const report = read(reportPath);
      console.log(json({ result: "input-binding-diagnostic-verified", binding,
        executionBinding: report.executionBinding ?? null, report: reportPath }));
      return { exitCode: 0, reportPath, report };
    }
    await verifyFamilyTransactionFactsReport(reportPath, transaction, leg);
    console.log(json({ result: "raw-evidence-verified", ...reportedOwner(read(reportPath)), legId: leg.id, report: reportPath }));
    return { exitCode: 0, reportPath, report: read(reportPath) };
  }
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    assert(["--transaction", "--leg", "--rpc-file", "--out", "--ready", "--executor-code-mode", "--simulation-method", "--stage", "--execution-source"].includes(argv[i]!) &&
      !args.has(argv[i]!) && argv[i + 1] && !argv[i + 1]!.startsWith("--"), "invalid transaction facts option");
    args.set(argv[i]!, argv[i + 1]!);
  }
  for (const key of ["--transaction", "--leg", "--rpc-file", "--out"]) assert(args.has(key), `missing ${key}`);
  const requestedStage = args.get("--stage") ?? "all";
  assert(["all", "ready", "match"].includes(requestedStage), "--stage must be all, ready or match");
  const out = resolve(args.get("--out")!); mkdirSync(dirname(out), { recursive: true }); mkdirSync(out);
  const reportPath = resolve(out, "report.json"), rawPath = resolve(out, "acceptance.json"), readyPath = resolve(out, "ready.json"), transactionEvidencePath = resolve(out, "transaction-evidence.json");
  const report: any = { format: "family-transaction-facts-v1", scope: "same-state-simulation", result: "failed",
    originalTransactionInput: ORIGINAL_INPUT_REFERENCE,
    sourceFingerprint: familyTestSourceFingerprint(ROOT), originalTransactionOutput: { status: "reference-only", required: false },
    stages: { discoveryCheckpoint: { status: "not-run" }, exact: { status: "not-run" }, quotedExecution: { status: "not-run" },
      runtimeExecution: { status: "not-run" }, simulationOutputParity: { status: "not-run" } } };
  const checkpoint = () => save(reportPath, report); checkpoint();
  let context: Awaited<ReturnType<typeof openFamilyAcceptanceRuntimeContext>> | undefined;
  let stage = "input";
  try {
    const transactionPath = realpathSync(resolve(args.get("--transaction")!));
    assert.equal(dirname(transactionPath), realpathSync(resolve(ROOT, familyTransactionDirectory)), "TX must be registered in the central directory");
    const transaction = readFamilyTransaction(transactionPath), leg = transaction.legs.find(item => item.id === args.get("--leg"));
    assert(leg, "unknown transaction leg");
    Object.assign(report, { transactionHash: transaction.transactionHash, legId: leg.id, familyId: leg.familyId, domain: leg.domain,
      inputFingerprint: familyTransactionInputFingerprint(transaction, leg),
      fixtureReference: { familyId: leg.familyId, domain: leg.domain, instanceKey: leg.instanceKey, lineageId: leg.lineageId, status: "reference-only" }, seed: { tokenIn: leg.tokenIn, tokenOut: leg.tokenOut,
        amountIn: leg.amountIn, amountScope: leg.amountScope } });
    const missing = familyTransactionLegMissing(leg);
    if (missing.length) { report.result = "incomplete"; throw new Error(`incomplete simulation input: ${missing.join(", ")}`); }
    let installed = (await getInstalledTransactionFamilies()).find(row => row.familyId === leg.familyId);
    report.bindingMode = "selector";
    const mode = args.get("--executor-code-mode") ?? "counterfactual", method = args.get("--simulation-method") ?? "eth_simulateV1";
    assert(["deployed", "counterfactual"].includes(mode)); assert(["debug_traceCall", "eth_simulateV1"].includes(method));
    report.execution = { executorCodeMode: mode, simulationMethod: method };
    const actors = transactionTestActors(leg), rpcFile = realpathSync(resolve(args.get("--rpc-file")!));
    const executionSourceMode = args.get("--execution-source") ?? "transaction";
    const rpc = read(rpcFile); assert(typeof rpc.MAINNET_RPC_URL === "string", "RPC configuration lacks MAINNET_RPC_URL");
    const sourceProvider = new JsonRpcProvider(rpc.MAINNET_RPC_URL, transaction.chainId, { staticNetwork: true });
    let stateSelection: TransactionStateSelection;
    try { stateSelection = await selectTransactionExecutionSource(leg.source!, executionSourceMode,
      (name, params) => sourceProvider.send(name, [...params])); }
    finally { sourceProvider.destroy(); }
    const executionSource = stateSelection.executionSource;
    report.stateSelection = stateSelection; checkpoint();
    stage = "discoveryCheckpoint";
    const envelope = args.has("--ready") ? (copyFileSync(realpathSync(resolve(args.get("--ready")!)), readyPath, constants.COPYFILE_FICLONE),
      await new UniverseRebuildCheckpointStore({ path: readyPath }).load())
      : await prepareFamilyReady({ familyId: leg.familyId, domain: leg.domain, source: executionSource, ...actors, rpcFile, out: readyPath,
        target: { transactionHash: transaction.transactionHash, instanceKey: leg.instanceKey!,
          ...(stateSelection.mode === "parent" ? { stateSelection } : {}) },
        executorCodeMode: mode as "deployed" | "counterfactual", simulationMethod: method as "debug_traceCall" | "eth_simulateV1" });
    assert(envelope, "Ready checkpoint unavailable");
    let prepared: Awaited<ReturnType<typeof registerReadyTransactionAcceptanceSample>> | undefined;
    if (leg.domain === "protocol" || leg.domain === "swap" || leg.domain === "credit") {
      stage = "transactionBinding";
      const rpc = read(rpcFile);
      assert(typeof rpc.MAINNET_RPC_URL === "string", "RPC configuration lacks MAINNET_RPC_URL");
      const evidence = await readFamilyTransactionEvidence({ rpcUrl: rpc.MAINNET_RPC_URL, directory: familyFactCacheDirectory(),
        transactionHash: transaction.transactionHash, source: { ...leg.source!, generation: leg.source!.number } });
      save(transactionEvidencePath, evidence);
      report.transactionEvidenceCache = evidence.cache;
      report.evidence = { ready: fileEvidence(readyPath), transaction: fileEvidence(transactionEvidencePath) };
      report.stages.transactionBinding = matchFamilyTransactionInput({ transactionHash: transaction.transactionHash, evidence, expected: leg, familyBinding: "selector",
        routes: await transactionReadyRoutes(envelope, { source: stateSelection.executionSource, ...actors }) });
      checkpoint();
      // Registry variants deliberately test new amounts and directions. Keep
      // the original TX relation accurate, while the current Ready/Graph and
      // actual same-state execution below determine simulation acceptance.
      if (requestedStage === "match" && report.stages.transactionBinding.status !== "matched") {
        report.result = "incomplete";
        throw new Error(`TX/Ready input binding: ${report.stages.transactionBinding.status}`);
      }
      if (requestedStage === "match") {
        const binding = resolveTransactionCaseBinding({ transactionHash: transaction.transactionHash, evidence, expected: leg,
          familyBinding: "selector", routes: await transactionReadyRoutes(envelope, { source: stateSelection.executionSource, ...actors }) });
        report.caseBinding = binding; report.executionBinding = binding.resolved;
        report.result = "match-only"; checkpoint();
        console.log(json({ result: report.result, ...reportedOwner(report), binding: report.stages.transactionBinding, report: reportPath }));
        return { exitCode: 0, reportPath, report };
      }
      stage = "transactionBinding";
      prepared = await registerReadyTransactionAcceptanceSample(transactionPath, leg.id, readyPath, transactionEvidencePath, stateSelection);
      report.caseBinding = prepared.binding;
      assert(prepared.binding.selection === "selector-call", "route facts require selector execution ownership");
      report.executionBinding = prepared.binding.resolved;
      installed = (await getInstalledTransactionFamilies()).find(row => row.familyId === prepared!.sample.familyId);
      assert(installed?.enabled && installed.selectorExecution && installed.domain === prepared.sample.domain,
        "resolved execution owner is not an active selector Family");
      save(resolve(out, "simulation-case.json"), prepared.sample);
      checkpoint();
    } else if (requestedStage === "match") throw new Error("TX action matching requires a priced route");
    const fundingSample = leg.domain === "funding" ? await transactionFundingCase(transaction, leg, stateSelection, envelope) : undefined;
    if (fundingSample) {
      report.executionBinding = { familyId: fundingSample.familyId, domain: "funding", instanceKey: fundingSample.instanceKey, fundingId: fundingSample.fundingId, lineageId: fundingSample.lineageId };
      installed = (await getInstalledTransactionFamilies()).find(row => row.familyId === fundingSample.familyId);
      assert(installed?.enabled && installed.domain === "funding", "resolved Funding owner is not active");
      save(resolve(out, "simulation-case.json"), fundingSample);
    }
    stage = "discoveryCheckpoint";
    if (requestedStage === "ready") {
      const target = leg.domain === "funding"
        ? await assertFundingTransactionReady({ envelope, sample: fundingSample! })
        : await assertAcceptanceReadyTarget(envelope, prepared?.sample ?? transactionSimulationCase(transaction, leg, stateSelection));
      report.stages.discoveryCheckpoint = { status: "pass", ...target };
      report.evidence = { ...report.evidence, ready: fileEvidence(readyPath) };
      report.result = "ready-only"; checkpoint();
      console.log(json({ result: report.result, ...reportedOwner(report), legId: leg.id, report: reportPath }));
      return { exitCode: 0, reportPath, report };
    }
    const input = { readyPath, rpcFile, familyId: prepared?.sample.familyId ?? leg.familyId, domain: prepared?.sample.domain ?? leg.domain, instanceKey: prepared?.sample.instanceKey ?? leg.instanceKey!, source: executionSource,
      ...(stateSelection.mode === "parent" ? { transactionHash: transaction.transactionHash, transactionState: stateSelection } : {}),
      ...actors, chainId: transaction.chainId, allowExecutorCodeOverride: mode === "counterfactual",
      simulationMethod: method as "debug_traceCall" | "eth_simulateV1", inputPaths: [transactionPath] };
    const raw: Record<string, any> = {};
    if (leg.domain === "funding") {
      const sample = fundingSample!;
      const target = await assertFundingTransactionReady({ envelope, sample });
      report.stages.discoveryCheckpoint = { status: "pass", ...target }; checkpoint();
      report.executionBinding = { familyId: sample.familyId, domain: "funding", instanceKey: sample.instanceKey, fundingId: sample.fundingId, lineageId: sample.lineageId };
      stage = "execution"; context = await openFamilyAcceptanceRuntimeContext({ ...input, familyId: sample.familyId, instanceKey: sample.instanceKey });
      await runFamilyFundingAcceptance(sample, context, raw, () => save(rawPath, raw));
      raw.diagnostics = context.counters(); raw.evidence = context.evidence; save(rawPath, raw);
      report.stages = { ...report.stages, ...fundingAcceptanceStages(sample, raw), discoveryCheckpoint: { status: "pass", ...target } };
    } else {
      const sample = prepared?.sample ?? transactionSimulationCase(transaction, leg, stateSelection), target = await assertAcceptanceReadyTarget(envelope, sample);
      report.stages.discoveryCheckpoint = { status: "pass", ...target }; checkpoint();
      const registration = prepared?.registration ?? registerTransactionAcceptanceSample(sample, transactionPath, leg.id, undefined, stateSelection);
      stage = "execution";
      const routeContext = await openProtocolJsonAcceptanceContext({ ...input, domain: sample.domain ?? leg.domain }); context = routeContext;
      await runProtocolJsonAcceptance(sample, routeContext, raw, () => save(rawPath, raw), registration);
      raw.diagnostics = context.counters(); save(rawPath, raw);
      report.stages = { ...report.stages, ...basicRouteAcceptanceStages(sample, raw, installed!.ordinaryRuntimeLeg) };
    }
    await context.close(); context = undefined;
    assert.equal(report.sourceFingerprint, familyTestSourceFingerprint(ROOT), "source changed while facts ran");
    assert.equal(report.inputFingerprint, familyTransactionInputFingerprint(readFamilyTransaction(transactionPath), leg), "transaction seed changed");
    report.evidence = { ...report.evidence, ready: fileEvidence(readyPath), acceptance: fileEvidence(rawPath) };
    // This entry verifies one selected action. Broader settlement/route coverage
    // remains in acceptance.json; it is not evidence of failure of this action.
    if (leg.domain === "funding") assert.equal(raw.result, "pass", JSON.stringify({ failure: raw.failure, stages: report.stages }));
    else verifyBasicRouteAcceptance(prepared?.sample ?? transactionSimulationCase(transaction, leg, stateSelection), raw, installed!.ordinaryRuntimeLeg);
    report.result = "pass"; checkpoint(); stage = "evidenceVerification";
    await verifyFamilyTransactionFactsReport(reportPath, transaction, leg);
  } catch (error) {
    if ((error as any)?.evidence?.status === "unverified-selector" || (error as any)?.evidence?.status === "ambiguous-selector") report.result = "incomplete";
    if (report.result !== "incomplete") report.result = "failed";
    report.failure = { stage, reason: safe(error), ...((error as any)?.evidence ? { evidence: (error as any).evidence } : {}) };
    if (stage === "discoveryCheckpoint") report.stages.discoveryCheckpoint = { status: "failed", failure: safe(error) };
  } finally {
    if (context) try { await context.close(); } catch (error) { report.result = "failed"; report.closeFailure = safe(error); }
    report.finished = new Date().toISOString(); checkpoint();
  }
  console.log(json({ ...reportedOwner(report), legId: report.legId, result: report.result, stages: report.stages, report: reportPath }));
  return { exitCode: report.result === "pass" ? 0 : 1, reportPath, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  familyTransactionFactsMain().then(result => { process.exitCode = result.exitCode; }).catch(error => { console.error(safe(error)); process.exitCode = 1; });
