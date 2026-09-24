import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { familyId } from "../venues/adapter-family-identifiers.js";

test("default strict eth_call uses ethers v6 physical blockTag even while latest changes", async () => {
  const seen: string[] = [];
  let latestOutput = "0x11";
  class Provider extends ethers.AbstractProvider {
    constructor() { super(ethers.Network.from(1), { cacheTimeout: -1 }); }
    async _detectNetwork() { return ethers.Network.from(1); }
    async _perform<T = unknown>(request: ethers.PerformActionRequest): Promise<T> {
      assert.equal(request.method, "call");
      if (request.method !== "call") throw new Error("unexpected method");
      seen.push(String(request.blockTag));
      return (request.blockTag === "0x64" ? "0x11" : latestOutput) as T;
    }
  }
  const provider = new Provider();
  try {
    const runtime = createStrictCentralAdapterRuntime({ provider,
      generationFence: { assertCurrent() {} } });
    const executor = runtime.scheduler.issueExecutor({} as never).executor;
    const input = {
      familyId: familyId("test-source-pin"),
      requirements: { transports: ["eth-call" as const] },
      source: { number: 100, hash: `0x${"aa".repeat(32)}`, generation: 1 },
      requests: [{ id: "fixed-source", kind: "eth-call" as const,
        to: `0x${"12".repeat(20)}`, data: "0x12345678", completion: "return-data" as const }],
    };
    const first = await executor.execute(input);
    latestOutput = "0x22"; // Stand-in for a concurrent mutable fork/head advance.
    const second = await executor.execute(input);
    assert(first[0]!.ok); assert(second[0]!.ok);
    assert.equal(first[0]!.data, "0x11");
    assert.equal(second[0]!.data, "0x11");
    assert.deepEqual(seen, ["0x64", "0x64"]);
  } finally { provider.destroy(); }
});
