import { FunctionFragment, Interface, MaxUint256, getAddress } from "ethers";
import type { CallPattern, OracleVictimSpec } from "./adapter-family-plugin.js";
import { hashCanonical, type CanonicalValue } from "./canonical-value.js";
import { immutableDeclarativeData } from "./declarative-immutable.js";
import { assertModuleData } from "./declarative-modules.js";
import { validateDeclarativeValue, type compileDeclarativeValues } from "./declarative-values.js";

type Value = unknown;
export interface DeclarativeOracleVictim {
  readonly version: 1;
  readonly callPatterns: readonly (Omit<CallPattern, "selector"> & {
    /** Infrastructure call targets, not instance admission or coverage. */
    readonly targets: readonly string[];
    readonly when: Value;
    readonly result: Value;
  })[];
  readonly resultChecks: readonly Value[];
  readonly canonicalIntakeTargets?: readonly string[];
  readonly runtimeDetection: Omit<OracleVictimSpec["runtimeDetection"], "priceProbe"> & {
    readonly priceProbe: Omit<OracleVictimSpec["runtimeDetection"]["priceProbe"], "amountIn"> & {
      readonly amountIn: string;
    };
  };
}

function shape(value: any, required: readonly string[], optional: readonly string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key)))
    throw new Error(`invalid oracle-victim ${label}`);
}
function identifier(value: unknown): void {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) throw new Error("invalid oracle-victim identifier");
}
function addresses(value: unknown, nonempty: boolean): void {
  if (!Array.isArray(value) || nonempty && !value.length || value.some(address => typeof address !== "string"))
    throw new Error("invalid oracle-victim targets");
  const normalized = value.map(address => getAddress(address).toLowerCase());
  if (new Set(normalized).size !== normalized.length) throw new Error("duplicate oracle-victim target");
}
function index(value: unknown, length: number): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= length)
    throw new Error("invalid oracle-victim ABI index");
}

/** Missing and empty optional blocks are handled by the module catalogue. A
 * nonempty block must describe the whole capability; no executable bindings. */
export function validateDeclarativeOracleVictim(raw: unknown): asserts raw is DeclarativeOracleVictim {
  assertModuleData(raw); validateDeclarativeValue(raw);
  shape(raw, ["version", "callPatterns", "runtimeDetection", "resultChecks"], ["canonicalIntakeTargets"], "module");
  const definition = raw as DeclarativeOracleVictim;
  if (definition.version !== 1 || !Array.isArray(definition.callPatterns) || !definition.callPatterns.length)
    throw new Error("invalid oracle-victim version or call patterns");
  if (!Array.isArray(definition.resultChecks) || !definition.resultChecks.length)
    throw new Error("oracle-victim requires result checks");
  if (definition.canonicalIntakeTargets !== undefined) addresses(definition.canonicalIntakeTargets, false);
  const ids = new Set<string>(), matches = new Set<string>();
  for (const pattern of definition.callPatterns) {
    shape(pattern, ["id", "signature", "candidateAddress", "targets", "when", "result"], ["argumentProjection"], "call pattern");
    identifier(pattern.id); identifier(pattern.signature);
    if (ids.has(pattern.id)) throw new Error("duplicate oracle-victim call id");
    ids.add(pattern.id); addresses(pattern.targets, true);
    const fn = FunctionFragment.from(pattern.signature);
    for (const target of pattern.targets) {
      const match = `${target.toLowerCase()}:${fn.selector}`;
      if (matches.has(match)) throw new Error("ambiguous oracle-victim target and selector");
      matches.add(match);
    }
    shape(pattern.candidateAddress, ["from"], ["index"], "candidate address");
    if (pattern.candidateAddress.from === "call-target") {
      if (Object.hasOwn(pattern.candidateAddress, "index")) throw new Error("call-target cannot declare an argument index");
    } else if (pattern.candidateAddress.from === "argument") {
      index(pattern.candidateAddress.index, fn.inputs.length);
      if (fn.inputs[pattern.candidateAddress.index]!.type !== "address") throw new Error("candidate argument must be an address");
    } else throw new Error("invalid oracle-victim candidate address source");
    if (pattern.argumentProjection !== undefined) {
      if (!Array.isArray(pattern.argumentProjection)) throw new Error("invalid oracle-victim argument projection");
      const names = new Set<string>();
      for (const projection of pattern.argumentProjection) {
        shape(projection, ["index", "type", "name"], [], "argument projection");
        index(projection.index, fn.inputs.length); identifier(projection.name);
        if (names.has(projection.name) || projection.type !== fn.inputs[projection.index]!.format("sighash"))
          throw new Error("duplicate or inconsistent oracle-victim argument projection");
        names.add(projection.name);
      }
    }
  }
  const detection = definition.runtimeDetection;
  shape(detection, ["id", "affectedEdges", "priceProbe", "maxSearchHops"], [], "runtime detection");
  identifier(detection.id);
  if (!Number.isSafeInteger(detection.maxSearchHops) || detection.maxSearchHops <= 0 ||
    !Array.isArray(detection.affectedEdges) || !detection.affectedEdges.length) throw new Error("invalid oracle-victim runtime detection");
  for (const edge of detection.affectedEdges) {
    shape(edge, ["adapterId"], ["target", "tokenIn", "tokenOut"], "affected edge"); identifier(edge.adapterId);
    for (const key of ["target", "tokenIn", "tokenOut"] as const) if (edge[key] !== undefined) getAddress(edge[key]!);
  }
  const probe = detection.priceProbe;
  shape(probe, ["signature", "functionName", "amountIn", "outputIndex"], [], "price probe");
  identifier(probe.signature); identifier(probe.functionName);
  const fn = FunctionFragment.from(probe.signature);
  if (fn.name !== probe.functionName || typeof probe.amountIn !== "string" || !/^[1-9][0-9]*$/.test(probe.amountIn) ||
    BigInt(probe.amountIn) > MaxUint256) throw new Error("invalid oracle-victim price probe");
  // The existing detector supplies exactly these three arguments. Reject an
  // incompatible definition here instead of failing later inside production.
  if (fn.inputs.map(input => input.type).join(",") !== "address,address,uint256" ||
    !["view", "pure"].includes(fn.stateMutability))
    throw new Error("oracle-victim price probe must read (address,address,uint256)");
  index(probe.outputIndex, fn.outputs.length);
  if (!/^uint([0-9]+)?$/.test(fn.outputs[probe.outputIndex]!.type)) throw new Error("price-probe output must be unsigned integer");
}

/** Decode only shortlisted matching calls. All parsing is synchronous and local;
 * the existing production OracleVictimSpec consumer owns later detection work. */
export function compileDeclarativeOracleVictim(
  raw: unknown,
  values: Pick<ReturnType<typeof compileDeclarativeValues>, "evaluate">,
): OracleVictimSpec {
  validateDeclarativeOracleVictim(raw);
  const definition = immutableDeclarativeData(JSON.parse(JSON.stringify(raw)) as DeclarativeOracleVictim, "trial");
  const compiled = definition.callPatterns.map(declaration => {
    const fn = FunctionFragment.from(declaration.signature);
    const { targets: _targets, when: _when, result: _result, ...metadata } = declaration;
    const pattern: CallPattern = Object.freeze({ ...metadata, signature: fn.format("sighash"), selector: fn.selector as `0x${string}` });
    return { declaration, pattern, fn, abi: new Interface([fn]) };
  });
  const byTarget = new Map<string, Map<string, typeof compiled[number]>>();
  for (const item of compiled) for (const target of item.declaration.targets) {
    const address = target.toLowerCase(), selectors = byTarget.get(address) ?? new Map<string, typeof compiled[number]>();
    selectors.set(item.pattern.selector, item); byTarget.set(address, selectors);
  }
  const plainArgs = (value: any): CanonicalValue => Array.isArray(value) ? Array.from(value, plainArgs) : value;
  const { priceProbe, ...detection } = definition.runtimeDetection;
  // The detector prepends `function`; preserve returns and mutability while
  // accepting either full or short human-readable ABI input in the JSON.
  const signature = FunctionFragment.from(priceProbe.signature).format("full").replace(/^function /, "");
  return Object.freeze({
    callPatterns: Object.freeze(compiled.map(item => item.pattern)),
    ...(definition.canonicalIntakeTargets === undefined ? {} : { canonicalIntakeTargets: definition.canonicalIntakeTargets }),
    runtimeDetection: Object.freeze({ ...detection, priceProbe: Object.freeze({ ...priceProbe, signature, amountIn: BigInt(priceProbe.amountIn) }) }),
    decode({ observation }: Parameters<OracleVictimSpec["decode"]>[0]) {
      if (observation.kind !== "call" || typeof observation.target !== "string") return null;
      const selectors = byTarget.get(observation.target.toLowerCase());
      if (!selectors || typeof observation.data !== "string") return null;
      const selector = observation.data.slice(0, 10).toLowerCase(), item = selectors.get(selector);
      if (!item) return null;
      // Some ingestion envelopes also retain a selector. It cannot contradict
      // the authoritative calldata even though UnifiedObservation needs only data.
      if (Object.hasOwn(observation, "selector")) {
        const declared = (observation as unknown as { selector: unknown }).selector;
        if (typeof declared !== "string" || declared.toLowerCase() !== selector) return null;
      }
      let args: CanonicalValue;
      try {
        args = plainArgs(item.abi.decodeFunctionData(item.fn, observation.data));
      } catch { return null; } // Malformed untrusted calldata is not a victim.
      const environment = { observation, args };
      const matched = values.evaluate(item.declaration.when, environment);
      if (typeof matched !== "boolean") throw new Error("oracle-victim condition must return boolean");
      if (!matched) return null;
      const result = values.evaluate(item.declaration.result, environment) as CanonicalValue;
      if (!result || typeof result !== "object" || Array.isArray(result) || !Object.keys(result).length)
        throw new Error("oracle-victim result must be a nonempty canonical record");
      hashCanonical(result); // Definition errors must not masquerade as unrelated calls.
      for (const check of definition.resultChecks) if (values.evaluate(check, { ...environment, result }) !== true)
        throw new Error("oracle-victim result check failed");
      return immutableDeclarativeData(result, "trial");
    },
  });
}
