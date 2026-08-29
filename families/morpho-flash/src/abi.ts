const BALANCE_OF_SELECTOR = "0x70a08231" as const;

function addressWord(value: string, path: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError(`${path} must be an address`);
  return value.slice(2).toLowerCase().padStart(64, "0");
}

export function encodeErc20BalanceOf(account: string): string {
  return `${BALANCE_OF_SELECTOR}${addressWord(account, "morpho.balanceOf.account")}`;
}

export function decodeUint256(value: string, path: string): bigint {
  if (!/^0x(?:[0-9a-fA-F]{64})+$/.test(value)) throw new TypeError(`${path} must be ABI uint256 return data`);
  return BigInt(`0x${value.slice(2, 66)}`);
}
