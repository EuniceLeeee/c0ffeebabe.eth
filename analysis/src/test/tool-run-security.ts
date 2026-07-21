import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNoSecretBearingToolArgs,
  redactToolArgv,
  redactToolOutput,
} from "../tool-run-security.js";

test("tool-run rejects secret-bearing argv before npm can echo it", () => {
  assert.throws(
    () => assertNoSecretBearingToolArgs(["--rpc", "https://eth-mainnet.g.alchemy.com/v2/example"]),
    /forbids secret-bearing argument --rpc/,
  );
  assert.throws(
    () => assertNoSecretBearingToolArgs(["--api-key=example"]),
    /forbids secret-bearing argument --api-key/,
  );
  assert.throws(
    () => assertNoSecretBearingToolArgs(["--rpcUrl=rawsecret"]),
    /forbids secret-bearing argument --rpcUrl/,
  );
  assert.throws(
    () => assertNoSecretBearingToolArgs(["--accessToken", "rawsecret"]),
    /forbids secret-bearing argument --accessToken/,
  );
  assert.throws(
    () => assertNoSecretBearingToolArgs(["https://example.quiknode.pro/credential/"]),
    /remote URLs/,
  );
  assert.throws(
    () => assertNoSecretBearingToolArgs(["wss://eth-mainnet.g.alchemy.com/v2/example"]),
    /remote URLs/,
  );
  assert.throws(
    () => assertNoSecretBearingToolArgs(["https://rpc.internal.example/opaque-private-key"]),
    /remote URLs/,
  );
  assert.throws(
    () => assertNoSecretBearingToolArgs(["--source=wss://rpc.internal.example/opaque-private-key"]),
    /remote URLs/,
  );
  assert.throws(
    () => assertNoSecretBearingToolArgs(['{"rpc":"https://rpc.internal.example/opaque-private-key"}']),
    /remote URLs/,
  );
  assert.throws(
    () => assertNoSecretBearingToolArgs(["https://rpc.internal.example/v2/key?project=opaque"]),
    /remote URLs/,
  );
  assert.throws(
    () => assertNoSecretBearingToolArgs(["wss://rpc.internal.example/v2/key?project=opaque"]),
    /remote URLs/,
  );
  assert.throws(
    () => assertNoSecretBearingToolArgs(['{"rpc":"https://rpc.internal.example/v2/key?project=opaque"}']),
    /remote URLs/,
  );
  assert.throws(
    () => assertNoSecretBearingToolArgs(["http://user:password@127.0.0.1:8545"]),
    /remote URLs/,
  );
  assert.throws(
    () => assertNoSecretBearingToolArgs(["--rpc", "http://127.0.0.1:8545?project=opaque"]),
    /secret-bearing argument --rpc/,
  );
  assert.throws(
    () => assertNoSecretBearingToolArgs(["--rpc", "http://127.0.0.1:8545/opaque-private-key"]),
    /secret-bearing argument --rpc/,
  );
  assert.doesNotThrow(() => assertNoSecretBearingToolArgs([
    "--tx", `0x${"12".repeat(32)}`, "--token", "0x0000000000000000000000000000000000000001",
    "--rpc-timeout-ms", "30000", "--rpc", "http://127.0.0.1:8545",
    "--anvil", "http://127.0.0.1:8546",
  ]));
});

test("tool-run redacts secret flags, environment values, and remote URLs", () => {
  assert.deepEqual(
    redactToolArgv(["npm", "run", "example", "--rpc-url=https://secret.example/v2/key"]),
    ["npm", "run", "example", "--rpc-url=<redacted>"],
  );
  assert.deepEqual(
    redactToolArgv(["npm", "run", "example", "--rpcUrl=rawsecret", "--accessToken", "rawsecret"]),
    ["npm", "run", "example", "--rpcUrl=<redacted>", "--accessToken", "<redacted>"],
  );
  assert.deepEqual(
    redactToolArgv(["npm", "run", "example", "--rpc", "http://127.0.0.1:8545"]),
    ["npm", "run", "example", "--rpc", "http://127.0.0.1:8545"],
  );
  const secret = "https://eth-mainnet.g.alchemy.com/v2/private-key";
  assert.equal(
    redactToolOutput(
      `rpc=${secret} key=private-key ws=wss://eth-mainnet.g.alchemy.com/v2/private-key docs=https://example.com/path local=http://127.0.0.1:8545`,
      { MAINNET_RPC_URL: secret },
    ),
    "rpc=<redacted-url> key=<redacted-env-fragment> ws=<redacted-url> docs=<redacted-url> local=http://127.0.0.1:8545",
  );
  assert.equal(
    redactToolOutput("unsafe=http://user:password@127.0.0.1:8545 safe=http://127.0.0.1:8545", {}),
    "unsafe=<redacted-url> safe=http://127.0.0.1:8545",
  );
  assert.equal(
    redactToolOutput("unsafe=http://127.0.0.1:8545/opaque-private-key", {}),
    "unsafe=<redacted-url>",
  );
});
