import { assertExactKeys, hashDomain, type Hash } from "../../../canonical-codec/src/index.ts";
import type {
  ProcessResourceScopeCapabilityV1,
  ProcessResourceScopeFactV1,
  ProcessResourceScopeReaderPortV1,
} from "../contracts.ts";

interface ScopeOwnerState {
  readonly processLogAnchorHash: Hash;
  readonly windowId: Hash;
  readonly generationId: string;
  readonly issuedAdmissionIds: Set<Hash>;
  readonly readerPort: ProcessResourceScopeReaderPortV1;
}

const owners = new WeakMap<object, ScopeOwnerState>();
const readerOwners = new WeakMap<object, object>();
const scopes = new WeakMap<object, Readonly<{ owner: object; fact: ProcessResourceScopeFactV1 }>>();
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const ZERO_HASH = `0x${"0".repeat(64)}`;

function exactHash(value: unknown, path: string): Hash {
  if (typeof value !== "string" || !HASH_PATTERN.test(value) || value === ZERO_HASH) {
    throw new TypeError(`${path} must be a non-zero lowercase hash`);
  }
  return value as Hash;
}

function exactNonEmpty(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${path} must be non-empty`);
  return value;
}

export interface ProcessResourceScopeOwnerV1 {
  readonly scopeReaderPort: ProcessResourceScopeReaderPortV1;
  issueHeadScope(input: { readonly admissionId: Hash; readonly ordinal: string }): ProcessResourceScopeCapabilityV1;
}

/** Internal producer/evidence-owner seam. It is deliberately not re-exported by the package root. */
export function createProcessResourceScopeOwner(input: {
  readonly processLogAnchorHash: Hash;
  readonly windowId: Hash;
  readonly generationId: string;
}): ProcessResourceScopeOwnerV1 {
  assertExactKeys(input, ["processLogAnchorHash", "windowId", "generationId"], "processResourceScopeOwner");
  const processLogAnchorHash = exactHash(input.processLogAnchorHash, "processResourceScopeOwner.processLogAnchorHash");
  const windowId = exactHash(input.windowId, "processResourceScopeOwner.windowId");
  const generationId = exactNonEmpty(input.generationId, "processResourceScopeOwner.generationId");
  const owner = Object.create(null) as ProcessResourceScopeOwnerV1;
  const readerPort = Object.freeze(Object.create(null)) as ProcessResourceScopeReaderPortV1;
  const state: ScopeOwnerState = { processLogAnchorHash, windowId, generationId, issuedAdmissionIds: new Set(), readerPort };
  Object.defineProperties(owner, {
    scopeReaderPort: { value: readerPort, enumerable: true },
    issueHeadScope: {
      value: (headInput: { readonly admissionId: Hash; readonly ordinal: string }): ProcessResourceScopeCapabilityV1 => {
        assertExactKeys(headInput, ["admissionId", "ordinal"], "processResourceHeadScope");
        const admissionId = exactHash(headInput.admissionId, "processResourceHeadScope.admissionId");
        const ordinal = exactNonEmpty(headInput.ordinal, "processResourceHeadScope.ordinal");
        const ordinalValue = BigInt(ordinal);
        if (ordinalValue < 1n || ordinalValue > 100n || ordinalValue.toString() !== ordinal) {
          throw new TypeError("processResourceHeadScope.ordinal must be canonical and inside 1..100");
        }
        if (state.issuedAdmissionIds.has(admissionId)) throw new TypeError("process resource scope is already issued for this admission");
        const body = Object.freeze({
          schemaVersion: 1 as const,
          kind: "aloha.process-resource-scope" as const,
          processLogAnchorHash,
          windowId,
          generationId,
          admissionId,
          ordinal,
        });
        const fact = Object.freeze({ ...body, scopeId: hashDomain("aloha/process-resource-scope/v1", body) });
        const capability = Object.freeze(Object.create(null)) as ProcessResourceScopeCapabilityV1;
        scopes.set(capability, Object.freeze({ owner, fact }));
        state.issuedAdmissionIds.add(admissionId);
        return capability;
      },
      enumerable: true,
    },
  });
  Object.freeze(owner);
  owners.set(owner, state);
  readerOwners.set(readerPort, owner);
  return owner;
}

export function readProcessResourceScope(
  readerPort: ProcessResourceScopeReaderPortV1,
  capability: ProcessResourceScopeCapabilityV1,
): ProcessResourceScopeFactV1 {
  if (readerPort === null || typeof readerPort !== "object") throw new TypeError("process resource scope reader is invalid");
  const owner = readerOwners.get(readerPort);
  if (owner === undefined) throw new TypeError("process resource scope reader is not owner-issued");
  if (capability === null || typeof capability !== "object") throw new TypeError("process resource scope capability is invalid");
  const state = scopes.get(capability);
  if (state === undefined) throw new TypeError("process resource scope capability is not owner-issued");
  if (state.owner !== owner) throw new TypeError("process resource scope belongs to another owner");
  return state.fact;
}
