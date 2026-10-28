/** Seeded single-leg capability checks, NOT admission or an arbitrage replay.
 * Every emitter comes from a saved Ready descriptor. All state mutation is on
 * the caller's task-owned fork. The GTC profit/gas benchmark is kept separate. */
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { RuntimeAmountProgram as P, runtimeProgramScript } from "../src/adapters/runtime-amount-program.js";

export async function settlementFamilyParity(input: {
  rpc: (method: string, params?: unknown[]) => Promise<any>;
  ready: any; members: readonly any[]; source: any; executor: string; owner: string;
  versions: readonly { name: string; code: string }[];
  amount: bigint; save: (name: string, data: unknown) => void;
}) {
  const { rpc, executor, owner, versions, save } = input;
  const weth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
  const recipient = "0x1000000000000000000000000000000000000087";
  const erc = new ethers.Interface(["function transfer(address,uint256)", "function balanceOf(address) view returns(uint256)", "function deposit() payable"]);
  const abi = new ethers.Interface(["function execute(bytes)"]);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const balance = async (token: string, who = executor) => BigInt(await rpc("eth_call", [{ to: token,
    data: erc.encodeFunctionData("balanceOf", [who]) }, "latest"]));
  const candidates: any[] = [];
  const unique = new Set<string>();
  for (const m of Object.values<any>(input.ready.verifiedMemos)) {
    const member = input.members.find(x => x.familyId === m.familyId);
    if (!member?.plugin.execution?.buildRuntimeLeg || !member.plugin.routes) continue;
    const descriptor = m.compiledDescriptor, plugin = member.plugin;
    for (const route of plugin.routes.project({ descriptor })) {
      if (!same(route.tokenIn, weth) || same(route.tokenOut, weth)) continue;
      const emit = (r: any, settlement?: any) => plugin.execution.buildRuntimeLeg({ descriptor, route: r,
        executor, transactionOrigin: owner, source: input.source, runtimeEvidence: [], settlement });
      const leg = emit(route);
      if (!leg?.settlement?.deferredInput || !leg.settlement.directOutput) continue;
      // Both a recipient=self settlement and a recipient=external settlement
      // are tested when present, without a Family-name dispatch table.
      const kind = same(leg.settlement.deferredInput, executor) ? "self-payment" : "external-payment";
      const key = `${m.familyId}:${m.instanceKey}:${route.direction}`;
      if (unique.has(key)) continue; unique.add(key);
      const stable = ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0xdac17f958d2ee523a2206206994597c13d831ec7", "0x6b175474e89094c44da98b954eedeac495271d0f"].findIndex(t => same(t, route.tokenOut));
      candidates.push({ key, familyId: m.familyId, kind, route, emit, plugin, descriptor, priority: stable < 0 ? 99 : stable });
    }
  }
  const selected = [...new Map(candidates.sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key))
    .map(c => [`${c.familyId}:${c.kind}`, c] as const).reverse()).values()];
  save("family-parity-plan.json", { amount: input.amount, samples: selected.map(c => ({ familyId: c.familyId, instance: c.route.instanceKey,
    direction: c.route.direction, kind: c.kind, tokenIn: c.route.tokenIn, tokenOut: c.route.tokenOut })),
    scope: "seeded single-leg parity on derived local states; not closed-loop profit/admission/natural discovery" });
  const results: any[] = [];
  let sampleSnapshot = await rpc("evm_snapshot");
  async function send(to: string, data: string, value = 0n) {
    const header = await rpc("eth_getBlockByNumber", ["latest", false]);
    await rpc("evm_setNextBlockTimestamp", [Number(BigInt(header.timestamp)) + 1]);
    await rpc("anvil_setNextBlockBaseFeePerGas", [header.baseFeePerGas]);
    const tx = await rpc("eth_sendTransaction", [{ from: owner, to, data, value: ethers.toQuantity(value), gas: "0x1000000" }]);
    await rpc("evm_mine");
    const receipt = await rpc("eth_getTransactionReceipt", [tx]);
    return { receipt, tx, stateHeader: { number: header.number, hash: header.hash, stateRoot: header.stateRoot,
      timestamp: header.timestamp, baseFeePerGas: header.baseFeePerGas } };
  }
  const encode = (leg: any, amount: bigint) => abi.encodeFunctionData("execute", [runtimeProgramScript(ethers.getBytes(leg.program), amount)]);
  for (const sample of selected) {
    assert(await rpc("evm_revert", [sampleSnapshot])); sampleSnapshot = await rpc("evm_snapshot");
    await rpc("anvil_setCode", [executor, versions[0]!.code]);
    // Deliberate local seed, acquired via real WETH deposit/transfer rather
    // than invented balances. No seeded result is included in the GTC profit.
    assert.equal((await send(weth, erc.encodeFunctionData("deposit"), input.amount * 10n)).receipt.status, "0x1");
    assert.equal((await send(weth, erc.encodeFunctionData("transfer", [executor, input.amount * 10n]))).receipt.status, "0x1");
    let directionSnapshot = await rpc("evm_snapshot");
    for (const reverse of [false, true]) {
      assert(await rpc("evm_revert", [directionSnapshot])); directionSnapshot = await rpc("evm_snapshot");
      let route = sample.route, amount = input.amount;
      if (reverse) {
        const before = await balance(route.tokenOut);
        const seed = await send(executor, encode(sample.emit(route), amount));
        if (seed.receipt.status !== "0x1") save(`family-parity-seed-failure-${results.length}.json`,
          await rpc("debug_traceTransaction", [seed.tx, { tracer: "callTracer" }]));
        assert.equal(seed.receipt.status, "0x1", "reverse seed must actually execute before a parity verdict");
        amount = (await balance(route.tokenOut) - before) / 2n;
        route = sample.plugin.routes.project({ descriptor: sample.descriptor }).find((r: any) => same(r.tokenIn, sample.route.tokenOut) && same(r.tokenOut, weth));
        assert(route && amount > 0n, "reverse route and real acquired seed required");
      }
      let trialSnapshot = await rpc("evm_snapshot");
      for (const amountIn of [amount, amount / 10n]) {
        if (!amountIn) continue;
        let expected: any;
        for (const mode of ["normal", "direct", "deferred"]) for (const version of versions) {
          assert(await rpc("evm_revert", [trialSnapshot])); trialSnapshot = await rpc("evm_snapshot");
          await rpc("anvil_setCode", [executor, version.code]);
          const normal = sample.emit(route), debtRecipient = normal.settlement.deferredInput;
          const payment = new P().constant(0, amountIn);
          if (!same(debtRecipient, executor)) payment.call(route.tokenIn, erc.encodeFunctionData("transfer", [debtRecipient, 0n]), { patches: [{ offset: 36, reg: 0 }] });
          const request = mode === "normal" ? undefined : mode === "direct" ? { kind: "direct-output", recipient } :
            { kind: "deferred-input", paymentAmount: 0n, paymentProgram: ethers.hexlify(payment.bytes()) };
          const leg = sample.emit(route, request); if (request) assert.deepEqual(leg.settlementRequest, request);
          const to = mode === "direct" ? recipient : executor;
          const before = await Promise.all([balance(route.tokenIn), balance(route.tokenOut, to), balance(route.tokenOut), rpc("eth_getBalance", [executor, "latest"]).then(BigInt)]);
          const data = encode(leg, amountIn), { receipt, tx, stateHeader } = await send(executor, data);
          const after = await Promise.all([balance(route.tokenIn), balance(route.tokenOut, to), balance(route.tokenOut), rpc("eth_getBalance", [executor, "latest"]).then(BigInt)]);
          const row = { familyId: sample.familyId, instance: route.instanceKey, kind: sample.kind, direction: route.direction, reverse, mode,
            version: version.name, amountIn, status: receipt.status, spent: before[0]! - after[0]!, received: after[1]! - before[1]!,
            nativeDelta: after[3]! - before[3]!, executorOutputDelta: after[2]! - before[2]!, gas: BigInt(receipt.gasUsed), stateHeader, calldataHash: ethers.keccak256(data) };
          results.push(row); save("family-parity-results.json", results);
          if (receipt.status !== "0x1") save(`family-parity-failure-${results.length}.json`, await rpc("debug_traceTransaction", [tx, { tracer: "callTracer" }]));
          assert.equal(receipt.status, "0x1", `${sample.familyId} ${mode} ${version.name} ${route.direction}`);
          assert(row.spent > 0n && row.spent <= amountIn && row.received > 0n);
          assert.equal(row.nativeDelta, 0n, "native output/input is wrapped/settled without residual native inventory");
          if (mode === "direct") assert.equal(row.executorOutputDelta, 0n, "direct output does not pass through executor");
          const actual = { spent: row.spent, received: row.received };
          expected ??= actual; assert.deepEqual(actual, expected, "mode/backend must preserve same-state actual input/output");
        }
      }
    }
  }
  save("family-parity-assertions.json", { samples: selected.length, cases: results.length,
    families: [...new Set(selected.map(c => c.familyId))], seededSingleLegOnly: true, passed: true });
}
