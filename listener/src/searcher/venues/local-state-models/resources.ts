/** Common EVM resource identities used by models, never protocol dispatch. */
function address(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("invalid trial resource address");
  return value.toLowerCase();
}
export const storageState = (account: string): string => `storage:${address(account)}`;
export const nativeBalanceState = (account: string): string => `native-balance:${address(account)}`;
export const tokenBalanceState = (token: string, account: string): string =>
  `token-balance:${address(token)}:${address(account)}`;
export const tokenSupplyState = (token: string): string => `token-supply:${address(token)}`;
