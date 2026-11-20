import assert from 'node:assert/strict';

// ERC-4626 shares deliberately reuse events: the root selector is indispensable.
export const vaultRootSelectors = Object.freeze(['0x6e553f65', '0x94bf804d', '0xb460af94', '0xba087652']);

function directions(tx, rules) {
  const lower = s => typeof s === 'string' ? s.toLowerCase() : '';
  const address = s => /^0x[0-9a-f]{40}$/.test(s);
  const hash = s => /^0x[0-9a-f]{64}$/.test(s);
  const zero = '0x' + '0'.repeat(40), zeroWord = '0'.repeat(64);
  const addressWord = w => typeof w === 'string' && /^0{24}[0-9a-f]{40}$/.test(w) ? '0x' + w.slice(24) : null;
  const safeNumber = n => Number.isSafeInteger(n) && n >= 0;
  if (!tx || ![1, '1'].includes(tx.receipt_status) || ![0, '0', '0x0'].includes(tx.value) ||
      !safeNumber(tx.block_number) || tx.block_number === 0 || !safeNumber(tx.transaction_index) ||
      !hash(lower(tx.block_hash)) || !hash(lower(tx.tx_hash)) || !Array.isArray(tx.logs) ||
      tx.logs.length < 3 || tx.logs.length > 4096) return [];
  const target = lower(tx.to_address), caller = lower(tx.from_address), input = lower(tx.input);
  if (!address(target) || !address(caller) || [target, caller].includes(zero) || caller === target ||
      !/^0x(?:[0-9a-f]{2})+$/.test(input)) return [];
  const method = input.slice(0, 10);
  const spec = {
    '0x6e553f65': ['deposit(uint256,address)', true, 0],
    '0x94bf804d': ['mint(uint256,address)', true, 1],
    '0xb460af94': ['withdraw(uint256,address,address)', false, 0],
    '0xba087652': ['redeem(uint256,address,address)', false, 1],
  }[method];
  if (!spec) return [];
  const [sig, incoming, amountWord] = spec, head = 10 + (incoming ? 2 : 3) * 64;
  // Some real root calls attach application attribution bytes. They have no
  // role in the proof; never scan or decode a selector/amount from this tail.
  if (input.length < head || input.length > head + 2 * 256) return [];
  const arg = n => input.slice(10 + 64 * n, 10 + 64 * (n + 1));
  const quantity = arg(0), receiver = addressWord(arg(1)), owner = incoming ? receiver : addressWord(arg(2));
  if (quantity === zeroWord || !receiver || receiver === zero || !owner || owner === zero) return [];
  const families = new Set();
  for (const r of rules) {
    if (typeof r.familyId !== 'string' || !r.familyId.startsWith('execution:' + method + ':abi-') ||
        !/^[0-9a-f]{64}$/.test(r.familyId.slice(('execution:' + method + ':abi-').length))) continue;
    if (r.callPatterns.some(p => lower(p.selector) === method &&
        typeof p.signature === 'string' && p.signature.replace(/^function\s+/, '').replace(/\s/g, '') === sig)) families.add(r.familyId);
  }
  if (families.size !== 1) return [];
  const deposit = '0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7';
  const withdraw = '0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db';
  const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const seen = new Set(), moves = [];
  let event;
  for (const log of tx.logs) {
    if (!log || !safeNumber(log.log_index) || seen.has(log.log_index) || !address(lower(log.log_address)) ||
        !Array.isArray(log.topics) || log.topics.length > 4 || !log.topics.every(t => hash(lower(t))) ||
        log.removed === true) return [];
    seen.add(log.log_index);
    const emitter = lower(log.log_address), [t0, ...args] = log.topics.map(lower);
    const data = lower(log.data);
    if (emitter === target && (t0 === deposit || t0 === withdraw)) {
      // An event on a second vault in the same transaction does not establish
      // this vault's conversion. Multiple events on this vault are ambiguous.
      if (event || t0 !== (incoming ? deposit : withdraw) || args.length !== (incoming ? 2 : 3) ||
          !/^0x[0-9a-f]{128}$/.test(data)) return [];
      const roles = args.map(t => addressWord(t.slice(2)));
      if (roles[0] !== caller || roles[1] !== receiver || (!incoming && roles[2] !== owner)) return [];
      const assets = data.slice(2, 66), shares = data.slice(66);
      if (assets === zeroWord || shares === zeroWord || [assets, shares][amountWord] !== quantity) return [];
      event = {assets, shares, i:log.log_index};
    } else if (t0 === transfer && args.length === 2 && /^0x[0-9a-f]{64}$/.test(data)) {
      const from = addressWord(args[0].slice(2)), to = addressWord(args[1].slice(2));
      if (emitter !== zero && from && to && from !== to && data.slice(2) !== zeroWord)
        moves.push({emitter, from, to, amount:data.slice(2), i:log.log_index});
    }
  }
  if (!event) return [];
  const shares = moves.filter(m => m.emitter === target && m.amount === event.shares &&
    (incoming ? m.from === zero && m.to === receiver : m.from === owner && m.to === zero));
  const assets = moves.filter(m => m.emitter !== target && m.amount === event.assets &&
    (incoming ? m.from === caller && m.to === target : m.from === target && m.to === receiver));
  if (shares.length !== 1 || assets.length !== 1) return [];
  const share = shares[0], asset = assets[0];
  if (!(incoming ? asset.i < share.i && share.i < event.i : share.i < asset.i && asset.i < event.i)) return [];
  const tokenIn = incoming ? asset.emitter : target, tokenOut = incoming ? target : asset.emitter;
  return [{observationId:['vault-root', '1', method, target, tokenIn, tokenOut].join(':'),
    familyId:[...families][0], programKey:null, selector:method, chainId:1, target, tokenIn, tokenOut,
    immutableParameters:null}];
}

export function renderVaultRootUdf(options) {
  assert.equal(arguments.length, 1);
  const resource = '"gs:\\/\\/[a-z0-9_.-]+\\/mev-discovery-json-check\\/[0-9a-f]{64}\\/[a-z0-9-]+\\.js"';
  assert(typeof options === 'string' && new RegExp('^OPTIONS \\(library = \\[' + resource + '(?:, ' + resource + ')*\\]\\)$').test(options),
    'Expected the pinned discovery library options');
  return `CREATE TEMP FUNCTION vaultRootDirections(tx STRING)
RETURNS STRING LANGUAGE js ${options}
AS r'''if (typeof tx !== 'string' || tx.length > 4194304) return '[]';
${directions.toString()}
return JSON.stringify(directions(JSON.parse(tx), DiscoveryKernel.rules()));''';`;
}
