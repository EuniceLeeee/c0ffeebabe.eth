export type Address = `0x${string}`;

export interface TokenDelta {
  readonly token: Address;
  readonly account: Address;
  readonly delta: bigint;
}

export interface AstraEffectProgram {
  readonly caller: Address;
  readonly executionMode: "impersonated-call-frame";
  readonly observeTokenBalances: readonly { readonly token: Address; readonly account: Address }[];
  readonly observeLogs: true;
}

function addr(value: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError("invalid address");
  return value.toLowerCase() as Address;
}

function pairs(input: { readonly caller: string; readonly target: string; readonly tokenIn: string; readonly tokenOut: string }) {
  const caller = addr(input.caller);
  const target = addr(input.target);
  const tokenIn = addr(input.tokenIn);
  const tokenOut = addr(input.tokenOut);
  if (caller === target || tokenIn === tokenOut) throw new TypeError("Astra effect scope is not distinct");
  return [
    { token: tokenIn, account: caller },
    { token: tokenIn, account: target },
    { token: tokenOut, account: caller },
    { token: tokenOut, account: target },
  ] as const;
}

function sum(deltas: readonly TokenDelta[], token: string, account: string): bigint {
  const expectedToken = addr(token);
  const expectedAccount = addr(account);
  return deltas.reduce(
    (total, delta) => addr(delta.token) === expectedToken && addr(delta.account) === expectedAccount ? total + delta.delta : total,
    0n,
  );
}

export function astraEffectProgram(input: { readonly caller: string; readonly target: string; readonly tokenIn: string; readonly tokenOut: string }): AstraEffectProgram {
  return Object.freeze({
    caller: addr(input.caller),
    executionMode: "impersonated-call-frame" as const,
    observeTokenBalances: Object.freeze([...pairs(input)].sort((left, right) => left.token.localeCompare(right.token) || left.account.localeCompare(right.account))),
    observeLogs: true as const,
  });
}

/** Require exactly the four declared token/account segments; aggregation is not a valid observation. */
export function validateAstraExchange(input: { readonly tokenDeltas: readonly TokenDelta[]; readonly caller: string; readonly target: string; readonly tokenIn: string; readonly tokenOut: string; readonly amountIn: bigint; readonly amountOut: bigint }): bigint {
  if (input.amountIn <= 0n || input.amountOut <= 0n) throw new RangeError("amounts must be positive");
  const expected = pairs(input);
  const expectedKeys = new Set(expected.map(pair => `${pair.token}:${pair.account}`));
  if (input.tokenDeltas.length !== expected.length) throw new Error("Astra token/account observation cardinality mismatch");
  const actualKeys = input.tokenDeltas.map(delta => {
    const key = `${addr(delta.token)}:${addr(delta.account)}`;
    if (!expectedKeys.has(key)) throw new Error("unowned token/account delta");
    return key;
  });
  if (new Set(actualKeys).size !== expectedKeys.size) throw new Error("duplicate token/account delta");
  if (
    sum(input.tokenDeltas, input.tokenIn, input.caller) !== -input.amountIn
    || sum(input.tokenDeltas, input.tokenIn, input.target) !== input.amountIn
    || sum(input.tokenDeltas, input.tokenOut, input.caller) !== input.amountOut
    || sum(input.tokenDeltas, input.tokenOut, input.target) !== -input.amountOut
  ) throw new Error("four-party conservation failed");
  return input.amountOut;
}
