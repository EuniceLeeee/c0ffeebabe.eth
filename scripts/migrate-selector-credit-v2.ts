import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

/** One-time migration only. Production loads the emitted v2 data, never this
 * script or the archived root schema. */
const base = process.argv[process.argv.indexOf("--base-source-root") + 1];
if (!process.argv.includes("--base-source-root") || !base) throw new Error("--base-source-root required");
const root = resolve(import.meta.dirname, "..");
const old = JSON.parse(readFileSync(resolve(base, "listener/src/searcher/venues/credit/fluid-family/fluid.json"), "utf8"));
const op = (name: string, ...args: any[]) => ({ op: name, args });
const u = (value: any) => op("uint", typeof value === "bigint" ? String(value) : value);
const set = (name: string, value: any, when?: any) => ({ let: name, value, ...(when === undefined ? {} : { when }) });
const check = (assert: any, error: string) => ({ assert, error });
const ret = (value: any, when?: any) => ({ return: value, ...(when === undefined ? {} : { when }) });
const max = (1n << 256n) - 1n, int127 = (1n << 127n) - 1n, int128 = 1n << 128n;
const q96 = 1n << 96n, e26 = 10n ** 26n, minRatio = 37075072n;
const maxRatio = 169307877264527972847801929085841449095838922544595n;
const factors = [4626198540796508716348404308345255985n,21508599537851153911767490449162n,46377364670549310883002866649n,
  2153540449365864845468344760n,464062544207767844008185025n,215421109505955298802281577n,146772309890508740607270615n,
  121149622323187099817270416n,110067989135437147685980801n,104913292358707887270979600n,102427189924701091191840928n,
  101206318935480056907421313n,100601351350506250000000000n,100300225000000000000000000n,100150000000000000000000000n];
const unsigned = (value: any) => op("and", op("eq", value, u(value)), op("gte", value, u("0")), op("lte", value, u(max)));
const tick = [check(op("and", op("gte", "$ratio", u(minRatio)), op("lte", "$ratio", u(maxRatio))), "credit ratio outside tick range"),
  set("negative", op("lt", "$ratio", u(q96))), set("factor", op("if", "$negative", op("div", op("mul", u(q96), u(e26)), "$ratio"), op("div", op("mul", "$ratio", u(e26)), u(q96)))),
  set("tick", u("0")), ...factors.flatMap((factor, index) => [set("matched", op("gte", "$factor", u(factor))),
    set("tick", op("add", "$tick", u(1n << BigInt(14 - index))), "$matched"), set("factor", op("div", op("mul", "$factor", u(e26)), u(factor)), "$matched")]),
  ret(op("if", "$negative", op("sub", u("-1"), "$tick"), "$tick"))];
const debt = (amount: any) => op("add", op("div", op("mul", amount, u(10n ** 12n)), "$borrowExchangePrice"), u("1"));
const rawDebt = (principal: any) => op("add", principal, op("div", op("mul", principal, "$borrowFeeBps"), u("10000")));
const adjusted = (value: any) => op("add", op("div", op("mul", value, u("1000000001")), u("1000000000")), u("1"));
const within = [set("principal", debt("$amount")), set("debtRaw", rawDebt("$principal")), ret(false, op("gte", "$debtRaw", u(int128))),
  set("ratio", op("div", op("mul", adjusted("$debtRaw"), u(q96)), "$collateralRaw")),
  ret(op("or", op("lt", "$ratio", u(minRatio)), op("and", op("lte", "$ratio", u(maxRatio)),
    op("lte", op("add", op("program", "tick", { ratio: "$ratio" }), u("1")), "$cfTick"))))];
const search = [set("mid", op("div", op("add", op("add", "$low", "$high"), u("1")), u("2"))),
  set("within", op("program", "within", { amount: "$mid" })),
  ret({ low: op("if", "$within", "$mid", "$low"), high: op("if", "$within", "$high", op("sub", "$mid", u("1"))) })];
const names = ["amountIn", "oracleRate", "collateralFactorBps", "borrowFeeBps", "supplyExchangePrice", "borrowExchangePrice", "debtBps"];
const borrow = [check(op("eq", op("length", "$input"), 7), "credit ceiling requires seven integer inputs"),
  ...names.flatMap((name, index) => [set(name, op("at", "$input", index)), check(unsigned(`$${name}`), `credit ${name} must be uint256`)]),
  check(op("and", op("gte", "$amountIn", u("10000")), op("lte", "$amountIn", u(int127)), op("gte", "$oracleRate", u(10n ** 9n)), op("lte", "$oracleRate", u(10n ** 54n)),
    op("gt", "$collateralFactorBps", u("0")), op("lte", "$collateralFactorBps", u("10000")), op("lte", "$borrowFeeBps", u("1023")),
    op("gt", "$supplyExchangePrice", u("0")), op("gt", "$borrowExchangePrice", u("0")), op("gt", "$debtBps", u("0")), op("lte", "$debtBps", u("10000"))), "credit invalid current borrow parameters"),
  set("collateralRaw", op("div", op("mul", "$amountIn", u(10n ** 12n)), "$supplyExchangePrice")),
  check(op("and", op("gt", "$collateralRaw", u("0")), op("lt", "$collateralRaw", u(int128))), "credit collateral outside position bounds"),
  set("rawOracle", op("div", op("mul", "$oracleRate", "$supplyExchangePrice"), "$borrowExchangePrice")),
  set("cappedOracle", op("min", "$rawOracle", u(10n ** 45n))),
  set("cfTick", op("program", "tick", { ratio: op("div", op("mul", op("div", op("mul", "$cappedOracle", "$collateralFactorBps"), u("10000")), u(q96)), u(10n ** 27n)) })),
  set("bounds", { low: u("0"), high: op("min", u(int127), op("div", op("mul", op("mul", "$amountIn", "$oracleRate"), "$collateralFactorBps"), op("mul", u(10n ** 27n), op("add", u("10000"), "$borrowFeeBps")))) }),
  ...Array.from({ length: 127 }, () => set("bounds", op("program", "search", { low: "$bounds.low", high: "$bounds.high" }), op("lt", "$bounds.low", "$bounds.high"))),
  check(op("eq", "$bounds.low", "$bounds.high"), "credit ceiling search did not converge"),
  set("requested", op("div", op("mul", "$bounds.low", "$debtBps"), u("10000"))), set("principal", debt("$requested")), set("debtRaw", rawDebt("$principal")), set("netDebtRaw", adjusted("$debtRaw")),
  check(op("and", op("gte", "$requested", u("10000")), op("gte", "$netDebtRaw", u("10000"))), "credit below minimum borrow amount"),
  { evaluate: op("program", "tick", { ratio: op("div", op("mul", "$netDebtRaw", u(q96)), "$collateralRaw") }) }, ret("$requested")];
const config = [check(op("eq", op("length", "$input"), 1), "credit config requires one packed word"), set("packed", op("at", "$input", 0)), check(unsigned("$packed"), "credit config must be uint256"),
  set("oracle", op("address", op("bytes", op("abiEncode", ["uint256"], [op("shrUint", "$packed", u("96"))]), 12, 20))),
  set("collateralFactorBps", op("mul", op("andUint", op("shrUint", "$packed", u("32")), u("1023")), u("10"))),
  set("borrowFeeBps", op("andUint", op("shrUint", "$packed", u("82")), u("1023"))),
  check(op("and", op("ne", "$oracle", "0x0000000000000000000000000000000000000000"), op("gt", "$collateralFactorBps", u("0")), op("lte", "$collateralFactorBps", u("10000")), op("lte", "$borrowFeeBps", u("1023"))), "credit invalid oracle/collateral factor"),
  ret({ oracle: "$oracle", collateralFactorBps: "$collateralFactorBps", borrowFeeBps: "$borrowFeeBps" })];
const math = { version: 1, entries: old.modules.math.entries, models: [
  { id: "fluid-credit:config-state", version: 1, program: config },
  { id: "fluid-credit:max-borrow-request", version: 1, values: { programs: { tick, within, search } }, program: borrow },
] };

const profile = old.identity.definition.identity;
const active = JSON.parse(JSON.stringify(profile.stages.active), (_key, value) => {
  if (typeof value === "string") return value.replaceAll("$evidence.constants.", "$steps.assets.")
    .replaceAll("$evidence.source", "$steps.assets.source").replaceAll("$constants.probeActor", "$executor");
  if (value && value.kind === "verified-actor") return { kind: "executor" };
  return value;
});
active.requirements.caller = "executor";
active.requests[0].call.executionMode = op("if", op("defined", "$transactionOrigin"), "impersonated-call-frame", "top-level");
active.decode = active.decode.filter((row: any) => !Object.hasOwn(row, "return"));
active.decode.push(check("$active", "credit binding requires actual collateral debit and debt receipt"), ret("$steps.assets"));
const assets = {
  id: "assets", requirements: { transports: ["eth-call"] },
  requests: [{ id: "vault-constants", kind: "eth-call", to: "$target", data: op("encode", "vault", "constantsView", []), completion: "return-data" }],
  decode: [set("source", op("source", "$results")), set("assetConstants", op("decodeCanonical", "vault", "constantsView", op("get", op("returned", "vault-constants"), "data"), 0)),
    set("supplyToken", op("address", op("at", "$assetConstants", 4))), set("borrowToken", op("address", op("at", "$assetConstants", 5))),
    set("supplyDecimals", op("number", op("at", "$assetConstants", 6))), set("borrowDecimals", op("number", op("at", "$assetConstants", 7))),
    check(op("and", op("ne", "$supplyToken", "0x0000000000000000000000000000000000000000"), op("ne", "$borrowToken", "0x0000000000000000000000000000000000000000"),
      op("not", op("sameAddress", "$supplyToken", "$borrowToken")), op("gte", "$supplyDecimals", 0), op("lte", "$supplyDecimals", 36), op("gte", "$borrowDecimals", 0), op("lte", "$borrowDecimals", 36)), "credit invalid asset parameters"),
    ret({ source: "$source", vault: "$target", supplyToken: "$supplyToken", borrowToken: "$borrowToken", supplyDecimals: "$supplyDecimals", borrowDecimals: "$borrowDecimals" })],
};
const constants = { ...old.standard.constants };
for (const key of ["familyId", "lineageId", "probeActor", "probeEvidenceId"]) delete constants[key];
const credit = JSON.parse(JSON.stringify(old.credit));
credit.position.key = op("hash", { familyId: "$descriptor.familyId", instanceKey: "$descriptor.instanceKey", routeKey: "$route.routeKey", lifecycle: "standing-position" });
const value = {
  format: "selector-family/v2", selector: "0x032d2276", signature: "function operate(uint256,int256,int256,address) payable returns(uint256,int256,int256)", domain: "credit",
  activation: { enabled: true, envKey: "SEARCHER_FAMILY_FLUID_CREDIT_ENABLED" },
  meta: { label: "Fluid Vault T1 collateral/debt position", migratedFrom: "credit/fluid-family/fluid.json",
    identity: { label: "Fluid Vault T1" }, positionPolicy: "Standing positions still require final position and repayment proof." },
  values: { abi: { vault: old.standard.abi.vault, erc20: old.standard.abi.erc20, state: old.standard.abi.state }, constants, inputs: ["transactionOrigin", "prefix"] },
  binding: { flow: { version: 1, steps: [assets, { id: "active", ...active }], result: "$steps.active" },
    descriptor: { vault: "$binding.vault", tokenIn: "$binding.supplyToken", tokenOut: "$binding.borrowToken", supplyToken: "$binding.supplyToken", borrowToken: "$binding.borrowToken", supplyDecimals: "$binding.supplyDecimals", borrowDecimals: "$binding.borrowDecimals" } },
  routes: { directions: [{ id: "collateral-debt", tokenIn: "$descriptor.supplyToken", tokenOut: "$descriptor.borrowToken", taxonomy: { slotKind: "lend" }, fields: { lifecycle: "standing-position" } }] },
  execution: old.standard.execution, math, credit,
  pricing: { flow: old.modules.pricingFlow, projection: { checks: old.modules.pricingProjection.checks, rows: old.modules.pricingProjection.rows }, liveState: old.modules.liveStateProjection.result },
};
const file = "listener/src/searcher/venues/selector-native/selector-032d2276-family/selector-032d2276.json";
mkdirSync(resolve(root, file, ".."), { recursive: true });
writeFileSync(resolve(root, file), `${JSON.stringify(value, null, 2)}\n`);
writeFileSync(resolve(root, "scripts/selector-credit-v2-migration.json"), `${JSON.stringify({ base: "fdb859a9b9b606a38c3b7afa52452752849ee465", source: "credit/fluid-family/fluid.json",
  destination: file, enabled: true, domain: "credit", selector: value.selector, execution: "operate(collateral,debt,new-position)",
  preserved: ["current config/oracle/exchange-price reads", "integer CF/tick/fee rounding model", "three source-bound debt fractions", "actual position/return/token-delta proof", "exact-clear approval", "standing-position/final repayment gate"],
  removedIdentityGates: ["factory reverse lookup", "vault/token code identity", "fixed probe actor"],
  normalization: "same selector + full ABI owns candidate, instance and route; metadata is not semantic",
  baseNonEntry: { action: "fluid-dex-liquidate", selector: "0x8433ea22", signature: "liquidate(uint256,uint256,address,bool)",
    destination: "listener/src/searcher/venues/selector-native/selector-8433ea22-family/selector-8433ea22.json", status: "observed-only",
    reason: "Base action/trace registration only; no projected route, Exact quote or execution recipe existed." },
}, null, 2)}\n`);
console.log(JSON.stringify({ written: file, bytes: JSON.stringify(value).length, pureModels: math.models.length }));
