import { getAddress, keccak256 } from "ethers";
import { matchesBearTransferRuntime } from "./btb-bear.js";

/** Family-consumed token semantics, not a central pipeline policy. Unknown
 * runtimes retain the existing nominal-ERC20 model; this is NOT a proof that
 * arbitrary ERC20s are untaxed. Mandatory final execution remains authoritative. */
export type TokenTransferModel = {
  readonly kind: "nominal-unverified" | "verified-transfer-tax";
  readonly token: string;
  readonly codeHash: string;
  readonly taxNumerator: bigint;
  readonly taxDenominator: bigint;
};

export function identifyTokenTransferModel(token: string, code: string): TokenTransferModel {
  token = getAddress(token);
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) throw new Error("token transfer model requires deployed runtime code");
  const verified = matchesBearTransferRuntime(code, token);
  return Object.freeze({ token, codeHash: keccak256(code), taxNumerator: verified ? 100n : 0n,
    taxDenominator: 10000n, kind: verified ? "verified-transfer-tax" : "nominal-unverified" });
}

/** Net credit of an ordinary transfer. Mint/burn is deliberately not modeled. */
export function tokenTransferReceived(model: TokenTransferModel | undefined, amount: bigint, recipient?: string): bigint {
  if (amount < 0n || amount >= 1n << 256n) throw new Error("token transfer amount outside uint256");
  if (!model || model.kind === "nominal-unverified") return amount;
  if (model.kind !== "verified-transfer-tax") throw new Error("unsupported token transfer model");
  // Solidity evaluates amount * 100 before dividing, with checked arithmetic.
  if (model.taxNumerator <= 0n || model.taxDenominator <= model.taxNumerator) throw new Error("invalid transfer tax model");
  if (amount > ((1n << 256n) - 1n) / model.taxNumerator) throw new Error("token transfer tax multiplication overflow");
  // This verified implementation credits tax to the token itself. A transfer
  // to that account receives both credits; ordinary pair/executor recipients do not.
  return recipient && getAddress(recipient) === getAddress(model.token)
    ? amount : amount - amount * model.taxNumerator / model.taxDenominator;
}
