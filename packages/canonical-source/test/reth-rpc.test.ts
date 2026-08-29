import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CanonicalSource,
  SQLiteCanonicalJournalStore,
  createRethCanonicalHeaderProviderV1,
  type CanonicalHeader,
} from "../src/index.ts";

const hash = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`;

async function withRpcServer(
  run: (endpoint: string) => Promise<void>,
  rawBlock?: (header: CanonicalHeader) => unknown,
): Promise<void> {
  const header: CanonicalHeader = {
    chainId: "1",
    number: "100",
    hash: hash("1"),
    parentHash: hash("9"),
    stateRoot: hash("2"),
  };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += String(chunk); });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { readonly id: number; readonly method: string; readonly params: readonly unknown[] };
      const result = parsed.method === "eth_chainId"
        ? "0x1"
        : rawBlock?.(header) ?? {
          number: "0x64",
          hash: header.hash,
          parentHash: header.parentHash,
          stateRoot: header.stateRoot,
        };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test RPC server did not bind");
  try {
    await run(`http://127.0.0.1:${address.port}/`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("Reth canonical provider reads exact chain/header facts without an injected transport", async () => {
  await withRpcServer(async endpoint => {
    const provider = createRethCanonicalHeaderProviderV1({ profile: "reth-json-rpc-v1", endpoint, chainId: "1" });
    assert.deepEqual(await provider.getLatestHeader(), {
      chainId: "1", number: "100", hash: hash("1"), parentHash: hash("9"), stateRoot: hash("2"),
    });
    assert.deepEqual(await provider.getHeader("100"), {
      kind: "found", header: {
        chainId: "1", number: "100", hash: hash("1"), parentHash: hash("9"), stateRoot: hash("2"),
      },
    });
  });
});

test("Reth canonical provider rejects missing and unknown raw block fields", async () => {
  await withRpcServer(async endpoint => {
    const provider = createRethCanonicalHeaderProviderV1({ profile: "reth-json-rpc-v1", endpoint, chainId: "1" });
    await assert.rejects(() => provider.getLatestHeader(), /parentHash/);
  }, value => ({ number: "0x64", hash: value.hash, stateRoot: value.stateRoot }));

  await withRpcServer(async endpoint => {
    const provider = createRethCanonicalHeaderProviderV1({ profile: "reth-json-rpc-v1", endpoint, chainId: "1" });
    await assert.rejects(() => provider.getLatestHeader(), /unknown Reth block field futureField/);
  }, value => ({
    number: "0x64",
    hash: value.hash,
    parentHash: value.parentHash,
    stateRoot: value.stateRoot,
    futureField: "not understood",
  }));
});

test("Reth source rejects proxy/config callback injection and binds current-head identity", async () => {
  assert.throws(
    () => createRethCanonicalHeaderProviderV1(new Proxy({ profile: "reth-json-rpc-v1", endpoint: "http://reth.test", chainId: "1" }, {})),
    /plain object|Proxy/,
  );
  assert.throws(
    () => createRethCanonicalHeaderProviderV1({ profile: "reth-json-rpc-v1", endpoint: "http://reth.test", chainId: "1", fetch: globalThis.fetch } as never),
    /unknown field|fetch/,
  );
  await withRpcServer(async endpoint => {
    const directory = mkdtempSync(join(tmpdir(), "aloha-reth-canonical-"));
    const journal = new SQLiteCanonicalJournalStore(join(directory, "journal.sqlite"));
    try {
      const source = new CanonicalSource(
        createRethCanonicalHeaderProviderV1({ profile: "reth-json-rpc-v1", endpoint, chainId: "1" }),
        { journalStore: journal },
      );
      const authority = source.authority;
      const observation = source.headObservationReader.read(await source.observeCurrentHead());
      assert.equal(observation.head.hash, hash("1"));
      assert.equal(observation.head.parentHash, hash("9"));
      assert.equal(source.authority, authority);
    } finally {
      journal.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
