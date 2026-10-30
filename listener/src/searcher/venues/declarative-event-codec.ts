import { Interface, getAddress } from "ethers";
type Data = Record<string, any>;
export interface DeclarativeEventLog { address: string; topics: readonly string[]; data: string }
function keys(value: any, required: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== required.length ||
      required.some(key => !Object.hasOwn(value, key))) throw new Error("invalid event codec declaration");
}
/** Canonical ABI events or a bounded, singleton-owned packed anonymous layout.
 * Decoding alone never admits an instance; the observer must bind it to Ready. */
export function compileDeclarativeEventCodec(spec: Data) {
  if ((spec.signature === undefined) === (spec.packed === undefined)) throw new Error("event requires one ABI or packed layout");
  if (spec.signature !== undefined) {
    const abi = new Interface([spec.signature]);
    if (abi.fragments.length !== 1 || abi.fragments[0].type !== "event") throw new Error("Swap observation requires one event ABI");
    const event = abi.getEvent(abi.fragments[0].format("sighash"))!;
    if (event.anonymous) throw new Error("anonymous event requires a bounded packed layout");
    return {
      topic: event.topicHash, anonymous: undefined,
      matches: (log: DeclarativeEventLog) => log.topics[0]?.toLowerCase() === event.topicHash.toLowerCase(),
      decode(log: DeclarativeEventLog): Data {
        const args = abi.decodeEventLog(event, log.data, log.topics);
        const encoded = abi.encodeEventLog(event, args);
        if (encoded.data.toLowerCase() !== log.data.toLowerCase() || encoded.topics.length !== log.topics.length ||
            encoded.topics.some((topic, i) => topic.toLowerCase() !== log.topics[i].toLowerCase())) throw new Error("noncanonical event data");
        return Object.fromEntries(event.inputs.map((field, i) => [field.name || String(i), args[i]]));
      },
    };
  }
  const p = spec.packed;
  keys(p, ["address", "dataLengthBytes", "identityOffsetBytes", "fields"]);
  const address = getAddress(p.address);
  if (!Number.isSafeInteger(p.dataLengthBytes) || p.dataLengthBytes < 32 || p.dataLengthBytes > 4096 ||
      !Number.isSafeInteger(p.identityOffsetBytes) || p.identityOffsetBytes < 0 || p.identityOffsetBytes + 32 > p.dataLengthBytes ||
      !Array.isArray(p.fields) || !p.fields.length || p.fields.length > 128) throw new Error("invalid bounded anonymous event");
  const used = new Set<number>(), names = new Set<string>();
  for (const field of p.fields) {
    keys(field, ["name", "offsetBytes", "lengthBytes", "encoding"]);
    if (typeof field.name !== "string" || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(field.name) ||
        ["constructor", "prototype", "__proto__"].includes(field.name) || names.has(field.name) ||
        !Number.isSafeInteger(field.offsetBytes) || field.offsetBytes < 0 || !Number.isSafeInteger(field.lengthBytes) ||
        field.lengthBytes < 1 || field.lengthBytes > 32 || field.offsetBytes + field.lengthBytes > p.dataLengthBytes ||
        !["int", "uint", "address", "bytes"].includes(field.encoding) || field.encoding === "address" && field.lengthBytes !== 20)
      throw new Error("invalid packed event field");
    names.add(field.name);
    for (let i = field.offsetBytes; i < field.offsetBytes + field.lengthBytes; i++) {
      if (used.has(i)) throw new Error("overlapping packed event fields"); used.add(i);
    }
  }
  if (used.size !== p.dataLengthBytes) throw new Error("packed event must account for every byte");
  const matches = (log: DeclarativeEventLog) => log.address.toLowerCase() === address.toLowerCase() && log.topics.length === 0 &&
    /^0x(?:[a-fA-F0-9]{2})*$/.test(log.data) && (log.data.length - 2) / 2 === p.dataLengthBytes;
  return {
    topic: undefined,
    anonymous: { address, dataLengthBytes: p.dataLengthBytes, identityOffsetBytes: p.identityOffsetBytes },
    matches,
    decode(log: DeclarativeEventLog): Data {
      if (!matches(log)) throw new Error("anonymous event boundary mismatch");
      return Object.fromEntries(p.fields.map((f: Data) => {
        const hex = `0x${log.data.slice(2 + f.offsetBytes * 2, 2 + (f.offsetBytes + f.lengthBytes) * 2)}`;
        let value: string | bigint = f.encoding === "address" ? getAddress(hex) : f.encoding === "bytes" ? hex.toLowerCase() : BigInt(hex);
        if (f.encoding === "int" && BigInt(value) >= 1n << BigInt(8 * f.lengthBytes - 1)) value = BigInt(value) - (1n << BigInt(8 * f.lengthBytes));
        return [f.name, value];
      }));
    },
  };
}
