import { AbiCoder, hexlify, id } from "ethers";

// Infrastructure entrypoint, not a protocol ABI. Execution remains inside the
// centrally trusted BotVM; a Family supplies only its ordinary VM script.
const SELECTOR = id("execSubscript(bytes)").slice(0, 10);
const ABI = AbiCoder.defaultAbiCoder();

export function buildSubscriptCalldata(script: Uint8Array): string {
  if (script.length === 0) throw new Error("executor program is empty");
  return SELECTOR + ABI.encode(["bytes"], [hexlify(script)]).slice(2);
}

export function assertSubscriptCalldata(data: string): void {
  try {
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(data) || data.slice(0, 10).toLowerCase() !== SELECTOR) throw 0;
    const [script] = ABI.decode(["bytes"], `0x${data.slice(10)}`);
    if (script === "0x" || SELECTOR + ABI.encode(["bytes"], [script]).slice(2) !== data.toLowerCase()) throw 0;
  } catch {
    throw new Error("invalid executor program entry");
  }
}
