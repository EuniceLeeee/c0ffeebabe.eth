// PSM sellGem: use the shared ordered-child-transfer proof, not a local copy.
export function discover(n, c, ctx) {
  return ctx.transfers(n, c);
}
