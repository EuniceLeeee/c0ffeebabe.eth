// Offline FFI: production emitters against synthetic descriptors supplied by
// Runtime.t.sol. This does not issue identity, Ready or historical authority.
import { ethers } from "ethers";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import { plugin } from "../../../production-families/balancer-v1.production.js";
import { descriptor, SOURCE } from "./fixtures.js";
const [poolArg, executorArg, tokenArgs, weightArgs, feeArg, iArg, jArg, amountArg, minArg, mode] = process.argv.slice(2);
const pool = ethers.getAddress(poolArg).toLowerCase(), executor = ethers.getAddress(executorArg).toLowerCase();
const d = { ...descriptor(), pool, instanceKey: instanceKey(pool), tokens: tokenArgs.split(",").map(a => ethers.getAddress(a).toLowerCase()),
  weights: weightArgs.split(",").map(BigInt), swapFee: BigInt(feeArg) };
const route = plugin.routes.project({ descriptor: d }).find(r => r.i === Number(iArg) && r.j === Number(jArg));
if (!route) throw Error("missing synthetic runtime direction");
const input = { descriptor: d, route, executor, source: SOURCE, runtimeEvidence: [] };
if (mode === "runtime") {
  for (const key of ["amountIn", "exactEvidence", "quotedAmountOut", "minAmountOut"]) Object.defineProperty(input, key, { get() { throw Error("runtime read " + key); } });
  const leg = plugin.execution.buildRuntimeLeg!(input); if (!leg) throw Error("runtime declined"); process.stdout.write(leg.program);
} else if (mode === "fragment") {
  const amountIn = BigInt(amountArg), amountOut = BigInt(minArg);
  const fragment = plugin.execution.buildFragment({ ...input, amountIn, quotedAmountOut: amountOut, minAmountOut: amountOut,
    exactEvidence: { kind: "balancer-v1-chain-exact-in", source: SOURCE, binding: route.bindingRef.fingerprint,
      routeKey: route.routeKey, executor, amountIn, amountOut } });
  if (fragment.requirements.length || fragment.nodes.length !== 1) throw Error("unexpected fragment requirements");
  process.stdout.write(ethers.hexlify(plugin.actionAdapters[0].encode(fragment.nodes[0], executor, new Uint8Array())));
} else throw Error("unknown offline mode");
