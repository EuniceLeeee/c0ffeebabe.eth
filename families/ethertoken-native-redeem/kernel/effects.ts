export type Address = `0x${string}`;
export interface TokenDelta { readonly token: Address; readonly account: Address; readonly delta: bigint }
export interface NativeDelta { readonly account: Address; readonly delta: bigint }
export interface SupplyDelta { readonly token: Address; readonly delta: bigint }

function address(value: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError("invalid address");
  return value.toLowerCase() as Address;
}

export function validateEtherTokenNativeRedeem(input: {
  readonly completion: "returned";
  readonly returnDataHex: string;
  readonly tokenDeltas: readonly TokenDelta[];
  readonly nativeDeltas: readonly NativeDelta[];
  readonly supplyDeltas: readonly SupplyDelta[];
  readonly token: string;
  readonly actor: string;
  readonly amountIn: bigint;
}): bigint {
  const token = address(input.token);
  const actor = address(input.actor);
  const tokenDelta = input.tokenDeltas[0];
  const nativeDelta = input.nativeDeltas[0];
  const supplyDelta = input.supplyDeltas[0];
  const exactScope = input.returnDataHex === "0x"
    && input.tokenDeltas.length === 1
    && input.nativeDeltas.length === 1
    && input.supplyDeltas.length === 1
    && address(tokenDelta!.token) === token
    && address(tokenDelta!.account) === actor
    && tokenDelta!.delta === -input.amountIn
    && address(nativeDelta!.account) === actor
    && nativeDelta!.delta === input.amountIn
    && address(supplyDelta!.token) === token
    && supplyDelta!.delta === -input.amountIn;
  if (input.amountIn <= 0n || !exactScope) throw new Error("exact native redemption failed");
  return input.amountIn;
}
