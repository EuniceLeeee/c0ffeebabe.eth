const issuedReaders = new WeakSet<object>();

export function registerReadyStage12EvidenceReader(reader: object): void {
  issuedReaders.add(reader);
}

export function isReadyStage12EvidenceReader(value: object): boolean {
  return issuedReaders.has(value);
}
