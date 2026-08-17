import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import {
  UNIV4_SWAP_TOPIC,
} from "../venues/swaps/univ4-abi.js";
import { UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK } from
  "../venues/swaps/univ4-common.js";
import {
  discoverRouters,
  type BlockData,
} from "../discover-routers.js";
import { loadForceIncludeRouters } from "../force-include.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function assertArrayEq(actual: string[], expected: string[], msg: string): void {
  assert(
    actual.length === expected.length && actual.every((item, i) => item === expected[i]),
    `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

const V3_SWAP_TOPIC0 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ROUTER = address(0xaa);
const ARB_BOT = address(0xbb);
const TOKEN_TRANSFER_TO = address(0xcc);
const ALLOWLISTED = address(0xdd);

interface FixtureTx {
  to: string;
  from: string;
  logAddress: string;
  topic0: string;
}

function address(byte: number): string {
  return ethers.getAddress("0x" + byte.toString(16).padStart(2, "0").repeat(20));
}

function makeBlocks(): Map<number, BlockData> {
  const byBlock = new Map<number, FixtureTx[]>();
  const routerCallers = Array.from({ length: 8 }, (_, i) => address(0x10 + i));
  const botCallers = [address(0x30), address(0x31)];
  const transferCallers = Array.from({ length: 8 }, (_, i) => address(0x40 + i));
  const allowlistedCallers = Array.from({ length: 8 }, (_, i) => address(0x50 + i));
  const pools = Array.from({ length: 6 }, (_, i) => address(0x70 + i));

  for (let i = 0; i < 20; i++) {
    addFixtureTx(byBlock, 1 + Math.floor(i / 5), {
      to: ROUTER,
      from: routerCallers[i % routerCallers.length],
      logAddress: pools[i % 5],
      topic0: V3_SWAP_TOPIC0,
    });
  }

  for (let i = 0; i < 22; i++) {
    addFixtureTx(byBlock, 1 + Math.floor(i / 6), {
      to: ARB_BOT,
      from: botCallers[i % botCallers.length],
      logAddress: pools[i % pools.length],
      topic0: V3_SWAP_TOPIC0,
    });
  }

  for (let i = 0; i < 24; i++) {
    addFixtureTx(byBlock, 1 + Math.floor(i / 6), {
      to: TOKEN_TRANSFER_TO,
      from: transferCallers[i % transferCallers.length],
      logAddress: TOKEN_TRANSFER_TO,
      topic0: TRANSFER_TOPIC0,
    });
  }

  for (let i = 0; i < 20; i++) {
    addFixtureTx(byBlock, 1 + Math.floor(i / 5), {
      to: ALLOWLISTED,
      from: allowlistedCallers[i % allowlistedCallers.length],
      logAddress: pools[i % 5],
      topic0: V3_SWAP_TOPIC0,
    });
  }

  const blocks = new Map<number, BlockData>();
  for (let n = 1; n <= 4; n++) {
    const txs = byBlock.get(n) ?? [];
    blocks.set(n, {
      number: n,
      hash: blockHash(n),
      txs: txs.map((tx) => ({ to: tx.to, from: tx.from })),
      receipts: txs.map((tx) => ({
        to: tx.to,
        logs: [{ address: tx.logAddress, topics: [tx.topic0], data: "0x" }],
      })),
    });
  }
  return blocks;
}

function addFixtureTx(byBlock: Map<number, FixtureTx[]>, block: number, tx: FixtureTx): void {
  const existing = byBlock.get(block);
  if (existing) {
    existing.push(tx);
    return;
  }
  byBlock.set(block, [tx]);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "discover-routers-"));
  try {
    const forceIncludePath = join(dir, "force-include-routers.json");
    const blocks = makeBlocks();
    const fetchBlock = async (n: number): Promise<BlockData> => {
      const block = blocks.get(n);
      if (!block) throw new Error(`missing fixture block ${n}`);
      return block;
    };
    const allowlist = new Set([ALLOWLISTED.toLowerCase()]);

    const dry = await discoverRouters({
      fromBlock: 1,
      toBlock: 4,
      allowlist,
      fetchBlock,
      append: false,
    });
    assertArrayEq(
      dry.qualified.map((candidate) => candidate.address),
      [ROUTER],
      "only the multi-caller router should qualify",
    );
    assert(
      !dry.qualified.some((candidate) => candidate.address === ARB_BOT),
      "arb-bot should be excluded by min-callers",
    );
    assert(
      !dry.qualified.some((candidate) => candidate.address === TOKEN_TRANSFER_TO),
      "token-transfer target should not qualify without swap logs",
    );
    assert(
      !dry.qualified.some((candidate) => candidate.address === ALLOWLISTED),
      "allowlisted router should not be re-suggested",
    );

    const singleton = await discoverRouters({
      fromBlock: UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK,
      toBlock: UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK,
      allowlist: new Set(),
      minTxs: 2,
      minPools: 2,
      minCallers: 1,
      append: false,
      async fetchBlock() {
        const pools = [bytes32(0xe1), bytes32(0xe2)];
        return {
          number: UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK,
          hash: blockHash(UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK),
          txs: pools.map(() => ({ to: ROUTER, from: address(0xe0) })),
          receipts: pools.map((pool) => ({
            to: ROUTER,
            logs: [{
              address: ADDR.UNISWAP_V4_POOL_MANAGER,
              topics: [UNIV4_SWAP_TOPIC, pool],
              data: "0x",
            }],
          })),
        };
      },
    });
    assert(
      singleton.qualified[0]?.pools === 2,
      "strict V4 discovery should count poolIds, not one PoolManager emitter",
    );
    const fakeSingleton = await discoverRouters({
      fromBlock: UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK,
      toBlock: UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK,
      allowlist: new Set(),
      minTxs: 1,
      minPools: 1,
      minCallers: 1,
      append: false,
      async fetchBlock() {
        return {
          number: UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK,
          hash: blockHash(UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK),
          txs: [{ to: ROUTER, from: address(0xe0) }],
          receipts: [{
            to: ROUTER,
            logs: [{
              address: address(0xef),
              topics: [UNIV4_SWAP_TOPIC, bytes32(0xe1)],
              data: "0x",
            }],
          }],
        };
      },
    });
    assert(
      fakeSingleton.qualified.length === 0,
      "foreign V4 topic emitter must not qualify a router",
    );

    const first = await discoverRouters({
      fromBlock: 1,
      toBlock: 4,
      allowlist,
      fetchBlock,
      forceIncludePath,
      append: true,
    });
    assertArrayEq(first.added, [ROUTER], "router should be appended once");
    assertArrayEq(
      loadForceIncludeRouters(forceIncludePath),
      [ROUTER],
      "temp force-include file should contain the appended router",
    );

    const second = await discoverRouters({
      fromBlock: 1,
      toBlock: 4,
      allowlist,
      fetchBlock,
      forceIncludePath,
      append: true,
    });
    assertArrayEq(second.added, [], "second append should be idempotent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("[discover-routers] strict topics + singleton pool identity + idempotence PASS");
}

function blockHash(value: number): string {
  return ethers.toBeHex(value, 32);
}

function bytes32(value: number): string {
  return ethers.toBeHex(value, 32);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
