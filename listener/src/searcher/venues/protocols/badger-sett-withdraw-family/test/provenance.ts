import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { CODE } from "../codec.js";
import { publicState, runtimes, historicalSource, saved, rpc } from "./fixture.js";
import { ABI_SELECTIONS, ARCHIVE_SHA256, extractPublicState, RESULT_FILES } from "./export-public-state.js";

test("committed public fixture preserves code/source commitments and only allowlisted ABI fields (not archive verification)", () => {
  assert.deepEqual(Object.keys(publicState).sort(), ["format", "source", "archiveSha256", "runtimeKeccak256", "runtimes", "rpcResults", "abis"].sort());
  assert.equal(publicState.format, "badger-sett-public-state-v1");
  assert.deepEqual(publicState.source, { number: historicalSource.number, hash: historicalSource.hash });
  assert.deepEqual(publicState.runtimeKeccak256, CODE);
  assert.deepEqual(Object.keys(runtimes).sort(), Object.keys(CODE).sort());
  for (const kind of Object.keys(CODE) as (keyof typeof CODE)[]) assert.equal(ethers.keccak256(runtimes[kind]), CODE[kind]);
  const abiFiles = ABI_SELECTIONS.map(([file]) => file);
  assert.deepEqual(Object.keys(publicState.archiveSha256).sort(), [...Object.keys(ARCHIVE_SHA256), ...abiFiles].sort());
  for (const [file, expected] of Object.entries(ARCHIVE_SHA256)) assert.equal(publicState.archiveSha256[file], expected, file);
  for (const value of Object.values(publicState.archiveSha256)) assert.match(value, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(publicState.rpcResults).sort(), [...RESULT_FILES].sort());
  for (const file of RESULT_FILES) assert(ethers.isHexString(rpc(file), file === "rpc-042-locker-balances.json" ? 64 : 32));
  assert.deepEqual(Object.keys(publicState.abis).sort(), [...abiFiles].sort());
  for (const [file, declared] of ABI_SELECTIONS) {
    const fragments = saved(file);
    assert.equal(fragments.length, declared.fragments.filter(f => f.type === "function").length);
    for (const fragment of fragments) assert.equal(ethers.FunctionFragment.from(fragment).format("full"), fragment);
  }
  // Unknown names may not silently fall back to the filesystem/raw archive.
  assert.throws(() => saved("../provenance.json"), /unknown public ABI fixture/);
  assert.throws(() => rpc("rpc-private.json"), /unknown public result fixture/);
});

const archive = process.env.BADGER_SETT_PREFLIGHT;
test("explicit retained archive: original source hashes, both proxy runtimes, N anchor and public export match", {
  skip: archive === undefined ? "archive-only verification requires explicit BADGER_SETT_PREFLIGHT; not acceptance" : false,
}, () => {
  // Missing/corrupt explicitly selected archives fail. Only an absent setting
  // skips; the committed fixture never substitutes for archive verification.
  assert(archive !== undefined);
  assert.deepEqual(extractPublicState(archive), publicState);
});
