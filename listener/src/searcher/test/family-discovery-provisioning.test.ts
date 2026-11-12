import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { candidatesFromCall, createProbeWiring, createRebuildWiring } from "../universe-rebuild-production.js";
import { NodeStrictClient } from "../simulator/node-strict-client.js";
import { RebuildReadProvider } from "../rebuild-read-provider.js";
import { observeAdapterRequests } from "../adapter-request-observation.js";
import { RevmStrictError, type DaemonResponse, type StrictSimulateRequest } from "../revm-sim-client.js";
import { nodeSimulateV1Environment } from "../simulator/node-simulate-v1.js";
import { PSM_INTERFACE } from "../venues/protocols/psm-family/codec.js";

const executor = "0x" + "33".repeat(20), owner = "0x" + "44".repeat(20);
const source = { number: 25_750_000, hash: "0x" + "a1".repeat(32), generation: 1 };
const runtimeCode = { code: "0x60006000", keccak256: ethers.keccak256("0x60006000") };
const identity = { executor, transactionOrigin: owner };
const provisioning = { owner, runtimeCode };
const common = { rpcUrl: "http://127.0.0.1:1", familyIds: ["protocol:psm"], executionIdentity: identity };
const header = { number: `0x${source.number.toString(16)}`, hash: source.hash,
  parentHash: ethers.ZeroHash, stateRoot: "0x" + "aa".repeat(32), timestamp: "0x12340000", gasLimit: "0x3938700" };

test("explicit Discovery provisioning binds owner and bytecode, while keeping family definitions unchanged", () => {
  for (const create of [createProbeWiring, createRebuildWiring]) {
    assert.throws(() => create({ rpcUrl: common.rpcUrl, testExecutorProvisioning: provisioning }), /explicit executor/);
    assert.throws(() => create({ ...common, testExecutorProvisioning: { ...provisioning, owner: executor } }), /matching distinct owner/);
    assert.throws(() => create({ ...common, testExecutorProvisioning: { owner, runtimeCode: { ...runtimeCode, code: "0x" } } }), /code\/hash/);
    assert.throws(() => create({ ...common, testExecutorProvisioning: { owner, runtimeCode: { ...runtimeCode, keccak256: ethers.ZeroHash } } }), /code\/hash/);
  }
  const deployed = createRebuildWiring(common);
  const provisioned = createRebuildWiring({ ...common, testExecutorProvisioning: provisioning, simulationMethod: "eth_simulateV1" });
  assert.notEqual(deployed.readyReviewInputFingerprint!(), provisioned.readyReviewInputFingerprint!());
  assert.equal(deployed.familyDefinitionHash!("protocol:psm"), provisioned.familyDefinitionHash!("protocol:psm"));
});

test("natural production attestation forwards code capability and V1 environment, refusing occupied executors", async () => {
  let sourceCode = "0x", expectedOverride = true, provision = true;
  let expectedMethod: "eth_simulateV1" | undefined = "eth_simulateV1";
  let proofs = 0, simulatedReads = 0, legacyReads = 0, controlledReads = 0, revertRead = false;
  const restorers: (() => void)[] = [];
  const replace = (target: object, key: string, value: unknown) => {
    const old = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
    restorers.push(() => { if (old) Object.defineProperty(target, key, old); else Reflect.deleteProperty(target, key); });
  };
  const returns = (transaction: { to: string; data: string }): string => {
    assert.equal(transaction.to.toLowerCase(), ADDR.SKY_PSM_LITE.toLowerCase());
    const call = PSM_INTERFACE.parseTransaction(transaction)!;
    const values: Record<string, unknown> = { gem: ADDR.USDC, dai: ADDR.DAI, pocket: "0x" + "bc".repeat(20),
      to18ConversionFactor: 10n ** 12n, tin: 0n, tout: 0n };
    assert(Object.hasOwn(values, call.name));
    return PSM_INTERFACE.encodeFunctionResult(call.name, [values[call.name]]);
  };
  try {
    replace(ethers.JsonRpcProvider.prototype, "getNetwork", async () => ethers.Network.from(1));
    replace(ethers.JsonRpcProvider.prototype, "getCode", async (address: string, n: number) => {
      assert.equal(n, source.number); return address.toLowerCase() === executor ? sourceCode : "0x6000";
    });
    replace(ethers.JsonRpcProvider.prototype, "getStorage", async () => ethers.ZeroHash);
    const send = async (method: string, params: any[]) => {
      if (method === "eth_getBlockByHash") { assert.equal(params[0], source.hash); return header; }
      if (method === "eth_getBlockByNumber") { assert.equal(params[0], header.number); return header; }
      if (method === "eth_call") { legacyReads++; return returns(params[0]); }
      assert.equal(method, "eth_simulateV1", "Discovery must not silently switch execution transports");
      simulatedReads++; assert.equal(params[1], header.number);
      const block = params[0].blockStateCalls[0], env = nodeSimulateV1Environment(header);
      assert.deepEqual(block.blockOverrides, env.blockOverrides);
      assert.deepEqual(block.stateOverrides, {});
      return [{ number: env.blockOverrides.number, timestamp: env.blockOverrides.time,
        gasLimit: env.blockOverrides.gasLimit, baseFeePerGas: "0x0", parentHash: source.hash,
        calls: block.calls.map((tx: { to: string; data: string }) => {
          assert(!Object.hasOwn(tx, "blockTag"), "central runtime's blockTag must not leak onto the V1 wire");
          return revertRead ? { status: "0x0", gasUsed: "0x5208", returnData: "0x", error: { code: 3, message: "execution reverted" } }
            : { status: "0x1", gasUsed: "0x5208", returnData: returns(tx) };
        }) }];
    };
    replace(ethers.JsonRpcProvider.prototype, "send", send);
    replace(RebuildReadProvider.prototype, "sendControlled", async (method: string, params: any[], control: { deadlineAtMs?: number }) => {
      if (control?.deadlineAtMs !== undefined) assert(Number.isFinite(control.deadlineAtMs));
      controlledReads++;
      return send(method, params);
    });
    replace(NodeStrictClient.prototype, "strictSimulate", async function (this: NodeStrictClient, req: StrictSimulateRequest): Promise<DaemonResponse> {
      proofs++;
      const options = (this as unknown as { options: ConstructorParameters<typeof NodeStrictClient>[0] }).options;
      assert.equal(options.simulationMethod, expectedMethod);
      assert.equal(options.allowExecutorCodeOverride, expectedOverride);
      assert.equal(req.blockNumber, source.number); assert.equal(req.sourcePin?.blockHash, source.hash);
      assert.equal(req.from, executor); assert.equal(req.transactionOrigin, owner);
      if (!provision) {
        assert.equal(options.executorRuntimeCode, undefined);
        throw new RevmStrictError("validation", "unprovisioned empty executor");
      }
      assert.deepEqual(options.executorRuntimeCode, runtimeCode);
      const call = PSM_INTERFACE.parseTransaction({ data: req.data })!;
      const gem = BigInt(call.args[1]), dai = gem * 10n ** 12n;
      const deltas = call.name === "sellGem" ? [-gem, gem, dai, -dai] : [-dai, dai, gem, -gem];
      const output = PSM_INTERFACE.encodeFunctionResult(call.name, []);
      return { ok: true, success: true, output, gasUsed: "21000", latencyMs: 1,
        sourceAttestation: { kind: "node-attested", chainId: 1, blockNumber: source.number,
          blockHash: source.hash, parentHash: header.parentHash, stateRoot: header.stateRoot },
        strict: { outcome: { kind: "Success", phase: "main", output }, executionGasUsed: "21000",
          ...(options.allowExecutorCodeOverride ? { counterfactualExecutorCode: { address: options.executor!, keccak256: options.executorRuntimeCode!.keccak256 } } : {}),
          tokenDeltas: req.observeTokenBalances!.map((pair, i) => ({ ...pair, delta: String(deltas[i]) })),
          nativeDeltas: [], totalSupplyDeltas: [], logs: [] } };
    });
    const candidate = candidatesFromCall({ kind: "call", target: ADDR.SKY_PSM_LITE,
      data: PSM_INTERFACE.encodeFunctionData("sellGem", [owner, 1n]), sender: owner,
      transactionHash: "0x" + "ce".repeat(32), blockNumber: source.number, blockHash: source.hash, traceAddress: [0] })[0]!;
    const attempt = () => createRebuildWiring({ ...common,
      ...(provision ? { testExecutorProvisioning: provisioning } : {}), simulationMethod: expectedMethod,
    }).attestFamilyInstanceOnce({ candidate, cutoff: source });
    const admitted = await attempt();
    assert.equal(admitted.status, "verified", `the installed Family must issue natural attestation: ${JSON.stringify(admitted, (_k, v) => typeof v === "bigint" ? v.toString() : v)}`);
    assert.equal(proofs, 4); assert(simulatedReads > 0); assert(controlledReads > simulatedReads); assert.equal(legacyReads, 0);
    sourceCode = runtimeCode.code; expectedOverride = false;
    assert.equal((await attempt()).status, "verified", "matching existing executor code does not require an override");
    assert.equal(proofs, 8);
    sourceCode = "0x6001";
    const occupied = await attempt();
    assert.equal(occupied.status, "retryable");
    assert.match(occupied.status === "retryable" ? occupied.reasonCode : "", /different deployed code/);
    assert.equal(proofs, 8, "occupied executor must fail before any active probe");
    sourceCode = "0x"; expectedOverride = true; revertRead = true;
    const observation = { revertedResults: 0 };
    assert.notEqual((await observeAdapterRequests(observation, attempt)).status, "verified");
    assert(observation.revertedResults > 0, "completed V1 call reverts retain central chain-negative classification");
    revertRead = false; expectedOverride = false;
    sourceCode = "0x"; provision = false; expectedMethod = undefined;
    assert.notEqual((await attempt()).status, "verified", "default wiring cannot provision an empty executor");
    assert(legacyReads > 0, "omitted method retains existing provider behavior");
  } finally { for (const restore of restorers.reverse()) restore(); }
});

test("controlled Discovery reads abort physical sockets and cannot dispatch expired queued work", { timeout: 5000 }, async () => {
  let requests = 0, started: (() => void) | undefined;
  const server = createServer((request, response) => {
    request.resume(); request.on("end", () => { requests++; started?.(); });
    response.on("error", () => {});
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const provider = new RebuildReadProvider(operation => operation(), `http://127.0.0.1:${address.port}`,
    ethers.Network.from(1), { staticNetwork: true, maxPhysicalRequests: 1, requestTimeoutMs: 2000 });
  try {
    const controller = new AbortController(), queue = new AbortController();
    const entered = new Promise<void>(resolve => { started = resolve; });
    const first = provider.sendControlled("eth_chainId", [], { signal: controller.signal });
    const failedFirst = assert.rejects(first, /cancelled fixture/);
    await entered;
    const second = provider.sendControlled("eth_chainId", [], { signal: queue.signal });
    const failedSecond = assert.rejects(second, /cancelled queue/);
    queue.abort(new Error("cancelled queue")); controller.abort(new Error("cancelled fixture"));
    await Promise.all([failedFirst, failedSecond]);
    assert.equal(requests, 1, "queued cancellation must settle without another HTTP request");
    await assert.rejects(provider.sendControlled("eth_chainId", [], { deadlineAtMs: Date.now() - 1 }), /deadline/);
    assert.equal(requests, 1);
    await assert.rejects(provider.sendControlled("eth_chainId", [], { deadlineAtMs: Date.now() + 80 }), /deadline/);
    assert.equal(requests, 2, "a stalled physical request is bounded by the work deadline");
  } finally {
    provider.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
