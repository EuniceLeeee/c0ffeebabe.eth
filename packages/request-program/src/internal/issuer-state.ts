import type { CapabilityRefV1, OwnerRef, SchemaRef } from "../../../capability-contracts/src/index.ts";
import type { Hash } from "../../../canonical-codec/src/index.ts";

export interface ProgramPayloadCodecV1 {
  readonly schemaRef: SchemaRef;
  readonly decodeExact: (value: unknown) => unknown;
}

export interface ProgramIssuerStateV1 {
  readonly issuerRef: OwnerRef;
  readonly capabilityRef: CapabilityRefV1;
  readonly authorityHash: Hash;
  readonly codec: ProgramPayloadCodecV1;
  active: boolean;
}

const ISSUERS = new WeakMap<object, ProgramIssuerStateV1>();

export function registerProgramIssuer(token: object, state: ProgramIssuerStateV1): void {
  if (ISSUERS.has(token)) throw new TypeError("program issuer token already registered");
  ISSUERS.set(token, state);
}

export function requireProgramIssuer(token: object): ProgramIssuerStateV1 {
  const state = ISSUERS.get(token);
  if (state === undefined) throw new TypeError("program issuer capability was not issued");
  if (!state.active) throw new TypeError("program issuer capability is revoked");
  return state;
}
