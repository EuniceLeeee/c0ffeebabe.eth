import { FunctionFragment, ZeroAddress, getAddress } from "ethers";
import { isDeepStrictEqual } from "node:util";
import { assertModuleData } from "./venues/declarative-modules.js";
import { normalizeSelectorNativeExecutionDefinition, validateSelectorDirectState } from "./venues/selector-native-definition.js";

// Build-time only. Execution compiles to a single template per selector;
// identity compiles declarative direction/pool confirmation options only.
type Data = Record<string, any>;
const obj = (x: unknown): x is Data => !!x && typeof x === "object" && !Array.isArray(x);
function need(v: unknown, s: string): asserts v { if (!v) throw Error("selector simulation source: " + s); }
function keys(v: unknown, names: string[]): asserts v is Data {
  need(obj(v) && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k)),
    "unexpected or missing fields: " + names.join(","));
}
const op = (name: string, ...args: unknown[]) => ({ op: name, args });
const ref = (runtime: string) => ({ runtime });

function optionId(value: unknown): asserts value is string {
  need(typeof value === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(value), "invalid stable option/template id");
}

function getter(s: unknown, type: string) {
  need(typeof s === "string", "invalid getter");
  const f = FunctionFragment.from(s);
  need(f.stateMutability === "view" && !f.inputs.length && f.outputs.length === 1 &&
    f.outputs[0]!.type === type && /^[a-zA-Z][a-zA-Z0-9]*$/.test(f.name) &&
    !["constructor", "prototype", "target", "direction", "tokenIn", "tokenOut"].includes(f.name),
    "expected a nullary, single-output identity getter");
  return f;
}

function directStateFromSource(sourceState: unknown, discoveryRuleHash: string): Data {
  need(obj(sourceState) && !Object.hasOwn(sourceState, "discoveryRuleHash"), "discovery fingerprint is generated, not authored");
  const state = { ...sourceState, discoveryRuleHash };
  validateSelectorDirectState(state);
  return state;
}

export function compileExecutionSource(source: unknown, discoveryRuleHash: string): Data {
  assertModuleData(source);
  if (obj(source)) {
    if (source.format === "simulated-execution-recipes/v1" || source.format === "selector-execution-template/v1") {
      return compileTemplateSource(source, discoveryRuleHash);
    }
    if (source.format === "simulated-psm-buy/v1") {
      return compilePsmBuySource(source, discoveryRuleHash);
    }
    if (source.format === "simulated-constant-product-swap/v1") {
      return compileConstantProductSwapSource(source, discoveryRuleHash);
    }
    if (source.format === "simulated-v3-callback-swap/v1") {
      return compileV3CallbackSwapSource(source, discoveryRuleHash);
    }
    if (source.format === "simulated-v4-unlock-swap/v1") {
      return compileV4UnlockSwapSource(source, discoveryRuleHash);
    }
  }
  const hasId = obj(source) && Object.hasOwn(source, "id");
  keys(source, ["format", ...(hasId ? ["id"] : []), "selector", "signature", "activation", "args", "approval", "state"]);
  if (hasId) optionId(source.id);
  need(source.format === "simulated-erc20-conversion/v2" && source.approval === "exact-clear", "unsupported simulation template");
  keys(source.state, ["pool", "assets", "watch", "on", "unclassifiedWatch"]);
  const state = directStateFromSource(source.state, discoveryRuleHash);
  const fn = FunctionFragment.from(source.signature), roles = source.args;
  need(fn.selector === source.selector && fn.stateMutability === "nonpayable" && Array.isArray(roles) && roles.length === 2 &&
    fn.inputs.length === 2 && fn.inputs.every((t, i) => ({ recipient: "address", amountIn: "uint256" } as Data)[roles[i]] === t.type) &&
    roles.includes("recipient") && roles.includes("amountIn"), "entry selector/argument roles differ from ABI");
  need(/^[a-zA-Z][a-zA-Z0-9]*$/.test(fn.name), "ambiguous ABI action name");
  const dir = fn.name.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  const amount = ref("amountIn");
  const execution = {
    version: 2,
    requireCanonicalSource: true,
    settlement: { directOutput: true },
    protectedAddresses: ["$target", "$route.tokenIn", "$route.tokenOut"],
    steps: [{
      id: "convert",
      approval: { token: "$route.tokenIn", spender: "$target", mode: "exact-clear", requireBool: true, verifyAllowance: true },
      call: { target: "$target", signature: source.signature, args: roles.map(r => r === "recipient" ? "$recipient" : amount) },
    }],
    effects: [
      { kind: "debit", token: "$route.tokenIn", account: "$executor", equals: amount },
      { kind: "credit", token: "$route.tokenOut", account: "$recipient", minimum: "$minAmountOut" },
      { kind: "unchanged-token", token: "$route.tokenIn", account: "$recipient", when: "$externalRecipient" },
      { kind: "unchanged-token", token: "$route.tokenOut", account: "$executor", when: "$externalRecipient" },
      { kind: "unchanged-native" },
    ],
  };
  const programs = [{
    type: "execution",
    resourceValues: { inputs: ["sqlEdge"] },
    projection: {
      descriptor: {
        tokenIn: op("address", "$sqlEdge.tokenIn"),
        tokenOut: op("address", "$sqlEdge.tokenOut"),
      },
    },
    routes: {
      directions: [{
        id: dir,
        enabled: true,
        tokenIn: "$descriptor.tokenIn",
        tokenOut: "$descriptor.tokenOut",
        taxonomy: { slotKind: "protocol", protocolAction: "convert" },
      }],
      resource: { target: "$descriptor.target" },
    },
    execution,
    refreshPolicy: "on-touch",
    sourceRefreshPolicy: "on-touch",
  }];
  const raw = {
    format: "selector-family/v2",
    selector: fn.selector,
    signature: source.signature,
    domain: "protocol",
    activation: source.activation,
    directState: state,
    programs,
  };
  normalizeSelectorNativeExecutionDefinition(raw);
  return raw;
}

function compilePsmBuySource(source: Data, discoveryRuleHash: string): Data {
  const hasId = Object.hasOwn(source, "id");
  keys(source, ["format", ...(hasId ? ["id"] : []), "selector", "signature", "activation", "args", "approval", "feeGetter", "scaleGetter", "state"]);
  if (hasId) optionId(source.id);
  need(source.approval === "exact-clear", "PSM buy template requires exact-clear approval");
  keys(source.state, ["pool", "assets", "watch", "on", "unclassifiedWatch"]);
  const state = directStateFromSource(source.state, discoveryRuleHash);
  const fn = FunctionFragment.from(source.signature), roles = source.args;
  need(fn.selector === source.selector && fn.stateMutability === "nonpayable" && Array.isArray(roles) && roles.length === 2 &&
    fn.inputs.length === 2 && fn.inputs.every((t, i) => ({ recipient: "address", gemAmount: "uint256" } as Data)[roles[i]] === t.type) &&
    roles.includes("recipient") && roles.includes("gemAmount"), "PSM buy entry selector/argument roles differ from ABI");
  const feeFn = getter(source.feeGetter, "uint256");
  const scaleFn = getter(source.scaleGetter, "uint256");
  need(feeFn.selector !== scaleFn.selector, "overlapping PSM fee/scale getter");
  const dir = hasId ? String(source.id) : "buy-gem";
  const programs = [{
    type: "execution",
    resourceValues: { inputs: ["sqlEdge"] },
    routes: {
      directions: [{
        id: dir,
        enabled: true,
        tokenIn: "$descriptor.tokenIn",
        tokenOut: "$descriptor.tokenOut",
        taxonomy: { slotKind: "protocol", protocolAction: "convert" },
      }],
      resource: { target: "$descriptor.target" },
    },
    execution: {
      version: 2,
      requireCanonicalSource: true,
      settlement: { directOutput: true },
      protectedAddresses: ["$target", "$route.tokenIn", "$route.tokenOut"],
      steps: [
        {
          id: "fee",
          static: true,
          call: { target: "$target", signature: source.feeGetter, args: [], save: { psmFee: 0 } },
        },
        {
          id: "scale",
          static: true,
          call: {
            target: "$target",
            signature: source.scaleGetter,
            args: [],
            save: { psmScale: 0 },
            checks: [{ left: ref("psmScale"), operator: "gte", right: 1 }],
          },
        },
        {
          id: "terms",
          math: {
            model: "psmTerms",
            inputs: { amountIn: ref("amountIn"), fee: ref("psmFee"), scale: ref("psmScale"), isBuy: op("uint", "1") },
            outputs: {
              callAmount: "psmCallAmount",
              expectedOut: "psmExpectedOut",
              expectedSpend: "psmExpectedSpend",
              expectedReturn: "psmExpectedReturn",
            },
            checks: [
              { left: "1000000000000000000", operator: "gte", right: ref("psmFee") },
              { left: ref("amountIn"), operator: "gte", right: ref("psmExpectedSpend") },
              { left: ref("psmCallAmount"), operator: "gte", right: 1 },
              { left: ref("psmExpectedOut"), operator: "gte", right: 1 },
            ],
          },
        },
        {
          id: "swap",
          approval: { token: "$route.tokenIn", spender: "$target", mode: "exact-clear", amount: ref("psmExpectedSpend"), requireBool: true },
          call: {
            target: "$target",
            signature: source.signature,
            args: roles.map((r: string) => r === "recipient" ? "$recipient" : ref("psmCallAmount")),
          },
          effects: [
            { kind: "debit", token: "$route.tokenIn", account: "$executor", equals: ref("psmExpectedSpend") },
            { kind: "credit", token: "$route.tokenOut", account: "$recipient", equals: ref("psmExpectedOut") },
          ],
        },
        {
          id: "allowance",
          static: true,
          call: {
            target: "$route.tokenIn",
            signature: "function allowance(address,address) view returns (uint256)",
            args: ["$executor", "$target"],
            save: { psmAllowance: 0 },
            checks: [{ left: ref("psmAllowance"), operator: "eq", right: 0 }],
          },
        },
      ],
      effects: [
        { kind: "debit", token: "$route.tokenIn", account: "$executor", maximum: ref("amountIn") },
        { kind: "credit", token: "$route.tokenOut", account: "$recipient", minimum: "$minAmountOut" },
        { kind: "unchanged-token", token: "$route.tokenOut", account: "$executor", when: "$externalRecipient" },
        { kind: "unchanged-token", token: "$route.tokenIn", account: "$recipient", when: "$externalRecipient" },
        { kind: "unchanged-native" },
      ],
    },
    runtimeMath: {
      version: 1,
      entries: { psmTerms: { model: "psm:runtime-terms", version: 1 } },
      models: [{
        id: "psm:runtime-terms",
        version: 1,
        inputs: ["amountIn", "fee", "scale", "isBuy"],
        outputs: ["callAmount", "expectedOut", "expectedSpend", "expectedReturn"],
        operations: [
          { name: "isSell", op: "sub", left: { constant: "1" }, right: { input: "isBuy" } },
          { name: "sellAmount", op: "mul", left: { input: "amountIn" }, right: { local: "isSell" } },
          { name: "sellScaled", op: "mul", left: { local: "sellAmount" }, right: { input: "scale" } },
          { name: "sellFeeScaled", op: "mul", left: { local: "sellScaled" }, right: { input: "fee" } },
          { name: "sellFee", op: "div", left: { local: "sellFeeScaled" }, right: { constant: "1000000000000000000" } },
          { name: "sellOut", op: "sub", left: { local: "sellScaled" }, right: { local: "sellFee" } },
          { name: "buyBudget", op: "mul", left: { input: "amountIn" }, right: { input: "isBuy" } },
          { name: "buyNext", op: "add", left: { local: "buyBudget" }, right: { constant: "1" } },
          { name: "buyWide", op: "mul", left: { local: "buyNext" }, right: { constant: "1000000000000000000" } },
          { name: "buyNumerator", op: "sub", left: { local: "buyWide" }, right: { constant: "1" } },
          { name: "buyDenominator", op: "add", left: { constant: "1000000000000000000" }, right: { input: "fee" } },
          { name: "buyGemWide", op: "div", left: { local: "buyNumerator" }, right: { local: "buyDenominator" } },
          { name: "buyGem", op: "div", left: { local: "buyGemWide" }, right: { input: "scale" } },
          { name: "buyScaled", op: "mul", left: { local: "buyGem" }, right: { input: "scale" } },
          { name: "buyFeeScaled", op: "mul", left: { local: "buyScaled" }, right: { input: "fee" } },
          { name: "buyFee", op: "div", left: { local: "buyFeeScaled" }, right: { constant: "1000000000000000000" } },
          { name: "buyCost", op: "add", left: { local: "buyScaled" }, right: { local: "buyFee" } },
          { name: "callAmount", op: "add", left: { local: "sellAmount" }, right: { local: "buyGem" } },
          { name: "expectedOut", op: "add", left: { local: "sellOut" }, right: { local: "buyGem" } },
          { name: "expectedSpend", op: "add", left: { local: "sellAmount" }, right: { local: "buyCost" } },
          { name: "expectedReturn", op: "add", left: { local: "sellOut" }, right: { local: "buyCost" } },
        ],
      }],
    },
    refreshPolicy: "on-touch",
    sourceRefreshPolicy: "on-touch",
    projection: {
      descriptor: {
        tokenIn: op("address", "$sqlEdge.tokenIn"),
        tokenOut: op("address", "$sqlEdge.tokenOut"),
      },
    },
  }];
  const raw = {
    format: "selector-family/v2",
    selector: fn.selector,
    signature: source.signature,
    domain: "protocol",
    activation: source.activation,
    directState: state,
    programs,
  };
  normalizeSelectorNativeExecutionDefinition(raw);
  return raw;
}

function compileConstantProductSwapSource(source: Data, discoveryRuleHash: string): Data {
  const hasId = Object.hasOwn(source, "id");
  const hasAlt = Object.hasOwn(source, "alternativeCallbacks");
  keys(source, [
    "format", ...(hasId ? ["id"] : []), "selector", "signature", "activation",
    "reservesGetter", "feeBps", "callback", ...(hasAlt ? ["alternativeCallbacks"] : []),
    "refreshPolicy", "state",
  ]);
  if (hasId) optionId(source.id);
  need(source.refreshPolicy === "on-touch" || source.refreshPolicy === "each-block", "execution template needs explicit refresh policy");
  need(Number.isSafeInteger(source.feeBps) && source.feeBps >= 0 && source.feeBps < 10000, "invalid constant-product feeBps");
  const state = directStateFromSource(source.state, discoveryRuleHash);
  const fn = FunctionFragment.from(source.signature);
  need(fn.selector === source.selector && fn.inputs.length === 4 &&
    fn.inputs[0]!.type === "uint256" && fn.inputs[1]!.type === "uint256" &&
    fn.inputs[2]!.type === "address" && fn.inputs[3]!.type === "bytes",
    "constant-product swap signature must match (uint256,uint256,address,bytes)");
  const reservesFn = FunctionFragment.from(source.reservesGetter);
  need(reservesFn.stateMutability === "view" && reservesFn.inputs.length === 0 && reservesFn.outputs.length >= 2 &&
    reservesFn.outputs[0]!.type === "uint112" && reservesFn.outputs[1]!.type === "uint112",
    "invalid constant-product reservesGetter");
  const cbFn = FunctionFragment.from(source.callback);
  need(cbFn.inputs.length === 4 && cbFn.inputs[0]!.type === "address" && cbFn.inputs[1]!.type === "uint256" &&
    cbFn.inputs[2]!.type === "uint256" && cbFn.inputs[3]!.type === "bytes", "invalid V2 flash callback signature");
  const altCallbacks: string[] = hasAlt ? source.alternativeCallbacks : [];
  need(Array.isArray(altCallbacks) && altCallbacks.every(s => typeof s === "string" && FunctionFragment.from(s).inputs.length === 4),
    "invalid alternativeCallbacks");

  const feeStr = String(source.feeBps);
  const callSig = "function " + fn.format("sighash");
  const isZeroForOne = op("eq", "$route.direction", "zero-for-one");
  const isZeroForOneGet = op("eq", op("get", "$route", "direction"), "zero-for-one");
  const zeroUint = op("uint", "0");
  const poolGet = op("get", "$descriptor", "pool");
  const feeBpsGet = op("get", op("get", "$descriptor", "feeRule"), "feeBps");

  const programs = [{
    type: "execution",
    projection: {
      descriptor: {
        pool: op("lower", op("address", "$target")),
        token0: "$binding.token0",
        token1: "$binding.token1",
        feeRule: { kind: "constant-bps", feeBps: op("uint", feeStr) },
        quoteModel: { kind: "constant-product" },
      },
    },
    routes: {
      target: poolGet,
      directions: [
        {
          id: "zero-for-one",
          enabled: true,
          tokenIn: op("get", "$descriptor", "token0"),
          tokenOut: op("get", "$descriptor", "token1"),
          taxonomy: { slotKind: "swap" },
          fields: { pool: poolGet, feeBps: feeBpsGet },
        },
        {
          id: "one-for-zero",
          enabled: true,
          tokenIn: op("get", "$descriptor", "token1"),
          tokenOut: op("get", "$descriptor", "token0"),
          taxonomy: { slotKind: "swap" },
          fields: { pool: poolGet, feeBps: feeBpsGet },
        },
      ],
      venue: { kind: "address-pool", pool: op("lower", op("address", poolGet)) },
      checks: [
        {
          assert: op("and",
            op("ne", op("address", poolGet), op("address", ZeroAddress)),
            op("ne", op("address", op("get", "$descriptor", "token0")), op("address", op("get", "$descriptor", "token1"))),
            op("eq", op("get", op("get", "$descriptor", "quoteModel"), "kind"), "constant-product")),
          error: "univ2 incompatible descriptor",
        },
        {
          assert: op("and", op("gte", "$descriptor.feeRule.feeBps", zeroUint), op("lt", "$descriptor.feeRule.feeBps", op("uint", "10000"))),
          error: "univ2 fee must be less than 10000 basis points",
        },
      ],
    },
    execution: {
      version: 2,
      settlement: {
        directOutput: true,
        settleOutput: {
          version: 1,
          steps: [
            {
              id: "transferInput",
              call: { target: "$route.tokenIn", signature: "function transfer(address,uint256) returns(bool)", args: ["$descriptor.pool", ref("amountIn")] },
            },
            {
              id: "deliverDebt",
              call: {
                target: "$descriptor.pool",
                signature: callSig,
                args: [
                  op("if", isZeroForOne, zeroUint, ref("settlementDebt")),
                  op("if", isZeroForOne, ref("settlementDebt"), zeroUint),
                  "$recipient",
                  "0x",
                ],
              },
            },
          ],
        },
      },
      protectedAddresses: op("concat"),
      requireCanonicalSource: true,
      contextChecks: [
        { condition: op("eq", "$descriptor.quoteModel.kind", "constant-product"), error: "unexpected pair quote model for execution" },
        { condition: op("eq", "$descriptor.feeRule.kind", "constant-bps"), error: "univ2 execution fee rule differs from quote model" },
      ],
      steps: [
        { id: "reserves", static: true, call: { target: poolGet, signature: source.reservesGetter, args: [], save: { reserve0: 0, reserve1: 1 } } },
        { id: "balanceBefore", call: { target: "$route.tokenIn", signature: "function balanceOf(address) view returns(uint256)", args: ["$descriptor.pool"], save: { beforeCredit: 0 } }, static: true },
        { id: "transferInput", call: { target: "$route.tokenIn", signature: "function transfer(address,uint256) returns(bool)", args: ["$descriptor.pool", ref("amountIn")] } },
        { id: "balanceAfter", call: { target: "$route.tokenIn", signature: "function balanceOf(address) view returns(uint256)", args: ["$descriptor.pool"], save: { afterCredit: 0 } }, static: true },
        { id: "credit", math: { model: "delta", inputs: { before: ref("beforeCredit"), after: ref("afterCredit") }, outputs: { delta: "pairCredit" } } },
        {
          id: "curve",
          math: {
            model: "fundedOutput",
            inputs: {
              reserveIn: op("if", isZeroForOneGet, ref("reserve0"), ref("reserve1")),
              reserveOut: op("if", isZeroForOneGet, ref("reserve1"), ref("reserve0")),
              amountIn: ref("pairCredit"),
              feeBps: feeBpsGet,
            },
            outputs: { poolAmountOut: "grossOutput" },
          },
        },
        {
          id: "swapOut",
          call: {
            target: "$descriptor.pool",
            signature: callSig,
            args: [
              op("if", isZeroForOne, zeroUint, ref("grossOutput")),
              op("if", isZeroForOne, ref("grossOutput"), zeroUint),
              "$recipient",
              "0x",
            ],
          },
        },
      ],
      effects: [
        { kind: "debit", token: op("get", "$route", "tokenIn"), account: "$executor", equals: ref("amountIn") },
        { kind: "credit", token: op("get", "$route", "tokenOut"), account: "$recipient" },
        { kind: "unchanged-native" },
      ],
      framedSettlement: {
        version: 1,
        recipient: "target",
        debtInput: true,
        expectedOutput: { quoteOutput: "amountOut" },
        frame: {
          call: {
            target: "$descriptor.pool",
            signature: callSig,
            args: [
              op("if", isZeroForOne, zeroUint, { quoteOutput: "poolAmountOut" }),
              op("if", isZeroForOne, { quoteOutput: "poolAmountOut" }, zeroUint),
              "$executor",
            ],
            dataArgument: 3,
          },
          callback: {
            signature: source.callback,
            dataArgument: 3,
            arguments: [
              { index: 0, name: "pairCaller", encoding: "word", equals: "$executor" },
              { index: 1, name: "amountZero", encoding: "word", equals: op("if", isZeroForOne, zeroUint, ref("grossOutput")) },
              { index: 2, name: "amountOne", encoding: "word", equals: op("if", isZeroForOne, ref("grossOutput"), zeroUint) },
            ],
            captures: { grossOutput: { quoteOutput: "poolAmountOut" }, netReceipt: { quoteOutput: "amountOut" } },
            steps: [{ id: "continuePayment", continuation: { debt: ref("amountIn"), output: ref("netReceipt") } }],
            ...(altCallbacks.length ? { alternativeSignatures: altCallbacks } : {}),
          },
        },
      },
    },
    refreshPolicy: source.refreshPolicy,
    runtimeMath: {
      version: 1,
      entries: {
        quote: { model: "univ2:runtime-quote", version: 1 },
        delta: { model: "univ2:received-balance-delta", version: 1 },
        netTransfer: { model: "univ2:net-token-transfer", version: 1 },
        fundedOutput: { model: "univ2:runtime-funded-output", version: 1 },
      },
      models: [
        {
          id: "univ2:runtime-quote",
          version: 1,
          inputs: ["reserveIn", "reserveOut", "amountIn", "feeBps", "taxInNumerator", "taxInDenominator", "taxOutNumerator", "taxOutDenominator"],
          outputs: ["poolAmountOut", "amountOut"],
          operations: [
            { name: "feeComplement", op: "sub", left: { constant: "10000" }, right: { input: "feeBps" } },
            { name: "inputTaxMul", op: "mul", left: { input: "amountIn" }, right: { input: "taxInNumerator" } },
            { name: "inputTax", op: "div", left: { local: "inputTaxMul" }, right: { input: "taxInDenominator" } },
            { name: "receivedIn", op: "sub", left: { input: "amountIn" }, right: { local: "inputTax" } },
            { name: "inWithFee", op: "mul", left: { local: "receivedIn" }, right: { local: "feeComplement" } },
            { name: "numerator", op: "mul", left: { local: "inWithFee" }, right: { input: "reserveOut" } },
            { name: "denominatorBase", op: "mul", left: { input: "reserveIn" }, right: { constant: "10000" } },
            { name: "denominator", op: "add", left: { local: "denominatorBase" }, right: { local: "inWithFee" } },
            { name: "poolAmountOut", op: "div", left: { local: "numerator" }, right: { local: "denominator" } },
            { name: "outputTaxMul", op: "mul", left: { local: "poolAmountOut" }, right: { input: "taxOutNumerator" } },
            { name: "outputTax", op: "div", left: { local: "outputTaxMul" }, right: { input: "taxOutDenominator" } },
            { name: "amountOut", op: "sub", left: { local: "poolAmountOut" }, right: { local: "outputTax" } },
          ],
        },
        {
          id: "univ2:received-balance-delta",
          version: 1,
          inputs: ["before", "after"],
          outputs: ["delta"],
          operations: [{ name: "delta", op: "sub", left: { input: "after" }, right: { input: "before" } }],
        },
        {
          id: "univ2:net-token-transfer",
          version: 1,
          inputs: ["amount", "numerator", "denominator"],
          outputs: ["net"],
          operations: [
            { name: "scaled", op: "mul", left: { input: "amount" }, right: { input: "numerator" } },
            { name: "tax", op: "div", left: { local: "scaled" }, right: { input: "denominator" } },
            { name: "net", op: "sub", left: { input: "amount" }, right: { local: "tax" } },
          ],
        },
        {
          id: "univ2:runtime-funded-output",
          version: 1,
          inputs: ["reserveIn", "reserveOut", "amountIn", "feeBps"],
          outputs: ["poolAmountOut"],
          operations: [
            { name: "feeComplement", op: "sub", left: { constant: "10000" }, right: { input: "feeBps" } },
            { name: "inWithFee", op: "mul", left: { input: "amountIn" }, right: { local: "feeComplement" } },
            { name: "numerator", op: "mul", left: { local: "inWithFee" }, right: { input: "reserveOut" } },
            { name: "denominatorBase", op: "mul", left: { input: "reserveIn" }, right: { constant: "10000" } },
            { name: "denominator", op: "add", left: { local: "denominatorBase" }, right: { local: "inWithFee" } },
            { name: "poolAmountOut", op: "div", left: { local: "numerator" }, right: { local: "denominator" } },
          ],
        },
      ],
    },
    quoteOutput: {
      version: 1,
      steps: [
        { id: "reserves", static: true, call: { target: poolGet, signature: source.reservesGetter, args: [], save: { reserve0: 0, reserve1: 1 } } },
        {
          id: "amount",
          math: {
            model: "quote",
            inputs: {
              reserveIn: op("if", isZeroForOneGet, ref("reserve0"), ref("reserve1")),
              reserveOut: op("if", isZeroForOneGet, ref("reserve1"), ref("reserve0")),
              amountIn: ref("amountIn"),
              feeBps: feeBpsGet,
              taxInNumerator: zeroUint,
              taxInDenominator: op("uint", "1"),
              taxOutNumerator: zeroUint,
              taxOutDenominator: op("uint", "1"),
            },
            outputs: { poolAmountOut: "poolAmountOut", amountOut: "amountOut" },
          },
        },
      ],
      result: ref("amountOut"),
      exports: { poolAmountOut: ref("poolAmountOut"), amountOut: ref("amountOut") },
    },
  }];
  const raw = {
    format: "selector-family/v2",
    selector: source.selector,
    signature: source.signature,
    domain: "swap",
    activation: source.activation,
    directState: state,
    programs,
  };
  normalizeSelectorNativeExecutionDefinition(raw);
  return raw;
}

function compileV3CallbackSwapSource(source: Data, discoveryRuleHash: string): Data {
  const hasId = Object.hasOwn(source, "id");
  keys(source, [
    "format", ...(hasId ? ["id"] : []), "selector", "signature", "activation",
    "swapSignature", "callback", "sqrtPriceLimits", "refreshPolicy", "state",
  ]);
  if (hasId) optionId(source.id);
  need(source.refreshPolicy === "on-touch" || source.refreshPolicy === "each-block", "execution template needs explicit refresh policy");
  const state = directStateFromSource(source.state, discoveryRuleHash);
  const fn = FunctionFragment.from(source.signature);
  const swapFn = FunctionFragment.from(source.swapSignature);
  const cbFn = FunctionFragment.from(source.callback);
  need(fn.selector === source.selector && swapFn.selector === source.selector, "V3 swapSignature selector mismatch");
  need(cbFn.inputs.length === 3 && cbFn.inputs[0]!.type === "int256" && cbFn.inputs[1]!.type === "int256" && cbFn.inputs[2]!.type === "bytes",
    "invalid V3 swap callback signature");
  need(Array.isArray(source.sqrtPriceLimits) && source.sqrtPriceLimits.length === 2 &&
    source.sqrtPriceLimits.every((s: unknown) => typeof s === "string" && /^[1-9]\d*$/.test(s)), "invalid sqrtPriceLimits");
  const [limitZeroForOne, limitOneForZero] = source.sqrtPriceLimits as [string, string];
  const minNegativeInt256Word = "57896044618658097711785492504343953926634992332820282019728792003956564819968";
  const poolGet = op("get", "$descriptor", "pool");
  const token0Get = op("get", "$descriptor", "token0");
  const token1Get = op("get", "$descriptor", "token1");
  const isZeroForOneGet = op("eq", op("get", "$route", "direction"), "zero-for-one");
  const isZeroForOne = op("eq", "$route.direction", "zero-for-one");

  const swapStep = (zeroForOne: boolean) => ({
    id: zeroForOne ? "swapZeroForOne" : "swapOneForZero",
    when: zeroForOne ? isZeroForOneGet : op("not", isZeroForOneGet),
    frame: {
      call: {
        target: poolGet,
        signature: source.swapSignature,
        args: ["$recipient", zeroForOne, ref("amountIn"), zeroForOne ? limitZeroForOne : limitOneForZero],
        dataArgument: 4,
        save: { returnedDebt: zeroForOne ? 0 : 1, returnedCreditWord: zeroForOne ? 1 : 0 },
        checks: [
          { left: ref("amountIn"), operator: "gte", right: ref("returnedDebt") },
          { left: ref("returnedCreditWord"), operator: "gte", right: minNegativeInt256Word },
        ],
      },
      callback: {
        signature: source.callback,
        dataArgument: 2,
        captures: { capital: ref("amountIn") },
        arguments: [
          { index: zeroForOne ? 0 : 1, name: "debt", encoding: "positive", maximum: ref("capital") },
          { index: zeroForOne ? 1 : 0, name: "credit", encoding: "negative", minimum: 1 },
        ],
        steps: [{
          id: "pay",
          call: {
            target: zeroForOne ? token0Get : token1Get,
            signature: "function transfer(address to,uint256 amount) returns(bool)",
            args: [poolGet, ref("debt")],
          },
        }],
      },
    },
  });

  const programs = [{
    type: "execution",
    projection: {
      descriptor: {
        pool: "$target",
        token0: "$binding.token0",
        token1: "$binding.token1",
      },
    },
    routes: {
      target: poolGet,
      directions: [
        {
          id: "zero-for-one",
          enabled: true,
          tokenIn: token0Get,
          tokenOut: token1Get,
          taxonomy: { slotKind: "swap" },
          fields: { pool: poolGet },
        },
        {
          id: "one-for-zero",
          enabled: true,
          tokenIn: token1Get,
          tokenOut: token0Get,
          taxonomy: { slotKind: "swap" },
          fields: { pool: poolGet },
        },
      ],
      venue: { kind: "address-pool", pool: op("lower", op("address", poolGet)) },
      checks: [
        { assert: op("not", op("sameAddress", poolGet, ZeroAddress)), error: "univ3 descriptor requires a pool" },
        { assert: op("not", op("sameAddress", token0Get, token1Get)), error: "univ3 descriptor requires distinct tokens" },
      ],
    },
    execution: {
      version: 2,
      settlement: { directOutput: true },
      protectedAddresses: [poolGet],
      requireCanonicalSource: true,
      contextChecks: [
        {
          condition: op("and",
            op("not", op("sameAddress", poolGet, ZeroAddress)),
            op("not", op("sameAddress", token0Get, ZeroAddress)),
            op("not", op("sameAddress", token1Get, ZeroAddress))),
          error: "univ3 runtime invalid execution addresses",
        },
        { condition: op("not", op("sameAddress", poolGet, "$executor")), error: "univ3 runtime invalid execution addresses" },
      ],
      steps: [swapStep(true), swapStep(false)],
      effects: [
        { kind: "debit", token: op("get", "$route", "tokenIn"), account: "$executor", maximum: ref("amountIn") },
        { kind: "credit", token: op("get", "$route", "tokenOut"), account: "$recipient" },
      ],
      framedSettlement: {
        version: 1,
        recipient: "target",
        debtInput: true,
        returnedWords: { debt: "returnedDebt", negativeOutput: "returnedCreditWord" },
        frame: {
          call: {
            target: poolGet,
            signature: source.swapSignature,
            args: ["$recipient", isZeroForOne, ref("amountIn"), op("if", isZeroForOne, limitZeroForOne, limitOneForZero)],
            dataArgument: 4,
            save: {
              returnedDebt: op("if", isZeroForOne, 0, 1),
              returnedCreditWord: op("if", isZeroForOne, 1, 0),
            },
            checks: [
              { left: ref("amountIn"), operator: "gte", right: ref("returnedDebt") },
              { left: ref("returnedCreditWord"), operator: "gte", right: minNegativeInt256Word },
            ],
          },
          callback: {
            signature: source.callback,
            dataArgument: 2,
            captures: { capital: ref("amountIn") },
            arguments: [
              { index: op("if", isZeroForOne, 0, 1), name: "debt", encoding: "positive", maximum: ref("capital") },
              { index: op("if", isZeroForOne, 1, 0), name: "credit", encoding: "negative", minimum: 1 },
            ],
            steps: [{ id: "continuePayment", continuation: { debt: ref("debt"), output: ref("credit") } }],
          },
        },
      },
    },
    refreshPolicy: source.refreshPolicy,
  }];
  const raw = {
    format: "selector-family/v2",
    selector: source.selector,
    signature: source.signature,
    domain: "swap",
    activation: source.activation,
    directState: state,
    programs,
  };
  normalizeSelectorNativeExecutionDefinition(raw);
  return raw;
}

function compileV4UnlockSwapSource(source: Data, discoveryRuleHash: string): Data {
  const hasId = Object.hasOwn(source, "id");
  const hasActivity = Object.hasOwn(source, "physicalPoolActivity");
  keys(source, [
    "format", ...(hasId ? ["id"] : []), "selector", "signature", "activation",
    "unlockSignature", "callback", "swapSignature", "takeSignature", "syncSignature", "settleSignature",
    "wrappedNative", "sqrtPriceLimits", "hookData", "refreshPolicy",
    "state", "managerCustody", ...(hasActivity ? ["physicalPoolActivity"] : []),
  ]);
  if (hasId) optionId(source.id);
  need(source.refreshPolicy === "on-touch" || source.refreshPolicy === "each-block", "execution template needs explicit refresh policy");
  need(source.hookData === "$sqlEdge.hookData", "V4 unlock template requires $sqlEdge.hookData binding");
  const state = directStateFromSource(source.state, discoveryRuleHash);
  const fn = FunctionFragment.from(source.signature);
  const unlockFn = FunctionFragment.from(source.unlockSignature);
  need(fn.selector === source.selector && unlockFn.selector === source.selector, "V4 unlockSignature selector mismatch");
  FunctionFragment.from(source.callback);
  FunctionFragment.from(source.swapSignature);
  FunctionFragment.from(source.takeSignature);
  FunctionFragment.from(source.syncSignature);
  FunctionFragment.from(source.settleSignature);
  const wrapped = getAddress(String(source.wrappedNative));
  need(wrapped !== ZeroAddress, "invalid wrappedNative address");
  need(obj(source.managerCustody) && typeof source.managerCustody.manager === "string", "V4 unlock template requires managerCustody");
  const pinnedManager = getAddress(source.managerCustody.manager);
  need(Array.isArray(source.sqrtPriceLimits) && source.sqrtPriceLimits.length === 2 &&
    source.sqrtPriceLimits.every((s: unknown) => typeof s === "string" && /^[1-9]\d*$/.test(s)), "invalid sqrtPriceLimits");
  const [limitZeroForOne, limitOneForZero] = source.sqrtPriceLimits as [string, string];

  const c0Raw = op("lower", op("address", "$binding.poolKey.currency0"));
  const c1Raw = op("lower", op("address", "$binding.poolKey.currency1"));
  const poolKeyGet = op("get", "$descriptor", "poolKey");
  const managerGet = op("get", op("get", "$descriptor", "managerBinding"), "manager");
  const poolIdGet = op("get", "$descriptor", "poolId");
  const isZeroForOneGet = op("eq", op("get", "$route", "direction"), "zero-for-one");
  const isNativeInput = op("eq", op("get", op("get", "$route", "executionAssets"), "input"), "native");
  const isNativeOutput = op("eq", op("get", op("get", "$route", "executionAssets"), "output"), "native");

  const directionEntry = (zeroForOne: boolean) => {
    const inField = zeroForOne ? "currency0" : "currency1";
    const outField = zeroForOne ? "currency1" : "currency0";
    return {
      id: zeroForOne ? "zero-for-one" : "one-for-zero",
      enabled: true,
      tokenIn: op("get", "$descriptor", zeroForOne ? "graphToken0" : "graphToken1"),
      tokenOut: op("get", "$descriptor", zeroForOne ? "graphToken1" : "graphToken0"),
      taxonomy: { slotKind: "swap" },
      executionAssets: {
        input: op("if", op("sameAddress", op("get", poolKeyGet, inField), ZeroAddress), "native", "erc20"),
        output: op("if", op("sameAddress", op("get", poolKeyGet, outField), ZeroAddress), "native", "erc20"),
      },
      fields: {
        poolId: op("lower", poolIdGet),
        poolKey: {
          currency0: op("get", poolKeyGet, "currency0"),
          currency1: op("get", poolKeyGet, "currency1"),
          fee: op("get", poolKeyGet, "fee"),
          tickSpacing: op("get", poolKeyGet, "tickSpacing"),
          hooks: op("get", poolKeyGet, "hooks"),
        },
        manager: managerGet,
        realTokenIn: op("get", poolKeyGet, inField),
        realTokenOut: op("get", poolKeyGet, outField),
      },
    };
  };

  const mask128 = "340282366920938463463374607431768211455";
  const base128 = "340282366920938463463374607431768211456";

  const programs = [{
    type: "execution",
    resourceValues: { inputs: ["sqlEdge"] },
    projection: {
      descriptor: {
        poolId: "$scope.poolId",
        poolKey: {
          currency0: c0Raw,
          currency1: c1Raw,
          fee: op("number", "$binding.poolKey.fee"),
          tickSpacing: op("number", "$binding.poolKey.tickSpacing"),
          hooks: op("lower", op("address", "$binding.poolKey.hooks")),
        },
        graphToken0: op("if", op("sameAddress", c0Raw, ZeroAddress), wrapped, op("address", c0Raw)),
        graphToken1: op("if", op("sameAddress", c1Raw, ZeroAddress), wrapped, op("address", c1Raw)),
        managerBinding: { manager: op("lower", op("address", "$target")) },
        hookData: op("coalesce", "$sqlEdge.hookData", "0x"),
      },
      stateBinding: {
        poolNamespace: "contract-pool-id",
        candidate: { manager: "$target", poolId: "$scope.poolId" },
        poolIdTuple: {
          signature: source.swapSignature,
          path: [0],
          fields: ["poolKey.currency0", "poolKey.currency1", "poolKey.fee", "poolKey.tickSpacing", "poolKey.hooks"],
        },
      },
    },
    routes: {
      target: managerGet,
      directions: [directionEntry(true), directionEntry(false)],
      venue: { kind: "manager-pool-id", manager: op("lower", op("address", managerGet)), poolId: op("lower", poolIdGet) },
      checks: [
        { assert: op("sameAddress", managerGet, pinnedManager), error: "univ4 descriptor requires the Uniswap V4 PoolManager" },
        { assert: op("lt", op("uint", op("get", poolKeyGet, "currency0")), op("uint", op("get", poolKeyGet, "currency1"))), error: "univ4 descriptor requires currency0 < currency1" },
        { assert: op("not", op("sameAddress", op("get", poolKeyGet, "currency0"), op("get", poolKeyGet, "currency1"))), error: "univ4 descriptor requires distinct currencies" },
      ],
      resource: { target: op("lower", op("address", managerGet)), poolId: op("lower", poolIdGet), poolNamespace: "contract-pool-id" },
    },
    execution: {
      version: 2,
      settlement: { directOutput: true },
      protectedAddresses: [],
      requireCanonicalSource: true,
      contextChecks: [
        { condition: op("sameAddress", managerGet, pinnedManager), error: "univ4 runtime manager binding" },
        {
          condition: op("and",
            op("eq", op("get", "$route", "poolId"), poolIdGet),
            op("eq", op("get", "$route", "instanceKey"), op("get", "$descriptor", "instanceKey")),
            op("sameAddress", op("get", "$route", "manager"), managerGet)),
          error: "univ4 runtime route instance",
        },
        {
          condition: op("and",
            op("sameAddress", op("get", "$route", "realTokenIn"), op("get", "$route", "realTokenIn")),
            op("sameAddress", op("get", "$route", "realTokenOut"), op("get", "$route", "realTokenOut")),
            op("or", isZeroForOneGet, op("eq", op("get", "$route", "direction"), "one-for-zero"))),
          error: "univ4 runtime route binding",
        },
        { condition: op("not", op("sameAddress", managerGet, "$executor")), error: "univ4 runtime executor/manager collision" },
      ],
      effects: [
        { kind: "debit", token: op("get", "$route", "tokenIn"), account: "$executor", equals: ref("amountIn"), when: op("not", isNativeInput) },
        { kind: "debit", asset: "native", account: "$executor", equals: ref("amountIn"), when: isNativeInput },
        { kind: "credit", token: op("get", "$route", "tokenOut"), account: "$recipient", minimum: "$minAmountOut", when: op("not", isNativeOutput) },
        { kind: "credit", asset: "native", account: "$recipient", minimum: "$minAmountOut", when: isNativeOutput },
      ],
      steps: [{
        id: "unlock",
        frame: {
          call: { target: managerGet, signature: source.unlockSignature, args: [], dataArgument: 0 },
          callback: {
            signature: source.callback,
            dataArgument: 0,
            arguments: [],
            captures: {},
            returns: { types: ["bytes"], values: ["0x"] },
            steps: [
              {
                id: "negate",
                math: {
                  model: "negate",
                  inputs: { amount: ref("amountIn") },
                  outputs: { negative: "swapAmount", high: "amountHigh" },
                  checks: [{ left: ref("amountHigh"), operator: "eq", right: 0 }],
                },
              },
              {
                id: "swap",
                call: {
                  target: managerGet,
                  signature: source.swapSignature,
                  args: [
                    {
                      currency0: op("get", poolKeyGet, "currency0"),
                      currency1: op("get", poolKeyGet, "currency1"),
                      fee: op("get", poolKeyGet, "fee"),
                      tickSpacing: op("get", poolKeyGet, "tickSpacing"),
                      hooks: op("get", poolKeyGet, "hooks"),
                    },
                    {
                      zeroForOne: isZeroForOneGet,
                      amountSpecified: ref("swapAmount"),
                      sqrtPriceLimitX96: op("if", isZeroForOneGet, limitZeroForOne, limitOneForZero),
                    },
                    "$descriptor.hookData",
                  ],
                  save: { swapDelta: 0 },
                },
              },
              {
                id: "delta",
                math: {
                  model: op("if", isZeroForOneGet, "deltaZero", "deltaOne"),
                  inputs: { delta: ref("swapDelta") },
                  outputs: { output: "takeAmount", debt: "settleDebt", outputHigh: "outputHigh" },
                  checks: [{ left: ref("outputHigh"), operator: "eq", right: 0 }],
                },
              },
              {
                id: "take",
                call: { target: managerGet, signature: source.takeSignature, args: [op("get", "$route", "realTokenOut"), "$recipient", ref("takeAmount")] },
              },
              {
                id: "sync",
                call: { target: managerGet, signature: source.syncSignature, args: [op("get", "$route", "realTokenIn")] },
              },
              {
                id: "pay",
                when: op("not", isNativeInput),
                call: {
                  target: op("get", "$route", "realTokenIn"),
                  signature: "function transfer(address to,uint256 amount) returns (bool)",
                  args: [managerGet, ref("settleDebt")],
                  save: { paid: 0 },
                  checks: [{ left: ref("paid"), operator: "eq", right: true }],
                },
              },
              {
                id: "settleToken",
                when: op("not", isNativeInput),
                call: {
                  target: managerGet,
                  signature: source.settleSignature,
                  args: [],
                  save: { settledToken: 0 },
                  checks: [{ left: ref("settledToken"), operator: "eq", right: ref("settleDebt") }],
                },
              },
              {
                id: "settleNative",
                when: isNativeInput,
                call: {
                  target: managerGet,
                  signature: source.settleSignature,
                  args: [],
                  value: ref("settleDebt"),
                  save: { settledNative: 0 },
                  checks: [{ left: ref("settledNative"), operator: "eq", right: ref("settleDebt") }],
                },
              },
            ],
          },
        },
      }],
    },
    refreshPolicy: source.refreshPolicy,
    runtimeMath: {
      version: 1,
      entries: {
        negate: { model: "univ4:negate", version: 1 },
        deltaZero: { model: "univ4:delta-zero-for-one", version: 1 },
        deltaOne: { model: "univ4:delta-one-for-zero", version: 1 },
      },
      models: [
        {
          id: "univ4:negate",
          version: 1,
          inputs: ["amount"],
          outputs: ["negative", "high"],
          operations: [
            { name: "high", op: "shr", left: { input: "amount" }, right: { constant: "127" } },
            { name: "negative", op: "neg", left: { input: "amount" }, right: { constant: "0" } },
          ],
        },
        {
          id: "univ4:delta-zero-for-one",
          version: 1,
          inputs: ["delta"],
          outputs: ["output", "debt", "outputHigh"],
          operations: [
            { name: "high", op: "shr", left: { input: "delta" }, right: { constant: "128" } },
            { name: "output", op: "and", left: { input: "delta" }, right: { constant: mask128 } },
            { name: "debtRaw", op: "and", left: { local: "high" }, right: { constant: mask128 } },
            { name: "debtBase", op: "sub", left: { constant: base128 }, right: { local: "debtRaw" } },
            { name: "debt", op: "and", left: { local: "debtBase" }, right: { constant: mask128 } },
            { name: "outputHigh", op: "shr", left: { local: "output" }, right: { constant: "127" } },
          ],
        },
        {
          id: "univ4:delta-one-for-zero",
          version: 1,
          inputs: ["delta"],
          outputs: ["output", "debt", "outputHigh"],
          operations: [
            { name: "high", op: "shr", left: { input: "delta" }, right: { constant: "128" } },
            { name: "low", op: "and", left: { input: "delta" }, right: { constant: mask128 } },
            { name: "output", op: "and", left: { local: "high" }, right: { constant: mask128 } },
            { name: "debtBase", op: "sub", left: { constant: base128 }, right: { local: "low" } },
            { name: "debt", op: "and", left: { local: "debtBase" }, right: { constant: mask128 } },
            { name: "outputHigh", op: "shr", left: { local: "output" }, right: { constant: "127" } },
          ],
        },
      ],
    },
  }];
  const raw = {
    format: "selector-family/v2",
    selector: source.selector,
    signature: source.signature,
    domain: "swap",
    activation: source.activation,
    directState: state,
    managerCustody: source.managerCustody,
    ...(hasActivity ? { physicalPoolActivity: source.physicalPoolActivity } : {}),
    programs,
  };
  normalizeSelectorNativeExecutionDefinition(raw);
  return raw;
}

function compileTemplateSource(source: Data, discoveryRuleHash: string): Data {
  const isSingle = source.format === "selector-execution-template/v1";
  const optional = ["managerCustody", "physicalPoolActivity", "directionSupport"].filter(k => Object.hasOwn(source, k));
  keys(source, ["format", "selector", "signature", "domain", "activation", "state", isSingle ? "template" : "recipes", ...optional]);
  const list = isSingle ? [source.template] : source.recipes;
  need(Array.isArray(list) && list.length === 1, "selector execution source must declare exactly one execution template");
  const state = directStateFromSource(source.state, discoveryRuleHash);
  const fn = FunctionFragment.from(source.signature);
  need(fn.selector === source.selector, "entry selector differs from ABI");
  const allowed = new Set([
    "id", "projection", "routes", "execution", "refreshPolicy", "sourceRefreshPolicy", "values", "resourceValues",
    "parameters", "payment", "runtimeMath", "math", "quoteOutput", "observations", "receiptChecks", "context", "checks", "meta",
  ]);
  const recipe = list[0];
  need(obj(recipe) && Object.keys(recipe).every(k => allowed.has(k)) && obj(recipe.projection) && obj(recipe.routes) && obj(recipe.execution),
    "execution template requires pure projection, routes and execution; read/binding flows and authored program roles are not source templates");
  need(recipe.refreshPolicy === "on-touch" || recipe.refreshPolicy === "each-block", "execution template needs explicit refresh policy");
  if (Object.hasOwn(recipe, "id")) optionId(recipe.id);
  const { id: _id, projection, ...program } = recipe;
  keys(projection, ["descriptor", ...["facts", "stateBinding"].filter(k => Object.hasOwn(projection, k))]);
  const stateBinding = projection.stateBinding;
  if (stateBinding !== undefined) {
    keys(stateBinding, ["poolNamespace", ...["candidate", "poolIdTuple"].filter(k => obj(stateBinding) && Object.hasOwn(stateBinding, k))]);
  }
  const programs = [{ type: "execution", ...program, projection }];
  const raw = {
    format: "selector-family/v2",
    selector: source.selector,
    signature: source.signature,
    domain: source.domain,
    activation: source.activation,
    directState: state,
    programs,
    ...Object.fromEntries(optional.map(k => [k, source[k]])),
  };
  normalizeSelectorNativeExecutionDefinition(raw);
  return raw;
}

export function compileIdentitySource(identitySource: unknown, expected?: { readonly selector?: unknown; readonly signature?: unknown; readonly activation?: unknown }): Data[] {
  assertModuleData(identitySource);
  need(obj(identitySource), "invalid identity source");
  need(identitySource.format === "identity-options/v1", "identity source requires format identity-options/v1");
  const optional = ["activation", "poolKeyTarget", "allowNativeToken"].filter(k => Object.hasOwn(identitySource, k));
  keys(identitySource, ["format", "selector", "signature", "options", ...optional]);
  if (expected) {
    need(identitySource.selector === expected.selector &&
      FunctionFragment.from(identitySource.signature).format("full") === FunctionFragment.from(expected.signature).format("full") &&
      (identitySource.activation === undefined || isDeepStrictEqual(identitySource.activation, expected.activation)),
      "identity/execution source metadata differs");
  }
  const poolKeyTarget = identitySource.poolKeyTarget === undefined ? undefined : getAddress(String(identitySource.poolKeyTarget)).toLowerCase();
  need(poolKeyTarget === undefined || poolKeyTarget !== ZeroAddress, "invalid poolKeyTarget address");
  const allowNativeToken = identitySource.allowNativeToken;
  need(allowNativeToken === undefined || typeof allowNativeToken === "boolean", "invalid allowNativeToken flag");
  need(Array.isArray(identitySource.options) && identitySource.options.length <= 32, "invalid identity options collection");
  const seenIds = new Set<string>();
  return identitySource.options.map((option: unknown) => {
    need(obj(option), "invalid identity option");
    optionId(option.id);
    need(!seenIds.has(option.id), "duplicate identity option id: " + option.id);
    seenIds.add(option.id);
    if (Object.hasOwn(option, "poolKey")) {
      return compilePoolKeyIdentityOption(option, { poolKeyTarget, allowNativeToken: allowNativeToken === true });
    }
    need(!poolKeyTarget && !allowNativeToken, "poolKeyTarget/allowNativeToken require poolKey identity options");
    if (Object.hasOwn(option, "tokenList")) {
      return compileTokenListIdentityOption(option);
    }
    if (typeof option.tokenIn === "string" && typeof option.tokenOut === "string" &&
        !option.tokenIn.startsWith("$") && !option.tokenOut.startsWith("$")) {
      return compileGetterIdentityOption(option);
    }
    return compileEndpointIdentityOption(option);
  });
}

function compileEndpointIdentityOption(option: Data): Data {
  keys(option, ["id", "tokenIn", "tokenOut"]);
  const abi: Data = {}, decoded: Data = {}, requests: Data[] = [];
  let callCount = 0;
  const resolveEndpoint = (spec: unknown, side: "in" | "out"): unknown => {
    if (spec === "$target" || spec === "$scope.tokenIn" || spec === "$scope.tokenOut") {
      return op("lower", op("address", spec));
    }
    const isStr = typeof spec === "string";
    need(isStr || obj(spec), `invalid ${side} identity endpoint`);
    const sigStr = isStr ? spec : spec.call;
    const rawArgs: unknown[] = isStr ? [] : (spec.args ?? []);
    const outIdx: number = isStr ? 0 : (spec.output ?? 0);
    if (!isStr) {
      const allowed = new Set(["call", "args", "output"]);
      need(Object.keys(spec).every(k => allowed.has(k)), `unexpected fields on ${side} identity call`);
    }
    need(typeof sigStr === "string" && Array.isArray(rawArgs) && Number.isSafeInteger(outIdx) && outIdx >= 0,
      `invalid ${side} identity call specification`);
    const fn = FunctionFragment.from(sigStr);
    need(fn.stateMutability === "view" && fn.inputs.length === rawArgs.length &&
      outIdx < fn.outputs.length && fn.outputs[outIdx]!.type === "address" &&
      /^[a-zA-Z][a-zA-Z0-9_]*$/.test(fn.name),
      `expected view function returning address at output ${outIdx}`);
    for (const arg of rawArgs) {
      need(typeof arg === "number" && Number.isSafeInteger(arg) ||
        typeof arg === "string" && (arg === "$scope.tokenIn" || arg === "$scope.tokenOut" || /^-?\d+$/.test(arg)),
        "unsupported identity call argument");
    }
    const idx = callCount++;
    const alias = `endpointRead${idx}`, reqId = `identity:ep${idx}`, signature = fn.format("sighash");
    abi[alias] = [fn.format("full")];
    requests.push({ id: reqId, kind: "eth-call", to: "$target", data: op("encode", alias, signature, rawArgs), completion: "return-data" });
    const field = `ep${idx}`;
    decoded[field] = op("lower", op("address", op("decodeCanonical", alias, signature, op("get", op("returned", reqId), "data"), outIdx)));
    return `$r.${field}`;
  };
  const exprIn = resolveEndpoint(option.tokenIn, "in");
  const exprOut = resolveEndpoint(option.tokenOut, "out");
  need(requests.length > 0, "identity option must perform at least one contract read");
  need(JSON.stringify(option.tokenIn) !== JSON.stringify(option.tokenOut), "identity endpoints must be distinct");
  return {
    type: "independentIdentity",
    values: { abi },
    binding: {
      flow: {
        version: 1,
        steps: [{
          id: "identity",
          requirements: { transports: ["eth-call"] },
          requests,
          decode: [{ let: "r", value: decoded }, { return: { direction: option.id, tokenIn: exprIn, tokenOut: exprOut } }],
        }],
        result: "$steps.identity",
      },
      descriptor: {
        direction: option.id,
        tokenIn: op("address", "$binding.tokenIn"),
        tokenOut: op("address", "$binding.tokenOut"),
      },
    },
    checks: [
      { assert: op("sameAddress", "$descriptor.tokenIn", "$scope.tokenIn"), error: "identity input differs from edge" },
      { assert: op("sameAddress", "$descriptor.tokenOut", "$scope.tokenOut"), error: "identity output differs from edge" },
    ],
  };
}

function compileTokenListIdentityOption(option: Data): Data {
  keys(option, ["id", "tokenList"]);
  need(typeof option.tokenList === "string", "invalid tokenList getter");
  const fn = FunctionFragment.from(option.tokenList);
  need(fn.stateMutability === "view" && fn.inputs.length === 0 && fn.outputs.length === 1 &&
    fn.outputs[0]!.type === "address[]", "tokenList getter must be a nullary view returning address[]");
  const alias = "tokenListRead", reqId = "identity:tokenList", signature = fn.format("sighash");
  return {
    type: "independentIdentity",
    values: { abi: { [alias]: [fn.format("full")] } },
    binding: {
      flow: {
        version: 1,
        steps: [{
          id: "identity",
          requirements: { transports: ["eth-call"] },
          requests: [{ id: reqId, kind: "eth-call", to: "$target", data: op("encode", alias, signature, []), completion: "return-data" }],
          decode: [
            { let: "rawTokens", value: op("decodeCanonical", alias, signature, op("get", op("returned", reqId), "data"), 0) },
            { let: "tokens", value: op("map", "$rawTokens", "tok", op("lower", op("address", "$tok"))) },
            { assert: op("some", "$tokens", "tok", op("sameAddress", "$tok", "$scope.tokenIn")), error: "tokenIn not in pool tokenList" },
            { assert: op("some", "$tokens", "tok", op("sameAddress", "$tok", "$scope.tokenOut")), error: "tokenOut not in pool tokenList" },
            { return: { direction: option.id, tokenIn: op("lower", op("address", "$scope.tokenIn")), tokenOut: op("lower", op("address", "$scope.tokenOut")) } },
          ],
        }],
        result: "$steps.identity",
      },
      descriptor: {
        direction: option.id,
        tokenIn: op("address", "$binding.tokenIn"),
        tokenOut: op("address", "$binding.tokenOut"),
      },
    },
    checks: [
      { assert: op("sameAddress", "$descriptor.tokenIn", "$scope.tokenIn"), error: "identity input differs from edge" },
      { assert: op("sameAddress", "$descriptor.tokenOut", "$scope.tokenOut"), error: "identity output differs from edge" },
    ],
  };
}

function compileGetterIdentityOption(option: Data): Data {
  keys(option, ["id", "tokenIn", "tokenOut"]);
  const fnIn = getter(option.tokenIn, "address");
  const fnOut = getter(option.tokenOut, "address");
  need(fnIn.selector !== fnOut.selector && fnIn.name !== fnOut.name, "overlapping identity getter");
  const ordered = [fnIn, fnOut].sort((a, b) => a.name.localeCompare(b.name));
  const abi: Data = {}, decoded: Data = {}, descriptor: Data = { direction: option.id };
  const requests = ordered.map(f => {
    const alias = f.name + "Read", id = "identity:" + f.name, signature = f.format("sighash");
    abi[alias] = [f.format("full")];
    decoded[f.name] = op("lower", op("address", op("decodeCanonical", alias, signature, op("get", op("returned", id), "data"), 0)));
    descriptor[f.name] = op("address", "$binding." + f.name);
    return { id, kind: "eth-call", to: "$target", data: op("encode", alias, signature, []), completion: "return-data" };
  });
  const result = {
    direction: option.id,
    ...Object.fromEntries(ordered.map(f => [f.name, "$r." + f.name])),
    tokenIn: "$r." + fnIn.name,
    tokenOut: "$r." + fnOut.name,
  };
  descriptor.tokenIn = op("address", "$binding.tokenIn");
  descriptor.tokenOut = op("address", "$binding.tokenOut");
  return {
    type: "independentIdentity",
    values: { abi },
    binding: {
      flow: {
        version: 1,
        steps: [{
          id: "identity",
          requirements: { transports: ["eth-call"] },
          requests,
          decode: [{ let: "r", value: decoded }, { return: result }],
        }],
        result: "$steps.identity",
      },
      descriptor,
    },
    checks: [
      { assert: op("sameAddress", "$descriptor.tokenIn", "$scope.tokenIn"), error: "identity input differs from edge" },
      { assert: op("sameAddress", "$descriptor.tokenOut", "$scope.tokenOut"), error: "identity output differs from edge" },
    ],
  };
}

function compilePoolKeyIdentityOption(option: Data, config: { poolKeyTarget?: string; allowNativeToken: boolean }): Data {
  const usesTokenInOut = Object.hasOwn(option, "tokenIn") || Object.hasOwn(option, "tokenOut");
  keys(option, ["id", "poolId", "poolKey", ...(usesTokenInOut ? ["tokenIn", "tokenOut"] : ["token0", "token1"])]);
  need(option.poolId === "$scope.poolId", "poolKey option must bind poolId from $scope.poolId");
  need(typeof option.poolKey === "string", "invalid poolKey ABI signature");
  const fn = FunctionFragment.from(option.poolKey);
  need(fn.stateMutability === "view" && fn.inputs.length === 1 && ["bytes25", "bytes32"].includes(fn.inputs[0]!.type) &&
    fn.outputs.length >= 2 && fn.outputs.every(p => !!p.name && /^[a-zA-Z][a-zA-Z0-9]*$/.test(p.name) &&
      !["__proto__", "constructor", "prototype"].includes(p.name)),
    "poolKey signature must be a view function taking bytes25/bytes32 and returning named tuple fields");
  const inField = String(usesTokenInOut ? option.tokenIn : option.token0);
  const outField = String(usesTokenInOut ? option.tokenOut : option.token1);
  const inIndex = fn.outputs.findIndex(p => p.name === inField && p.type === "address");
  const outIndex = fn.outputs.findIndex(p => p.name === outField && p.type === "address");
  need(inIndex >= 0 && outIndex >= 0 && inIndex !== outIndex, "poolKey option token fields must reference distinct address outputs");

  const alias = "poolKeyRead", signature = fn.format("sighash");
  const abi: Data = { [alias]: [fn.format("full")] };
  const arg = fn.inputs[0]!.type === "bytes25" ? op("bytes", "$scope.poolId", 0, 25) : "$scope.poolId";
  const to = config.poolKeyTarget ?? "$target";
  const tupleFields: Data = {};
  for (const [idx, param] of fn.outputs.entries()) {
    const rawItem = op("at", "$w", idx);
    tupleFields[param.name!] = param.type === "address"
      ? op("lower", op("address", rawItem))
      : /^(?:u?int)(?:8|16|24|32)$/.test(param.type)
        ? op("number", rawItem)
        : rawItem;
  }
  const decodeSteps: Data[] = [
    { let: "w", value: op("decodeCanonical", alias, signature, op("get", op("returned", "identity:poolKey"), "data")) },
    {
      assert: op("eq",
        op("lower", op("codeHash", op("abiEncode", fn.outputs.map(o => o.type), "$w"))),
        op("lower", "$scope.poolId")),
      error: "full pool id commitment mismatch",
    },
    {
      return: {
        direction: option.id,
        words: "$w",
        poolKey: tupleFields,
        tokenIn: op("lower", op("address", op("at", "$w", inIndex))),
        tokenOut: op("lower", op("address", op("at", "$w", outIndex))),
      },
    },
  ];
  const descriptor: Data = {
    direction: option.id,
    poolId: "$scope.poolId",
    poolKey: "$binding.poolKey",
    tokenIn: "$binding.tokenIn",
    tokenOut: "$binding.tokenOut",
    ...(config.allowNativeToken ? { allowNativeToken: true } : {}),
  };
  return {
    type: "independentIdentity",
    values: { abi },
    binding: {
      flow: {
        version: 1,
        steps: [{
          id: "key",
          requirements: { transports: ["eth-call"] },
          requests: [{ id: "identity:poolKey", kind: "eth-call", to, data: op("encode", alias, signature, [arg]), completion: "return-data" }],
          decode: decodeSteps,
        }],
        result: "$steps.key",
      },
      descriptor,
    },
    checks: [
      { assert: op("sameAddress", "$descriptor.tokenIn", "$scope.tokenIn"), error: "identity input differs from edge" },
      { assert: op("sameAddress", "$descriptor.tokenOut", "$scope.tokenOut"), error: "identity output differs from edge" },
    ],
  };
}

export function compileSelectorExecutionSource(source: unknown, discoveryRuleHash: string, identitySource?: unknown): Data {
  const raw = compileExecutionSource(source, discoveryRuleHash);
  if (identitySource === undefined) return raw;
  const identities = compileIdentitySource(identitySource, raw);
  const merged = { ...raw, programs: [...identities, ...raw.programs] };
  normalizeSelectorNativeExecutionDefinition(merged);
  return merged;
}
