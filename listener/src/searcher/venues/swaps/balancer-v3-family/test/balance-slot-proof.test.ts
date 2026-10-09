import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { proveActorBalanceSlot } from "./balance-slot-proof.js";
const actor = ethers.toBeHex(1, 20), protectedAccount = ethers.toBeHex(2, 20), token = ethers.toBeHex(3, 20);
const abi = new ethers.Interface(["function balanceOf(address) view returns(uint256)", "function totalSupply() view returns(uint256)"]);
const keys = [41n, 42n].map(v => ethers.toBeHex(v, 32));
function fixture(mode = "valid") {
  return { token, actor, protectedAccount, candidates: keys, async call(_to: string, data: string, overrides?: any) {
    const read = abi.parseTransaction({ data })!;
    const diff = overrides?.[token]?.stateDiff;
    const value = diff?.[keys[1]];
    if (diff?.[keys[0]]) {
      if (mode === "transport") throw new Error("transport failed");
      if (mode === "empty") return "0x";
      throw Object.assign(new Error("execution reverted"), { localCall: true, rpcCode: 3, returnData: "0x" });
    }
    if (read.name === "totalSupply") return ethers.toBeHex(value && mode === "supply" ? 9n : 100n, 32);
    return ethers.toBeHex(read.args[0].toLowerCase() === actor ? BigInt(value ?? 0) : value && mode === "protected" ? 9n : 50n, 32);
  } };
}
test("namespace balance proof excludes reverting/empty proxy slots and proves only actor storage", async () => {
  for (const mode of ["valid", "empty"]) assert.equal((await proveActorBalanceSlot(fixture(mode))).slot, keys[1]);
});
test("namespace balance proof never absorbs transport failure or changes protected balance/supply", async () => {
  await assert.rejects(() => proveActorBalanceSlot(fixture("transport")), /transport failed/);
  for (const mode of ["supply", "protected"]) await assert.rejects(() => proveActorBalanceSlot(fixture(mode)), /not uniquely proven/);
});
