import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { assertRecipientEvent } from "../../erc4626-family/test/standard-recipient-observations.js";
import { ERC4626_INTERFACE } from "../../erc4626-family/abi.js";
import { stakedUsdatEventAssets } from "./observations.js";
const vault = "0x1000000000000000000000000000000000000001";
const asset = "0x1000000000000000000000000000000000000002";
const executor = "0x1000000000000000000000000000000000000003";
const recipient = "0x1000000000000000000000000000000000000004";

test("StakedUSDat observer rounds fee up; zero fee or zero recipient leaves gross intact", () => {
  assert.equal(stakedUsdatEventAssets(10_001n, 10n, recipient), 9_990n);
  assert.equal(stakedUsdatEventAssets(10_001n, 0n, recipient), 10_001n);
  assert.equal(stakedUsdatEventAssets(10_001n, 10n, ethers.ZeroAddress), 10_001n);
  assert.throws(() => stakedUsdatEventAssets(1n, 10_001n, recipient));
});

test("net Deposit.assets needs explicit evidence; ordinary default remains gross-strict", () => {
  const gross = 10_001n, net = stakedUsdatEventAssets(gross, 10n, recipient), shares = 777n;
  const make = (assets: bigint) => [{ address: vault,
    ...ERC4626_INTERFACE.encodeEventLog(ERC4626_INTERFACE.getEvent("Deposit")!, [executor, recipient, assets, shares]) }];
  const context = { deposit: true, vault, asset, executor, recipient, amount: gross, output: shares, assetSupplyDelta: 0n };
  assert.throws(() => assertRecipientEvent(make(net), context));
  assertRecipientEvent(make(gross), context);
  assertRecipientEvent(make(net), { ...context, expectedEventAssets: net });
  assert.throws(() => assertRecipientEvent(make(net), { ...context, expectedEventAssets: net - 1n }));
  assert.throws(() => assertRecipientEvent(make(gross), { ...context, expectedEventAssets: net }));
  assert.throws(() => assertRecipientEvent(make(net), { ...context, deposit: false, expectedEventAssets: net }));
});
