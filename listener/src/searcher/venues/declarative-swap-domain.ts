import { compileDeclarativeEventCodec, type DeclarativeEventLog } from "./declarative-event-codec.js";
import { Interface, getAddress } from "ethers";
import { createStrictSwapObservation, type PoolImpact, type SwapEventLog } from "./swap-observation.js";
import type { SwapDomainSemantics, CompiledInstanceDescriptor, FamilyRouteDescriptor, UnifiedObservation } from "./adapter-family-plugin.js";
import { validateDeclarativeValue, type compileDeclarativeValues } from "./declarative-values.js";
import { validateDeclarativeReadFlow } from "./declarative-read-flow.js";

type Data = Record<string, any>;
type Values = ReturnType<typeof compileDeclarativeValues>;
function record(value: any, required: readonly string[], optional: readonly string[] = []): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error("invalid Swap domain declaration");
}
const same = (a: string, b: string) => getAddress(a).toLowerCase() === getAddress(b).toLowerCase();

/** ABI and field relations belong to JSON. This layer only authenticates event
 * shape and graph ownership, then uses the production strict trigger wrapper.
 * Optional observation enrichment uses its existing query backend and lifetime;
 * it neither issues quote evidence nor adds a second receipt scheduler. */
export function compileDeclarativeSwap(raw: Data, values: Values, manifest: Data): SwapDomainSemantics<CompiledInstanceDescriptor, FamilyRouteDescriptor> {
  record(raw, ["version", "events", "canonicalIntakeTargets", "victimSupport"], ["calls", "receiptReads", "localApply", "overlay", "poolMaterialization", "replay"]);
  validateDeclarativeValue(raw);
  if (raw.version !== 1 || !Array.isArray(raw.events) || !raw.events.length || raw.events.length > 64 ||
      !Array.isArray(raw.canonicalIntakeTargets) || !["none", "detect-only", "local-apply", "overlay", "replay"].includes(raw.victimSupport))
    throw new Error("invalid Swap observation version/capabilities");
  const events = raw.events.map((spec: Data) => {
    record(spec, ["id", "pool", "payload", "match", "impact", "classification"], ["valid", "signature", "packed", "relatedEvents"]);
    if (typeof spec.id !== "string" || !spec.id.trim() || !["swap", "mutation"].includes(spec.classification)) throw new Error("invalid Swap event identity");
    return { spec, codec: compileDeclarativeEventCodec(spec) };
  });
  if (new Set(events.map(e => e.spec.id)).size !== events.length ||
      new Set(events.filter(e => e.codec.topic).map(e => e.codec.topic)).size !== events.filter(e => e.codec.topic).length ||
      new Set(events.filter(e => e.codec.anonymous).map(e => `${e.codec.anonymous!.address}:${e.codec.anonymous!.dataLengthBytes}`)).size !== events.filter(e => e.codec.anonymous).length)
    throw new Error("ambiguous Swap event declarations");
  const eventIds = new Set(events.map(e => e.spec.id));
  for (const { spec } of events) {
    if (spec.relatedEvents !== undefined && (!Array.isArray(spec.relatedEvents) || spec.relatedEvents.length > 64 ||
        new Set(spec.relatedEvents).size !== spec.relatedEvents.length || spec.relatedEvents.some((id: unknown) => !eventIds.has(id))))
      throw new Error("related Swap events must name unique declared events");
  }
  if (raw.calls !== undefined && (!Array.isArray(raw.calls) || raw.calls.length > 64)) throw new Error("invalid Swap call declarations");
  const calls = (raw.calls ?? []).map((spec: Data) => {
    record(spec, ["id", "signature", "classification", "payload"], ["valid"]);
    if (typeof spec.id !== "string" || !spec.id.trim() || typeof spec.signature !== "string" ||
        !["swap", "mutation"].includes(spec.classification)) throw new Error("invalid Swap call identity");
    const abi = new Interface([spec.signature]);
    if (abi.fragments.length !== 1 || abi.fragments[0].type !== "function") throw new Error("Swap call requires one function ABI");
    const fn = abi.getFunction(abi.fragments[0].format("sighash"))!;
    return { spec, abi, fn };
  });
  if (new Set(calls.map((c: any) => c.spec.id)).size !== calls.length || calls.some((c: any) => eventIds.has(c.spec.id)) ||
      new Set(calls.map((c: any) => c.fn.selector)).size !== calls.length) throw new Error("ambiguous Swap call declarations");
  if (raw.receiptReads !== undefined && (!raw.receiptReads || typeof raw.receiptReads !== "object" || Array.isArray(raw.receiptReads)))
    throw new Error("invalid receipt read declaration");
  const receiptReads = raw.receiptReads && Object.keys(raw.receiptReads).length ? raw.receiptReads : undefined;
  if (receiptReads) {
    record(receiptReads, ["version", "when", "flow"]);
    if (receiptReads.version !== 1) throw new Error("unsupported receipt read version");
    validateDeclarativeReadFlow(receiptReads.flow);
    if (receiptReads.flow.steps.length > 16) throw new Error("receipt read step budget exceeded");
  }
  function decodeCall(observation: Extract<UnifiedObservation, { kind: "call" }>) {
    const entry = calls.find((c: any) => observation.data.slice(0, 10).toLowerCase() === c.fn.selector.toLowerCase());
    if (!entry) return [];
    try {
      const decoded = entry.abi.decodeFunctionData(entry.fn, observation.data);
      if (entry.abi.encodeFunctionData(entry.fn, decoded).toLowerCase() !== observation.data.toLowerCase()) return [];
      const args = Object.fromEntries(entry.fn.inputs.map((field: any, i: number) => [field.name || String(i), decoded[i]]));
      // Only facts carried by UnifiedObservation are exposed. In particular,
      // absent transaction value is unknown, never an invented zero.
      const env = { observation, args };
      if (entry.spec.valid !== undefined && values.evaluate(entry.spec.valid, env) !== true) return [];
      return [{ kind: entry.spec.classification, canonicalPayload: values.evaluate(entry.spec.payload, env) }];
    } catch { return []; }
  }
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
    observation: { patternIds: [...ids, ...calls.map((c: any) => c.spec.id)], decode({ observation }) {
      if (observation.kind === "call") return decodeCall(observation);
      const found = observation.kind === "log" ? decode(observation) : null;
      return found ? [{ kind: found.spec.classification, canonicalPayload: found.payload }] : [];
    } },
    receiptObservation: createStrictSwapObservation({
      topics: events.flatMap(e => e.codec.topic ? [e.codec.topic] : []), canonicalIntakeTargets: raw.canonicalIntakeTargets.map(getAddress),
      ...(events.some(e => e.codec.anonymous) ? { anonymousLogs: events.flatMap(e => e.codec.anonymous ? [e.codec.anonymous] : []) } : {}),
      observedPoolIdentity: log => decode(log)?.pool ?? null,
      async decodeSwapImpacts(ctx) {
        // This is observation enrichment through the existing backend. Its
        // string results are not issued quote evidence and carry no invented
        // canonical source/provenance. Block tags and lifetime stay bound to
        // the production receipt context.
        const queries = new Map<string, Promise<string>>();
        function assertCompleteReceipt(logIndex: number) {
          const generation = ctx.sourceGeneration;
          if (generation.logsCompleteness !== "complete-receipt" || !/^0x[0-9a-fA-F]{64}$/.test(generation.receiptTransactionHash ?? "") ||
              !/^0x[0-9a-fA-F]{64}$/.test(generation.receiptBlockHash ?? "") || !Number.isSafeInteger(generation.receiptBlockNumber) ||
              generation.receiptBlockNumber! < 0) throw new Error("related Swap events require a complete bound receipt");
          const assertReceipt = (log: SwapEventLog) => {
            if (log.transactionHash?.toLowerCase() !== generation.receiptTransactionHash!.toLowerCase() ||
                log.blockHash?.toLowerCase() !== generation.receiptBlockHash!.toLowerCase() || log.blockNumber !== generation.receiptBlockNumber)
              throw new Error("related Swap event came from a foreign or unbound receipt");
          };
          assertReceipt(ctx.logs[logIndex]);
          return assertReceipt;
        }
        async function enrich(env: Data, logIndex: number): Promise<Data> {
          if (!receiptReads || values.evaluate(receiptReads.when, env) !== true) return {};
          assertCompleteReceipt(logIndex);
          const { sourceBlock, sourceBlockHash } = ctx.sourceGeneration;
          if (!Number.isSafeInteger(sourceBlock) || sourceBlock! < 0 || !/^0x[0-9a-fA-F]{64}$/.test(sourceBlockHash ?? ""))
            throw new Error("receipt reads require a bound pre-victim source");
          if (!ctx.tokenQuery) throw new Error("receipt read backend unavailable");
          const steps: Data = {}, seen = new Set<string>();
          let requestCount = 0;
          for (const step of receiptReads.flow.steps) {
            const environment = { ...env, steps: Object.freeze({ ...steps }) };
            const requirements = values.evaluate(step.requirements, environment);
            record(requirements, ["transports"]);
            if (!Array.isArray(requirements.transports) || requirements.transports.length !== 1 || requirements.transports[0] !== "eth-call")
              throw new Error("receipt enrichment supports only eth-call");
            const requests = values.evaluate(step.requests, environment);
            if (!Array.isArray(requests) || requests.length > 64 || (requestCount += requests.length) > 256)
              throw new Error("receipt read request budget exceeded");
            for (const request of requests) {
              record(request, ["id", "kind", "to", "data", "completion"]);
              if (typeof request.id !== "string" || !request.id.length || seen.has(request.id) || request.kind !== "eth-call" ||
                  request.completion !== "return-data" || typeof request.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(request.data) ||
                  request.data.length < 10 || request.data.length > 131074) throw new Error("invalid receipt read request");
              getAddress(request.to); seen.add(request.id);
            }
            const reads = await Promise.all(requests.map(async (request: Data) => {
              if (ctx.control.signal.aborted || Date.now() >= ctx.control.deadlineAtMs) throw new Error("receipt read deadline reached");
              const to = getAddress(request.to), data = request.data;
              const key = `${to.toLowerCase()}:${data.toLowerCase()}`;
              let query = queries.get(key);
              if (!query) {
                if (queries.size >= 256) throw new Error("receipt read total request budget exceeded");
                query = ctx.tokenQuery!.call({ to, data, blockTag: sourceBlock! }, ctx.control);
                queries.set(key, query);
              }
              const returned = await query;
              if (ctx.control.signal.aborted || Date.now() >= ctx.control.deadlineAtMs) throw new Error("receipt read deadline reached");
              if (typeof returned !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(returned)) throw new Error("malformed receipt read response");
              return Object.freeze({ id: request.id, data: returned });
            }));
            const stepEnv = { ...environment, reads: Object.freeze(reads), requests };
            const output = step.decode === undefined ? values.evaluate(step.result, stepEnv) : values.run(step.decode, stepEnv);
            if (output === undefined) throw new Error("receipt read step returned undefined");
            steps[step.id] = output;
          }
          const result = values.evaluate(receiptReads.flow.result, { ...env, steps });
          if (result === undefined) throw new Error("receipt read flow returned undefined");
          return { receiptReads: Object.freeze({ result }) };
        }
        function related(found: NonNullable<ReturnType<typeof decode>>, logIndex: number) {
          const requested = found.spec.relatedEvents as readonly string[] | undefined;
          if (!requested?.length) return {};
          const assertReceipt = assertCompleteReceipt(logIndex);
          const relatedEvents = ctx.logs.flatMap((log, index) => {
            if (!same(log.address, ctx.logs[logIndex].address)) return [];
            const matching = events.filter(e => requested.includes(e.spec.id) && e.codec.matches(log));
            if (!matching.length) return [];
            const event = decode(log);
            // An invalid same-emitter log must not silently leave an earlier
            // post-state masquerading as the final state of the receipt.
            if (!event) {
              if (same(log.address, ctx.logs[logIndex].address)) throw new Error("malformed related Swap event");
              return [];
            }
            if (event.pool !== found.pool) return [];
            assertReceipt(log);
            return [Object.freeze({ id: event.spec.id, logIndex: index, args: event.env.args, payload: event.payload })];
          });
          return { receipt: Object.freeze({ events: Object.freeze(relatedEvents), logIndex }) };
        }
        return Promise.all(ctx.matchedOwnedTriggers.map(async trigger => {
          const found = decode(ctx.logs[trigger.logIndex]);
          if (!found) throw new Error("malformed owned Swap event");
          if (found.spec.classification === "mutation") return { logIndex: trigger.logIndex, mutationOnlyReason: "declared state mutation" };
          const candidates = ctx.edgesByTarget.get(found.pool) ?? ctx.graph;
          const edges = candidates.filter(edge => ctx.graph.includes(edge) && manifest.edgeAdapterIds.includes(edge.adapterId) &&
            values.evaluate(found.spec.match, { ...found.env, payload: found.payload, pool: found.pool, edge,
              descriptor: ctx.resolveBinding?.(edge)?.descriptor }) === true);
          if (!edges.length) return { logIndex: trigger.logIndex, mutationOnlyReason: "direction absent from admitted graph" };
          if (edges.length !== 1) throw new Error("ambiguous Swap event route binding");
          const edge = edges[0];
          const environment = { ...found.env, payload: found.payload, pool: found.pool, edge,
            sourceGeneration: ctx.sourceGeneration, descriptor: ctx.resolveBinding?.(edge)?.descriptor, ...related(found, trigger.logIndex) };
          const impact = values.evaluate(found.spec.impact, { ...environment, ...await enrich(environment, trigger.logIndex) }) as PoolImpact;
          if (!impact || !same(impact.tokenIn, edge.tokenIn) || !same(impact.tokenOut, edge.tokenOut) ||
              impact.matchedAdapterId !== edge.adapterId || !same(impact.pool, edge.target) ||
              (found.pool.length === 66 ? impact.poolId?.toLowerCase() !== found.pool || edge.instanceKey?.toLowerCase() !== found.pool : !same(impact.pool, found.pool)) ||
              typeof impact.amountIn !== "bigint" || impact.amountIn <= 0n ||
              (impact.amountOut !== undefined && (typeof impact.amountOut !== "bigint" || impact.amountOut <= 0n)))
            throw new Error("Swap impact violates admitted route binding");
          return { logIndex: trigger.logIndex, impact };
        }));
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
