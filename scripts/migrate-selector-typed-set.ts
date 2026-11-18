/** Migrate the actual BasicIssuance/Core execution entries from fdb859a. */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { E, R, U, check, read, approval, execution, model, math, mathStep, upsert, root, type Data } from "./selector-typed-migration-utils.js";
const rows: Data[] = [], WAD = 10n ** 18n;
const cap = (prefix: string) => E("join", [prefix, E("string", "$index")], "");
const ref = (prefix: string) => ({ runtime: cap(prefix) });
const field = (name: any, value: any) => E("objectFromEntries", [[name, value]]);
const value = (id: string, abi: string, signature: string) => E("decode", abi, signature, E("get", E("returned", id), "data"), 0);
const setGetter = "function getComponents() view returns(address[])";
const abi = { basket: [setGetter, "function getUnits() view returns(uint256[])", "function naturalUnit() view returns(uint256)"],
  core: ["function transferProxy() view returns(address)", "function vault() view returns(address)"] };
function binding(setPath: number, issue = false): Data {
  const requests = [{ id: "components", kind: "eth-call", to: `$args.${setPath}`, completion: "return-data", data: E("encode", "basket", "getComponents", []) },
    ...(issue ? ["transferProxy", "vault"].map(name => ({ id: name, kind: "eth-call", to: "$target", completion: "return-data", data: E("encode", "core", name, []) })) : [])];
  return { nomination: { poolIdPath: [setPath], poolNamespace: "component-basket", parameterPaths: [[setPath]] },
    flow: { version: 1, steps: [{ id: "basket", requirements: { transports: ["eth-call"] }, requests,
      result: { components: E("map", value("components", "basket", "getComponents"), "token", E("lower", E("address", "$token"))),
        ...(issue ? { transferProxy: value("transferProxy", "core", "transferProxy"), vault: value("vault", "core", "vault") } : {}) } }], result: "$steps.basket" },
    descriptor: { set: `$args.${setPath}`, components: "$binding.components",
      componentRows: E("map", "$binding.components", "token", { token: "$token", index: "$index" }),
      ...(issue ? { transferProxy: "$binding.transferProxy", vault: "$binding.vault", tokenIn: E("at", "$binding.components", 0), tokenOut: `$args.${setPath}` }
        : { tokenIn: `$args.${setPath}` }) },
    match: E("and", E("gt", E("length", "$binding.components"), 0),
      E("eq", E("length", E("unique", "$binding.components")), E("length", "$binding.components")),
      E("every", "$binding.components", "token", E("and", E("not", E("sameAddress", "$token", `$args.${setPath}`)), E("not", E("sameAddress", "$token", "$target")))),
      ...(issue ? [E("eq", E("length", "$binding.components"), 1)] : [])) };
}
function routes(issue = false): Data {
  return { resource: { target: "$descriptor.set" },
    ...(issue ? {} : { directions: E("map", "$descriptor.componentRows", "component", {
      id: E("join", ["redeem", E("string", "$component.index")], ":"), tokenIn: "$descriptor.set", tokenOut: "$component.token",
      taxonomy: { slotKind: "protocol", protocolAction: "redeem" }, fields: { componentIndex: "$component.index" },
    }) }) };
}
const basicUnits = model("basket-floor-units", ["input", "unit"], [
  ["numerator", "mul", "input", "unit"], ["minimum", "div", "numerator", WAD],
], ["minimum"]);
const legacyUnits = model("basket-natural-units", ["input", "unit", "natural"], [
  ["lots", "div", "input", "natural"], ["recomposed", "mul", "lots", "natural"], ["minimum", "mul", "lots", "unit"],
], ["recomposed", "minimum"]);
function envelopes(legacy: boolean): Data {
  const membership = { id: cap("member"), static: true, call: { target: "$descriptor.set", signature: setGetter, args: [],
    save: field(cap("member"), { arrayIndex: "$item.index", length: E("length", "$descriptor.components") }),
    checks: [check(ref("member"), "eq", E("uint", "$item.token"))] } };
  const units = { id: cap("unit"), static: true, call: { target: "$descriptor.set",
    signature: legacy ? "function getUnits() view returns(uint256[])" : "function getDefaultPositionRealUnit(address) view returns(int256)",
    args: legacy ? [] : ["$item.token"], save: field(cap("unit"), legacy ? { arrayIndex: "$item.index", length: E("length", "$descriptor.components") } : 0),
    checks: [check((1n << 255n) - 1n + "", "gte", ref("unit"))] } };
  const calculation = { id: cap("units"), math: { model: legacy ? "basketnaturalunits" : "basketfloorunits",
    inputs: { input: R("amountIn"), unit: ref("unit"), ...(legacy ? { natural: R("natural") } : {}) },
    outputs: E("merge", field("minimum", cap("minimum")), ...(legacy ? [field("recomposed", cap("recomposed"))] : [])),
    ...(legacy ? { checks: [check(ref("recomposed"), "eq", R("amountIn"))] } : {}) } };
  return E("map", E("chunks", "$descriptor.componentRows", 2), "group", {
    steps: E("concat", legacy ? [read("natural", "$descriptor.set", "function naturalUnit() view returns(uint256)", [], { natural: 0 }, [check(R("natural"), "gte", 1)])] : [],
      E("flatMap", "$group", "item", [membership, units, calculation])),
    effects: E("flatMap", "$group", "item", [
      { kind: "credit", token: "$item.token", account: E("if", E("sameAddress", "$item.token", "$route.tokenOut"), "$recipient", "$executor"), minimum: ref("minimum") },
      { kind: "unchanged-token", token: "$item.token", account: E("if", E("sameAddress", "$item.token", "$route.tokenOut"), "$executor", "$recipient"), when: "$externalRecipient" },
    ]),
  });
}
const handoff = E("map", E("chunks", E("filter", "$descriptor.components", "token", E("not", E("sameAddress", "$token", "$route.tokenOut"))), 8), "group", {
  effects: E("map", "$group", "token", { kind: "unchanged-token", token: "$token", account: "$executor" }),
});
const delta = model("fresh-receipt", ["after", "before"], [["receipt", "sub", "after", "before"]], ["receipt"]);
const basicSignature = "function redeem(address,uint256,address)";
const basic = execution([
  { ...read("opening", "$route.tokenOut", "function balanceOf(address) view returns(uint256)", ["$executor"], { opening: 0 }), when: "$externalRecipient" },
  { id: "redeem", call: { target: "$target", signature: basicSignature, args: ["$descriptor.set", R("amountIn"), "$executor"] } },
  { ...read("closing", "$route.tokenOut", "function balanceOf(address) view returns(uint256)", ["$executor"], { closing: 0 }), when: "$externalRecipient" },
  { ...mathStep("receipt", delta.id, { after: R("closing"), before: R("opening") }, { receipt: "receipt" }), when: "$externalRecipient" },
  { id: "handoff", when: "$externalRecipient", input: R("receipt"), envelopes: handoff,
    call: { target: "$route.tokenOut", signature: "function transfer(address,uint256)", args: ["$recipient", R("amountIn")] } },
]);
basic.envelopes = envelopes(false);
basic.protectedAddresses = E("concat", basic.protectedAddresses, "$descriptor.components");
basic.effects.push({ kind: "supply", token: "$route.tokenIn", direction: "decrease", equals: R("amountIn") });
rows.push(upsert(basicSignature, { parameters: [{ path: [0], role: "tokenIn" }, { path: [1], role: "amountIn" }, { path: [2], role: "recipient" }],
  values: { abi }, binding: binding(0), routes: routes(), execution: basic, runtimeMath: math([basicUnits, delta]),
  dependencies: E("concat", "$descriptor.components", ["$target", "$descriptor.set"]),
}, "set-redemption", "typed:set:basic-basket"));

const withdrawalSignature = "function redeemAndWithdrawTo(address,address,uint256,uint256)";
for (const unary of [true, false]) {
  const body = execution([{ id: "redeem", call: { target: "$target", signature: withdrawalSignature,
    args: ["$descriptor.set", "$recipient", R("amountIn"), U(0)] } }], unary);
  body.envelopes = envelopes(true);
  body.protectedAddresses = E("concat", body.protectedAddresses, "$descriptor.components");
  const bind = binding(0); bind.match = E("and", bind.match, E(unary ? "eq" : "gt", E("length", "$binding.components"), 1));
  rows.push(upsert(withdrawalSignature, { parameters: [{ path: [0], role: "tokenIn" }, { path: [1], role: "recipient" }, { path: [2], role: "amountIn" }],
    values: { abi }, binding: bind, routes: routes(), execution: body, runtimeMath: math([legacyUnits]),
    dependencies: E("concat", "$descriptor.components", ["$target", "$descriptor.set"]),
  }, "set-redemption", `typed:set:legacy-redemption:${unary ? "unary" : "basket"}`));
}

const issuance = model("natural-unit-issuance", ["input", "unit", "natural"], [
  ["lots", "div", "input", "unit"], ["recomposed", "mul", "lots", "unit"], ["quantity", "mul", "lots", "natural"],
], ["recomposed", "quantity"]);
const entryFee = model("recipient-net-entry-fee", ["quantity", "fee", "feeRecipient", "recipient"], [
  ["feeNumerator", "mul", "quantity", "fee"], ["feeAmount", "div", "feeNumerator", WAD],
  ["receivesFee", "eq", "feeRecipient", "recipient"], ["otherReceiver", "sub", 1, "receivesFee"],
  ["lostFee", "mul", "feeAmount", "otherReceiver"], ["minimum", "sub", "quantity", "lostFee"],
], ["minimum"]);
for (const to of [false, true]) for (const rebalancing of [false, true]) {
  const signature = to ? "function issueTo(address,address,uint256)" : "function issue(address,uint256)", setPath = to ? 1 : 0;
  const body = execution([
    read("membership", "$descriptor.set", setGetter, [], { member: { arrayIndex: 0, length: 1 } }, [check(R("member"), "eq", E("uint", "$route.tokenIn"))]),
    read("proxy", "$target", "function transferProxy() view returns(address)", [], { proxy: 0 }, [check(R("proxy"), "eq", E("uint", "$descriptor.transferProxy"))]),
    read("vault", "$target", "function vault() view returns(address)", [], { vault: 0 }, [check(R("vault"), "eq", E("uint", "$descriptor.vault"))]),
    read("oldCredit", "$descriptor.vault", "function getOwnerBalance(address,address) view returns(uint256)", ["$route.tokenIn", "$executor"], { oldCredit: 0 }, [check(R("oldCredit"), "eq", 0)]),
    read("units", "$descriptor.set", "function getUnits() view returns(uint256[])", [], { unit: { arrayIndex: 0, length: 1 } }, [check(R("unit"), "gte", 1)]),
    read("natural", "$descriptor.set", "function naturalUnit() view returns(uint256)", [], { natural: 0 }, [check(R("natural"), "gte", 1)]),
    mathStep("quantity", issuance.id, { input: R("amountIn"), unit: R("unit"), natural: R("natural") },
      { recomposed: "recomposed", quantity: "quantity" }, [check(R("recomposed"), "eq", R("amountIn"))]),
    ...(rebalancing ? [read("fee", "$descriptor.set", "function entryFee() view returns(uint256)", [], { fee: 0 }, [check(String(WAD - 1n), "gte", R("fee"))]),
      read("feeRecipient", "$descriptor.set", "function feeRecipient() view returns(address)", [], { feeRecipient: 0 }),
      mathStep("netReceipt", entryFee.id, { quantity: R("quantity"), fee: R("fee"), feeRecipient: R("feeRecipient"), recipient: E("uint", "$recipient") }, { minimum: "minimum" })] : []),
    read("oldAllowance", "$route.tokenIn", "function allowance(address,address) view returns(uint256)", ["$executor", "$descriptor.transferProxy"], { oldAllowance: 0 }, [check(R("oldAllowance"), "eq", 0)]),
    { id: "issue", approval: approval("$descriptor.transferProxy", false), call: { target: "$target", signature,
      args: [...(to ? ["$recipient"] : []), "$descriptor.set", R("quantity")] } },
    read("credit", "$descriptor.vault", "function getOwnerBalance(address,address) view returns(uint256)", ["$route.tokenIn", "$executor"], { credit: 0 }, [check(R("credit"), "eq", 0)]),
  ], to);
  body.protectedAddresses = E("concat", body.protectedAddresses, ["$descriptor.vault", "$descriptor.transferProxy"]);
  body.effects[1].minimum = R(rebalancing ? "minimum" : "quantity");
  body.effects.push({ kind: "supply", token: "$route.tokenOut", direction: "increase", equals: R("quantity") });
  rows.push(upsert(signature, { parameters: [{ path: [setPath], role: "tokenOut" }, ...(to ? [{ path: [0], role: "recipient" }] : [])],
    values: { abi }, binding: binding(setPath, true), routes: routes(true), execution: body,
    runtimeMath: math(rebalancing ? [issuance, entryFee] : [issuance]),
    dependencies: E("concat", "$descriptor.components", ["$target", "$descriptor.set", "$descriptor.vault", "$descriptor.transferProxy"]),
  }, "set-redemption", `typed:set:legacy-issue:${to ? "to" : "self"}:${rebalancing ? "fee" : "plain"}`));
}

writeFileSync(resolve(root, "listener/src/searcher/generated/selector-typed-set-migration.generated.json"), JSON.stringify({
  baseCommit: "fdb859a9b9b606a38c3b7afa52452752849ee465", rows,
  observationOnly: [
    { signature: "redeem(address,uint256)", reason: "Original Core observation pattern credits the vault; its implemented execution used redeemAndWithdrawTo, now a separate selector family." },
    { signature: "redeemTo(address,address,uint256)", reason: "Original Core observation pattern credits the vault; its implemented execution used redeemAndWithdrawTo, now a separate selector family." },
  ],
}, null, 2) + "\n");
console.log(JSON.stringify({ typedSetPrograms: rows.length, selectors: [...new Set(rows.map(row => row.selector))] }));
