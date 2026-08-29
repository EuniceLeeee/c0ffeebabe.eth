import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain } from "../../canonical-codec/src/index.ts";
import {
  assetRefForIdentityV1,
  decodeAssetIdentityV1,
  decodeAssetReferenceV1,
  erc20AssetReferenceV1,
  nativeAssetReferenceV1,
} from "../src/index.ts";

const tokenA = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const tokenB = "0x2222222222222222222222222222222222222222";

test("the same chain and token has one family-independent AssetRef", () => {
  const fromFamilyA = erc20AssetReferenceV1("1", tokenA);
  const fromFamilyB = erc20AssetReferenceV1("1", tokenA.toUpperCase().replace("0X", "0x"));
  assert.deepEqual(fromFamilyA, fromFamilyB);
});

test("chain, token, and native identities do not collide", () => {
  const refs = [
    erc20AssetReferenceV1("1", tokenA).assetRef,
    erc20AssetReferenceV1("10", tokenA).assetRef,
    erc20AssetReferenceV1("1", tokenB).assetRef,
    nativeAssetReferenceV1("1").assetRef,
    nativeAssetReferenceV1("10").assetRef,
  ];
  assert.equal(new Set(refs).size, refs.length);
});

test("exact decoding rejects malformed identities and naked caller hashes", () => {
  assert.throws(() => decodeAssetIdentityV1({ chainId: "0", kind: "erc20", address: tokenA }));
  assert.throws(() => decodeAssetIdentityV1({ chainId: "01", kind: "erc20", address: tokenA }));
  assert.throws(() => decodeAssetIdentityV1({ chainId: "1", kind: "erc20", address: "0x0000000000000000000000000000000000000000" }));
  assert.throws(() => decodeAssetIdentityV1({ chainId: "1", kind: "erc20", address: tokenA.toUpperCase().replace("0X", "0x") }));
  assert.throws(() => decodeAssetIdentityV1({ chainId: "1", kind: "native", address: tokenA }));
  assert.throws(() => decodeAssetIdentityV1({ chainId: "1", kind: "native", address: null, familyId: "caller-family" }));
  assert.throws(() => decodeAssetIdentityV1({ chainId: "1", kind: "unknown", address: null }));
  assert.throws(() => decodeAssetReferenceV1(hashDomain("caller/asset", tokenA)));
  assert.throws(() => decodeAssetReferenceV1({
    identity: { chainId: "1", kind: "erc20", address: tokenA },
    assetRef: hashDomain("caller/asset", tokenA),
  }));
});

test("an unrelated family name cannot change an existing AssetRef", () => {
  const identity = erc20AssetReferenceV1("1", tokenA).identity;
  assert.equal(assetRefForIdentityV1(identity), erc20AssetReferenceV1("1", tokenA).assetRef);
  assert.notEqual(hashDomain("aloha/unrelated-family/asset/v1", identity), assetRefForIdentityV1(identity));
});
