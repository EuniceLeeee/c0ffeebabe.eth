// Fluid credit: use the shared ordered-child-accounting proof, not a local copy.
export function discover(n, c, ctx) {
  return ctx.indexed(n, c);
}
