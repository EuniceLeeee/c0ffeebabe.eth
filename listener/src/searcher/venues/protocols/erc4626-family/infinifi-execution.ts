import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExecutor } from "../../runtime-execution.js";
import { INFINIFI_ABI as ABI, INFINIFI_GATEWAY, INFINIFI_ROLE, infinifiAddress, type InfiniFiBinding } from "./infinifi.js";

export function infinifiProgram(b: Pick<InfiniFiBinding, "vault" | "asset" | "gateway" | "yieldSharing" | "core">, executor: string, direction: "deposit" | "redeem", minimumOut = 1n): RuntimeAmountProgram {
  const { vault, asset, gateway, yieldSharing, core } = b;
  for (const address of [vault, asset, gateway, yieldSharing, core]) infinifiAddress(address);
  if (gateway.toLowerCase() !== INFINIFI_GATEWAY || new Set([vault, asset, gateway, yieldSharing, core].map(a => a.toLowerCase())).size !== 5)
    throw new Error("InfiniFi runtime bindings");
  runtimeExecutor(executor, vault, asset, gateway, yieldSharing, core);
  if (direction !== "deposit" && direction !== "redeem" || minimumOut < 0n || minimumOut > ethers.MaxUint256)
    throw new Error("InfiniFi runtime direction/minimum");
  const deposit = direction === "deposit", input = deposit ? asset : vault, output = deposit ? vault : asset;
  const p = new RuntimeAmountProgram().constant(14, 0n).constant(15, 1n).math("sub", 12, 0, 15);
  const read = (target: string, name: string, args: readonly unknown[], reg: number) =>
    p.call(target, ABI.encodeFunctionData(name, args), { static: true }).load(reg, 0);
  const addressCheck = (target: string, name: string, args: readonly unknown[], expected: string) =>
    read(target, name, args, 12).constant(13, BigInt(expected)).equal(12, 13);
  for (const [name, expected] of [["stakedToken", vault], ["receiptToken", asset], ["yieldSharing", yieldSharing]] as const)
    addressCheck(gateway, "getAddress", [name], expected);
  addressCheck(vault, "asset", [], asset); addressCheck(vault, "yieldSharing", [], yieldSharing);
  for (const target of [gateway, vault, yieldSharing]) addressCheck(target, "core", [], core);
  read(core, "hasRole", [INFINIFI_ROLE, gateway], 12).equal(12, 15);
  // No preview or chain-external amount goes into this program. r0 alone
  // determines the spend; final output is measured independently.
  read(input, "balanceOf", [executor], 1).math("sub", 12, 1, 0);
  read(output, "balanceOf", [executor], 2); read(vault, "totalSupply", [], 3);
  read(input, "balanceOf", [gateway], 5); read(output, "balanceOf", [gateway], 6);
  const approve = (actual: boolean) => {
    p.call(input, ABI.encodeFunctionData("approve", [gateway, 0n]), actual ? { patches: [{ offset: 36, reg: 0 }] } : {})
      .load(12, 0).equal(12, 15);
    read(input, "allowance", [executor, gateway], 12).equal(12, actual ? 0 : 14);
  };
  approve(false); approve(true);
  p.call(gateway, ABI.encodeFunctionData(deposit ? "stake" : "unstake", [executor, 0n]), { patches: [{ offset: 36, reg: 0 }] })
    .load(4, 0).math("sub", 12, 4, 15);
  approve(false);
  read(input, "balanceOf", [executor], 8).math("sub", 8, 1, 8).equal(8, 0);
  read(output, "balanceOf", [executor], 8).math("sub", 8, 8, 2).equal(8, 4);
  read(vault, "totalSupply", [], 9).math("sub", 9, deposit ? 9 : 3, deposit ? 3 : 9).equal(9, deposit ? 4 : 0);
  read(input, "balanceOf", [gateway], 9).equal(9, 5); read(output, "balanceOf", [gateway], 9).equal(9, 6);
  p.constant(10, minimumOut > 0n ? minimumOut : 1n).math("sub", 12, 8, 10);
  return p;
}
