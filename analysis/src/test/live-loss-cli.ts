import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ethers } from "ethers";

const ANALYSIS_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const CLI = resolve(ANALYSIS_ROOT, "src/cli/live-loss.ts");
const UNI_V2_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const POOL = "0x0de0fa91b6dbab8c8503aaa2d1dfa91a192cb149";
const WATCH = "0x1111111111111111111111111111111111111111";
const TARGET = "0x2222222222222222222222222222222222222222";
const COINBASE = "0x3333333333333333333333333333333333333333";
const TX_HASH = `0x${"4".repeat(64)}`;
const BLOCK = 100;
const factoryIface = new ethers.Interface([
  "function factory() view returns (address)",
]);

test("spawned live-loss CLI resolves canonical V2 after full module initialization", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "live-loss-cli-"));
  const events = resolve(dir, "events.jsonl");
  const graph = resolve(dir, "runtime-graph-pools.json");
  const active = resolve(dir, "active-pools.json");
  const output = resolve(dir, "output");
  writeFileSync(events, `${JSON.stringify({ target_block: BLOCK })}\n`);
  writeFileSync(graph, JSON.stringify({ pools: [{ address: POOL }] }));
  writeFileSync(active, JSON.stringify({ pools: [] }));

  let factoryProbeCalls = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id: number;
      method: string;
      params?: any[];
    };
    const send = (payload: object): void => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...payload }));
    };

    if (rpc.method === "eth_getBlockByNumber") {
      send({
        result: {
          number: `0x${BLOCK.toString(16)}`,
          miner: COINBASE,
          baseFeePerGas: "0x0",
          transactions: [{
            hash: TX_HASH,
            from: WATCH,
            to: TARGET,
          }],
        },
      });
      return;
    }
    if (rpc.method === "eth_getTransactionReceipt") {
      send({
        result: {
          transactionHash: TX_HASH,
          status: "0x1",
          from: WATCH,
          to: TARGET,
          gasUsed: "0x0",
          effectiveGasPrice: "0x0",
          logs: [{
            address: POOL,
            topics: [
              ethers.id(
                "Swap(address,uint256,uint256,uint256,uint256,address)",
              ),
              ethers.zeroPadValue(WATCH, 32),
              ethers.zeroPadValue(TARGET, 32),
            ],
            data: ethers.AbiCoder.defaultAbiCoder().encode(
              ["uint256", "uint256", "uint256", "uint256"],
              [1n, 0n, 0n, 1n],
            ),
            logIndex: "0x0",
          }],
        },
      });
      return;
    }
    if (rpc.method === "eth_call") {
      const call = rpc.params?.[0] ?? {};
      if (
        String(call.to ?? "").toLowerCase() === POOL.toLowerCase() &&
        String(call.data ?? "").toLowerCase() ===
          factoryIface.encodeFunctionData("factory").toLowerCase()
      ) {
        factoryProbeCalls++;
        send({
          result: factoryIface.encodeFunctionResult("factory", [
            UNI_V2_FACTORY,
          ]),
        });
        return;
      }
      // Chainlink ETH/USD is optional in this diagnostic and falls back.
      send({ result: "0x" });
      return;
    }
    if (rpc.method === "eth_getTransactionCount") {
      send({ result: "0x0" });
      return;
    }
    if (rpc.method === "debug_traceTransaction") {
      send({ error: { code: -32601, message: "trace disabled in fixture" } });
      return;
    }
    send({ error: { code: -32601, message: `unsupported ${rpc.method}` } });
  });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address === "object");
    const rpcUrl = `http://127.0.0.1:${address.port}`;
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      CLI,
      "--events",
      events,
      "--watch",
      WATCH,
      "--rpc",
      rpcUrl,
      "--graph-pools",
      graph,
      "--active-pools",
      active,
      "--from-block",
      String(BLOCK),
      "--to-block",
      String(BLOCK),
      "--blockscan-log",
      resolve(dir, "missing-blockscan.log"),
      "--output",
      output,
    ], {
      cwd: ANALYSIS_ROOT,
      env: {
        ...process.env,
        MAINNET_RPC_URL: "",
        READONLY_RPC_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    const [code, signal] = await once(child, "exit");
    clearTimeout(timeout);
    assert.equal(
      code,
      0,
      `live-loss CLI failed signal=${signal}\nstdout=${stdout}\nstderr=${stderr}`,
    );

    const report = JSON.parse(readFileSync(
      resolve(output, `watch-${BLOCK}-${TX_HASH.slice(2, 12)}.json`),
      "utf8",
    ));
    const venueGap = report.venue_gaps.find(
      (gap: { pool: string }) => gap.pool === POOL.toLowerCase(),
    );
    assert(venueGap, "canonical V2 pool missing from spawned CLI report");
    assert.equal(venueGap.venue, "univ2");
    assert.equal(venueGap.pool_adapter, "univ2");
    assert.equal(venueGap.gap_type, "detection_gap");
    assert.equal(
      factoryProbeCalls,
      1,
      "spawned CLI must execute the factory probe instead of swallowing a TDZ error",
    );
  } finally {
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose())
    );
    rmSync(dir, { recursive: true, force: true });
  }
});
