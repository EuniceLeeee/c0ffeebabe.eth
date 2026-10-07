// Emits real production Family code against synthetic descriptors only.
// No provider, historical identity or admission evidence is manufactured.
import { ethers } from "ethers";
import { plugin } from "../../../production-families/balancer-v2.production.js";
import { fixture, setup, idFor, exact } from "./fixtures.js";
const [pool, executor, iValue, jValue, ...rest] = process.argv.slice(2);
const tokenValues = rest.slice(0, 3), mode = rest[3] ?? "runtime";
if (!pool || !executor || tokenValues.length < 2) throw Error("runtime fixture arguments");
const tokens = tokenValues.map(ethers.getAddress), i = Number(iValue), j = Number(jValue);
const s = setup(fixture(tokens, tokens.map(() => 18), idFor(pool, tokens.length === 2 ? 2 : 1)));
const route = s.routes.find(r => r.i === i && r.j === j);
if (!route) throw Error("runtime fixture direction");
const leg = plugin.execution.buildRuntimeLeg!({ descriptor: s.descriptor, route, executor, runtimeEvidence: [] });
if (!leg) throw Error("missing runtime leg");
if (mode === "runtime") process.stdout.write(leg.program);
else if (mode === "quoted") {
  const amount = BigInt(rest[4]), minimum = BigInt(rest[5]), q = exact(s, amount, route, executor);
  const input = { ...q.input, quotedAmountOut: q.quote.amountOut,
    minAmountOut: minimum, exactEvidence: q.quote.evidence };
  const node = plugin.execution.buildFragment(input).nodes[0];
  process.stdout.write(ethers.hexlify(plugin.actionAdapters[0].encode(node, executor, new Uint8Array())));
} else throw Error("unknown emitter mode");
