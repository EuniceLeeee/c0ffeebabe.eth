import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { definedFamilyPluginContractSummary } from "../../../adapter-family-plugin.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { plugin } from "../../../production-families/boring-vault-teller.production.js";

const executor = ethers.getAddress("0x10000000000000000000000000000000000000ee");
const amount = 10n ** 18n;
const abi = new ethers.Interface(["function bulkWithdraw(address,uint256,uint256,address)"]);

function descriptor() {
  const asset = ethers.getAddress("0x1000000000000000000000000000000000000011");
  const vault = ethers.getAddress("0x1000000000000000000000000000000000000012");
  const teller = ethers.getAddress("0x1000000000000000000000000000000000000013");
  const accountant = ethers.getAddress("0x1000000000000000000000000000000000000014");
  return {
    familyId: "protocol:boring-vault-teller", lineageId: "boring-vault-teller:v1",
    instanceKey: teller, teller, vault, accountant, asset, shareDecimals: 18, shareLockPeriod: 0n,
    tellerCodeHash: "0x" + "11".repeat(32), vaultCodeHash: "0x" + "22".repeat(32),
    accountantCodeHash: "0x" + "33".repeat(32), runtimeRequirements: [],
  } as any;
}

test("boring vault teller family definition is valid", () => {
  definedFamilyPluginContractSummary(plugin);
  assert.equal(plugin.manifest.familyId, "protocol:boring-vault-teller");
  assert.equal(plugin.manifest.domain, "protocol");
  assert.deepEqual([...plugin.manifest.ownedActionAdapterIds], ["boring-vault-withdraw"]);
  assert.deepEqual([...plugin.manifest.supportedLineages], ["boring-vault-teller:v1"]);
});

test("runtime leg withdraws the actual share amount with no allowance", () => {
  const d = descriptor();
  const route = plugin.routes.project({ descriptor: d })[0]!;
  const leg = plugin.execution.buildRuntimeLeg({ descriptor: d, route, executor, runtimeEvidence: [] });
  assert.ok(leg);
  const trace = inspectRuntime(leg.program, amount, { call: () => ethers.ZeroHash, nativeBalance: () => 0n });
  assert.equal(trace.allowances.length, 0);
  assert.equal(trace.calls.filter(call => call.data.slice(0, 10) === "0x095ea7b3").length, 0);
  const calls = trace.calls.filter(call => call.data.slice(0, 10) === abi.getFunction("bulkWithdraw")!.selector);
  assert.equal(calls.length, 1);
  const [asset, shares, minimumOut, receiver] = abi.decodeFunctionData("bulkWithdraw", calls[0]!.data);
  assert.equal(calls[0]!.target.toLowerCase(), d.teller.toLowerCase());
  assert.equal(String(asset).toLowerCase(), d.asset.toLowerCase());
  assert.equal(shares, amount);
  assert.equal(minimumOut, 0n);
  assert.equal(String(receiver).toLowerCase(), executor.toLowerCase());
});
