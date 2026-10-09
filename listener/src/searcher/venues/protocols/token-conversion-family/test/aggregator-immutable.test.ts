// Captured historical bytecodes and published compiler artifact are passed in;
// this suite does not fetch network data or pretend to recompile Solidity.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ethers } from "ethers";
import { assertXwinChainlinkAggregatorRuntime } from "../xwin-dependency-runtime.js";

const evidence = process.env.XWIN_AGGREGATOR_IMMUTABLE_EVIDENCE;
test("OCR2 maxAnswer compatibility authenticates actual N code and exact immutable/compiler/source bindings", { skip: !evidence }, () => {
  const captured = JSON.parse(readFileSync(evidence + "/aggregator-diagnostic-1.json", "utf8"));
  const published = JSON.parse(readFileSync(evidence + "/aggregator-sourcify-1.json", "utf8"));
  assert.equal(captured.status, "captured");
  assert.equal(captured.pin.blockHash, "0x4256c70c1fba6d441343680f94d07e2a1034dddb5628bb11858b9157490b501c");
  assert.equal(captured.pin.requireCanonical, true);
  const newRow = captured.rows.find((r: any) => r.codeHash === "0xec635dff6a4204a0de141a9a6728b9c84995894680d703e44ac0057ffb38c412");
  assert(newRow); assert.equal(published.runtimeMatch, "exact_match");
  assert.equal(published.address.toLowerCase(), newRow.aggregator.toLowerCase());
  const artifact = published.runtimeBytecode;
  assert.equal(artifact.onchainBytecode.toLowerCase(), newRow.code.toLowerCase());
  assert.deepEqual(artifact.immutableReferences["630"], [1303, 9901, 15567].map(start => ({ start, length: 32 })));
  assert(published.sources["src/OCR2Aggregator.sol"].content.includes("int192 immutable public maxAnswer;"));
  for (const [name, metadata] of Object.entries(published.metadata.sources) as [string, any][])
    assert.equal(ethers.keccak256(ethers.toUtf8Bytes(published.sources[name].content)), metadata.keccak256);
  let rebuilt = artifact.recompiledBytecode;
  for (const [id, refs] of Object.entries(artifact.immutableReferences) as [string, any[]][])
    for (const ref of refs) {
      const word = artifact.transformationValues.immutables[id].slice(2); assert.equal(word.length, ref.length * 2);
      rebuilt = rebuilt.slice(0, 2 + ref.start * 2) + word + rebuilt.slice(2 + (ref.start + ref.length) * 2);
    }
  assert.equal(rebuilt.toLowerCase(), newRow.code.toLowerCase());
  for (const row of captured.rows) assert.equal(assertXwinChainlinkAggregatorRuntime(row.code), row.codeHash);

  const patchWord = (code: string, offset: number, word: string) => code.slice(0, 2 + offset * 2) + word + code.slice(2 + (offset + 32) * 2);
  const setMax = (n: bigint) => [1303, 9901, 15567].reduce((c, at) => patchWord(c, at, ethers.toBeHex(n, 32).slice(2)), newRow.code);
  // Boundary fixtures are semantic-template tests, not additional chain samples.
  for (const n of [1n, 105000000n, (1n << 191n) - 1n]) assertXwinChainlinkAggregatorRuntime(setMax(n));
  for (const n of [0n, 1n << 191n, (1n << 256n) - 1n]) assert.throws(() => assertXwinChainlinkAggregatorRuntime(setMax(n)));
  assert.throws(() => assertXwinChainlinkAggregatorRuntime(patchWord(newRow.code, 1303, ethers.toBeHex(100n, 32).slice(2))));
  for (const offset of [0, 868, 1128, 1302, 9900, 15566, 22284, 22336]) {
    const bytes = ethers.getBytes(newRow.code); bytes[offset] ^= 1;
    assert.throws(() => assertXwinChainlinkAggregatorRuntime(ethers.hexlify(bytes)));
  }
});
