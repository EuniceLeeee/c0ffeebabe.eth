export type Address = `0x${string}`;

export interface TokenDelta {
  readonly token: Address;
  readonly account: Address;
  readonly delta: bigint;
}

export interface SupplyDelta {
  readonly token: Address;
  readonly delta: bigint;
}

function address(value: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError("invalid address");
  return value.toLowerCase() as Address;
}

function decodeUint256Return(dataHex: string): bigint {
  if (!/^0x[0-9a-fA-F]{64}$/.test(dataHex)) {
    throw new TypeError("redeem return must be exactly one ABI uint256 word");
  }
  return BigInt(dataHex);
}

function exactTokenDelta(
  deltas: readonly TokenDelta[],
  token: Address,
  account: Address,
  expected: bigint,
): boolean {
  const matching = deltas.filter((item) =>
    address(item.token) === token && address(item.account) === account
  );
  return matching.length === 1 && matching[0]!.delta === expected;
}

export function validateErc4626SiloRedeem(input: {
  readonly completion: "returned";
  readonly returnDataHex: string;
  readonly tokenDeltas: readonly TokenDelta[];
  readonly supplyDeltas: readonly SupplyDelta[];
  readonly vault: string;
  readonly payoutToken: string;
  readonly actor: string;
  readonly amountIn: bigint;
}): bigint {
  const vault = address(input.vault);
  const payoutToken = address(input.payoutToken);
  const actor = address(input.actor);
  if (vault === payoutToken || input.amountIn <= 0n) throw new Error("invalid Silo redeem contract");

  const amountOut = decodeUint256Return(input.returnDataHex);
  const exactScope = input.tokenDeltas.length === 2
    && input.supplyDeltas.length === 1
    && exactTokenDelta(input.tokenDeltas, vault, actor, -input.amountIn)
    && exactTokenDelta(input.tokenDeltas, payoutToken, actor, amountOut)
    && address(input.supplyDeltas[0]!.token) === vault
    && input.supplyDeltas[0]!.delta === -input.amountIn;
  if (amountOut <= 0n || !exactScope) throw new Error("Silo redeem conservation failed");
  return amountOut;
}
