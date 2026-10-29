import { getAddress, isHexString } from "ethers";
import { compileDeclarativeReadFlow, type DeclarativeReadFlow, type ReadFlowValues } from "./declarative-read-flow.js";
import type { AdapterRequest, AdapterRequestResult, RequestRequirements } from "./adapter-request-program.js";
import type { NominationOpaqueInput } from "./address-surface-nomination.js";
import { hashCanonical, type CanonicalValue } from "./canonical-value.js";

/** Bridge the existing read-flow declaration to the existing nomination
 * provider. It neither schedules identity work nor issues admission evidence.
 * Provider failures propagate unchanged to nomination's per-item unresolved
 * boundary; a failed request is never relabelled as a successful/reverted read. */
export function compileDeclarativeNominationReadFlow(definition: DeclarativeReadFlow, values: ReadFlowValues) {
  const flow = compileDeclarativeReadFlow(definition, values);
  return async function resolveOpaque({ nomination, source, provider }: NominationOpaqueInput): Promise<CanonicalValue | null> {
    const pinnedSource = Object.freeze({ ...source });
    const input = { nomination, source: pinnedSource, address: getAddress(nomination.address) };
    async function read(requirements: RequestRequirements, requests: readonly AdapterRequest[]): Promise<readonly AdapterRequestResult[]> {
      if (!Array.isArray(requirements.transports) || requirements.transports.some(kind =>
          !["eth-call", "get-code", "get-storage"].includes(kind)) ||
          requirements.caller !== undefined && requirements.caller !== "none" || requirements.effects?.length ||
          requirements.completions?.some(value => value !== "return-data"))
        throw new Error("nomination read flow only supports ordinary source-bound reads");
      // Validate the complete round before invoking its provider; a later
      // unsupported request must not partially run the declared round.
      for (const request of requests) {
        const allowed = request.kind === "eth-call" ? ["id", "kind", "required", "to", "data", "completion", "caller"]
          : request.kind === "get-code" ? ["id", "kind", "required", "address"]
          : request.kind === "get-storage" ? ["id", "kind", "required", "address", "slot"] : [];
        if (!allowed.length || Object.keys(request).some(key => !allowed.includes(key)) ||
            !requirements.transports.includes(request.kind) || request.required !== undefined && typeof request.required !== "boolean")
          throw new Error("unsupported nomination read request");
        if (request.kind === "eth-call") {
          getAddress(request.to);
          if (!isHexString(request.data, true) || request.completion !== "return-data" ||
              request.caller !== undefined && (request.caller.kind !== "none" || Object.keys(request.caller).length !== 1))
            throw new Error("unsupported nomination call authority");
        } else if (request.kind === "get-code" || request.kind === "get-storage") {
          getAddress(request.address);
          if (request.kind === "get-storage" && !isHexString(request.slot, 32)) throw new Error("invalid nomination storage slot");
        }
      }
      return Promise.all(requests.map(async request => {
        const data = request.kind === "eth-call" ? await provider.call({ to: getAddress(request.to), data: request.data }, pinnedSource.number)
          : request.kind === "get-code" ? await provider.getCode(getAddress(request.address), pinnedSource.number)
          : request.kind === "get-storage" ? await provider.getStorage(getAddress(request.address), request.slot, pinnedSource.number)
          : (() => { throw new Error("unsupported nomination read request"); })();
        if (!isHexString(data, true)) throw new Error("invalid nomination provider data");
        return Object.freeze({ id: request.id, ok: true as const, source: pinnedSource, completion: "returned" as const, data,
          // This local correlation is deliberately distinct from issuer-owned
          // identity/quote transport attestations and never leaves this flow.
          provenance: { kind: "nomination-provider-read", fingerprint: hashCanonical({ source: pinnedSource, request } as unknown as CanonicalValue) } });
      }));
    }
    const first = flow.start(input);
    const initialResults = await read(first.requirements, first.requests);
    first.decode(initialResults);
    const priorEvidence: unknown[] = [];
    for (;;) {
      const next = flow.program.buildDependentProgram!({ programInput: input, completedRound: priorEvidence.length, initialResults, priorEvidence });
      if (!next) break;
      priorEvidence.push(next.decode(await read(next.requirements, next.requests)));
    }
    const output = flow.program.decode({ programInput: input, initialResults, dependentEvidence: priorEvidence });
    if (output === null) return null;
    if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("nomination read flow must return opaque data or null");
    hashCanonical(output as CanonicalValue);
    return output as CanonicalValue;
  };
}
