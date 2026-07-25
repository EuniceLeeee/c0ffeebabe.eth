import { ethers } from "ethers";
import {
  buildSignedBackrunTx,
  mevShareInclusion,
} from "../../submitter.js";
import { computeBidEth } from "../main.js";

function assertEq(actual: bigint, expected: bigint, msg: string): void {
  if (actual !== expected) {
    throw new Error(`FAIL: ${msg}: expected ${expected}, got ${actual}`);
  }
}

async function expectReject(
  input: Parameters<typeof buildSignedBackrunTx>[0],
  reason: string,
): Promise<void> {
  try {
    await buildSignedBackrunTx(input);
  } catch (error) {
    if (String(error).includes(reason)) return;
    throw error;
  }
  throw new Error(`FAIL: expected rejection containing ${reason}`);
}

async function main(): Promise<void> {
  assertEq(
    computeBidEth(100n, 30n, { bribeAllAboveGas: true, bribeBps: 5000 }),
    70n,
    "bribe-all profit above gas",
  );
  assertEq(
    computeBidEth(20n, 30n, { bribeAllAboveGas: true, bribeBps: 5000 }),
    0n,
    "bribe-all zero when gas exceeds profit",
  );
  assertEq(
    computeBidEth(30n, 30n, { bribeAllAboveGas: true, bribeBps: 5000 }),
    0n,
    "bribe-all zero at breakeven",
  );
  assertEq(
    computeBidEth(100n, 30n, { bribeAllAboveGas: false, bribeBps: 5000 }),
    35n,
    "bps mode shares post-gas surplus",
  );

  const wallet = ethers.Wallet.createRandom();
  Object.defineProperty(wallet, "getNonce", { value: async () => 7 });
  const provider = {
    async getBalance() {
      return ethers.parseEther("1");
    },
  };
  const signed = await buildSignedBackrunTx({
    calldataHex: "0x",
    gasUsed: 100,
    wallet: wallet as never,
    botvmAddress: "0x0000000000000000000000000000000000000002",
    provider: provider as never,
    bribeWei: 1_000n,
    maxBaseFeePerGas: 20n,
  });
  const tx = ethers.Transaction.from(signed.signedBackrunTx);
  assertEq(tx.gasLimit, 130n, "signed gas limit");
  assertEq(tx.maxPriorityFeePerGas ?? -1n, 1_000n / 130n, "signed priority fee");
  assertEq(
    tx.maxFeePerGas ?? -1n,
    20n + 1_000n / 130n,
    "signed max fee",
  );
  if ((tx.maxPriorityFeePerGas ?? 0n) * tx.gasLimit > 1_000n) {
    throw new Error("FAIL: signed tx can spend above EV-approved bribe budget");
  }

  const valid = {
    calldataHex: "0x",
    gasUsed: 100,
    wallet: wallet as never,
    botvmAddress: "0x0000000000000000000000000000000000000002",
    provider: provider as never,
    bribeWei: 0n,
    maxBaseFeePerGas: 20n,
  };
  await expectReject({ ...valid, gasUsed: 0 }, "measured gas used");
  await expectReject({ ...valid, maxBaseFeePerGas: 0n }, "target block base fee");
  await expectReject({ ...valid, bribeWei: -1n }, "bribe budget");
  const inclusion = mevShareInclusion(123);
  if (inclusion.block !== "0x7b" || inclusion.maxBlock !== "0x7b") {
    throw new Error("FAIL: MEV-Share inclusion must be pinned to one exact block");
  }

  console.log("[bribe-mode] computeBidEth: PASS");
  console.log("[bribe-mode] signed fee budget: PASS");
  console.log("[bribe-mode] single-block MEV-Share inclusion: PASS");
  console.log("expected_transition: bid = bribeBps*profit -> bid = bribeBps*(profit-gas)");
  console.log("verdict: fixed");
  console.log("searcher_behavior_change: yes");
}

await main();
