import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  RevmSimulationClient,
  RevmSimulationError,
  hashEffectsWire,
  hashExecutionReceipt,
  hashFrozenProgram,
  type RevmSimulationReceipt,
  type RevmWorkerResultV1,
} from "../src/index.ts";
import { encodeExecutorExecuteCalldata, encodePackedCallProgram } from "../../../packages/execution-program/src/index.ts";
import {
  createNodeRevmWorkerFactory,
} from "../src/node-worker-factory.ts";
import {
  RevmWorkerPool,
  type RevmWorkerFactory,
  type RevmWorkerQualification,
} from "../src/lifecycle.ts";
import { createTestRevmAuthorityIssuer } from "./qualified-authority.ts";

const h = (value: string): Hash => hashDomain("test/revm-worker-rust-integration", value);
const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const manifestPath = fileURLToPath(new URL("../../revm-worker-rust/Cargo.toml", import.meta.url));
const binaryPath = fileURLToPath(new URL("../../revm-worker-rust/target/debug/aloha-revm-worker", import.meta.url));

const qualification: RevmWorkerQualification = Object.freeze({
  // Keep the test-only release fixture and the actual executable's hello
  // projection joined on the same selected-executor fingerprints.
  engineBuildFingerprint: h("engine"),
  executableFingerprint: h("executable"),
});
const workerEpoch = "rust-integration-epoch";
const caller = "0x1111111111111111111111111111111111111111";
const target = "0x2222222222222222222222222222222222222222";
const incrementTarget = "0x3333333333333333333333333333333333333333";
const revertTarget = "0x4444444444444444444444444444444444444444";
const observeAccounts = Object.freeze([caller, target]);
const programBody = Object.freeze({
  format: "frozen-program-v1" as const,
  schemaHash: h("program-schema"),
  // Return the 32-byte ABI encoding of uint256(42).
  bytes: "0x602a60005260206000f3",
});
const program = Object.freeze({
  ...programBody,
  programHash: hashFrozenProgram({ ...programBody, programHash: "placeholder" }),
});
const expectedOutput = `0x${"0".repeat(62)}2a`;
const source = Object.freeze({ chainId: "1", number: "123", hash: h("block"), stateRoot: h("state") });

function rustWorkerFactory(events?: string[], transformLine?: (line: string) => string): RevmWorkerFactory {
  return Object.freeze({
    async spawn(epoch: string) {
      // The production Node adapter intentionally receives a static command
      // configuration; the test closure binds each authority-issued epoch as
      // an executable argument without changing production authority code.
      const channel = await createNodeRevmWorkerFactory({
        command: binaryPath,
        args: ["--worker-epoch", epoch],
        cwd: workspaceRoot,
        env: {
          ...process.env,
          REVM_ENGINE_BUILD_FINGERPRINT: qualification.engineBuildFingerprint,
          REVM_EXECUTABLE_FINGERPRINT: qualification.executableFingerprint,
        },
        qualification,
      }).spawn(epoch);
      if (events === undefined && transformLine === undefined) return channel;
      return Object.freeze({
        async send(line: string) {
          const message = JSON.parse(line) as { readonly kind?: string; readonly requestId?: string };
          events?.push(`send:${message.kind ?? "unknown"}:${message.requestId ?? "none"}`);
          await channel.send(transformLine?.(line) ?? line);
          events?.push(`sent:${message.kind ?? "unknown"}:${message.requestId ?? "none"}`);
        },
        onLine(listener: (line: string) => void) {
          return channel.onLine((line) => {
            const message = JSON.parse(line) as { readonly kind?: string; readonly requestId?: string };
            events?.push(`line:${message.kind ?? "unknown"}:${message.requestId ?? "none"}`);
            listener(line);
          });
        },
        onExit(listener: (code: number | null) => void) {
          return channel.onExit((code) => {
            events?.push(`exit:${code ?? "null"}`);
            listener(code);
          });
        },
        kill: channel.kill,
        waitForExit: channel.waitForExit,
      });
    },
  });
}

function explicitInput(callerCode: string) {
  return {
    to: target,
    calldata: "0x",
    gasLimit: "1000000",
    value: "0",
    chainId: "1",
    block: { timestamp: "7", gasLimit: "30000000" },
    accounts: {
      [caller]: { balance: "0", nonce: "0", code: callerCode },
      [target]: { balance: "0", nonce: "0" },
    },
  } as const;
}

function request(requestId: string, attemptId: string, input = explicitInput("0x")) {
  return {
    requestId,
    ownerRef: "rust-integration-owner",
    generationId: "rust-integration-generation",
    attemptId,
    source,
    caller: { address: caller, mode: "top-level" as const, observedSender: caller, verifiedActors: {} },
    observeAccounts,
    program,
    input,
    deadlineAtMs: performance.now() + 10_000,
  };
}

function wireResult(receipt: RevmSimulationReceipt) {
  const { kind: _receiptKind, ...fields } = receipt;
  return {
    wireVersion: 1 as const,
    kind: "response" as const,
    op: "simulate" as const,
    ...fields,
  } as unknown as RevmWorkerResultV1;
}

function assertReceipt(receipt: RevmSimulationReceipt, requestId: string): void {
  assert.equal(receipt.requestId, requestId);
  assert.equal(receipt.status, "returned");
  assert.equal(receipt.output, expectedOutput);
  assert.equal(receipt.programHash, program.programHash);
  assert.deepEqual(receipt.effects.observedAccounts, observeAccounts);
  assert.equal(receipt.effects.effectsHash, hashEffectsWire(receipt.effects));
  assert.equal(receipt.executionReceiptHash, hashExecutionReceipt(wireResult(receipt)));
}

function patchedExecutorRuntime(owner: string): string {
  execFileSync("forge", ["build", "--root", "contracts", "--force"], { cwd: workspaceRoot, stdio: "inherit" });
  const artifactPath = fileURLToPath(new URL("../../../contracts/out/AlohaCallExecutor.sol/AlohaCallExecutor.json", import.meta.url));
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
    readonly deployedBytecode: { readonly object: string; readonly immutableReferences: Readonly<Record<string, readonly { readonly start: number; readonly length: number }[]>> };
  };
  let body = artifact.deployedBytecode.object.slice(2);
  const ownerWord = owner.slice(2).padStart(64, "0");
  for (const refs of Object.values(artifact.deployedBytecode.immutableReferences)) {
    for (const ref of refs) {
      const start = ref.start * 2;
      const end = start + ref.length * 2;
      if (ref.length !== 32 || ownerWord.length !== end - start) throw new Error("executor immutable reference shape mismatch");
      body = body.slice(0, start) + ownerWord + body.slice(end);
    }
  }
  return `0x${body}`;
}

const incrementCode = "0x60005460010160005560005460005260206000f3";
const revertCode = "0x60006000fd";

function executorCalldata(targets: readonly string[]): string {
  return encodeExecutorExecuteCalldata(encodePackedCallProgram(targets.map(targetAddress => ({ target: targetAddress as `0x${string}`, value: "0", calldata: "0x" }))));
}

function executorInput(calldata: string, executorCode: string) {
  return {
    to: target,
    target,
    data: calldata,
    calldata,
    gasLimit: "1000000",
    value: "0",
    chainId: "1",
    block: { timestamp: "7", gasLimit: "30000000" },
    accounts: {
      [caller]: { balance: "0", nonce: "0", code: "0x" },
      [target]: { balance: "0", nonce: "0", code: executorCode },
      [incrementTarget]: { balance: "0", nonce: "0", code: incrementCode, storage: { "0x0": "0" } },
      [revertTarget]: { balance: "0", nonce: "0", code: revertCode },
    },
  } as const;
}

function executorProgram(calldata: string) {
  const body = Object.freeze({ format: "frozen-program-v1" as const, schemaHash: h("executor-schema"), bytes: calldata });
  return Object.freeze({ ...body, programHash: hashFrozenProgram({ ...body, programHash: "placeholder" }) });
}

function executorRequest(requestId: string, attemptId: string, calldata: string, executorCode: string) {
  return {
    requestId,
    ownerRef: "rust-integration-owner",
    generationId: "rust-integration-generation",
    attemptId,
    source,
    caller: { address: caller, mode: "top-level" as const, observedSender: caller, verifiedActors: {} },
    observeAccounts: Object.freeze([caller, target, incrementTarget, revertTarget].sort()),
    program: executorProgram(calldata),
    input: executorInput(calldata, executorCode),
    deadlineAtMs: performance.now() + 10_000,
  };
}

test("real Rust worker returns verified EVM output, stays resident, and keeps top-level EIP-3607 enabled", { concurrency: false }, async () => {
  execFileSync("cargo", ["build", "--quiet", "--manifest-path", manifestPath], { cwd: workspaceRoot, stdio: "inherit" });

  const pool = new RevmWorkerPool({
    factory: rustWorkerFactory(),
    authority: createTestRevmAuthorityIssuer([workerEpoch]),
    qualification,
    maxWorkers: 1,
    timeoutMs: 15_000,
  });
  const client = new RevmSimulationClient({ pool });
  try {
    const first = await client.simulate(request("rust-request-1", "rust-attempt-1"));
    assertReceipt(first, "rust-request-1");
    const firstSnapshot = client.snapshot();
    assert.ok(firstSnapshot);
    assert.equal(firstSnapshot.workers.length, 1);
    assert.equal(firstSnapshot.workers[0]?.state, "ready");

    const second = await client.simulate(request("rust-request-2", "rust-attempt-2"));
    assertReceipt(second, "rust-request-2");
    assert.equal(second.workerEpoch, first.workerEpoch);
    const secondSnapshot = client.snapshot();
    assert.ok(secondSnapshot);
    assert.equal(secondSnapshot.workers.length, 1);
    assert.equal(secondSnapshot.workers[0]?.state, "ready");
    assert.equal(secondSnapshot.workers[0]?.epoch, first.workerEpoch);

    // A top-level caller with deployed code must not be accepted by a worker
    // that globally disables EIP-3607.  The real Rust process rejects it;
    // the resident controller remains available for a subsequent request.
    const eip3607StartedAt = performance.now();
    await assert.rejects(
      client.simulate(request("rust-request-eip3607", "rust-attempt-eip3607", explicitInput("0x6000"))),
      (error: unknown) => error instanceof RevmSimulationError && error.code === "worker-error",
    );
    assert.ok(performance.now() - eip3607StartedAt < 2_000, "top-level EIP-3607 rejection must not wait for request deadline");
    const third = await client.simulate(request("rust-request-3", "rust-attempt-3"));
    assertReceipt(third, "rust-request-3");
    assert.equal(third.workerEpoch, first.workerEpoch);
  } finally {
    await pool.retireAll();
  }
});

test("real Rust worker echoes and hashes an optional effect transport declaration", { concurrency: false }, async () => {
  const effectTransport = {
    caller: { ref: { kind: "observed-sender" as const }, executionMode: "top-level" as const },
    preCalls: [],
    observeTokenBalances: [],
    observeLogs: true,
  };
  const effectProgramBody = Object.freeze({ ...programBody, effectTransport });
  const effectProgram = Object.freeze({ ...effectProgramBody, programHash: hashFrozenProgram({ ...effectProgramBody, programHash: "placeholder" }) });
  const pool = new RevmWorkerPool({
    factory: rustWorkerFactory(),
    authority: createTestRevmAuthorityIssuer([workerEpoch]),
    qualification,
    maxWorkers: 1,
    timeoutMs: 15_000,
  });
  const client = new RevmSimulationClient({ pool });
  try {
    const result = await client.simulate({ ...request("rust-effect-transport", "rust-effect-attempt"), program: effectProgram });
    assert.equal(result.status, "returned");
    assert.deepEqual(result.effectTransport, effectTransport);
    assert.equal(result.executionReceiptHash, hashExecutionReceipt(wireResult(result)));
  } finally {
    await pool.retireAll();
  }
});

test("real Rust worker rejects bindable non-canonical request bytes without waiting for the deadline", { concurrency: false }, async () => {
  let mutateNextRequest = true;
  const pool = new RevmWorkerPool({
    factory: rustWorkerFactory(undefined, (line) => {
      if (!mutateNextRequest) return line;
      mutateNextRequest = false;
      const decoded = JSON.parse(line) as { readonly deadlineAtMs: number };
      const canonical = JSON.stringify(decoded.deadlineAtMs);
      const mutated = line.replace(`"deadlineAtMs":${canonical}`, `"deadlineAtMs":${canonical}.0`);
      assert.notEqual(mutated, line, "test mutation must change canonical deadline bytes");
      return mutated;
    }),
    authority: createTestRevmAuthorityIssuer([workerEpoch]),
    qualification,
    maxWorkers: 1,
    timeoutMs: 15_000,
  });
  const client = new RevmSimulationClient({ pool });
  try {
    const startedAt = performance.now();
    await assert.rejects(
      client.simulate({
        ...request("rust-non-canonical", "rust-non-canonical-attempt"),
        deadlineAtMs: Math.ceil(performance.now() + 10_000),
      }),
      (error: unknown) => error instanceof RevmSimulationError && error.code === "worker-error",
    );
    assert.ok(performance.now() - startedAt < 2_000, "non-canonical input must return an invalid-request response before its deadline");
    const recovered = await client.simulate(request("rust-after-non-canonical", "rust-after-non-canonical-attempt"));
    assertReceipt(recovered, "rust-after-non-canonical");
  } finally {
    await pool.retireAll();
  }
});

test("real compiled AlohaCallExecutor performs ordered CALLs and atomically reverts mutated programs", { concurrency: false }, async () => {
  const events: string[] = [];
  const executorCode = patchedExecutorRuntime(caller);
  const successCalldata = executorCalldata([incrementTarget, incrementTarget]);
  const failingCalldata = executorCalldata([incrementTarget, revertTarget]);
  const pool = new RevmWorkerPool({
    factory: rustWorkerFactory(events),
    authority: createTestRevmAuthorityIssuer([workerEpoch]),
    qualification,
    maxWorkers: 1,
    timeoutMs: 15_000,
  });
  const client = new RevmSimulationClient({ pool });
  try {
    let success: RevmSimulationReceipt;
    try {
      success = await client.simulate(executorRequest("executor-request-ordered", "executor-attempt-ordered", successCalldata, executorCode));
    } catch (error) {
      assert.fail(`ordered execution failed: ${error instanceof Error ? error.message : String(error)} events=${JSON.stringify(events)} snapshot=${JSON.stringify(client.snapshot())}`);
    }
    assert.equal(success.status, "returned");
    assert.equal(success.output, `0x${"0".repeat(62)}20${"0".repeat(62)}20${"0".repeat(62)}02`);
    assert.deepEqual(success.effects.observedAccounts, [caller, target, incrementTarget, revertTarget].sort());

    // The second CALL is a real target revert.  The executor's low-level
    // CALL failure must revert the whole transaction, including the first
    // target's SSTORE; the worker reports the chain result as reverted.
    let reverted: RevmSimulationReceipt;
    try {
      reverted = await client.simulate(executorRequest("executor-request-atomic", "executor-attempt-atomic", failingCalldata, executorCode));
    } catch (error) {
      assert.fail(`atomic execution failed: ${error instanceof Error ? error.message : String(error)} events=${JSON.stringify(events)} snapshot=${JSON.stringify(client.snapshot())}`);
    }
    assert.equal(reverted.status, "reverted");
    assert.match(reverted.output, /^0x[0-9a-f]+$/);
    assert.notEqual(reverted.output, success.output);
    const afterRevert = client.snapshot();
    assert.equal(afterRevert?.workers.length, 1);
    assert.equal(afterRevert?.workers[0]?.state, "ready");
    assert.equal(afterRevert?.workers[0]?.epoch, success.workerEpoch);

    // A chain-level atomic revert is a valid final-simulation fact, not a
    // transport failure.  The same qualified resident worker must remain
    // usable for the next independently bound request.
    let recovered: RevmSimulationReceipt;
    try {
      recovered = await client.simulate(executorRequest(
        "executor-request-after-revert",
        "executor-attempt-after-revert",
        successCalldata,
        executorCode,
      ));
    } catch (error) {
      assert.fail(`resident recovery failed: ${error instanceof Error ? error.message : String(error)} events=${JSON.stringify(events)} snapshot=${JSON.stringify(client.snapshot())}`);
    }
    assert.equal(recovered.status, "returned");
    assert.equal(recovered.output, success.output);
    assert.equal(recovered.workerEpoch, success.workerEpoch);
    assert.deepEqual(events, [
      "line:hello:none",
      "send:request:executor-request-ordered",
      "sent:request:executor-request-ordered",
      "line:response:executor-request-ordered",
      "send:request:executor-request-atomic",
      "sent:request:executor-request-atomic",
      "line:response:executor-request-atomic",
      "send:request:executor-request-after-revert",
      "sent:request:executor-request-after-revert",
      "line:response:executor-request-after-revert",
    ]);

    // A changed instruction is a distinct frozen request/program identity;
    // the compiled executor, rather than the generic worker, rejects it.
    assert.notEqual(successCalldata, failingCalldata);
    assert.notEqual(success.programHash, reverted.programHash);
  } finally {
    await pool.retireAll();
  }
});
