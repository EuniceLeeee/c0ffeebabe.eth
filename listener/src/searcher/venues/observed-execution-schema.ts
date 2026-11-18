import { getAddress, isAddress, ZeroAddress } from "ethers";
import type { CanonicalSource } from "./adapter-request-program.js";
import { assertModuleData, type ModuleBlock } from "./declarative-modules.js";
import { bindObservedCallTemplate, OBSERVED_CALL_MAX_AMOUNT, validateObservedCallTemplate, type ObservedCallTemplate } from "./observed-call-template.js";

/** Portable configuration data. Query discovery validates these same bindings
 * without loading the execution compiler or granting runtime/Ready authority. */
export interface ObservedExecutionBinding {
  readonly version: 1;
  readonly familyId: string;
  readonly lineageId: string;
  readonly instanceKey: string;
  readonly routeKey: string;
  readonly adapterId: string;
  readonly bindingFingerprint: string;
  readonly executor: string;
  readonly template: ObservedCallTemplate;
  readonly targetCodeHash: string;
  readonly protectedTokens: readonly string[];
  readonly minimumAmountIn: string;
  readonly maximumAmountIn: string;
  readonly probeSource: CanonicalSource;
}
export interface ObservedExecutionModule extends ModuleBlock {
  readonly version: 1;
  readonly entries: readonly ObservedExecutionBinding[];
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hash = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const bindingFields = ["version", "familyId", "lineageId", "instanceKey", "routeKey", "adapterId", "bindingFingerprint", "executor",
  "template", "targetCodeHash", "protectedTokens", "minimumAmountIn", "maximumAmountIn", "probeSource"];
function fail(message: string): never { throw new Error(`observed execution: ${message}`); }

/** Data and actor validation shared by browser discovery and production.
 * Production additionally compiles each binding's VM leg to enforce its budget.
 * A valid module remains configuration, never an execution or identity proof. */
export function validateObservedExecutionModule(value: ModuleBlock): void {
  assertModuleData(value);
  if (value.version !== 1 || Object.keys(value).some(k => !["version", "entries"].includes(k)) ||
      !Array.isArray(value.entries) || !value.entries.length || value.entries.length > 256) fail("invalid module");
  const keys = new Set<string>();
  for (const raw of value.entries) {
    const e = raw as ObservedExecutionBinding;
    if (!e || typeof e !== "object" || Array.isArray(e) || e.version !== 1 ||
        Object.keys(e).length !== bindingFields.length || bindingFields.some(k => !Object.hasOwn(e, k))) fail("invalid binding fields");
    for (const field of [e.familyId, e.lineageId, e.instanceKey, e.routeKey, e.adapterId])
      if (typeof field !== "string" || !field.trim() || field.trim() !== field) fail("invalid owner or route key");
    if (!hash(e.bindingFingerprint) || !/^0x[0-9a-f]{64}$/.test(e.targetCodeHash)) fail("invalid identity/code binding");
    validateObservedCallTemplate(e.template);
    const source = e.probeSource;
    if (!source || !Number.isSafeInteger(source.number) || source.number < 0 ||
        !Number.isSafeInteger(source.generation) || source.generation < 0 || !/^0x[0-9a-fA-F]{64}$/.test(source.hash))
      fail("canonical source required");
    if (!isAddress(e.instanceKey) || !same(e.instanceKey, e.template.sample.target))
      fail("logical singleton instances require a separate binding capability");
    const actor = getAddress(e.executor), sample = e.template.sample;
    if (actor === ZeroAddress || [sample.target, sample.tokenIn, sample.tokenOut,
      ...(sample.payment.kind === "approval" ? [sample.payment.spender] : [])].some(address => getAddress(address) === actor))
      fail("invalid executor");
    // Exercise the same pure word binding as runtime compilation. Address
    // comparisons above also cover noncanonical but valid input casing.
    bindObservedCallTemplate(e.template, { amountIn: 1n, executor: actor });
    if (!Array.isArray(e.protectedTokens) || e.protectedTokens.length > 8 ||
        new Set(e.protectedTokens.map(t => getAddress(t).toLowerCase())).size !== e.protectedTokens.length) fail("invalid protected inventory");
    if (e.protectedTokens.some(token => getAddress(token) === ZeroAddress || getAddress(token) === actor))
      fail("invalid protected token scope");
    for (const n of [e.minimumAmountIn, e.maximumAmountIn])
      if (typeof n !== "string" || !/^[1-9][0-9]{0,76}$/.test(n) || BigInt(n) > OBSERVED_CALL_MAX_AMOUNT) fail("invalid amount envelope");
    if (BigInt(e.minimumAmountIn) > BigInt(e.maximumAmountIn) || BigInt(e.template.sample.amountIn) < BigInt(e.minimumAmountIn) ||
        BigInt(e.template.sample.amountIn) > BigInt(e.maximumAmountIn)) fail("sample outside amount envelope");
    const key = JSON.stringify([e.familyId, e.instanceKey, e.routeKey]);
    if (keys.has(key)) fail("ambiguous route binding");
    keys.add(key);
  }
}
