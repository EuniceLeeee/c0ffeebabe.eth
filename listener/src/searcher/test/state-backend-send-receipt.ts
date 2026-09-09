import assert from "node:assert/strict";
import { AnvilStateBackend, TransactionRevertedError } from "../../shared/state/state-backend.js";

const sender = "0x" + "11".repeat(20);
const target = "0x" + "22".repeat(20);
const hash = "0x" + "33".repeat(32);
const backend = new AnvilStateBackend("http://archive.invalid", "http://127.0.0.1:65534", 65534);
backend.provider.destroy();
let receipt: { status: number | null } | null = null;
let traced = 0;
backend.provider = {
  getBalance: async () => 10n ** 20n,
  getTransactionReceipt: async () => receipt,
  async send(method: string) {
    switch (method) {
      case "anvil_impersonateAccount":
      case "anvil_setBalance":
      case "anvil_mine": return null;
      case "eth_sendTransaction": return hash;
      case "debug_traceTransaction":
        traced++;
        return { to: target, input: "0x12345678", error: "execution reverted" };
      default: throw new Error(`unexpected request ${method}`);
    }
  },
} as unknown as typeof backend.provider;
const send = () => backend.send({ from: sender, to: target, data: "0x12345678" });
for (const missing of [null, { status: null }, { status: 2 }]) {
  receipt = missing;
  await assert.rejects(send(), (error: unknown) =>
    error instanceof Error && !(error instanceof TransactionRevertedError) &&
    error.message.includes("receipt unavailable"));
}
assert.equal(traced, 0, "missing receipt is not proof of an EVM revert");
receipt = { status: 0 };
await assert.rejects(send(), (error: unknown) =>
  error instanceof TransactionRevertedError && error.kind === "revert" &&
  error.code === "TRANSACTION_REVERTED" && error.transactionHash === hash);
assert.equal(traced, 1);
receipt = { status: 1 };
assert.equal(await send(), hash);
console.log("state-backend-send-receipt PASS (missing/invalid is infrastructure, status=0 is revert)");
