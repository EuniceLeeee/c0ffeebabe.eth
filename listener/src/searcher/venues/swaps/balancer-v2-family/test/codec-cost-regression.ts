import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { VAULT_ABI, queryData, quoteOutput } from "../codec.js";

test("fixed Vault quote shape does not invoke the general ABI codec per direction", () => {
  // Work count, not a machine-dependent wall-clock assertion. Independent ABI
  // expectations are generated before installing the spies. Production must
  // preserve the same bytes and integer outputs for a multi-pool workload.
  const oracle = new ethers.Interface(VAULT_ABI.fragments);
  const address = (n: number) => ethers.getAddress("0x" + n.toString(16).padStart(40, "0"));
  const rows = Array.from({ length: 94 * 12 }, (_, i) => {
    const poolId = address(1000 + i % 94).toLowerCase() + "000100000000000000000030";
    const tokenIn = address(3000 + i % 47), tokenOut = address(4000 + i % 29), executor = address(5000);
    const amount = 6917984563928420n + BigInt(i), amountOut = amount * 123n;
    const calldata = oracle.encodeFunctionData("queryBatchSwap", [0,
      [[poolId, 0, 1, amount, "0x"]], [tokenIn, tokenOut], [executor, false, executor, false]]);
    const returned = oracle.encodeFunctionResult("queryBatchSwap", [[amount, -amountOut]]);
    return { poolId, tokenIn, tokenOut, executor, amount, amountOut, calldata, returned };
  });
  const methods = ["encodeFunctionData", "decodeFunctionResult", "encodeFunctionResult"] as const;
  const previous = methods.map(method => Object.getOwnPropertyDescriptor(VAULT_ABI, method));
  const calls: Record<string, number> = Object.fromEntries(methods.map(method => [method, 0]));
  try {
    for (const method of methods) {
      const original = VAULT_ABI[method];
      Object.defineProperty(VAULT_ABI, method, { configurable: true, value: (...args: unknown[]) => {
        calls[method]++;
        return Reflect.apply(original, VAULT_ABI, args);
      } });
    }
    for (const row of rows) {
      assert.equal(queryData(row.poolId, row.tokenIn, row.tokenOut, row.amount, row.executor), row.calldata);
      assert.equal(quoteOutput(row.returned, row.amount), row.amountOut);
    }
    assert.deepEqual(calls, { encodeFunctionData: 0, decodeFunctionResult: 0, encodeFunctionResult: 0 });
  } finally {
    methods.forEach((method, i) => {
      if (previous[i]) Object.defineProperty(VAULT_ABI, method, previous[i]!);
      else Reflect.deleteProperty(VAULT_ABI, method);
    });
  }
});
