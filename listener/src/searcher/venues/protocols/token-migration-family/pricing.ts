import type { PricingSemantics } from "../../adapter-family-plugin.js";
import { compileAddressMutations } from "../../mutation-index.js";
import { protocolMid } from "../standard-family/common.js";
import { assertInvocation, bindingProjection } from "./binding.js";
import { decodeQuote, quoteRequests } from "./state.js";
import { MAX } from "./codec.js";
import type { Descriptor, Route, PricingDescriptor, Snapshot } from "./types.js";
const dependencies = (d: Descriptor) => [d.target, d.tokenIn, d.tokenOut];
const sample = (d: Descriptor) => d.oneToken < MAX / d.numerator ? d.oneToken : MAX / d.numerator;
const unavailable = (s: Snapshot) => s.halted ? "migration-halted" : s.amountOut === 0n ? "migration-zero-output" : s.amountOut > s.inventory ? "migration-insufficient-inventory" : null;
export const pricing = {
  stateKey: r => r.instanceKey,
  staticBindingProjection: ({ descriptor }) => bindingProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => bindingProjection(descriptor),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length !== 1) throw new Error("migration requires one direction");
    assertInvocation(descriptor, routes[0]);
    return { ...descriptor, route: routes[0] };
  },
  finalizePricingDescriptor: ({ draft }) => draft,
  current: {
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: ({ descriptor }) => quoteRequests(descriptor, sample(descriptor)),
    decodeSnapshot: ({ descriptor, initialResults }) => decodeQuote(descriptor, sample(descriptor), initialResults),
    deriveMids({ descriptor, snapshot, routes }) {
      if (unavailable(snapshot)) return new Map();
      return new Map(routes.map(route => [route.routeKey, protocolMid({ route, adapterId: route.adapterId, target: descriptor.target, quote: snapshot })]));
    },
    classifyUnavailable: ({ snapshot, routes }) => {
      const reason = unavailable(snapshot);
      return new Map(reason ? routes.map(route => [route.routeKey, reason]) : []);
    },
  },
  dependencies: ({ descriptor }) => dependencies(descriptor),
  mutation: {
    compile: ({ entries }) => compileAddressMutations(entries, ({ descriptor }) => ({ addresses: dependencies(descriptor), keys: [descriptor.instanceKey] }), { kinds: ["log", "call"] }),
    affectedStateKeys({ descriptor, observation }) {
      const address = observation.kind === "log" ? observation.address : observation.kind === "call" ? observation.target : null;
      return address && dependencies(descriptor).some(d => d.toLowerCase() === address.toLowerCase()) ? [descriptor.instanceKey] : [];
    },
  },
} satisfies PricingSemantics<Descriptor, Route, PricingDescriptor, Snapshot>;
