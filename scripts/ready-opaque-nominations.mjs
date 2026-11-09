// Shared by the streaming importer and the query-side kernel. These are
// nomination witnesses only; Ready must still reverse-bind and verify identity.
export function createOpaqueNominationCollector(catalog) {
  const patterns = new Map();
  for (const { plugin } of catalog.listAll()) {
    if (plugin.discovery?.reverseBinding?.kind !== 'implementation') continue;
    for (const pattern of plugin.discovery.logPatterns ?? []) {
      if (pattern.emitter?.mode === 'singleton-indexed-bytes32')
        patterns.set(JSON.stringify([plugin.manifest.familyId, pattern.id]), pattern.emitter);
    }
  }
  return log => {
    if (log.kind === 'call') return [];
    const observation = { ...log, kind: 'log', source: {
      number: log.blockNumber, hash: log.blockHash, generation: log.blockNumber,
    } };
    return catalog.matches(observation).flatMap(match => {
      const emitter = patterns.get(JSON.stringify([match.familyId, match.patternId]));
      if (!emitter || log.address.toLowerCase() !== emitter.address.toLowerCase() ||
          log.blockNumber < emitter.fromBlock) return [];
      const poolId = log.topics[emitter.topicIndex];
      if (!/^0x[0-9a-f]{64}$/i.test(poolId)) return [];
      return [{ family: match.familyId,
        key: [match.familyId, log.address.toLowerCase(), poolId.toLowerCase()].join('|'),
        log }];
    });
  };
}
