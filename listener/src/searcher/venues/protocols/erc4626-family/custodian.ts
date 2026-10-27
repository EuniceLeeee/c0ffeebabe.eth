import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CallerRef, CanonicalSource } from "../../adapter-request-program.js";
import { compileDeclarativeValues } from "../../declarative-values.js";
import rawDefinition from "./custodian.json";
import { normalizeDeclarativeVariant } from "../../declarative-variant.js";
const definition = normalizeDeclarativeVariant(rawDefinition);

// Compatibility exports for existing consumers. Protocol definitions and all
// read/proof logic are owned by JSON and the shared Family interpreter.
const values = compileDeclarativeValues({ inputs: definition.inputs, abi: definition.abi,
  constants: definition.constants, expressions: definition.expressions, programs: definition.programs });
const expression = (name: string, env: Record<string, unknown>): any =>
  values.evaluate({ op: "expression", args: [name, {}] }, env);
const program = (name: string, env: Record<string, unknown>): any =>
  values.evaluate({ op: "program", args: [name, {}] }, env);

export const CUSTODIAN_IMPLEMENTATION_HASH = definition.constants.implementationHash;
export const CUSTODIAN_IMPLEMENTATION_SLOT = definition.constants.implementationSlot;
export const CUSTODIAN_VARIANT = definition.id;
export const CUSTODIAN_ABI = new ethers.Interface(definition.abi.vault);
export const CUSTODIAN_TOKEN = new ethers.Interface(definition.abi.token);

export interface CustodianBinding {
  /** Historical identity provenance, not an execution expiry at the next head. */
  readonly proofSource: CanonicalSource;
  readonly proxyCodeHash: string;
  readonly proxyAdmin: string;
  readonly implementation: string;
  readonly share: string;
  readonly asset: string;
  readonly shareDecimals: number;
  readonly assetDecimals: number;
  readonly shareCodeHash: string;
  readonly assetCodeHash: string;
}
export interface CustodianSurface {
  readonly source: CanonicalSource;
  readonly vault: string;
  readonly proxyCodeHash: string;
  readonly proxyAdmin: string;
  readonly implementation: string;
  readonly share: string;
  readonly asset: string;
  readonly shareDecimals: number;
  readonly assetDecimals: number;
  readonly inventory: bigint;
  readonly capacity: bigint;
  readonly depositCapacity: bigint;
  readonly mintCapacity: bigint;
}

export function custodianAddress(value: string): string { return program("address", { value }); }
export function custodianImplementationWord(data: string): string { return program("implementationWord", { data }); }
export function proveCustodianProxy(code: string): { proxyCodeHash: string; proxyAdmin: string } {
  return program("proxy", { code });
}
export function custodianSlot(id: string, vault: string): AdapterRequest {
  return expression("slotRequest", { id, vault });
}
export function custodianSurfaceRequests(prefix: string, vault: string, caller: CallerRef): AdapterRequest[] {
  return expression("surfaceRequests", { prefix, vault, caller });
}
export function custodianWord(results: readonly AdapterRequestResult[], id: string): bigint {
  return program("word", { results, id });
}
export function custodianBool(results: readonly AdapterRequestResult[], id: string): boolean {
  return program("boolean", { results, id });
}
export function decodeCustodianSurface(results: readonly AdapterRequestResult[], prefix: string, vault: string): CustodianSurface {
  return program("surface", { results, prefix, vault });
}
export function custodianDependencyRequests(prefix: string, binding: CustodianSurface | CustodianBinding, vault: string, actor?: string): AdapterRequest[] {
  return expression("dependencyRequests", { prefix, binding, vault, actor });
}
export function decodeCustodianDependencies(results: readonly AdapterRequestResult[], prefix: string, surface: CustodianSurface): CustodianBinding {
  return program("dependencies", { results, prefix, surface });
}
export function custodianPermissionReason(results: readonly AdapterRequestResult[], prefix: string, checkActor = false): string | null {
  return program("permission", { results, prefix, checkActor });
}
export function assertCustodianBinding(actual: CustodianBinding, expected: CustodianBinding): void {
  program("bindingCheck", { actual, expected });
}
export function custodianGuardRequests(prefix: string, vault: string, binding: CustodianBinding, actor?: string): AdapterRequest[] {
  return expression("guardRequests", { prefix, vault, binding, actor });
}
export function checkCustodianGuard(results: readonly AdapterRequestResult[], prefix: string, vault: string,
  binding: CustodianBinding, checkActor = false, source?: CanonicalSource): CustodianSurface {
  return program("guard", { results, prefix, vault, binding, checkActor, source });
}
