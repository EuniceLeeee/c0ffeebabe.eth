import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { concatBytes, encodeCall } from "../../../../../encoder.js";
import { plugin } from "../../../production-families/uniswap-v1.production.js";
import { MAX_UINT, POOL } from "../codec.js";
import { answer, EXECUTOR, quote, result, TOKEN_ADDRESS, word } from "./fixtures.js";

// In-process EVM only. This runner never creates a provider, forks a chain,
// signs/broadcasts, installs dependencies or starts even a loopback RPC server.
const root = fileURLToPath(new URL("../../../../../../../", import.meta.url));
const sample = quote(10n ** 16n, false);
const { input, method } = sample;
const actualQuote = method.program.decode({ programInput: input,
  initialResults: method.program.buildRequests(input).map(r => r.id === "native-reserve"
    ? result(r.id, word(100n * 10n ** 18n + 1_000_000n)) : answer(r)), dependentEvidence: [] });
assert.equal(sample.quoted.amountOut, 19920056031912n);
assert.equal(actualQuote.amountOut, 19920056031913n);

function script(q: typeof sample.quoted, minAmountOut = q.amountOut): string {
  const fragment = plugin.execution.buildFragment({ ...input, quotedAmountOut: q.amountOut,
    minAmountOut, exactEvidence: q.evidence });
  const encoded = plugin.actionAdapters[0].encode(fragment.nodes[0], EXECUTOR, new Uint8Array());
  // Actual production encoding: scoped native receipt around the swap. The
  // quote is a minimum in the swap calldata, never a fixed wrapping quantity.
  assert.equal(encoded[0], 0x0b);
  const innerSize = encoded[1]! * 65536 + encoded[2]! * 256 + encoded[3]!;
  assert.equal(innerSize, encoded.length - 4);
  const inner = encoded.slice(4);
  assert.equal(inner[0], 0);
  const size = inner[21]! * 65536 + inner[22]! * 256 + inner[23]!;
  const decoded = POOL.decodeFunctionData("tokenToEthSwapInput", inner.slice(24, 24 + size));
  assert.equal(decoded[0], input.amountIn); assert.equal(decoded[1], minAmountOut);
  assert.equal(inner.length, 24 + size, "no fixed-output deposit after swap");
  const approve = new ethers.Interface(["function approve(address,uint256) returns(bool)"]);
  return ethers.hexlify(concatBytes(encodeCall(TOKEN_ADDRESS,
    ethers.getBytes(approve.encodeFunctionData("approve", [input.descriptor.pool, MAX_UINT]))), encoded));
}
const highQuote = { ...actualQuote, amountOut: actualQuote.amountOut + 1n,
  evidence: { ...actualQuote.evidence, amountOut: actualQuote.amountOut + 1n } };
const args = ["test", "--offline", "--root", root, "--match-contract", "UniV1NativeResidualTest",
  "--out", resolve(root, "logs/univ1-native-residual/foundry"),
  "--cache-path", resolve(root, "logs/univ1-native-residual/foundry-cache"), "-vvvv"];
// Do not inherit ambient Foundry/fork/RPC configuration or signing variables.
// The repository foundry.toml is read unchanged; only OS runtime paths pass on.
const osEnvironment = Object.fromEntries(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT"]
  .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
const run = spawnSync("forge", args, { cwd: root, encoding: "utf8", timeout: 60_000, env: { ...osEnvironment,
  FOUNDRY_TEST: "listener/src/searcher/venues/swaps/univ1-family/test",
  UNIV1_RESIDUAL_EXACT_SCRIPT: script(actualQuote),
  UNIV1_RESIDUAL_LOW_SCRIPT: script(sample.quoted),
  UNIV1_RESIDUAL_HIGH_SCRIPT: script(highQuote),
  UNIV1_RESIDUAL_HIGH_TOLERATED_SCRIPT: script(highQuote, highQuote.amountOut - 1n),
} });
process.stdout.write(run.stdout ?? ""); process.stderr.write(run.stderr ?? "");
assert.equal(run.status, 0, `in-process Foundry regression failed: ${run.error ?? run.signal ?? run.status}`);
assert.match(run.stdout, /4 passed; 0 failed/);
console.log(JSON.stringify({ scope: "synthetic-in-process-EVM-native-receipt-regression", noRPC: true,
  implementationTested: true, historicalAcceptance: false, quote: String(sample.quoted.amountOut), actual: String(actualQuote.amountOut),
  wrapped: String(actualQuote.amountOut), nativeResidual: "0", checks: 4, forgeArgs: args }));
