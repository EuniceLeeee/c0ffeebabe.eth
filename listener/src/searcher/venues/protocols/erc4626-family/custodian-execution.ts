import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { runtimeExecutor } from "../../runtime-execution.js";
import { CUSTODIAN_ABI, CUSTODIAN_TOKEN, custodianAddress } from "./custodian.js";

export function assertCustodianExecutionSource(source: CanonicalSource | undefined): void {
  // The production issuer authenticates the current-source route. Identity's
  // original block is provenance, not a one-block expiry. Pricing/Exact check
  // the current proxy/implementation; runtime reads current permissions and
  // enforces independent effects, with final simulation still mandatory.
  if (source === undefined || !Number.isSafeInteger(source.number) || source.number < 0 ||
      !Number.isSafeInteger(source.generation) || source.generation < 0 || !/^0x[0-9a-fA-F]{64}$/.test(source.hash))
    throw new Error("Custodian runtime requires canonical source");
}

/** Amount comes solely from r0; no chain-external quote or trial amount. */
export function custodianProgram(d: { vault: string; share: string; asset: string },
  executor: string, direction: "deposit" | "redeem", minimumOut = 1n): RuntimeAmountProgram {
  const vault = custodianAddress(d.vault), share = custodianAddress(d.share), asset = custodianAddress(d.asset);
  if (new Set([vault, share, asset].map(x => x.toLowerCase())).size !== 3) throw new Error("Custodian external token binding");
  runtimeExecutor(executor, vault, share, asset);
  if (direction !== "deposit" && direction !== "redeem") throw new Error("Custodian direction");
  if (minimumOut < 0n || minimumOut > ethers.MaxUint256) throw new Error("Custodian minimum output");
  const deposit = direction === "deposit", tokenIn = deposit ? asset : share, tokenOut = deposit ? share : asset;
  const p = new RuntimeAmountProgram().constant(14, 0n).constant(15, 1n);
  const read = (target: string, data: string, reg: number) => p.call(target, data, { static: true }).load(reg, 0);
  const tokenRead = (token: string, name: string, args: readonly unknown[], reg: number) => read(token, CUSTODIAN_TOKEN.encodeFunctionData(name, args), reg);
  for (const [name, address] of [["frxUSD", share], ["asset", asset], ["custodianTkn", asset]] as const) {
    read(vault, CUSTODIAN_ABI.encodeFunctionData(name), 12).constant(13, BigInt(address)).equal(12, 13);
  }
  tokenRead(share, "minters", [vault], 12).equal(12, 15);
  tokenRead(share, "isPaused", [], 12).equal(12, 14);
  for (const actor of [executor, vault]) tokenRead(share, "isFrozen", [actor], 12).equal(12, 14);
  tokenRead(tokenIn, "balanceOf", [executor], 1).math("sub", 12, 1, 0);
  tokenRead(tokenOut, "balanceOf", [executor], 2);
  tokenRead(share, "totalSupply", [], 3);
  p.call(vault, CUSTODIAN_ABI.encodeFunctionData("mdwrComboView"), { static: true })
    .load(4, deposit ? 32 : 64).load(5, deposit ? 0 : 96).math("sub", 12, 5, 0);
  p.call(vault, CUSTODIAN_ABI.encodeFunctionData(deposit ? "previewDeposit" : "previewRedeem", [0n]), { static: true, patches: [{ offset: 4, reg: 0 }] })
    .load(6, 0).math("sub", 12, 6, 15).math("sub", 12, 4, 6);
  const approve = (actual: boolean) => {
    p.call(tokenIn, CUSTODIAN_TOKEN.encodeFunctionData("approve", [vault, 0n]),
      actual ? { patches: [{ offset: 36, reg: 0 }] } : {}).load(12, 0).equal(12, 15);
    tokenRead(tokenIn, "allowance", [executor, vault], 12).equal(12, actual ? 0 : 14);
  };
  approve(false); approve(true);
  p.call(vault, CUSTODIAN_ABI.encodeFunctionData(direction, deposit ? [0n, executor] : [0n, executor, executor]), { patches: [{ offset: 4, reg: 0 }] })
    .load(7, 0).equal(7, 6);
  approve(false);
  tokenRead(tokenIn, "balanceOf", [executor], 8).math("sub", 8, 1, 8).equal(8, 0);
  tokenRead(share, "totalSupply", [], 8).math("sub", 8, deposit ? 8 : 3, deposit ? 3 : 8).equal(8, deposit ? 7 : 0);
  // Measure the external asset independently. Neither a return word nor old
  // executor inventory can make up missing output; partial input is rejected.
  tokenRead(tokenOut, "balanceOf", [executor], 8).math("sub", 8, 8, 2).equal(8, 7);
  p.constant(10, minimumOut > 0n ? minimumOut : 1n).math("sub", 12, 8, 10);
  return p;
}

export function custodianRedeemProgram(d: { vault: string; share: string; asset: string }, executor: string, minimumOut = 1n) {
  return custodianProgram(d, executor, "redeem", minimumOut);
}
