import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  sha256Canonical,
  type ConversionCandidate,
  type ConversionEligibilityPlan,
} from "./adapter-family-blind-contract.js";
import {
  buildConversionFreshnessPlan,
  revealConversionFreshness,
  scanConversionFreshness,
  type ConversionFreshnessPrivateEvidenceBundle,
  type ConversionFreshnessReveal,
} from "./conversion-freshness-oracle.js";
import {
  replayPersistedConversionFreshness,
} from "./conversion-freshness-production-resume.js";
import {
  WSTETH_FRESHNESS_INTEGRATION_RANGE,
  WSTETH_FRESHNESS_KNOWN_CANDIDATES,
  wstethFreshnessPrivatePredicate,
} from "./fixtures/conversion-freshness-wsteth.js";

const root = mkdtempSync(resolve(tmpdir(), "conversion-freshness-oracle-"));
const cli = fileURLToPath(
  new URL("./conversion-freshness-oracle.ts", import.meta.url),
);
const listenerRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const predicate = wstethFreshnessPrivatePredicate();
const secret = { seed: "trusted-seed", salt: "trusted-salt" };

try {
  const rpc = createFixtureRpc(WSTETH_FRESHNESS_KNOWN_CANDIDATES);
  const port = await listen(rpc);
  const rpcUrl = `http://127.0.0.1:${port}`;
  try {
    const predicatePath = resolve(root, "private-predicate.json");
    const secretPath = resolve(root, "private-secret.json");
    const planPath = resolve(root, "public-plan.json");
    const candidatesPath = resolve(root, "private-candidates.json");
    const evidencePath = resolve(root, "private-evidence.json");
    const revealPath = resolve(root, "private-reveal.json");
    writeFileSync(predicatePath, `${canonicalJson(predicate)}\n`, { mode: 0o600 });
    writeFileSync(secretPath, `${canonicalJson(secret)}\n`, { mode: 0o600 });

    const committed = await runCli([
      "commit",
      "--predicate-file",
      predicatePath,
      "--from-block",
      String(WSTETH_FRESHNESS_INTEGRATION_RANGE.fromBlock),
      "--to-block",
      String(WSTETH_FRESHNESS_INTEGRATION_RANGE.toBlock),
      "--min-eligible-cardinality",
      "32",
      "--production-inputs-sha256",
      "ab".repeat(32),
      "--secret-file",
      secretPath,
      "--out",
      planPath,
    ]);
    assert.equal(committed.code, 0, committed.stderr);
    const plan = readJson<ConversionEligibilityPlan>(planPath);
    const publicPlan = readFileSync(planPath, "utf8").toLowerCase();
    for (const privateValue of [
      predicate.protocol,
      predicate.instanceAddress,
      predicate.event.address,
      predicate.event.topic0,
      ...predicate.rateReads.map((read) => read.data),
      ...WSTETH_FRESHNESS_KNOWN_CANDIDATES.map(String),
    ]) {
      assert.equal(
        publicPlan.includes(privateValue.toLowerCase()),
        false,
        `pre-scan plan leaked ${privateValue}`,
      );
    }
    assert(committed.stdout.includes(`CONVERSION_RANGE_HASH=${plan.range.rangeHash}`));
    assert(committed.stdout.includes(
      `CONVERSION_PREDICATE_SHA256=${plan.predicateSha256}`,
    ));
    assert(committed.stdout.includes(
      `CONVERSION_SEED_COMMITMENT=${plan.seedCommitment}`,
    ));

    const scanned = await runCli([
      "scan",
      "--plan",
      planPath,
      "--predicate-file",
      predicatePath,
      "--log-chunk-size",
      "1000",
      "--candidates-out",
      candidatesPath,
      "--evidence-out",
      evidencePath,
    ], {
      CONVERSION_FRESHNESS_RPC_URL: rpcUrl,
    });
    assert.equal(scanned.code, 0, scanned.stderr);
    for (const privateValue of [
      predicate.protocol,
      predicate.instanceAddress,
      ...WSTETH_FRESHNESS_KNOWN_CANDIDATES.map(String),
    ]) {
      assert.equal(
        scanned.stdout.toLowerCase().includes(privateValue.toLowerCase()),
        false,
        "scan stdout leaked private oracle metadata",
      );
    }
    const candidates = readJson<ConversionCandidate[]>(candidatesPath);
    assert.deepEqual(
      candidates.map((candidate) => candidate.sourceBlock),
      [...WSTETH_FRESHNESS_KNOWN_CANDIDATES],
    );
    assert(
      candidates.every((candidate) =>
        canonicalJson(Object.keys(candidate).sort()) ===
          canonicalJson(["evidenceSha256", "id", "sourceBlock"])
      ),
      "candidate output must contain only ConversionCandidate fields",
    );
    assert.equal(statSync(candidatesPath).mode & 0o777, 0o600);
    assert.equal(statSync(evidencePath).mode & 0o777, 0o600);
    const candidateText = readFileSync(candidatesPath, "utf8").toLowerCase();
    assert.equal(candidateText.includes(predicate.protocol), false);
    assert.equal(candidateText.includes(predicate.instanceAddress), false);
    const evidence = readJson<ConversionFreshnessPrivateEvidenceBundle>(
      evidencePath,
    );
    assert.equal(evidence.eligible.length, 2);
    assert(
      evidence.eligible.every((entry) =>
        entry.evidence.topologyUnchanged &&
        entry.evidence.rateChangedAtSource &&
        entry.evidence.rates.every((rate) => rate.changed)
      ),
    );

    const revealed = await runCli([
      "reveal",
      "--plan",
      planPath,
      "--predicate-file",
      predicatePath,
      "--candidates",
      candidatesPath,
      "--evidence",
      evidencePath,
      "--secret-file",
      secretPath,
      "--out",
      revealPath,
    ]);
    assert.equal(revealed.code, 2, revealed.stderr);
    const missing = readJson<ConversionFreshnessReveal>(revealPath);
    assert.equal(missing.freshnessEvidence, "missing");
    assert.equal(missing.selected, null);
    assert.equal(missing.selectedEvidence, null);
    assert.equal(statSync(revealPath).mode & 0o777, 0o600);

    const tamperedPredicatePath = resolve(root, "tampered-predicate.json");
    writeFileSync(
      tamperedPredicatePath,
      `${canonicalJson({
        ...predicate,
        protocol: "tampered-private-protocol",
      })}\n`,
      { mode: 0o600 },
    );
    const rejected = await runCli([
      "scan",
      "--plan",
      planPath,
      "--predicate-file",
      tamperedPredicatePath,
      "--candidates-out",
      resolve(root, "rejected-candidates.json"),
      "--evidence-out",
      resolve(root, "rejected-evidence.json"),
    ], {
      CONVERSION_FRESHNESS_RPC_URL: rpcUrl,
    });
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /predicate commitment mismatch/);
  } finally {
    await close(rpc);
  }

  await assertSelectedRevealPath();
  console.log("conversion-freshness-oracle PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}

async function assertSelectedRevealPath(): Promise<void> {
  const eventBlocks = Object.freeze(
    Array.from({ length: 32 }, (_, index) => 1_001 + index),
  );
  const rpc = createFixtureRpc(eventBlocks);
  const port = await listen(rpc);
  try {
    const selectedPlan = buildConversionFreshnessPlan({
      predicate,
      fromBlock: 1_000,
      toBlock: 1_100,
      minEligibleCardinality: 32,
      productionInputsSha256: "ab".repeat(32),
      secret,
    });
    const scanned = await scanConversionFreshness({
      plan: selectedPlan,
      predicate,
      rpcUrl: `http://127.0.0.1:${port}`,
      logChunkSize: 50,
    });
    assert.equal(scanned.candidates.length, 32);
    const revealed = revealConversionFreshness({
      plan: selectedPlan,
      predicate,
      candidates: scanned.candidates,
      privateEvidence: scanned.privateEvidence,
      secret,
    });
    assert.equal(revealed.freshnessEvidence, "selected");
    assert(revealed.selected);
    assert(revealed.selectedEvidence);
    assert.equal(revealed.selectedEvidence.protocol, predicate.protocol);
    assert.equal(
      revealed.selectedEvidence.instanceAddress,
      predicate.instanceAddress,
    );
    assert.equal(
      revealed.selectedEvidence.source.number,
      revealed.selected.sourceBlock,
    );
    assert.deepEqual(
      replayPersistedConversionFreshness({
        plan: selectedPlan,
        predicate,
        candidates: scanned.candidates,
        privateEvidence: scanned.privateEvidence,
        secret,
        persistedReveal: revealed,
      }),
      revealed,
      "production resume must return the replayed reveal",
    );
    assert.throws(
      () => replayPersistedConversionFreshness({
        plan: selectedPlan,
        predicate,
        candidates: scanned.candidates,
        privateEvidence: scanned.privateEvidence,
        secret,
        persistedReveal: {
          ...revealed,
          eligibleSetSha256: "00".repeat(32),
        },
      }),
      /does not replay/,
      "production resume accepted a persisted reveal not bound to commitment inputs",
    );
  } finally {
    await close(rpc);
  }
}

function createFixtureRpc(
  eventBlocks: readonly number[],
): ReturnType<typeof createServer> {
  const eventSet = new Set(eventBlocks);
  return createServer((request, response) => {
    void serveRpc(request, response, eventSet).catch((error) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
}

async function serveRpc(
  request: IncomingMessage,
  response: ServerResponse,
  eventBlocks: ReadonlySet<number>,
): Promise<void> {
  type FixtureRpcRequest = {
    readonly id: unknown;
    readonly method: string;
    readonly params: readonly unknown[];
  };
  const body = JSON.parse(await readBody(request)) as
    | FixtureRpcRequest
    | readonly FixtureRpcRequest[];
  const handle = (rpc: FixtureRpcRequest): object => ({
    jsonrpc: "2.0",
    id: rpc.id,
    result: fixtureRpcResult(rpc, eventBlocks),
  });
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(
    Array.isArray(body)
      ? body.map(handle)
      : handle(body as FixtureRpcRequest),
  ));
}

function fixtureRpcResult(
  rpc: {
    readonly method: string;
    readonly params: readonly unknown[];
  },
  eventBlocks: ReadonlySet<number>,
): unknown {
  let result: unknown;
  if (rpc.method === "eth_chainId") {
    result = "0x1";
  } else if (rpc.method === "eth_getLogs") {
    const filter = rpc.params[0] as {
      readonly fromBlock: string;
      readonly toBlock: string;
    };
    const fromBlock = Number(BigInt(filter.fromBlock));
    const toBlock = Number(BigInt(filter.toBlock));
    result = [...eventBlocks]
      .filter((block) => block >= fromBlock && block <= toBlock)
      .sort((a, b) => a - b)
      .map((block) => fixtureLog(block));
  } else if (rpc.method === "eth_getBlockByNumber") {
    const block = Number(BigInt(String(rpc.params[0])));
    result = fixtureBlock(block);
  } else if (rpc.method === "eth_getCode") {
    assertEip1898Block(rpc.params[1], eventBlocks);
    result = "0x60006000";
  } else if (rpc.method === "eth_call") {
    const call = rpc.params[0] as { readonly data: string };
    const block = assertEip1898Block(rpc.params[1], eventBlocks);
    if (call.data.toLowerCase() === "0xc1fe3e48") {
      result = `0x${"0".repeat(24)}${predicate.event.address.slice(2)}`;
    } else {
      const eventOrdinal = [...eventBlocks].filter((value) => value <= block).length;
      const base = call.data.toLowerCase().startsWith("0xbb2952fc")
        ? 1_200_000_000_000_000_000n
        : 800_000_000_000_000_000n;
      const direction = call.data.toLowerCase().startsWith("0xbb2952fc")
        ? 1n
        : -1n;
      result = uint256(base + direction * BigInt(eventOrdinal));
    }
  } else {
    throw new Error(`unexpected fixture RPC ${rpc.method}`);
  }
  return result;
}

function assertEip1898Block(
  value: unknown,
  eventBlocks: ReadonlySet<number>,
): number {
  assert(
    typeof value === "object" &&
      value !== null &&
      (value as { requireCanonical?: unknown }).requireCanonical === true,
    "conversion fixture requires an EIP-1898 canonical block tag",
  );
  const hash = (value as { blockHash?: unknown }).blockHash;
  if (typeof hash !== "string") {
    throw new Error("conversion fixture EIP-1898 blockHash must be a string");
  }
  const blocks = [...eventBlocks];
  const from = Math.max(0, Math.min(...blocks) - 2);
  const to = Math.max(...blocks) + 2;
  for (let block = from; block <= to; block += 1) {
    if (blockHash(block).toLowerCase() === hash.toLowerCase()) return block;
  }
  throw new Error(`unknown fixture block hash ${hash}`);
}

function fixtureLog(block: number): object {
  return {
    address: predicate.event.address,
    topics: [
      predicate.event.topic0,
      uint256(BigInt(block)),
    ],
    data: `0x${"00".repeat(32 * 6)}`,
    blockNumber: quantity(block),
    blockHash: blockHash(block),
    transactionHash: hexHash(`transaction:${block}`),
    logIndex: "0x0",
    removed: false,
  };
}

function fixtureBlock(block: number): object {
  return {
    number: quantity(block),
    hash: blockHash(block),
    parentHash: blockHash(block - 1),
    stateRoot: hexHash(`state:${block}`),
  };
}

function blockHash(block: number): string {
  return hexHash(`block:${block}`);
}

function uint256(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function quantity(value: number): string {
  return `0x${value.toString(16)}`;
}

function hexHash(value: string): string {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

async function runCli(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", cli, ...args],
    {
      cwd: listenerRoot,
      env: {
        PATH: process.env.PATH ?? "",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", resolveExit);
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", rejectBody);
  });
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectPort(new Error("fixture RPC did not bind TCP"));
        return;
      }
      resolvePort(address.port);
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}
