import { ethers } from "ethers";
import { createDeclarativeSwapRuntime } from "./src/searcher/venues/declarative-swap.js";
import { defineSwapFamily } from "./src/searcher/venues/adapter-family-plugin.js";
import definition from "./src/searcher/venues/swaps/mooniswap-family/mooniswap.json" with { type: "json" };
import { mooniswapQuoteProgram } from "./src/searcher/venues/swaps/mooniswap-family/exact.js";
import { mooniswapRoutes } from "./src/searcher/venues/swaps/mooniswap-family/routes.js";
import { POOL, TOKEN, MAX_UINT } from "./src/searcher/venues/swaps/mooniswap-family/codec.js";
import { inspectRuntime } from "./src/searcher/test/runtime-program-testkit.js";

const runtime = createDeclarativeSwapRuntime(definition as any, []);
const plugin = defineSwapFamily(runtime.definition as any);
const source = { number: 1, hash: `0x${"ab".repeat(32)}`, generation: 1 };
const provenance = { kind: "synthetic", fingerprint: "x" };
const pool = ethers.getAddress("0x2c4ea51d9dec7cdabe2d1bde01882f87b5231d21");
const token0 = ethers.getAddress("0x1111111111111111111111111111111111111111");
const token1 = ethers.getAddress("0x2222222222222222222222222222222222222222");
const executor = ethers.getAddress("0x6666666666666666666666666666666666666666");
const codeHash = `0x${"88".repeat(32)}`;
const descriptor: any = { familyId: "mooniswap", lineageId: "mooniswap:verified-v2-runtime", instanceKey: pool.toLowerCase(),
  provenance: [], runtimeRequirements: [], pool, token0, token1, codeHash };
const routes = plugin.routes.project({ descriptor }) as any[];
const route = routes[0];
const amountIn = 123456789123456789n, amountOut = 987654321n;
const ok = (id: string, data: string) => ({ id, ok: true, source, provenance, completion: "returned", data });
const active = ok("active", new ethers.Interface(["function isActive() view returns(bool)"]).encodeFunctionResult("isActive", [true]));
const reads = [
  ok("get-return", POOL.encodeFunctionResult("getReturn", [amountOut])),
  ok("output-balance", TOKEN.encodeFunctionResult("balanceOf", [amountOut + 1n])),
  ok("input-balance", TOKEN.encodeFunctionResult("balanceOf", [10n ** 24n])),
  ok("governance", POOL.encodeFunctionResult("mooniswapFactoryGovernance", [ethers.getAddress("0x5555555555555555555555555555555555555555")])),
  ok("token0", POOL.encodeFunctionResult("token0", [token0])),
  ok("token1", POOL.encodeFunctionResult("token1", [token1])),
];
const method = plugin.exact.methods({ descriptor, route, amountIn, source, executor, runtimeEvidence: [] } as any).filter((m: any) => m.kind === "request-program")[0];
const quote = method.program.decode({ programInput: { descriptor, route, amountIn, source, executor, runtimeEvidence: [] }, initialResults: reads,
  dependentEvidence: [{ stepId: "governance", results: [active] }] } as any);
console.log("quote", quote.amountOut, Object.keys(quote.evidence));
const fragment = plugin.execution.buildFragment({ descriptor, route, amountIn, quotedAmountOut: quote.amountOut,
  minAmountOut: quote.amountOut, exactEvidence: quote.evidence, executor } as any);
const program = fragment.nodes[0].params.runtimeAmountProgram;
console.log("program length", (program.length - 2) / 2, "head", program.slice(0, 60));
let calls = 0;
try {
  const run = inspectRuntime(program, amountIn, {
    call(call: any) {
      calls++;
      const sel = call.data.slice(0, 10).toLowerCase();
      console.log("call", calls, "target", call.target, "selector", sel, "patches", JSON.stringify(call.patches), "data", call.data.slice(0, 200));
      if (sel === POOL.getFunction("getReturn")!.selector.toLowerCase()) return POOL.encodeFunctionResult("getReturn", [987654321n]);
      if (sel === TOKEN.getFunction("balanceOf")!.selector.toLowerCase()) return TOKEN.encodeFunctionResult("balanceOf", [10n ** 24n]);
      return "0x";
    },
    allowance(g: any) { console.log("allowance", g); },
    nativeBalance() { return 0n; },
  });
  console.log("registers", run.registers.map(String));
} catch (error) {
  console.log("program run failed after", calls, "calls", (error as Error).message);
  process.exitCode = 1;
}
