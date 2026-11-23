import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { keccak256, toUtf8Bytes } from "ethers";
import { erc20TransferAdapter } from "../../adapters/erc20.js";
import { register } from "../../adapters/registry.js";
import type { ResolvedPlan } from "../solver/solver.js";
import { HOP_DIAGNOSTIC_SLOT } from "../simulator/direct-revert-hop.js";
import { buildEthSimulateV1ExecutionInput, ethSimulateV1AmountFeeBasis, EthSimulateV1Simulator } from "../simulator/eth-simulate-v1.js";

const addr = (c: string) => "0x" + c.repeat(40), hash = (c: string) => "0x" + c.repeat(64);
const token = addr("3"), executor = addr("2"), owner = addr("1");
const source = { number: 100, hash: hash("a"), generation: 7 };
const header = { number: 100, hash: source.hash, parentHash: hash("b"), timestamp: 1_800_000_000,
  gasUsed: 60_000_000n, gasLimit: 60_000_000n, baseFeePerGas: 1_000_000_000n, transactionHashes: [] };
const ctx = () => ({ source, header, signal: new AbortController().signal, deadlineAtMs: Date.now() + 5000 });
const plan = (): ResolvedPlan => ({ root: { adapterId: "erc20-transfer", target: token, tokenIn: token,
  tokenOut: token, amount: 17n, params: { to: owner }, children: [] }, flashAmount: 17n,
  profitToken: token, templateName: "fixed receipt fixture", netProfit: 0n });
const tag = keccak256(toUtf8Bytes("mev.static-balance-observer.result.v3"));
const observed = (n: bigint) => tag + n.toString(16).padStart(64, "0");
register(erc20TransferAdapter);

async function loopback() {
  let calls = 0;
  const response = { profit: 25n, gas: 0x12345n, revert: false };
  const keys: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(payload.method, "eth_simulateV1");
    const { blockOverrides: h, stateOverrides } = payload.params[0].blockStateCalls[0];
    const diag = stateOverrides[executor]?.stateDiff?.[HOP_DIAGNOSTIC_SLOT];
    if (diag) keys.push(diag);
    const main = { status: response.revert ? "0x0" : "0x1", gasUsed: "0x" + response.gas.toString(16),
      logs: [], returnData: "0x", ...(response.revert ? {error: {code: 3, message: "reverted"}} : {}) };
    calls++;
    res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: [{ number: h.number,
      parentHash: payload.params[1].blockHash, timestamp: h.time, gasLimit: h.gasLimit,
      baseFeePerGas: h.baseFeePerGas, calls: [
        { status: "0x1", gasUsed: "0x10000", returnData: observed(100n), logs: [] }, main,
        { status: "0x1", gasUsed: "0x10000", returnData: observed(100n + response.profit), logs: [] },
      ] }] }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert(address && typeof address === "object");
  return { url: "http://127.0.0.1:" + address.port, calls: () => calls, keys, response,
    close() { server.closeAllConnections(); return new Promise<void>((resolve,reject) => server.close(e => e ? reject(e) : resolve())); } };
}

test("only an actual eligible amount execution can supply immutable final gas/profit; exact hits produce zero new wire calls", async () => {
  const h = await loopback();
  try {
    const sim = new EthSimulateV1Simulator(h.url, executor, owner), candidate = plan();
    const r = await sim.simulate(candidate,{...ctx(), captureAmountEvidence: true});
    const winner = {...candidate, netProfit: r.netProfit};
    assert.equal(h.calls(),1);
    assert(Object.isFrozen(r)); assert.throws(() => {r.gasUsed=1n;}, TypeError);
    const match = sim.reuseAmountSimulation(winner, ctx(), r);
    assert.equal(match?.netProfit,25n); assert.equal(match?.gasUsed,0x12345n);
    assert.equal(match?.grossProfit,25n); assert.equal(match?.calldata,r.calldata);
    assert.equal(sim.reuseAmountSimulation(winner,ctx(),{...r}),null,"unissued copy");
    assert.equal(sim.reuseAmountSimulation({...winner, netProfit:1n},ctx(),r),null);
    assert.equal(sim.reuseAmountSimulation({...winner, profitToken:addr("5")},ctx(),r),null);
    assert.equal(sim.reuseAmountSimulation({...winner, flashAmount:1n},ctx(),r),null);
    assert.equal(sim.reuseAmountSimulation({...winner,root:{...winner.root,amount:18n}},ctx(),r),null);
    for(const changed of [{timestamp:header.timestamp+1},{parentHash:hash("c")},{baseFeePerGas:2_000_000_000n},
      {gasUsed:header.gasUsed-500_000n},{gasLimit:header.gasLimit+1n}])
      assert.equal(sim.reuseAmountSimulation(winner,{...ctx(),header:{...header,...changed}},r),null);
    assert.equal(sim.reuseAmountSimulation(winner,{...ctx(),source:{...source,generation:8}},r),null);
    assert.equal(sim.reuseAmountSimulation(winner,{...ctx(),source:{...source,hash:hash("d")},header:{...header,hash:hash("d")}},r),null);
    assert.throws(()=>sim.reuseAmountSimulation(winner,{...ctx(),signal:AbortSignal.abort()},r),/aborted/);
    assert.throws(()=>sim.reuseAmountSimulation(winner,{...ctx(),deadlineAtMs:Date.now()-1},r),/deadline/);
    for(const other of [new EthSimulateV1Simulator(h.url,executor,owner),new EthSimulateV1Simulator(h.url,executor,addr("6")),
      new EthSimulateV1Simulator(h.url,addr("7"),owner),new EthSimulateV1Simulator(h.url,executor,owner,undefined,true)])
      assert.equal(other.reuseAmountSimulation(winner,ctx(),r),null);
    assert.equal(h.calls(),1);
    const uncaptured=await sim.simulate(candidate,ctx());
    const replay=await sim.simulateExecutionInput(buildEthSimulateV1ExecutionInput({...ctx(),owner,executor,profitToken:token,scriptHex:r.scriptHex!}),ctx());
    for(const unissued of [uncaptured,replay]) assert.equal(sim.reuseAmountSimulation(winner,ctx(),unissued),null);
    h.response.gas=0n;
    await assert.rejects(sim.simulate(candidate,{...ctx(),captureAmountEvidence:true}),/invalid final simulation call result/);
    for(const bad of [{profit:0n,gas:0x12345n,revert:false},{profit:25n,gas:0x12345n,revert:true}]) {
      Object.assign(h.response,bad); const out=await sim.simulate(candidate,{...ctx(),captureAmountEvidence:true});
      assert.equal(sim.reuseAmountSimulation({...candidate,netProfit:out.netProfit},ctx(),out),null);
    }
  } finally { await h.close(); }
});

test("fee basis uses checked next-block wire response and authentic positive amount evidence, never a caller header, serialization or fresh fetch", async () => {
  const h = await loopback();
  try {
    const sim = new EthSimulateV1Simulator(h.url,executor,owner), p = plan();
    assert.equal(ethSimulateV1AmountFeeBasis(undefined,source),null);
    // Caller mutation after execution starts must not change the recorded fee basis.
    const mutable = {...header}, control = {...ctx(),header:mutable,captureAmountEvidence:true};
    const running = sim.simulate(p,control); mutable.baseFeePerGas = 5n; mutable.gasUsed = 0n;
    const measured = await running, basis = ethSimulateV1AmountFeeBasis(measured,source);
    assert.deepEqual(basis,{parent:{number:100,hash:source.hash,timestamp:1_800_000_000,baseFeePerGas:1_000_000_000n,
      gasUsed:60_000_000n,gasLimit:60_000_000n},targetBlock:101,targetBaseFeePerGas:1_125_000_000n});
    assert(basis && Object.isFrozen(basis) && Object.isFrozen(basis.parent));
    assert.equal(ethSimulateV1AmountFeeBasis({...measured},source),null);
    for (const wrong of [{...source,number:101},{...source,generation:8},{...source,hash:hash("c")}]) {
      assert.equal(ethSimulateV1AmountFeeBasis(measured,wrong),null);
    }
    assert.equal(h.calls(),1);
    const input = buildEthSimulateV1ExecutionInput({...ctx(),owner,executor,profitToken:token,scriptHex:measured.scriptHex!});
    for(const other of [await sim.simulate(p,ctx()),await sim.simulateExecutionInput(input,ctx())]) {
      assert.equal(ethSimulateV1AmountFeeBasis(other,source),null);
    }
    h.response.profit=0n;
    assert.equal(ethSimulateV1AmountFeeBasis(await sim.simulate(p,{...ctx(),captureAmountEvidence:true}),source),null);
    h.response.revert=true;
    assert.equal(ethSimulateV1AmountFeeBasis(await sim.simulate(p,{...ctx(),captureAmountEvidence:true}),source),null);
  } finally { await h.close(); }
});

test("raw/override and chain diagnostics bind the original private diagnostic nonce without generating or executing a different request", async () => {
  const h = await loopback();
  try {
    const code = "0x7f" + HOP_DIAGNOSTIC_SLOT.slice(2) + "00", image = {code,keccak256:keccak256(code)};
    for(const sim of [new EthSimulateV1Simulator(h.url,executor,owner,image,true),
      new EthSimulateV1Simulator(h.url,executor,owner,undefined,true,image)]) {
      const before=h.calls(), candidate=plan();
      const r=await sim.simulate(candidate,{...ctx(),captureAmountEvidence:true});
      const winner={...candidate,netProfit:r.netProfit};
      assert.equal(sim.reuseAmountSimulation(winner,ctx(),r)?.calldata,r.calldata);
      assert.equal(h.calls(),before+1);
      assert.equal(new EthSimulateV1Simulator(h.url,executor,owner).reuseAmountSimulation(winner,ctx(),r),null);
      if(r.counterfactualExecutorCode) assert(Object.isFrozen(r.counterfactualExecutorCode));
    }
    assert.equal(h.keys.length,2); assert.notEqual(h.keys[0],h.keys[1],"independent trials retain independent nonces");
  } finally { await h.close(); }
});
