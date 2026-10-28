import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { address, call, code, CONTROLLER, decode, members, MODULE, MODULE_CODE_HASH, rows, SET, SET_CODE_HASH, TOKEN } from "./codec.js";
import { FAMILY, LINEAGE } from "./manifest.js";
import { legacyIdentity } from "./legacy.js";
import { binding } from "./instance.js";
import type { Binding, Candidate, Identity } from "./types.js";
interface Proof { phase: "code" | "binding" | "complete"; source: CanonicalSource; binding?: Binding; rejection?: string; unavailable?: string; ids: readonly string[] }
const bindingRequests = (c: Candidate) => [call("set-controller", c.set, SET.encodeFunctionData("controller")), call("module-controller", c.module, MODULE.encodeFunctionData("controller")),
  ...["getComponents", "getModules", "isLocked"].map(k => call(k, c.set, SET.encodeFunctionData(k))), call("module-state", c.set, SET.encodeFunctionData("moduleStates", [c.module]))];
function identityRequests(c: Candidate, p?: Proof) {
  if (!p) return [code("set-code", c.set), code("module-code", c.module)];
  if (p.phase === "code") return [...bindingRequests(c), code("set-code", c.set)];
  if (p.phase !== "binding" || !p.binding) return [];
  const d = p.binding;
  return [code("controller-code", d.controller), call("registered-set", d.controller, CONTROLLER.encodeFunctionData("isSet", [d.set])),
    call("registered-module", d.controller, CONTROLLER.encodeFunctionData("isModule", [d.module])), ...d.components.flatMap((t, i) => [
      code(`component-code-${i}`, t), call(`external-${i}`, d.set, SET.encodeFunctionData("getExternalPositionModules", [t])), call(`decimals-${i}`, t, TOKEN.encodeFunctionData("decimals"))])];
}
export const identity = {
  memoReuse: "recheck-identity", identityKey: i => `${i.binding.set}:${i.binding.module}`,
  variants: [{ id: "basic-issuance-runtime-and-reciprocal-registration", kind: "standalone-contract", lineageId: LINEAGE,
    applies: c => c.candidateKind === "set-redemption" && !c.legacyCore,
    requirements: ({ evidence }) => ({ transports: evidence ? ["get-code", "eth-call"] : ["get-code"] }),
    buildRequests: ({ candidate, evidence }) => identityRequests(candidate, evidence as Proof | undefined),
    decode({ step, results }): Proof {
      const p = step.evidence as Proof | undefined, c = step.candidate;
      const ids = identityRequests(c, p).map(r => r.id), r = rows(results, ids, p?.source);
      if (!p) return { phase: "code", source: r.source, ids,
        ...(ethers.keccak256(r.get("set-code")) === SET_CODE_HASH && ethers.keccak256(r.get("module-code")) === MODULE_CODE_HASH
          ? {} : { rejection: "unsupported-set-or-basic-issuance-runtime" }) };
      if (p.phase === "code") {
        if (ethers.keccak256(r.get("set-code")) !== SET_CODE_HASH) throw new Error("set-redemption runtime changed during identity");
        const controller = address(decode(SET, "controller", r.get("set-controller"))[0]);
        if (controller !== address(decode(MODULE, "controller", r.get("module-controller"))[0])) return { ...p, ids, rejection: "set-module-controller-mismatch" };
        const components = members(decode(SET, "getComponents", r.get("getComponents"))[0], [address(c.set), address(c.module), controller]);
        const modules = decode(SET, "getModules", r.get("getModules"))[0].map(address);
        const eligible = decode(SET, "moduleStates", r.get("module-state"))[0] === 2n && modules.includes(address(c.module)) && !decode(SET, "isLocked", r.get("isLocked"))[0];
        return { phase: "binding", source: r.source, ids, binding: { set: address(c.set), module: address(c.module), controller, components, controllerCodeHash: "" },
          ...(eligible ? {} : { unavailable: "set-module-not-initialized-or-locked" }) };
      }
      if (p.phase !== "binding" || !p.binding) throw new Error("set-redemption invalid identity phase");
      if (r.get("controller-code") === "0x" || p.binding.components.some((_, i) => r.get(`component-code-${i}`) === "0x" || decode(TOKEN, "decimals", r.get(`decimals-${i}`))[0] > 77n))
        throw new Error("set-redemption controller/component code or decimals unavailable");
      const eligible = decode(CONTROLLER, "isSet", r.get("registered-set"))[0] && decode(CONTROLLER, "isModule", r.get("registered-module"))[0] &&
        p.binding.components.every((_, i) => decode(SET, "getExternalPositionModules", r.get(`external-${i}`))[0].length === 0);
      return { ...p, phase: "complete", ids, binding: { ...p.binding, controllerCodeHash: ethers.keccak256(r.get("controller-code")) },
        ...(eligible ? {} : { unavailable: "set-unregistered-module-disabled-or-external-position" }) };
    },
    decide({ evidence }) {
      const p = evidence as Proof | undefined;
      if (p?.rejection) return { status: "chain-proven-rejected", reasonCode: p.rejection, evidenceRequestIds: p.ids };
      if (p?.unavailable) return { status: "retryable", reasonCode: p.unavailable };
      if (p?.phase !== "complete" || !p.binding) return { status: "continue" };
      return { status: "verified", identity: { familyId: FAMILY, lineageId: LINEAGE, subject: p.binding.set, binding: p.binding,
        provenance: [{ kind: "source-bound-direct-runtime-and-current-controller-registration", subject: p.binding.module,
          evidenceHash: hashCanonical({ ...binding(p.binding), source: { ...p.source }, setCodeHash: SET_CODE_HASH, moduleCodeHash: MODULE_CODE_HASH }) }] } };
    },
  }, legacyIdentity],
} satisfies IdentitySemantics<Candidate, Identity>;
