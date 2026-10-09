import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { createIdentityAssetMetadataPlan, identityAssetRequestId, type IdentityAssetDeclaration } from "../identity-asset-metadata.js";
import type { AdapterRequestResult } from "../venues/adapter-request-program.js";

const source = { number: 7, hash: `0x${"12".repeat(32)}`, generation: 7 };
const token = "0x0000000000000000000000000000000000000023";
const ok = (id: string, data: string): AdapterRequestResult => ({ id, ok: true, completion: "returned", source, data });
const declarations = [{ key: "in", kind: "native" }, { key: "out", kind: "erc20", address: token }] as const;
const ercResults = () => [ok(identityAssetRequestId("out", "code"), "0x6000"),
  ok(identityAssetRequestId("out", "decimals"), ethers.toBeHex(6, 32))];

test("native is metadata, not an ERC20 call or a new scheduler round", () => {
  const p = createIdentityAssetMetadataPlan(declarations, source);
  const requests = p.append([{ id: "protocol", kind: "get-code", address: token }]);
  assert.equal(requests.length, 3);
  assert.equal(requests.filter(r => r.id.startsWith("central-asset:in:")).length, 0);
  assert.deepEqual(p.decode(ercResults()), [
    { key: "in", kind: "native", token: ethers.getAddress(ADDR.WETH), decimals: 18 },
    { key: "out", kind: "erc20", token, code: "0x6000", decimals: 6 },
  ]);
  assert.deepEqual(new Set(p.requirements({ transports: ["get-storage"], completions: ["return-data"] }).transports),
    new Set(["get-storage", "get-code", "eth-call"]));
  const native = createIdentityAssetMetadataPlan([{ key: "eth", kind: "native" }], source);
  assert.deepEqual(native.append([]), []);
  const base = { transports: ["get-code" as const] };
  assert.equal(native.requirements(base), base);
});

test("WETH and arbitrary ERC20 addresses never become native implicitly", () => {
  const p = createIdentityAssetMetadataPlan([{ key: "out", kind: "erc20", address: ADDR.WETH }], source);
  assert.equal(p.append([]).length, 2);
  assert.equal(p.decode(ercResults())[0].kind, "erc20");
  const absent = createIdentityAssetMetadataPlan([{ key: "out", kind: "erc20", address: token }], source)
    .decode([ok(identityAssetRequestId("out", "code"), "0x"), ok(identityAssetRequestId("out", "decimals"), "0x")])[0];
  assert.deepEqual(absent, { key: "out", kind: "erc20", token, code: "0x", decimals: null });
});

test("malformed declarations and forged/stale metadata fail closed", () => {
  const invalid: unknown[] = [null, {}, [undefined],
    [{ key: "a", kind: "native", address: token }], [{ key: "a", kind: "erc20" }],
    [{ key: "a", kind: "erc20", address: ethers.ZeroAddress }],
    [{ key: "a", kind: "native" }, { key: "a", kind: "native" }],
    [{ key: "a:code", kind: "native" }], [{ key: "a", kind: "unknown" }]];
  for (const value of invalid) assert.throws(() => createIdentityAssetMetadataPlan(value as readonly IdentityAssetDeclaration[], source));
  const p = createIdentityAssetMetadataPlan(declarations, source);
  assert.throws(() => p.append([{ id: identityAssetRequestId("out", "code"), kind: "get-code", address: token }]));
  assert.throws(() => p.decode([]));
  assert.throws(() => p.decode([...ercResults(), ercResults()[0]]));
  assert.throws(() => p.decode(ercResults().map(r => ({ ...r, source: { ...source, generation: 8 } }))));
  assert.throws(() => p.decode([ercResults()[0], ok(identityAssetRequestId("out", "decimals"), ethers.toBeHex(256, 32))]));
  assert.throws(() => p.decode([ercResults()[0], ok(identityAssetRequestId("out", "decimals"), "0x")]));
  assert.throws(() => p.decode([ercResults()[0], { id: identityAssetRequestId("out", "decimals"), ok: false, source, failure: "rpc" }]));
});
