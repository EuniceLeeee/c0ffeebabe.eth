import assert from "node:assert/strict";
import { test } from "node:test";
import { options } from "./evidence.js";
const args = ["--family", "v4-native-nohook", "--ready", "/current-ready", "--prices", "/immutable-donor-prices", "--port", "19226", "--out", "/new-result"];
test("input-only and isolated native settlement are explicit V4 acceptance options", () => {
  const baseline = options(args);
  assert.equal(baseline.inputOnlyReference, false);
  assert.equal(baseline.v4SettlementArtifact, undefined);
  const parsed = options([...args, "--input-only-reference", "true", "--v4-settlement-artifact", "/current-fixture.json"]);
  assert.equal(parsed.inputOnlyReference, true);
  assert.equal(parsed.v4SettlementArtifact, "/current-fixture.json");
  assert.equal(parsed.ready, "/current-ready");
  assert.equal(parsed.prices, "/immutable-donor-prices");
});
test("input-only mode cannot silently weaken a different Family or accept a false/ambiguous flag", () => {
  for (const family of ["kyber", "yb", "compound", "frax"])
    assert.throws(() => options(["--family", family, ...args.slice(2), "--input-only-reference", "true"]));
  for (const value of ["false", "1", "yes"])
    assert.throws(() => options([...args, "--input-only-reference", value]));
});
test("funding fixture is confined to explicitly selected native V4 historical samples", () => {
  assert.equal(options(["--family", "v4-sat1", ...args.slice(2), "--v4-settlement-artifact", "/fixture"]).v4SettlementArtifact, "/fixture");
  assert.throws(() => options(["--family", "kyber", ...args.slice(2), "--v4-settlement-artifact", "/fixture"]));
});

import { assertV4SettlementAssets } from "./v4-native-settlement.js";
const zero = "0x0000000000000000000000000000000000000000", token0 = "0x1000000000000000000000000000000000000001", token1 = "0x1000000000000000000000000000000000000002";
test("settlement acceptance binds native and ERC20 mode to actual admitted raw currencies", () => {
  for (const currency0 of [zero, token0]) for (const direction of ["zero-for-one", "one-for-zero"]) {
    const descriptor = { poolKey: { currency0, currency1: token1 } }, forward = direction === "zero-for-one";
    const realTokenIn = forward ? currency0 : token1, realTokenOut = forward ? token1 : currency0;
    const route = { direction, realTokenIn, realTokenOut, executionAssets: { input: realTokenIn === zero ? "native" : "erc20", output: realTokenOut === zero ? "native" : "erc20" } };
    assert.equal(assertV4SettlementAssets(route, descriptor), currency0 === zero ? "native" : "erc20");
    assert.throws(() => assertV4SettlementAssets({ ...route, realTokenIn: token1 === realTokenIn ? token0 : token1 }, descriptor));
    assert.throws(() => assertV4SettlementAssets({ ...route, executionAssets: { ...route.executionAssets, input: route.executionAssets.input === "native" ? "erc20" : "native" } }, descriptor));
  }
  assert.throws(() => assertV4SettlementAssets({ direction: "zero-for-one", realTokenIn: zero, realTokenOut: zero,
    executionAssets: { input: "native", output: "native" } }, { poolKey: { currency0: zero, currency1: zero } }));
});
test("ERC20 settlement uses the same explicit input-only and fixture options", () => {
  for (const family of ["v4-erc20-nohook", "v4-erc20-tiered-fee"]) {
    const parsed = options(["--family", family, ...args.slice(2), "--input-only-reference", "true", "--v4-settlement-artifact", "/fixture", ...(family === "v4-erc20-tiered-fee" ? ["--revm-bin", "/revm-sim"] : [])]);
    assert.equal(parsed.inputOnlyReference, true); assert.equal(parsed.v4SettlementArtifact, "/fixture");
  }
});

test("ERC20 cross-block header is explicit and cannot alter native historical gates", () => {
  assert.throws(() => options([...args, "--input-only-reference", "true", "--target-header", "/target-header.json"]));
  assert.throws(() => options(["--family", "v4-erc20-nohook", ...args.slice(2)]));
  const parsed = options(["--family", "v4-erc20-tiered-fee", ...args.slice(2), "--input-only-reference", "true", "--target-header", "/target-header.json", "--revm-bin", "/revm-sim"]);
  assert.equal(parsed.targetHeader, "/target-header.json");
});

test("tiered executor quote requires explicit REVM; other samples retain provider-only mode", () => {
  assert.throws(() => options(["--family", "v4-erc20-tiered-fee", ...args.slice(2), "--input-only-reference", "true"]));
  assert.throws(() => options([...args, "--revm-bin", "/revm-sim"]));
});
