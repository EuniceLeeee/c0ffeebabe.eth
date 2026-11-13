import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { familyTestMain, parseFamilyTestArguments, summarizeFamilyTransactionResults } from "../../../scripts/test-family.mjs";

const family = { familyId: "fixture", domain: "swap", envKey: "FIXTURE_ENABLED", enabled: false, sourceFile: "fixture.ts", lineages: ["lineage"], ordinaryRuntimeLeg: true };
const row = () => ({ familyId: family.familyId, inputComplete: true, status: "pass", evidenceVerified: true });
test("family acceptance requires a verified case and every complete case must pass", () => {
  assert.equal(summarizeFamilyTransactionResults(family, [], true).result, "incomplete");
  assert.equal(summarizeFamilyTransactionResults(family, [row()], true).result, "pass");
  assert.equal(summarizeFamilyTransactionResults(family, [{ ...row(), evidenceVerified: false }], true).result, "incomplete");
  assert.equal(summarizeFamilyTransactionResults(family, [row(), { ...row(), status: "failed" }], true).result, "failed");
  assert.equal(summarizeFamilyTransactionResults(family, [row()], false).result, "failed");
});
test("incomplete references remain separate and cannot substitute for a complete passing case", () => {
  const reference = { ...row(), inputComplete: false, status: "incomplete", evidenceVerified: false };
  assert.equal(summarizeFamilyTransactionResults(family, [reference], true).result, "incomplete");
  const result = summarizeFamilyTransactionResults(family, [row(), reference], true);
  assert.equal(result.references, 2); assert.equal(result.completeInputs, 1); assert.equal(result.passedLegs, 1);
  assert.equal(result.incompleteInputs, 1); assert.equal(result.result, "incomplete");
});
test("missing implemented actions are incomplete samples, not failures or token-direction requirements", () => {
  const conversion = { ...family, domain: "protocol", executionActions: [
    { adapterId: "deposit", action: "deposit" }, { adapterId: "redeem", action: "redeem" },
  ] };
  const proved = (adapterId: string, tokenIn: string, tokenOut: string) => ({ ...row(),
    stages: { discoveryCheckpoint: { edges: [{ adapterId, tokenIn, tokenOut }] } } });
  const deposit = proved("deposit", "asset", "share"), redeem = proved("redeem", "share", "asset");
  const partial = summarizeFamilyTransactionResults(conversion, [deposit], true);
  assert.equal(partial.result, "incomplete"); assert.equal(partial.passedLegs, 1);
  assert.deepEqual(partial.missingActions, ["redeem"]);
  assert.equal(summarizeFamilyTransactionResults(conversion, [deposit, redeem], true).result, "pass");
  const swap = { ...family, executionActions: [{ adapterId: "swap", action: "swap" }] };
  assert.equal(summarizeFamilyTransactionResults(swap, [proved("swap", "A", "B")], true).result, "pass");
  assert.equal(summarizeFamilyTransactionResults(swap, [proved("swap", "B", "A")], true).result, "pass");
  assert.deepEqual(summarizeFamilyTransactionResults(conversion,
    [deposit, { ...redeem, evidenceVerified: false }], true).missingActions, ["redeem"]);
  assert.equal(summarizeFamilyTransactionResults(conversion, [deposit, { ...redeem, status: "failed" }], true).result, "failed");
});

test("CLI rejects accidental reduced scopes, malformed modes and duplicated options", () => {
  assert.equal(parseFamilyTestArguments([]).offline, false);
  assert.equal(parseFamilyTestArguments(["--offline"]).offline, true);
  for (const argv of [["--scope", "enabled"], ["--simulation-method", "eth_call"], ["--offline", "--offline"], ["--family"]]) assert.throws(() => parseFamilyTestArguments(argv));
});
async function round(argv: string[], changes: Record<string, any> = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "family-main-")); let calls = 0;
  const item = { path: resolve(root, "seed.json"), sha256: "file-pin", inputFingerprint: "input-pin", missing: [],
    transaction: { transactionHash: "0xabc" }, leg: { familyId: family.familyId, id: "leg" } };
  try {
    return await familyTestMain(["--out", resolve(root, "out"), ...argv], {
      root, fingerprint: () => "stable", getFamilies: async () => [family],
      registry: () => ({ transactions: [item], legs: [item] }),
      execute: async () => { calls++; return { exitCode: 0 }; }, verify: async () => {}, ...changes,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test("successful unit suite with absent RPC cannot pass factual acceptance", async () => {
  const result = await round([]);
  assert.equal(result.exitCode, 1); assert.equal(result.report.offline.status, "pass");
  assert.equal(result.report.families[0].legs[0].status, "incomplete");
  assert.equal(result.report.families[0].passedLegs, 0);
});
test("offline is explicitly not a transaction acceptance pass", async () => {
  let calls = 0;
  const result = await round(["--offline"], { execute: async (args: string[]) => {
    calls++; assert.equal(args[0], "scripts/test-protocol-json.mjs"); return { exitCode: 0 };
  } });
  assert.equal(result.exitCode, 0); assert.equal(result.report.result, "offline-contracts-pass");
  assert.equal(result.report.transactions.status, "not-run");
  assert.equal(calls, 1); assert.equal(result.report.families[0].completeInputs, 1);
  assert.equal(result.report.families[0].passedLegs, 0);
  assert.equal(result.report.families[0].legs[0].status, "not-run");
});
test("case exit zero cannot override raw evidence rejection", async () => {
  const result = await round(["--rpc-file", "rpc.json"], { verify: async () => { throw new Error("fabricated raw effects"); } });
  assert.equal(result.exitCode, 1); assert.equal(result.report.families[0].legs[0].evidenceVerified, false);
  assert.match(result.report.families[0].legs[0].error, /fabricated/);
});
test("verified process results pass only while the test and input source remains frozen", async () => {
  assert.equal((await round(["--rpc-file", "rpc.json"])).exitCode, 0);
  let reads = 0;
  const changed = await round(["--rpc-file", "rpc.json"], { fingerprint: () => ++reads === 1 ? "before" : "after" });
  assert.equal(changed.exitCode, 1); assert.equal(changed.report.sourceStable, false);
});
test("main retains missing action samples as incomplete, not execution failure", async () => {
  const result = await round(["--rpc-file", "rpc.json"], { getFamilies: async () => [{ ...family,
    executionActions: [{ adapterId: "redeem", action: "redeem" }] }] });
  assert.equal(result.exitCode, 1, "incomplete evidence cannot open the acceptance gate");
  assert.equal(result.report.result, "incomplete");
  assert.equal(result.report.transactions.status, "incomplete");
  assert.equal(result.report.families[0].passedLegs, 1);
  assert.deepEqual(result.report.families[0].missingActions, ["redeem"]);
});

test("an admitted instance with an unimplemented TX action remains a failure outside the implemented action inventory", () => {
  const f = { ...family, executionActions: [{ adapterId: "deposit", action: "deposit" }] };
  const deposit = { ...row(), stages: { discoveryCheckpoint: { edges: [{ adapterId: "deposit" }] } } };
  const unsupported = { ...row(), status: "failed", evidenceVerified: false,
    legId: "real-tx-unsupported-action", failure: { stage: "discoveryCheckpoint", reason: "case direction/route is absent or ambiguous in admitted instance" } };
  const result = summarizeFamilyTransactionResults(f, [deposit, unsupported], true);
  assert.deepEqual(result.missingActions, [], "implemented action sample exists");
  assert.equal(result.result, "failed", "implemented inventory must not hide a real TX action gap");
  assert.equal(result.legs.length, 2); assert.equal(result.legs[1].failure, unsupported.failure);
});

test("a failed leg does not hide the next result; only verified child stages enter passing evidence", async () => {
  const secondFamily = { ...family, familyId: "second" }; let attempts = 0, verifications = 0;
  const result = await round(["--rpc-file", "rpc.json"], {
    getFamilies: async () => [family, secondFamily],
    registry: () => ({ transactions: [{}], legs: [family, secondFamily].map((f, i) => ({
      path: `/seed-${i}.json`, sha256: "seed-pin", inputFingerprint: "input-pin", missing: [],
      transaction: { transactionHash: "0xabc" }, leg: { id: `leg-${i}`, familyId: f.familyId },
    })) }),
    execute: async (args: string[]) => {
      if (args[0] === "scripts/test-protocol-json.mjs") return { exitCode: 0 };
      assert.equal(args[args.indexOf("--executor-code-mode") + 1], "counterfactual");
      assert.equal(args[args.indexOf("--simulation-method") + 1], "eth_simulateV1");
      const out = args[args.indexOf("--out") + 1]!, status = ++attempts === 1 ? "failed" : "pass";
      mkdirSync(out);
      writeFileSync(resolve(out, "report.json"), JSON.stringify({ execution: { executorCodeMode: "counterfactual", simulationMethod: "eth_simulateV1" },
        stages: { exact: { status, requestedAmountIn: "7", quotedAmountOut: "9" } } }));
      return { exitCode: status === "pass" ? 0 : 1 };
    },
    verify: async () => { verifications++; },
  });
  assert.equal(attempts, 2); assert.equal(verifications, 1); assert.equal(result.exitCode, 1);
  const failed = result.report.families[0].legs[0], passed = result.report.families[1].legs[0];
  assert.equal(failed.status, "failed"); assert.equal(failed.stages, undefined);
  assert.equal(failed.reportedStages.exact.status, "failed"); assert.equal(failed.reportedStagesVerified, false);
  assert.equal(passed.status, "pass"); assert.equal(passed.evidenceVerified, true);
  assert.equal(passed.stages.exact.quotedAmountOut, "9");
  assert.equal(result.report.execution.executorCodeMode, "counterfactual");
  assert.equal(result.report.execution.simulationMethod, "eth_simulateV1");
});

test("disabled-family raw verification uses a fresh process with identical activation and cannot be skipped", async () => {
  for (const verificationExit of [0, 1]) {
    let caseEnv: unknown, verifierCalls = 0;
    const result = await round(["--rpc-file", "rpc.json"], { verify: undefined,
      execute: async (args: string[], _root: string, env: Record<string, string>) => {
        if (args[0] === "scripts/test-protocol-json.mjs") return { exitCode: 0 };
        assert.equal(env[family.envKey], "1");
        if (args.includes("--verify-report")) {
          verifierCalls++; assert.deepEqual(env, caseEnv);
          assert(args.includes("--transaction") && args.includes("--leg"));
          assert(!args.includes("--rpc-file"), "raw verification is read-only and does not resimulate");
          return { exitCode: verificationExit };
        }
        caseEnv = env;
        const out = args[args.indexOf("--out") + 1]!; mkdirSync(out);
        writeFileSync(resolve(out, "report.json"), JSON.stringify({ execution: { executorCodeMode: "counterfactual", simulationMethod: "eth_simulateV1" }, stages: {} }));
        return { exitCode: 0 };
      },
    });
    assert.equal(verifierCalls, 1); assert.equal(result.exitCode, verificationExit);
    const leg = result.report.families[0].legs[0];
    assert.equal(leg.evidenceVerified, verificationExit === 0);
    assert.equal(leg.verificationProcess.exitCode, verificationExit);
  }
});

test("TX direction/input conflict becomes incomplete only after independent raw binding verification", async () => {
  for (const verificationExit of [0, 1]) {
    let verifications = 0;
    const result = await round(["--rpc-file", "rpc.json"], { verify: undefined,
      execute: async (args: string[]) => {
        if (args[0] === "scripts/test-protocol-json.mjs") return { exitCode: 0 };
        if (args.includes("--verify-binding")) { verifications++; return { exitCode: verificationExit }; }
        const out = args[args.indexOf("--out") + 1]!; mkdirSync(out);
        writeFileSync(resolve(out, "report.json"), JSON.stringify({ result: "incomplete",
          failure: { stage: "transactionBinding" }, stages: { transactionBinding: { status: "direction-not-admitted" } } }));
        return { exitCode: 1 };
      },
    });
    const leg = result.report.families[0].legs[0];
    assert.equal(verifications, 1); assert.equal(result.exitCode, 1, "input diagnostic never passes acceptance");
    assert.equal(leg.status, verificationExit === 0 ? "incomplete" : "failed");
    assert.equal(leg.evidenceVerified, false); assert.equal(result.report.families[0].passedLegs, 0);
    assert.equal(result.report.families[0].result, verificationExit === 0 ? "incomplete" : "failed");
  }
});

test("main acceptance retains historical reference conflicts and still requires independent simulation verification", async () => {
  for (const referenceStatus of ["input-conflict", "action-conflict"]) for (const verificationExit of [0, 1]) {
    let verifications = 0;
    const result = await round(["--rpc-file", "rpc.json"], { verify: undefined,
      execute: async (args: string[]) => {
        if (args[0] === "scripts/test-protocol-json.mjs") return { exitCode: 0 };
        if (args.includes("--verify-report")) {
          verifications++;
          const report = JSON.parse(readFileSync(args[args.indexOf("--verify-report") + 1]!, "utf8"));
          assert.equal(report.stages.transactionBinding.status, referenceStatus);
          assert.equal(report.stages.exact.requestedAmountIn, "34");
          assert.equal(report.stages.quotedExecution.actualAmountIn, "34");
          return { exitCode: verificationExit };
        }
        assert(!args.includes("--verify-binding"), "reference diagnostics cannot substitute for execution verification");
        const out = args[args.indexOf("--out") + 1]!; mkdirSync(out);
        writeFileSync(resolve(out, "report.json"), JSON.stringify({ result: "pass", scope: "same-state-simulation",
          execution: { executorCodeMode: "counterfactual", simulationMethod: "eth_simulateV1" },
          originalTransactionInput: { status: "reference-only", required: false },
          stages: { transactionBinding: { status: referenceStatus },
            exact: { status: "pass", requestedAmountIn: "34", quotedAmountOut: "68" },
            quotedExecution: { status: "pass", actualAmountIn: "34", actualAmountOut: "68" } } }));
        return { exitCode: 0 };
      },
    });
    const leg = result.report.families[0].legs[0];
    assert.equal(verifications, 1); assert.equal(result.exitCode, verificationExit);
    assert.equal(leg.status, verificationExit === 0 ? "pass" : "failed");
    assert.equal(leg.evidenceVerified, verificationExit === 0);
    if (verificationExit === 0) {
      assert.deepEqual(leg.originalTransactionInput, { status: "reference-only", required: false });
      assert.equal(leg.stages.transactionBinding.status, referenceStatus);
      assert.equal(leg.stages.exact.requestedAmountIn, "34");
      assert.equal(result.report.families[0].passedLegs, 1);
    } else assert.equal(leg.stages, undefined, "unverified child stages cannot become passing evidence");
  }
});
