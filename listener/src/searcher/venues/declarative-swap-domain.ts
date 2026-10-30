import { compileDeclarativeEventCodec, type DeclarativeEventLog } from "./declarative-event-codec.js";
import { getAddress } from "ethers";
import { createStrictSwapObservation, type PoolImpact, type SwapEventLog } from "./swap-observation.js";
import type { SwapDomainSemantics, CompiledInstanceDescriptor, FamilyRouteDescriptor } from "./adapter-family-plugin.js";
import { validateDeclarativeValue, type compileDeclarativeValues } from "./declarative-values.js";

type Data = Record<string, any>;
type Values = ReturnType<typeof compileDeclarativeValues>;
function record(value: any, required: readonly string[], optional: readonly string[] = []): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error("invalid Swap domain declaration");
}
const same = (a: string, b: string) => getAddress(a).toLowerCase() === getAddress(b).toLowerCase();

/** ABI and field relations belong to JSON. This layer only authenticates event
 * shape and graph ownership, then uses the production strict trigger wrapper.
 * It performs no network reads and does not add a second receipt scheduler. */
export function compileDeclarativeSwap(raw: Data, values: Values, manifest: Data): SwapDomainSemantics<CompiledInstanceDescriptor, FamilyRouteDescriptor> {
  record(raw, ["version", "events", "canonicalIntakeTargets", "victimSupport"], ["localApply", "overlay", "poolMaterialization", "replay"]);
  validateDeclarativeValue(raw);
  if (raw.version !== 1 || !Array.isArray(raw.events) || !raw.events.length || raw.events.length > 64 ||
      !Array.isArray(raw.canonicalIntakeTargets) || !["none", "detect-only", "local-apply", "overlay", "replay"].includes(raw.victimSupport))
    throw new Error("invalid Swap observation version/capabilities");
  const events = raw.events.map((spec: Data) => {
    record(spec, ["id", "pool", "payload", "match", "impact", "classification"], ["valid", "signature", "packed"]);
    if (typeof spec.id !== "string" || !spec.id.trim() || !["swap", "mutation"].includes(spec.classification)) throw new Error("invalid Swap event identity");
    return { spec, codec: compileDeclarativeEventCodec(spec) };
  });
  if (new Set(events.map(e => e.spec.id)).size !== events.length ||
      new Set(events.filter(e => e.codec.topic).map(e => e.codec.topic)).size !== events.filter(e => e.codec.topic).length ||
      new Set(events.filter(e => e.codec.anonymous).map(e => `${e.codec.anonymous!.address}:${e.codec.anonymous!.dataLengthBytes}`)).size !== events.filter(e => e.codec.anonymous).length)
    throw new Error("ambiguous Swap event declarations");
  function decode(log: DeclarativeEventLog) {
    const matching = events.filter(e => e.codec.matches(log));
    if (matching.length !== 1) return null;
    const entry = matching[0];
    try {
      const env = { log, args: entry.codec.decode(log) };
      if (entry.spec.valid !== undefined && values.evaluate(entry.spec.valid, env) !== true) return null;
      const pool = values.evaluate(entry.spec.pool, env);
      if (typeof pool !== "string" || !/^0x(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(pool)) return null;
      return { ...entry, env, pool: pool.toLowerCase(), payload: values.evaluate(entry.spec.payload, env) };
    } catch { return null; }
  }
  const ids = Object.freeze(events.filter(e => e.codec.topic).map(e => e.spec.id));
  const capability = (key: string, mode: string) => {
    const defined = raw[key] !== undefined && Object.keys(raw[key]).length !== 0;
    if (raw.victimSupport === mode && !defined) throw new Error(`Swap ${mode} requires declared ${key}`);
    return defined;
  };
  const local = capability("localApply", "local-apply"), overlay = capability("overlay", "overlay"), replay = capability("replay", "replay");
  if (local) record(raw.localApply, ["result"]);
  if (overlay) record(raw.overlay, ["result"]);
  const materialization = raw.poolMaterialization && Object.keys(raw.poolMaterialization).length > 0;
  if (materialization) record(raw.poolMaterialization, ["result"]);
  if (replay) record(raw.replay, ["bind", "applyLocal", "buildOverlay"], ["exactPostState"]);
  return {
    landedEvents: { patternIds: ids, classify({ observation }) {
      return observation.kind === "log" ? decode(observation)?.spec.classification ?? null : null;
    } },
    observation: { patternIds: ids, decode({ observation }) {
      const found = observation.kind === "log" ? decode(observation) : null;
      return found ? [{ kind: found.spec.classification, canonicalPayload: found.payload }] : [];
    } },
    receiptObservation: createStrictSwapObservation({
      topics: events.flatMap(e => e.codec.topic ? [e.codec.topic] : []), canonicalIntakeTargets: raw.canonicalIntakeTargets.map(getAddress),
      ...(events.some(e => e.codec.anonymous) ? { anonymousLogs: events.flatMap(e => e.codec.anonymous ? [e.codec.anonymous] : []) } : {}),
      observedPoolIdentity: log => decode(log)?.pool ?? null,
      async decodeSwapImpacts(ctx) {
        return ctx.matchedOwnedTriggers.map(trigger => {
          const found = decode(ctx.logs[trigger.logIndex]);
          if (!found) throw new Error("malformed owned Swap event");
          if (found.spec.classification === "mutation") return { logIndex: trigger.logIndex, mutationOnlyReason: "declared state mutation" };
          const candidates = ctx.edgesByTarget.get(found.pool) ?? ctx.graph;
          const edges = candidates.filter(edge => manifest.edgeAdapterIds.includes(edge.adapterId) &&
            values.evaluate(found.spec.match, { ...found.env, payload: found.payload, pool: found.pool, edge,
              descriptor: ctx.resolveBinding?.(edge)?.descriptor }) === true);
          if (!edges.length) return { logIndex: trigger.logIndex, mutationOnlyReason: "direction absent from admitted graph" };
          if (edges.length !== 1) throw new Error("ambiguous Swap event route binding");
          const edge = edges[0];
          const impact = values.evaluate(found.spec.impact, { ...found.env, payload: found.payload, pool: found.pool, edge,
            sourceGeneration: ctx.sourceGeneration, descriptor: ctx.resolveBinding?.(edge)?.descriptor }) as PoolImpact;
          if (!impact || !same(impact.tokenIn, edge.tokenIn) || !same(impact.tokenOut, edge.tokenOut) ||
              impact.matchedAdapterId !== edge.adapterId || !same(impact.pool, edge.target) ||
              (found.pool.length === 66 ? impact.poolId?.toLowerCase() !== found.pool || edge.instanceKey?.toLowerCase() !== found.pool : !same(impact.pool, found.pool)) ||
              typeof impact.amountIn !== "bigint" || impact.amountIn <= 0n ||
              (impact.amountOut !== undefined && (typeof impact.amountOut !== "bigint" || impact.amountOut <= 0n)))
            throw new Error("Swap impact violates admitted route binding");
          return { logIndex: trigger.logIndex, impact };
        });
      },
    }),
    victimSupport: raw.victimSupport,
    ...(local ? { localApply: { apply: (input: any) => values.evaluate(raw.localApply.result, input) } } : {}),
    ...(overlay ? { overlay: { build: (input: any) => values.evaluate(raw.overlay.result, input) } } : {}),
    ...(materialization ? { poolMaterialization: { patternIds: ids, candidateBinding: (input: any) => values.evaluate(raw.poolMaterialization.result, input) } } : {}),
    ...(replay ? { replay: {
      bind(input: any) {
        const key = values.evaluate(raw.replay.bind, input);
        if (key === null) return null;
        const matches = input.routes.filter((route: FamilyRouteDescriptor) => route.routeKey === key);
        if (matches.length !== 1) throw new Error("replay must bind one admitted route");
        return matches[0];
      },
      applyLocal: (input: any) => values.evaluate(raw.replay.applyLocal, input),
      buildOverlay: (input: any) => values.evaluate(raw.replay.buildOverlay, input),
      ...(raw.replay.exactPostState === undefined ? {} : { exactPostState: (input: any) => values.evaluate(raw.replay.exactPostState, input) }),
    } } : {}),
  };
}
