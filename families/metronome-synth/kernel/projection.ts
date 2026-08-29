export type Address = `0x${string}`;
export interface Pair { readonly tokenIn: Address; readonly tokenOut: Address; }
export interface MetronomeSynthProjectionV1 {
  readonly pool: Address;
  readonly tokens: readonly Address[];
  readonly directions: readonly Pair[];
  readonly oracleBinding: `0x${string}`;
  readonly quoteSemantics: "metronome-quote-swap-out-v1";
}
function address(value: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError("invalid address");
  return value.toLowerCase() as Address;
}
export function uniqueAddresses(values: readonly string[]): readonly Address[] {
  return Object.freeze([...new Set(values.map(address))].sort());
}
export function directedPairs(values: readonly string[]): readonly Pair[] {
  const tokens = uniqueAddresses(values);
  return Object.freeze(tokens.flatMap(tokenIn => tokens.flatMap(tokenOut => tokenIn === tokenOut ? [] : [Object.freeze({ tokenIn, tokenOut })])));
}
export function pairRequestId(prefix: string, pair: Pair): string {
  if (!/^[a-z][a-z0-9-]*$/.test(prefix)) throw new TypeError("invalid prefix");
  return `${prefix}:${pair.tokenIn}:${pair.tokenOut}`;
}
export function metronomeSynthProjection(input: {
  readonly pool: string;
  readonly tokens: readonly string[];
  readonly activeDirections: readonly Pair[];
  readonly oracleBinding: `0x${string}`;
}): MetronomeSynthProjectionV1 {
  const tokens = uniqueAddresses(input.tokens);
  const tokenSet = new Set(tokens);
  const directions = input.activeDirections
    .map(pair => Object.freeze({ tokenIn: address(pair.tokenIn), tokenOut: address(pair.tokenOut) }))
    .sort((left, right) => left.tokenIn.localeCompare(right.tokenIn) || left.tokenOut.localeCompare(right.tokenOut));
  if (directions.some(pair => pair.tokenIn === pair.tokenOut || !tokenSet.has(pair.tokenIn) || !tokenSet.has(pair.tokenOut)) || new Set(directions.map(pair => `${pair.tokenIn}:${pair.tokenOut}`)).size !== directions.length) throw new Error("direction not bound to token set");
  if (!/^0x[0-9a-fA-F]+$/.test(input.oracleBinding) || input.oracleBinding.length % 2 !== 0) throw new TypeError("invalid oracle binding");
  return Object.freeze({ pool: address(input.pool), tokens, directions: Object.freeze(directions), oracleBinding: input.oracleBinding.toLowerCase() as `0x${string}`, quoteSemantics: "metronome-quote-swap-out-v1" });
}
