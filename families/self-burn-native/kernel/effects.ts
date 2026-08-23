export type Address = `0x${string}`;
export interface TokenDelta { readonly token: Address; readonly account: Address; readonly delta: bigint }
export interface NativeDelta { readonly account: Address; readonly delta: bigint }
export interface SupplyDelta { readonly token: Address; readonly delta: bigint }

function address(value: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError("invalid address");
  return value.toLowerCase() as Address;
}

function returnsTrue(dataHex: string): boolean {
  return /^0x0{63}1$/i.test(dataHex);
}

export function selfBurnProbeAmounts(one: bigint): readonly bigint[] {
  if (one <= 0n) throw new RangeError("one must be positive");
  return Object.freeze([...new Set([
    one >= 1_000n ? one / 1_000n : 1n,
    one >= 100n ? one / 100n : 1n,
    one >= 10n ? one / 10n : 1n,
    one,
  ])].sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
}

export function validateSelfBurnNativeRedeem(input: {
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
  const exactScope = returnsTrue(input.returnDataHex)
    && input.tokenDeltas.length === 1
    && input.nativeDeltas.length === 1
    && input.supplyDeltas.length === 1
    && address(tokenDelta!.token) === token
    && address(tokenDelta!.account) === actor
    && tokenDelta!.delta === -input.amountIn
    && address(nativeDelta!.account) === actor
    && nativeDelta!.delta > 0n
    && address(supplyDelta!.token) === token
    && supplyDelta!.delta === -input.amountIn;
  if (input.amountIn <= 0n || !exactScope) throw new Error("variable native redemption failed");
  return nativeDelta!.delta;
}
