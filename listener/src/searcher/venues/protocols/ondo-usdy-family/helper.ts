import { AbiCoder } from "ethers";
/** Unverified Ondo redeem helper used by the historical tx; calldata is address-only. */
export const ONDO_REDEEM_HELPER = "0x8ca0c4f7902f796043635d2fd3ce2a085cebac90";
const coder = AbiCoder.defaultAbiCoder();
export function buildOndoHelperCalldata(executor: string, receive: string, usdy: string): string {
  const body = coder.encode(
    ["address", "address", "uint256", "uint256", "uint256", "address", "uint256", "uint256", "address"],
    [executor, receive, 0x60n, 1n, 0x20n, usdy, 0x40n, 0x20n, receive],
  );
  return "0xccee0802" + body.slice(2);
}
