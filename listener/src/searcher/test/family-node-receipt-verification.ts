import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { createRevmStrictSimulationTransport } from "../revm-strict-simulation-transport.js";
import type { ExecutorRuntimeCode, StrictSimulateRequest } from "../revm-sim-client.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../venues/adapter-request-program.js";

/** Re-decode captured node receipts through the production transport. This
 * performs no RPC and issues no new admission; it cannot manufacture a result
 * for a request absent from the actual execution recording. */
export async function verifyRecordedExecutionReceipts(input: {
  readonly source: CanonicalSource;
  readonly chainId: number;
  readonly stateRoot: string;
  readonly executor: string;
  readonly owner: string;
  readonly executorRuntimeCode: ExecutorRuntimeCode;
  readonly simulations: readonly { request: Omit<StrictSimulateRequest, "rpcUrl">; response: unknown }[];
  readonly executions: readonly { request: AdapterRequest; resultEvidence: AdapterRequestResult }[];
}): Promise<void> {
  const source = { ...input.source, hash: input.source.hash.toLowerCase() };
  const remaining = new Set(input.simulations.map((_, index) => index));
  const transport = createRevmStrictSimulationTransport({
    rpcUrl: "http://127.0.0.1:1", executionGasLimit: 0x1000000,
    executorRuntimeCode: input.executorRuntimeCode,
    async leaseFor(requested) {
      assert.deepEqual(requested, source);
      return {
        source,
        sourcePin: { chainId: input.chainId, blockHash: source.hash, stateRoot: input.stateRoot.toLowerCase() },
        async strictSimulate(request) {
          const { rpcUrl: _url, ...wire } = request;
          const index = [...remaining].find(index => isDeepStrictEqual(input.simulations[index]!.request, wire));
          assert(index !== undefined, "execution has no unused matching raw node request");
          remaining.delete(index);
          return structuredClone(input.simulations[index]!.response) as never;
        },
        async closeAndDrain() {},
      };
    },
    onFatal() {}, // The transport itself throws after latching the fault.
  });
  assert(input.executions.length > 0, "no execution receipts to verify");
  for (const execution of input.executions) {
    const { request, resultEvidence: result } = execution;
    assert(request.kind === "effect-delta-simulation", "execution receipt requires the declared effect transport");
    assert.equal(request.call.executionMode, "executor-program");
    assert(result.ok && result.id === request.id, "execution result/request mismatch");
    assert.deepEqual(result.source, source);
    let decoded: Awaited<ReturnType<typeof transport.simulate>> | undefined;
    let reverted: string | undefined;
    try {
      decoded = await transport.simulate({ request, source,
        callerAuthority: { executor: input.executor, transactionOrigin: input.owner } });
    } catch (error) {
      if ((error as any)?.code !== "CALL_EXCEPTION" || typeof (error as any).data !== "string") throw error;
      reverted = (error as any).data;
    }
    if (decoded) {
      assert.equal(result.completion, "returned");
      assert.equal(result.data, decoded.data, "reported output differs from the node receipt");
      assert.deepEqual(result.effects, decoded.effects, "reported balances/logs differ from the node receipt");
    } else {
      assert.equal(result.completion, "reverted-as-declared");
      assert.equal(result.data, reverted, "reported revert differs from the node receipt");
      assert.deepEqual(result.effects, {
        ...(request.observe.includes("token-delta") ? { tokenDeltas: [] } : {}),
        ...(request.observe.includes("native-delta") ? { nativeDeltas: [] } : {}),
        ...(request.observe.includes("total-supply-delta") ? { totalSupplyDeltas: [] } : {}),
        ...(request.observe.includes("logs") ? { logs: [] } : {}),
      }, "reported rollback differs from the completed node revert");
    }
  }
}
