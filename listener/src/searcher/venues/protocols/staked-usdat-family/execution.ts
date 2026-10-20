import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { runtimeExecutor, runtimeLeg } from "../../runtime-execution.js";
import { assertErc4626Invocation } from "../erc4626-family/binding.js";
import { erc4626Execution, standardRecipientProgram } from "../erc4626-family/execution.js";
import type { Erc4626Descriptor, Erc4626Route, Erc4626ExactEvidence } from "../erc4626-family/types.js";
import { STAKED_USDAT_INTERFACE } from "./identity-proof.js";

export const stakedUsdatExecution: ExecutionSemantics<Erc4626Descriptor, Erc4626Route, Erc4626ExactEvidence> = {
  ...erc4626Execution,
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor, source } = input;
    assertErc4626Invocation(d, r);
    if (!d.stakedUsdat || input.runtimeEvidence.length) throw new Error("StakedUSDat runtime binding/evidence mismatch");
    if (!source || !Number.isSafeInteger(source.number) || source.number < 0 ||
        !Number.isSafeInteger(source.generation) || source.generation < 0 || !/^0x[0-9a-fA-F]{64}$/.test(source.hash))
      throw new Error("StakedUSDat runtime requires canonical source");
    if (input.settlement && input.settlement.kind !== "direct-output") return null;
    const recipient = input.settlement ? runtimeExecutor(input.settlement.recipient, d.vault, d.asset) : executor;
    // This is the shared ERC4626 receipt program: r0 alone supplies input;
    // payer debit and recipient's fresh receipt are independently checked.
    const program = standardRecipientProgram(d, executor, "deposit", recipient);
    for (const [name, expected] of [["asset", d.asset], ["getStrcOracle", d.stakedUsdat.oracle],
      ["getWithdrawalQueue", d.stakedUsdat.withdrawalQueue]] as const) {
      program.call(d.vault, STAKED_USDAT_INTERFACE.encodeFunctionData(name), { static: true })
        .load(13, 0).constant(14, BigInt(expected)).equal(13, 14);
    }
    return { ...runtimeLeg(r.adapterId, program), settlement: { directOutput: true },
      ...(input.settlement ? { settlementRequest: input.settlement } : {}) };
  },
};
