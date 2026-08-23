import { assertCapabilityRef, asOwnerRef, asSchemaRef, type CapabilityRefV1 } from "../../../capability-contracts/src/index.ts";
import { assertHash, type Hash } from "../../../canonical-codec/src/index.ts";
import type { ProgramIssuerCapabilityV1 } from "../index.ts";
import { registerProgramIssuer, type ProgramPayloadCodecV1 } from "./issuer-state.ts";

export interface ProgramIssuerOwnerV1 {
  readonly capability: ProgramIssuerCapabilityV1;
  revoke(): void;
}

export function createProgramIssuerOwner(input: {
  readonly issuerRef: Hash;
  readonly capabilityRef: CapabilityRefV1;
  readonly authorityHash: Hash;
  readonly codec: ProgramPayloadCodecV1;
}): ProgramIssuerOwnerV1 {
  const issuerRef = asOwnerRef(input.issuerRef, "issuerRef");
  const capabilityRef = assertCapabilityRef(input.capabilityRef);
  const authorityHash = assertHash(input.authorityHash, "authorityHash");
  const schemaRef = asSchemaRef(input.codec.schemaRef, "codec.schemaRef");
  if (schemaRef !== capabilityRef.schemaHash) throw new TypeError("program codec schema does not match capability ref");
  if (typeof input.codec.decodeExact !== "function") throw new TypeError("program codec decoder is required");
  const capability = Object.freeze({ issuerRef, capabilityRef });
  const state = { issuerRef, capabilityRef, authorityHash, codec: Object.freeze({ schemaRef, decodeExact: input.codec.decodeExact }), active: true };
  registerProgramIssuer(capability, state);
  return Object.freeze({ capability, revoke: () => { state.active = false; } });
}
