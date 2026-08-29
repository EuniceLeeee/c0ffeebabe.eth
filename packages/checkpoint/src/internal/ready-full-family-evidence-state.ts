const issuedReaders = new WeakSet<object>();

export function registerReadyFullFamilyEvidenceReader(reader: object): void {
  issuedReaders.add(reader);
}

export function isReadyFullFamilyEvidenceReader(value: object): boolean {
  return issuedReaders.has(value);
}
