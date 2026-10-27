import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CallerRef, CanonicalSource } from "../../adapter-request-program.js";
import { compileDeclarativeValues } from "../../declarative-values.js";
import rawDefinition from "./infinifi.json";
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

export const INFINIFI_GATEWAY = definition.constants.gateway;
export const INFINIFI_MULTICALL = definition.constants.multicall;
export const INFINIFI_VARIANT = definition.id;
export const INFINIFI_ROLE = definition.constants.role;
export const INFINIFI_SLOT = definition.constants.implementationSlot;
export const INFINIFI_ABI = new ethers.Interface(definition.abi.vault);

export interface InfiniFiSurface {
  readonly proofSource: CanonicalSource;
  readonly vault: string;
  readonly asset: string;
  readonly gateway: string;
  readonly core: string;
  readonly yieldSharing: string;
  readonly gatewayImplementation: string;
  readonly shareDecimals: number;
  readonly vaultCodeHash: string;
  readonly gatewayCodeHash: string;
}
export interface InfiniFiBinding extends InfiniFiSurface {
  readonly yieldSharingImplementation: string;
  readonly assetDecimals: number;
  readonly codeHashes: Readonly<Record<"asset" | "core" | "yieldSharing" | "gatewayImplementation" | "yieldSharingImplementation" | "multicall", string>>;
}

export function infinifiProjection(binding: InfiniFiBinding) {
  return expression("projection", { binding });
}
export function infinifiAddress(value: string): string { return program("address", { value }); }
export function infinifiWord(results: readonly AdapterRequestResult[], id: string): bigint {
  return program("word", { results, id });
}
export function infinifiSlot(id: string, vault: string): AdapterRequest {
  return expression("slotRequest", { id, vault });
}
export function infinifiSurfaceRequests(prefix: string, vault: string): AdapterRequest[] {
  return expression("surfaceRequests", { prefix, vault });
}
export function decodeInfiniFiSurface(results: readonly AdapterRequestResult[], prefix: string, vault: string): InfiniFiSurface {
  return program("surface", { results, prefix, vault });
}
export function infinifiDependencyRequests(prefix: string, binding: InfiniFiSurface): AdapterRequest[] {
  return expression("dependencyRequests", { prefix, binding });
}
export function decodeInfiniFiDependencies(results: readonly AdapterRequestResult[], prefix: string, surface: InfiniFiSurface):
  Omit<InfiniFiBinding, "codeHashes"> & { codeHashes: Omit<InfiniFiBinding["codeHashes"], "yieldSharingImplementation"> } {
  return program("dependencies", { results, prefix, surface });
}
export function infinifiPermissionReason(results: readonly AdapterRequestResult[], prefix: string, redeem: boolean): string | null {
  return program("permission", { results, prefix, redeem });
}
export function infinifiGuardRequests(prefix: string, binding: InfiniFiBinding): AdapterRequest[] {
  return expression("guardRequests", { prefix, binding });
}
export function checkInfiniFiGuard(results: readonly AdapterRequestResult[], prefix: string, binding: InfiniFiBinding,
  redeem: boolean, source?: CanonicalSource): void {
  program("guard", { results, prefix, binding, redeem, source });
}
export function infinifiQuoteRequest(requestId: string, binding: Pick<InfiniFiBinding, "vault" | "yieldSharing">,
  direction: "deposit" | "redeem", amountIn: bigint): AdapterRequest {
  return program("quoteRequests", { requestId, binding, direction, amountIn });
}
export function decodeInfiniFiQuote(data: string): bigint {
  return program("quoteData", { data });
}
