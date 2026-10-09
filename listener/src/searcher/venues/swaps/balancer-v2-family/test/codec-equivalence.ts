import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ethers } from "ethers";
import { MAX_INPUT, lower, nonzero, queryData, quoteOutput } from "../codec.js";

// Independent legacy ABI oracle: do not import VAULT_ABI or the production decoder.
const reference = new ethers.Interface([
  "function queryBatchSwap(uint8 kind,(bytes32 poolId,uint256 assetInIndex,uint256 assetOutIndex,uint256 amount,bytes userData)[] swaps,address[] assets,(address sender,bool fromInternalBalance,address recipient,bool toInternalBalance) funds) returns(int256[] assetDeltas)",
]);
const method = "queryBatchSwap", abi = ethers.AbiCoder.defaultAbiCoder();
const signedMax = (1n << 255n) - 1n;
const samples = 128;
type Query = Parameters<typeof queryData>;

// Fixed seed and labels keep failures reproducible, with no provider or clock dependency.
function randomHex(label: string, bytes: number): string {
  return "0x" + createHash("sha256").update("balancer-v2-codec-equivalence:v1:" + label)
    .digest("hex").slice(0, bytes * 2);
}
function sample(index: number): Query {
  const address = (field: string) => ethers.getAddress(randomHex(`${index}:${field}`, 20));
  const poolId = ethers.solidityPacked(["address", "uint16", "uint80"],
    [address("pool"), index % 3, BigInt(randomHex(`${index}:nonce`, 10))]);
  return [poolId, address("in"), address("out"), BigInt(randomHex(`${index}:amount`, 32)), address("executor")];
}
function hexCases(data: string): string[] {
  return [data.toLowerCase(), "0x" + data.slice(2).toUpperCase(),
    "0x" + Array.from(data.slice(2), (c, i) => i % 2 ? c.toUpperCase() : c.toLowerCase()).join("")];
}
function addressCases(address: string): string[] {
  return [address.toLowerCase(), "0x" + address.slice(2).toUpperCase(), ethers.getAddress(address)];
}
function referenceQuery([poolId, tokenIn, tokenOut, amount, executor]: Query): string {
  return reference.encodeFunctionData(method, [0, [[poolId, 0, 1, amount, "0x"]],
    [tokenIn, tokenOut], [executor, false, executor, false]]);
}
function encoded(deltas: readonly bigint[]): string {
  return reference.encodeFunctionResult(method, [deltas]);
}
function referenceQuote(data: string, amountIn: bigint, allowZero = false): bigint {
  const result = reference.decodeFunctionResult(method, data);
  assert.equal(reference.encodeFunctionResult(method, result).toLowerCase(), data.toLowerCase(), "noncanonical ABI result");
  const deltas = Array.from(result[0] as readonly bigint[]);
  assert.equal(deltas.length, 2, "two asset deltas required");
  assert.equal(deltas[0], amountIn, "input delta mismatch");
  assert(deltas[1] <= 0n && deltas[1] >= -signedMax, "output delta sign/range");
  assert(allowZero || deltas[1] !== 0n, "zero output not allowed");
  return -deltas[1];
}
function acceptsQuote(data: string, amountIn: bigint, amountOut: bigint, label: string, allowZero?: boolean): void {
  assert.equal(referenceQuote(data, amountIn, allowZero), amountOut, `${label}: oracle`);
  assert.equal(quoteOutput(data, amountIn, allowZero), amountOut, label);
}
function rejectsQuote(data: string, amountIn: bigint, label: string): void {
  // allowZero must never bypass any other canonical or semantic guard.
  for (const allowZero of [undefined, false, true]) {
    assert.throws(() => referenceQuote(data, amountIn, allowZero), `${label}: oracle, allowZero=${allowZero}`);
    assert.throws(() => quoteOutput(data, amountIn, allowZero), `${label}: allowZero=${allowZero}`);
  }
}
// Corrupt an oracle-produced result; words are encoded by ethers, never by the candidate.
function replaceWord(data: string, index: number, value: bigint): string {
  return ethers.concat([ethers.dataSlice(data, 0, index * 32), abi.encode(["uint256"], [value]),
    ethers.dataSlice(data, (index + 1) * 32)]);
}

test("queryData preserves uint256 boundaries, address casing and the zero pricing caller", () => {
  assert.equal(MAX_INPUT, signedMax, "the existing signed-delta safety bound must not change");
  const [poolId, tokenIn, tokenOut, , executor] = sample(0);
  // MAX_INPUT is a quote-delta limit, not a restriction on the uint256 ABI input.
  for (const amount of [0n, 1n, MAX_INPUT, MAX_INPUT + 1n, ethers.MaxUint256]) {
    for (const id of hexCases(poolId)) for (const input of addressCases(tokenIn)) {
      for (const output of addressCases(tokenOut)) for (const caller of [ethers.ZeroAddress, ...addressCases(executor)]) {
        const args: Query = [id, input, output, amount, caller];
        assert.equal(queryData(...args), referenceQuery(args), `amount=${amount}, caller=${caller}`);
      }
    }
  }
});

test("queryData is byte-identical to the independent ABI for 128 seeded random pools and amounts", () => {
  for (let i = 0; i < samples; i++) {
    const [poolId, tokenIn, tokenOut, amount, executor] = sample(i);
    // Include full-width uint256 and smaller values with leading zero bytes.
    for (const inputAmount of [amount, amount >> BigInt(i % 256)]) for (let style = 0; style < 3; style++) {
      for (const caller of [ethers.ZeroAddress, addressCases(executor)[style]]) {
        const args: Query = [hexCases(poolId)[style], addressCases(tokenIn)[style],
          addressCases(tokenOut)[(style + 1) % 3], inputAmount, caller];
        assert.equal(queryData(...args), referenceQuery(args), `sample=${i}, style=${style}, amount=${inputAmount}`);
      }
    }
  }
});

test("queryData rejects malformed pool IDs, invalid addresses/checksums and negative/overflow amounts", () => {
  const base = sample(0);
  const rejects = (args: Query, label: string) => {
    assert.throws(() => referenceQuery(args), `${label}: oracle`);
    assert.throws(() => queryData(...args), label);
  };
  // These are malformed bytes32 values; pool identity/specialization is a separate contract.
  for (const poolId of ["", "0x", "0x1", "0x" + "ab".repeat(31), "0x" + "ab".repeat(33),
    base[0].slice(2), "0x" + "gg".repeat(32), base[0] + "00", " " + base[0]]) {
    rejects([poolId, base[1], base[2], base[3], base[4]], `poolId=${poolId}`);
  }
  const checksummed = ethers.getAddress("0xabcdef0123456789abcdef0123456789abcdef01");
  const badChecksum = checksummed.replace(/[a-fA-F]/, c => c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
  assert.equal(ethers.isAddress(badChecksum), false, "fixture must have an invalid mixed-case checksum");
  for (const address of [badChecksum, "", "0x", "0x" + "ab".repeat(19), "0x" + "ab".repeat(21),
    "0x" + "gg".repeat(20), checksummed + " "]) {
    for (const index of [1, 2, 4] as const) {
      const args: Query = [...base]; args[index] = address;
      rejects(args, `address field=${index}, value=${address}`);
    }
  }
  for (const amount of [-1n, -signedMax, -(1n << 255n), ethers.MaxUint256 + 1n, 1n << 512n]) {
    rejects([base[0], base[1], base[2], amount, base[4]], `amount=${amount}`);
  }
});

test("quoteOutput matches canonical ABI results at signed and integer precision boundaries", () => {
  const amounts = [0n, 1n, 255n, 256n, (1n << 53n) - 1n, 1n << 53n, (1n << 53n) + 1n,
    (1n << 128n) - 1n, 1n << 128n, signedMax - 1n, signedMax];
  for (const amountIn of amounts) for (const amountOut of amounts.filter(n => n > 0n)) {
    for (const data of hexCases(encoded([amountIn, -amountOut]))) for (const allowZero of [undefined, false, true]) {
      acceptsQuote(data, amountIn, amountOut, `in=${amountIn}, out=${amountOut}`, allowZero);
    }
  }
});

test("quoteOutput matches decode/reencode for 128 seeded random signed-range results", () => {
  for (let i = 0; i < samples; i++) {
    const amountIn = BigInt(randomHex(`${i}:quote-in`, 32)) & signedMax;
    const amountOut = 1n + BigInt(randomHex(`${i}:quote-out`, 32)) % signedMax;
    for (const data of hexCases(encoded([amountIn, -amountOut]))) {
      acceptsQuote(data, amountIn, amountOut, `sample=${i}`);
      acceptsQuote(data, amountIn, amountOut, `sample=${i}, allowZero`, true);
    }
  }
});

test("quoteOutput accepts zero only with allowZero=true", () => {
  for (const amountIn of [0n, 1n, signedMax]) for (const data of hexCases(encoded([amountIn, 0n]))) {
    assert.throws(() => referenceQuote(data, amountIn));
    assert.throws(() => quoteOutput(data, amountIn));
    assert.throws(() => referenceQuote(data, amountIn, false));
    assert.throws(() => quoteOutput(data, amountIn, false));
    acceptsQuote(data, amountIn, 0n, `zero, in=${amountIn}`, true);
  }
});

test("quoteOutput rejects wrong delta counts, positive output, mismatched input and int256 minimum output", () => {
  for (const deltas of [[], [1n], [1n, -7n, 0n], [1n, -7n, 0n, 0n], [1n, 1n], [1n, signedMax],
    [0n, -7n], [2n, -7n], [-1n, -7n], [signedMax, -7n], [1n, -(signedMax + 1n)]]) {
    rejectsQuote(encoded(deltas), 1n, `deltas=${deltas}`);
  }
  rejectsQuote(encoded([signedMax, -1n]), signedMax - 1n, "large input differs by one wei");
  rejectsQuote(encoded([-(1n << 255n), -1n]), signedMax + 1n, "signed input cannot alias uint256 bit 255");
  rejectsQuote(encoded([-1n, -1n]), ethers.MaxUint256, "signed input cannot alias MaxUint256");
});

test("quoteOutput rejects invalid dynamic offsets and forged array lengths", () => {
  const data = encoded([1n, -7n]);
  for (const offset of [0n, 1n, 31n, 33n, 64n, 96n, 128n, 1n << 53n, ethers.MaxUint256]) {
    rejectsQuote(replaceWord(data, 0, offset), 1n, `offset=${offset}`);
  }
  for (const length of [0n, 1n, 3n, 4n, 1n << 53n, ethers.MaxUint256]) {
    rejectsQuote(replaceWord(data, 1, length), 1n, `array length=${length}`);
  }
});

test("quoteOutput rejects decodable but noncanonical relocated arrays and trailing words", () => {
  const data = encoded([1n, -7n]);
  const noncanonical = [ethers.concat([data, abi.encode(["uint256"], [0n])])];
  for (const gap of [abi.encode(["uint256"], [0n]), abi.encode(["uint256", "uint256"], [123n, ethers.MaxUint256])]) {
    noncanonical.push(ethers.concat([abi.encode(["uint256"], [32 + ethers.dataLength(gap)]), gap,
      ethers.dataSlice(data, 32)]));
  }
  for (const value of noncanonical) {
    // Prove these negatives need the old canonical reencode guard, not merely successful ABI decoding.
    const decoded = reference.decodeFunctionResult(method, value);
    assert.deepEqual(Array.from(decoded[0]), [1n, -7n]);
    assert.notEqual(reference.encodeFunctionResult(method, decoded).toLowerCase(), value.toLowerCase());
    rejectsQuote(value, 1n, "decodable noncanonical result");
  }
});

test("quoteOutput rejects every byte truncation and trailing garbage", () => {
  const data = encoded([1n, -7n]);
  for (let length = 0; length < ethers.dataLength(data); length++) {
    rejectsQuote(ethers.dataSlice(data, 0, length), 1n, `truncated to ${length} bytes`);
  }
  for (const suffix of ["0x00", "0x01", "0xff", "0x" + "00".repeat(31), "0x" + "ff".repeat(32), data]) {
    rejectsQuote(ethers.concat([data, suffix]), 1n, `trailing ${ethers.dataLength(suffix)} bytes`);
  }
});

test("quoteOutput rejects malformed hex and partial nibbles", () => {
  const data = encoded([1n, -7n]);
  for (const value of ["", "0x0", data.slice(2), data.slice(0, -1), data + "0", " " + data, data + " ",
    data.slice(0, -2) + "gg"]) {
    rejectsQuote(value, 1n, "invalid hex result");
  }
});

test("lower/nonzero reject bad mixed-case checksums after valid spellings are warm", () => {
  const address = ethers.getAddress("0xabcdef0123456789abcdef0123456789abcdef01");
  const invalid = address.replace(/[a-fA-F]/, c => c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
  assert.throws(() => ethers.getAddress(invalid), "fixture must have an invalid mixed-case checksum");
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const value of addressCases(address)) {
      assert.equal(lower(value), address.toLowerCase());
      assert.equal(nonzero(value), address);
    }
    assert.throws(() => lower(invalid), "a warmed lowercase spelling must not validate bad checksum spelling");
    assert.throws(() => nonzero(invalid), "the shared cache must preserve checksum rejection");
  }
});

test("zero address remains valid for lower and always invalid for nonzero on a warm cache", () => {
  assert.equal(ethers.getAddress(ethers.ZeroAddress), ethers.ZeroAddress);
  for (let repeat = 0; repeat < 3; repeat++) {
    assert.equal(lower(ethers.ZeroAddress), ethers.ZeroAddress);
    assert.throws(() => nonzero(ethers.ZeroAddress), /zero/);
    assert.equal(lower(ethers.ZeroAddress), ethers.ZeroAddress, "nonzero rejection must not poison lower");
    assert.throws(() => nonzero(ethers.ZeroAddress), /zero/);
  }
});

test("lower/nonzero keep old, zero and invalid address decisions after 2057 distinct inputs", () => {
  const address = sample(127)[4];
  const badChecksum = address.replace(/[a-fA-F]/, c => c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
  const invalid = [badChecksum, "", "0x", "0x" + "ab".repeat(19), "0x" + "ab".repeat(21),
    "0x" + "gg".repeat(20), address + " "];
  const check = () => {
    for (const value of addressCases(address)) {
      const expected = ethers.getAddress(value);
      assert.equal(lower(value), expected.toLowerCase());
      assert.equal(nonzero(value), expected);
    }
    for (const value of invalid) {
      assert.throws(() => ethers.getAddress(value), `invalid fixture: ${value}`);
      assert.throws(() => lower(value), `lower: ${value}`);
      assert.throws(() => nonzero(value), `nonzero: ${value}`);
    }
    assert.equal(lower(ethers.ZeroAddress), ethers.ZeroAddress);
    assert.throws(() => nonzero(ethers.ZeroAddress), /zero/);
  };
  check();
  // More than the proposed capacity, without inspecting cache internals or timing it.
  for (let i = 1; i <= 2057; i++) {
    const value = ethers.toBeHex(i, 20), expected = ethers.getAddress(value);
    assert.equal(lower(value), expected.toLowerCase());
    assert.equal(nonzero(value), expected);
  }
  check();
});
