// Match the pool's nominal payout to both calldata and the Swap event. The
// recipient's Transfer may report a different amount from that nominal payout.
function swapSettlement(call, output, poolLogs, incoming, cfg, uniqueOutput = false) {
  if (call.selector !== cfg.amountSwapSelector || call.input.length < 202) return;
  if (output.index === null || output.from !== call.target || output.amount <= 0n) return;

  const args = call.input.slice(10, 202).match(/.{64}/g);
  if (!/^0{24}[0-9a-f]{40}$/.test(args[2]) || '0x' + args[2].slice(24) !== output.to) return;
  const amounts = args.slice(0, 2).map(w => BigInt('0x' + w));
  const side = amounts[0] === output.amount ? 0 : 1;
  if (amounts[side] !== output.amount || amounts[1 - side] !== 0n) return;

  const swaps = poolLogs.filter(l => l.topics[0] === cfg.amountSwapTopic);
  const index = swaps.findIndex(l => l.idx > output.index);
  if (index < 0) return;
  const swap = swaps[index];
  const sender = '0x' + call.sender.slice(2).padStart(64, '0');
  const recipient = '0x' + args[2];
  const payoutWords = args[0] + args[1];
  function matchesPayout(l) {
    return l.topics.length === 3 && l.topics[1] === sender && l.topics[2] === recipient
      && /^0x[0-9a-f]{256}$/.test(l.data) && l.data.slice(130) === payoutWords;
  }
  if (!matchesPayout(swap)) return;
  if (uniqueOutput && swaps.some(l => l !== swap && matchesPayout(l))) return;

  const previous = index ? swaps[index - 1].idx : -1;
  const paid = incoming.filter(l => l.idx > previous && l.idx < swap.idx);
  if (paid.length !== 1 || paid[0].emitter === output.asset) return;
  const input = paid[0];
  const words = swap.data.slice(2, 130).match(/.{64}/g);
  if (BigInt('0x' + words[side]) !== 0n || BigInt('0x' + words[1 - side]) !== BigInt(input.data)) return;
  return {swap, input, previous};
}

// The output must already belong to this frame by trace path. When several
// calls could spend a prepayment, bind its receipt index to the pool's Swap.
export function matchSwapInput(call, assigned, poolLogs, incoming, cfg) {
  if (assigned.length !== 1) return;
  return swapSettlement(call, assigned[0], poolLogs, incoming, cfg);
}

export function ownsDiscrepantInput(call, input, mismatches, prepaidOwner) {
  const matches = mismatches.filter(m => m.log.idx === input.idx);
  if (matches.length !== 1) return false;
  const {node} = matches[0];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.target === call.target && parent.net) return parent === call;
  }
  return prepaidOwner(node, input.idx) === call;
}

export function matchSwapOutput(call, outputs, poolCalls, poolLogs, incoming, incomingLogs, cfg) {
  if (outputs.length !== 1) return;
  const output = outputs[0];
  const proof = swapSettlement(call, output, poolLogs, incoming, cfg, true);
  if (!proof) return;
  const payout = call.input.slice(0, 202);
  if (poolCalls.some(c => c !== call && c.sender === call.sender && c.input.slice(0, 202) === payout)) return;
  const fromTopic = '0x' + call.target.slice(2).padStart(64, '0');
  const received = incomingLogs.get(output.to).filter(l => l.topics[1] === fromTopic
    && l.idx > proof.previous && l.idx < proof.swap.idx);
  if (received.length !== 1 || received[0].idx !== output.index) return;
  return {...proof, output};
}
