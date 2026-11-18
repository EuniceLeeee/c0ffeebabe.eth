/** One-time data migration from the pinned typed execution contracts. This
 * script and its source audit are never imported by production. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeSelectorNativeExecutionDefinition } from "../listener/src/searcher/venues/selector-native-definition.js";
import { root, upsert, effects, model, math, mathStep, R, type Data } from "./selector-typed-migration-utils.js";

const ALGEBRA_CALL = "function swap(address recipient,bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96,bytes data) returns(int256 amount0,int256 amount1)";
const KYBER_CALL = "function swap(address recipient,int256 amountSpecified,bool zeroForOne,uint160 sqrtPriceLimitX96,bytes data) returns(int256 amount0,int256 amount1)";
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function transform(value: any, rewrite: (value: string) => string): any {
  if (typeof value === "string") return rewrite(value);
  if (Array.isArray(value)) return value.map(item => transform(item, rewrite));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,transform(item,rewrite)]));
  return value;
}

export function typedCallbackPrograms(template: Data): { algebra: Data; kyber: Data } {
  const source = clone(template);
  const make = (kind: "algebra" | "kyber"): Data => {
    const call = kind === "algebra" ? ALGEBRA_CALL : KYBER_CALL;
    const callback = kind === "algebra" ? "algebraSwapCallback" : "swapCallback";
    let program = transform(source, text => text.replaceAll("uniswapV3SwapCallback",callback)
      .replaceAll("univ3",kind).replaceAll("pancake-v3",kind));
    program.binding.nomination = { parameterPaths: [[kind === "algebra" ? 1 : 2]] };
    // These copied annotations never participate in calldata, settlement or
    // simulation pricing. Requiring their getters would recreate a protocol
    // identity gate for an otherwise compatible execution selector.
    const annotations = ["fee", "tickSpacing"];
    for (const key of annotations) {
      delete program.values.abi[`bindingpool${key}`];
      delete program.binding.descriptor.args[0][key];
      delete program.binding.flow.result.pool[key];
      for (const step of program.binding.flow.steps) {
        step.requests = step.requests.filter((request: any) => request.id !== `selectorBinding:pool:${key}`);
        delete step.result[key];
      }
      for (const direction of program.routes.directions) delete direction.fields[key];
    }
    program.routes.checks = program.routes.checks.filter((check: any) => !JSON.stringify(check.assert).match(/"(?:fee|tickSpacing)"/));
    const frames = [...program.execution.steps.map((step: any) => step.frame), program.execution.framedSettlement.frame];
    for (const frame of frames) {
      frame.call.signature = call;
      if (kind === "kyber") [frame.call.args[1],frame.call.args[2]] = [frame.call.args[2],frame.call.args[1]];
      frame.call.checks[0].operator = "eq";
    }
    program.execution.protectedAddresses = ["$target", "$route.tokenIn", "$route.tokenOut"];
    program.execution.effects = effects(true);
    // The signed return is checked against this invocation's measured output,
    // including direct settlement. Deferred frames already prove gross output
    // against their signed returnedWords after the continuation.
    program.runtimeMath = math([model("signedOutputMagnitude", ["word"], [
      ["inverse", "sub", ((1n << 256n) - 1n).toString(), "word"],
      ["magnitude", "add", "inverse", "1"],
    ], ["magnitude"])]);
    program.execution.steps.push({ ...mathStep("returnMagnitude", "signedOutputMagnitude", {
      word: R("returnedCreditWord"),
    }, { magnitude: "returnedOutput" }), when: "$fundedSettlement" });
    const outputEffect = program.execution.effects[1];
    program.execution.effects.splice(1, 1,
      { ...outputEffect, equals: R("returnedOutput"), when: "$fundedSettlement" },
      { ...outputEffect, when: "$deferredSettlement" });
    const swap = clone(program.observations.events.find((event: any) => event.classification === "swap"));
    swap.id = "swap-receipt";
    swap.signature = kind === "algebra"
      ? "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 overrideFee,uint24 pluginFee)"
      : "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)";
    // The generic runtime owns simulation state. A receipt from a different
    // curve must never be injected as UniV3 local price/state evidence.
    delete swap.payload.exactPostState; delete swap.impact.v3PostState;
    const mutation = program.observations.events.find((event: any) => event.classification === "mutation");
    const mutationSignatures = kind === "algebra" ? [
      "event Initialize(uint160 price,int24 tick)",
      "event Mint(address sender,address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)",
      "event Burn(address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1,uint24 pluginFee)",
      "event Fee(uint16 fee)", "event Plugin(address newPluginAddress)", "event PluginConfig(uint8 newPluginConfig)",
      "event TickSpacing(int24 newTickSpacing)", "event CommunityFee(uint16 communityFeeNew)",
    ] : [
      "event Mint(address indexed sender,address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)",
      "event Burn(address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)",
      "event BurnRTokens(address indexed owner,uint256 qty,uint256 qty0,uint256 qty1)",
    ];
    program.observations.events = [swap,...mutationSignatures.map((signature,index) => ({ ...clone(mutation), id: `mutation-${index}`, signature }))];
    program.observations.calls = [{ ...program.observations.calls[0], id: "swap-call", signature: call }];
    program.observations.canonicalIntakeTargets = [];
    program.refreshPolicy = "on-touch";
    program.routes.resource = { target: "$descriptor.pool" };
    return program;
  };
  return { algebra: make("algebra"), kyber: make("kyber") };
}

function main() {
  const index = process.argv.indexOf("--base-directory");
  if (index < 0 || !process.argv[index + 1]) throw new Error("--base-directory must identify the pinned fdb859a source checkout");
  const base = realpathSync(process.argv[index + 1]!);
  const templatePath = resolve(root,"listener/src/searcher/venues/selector-native/selector-128acb08-family/selector-128acb08.json");
  const definition = normalizeSelectorNativeExecutionDefinition(JSON.parse(readFileSync(templatePath,"utf8")));
  const template = definition.programs.find(program => JSON.stringify(program.execution).includes("uniswapV3SwapCallback"));
  if (!template) throw new Error("the independently migrated UniV3 data template is missing");
  const programs = typedCallbackPrograms(template), rows = [
    upsert(ALGEBRA_CALL,programs.algebra,"algebra-integral","typed-algebra-integral-exact-input",false,"swap"),
    upsert(KYBER_CALL,programs.kyber,"kyberswap-elastic","typed-kyberswap-elastic-exact-input",false,"swap"),
  ];
  const sources = ["algebra-integral","kyberswap-elastic"].flatMap(family => [
    ...["abi","execution","direct","routes","swap"].map(file => `listener/src/searcher/venues/swaps/${family}-family/${file}.ts`),
    `listener/src/searcher/venues/production-families/${family}.production.ts`,
  ]).map(file => ({ file, sha256: createHash("sha256").update(readFileSync(resolve(base,file))).digest("hex") }));
  const report = { sourceCommit:"fdb859a9b9b606a38c3b7afa52452752849ee465", sources, rows,
    preserved:["selector and argument order","signed exact-input amount guard","authenticated callback debt cap and negative credit","both token directions",
      "actual debit/receipt and signed return checks","direct receiver balance isolation","deferred payment continuation and output floor",
      "physical pool touched association","swap and mutation receipt events","source-bound funded startup simulation pricing"],
    defaults:"Algebra shares the already-enabled 128acb08 selector family; the independent Kyber selector remains disabled by default.",
    changes:"Historical protocol identity/factory gates, unused fee/tick-spacing getters and protocol quoter RPCs are absent. Token0/token1 bind the execution direction; current execution validity and prices use funded simulation. Full input and external-recipient isolation are enforced on ordinary execution as well as direct settlement.",
    runtimeDependenciesOnTypedSources:[] };
  writeFileSync(resolve(root,"scripts/selector-typed-c-migration.json"),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify({ migrated:rows.length, selectors:rows.map(row=>row.selector) }));
}
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) main();
