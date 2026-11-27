// DOLA/Curve exchange_received: shared prepaid-exchange proof.
export function discover(n, c, ctx) {
  return ctx.prepaidExchange(n, c);
}
