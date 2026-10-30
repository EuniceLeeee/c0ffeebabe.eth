import type { DeclarativeMathModel, MathValue } from "../../declarative-math.js";

const BONE = 10n ** 18n;
const MAX = (1n << 256n) - 1n;
function checked(value: bigint): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX) throw new Error("balancer-v1 uint256 overflow");
  return value;
}
// Source-exact BNum half-up arithmetic. Amount-out remains the pool's
// calcOutGivenIn view; this module only evaluates marginal prices and guards.
const mul = (a: bigint, b: bigint) => checked(checked(checked(a) * checked(b)) + BONE / 2n) / BONE;
function div(a: bigint, b: bigint): bigint {
  checked(a); checked(b);
  if (b === 0n) throw new Error("balancer-v1 division by zero");
  return checked(checked(a * BONE) + b / 2n) / b;
}
function spot([balanceIn, weightIn, balanceOut, weightOut, fee]: readonly bigint[]): bigint {
  return mul(div(div(balanceIn!, weightIn!), div(balanceOut!, weightOut!)), div(BONE, checked(BONE - fee!)));
}
function array(value: MathValue, size?: number): asserts value is readonly bigint[] {
  if (!Array.isArray(value) || (size !== undefined && value.length !== size) || value.length > 8)
    throw new Error("balancer-v1 invalid math input");
  value.forEach(item => checked(item as bigint));
}
const model = (id: string, size: number | undefined, evaluate: (input: readonly bigint[]) => bigint): DeclarativeMathModel => ({
  id, version: 1,
  validateInput(value) { array(value, size); },
  evaluate(value) { return evaluate(value as readonly bigint[]); },
  validateOutput(value) { checked(value as bigint); },
});
export const balancerV1MathModels: readonly DeclarativeMathModel[] = Object.freeze([
  model("balancer-v1:spot-price", 5, spot),
  model("balancer-v1:max-input", 1, values => mul(values[0]!, BONE / 2n)),
  model("balancer-v1:sum-weights", undefined, values => values.reduce((sum, weight) => checked(sum + weight), 0n)),
  model("balancer-v1:output-guard", 7, values => {
    const [balanceIn, weightIn, balanceOut, weightOut, fee, amountIn, amountOut] = values as readonly bigint[];
    if (balanceIn! === 0n || balanceOut! === 0n || amountIn! === 0n || amountIn! > mul(balanceIn!, BONE / 2n))
      throw new Error("balancer-v1 input outside MAX_IN_RATIO");
    if (amountOut! === 0n || amountOut! >= balanceOut!) throw new Error("balancer-v1 no spendable output");
    const before = spot([balanceIn!, weightIn!, balanceOut!, weightOut!, fee!]);
    const after = spot([checked(balanceIn! + amountIn!), weightIn!, checked(balanceOut! - amountOut!), weightOut!, fee!]);
    if (after < before || before > div(amountIn!, amountOut!)) throw new Error("balancer-v1 ERR_MATH_APPROX");
    return amountOut!;
  }),
]);
