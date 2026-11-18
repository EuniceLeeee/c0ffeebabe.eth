/** Offline migration only; the production closure contains the generated JSON. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { root, upsert, effects, E, R, U, check, type Data } from "./selector-typed-migration-utils.js";

const ORDER = "tuple(address maker,uint256 traits,bytes data)";
const SWAP = `function swap(${ORDER} order,address tokenIn,address tokenOut,uint256 amount,bytes takerTraitsAndData) returns(uint256 amountIn,uint256 amountOut,bytes32 orderHash)`;
const QUOTE = `function quote(${ORDER} order,address tokenIn,address tokenOut,uint256 amount,bytes takerTraitsAndData) returns(uint256 amountIn,uint256 amountOut,bytes32 orderHash)`;
const CALLBACK = "function preTransferInCallback(address maker,address taker,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut,bytes32 orderHash,bytes data)";
const hash = E("codeHash", E("abiEncode", [ORDER], ["$args.0"]));
const receiver = E("if", "$externalRecipient", E("bytes", E("abiEncode", ["address"], ["$recipient"]), 12, 20), "0x");
const minimum = E("abiEncode", ["uint256"], ["$minAmountOut"]);
const slices = (amount: any, recipient: any, payload: any = "0x") => [amount, recipient, "0x", "0x", "0x", "0x", "0x", payload, "0x", "0x"];
const packed = (minimum: any, recipient: any) => E("packedSlices", 16, 16, 97, slices(minimum, recipient));
const quoteExpected = E("if", "$deferredSettlement", { quoteOutput: "output" }, "0");
const swapArgs = ["$descriptor.order", "$route.tokenIn", "$route.tokenOut", R("amountIn")];
const returnChecks = [check(R("returnedInput"), "eq", R("amountIn")),
  check(R("returnedHash"), "eq", U("0"))];
returnChecks[1].right = E("uint", "$descriptor.strategyHash");

const program: Data = {
  values: { abi: { registry: ["function AQUA() view returns(address)"] } },
  binding: {
    nomination: { tokenInPath: [1], tokenOutPath: [2], amountInPath: [3], parameterPaths: [[0]] },
    flow: { version: 1, steps: [{ id: "registry", requirements: { transports: ["eth-call"] },
      requests: [{ id: "registry", kind: "eth-call", to: "$target", data: E("encode", "registry", "AQUA", []), completion: "return-data" }],
      decode: [{ return: E("lower", E("address", E("decode", "registry", "AQUA", E("get", E("returned", "registry"), "data"), 0))) }],
    }], result: { registry: "$steps.registry" } },
    descriptor: { order: "$args.0", maker: E("lower", E("address", "$args.0.0")), registry: "$binding.registry",
      strategyHash: hash, poolId: hash, poolNamespace: E("lower", "$target") },
  },
  routes: {
    venue: { kind: "registered-strategy", app: "$descriptor.target", maker: "$descriptor.maker", strategyHash: "$descriptor.strategyHash",
      poolId: "$descriptor.poolId", poolNamespace: "$descriptor.poolNamespace" },
    resource: { target: "$descriptor.registry", poolId: "$descriptor.poolId", poolNamespace: "$descriptor.poolNamespace" },
    resources: [
      { target: "$descriptor.registry", poolId: "$descriptor.poolId", poolNamespace: "$descriptor.poolNamespace" },
      { target: "$route.tokenIn", poolId: "$descriptor.maker", poolNamespace: "erc20-balance" },
      { target: "$route.tokenOut", poolId: "$descriptor.maker", poolNamespace: "erc20-balance" },
    ],
    checks: [{ assert: E("ne", "$descriptor.registry", "0x0000000000000000000000000000000000000000"), error: "execution registry must be an address" }],
  },
  execution: {
    version: 2, settlement: { directOutput: true }, requireCanonicalSource: true,
    protectedAddresses: ["$target", "$descriptor.registry", "$descriptor.maker", "$route.tokenIn", "$route.tokenOut"],
    steps: [{ id: "swap", call: { target: "$target", signature: SWAP, args: [...swapArgs, packed(minimum, receiver)],
      save: { returnedInput: 0, returnedOutput: 1, returnedHash: 2 }, checks: returnChecks },
      approval: { token: "$route.tokenIn", spender: "$target", mode: "exact-clear", requireBool: false, verifyAllowance: true },
    }],
    deferred: { stepId: "swap", dataArgument: 4,
      dataLayout: { kind: "packed-slices", prefixBits: 16, offsetBits: 16, prefix: 69,
        slices: slices(minimum, "0x", { payload: "abi-bytes" }) },
      call: { target: "$target", signature: SWAP, args: swapArgs,
        save: { returnedInput: 0, returnedOutput: 1, returnedHash: 2 },
        checks: [...returnChecks, check(R("returnedOutput"), "eq", quoteExpected)] },
      callback: { signature: CALLBACK, dataArgument: 7, dataLayout: { kind: "abi-bytes" }, debtArgument: 4, outputArgument: 5,
        expectedDebt: R("amountIn"), expectedOutput: quoteExpected,
        bindings: [{ argument: 0, equals: "$descriptor.maker" }, { argument: 1, equals: "$executor" },
          { argument: 2, equals: "$route.tokenIn" }, { argument: 3, equals: "$route.tokenOut" }, { argument: 6, equals: E("uint", "$descriptor.strategyHash") }],
        payment: { mode: "approve-pull", recipient: "$target", requireBool: false, verifyAllowance: true },
      },
    },
    effects: effects(true).map(effect => effect.kind === "credit" ? { ...effect, equals: R("returnedOutput") } : effect),
  },
  quoteOutput: { version: 1, steps: [{ id: "quote", static: true,
    call: { target: "$target", signature: QUOTE,
      args: [...swapArgs, packed(E("abiEncode", ["uint256"], ["1"]), receiver)],
      save: { quotedInput: 0, quotedOutput: 1, quotedHash: 2 }, checks: [
        check(R("quotedInput"), "eq", R("amountIn")), check(R("quotedHash"), "eq", E("uint", "$descriptor.strategyHash")), check(R("quotedOutput"), "gte", "1"),
      ] },
  }], result: R("quotedOutput"), exports: { output: R("quotedOutput") } },
  observations: {
    version: 1, canonicalIntakeTargets: [], victimSupport: "detect-only",
    events: [{ id: "strategy-swap", signature: "event Swapped(bytes32 orderHash,address maker,address taker,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut)",
      classification: "swap", pool: "$args.orderHash", requireReadyBinding: true,
      valid: E("and", E("gt", "$args.amountIn", U(0)), E("gt", "$args.amountOut", U(0)), E("not", E("sameAddress", "$args.tokenIn", "$args.tokenOut"))),
      payload: { maker: "$args.maker", orderHash: "$args.orderHash", tokenIn: "$args.tokenIn", tokenOut: "$args.tokenOut", amountIn: "$args.amountIn", amountOut: "$args.amountOut" },
      poolBinding: { emitter: "$descriptor.bound.descriptor.target", id: "$descriptor.bound.descriptor.strategyHash" },
      match: E("and", E("sameAddress", "$edge.observationTarget", "$log.address"), E("sameAddress", "$descriptor.bound.descriptor.maker", "$args.maker"),
        E("eq", E("lower", "$descriptor.bound.descriptor.strategyHash"), E("lower", "$args.orderHash")),
        E("sameAddress", "$edge.tokenIn", "$args.tokenIn"), E("sameAddress", "$edge.tokenOut", "$args.tokenOut")),
      impact: { pool: "$edge.observationTarget", poolId: "$args.orderHash", tokenIn: "$args.tokenIn", tokenOut: "$args.tokenOut",
        amountIn: "$args.amountIn", amountOut: "$args.amountOut", matchedAdapterId: "$edge.adapterId" },
    }],
    calls: [{ id: "strategy-call", signature: SWAP, classification: "swap", payload: { pool: "$observation.target",
      tokenIn: "$args.tokenIn", tokenOut: "$args.tokenOut", amountIn: "$args.amount" } }],
  },
  dependencies: ["$descriptor.registry", "$descriptor.maker"], refreshPolicy: "on-touch",
};

const flag = process.argv.indexOf("--base-directory");
if (flag < 0 || !process.argv[flag + 1]) throw new Error("--base-directory must name the pinned fdb859a checkout");
const base = realpathSync(process.argv[flag + 1]!);
const row = upsert(SWAP, program, "aqua-swapvm", "typed-aqua-swapvm-registered-order", false, "swap");
const sources = ["codec", "runtime", "execution", "routes", "swap", "discovery"].map(file =>
  `listener/src/searcher/venues/swaps/aqua-swapvm-family/${file}.ts`).concat("listener/src/searcher/venues/production-families/aqua-swapvm.production.ts")
  .map(file => ({ file, sha256: createHash("sha256").update(readFileSync(resolve(base, file))).digest("hex") }));
writeFileSync(resolve(root, "scripts/selector-typed-aqua-migration.json"), JSON.stringify({
  sourceCommit: "fdb859a9b9b606a38c3b7afa52452752849ee465", sources, rows: [row], runtimeDependenciesOnTypedSources: [],
  preserved: ["dynamic order tuple and observed token pair", "order hash return commitment", "runtime amount in swap/quote",
    "0x61 ordinary packed slice layout", "0x45 output-first callback layout with nested ABI bytes",
    "same-transaction static quote-output", "fresh direct receiver receipt", "authenticated approve-pull deferred continuation",
    "old input/output/native inventory and allowance clearance", "strategy-specific receipt/touched binding"],
  changes: ["Identity, code-hash and strategy opcode profile are not admission gates; exact parameter/order binding and funded source-bound execution prove Ready",
    "The registry address is read as an execution resource binding; it is not a fixed protocol allowlist",
    "Physical resources include registered order and maker token balances, so alternative entries cannot spend the same underlying state independently",
    "ship is historical nomination, not a swap execution selector; its unknown census is retained without inventing a conversion edge"],
  default: "disabled, preserving the prior typed Family default", validation: "local byte-layout/VM and source-bound generic Ready tests; no mainnet claim",
}, null, 2) + "\n");
console.log(JSON.stringify({ migrated: 1, selector: row.selector, enabledByDefault: row.enabledByDefault }));
