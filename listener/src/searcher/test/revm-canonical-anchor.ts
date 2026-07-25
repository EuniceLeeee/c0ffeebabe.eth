import { RevmLiveBackend } from "../live-backends/revm-live-backend.js";
import type { PrepareInput } from "../live-state-backend.js";
import type { RevmSimClient } from "../revm-sim-client.js";

const OWNER = "0x1000000000000000000000000000000000000001";
const EXECUTOR = "0x00000000000000000000000000000000b07c0de5";
const HASH_A = `0x${"11".repeat(32)}`;
const HASH_B = `0x${"22".repeat(32)}`;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

class MockClient {
  prepares = 0;
  resets = 0;

  async prepare(): Promise<void> {
    this.prepares++;
  }

  async reset(): Promise<void> {
    this.resets++;
  }
}

class MockProvider {
  private index = 0;

  constructor(private readonly hashes: string[]) {}

  async send(method: string, params: unknown[]): Promise<{ hash: string }> {
    assert(method === "eth_getBlockByNumber", `method ${method}`);
    assert(params[0] === "0x64", `block tag ${String(params[0])}`);
    const hash = this.hashes[Math.min(this.index, this.hashes.length - 1)];
    this.index++;
    assert(hash !== undefined, "missing mock hash");
    return { hash };
  }
}

function input(expectedHash = HASH_A): PrepareInput {
  return {
    event: {} as PrepareInput["event"],
    impact: null,
    baseBlock: 100,
    baseBlockHash: expectedHash,
    path: "mined",
  };
}

function backend(client: MockClient, hashes: string[]): RevmLiveBackend {
  return new RevmLiveBackend(
    client as unknown as RevmSimClient,
    EXECUTOR,
    OWNER,
    new MockProvider(hashes) as never,
    [],
    "mock://rpc",
  );
}

async function expectReject(
  promise: Promise<unknown>,
  reason: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert(String(error).includes(reason), `unexpected error ${String(error)}`);
    return;
  }
  throw new Error(`FAIL: expected ${reason}`);
}

async function main(): Promise<void> {
  const stableClient = new MockClient();
  const stable = await backend(stableClient, [HASH_A, HASH_A])
    .prepareVictimState(input());
  assert(stable.blockHash === HASH_A, `stable block hash ${stable.blockHash}`);
  assert(stableClient.prepares === 1, `stable prepares ${stableClient.prepares}`);
  assert(stableClient.resets === 0, `stable resets ${stableClient.resets}`);

  const beforeClient = new MockClient();
  await expectReject(
    backend(beforeClient, [HASH_B]).prepareVictimState(input()),
    "reorged before prepare",
  );
  assert(beforeClient.prepares === 0, `before-reorg prepares ${beforeClient.prepares}`);
  assert(beforeClient.resets === 1, `before-reorg resets ${beforeClient.resets}`);

  const duringClient = new MockClient();
  await expectReject(
    backend(duringClient, [HASH_A, HASH_B]).prepareVictimState(input()),
    "reorged during prepare",
  );
  assert(duringClient.prepares === 1, `during-reorg prepares ${duringClient.prepares}`);
  assert(duringClient.resets === 1, `during-reorg resets ${duringClient.resets}`);

  console.log("revm-canonical-anchor PASS (3/3)");
}

await main();
