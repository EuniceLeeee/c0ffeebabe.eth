import assert from "node:assert/strict";
import test from "node:test";
import { Interface, ZeroAddress } from "ethers";
import { BLOCKSCAN_MULTICALL3, blockScanMulticallIface } from "../blockscan-multicall.js";
import { verifyDeclarativeQuoteProof } from "../venues/declarative-quote-proof.js";
import { compileDeclarativeValues } from "../venues/declarative-values.js";

const signature="function quote(uint128 amountIn,bytes hook) returns (uint256 amountOut)";
const quoter = "0x"+"31".repeat(20);
const source = { number: 1, hash: "0x"+"11".repeat(32), generation: 1 };
const abi = new Interface([signature]);
const data = abi.encodeFunctionData("quote", [33n,"0xab"]);
const other = abi.encodeFunctionData("quote", [33n,"0xcd"]);
const output = abi.encodeFunctionResult("quote", [42n]);
const call = blockScanMulticallIface.encodeFunctionData("aggregate3", [[[quoter,true,data],[quoter,true,other]]]);
const reply = blockScanMulticallIface.encodeFunctionResult("aggregate3", [[[true,output],[false,output]]]);
const values = compileDeclarativeValues({abi:{},constants:{},expressions:{}});
const check = (change:Record<string,unknown>={}) => verifyDeclarativeQuoteProof({
  proof: { version:2, step:"quote", requestId:"test-quote", signature, amountPath:[0],outputPath:[0],
    requestBinding:{target:BLOCKSCAN_MULTICALL3,caller:{kind:"none"}},
    multicall:{index:"$selected",target:"$quoter",calldata:"$call"} },sourceKind:"view",
  source, amountIn:33n, amountOut:42n, tokenIn:ZeroAddress, tokenOut:quoter, executor:ZeroAddress,
  request:{id:"test-quote",kind:"eth-call",to:BLOCKSCAN_MULTICALL3,data:call,completion:"return-data"},
  result:{id:"test-quote",ok:true,source,data:reply,completion:"returned",provenance:{kind:"test",fingerprint:"fixture"}},
  evaluate:values.evaluate,environment:{selected:0,quoter,call:data},...change,
});
test("nested Exact proof binds the canonical multicall contract, successful member, calldata and both amounts", () => {
  check();
  assert.throws(()=>check({amountIn:32n}));
  assert.throws(()=>check({amountOut:41n}));
  for (const env of [{selected:1,quoter,call:other}, {selected:0,quoter:ZeroAddress,call:data}, {selected:0,quoter,call:other}, {selected:-1,quoter,call:data}])
    assert.throws(()=>check({environment:env}));
  assert.throws(()=>check({request:{id:"test-quote",kind:"eth-call",to:ZeroAddress,data:call,completion:"return-data"}}));
  assert.throws(()=>check({result:{id:"test-quote",ok:true,source,data:reply+"ff",completion:"returned",provenance:{kind:"test",fingerprint:"fixture"}}}));
});
