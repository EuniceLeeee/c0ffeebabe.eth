import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import {
  allowanceStorageKey,
  balanceStorageKey,
  COMMON_ERC20_MAPPING_SLOTS,
  knownTokenStorageLayout,
  tokenAllowanceHint,
  tokenBalanceHint,
} from "../solver/balance-slots.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function main(): void {
  assert(COMMON_ERC20_MAPPING_SLOTS.includes(3), "candidate slots include WETH balance slot");

  const weth = knownTokenStorageLayout(ADDR.WETH);
  assert(weth?.balanceSlot === 3, `WETH balance slot ${weth?.balanceSlot}`);
  assert(weth?.allowanceSlot === 4, `WETH allowance slot ${weth?.allowanceSlot}`);

  const owner = "0x000000000000000000000000000000000000dEaD";
  const spender = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
  const balanceSlot = balanceStorageKey(owner, 3);
  const manualBalance = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256"],
      [ethers.getAddress(owner), 3],
    ),
  );
  assert(balanceSlot === manualBalance, "balance slot key matches abi-encoded mapping");

  const allowanceSlot = allowanceStorageKey(owner, spender, 4);
  const manualInner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256"],
      [ethers.getAddress(owner), 4],
    ),
  );
  const manualAllowance = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256"],
      [ethers.getAddress(spender), manualInner],
    ),
  );
  assert(allowanceSlot === manualAllowance, "allowance slot key matches nested mapping");

  const balHint = tokenBalanceHint(ADDR.WETH, owner);
  assert(balHint.balanceSlot === 3, "known token balance hint carries slot");
  const allowanceHint = tokenAllowanceHint(ADDR.WETH, owner, spender);
  assert(allowanceHint.allowanceSlot === 4, "known token allowance hint carries slot");

  const unknown = "0x0000000000000000000000000000000000000001";
  assert(knownTokenStorageLayout(unknown) === null, "unknown token has no forced slot");
  assert(tokenBalanceHint(unknown, owner).balanceSlot === undefined, "unknown token falls back to daemon probe");

  console.log("[balance-slots] registry hints and storage keys: PASS");
}

main();
