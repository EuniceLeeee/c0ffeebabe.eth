import { ethers } from "ethers";
import {
  RuntimeAmountProgram,
  encodeRuntimeAmountNode,
  runtimeProgramScript,
} from "../../../../adapters/runtime-amount-program.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import {
  KYSWAP_POOL_INTERFACE,
  KYSWAP_SWAP_SELECTOR,
} from "./abi.js";
import { lower } from "./codec.js";
import { KYSWAP_SWAP_ACTION } from "./manifest.js";
import { MAX_SQRT_RATIO, MIN_SQRT_RATIO } from "../../../solver/v3-math.js";

const ERC20_TRANSFER = new ethers.Interface([
  "function transfer(address to,uint256 amount) returns (bool)",
]);

/**
 * Plugin-owned action: one Elastic `swap` call plus its `swapCallback` payment
 * script. The quoted-amount path may supply the runtime amount program (the
 * mechanism the template families use); the same encoder also accepts a
 * static plan node carrying an explicit amount, in which case the callback
 * script pays that fixed amount from the executor's own balance — the pool
 * pulls the input token from `msg.sender`, so no approval is ever emitted.
 * The action id, encoder and trace matcher all live in this family; the central
 * action catalog is not touched.
 */
export const kyberswapElasticSwapAction = bindFamilyOwnedAction({
  action: {
    id: KYSWAP_SWAP_ACTION,
    isWrapper: false,
    field2Offset: null,
    encode(node, executor, inner) {
      const runtime = encodeRuntimeAmountNode(node, inner);
      if (runtime !== null) return runtime;
      const target = lower(node.target);
      const actor = lower(executor);
      const isToken0 = node.params.isToken0;
      if (
        node.adapterId !== KYSWAP_SWAP_ACTION ||
        typeof node.amount !== "bigint" ||
        node.amount <= 0n ||
        typeof isToken0 !== "boolean" ||
        inner.length !== 0 ||
        node.children.length !== 0 ||
        target === actor ||
        lower(node.tokenIn) === lower(node.tokenOut)
      ) {
        throw new Error("kyberswap elastic invalid action");
      }
      const payment = new RuntimeAmountProgram().constant(1, node.amount);
      payment.call(
        node.tokenIn,
        ERC20_TRANSFER.encodeFunctionData("transfer", [target, 0n]),
        { patches: [{ offset: 36, reg: 1 }] },
      );
      const script = runtimeProgramScript(payment.bytes());
      return ethers.getBytes(KYSWAP_POOL_INTERFACE.encodeFunctionData("swap", [
        actor,
        node.amount,
        isToken0,
        isToken0 ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n,
        script,
      ]));
    },
    matchTrace: (_target: string, selector: string) =>
      selector.toLowerCase() === KYSWAP_SWAP_SELECTOR.toLowerCase(),
  },
  descriptor: {
    adapterId: KYSWAP_SWAP_ACTION,
    lineage: "custom-swap:kyberswap-elastic",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
