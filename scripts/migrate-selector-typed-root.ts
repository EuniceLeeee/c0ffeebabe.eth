/** fdb859a typed execution -> independent selector-family/v2 author data. */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { E, R, U, check, read, approval, execution, model, math, mathStep, upsert, root, type Data } from "./selector-typed-migration-utils.js";
const rows: Data[] = [];
const put = (signature: string, program: Data, family: string, recipe: string, domain: "swap" | "protocol" = "protocol") =>
  rows.push(upsert(signature, program, family, recipe, false, domain));

// The original weighted-single-asset entry burns the caller's pod shares.
// Empty optional lists preserve that entry behavior; ABI observation lists are
// not permissions to select a different payout basket at execution time.
put("function debond(uint256,address[],uint8[])", {
  parameters: [{ path: [0], role: "amountIn" }, { path: [1], role: "bound" }, { path: [2], role: "bound" }],
  binding: { descriptor: { tokenIn: "$target" } },
  execution: execution([{ id: "debond", call: { target: "$target", signature: "function debond(uint256,address[],uint8[])",
    args: [R("amountIn"), [], []] } }], false),
}, "peapods-debond", "typed:peapods-debond:single-asset");

// Amount is sent by an ERC20 pretransfer, not an entry argument. Compare the
// vault's accounted inventory before/after as well as the actual input/output.
const spot = execution([
  read("openingBalance", "$route.tokenIn", "function balanceOf(address) view returns(uint256)", ["$target"], { openingBalance: 0 }),
  read("openingAccounted", "$target", "function tokenBalances(address) view returns(uint256)", ["$route.tokenIn"],
    { openingAccounted: 0 }, [check(R("openingAccounted"), "eq", R("openingBalance"))]),
  { id: "pay", call: { target: "$route.tokenIn", signature: "function transfer(address,uint256)", args: ["$target", R("amountIn")] },
    effects: [{ kind: "credit", token: "$route.tokenIn", account: "$target", equals: R("amountIn") }] },
  { id: "swap", call: { target: "$target", signature: "function swap(address,address,address) returns(uint256)",
    args: ["$route.tokenIn", "$route.tokenOut", "$recipient"], save: { output: 0 } } },
  read("closingAccounted", "$target", "function tokenBalances(address) view returns(uint256)", ["$route.tokenIn"], { closingAccounted: 0 }),
  read("closingBalance", "$route.tokenIn", "function balanceOf(address) view returns(uint256)", ["$target"],
    { closingBalance: 0 }, [check(R("closingBalance"), "eq", R("closingAccounted"))]),
]);
spot.effects[1].equals = R("output");
put("function swap(address,address,address) returns(uint256)", {
  parameters: [{ path: [0], role: "tokenIn" }, { path: [1], role: "tokenOut" }, { path: [2], role: "recipient" }],
  execution: spot,
}, "vault-spot", "typed:vault-spot:pretransfer-accounted", "swap");

// PSV and PSM share two entry signatures. They are separate execution rules
// under those same families; there is no protocol-name eligibility test.
for (const [entry, preview, scale, reserveIndex] of [
  ["sellGem", "previewSellGem", "gemToWad", 0], ["buyGem", "previewBuyGem", "stableToWad", 1],
] as const) {
  const terms = model("recipient-net-fee", ["net", "fee", "treasury", "recipient"], [
    ["gross", "add", "net", "fee"], ["treasuryMatch", "eq", "treasury", "recipient"],
    ["feeReceipt", "mul", "fee", "treasuryMatch"], ["receipt", "add", "net", "feeReceipt"],
  ], ["gross", "receipt"]);
  const cap = model("capacity-with-unlimited-zero", ["limit", "amount", "scale"], [
    ["unlimited", "eq", "limit", 0], ["unlimitedValue", "mul", "unlimited", (1n << 256n) - 1n],
    ["limitValue", "add", "limit", "unlimitedValue"], ["scaledAmount", "mul", "amount", "scale"],
  ], ["limitValue", "scaledAmount"]);
  const quote = { version: 1, steps: [
    read("active", "$target", "function paused() view returns(bool)", [], { paused: 0 }, [check(R("paused"), "eq", false)]),
    read("preview", "$target", `function ${preview}(uint256,address) view returns(uint256,uint256)`,
      [R("amountIn"), "$recipient"], { net: 0, fee: 1 }, [check(R("net"), "gte", 1)]),
    read("treasury", "$target", "function treasury() view returns(address)", [], { treasury: 0 }),
    mathStep("recipientTerms", terms.id, { net: R("net"), fee: R("fee"), treasury: R("treasury"), recipient: E("uint", "$recipient") },
      { gross: "gross", receipt: "receipt" }),
    read("reserves", "$target", "function getReserves() view returns(uint256,uint256)", [], { reserves: reserveIndex },
      [check(R("reserves"), "gte", R("gross"))]),
    read("scale", "$target", `function ${scale}() view returns(uint256)`, [], { scale: 0 }),
    read("perTransaction", "$target", "function maxPerTransaction() view returns(uint256)", [], { transactionLimit: 0 }),
    mathStep("transactionCapacity", cap.id, { limit: R("transactionLimit"), amount: R("amountIn"), scale: R("scale") },
      { limitValue: "limitValue", scaledAmount: "scaledAmount" }, [check(R("limitValue"), "gte", R("scaledAmount"))]),
    read("remainingCapacity", "$target", "function getRemainingBlockCapacity() view returns(uint256)", [], { remainingCapacity: 0 },
      [check(R("remainingCapacity"), "gte", R("scaledAmount"))]),
  ], result: R("receipt") };
  put(`function ${entry}(address,uint256) returns(uint256)`, {
    parameters: [{ path: [0], role: "recipient" }, { path: [1], role: "amountIn" }],
    runtimeMath: math([terms, cap]),
    execution: { ...execution([{ id: "convert", approval: approval(), call: { target: "$target",
      signature: `function ${entry}(address,uint256) returns(uint256)`, args: ["$recipient", R("amountIn")] } }]), quoteOutput: quote },
  }, "psv", `typed:psv:${entry}`);
}

// Budget-priced auctions: the input is a maximum payment, whereas the ABI's
// uint256 is an output quantity. Both are derived in the same VM invocation.
for (const signature of ["function take(address) returns(uint256)", "function take(address,uint256) returns(uint256)",
  "function take(address,uint256,address) returns(uint256)", "function take(address,uint256,address,bytes) returns(uint256)"]) {
  const count = signature.slice(signature.indexOf("(") + 1, signature.indexOf(")")).split(",").length;
  const direct = count >= 3, callback = count === 4;
  const tokenAbi = ["function decimals() view returns(uint8)"];
  const decimals = (id: string) => E("decode", "metadata", "decimals", E("get", E("returned", id), "data"), 0);
  const scale = (path: string) => E("pow", U(10), E("sub", U(18), path));
  const terms = model(count === 1 ? "auction-whole-capacity" : "auction-floor-inverse", ["budget", "quotedPrice", "soldScale", "denominator", "available", "receiver", "actor"], [
    ["receiverIsActor", "eq", "receiver", "actor"], ["price", "mul", "quotedPrice", "soldScale"],
    ["nextBudget", "add", "budget", 1], ["scaledBudget", "mul", "nextBudget", "denominator"],
    ["lastAffordable", "sub", "scaledBudget", 1], ["capacity", "div", "lastAffordable", "price"],
    ["quantity", "min", "available", "capacity"],
    ["numerator", "mul", "quantity", "price"], ["cost", "div", "numerator", "denominator"],
  ], ["quantity", "cost", "receiverIsActor"]);
  const quote = { version: 1, steps: [
    read("price", "$target", "function getAmountNeeded(address,uint256) view returns(uint256)",
      ["$route.tokenOut", "$descriptor.priceProbe"], { quotedPrice: 0 }, [check(R("quotedPrice"), "gte", "$descriptor.wantScale")]),
    read("available", "$target", "function available(address) view returns(uint256)", ["$route.tokenOut"], { available: 0 }),
    read("receiver", "$target", "function receiver() view returns(address)", [], { receiver: 0 }),
    mathStep("budget", terms.id, { budget: R("amountIn"), quotedPrice: R("quotedPrice"), soldScale: "$descriptor.soldScale",
      denominator: "$descriptor.denominator", available: R("available"), receiver: R("receiver"), actor: E("uint", "$executor") },
      { quantity: "quantity", cost: "cost", receiverIsActor: "receiverIsActor" }, [check(R("receiverIsActor"), "eq", 0),
        check(R("quantity"), "gte", 1), check(R("cost"), "gte", 1), check(R("amountIn"), "gte", R("cost")),
        ...(count === 1 ? [check(R("quantity"), "eq", R("available"))] : [])]),
  ], result: R("quantity"), exports: { quantity: R("quantity"), cost: R("cost") } };
  const args: any[] = ["$route.tokenOut", ...(count >= 2 ? [{ quoteOutput: "quantity" }] : []),
    ...(direct ? ["$recipient"] : []), ...(callback ? ["0x"] : [])];
  const body = execution([{ id: "take", approval: approval(), call: { target: "$target", signature, args,
    save: { actualQuantity: 0 }, checks: [check(R("actualQuantity"), "eq", { quoteOutput: "quantity" })] } }], direct);
  body.quoteOutput = quote;
  body.effects[0] = { kind: "debit", token: "$route.tokenIn", account: "$executor", maximum: R("amountIn"), equals: { quoteOutput: "cost" } };
  body.effects[1].equals = { quoteOutput: "quantity" };
  if (callback) body.deferred = { stepId: "take", dataArgument: 3, call: { target: "$target", signature,
    args: ["$route.tokenOut", { quoteOutput: "quantity" }, "$executor"], save: { actualQuantity: 0 },
    checks: [check(R("actualQuantity"), "eq", { quoteOutput: "quantity" })] }, callback: {
    signature: "function auctionTakeCallback(address,address,uint256,uint256,bytes)", dataArgument: 4, debtArgument: 3, outputArgument: 2,
    expectedDebt: { quoteOutput: "cost" }, expectedOutput: { quoteOutput: "quantity" },
    bindings: [{ argument: 0, equals: E("uint", "$route.tokenOut") }, { argument: 1, equals: E("uint", "$executor") }],
    payment: { mode: "approve-pull", recipient: "$target", requireBool: true, verifyAllowance: true },
  } };
  put(signature, {
    parameters: [{ path: [0], role: "tokenOut" }, ...(direct ? [{ path: [2], role: "recipient" }] : [])],
    values: { abi: { metadata: tokenAbi } },
    binding: { flow: { version: 1, steps: [{ id: "metadata", requirements: { transports: ["eth-call"] },
      requests: ["tokenIn", "tokenOut"].map(side => ({ id: side, kind: "eth-call", to: `$scope.${side}`,
        data: E("encode", "metadata", "decimals", []), completion: "return-data" })),
      result: { wantDecimals: decimals("tokenIn"), soldDecimals: decimals("tokenOut") } }], result: "$steps.metadata" },
      descriptor: { wantScale: scale("$binding.wantDecimals"), soldScale: scale("$binding.soldDecimals"),
        denominator: E("mul", U(10n ** 18n), scale("$binding.wantDecimals")),
        priceProbe: E("mul", E("pow", U(10), "$binding.soldDecimals"), scale("$binding.wantDecimals")) } },
    runtimeMath: math([terms]), execution: body, refreshPolicy: "each-block",
  }, "yearn-auction", `typed:yearn-auction:take-${count}`);
}

writeFileSync(resolve(root, "listener/src/searcher/generated/selector-typed-root-migration.generated.json"),
  JSON.stringify({ baseCommit: "fdb859a9b9b606a38c3b7afa52452752849ee465", rows }, null, 2) + "\n");
console.log(JSON.stringify({ typedRootPrograms: rows.length, rows }));
