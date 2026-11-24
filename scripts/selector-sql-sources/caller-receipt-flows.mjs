import {possibleReceiptOwners} from './receipt-call-owners.mjs';

// Attribute each endpoint to the nearest action made by that account. An
// ambiguous receipt blocks every candidate that might include that movement.
export function callerReceiptEdges(candidates, timeline, transfers, anchors, nativeMoves) {
  const accounts = new Map(candidates.map(call => [call, {net: new Map(), indices: [], claims:[], ambiguous: false}]));
  const actors = new Set(candidates.map(call => call.sender));

  function actionFor(node, actor) {
    for (let current = node; current; current = current.parent) {
      if (current.selector && current.sender === actor) return current;
    }
  }

  function record(owners, actor, asset, amount, index, valuePath) {
    if (!actors.has(actor)) return;
    const calls = new Set();
    for (const node of owners) calls.add(actionFor(node, actor));
    for (const call of calls) {
      const account = accounts.get(call);
      if (!account) continue;
      if (calls.size > 1) {
        account.ambiguous = true;
        continue;
      } else if(valuePath!==undefined) account.claims.push({asset,side:amount<0n?'in':'out',valuePath});
      account.net.set(asset, (account.net.get(asset) ?? 0n) + amount);
      if (index !== null) {
        account.indices.push(index);
        account.claims.push({asset,side:amount<0n?'in':'out',logIndex:index});
      }
    }
  }

  const anchored = anchors.size ? timeline.withBindings(anchors) : undefined;
  const placements = anchored ?? timeline.placements;
  for (const [log, move] of transfers) {
    if (!actors.has(move.from) && !actors.has(move.to)) continue;
    const placement = placements.get(log);
    if (!placement) continue;
    const anchor = anchored && anchors.get(log);
    const owners = anchor ? [anchor] : possibleReceiptOwners(placement);
    record(owners, move.from, move.asset, -move.amount, move.index);
    record(owners, move.to, move.asset, move.amount, move.index);
  }
  for (const move of nativeMoves) {
    record([move.node], move.from, move.asset, -move.amount, null, move.node.path);
    record([move.node], move.to, move.asset, move.amount, null, move.node.path);
  }

  const edges = [];
  for (const [call, {net, indices, claims, ambiguous}] of accounts) {
    if (ambiguous) continue;
    const paid = [...net].filter(([, amount]) => amount < 0n);
    const received = [...net].filter(([, amount]) => amount > 0n);
    if (paid.length !== 1 || received.length !== 1) continue;
    edges.push({
      selector: call.selector, poolAddress: call.target, poolId: null,
      tokenIn: paid[0][0], tokenOut: received[0][0], callPath: call.path,
      selectorTarget: call.target, innerSwapPath: null, evidence: 'caller-receipt-net-flow',
      amountPayerInRaw: String(-paid[0][1]), amountReceivedOutRaw: String(received[0][1]),
      settlementClaims:claims.filter(c=>c.side==='in'?c.asset===paid[0][0]:c.asset===received[0][0]),
      receiptIndices: indices.sort((a, b) => a - b).join(',')
    });
  }
  return edges;
}
