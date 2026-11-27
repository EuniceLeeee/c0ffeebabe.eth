// PSM buyGem: ordered DAI transferFrom + gem transfer + BuyGem event proof.
const addr = /^0x[0-9a-f]{40}$/;
const word = /^0x[0-9a-f]{64}$/;
const zero = "0x" + "0".repeat(40);
const address = w => word.test(w) && /^0x0{24}/.test(w) ? "0x" + w.slice(-40) : null;
function at(hex, index, offset) {
  const start = offset + 64 * index, s = hex?.slice(start, start + 64);
  return s?.length === 64 && /^[0-9a-f]+$/.test(s) ? "0x" + s : null;
}
const arg = (n, k) => k === "sender" && addr.test(n.sender)
  ? "0x" + "0".repeat(24) + n.sender.slice(2)
  : typeof k === "string" && /^arg\d+$/.test(k) ? at(n.input, Number(k.slice(3)), 10) : null;
const field = (l, k) => /^topic\d+$/.test(k) ? l.topics[Number(k.slice(5))]
  : /^data\d+$/.test(k) ? at(l.data, Number(k.slice(4)), 2) : null;
const positive = w => word.test(w) && BigInt(w) > 0n;
const matchEvent = (c, l, n) => l.emitter === n.target && l.topics[0] === c.eventTopic0 &&
  l.topics.length === c.topicCount && l.data?.length === 2 + 64 * c.dataWords &&
  Object.entries(c.bind).every(([lf, cf]) => {
    const a = arg(n, cf), b = field(l, lf);
    return !!a && a === b;
  });
const matchTransfer = (c, x, l) => {
  if (x.kind !== "call" || (x.selector !== c.inputSelector && x.selector !== c.outputSelector)) return;
  const delegated = x.selector === c.inputSelector;
  const from = delegated ? address(arg(x, "arg0")) : x.sender;
  const to = address(arg(x, delegated ? "arg1" : "arg0"));
  const amount = arg(x, delegated ? "arg2" : "arg1");
  return !!from && !!to && from !== zero && to !== zero && from !== to && positive(amount) &&
    l.emitter === x.target && l.topics.length === 3 && l.topics[0] === c.transferTopic &&
    address(l.topics[1]) === from && address(l.topics[2]) === to && l.data === amount;
};
function orderedBuyEvents(c, ctx, target, selector) {
  const calls = ctx.nodes.filter(x => x.valid && x.kind === "call" && x.target === target && x.selector === selector);
  const records = (ctx.byTopic.get(c.eventTopic0) ?? []).filter(l => l.emitter === target);
  if (calls.length !== records.length) return;
  const ops = new Set(calls), bindings = new Map();
  for (let i = 0; i < calls.length; i++) {
    const op = calls[i], l = records[i], owners = ctx.owners.get(l);
    for (let p = op.parent; p; p = p.parent) if (ops.has(p)) return;
    if (!owners?.has(op) || !matchEvent(c, l, op) || Array.from(owners).some(o => !ops.has(o))) return;
    bindings.set(l, op);
  }
  if (ctx.model.canPlace(bindings)) return new Map(Array.from(bindings, ([l, op]) => [op, l]));
}
function orderedTokenRecords(c, ctx, target) {
  const a = c.allowance;
  if (!a) return;
  const records = [...(ctx.byTopic.get(c.transferTopic) ?? []), ...(ctx.byTopic.get(a.eventTopic0) ?? [])]
    .filter(l => l.emitter === target).sort((x, y) => x.idx - y.idx);
  const calls = ctx.nodes.filter(n => n.valid && n.kind === "call" && n.target === target &&
    (n.selector === a.callSelector || n.selector === c.inputSelector || n.selector === c.outputSelector));
  if (records.length !== calls.length) return;
  const known = new Set(calls), bindings = new Map();
  for (let j = 0; j < calls.length; j++) {
    const n = calls[j], l = records[j], owners = ctx.owners.get(l);
    if (!owners?.has(n) || Array.from(owners).some(o => !known.has(o))) return;
    for (let p = n.parent; p; p = p.parent) if (known.has(p)) return;
    if (n.selector === a.callSelector ? !matchEvent(a, l, n) : !matchTransfer(c, n, l)) return;
    bindings.set(l, n);
  }
  if (ctx.model.canPlace(bindings)) return new Map(Array.from(bindings, ([l, n]) => [n, l]));
}

export function discover(n, c, ctx) {
  const cs = n.children.filter(x => x.kind === "call" && (x.selector === c.inputSelector || x.selector === c.outputSelector));
  if (cs.length !== 2) return;
  const [i, o] = cs;
  const recipientWord = arg(n, c.recipient), recipient = address(recipientWord), gemOut = arg(n, c.amountOut), daiIn = arg(i, "arg2");
  const outTo = o.selector === c.outputSelector ? arg(o, "arg0") : o.selector === c.inputSelector ? arg(o, "arg1") : null;
  const outAmt = o.selector === c.outputSelector ? arg(o, "arg1") : o.selector === c.inputSelector ? arg(o, "arg2") : null;
  const pocketFrom = o.selector === c.inputSelector ? address(arg(o, "arg0")) : null;
  const outFromOk = o.selector === c.outputSelector || (o.selector === c.inputSelector && !!pocketFrom && pocketFrom !== zero && pocketFrom !== recipient);
  if (i.selector !== c.inputSelector || !outFromOk ||
    i.sender !== n.target || o.sender !== n.target || i.target === o.target ||
    address(arg(i, "arg0")) !== n.sender || !positive(daiIn) ||
    !recipient || recipient === zero || outTo !== recipientWord ||
    !positive(gemOut) || outAmt !== gemOut) return;
  const proof = ctx.uniqueLog(n, c.eventTopic0, (x, l) => x.kind === "call" && x.selector === n.selector ? matchEvent(c, l, x) : undefined) ??
    orderedBuyEvents(c, ctx, n.target, n.selector)?.get(n);
  const pick = x => ctx.uniqueLog(x, c.transferTopic, (f, l) => matchTransfer(c, f, l)) ?? orderedTokenRecords(c, ctx, x.target)?.get(x);
  const src = pick(i), dst = pick(o);
  if (!proof || !src || !dst || !(src.idx < dst.idx && dst.idx < proof.idx)) return;
  if (!ctx.model.canPlace(new Map([[src, i], [dst, o], [proof, n]]))) return;
  if (!addr.test(src.emitter) || !addr.test(dst.emitter) || src.emitter === dst.emitter || src.emitter === zero || dst.emitter === zero) return;
  const amountIn = String(BigInt(src.data)), amountOut = String(BigInt(dst.data));
  return {
    selector: n.selector,
    callPath: n.path,
    selectorTarget: n.target,
    poolAddress: n.target,
    poolId: null,
    tokenIn: src.emitter,
    tokenOut: dst.emitter,
    innerSwapPath: null,
    receiptIndices: [src.idx, dst.idx, proof.idx].join(","),
    receiptRoles: ["in", "out", "event"],
    evidence: "family-ordered-child-transfers",
    amountVenueInRaw: amountIn,
    amountPayerInRaw: amountIn,
    amountPoolOutRaw: amountOut,
    amountReceivedOutRaw: amountOut,
  };
}
