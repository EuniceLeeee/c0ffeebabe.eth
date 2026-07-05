import { ethers } from "ethers";
import { encodeCall } from "../encoder.js";
import type { ActionAdapter } from "../types.js";

export interface ProtocolLegDescriptor {
  id: string;
  signature: string;
  amountArg: number;
  executorArgs: number[];
  needsApprove: boolean;
  quoteSig?: string;
}

type ArgSource = "amount" | "executor";

function functionName(signature: string): string {
  const paren = signature.indexOf("(");
  if (paren <= 0) {
    throw new Error(`invalid protocol leg signature: ${signature}`);
  }
  return signature.slice(0, paren);
}

function argSources(desc: ProtocolLegDescriptor, argCount: number): ArgSource[] {
  const sources: Array<ArgSource | undefined> = Array(argCount).fill(undefined);

  function setArg(index: number, source: ArgSource): void {
    if (!Number.isInteger(index) || index < 0 || index >= argCount) {
      throw new Error(`protocol leg ${desc.id} arg index ${index} out of range`);
    }
    if (sources[index] !== undefined) {
      throw new Error(`protocol leg ${desc.id} arg index ${index} assigned twice`);
    }
    sources[index] = source;
  }

  setArg(desc.amountArg, "amount");
  for (const index of desc.executorArgs) {
    setArg(index, "executor");
  }

  const missing = sources.findIndex((source) => source === undefined);
  if (missing !== -1) {
    throw new Error(`protocol leg ${desc.id} leaves arg index ${missing} uncovered`);
  }

  return sources as ArgSource[];
}

export function makeProtocolAdapter(desc: ProtocolLegDescriptor): ActionAdapter {
  const iface = new ethers.Interface([`function ${desc.signature}`]);
  const fnName = functionName(desc.signature);
  const fragment = iface.getFunction(fnName);
  if (fragment === null) {
    throw new Error(`protocol leg ${desc.id} function not found: ${fnName}`);
  }

  const sources = argSources(desc, fragment.inputs.length);
  const expectedSelector = fragment.selector;

  return {
    id: desc.id,
    isWrapper: false,
    field2Offset: null,

    encode(node, executor, _inner) {
      const args = sources.map((source) => source === "amount" ? node.amount : executor);
      return encodeCall(node.target, ethers.getBytes(iface.encodeFunctionData(fnName, args)));
    },

    matchTrace(_target, selector) {
      return selector === expectedSelector;
    },
  };
}

export const PROTOCOL_LEG_DESCRIPTORS: ProtocolLegDescriptor[] = [
  {
    id: "wsteth-wrap",
    signature: "wrap(uint256)",
    amountArg: 0,
    executorArgs: [],
    needsApprove: true,
    quoteSig: "getWstETHByStETH(uint256)",
  },
  {
    id: "wsteth-unwrap",
    signature: "unwrap(uint256)",
    amountArg: 0,
    executorArgs: [],
    needsApprove: false,
    quoteSig: "getStETHByWstETH(uint256)",
  },
  {
    id: "erc4626-deposit",
    signature: "deposit(uint256,address)",
    amountArg: 0,
    executorArgs: [1],
    needsApprove: true,
    quoteSig: "previewDeposit(uint256)",
  },
  {
    id: "erc4626-redeem",
    signature: "redeem(uint256,address,address)",
    amountArg: 0,
    executorArgs: [1, 2],
    needsApprove: false,
    quoteSig: "previewRedeem(uint256)",
  },
];
