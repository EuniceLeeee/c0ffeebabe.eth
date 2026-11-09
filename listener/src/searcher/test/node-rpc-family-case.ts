import assert from 'node:assert/strict';
import { registerAcceptanceSample, assertRegisteredAcceptanceSample } from './protocol-json-sample-registration.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
// Swap component correctness runner: real node state and production Family programs.
// It does not construct Ready, Graph, a search pipeline, or a performance verdict.
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
    const k = process.argv[i]!;
    assert(['--case', '--definition', '--rpc-file', '--out'].includes(k) && !args.has(k) && process.argv[i + 1]);
    args.set(k, process.argv[i + 1]!);
}
for (const k of ['--case', '--definition', '--rpc-file', '--out'])
    assert(args.has(k), k + ' required');
const sample = JSON.parse(readFileSync(resolve(args.get('--case')!), 'utf8'));
assert.equal(sample.format, 'node-rpc-family-component-case-v1');
const registration = registerAcceptanceSample(sample, resolve(args.get('--case')!));
const definitionFile = resolve(args.get('--definition')!), definitionBytes = readFileSync(definitionFile);
const ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const { compileDeclarativeSwap } = await import(`${ROOT}/src/searcher/venues/declarative-swap.ts`);
const { createNodeStrictSourceSimulation } = await import(`${ROOT}/src/searcher/node-strict-source-simulation.ts`);
const { createStrictCentralAdapterRuntime } = await import(`${ROOT}/src/searcher/strict-central-adapter-runtime.ts`);
const { executeAdapterWork } = await import(`${ROOT}/src/searcher/adapter-work-intent.ts`);
const { keccak256, getBytes, hexlify } = await import(`${ROOT}/node_modules/ethers/lib.esm/index.js`);
const { runtimeProgramScript, encodeRuntimeAmountNode, RuntimeAmountProgram } = await import(`${ROOT}/src/adapters/runtime-amount-program.ts`);
const { buildSubscriptCalldata } = await import(`${ROOT}/src/shared/executor/botvm-program-entry.ts`);
const { concatBytes } = await import(`${ROOT}/src/encoder.ts`);
const { checkProtocolJsonExecutionFacts, checkProtocolJsonRevertFacts } = await import(`${ROOT}/src/searcher/test/protocol-json-acceptance-facts.ts`);
const rpcUrl = JSON.parse(readFileSync(resolve(args.get('--rpc-file')!), 'utf8')).MAINNET_RPC_URL;
const SOURCE = sample.source;
const control = { signal: AbortSignal.timeout(120000), deadlineAtMs: Date.now() + 120000 };
let reads = 0;
const block = { blockHash: SOURCE.hash, requireCanonical: true };
const EXECUTOR = sample.executor.toLowerCase(), ORIGIN = sample.owner.toLowerCase();
async function rpc(method: string, params: any[]) { assert(++reads <= 100, 'case direct-read budget'); control.signal.throwIfAborted(); const response = await fetch(rpcUrl, { method: 'POST', signal: AbortSignal.any([control.signal, AbortSignal.timeout(20000)]), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const r: any = await response.json(); if (r.error)
    throw new Error('RPC ' + method + ' failed code ' + r.error.code); return r.result; }
const code = await rpc('eth_getCode', [EXECUTOR, block]);
assert.notEqual(code, '0x');
if (sample.executorCodeHash)
    assert.equal(keccak256(code), sample.executorCodeHash);
const sim = createNodeStrictSourceSimulation({ control, identity: { source: SOURCE, chainId: 1, rpcUrl }, timeoutMs: 60000, executionGasLimit: 0x1000000, executor: EXECUTOR,
    executorRuntimeCode: { code, keccak256: keccak256(code) }, onFatal(reason: any) { throw new Error(JSON.stringify(reason)); } });
const runtime = createStrictCentralAdapterRuntime({ simulator: sim.transport, executor: EXECUTOR, transactionOrigin: ORIGIN,
    provider: { call: (tx: any) => rpc('eth_call', [tx, block]), getCode: (a: string) => rpc('eth_getCode', [a, block]), getStorage: (a: string, slot: string) => rpc('eth_getStorageAt', [a, slot, block]) },
    generationFence: { assertCurrent(g: number, s: any) { assert.deepEqual(s, SOURCE); assert.equal(g, SOURCE.generation); } } });
const J = (v: any) => JSON.stringify(v, (_k, v) => typeof v === 'bigint' ? v.toString() : v);
async function runRequests(requests: any[]) {
    const out = [];
    for (const request of requests) {
        const isSim = request.kind.endsWith('simulation');
        const caller = isSim ? request.call.caller : request.caller;
        const outcome = await executeAdapterWork({ runtime, control, intent: { stage: 'exact-refine', familyId: sample.familyId, source: SOURCE, generation: SOURCE.generation, programInput: undefined,
                program: { requirements: () => ({ transports: [request.kind], ...(caller?.kind && caller.kind !== 'none' ? { caller: caller.kind } : {}), ...(isSim ? { effects: request.observe } : {}) }), buildRequests: () => [request], decode: ({ results }: any) => results } } });
        assert.equal(outcome.status, 'resolved', J(outcome));
        const r = outcome.executed.evidence[0];
        if (request.required !== false)
            assert(r?.ok, J(r));
        out.push(r);
    }
    return out;
}
try {
    const raw = JSON.parse(definitionBytes.toString());
    assert.equal(raw.scope.family, sample.familyId);
    const plugin = compileDeclarativeSwap(raw, []);
    assert.equal(plugin.identity.variants.length, 1, 'component case requires one identity variant');
    const candidate = sample.candidate;
    const variant = plugin.identity.variants[0];
    let evidence: any, identity: any;
    for (let step = 0; step < 12; step++) {
        const input = { candidate, ...(evidence ? { evidence } : {}), step, executionRoundingRawUnits: 0n };
        const d = variant.decide(input);
        if (d.status === 'verified') {
            identity = d.identity;
            break;
        }
        assert.equal(d.status, 'continue', J(d));
        evidence = variant.decode({ step: input, results: await runRequests(variant.buildRequests(input)) });
    }
    assert(identity);
    const descriptor = plugin.instance.compileDraft(identity);
    const routes = plugin.routes.project({ descriptor });
    console.log('identity', J(identity.subject), 'routes', routes.map((r: any) => r.direction));
    const amount = BigInt(sample.amountIn), route = routes.find((r: any) => r.direction === sample.direction);
    assert(route);
    const invocation = { descriptor, route, amountIn: amount, source: SOURCE, executor: EXECUTOR, transactionOrigin: ORIGIN, runtimeEvidence: [] };
    const leg = plugin.execution.buildRuntimeLeg({ ...invocation, amountIn: undefined });
    assert(leg);
    const method = plugin.exact.methods(invocation).find((m: any) => m.program);
    const start = performance.now();
    const initialResults = await runRequests(method.program.buildRequests(invocation));
    const dep = [];
    for (let i = 0; i < 10; i++) {
        const b = method.program.buildDependentProgram?.({ programInput: invocation, completedRound: i, initialResults, priorEvidence: dep });
        if (!b)
            break;
        dep.push(b.decode(await runRequests(b.requests)));
    }
    const q = method.program.decode({ programInput: invocation, initialResults, dependentEvidence: dep });
    const quoteWallMs = performance.now() - start;
    if (sample.expectedAmountOut)
        assert.equal(q.amountOut, BigInt(sample.expectedAmountOut));
    console.log('quote', q.amountOut.toString(), 'componentWallMs', quoteWallMs);
    const executions = [];
    const fragment = plugin.execution.buildFragment({ ...invocation, quotedAmountOut: q.amountOut, minAmountOut: q.amountOut, exactEvidence: q.evidence });
    assert.equal(fragment.nodes.length, 1, 'component case requires one execution root');
    const scripts = [['quoted', encodeRuntimeAmountNode(fragment.nodes[0], new Uint8Array())], ['runtime', runtimeProgramScript(getBytes(leg.program), amount)]];
    for (const [encoding, originalScript] of scripts)
        for (const probe of ['positive', 'no-input', 'forced-revert']) {
            const script = probe === 'forced-revert' ? concatBytes(originalScript, runtimeProgramScript(new RuntimeAmountProgram().constant(0, 0n).constant(1, 1n).equal(0, 1).bytes())) : originalScript;
            const caller = { kind: 'executor' };
            const request = { id: `actual-${encoding}-${probe}`, kind: 'effect-delta-simulation', required: false,
                call: { caller, executionMode: 'executor-program', to: EXECUTOR, data: buildSubscriptCalldata(script) },
                overrideIntent: { caller, tokenBalances: [{ token: route.tokenIn, amount: probe === 'no-input' ? 0n : amount + 101n }, { token: route.tokenOut, amount: q.amountOut + 103n }] },
                observeTokenBalances: [route.tokenIn, route.tokenOut, ...(sample.protectedTokens ?? [])].map(token => ({ token, account: caller })),
                observe: ['return-data', 'revert-data', 'token-delta', 'native-delta', 'logs'] };
            const result = (await runRequests([request]))[0];
            const common = { requestId: request.id, result, source: SOURCE, tokenIn: route.tokenIn, tokenOut: route.tokenOut, executor: EXECUTOR, recipient: EXECUTOR, protectedBalances: (sample.protectedTokens ?? []).map((token: string) => ({ token, account: EXECUTOR })) };
            const facts = probe === 'positive' ? checkProtocolJsonExecutionFacts({ ...common, amountIn: amount, quoteAmountOut: q.amountOut, inputMode: 'exact', inputToleranceRawUnits: 0, outputToleranceRawUnits: 0 }) : checkProtocolJsonRevertFacts({ ...common, probe });
            console.log('execution', encoding, probe, J(facts));
            executions.push({ encoding, probe, facts, result });
            assert(facts.passed);
        }
    const standalone = await sim.transport.simulateStandalone({ source: SOURCE, control, callerAuthority: { executor: EXECUTOR, transactionOrigin: ORIGIN }, scriptHex: hexlify(scripts[1][1]), inputToken: route.tokenIn, inputAmount: amount });
    assert.equal(standalone.targetBlock, SOURCE.number + 1);
    assert.equal(standalone.kind, 'success');
    console.log('standalone-N+1', standalone.kind, standalone.targetBlock, standalone.gasUsed.toString());
    assert.equal(createHash('sha256').update(readFileSync(definitionFile)).digest('hex'), createHash('sha256').update(definitionBytes).digest('hex'));
    assertRegisteredAcceptanceSample(sample, registration);
    writeFileSync(resolve(args.get('--out')!), J({ registration, format: 'node-rpc-family-component-v1', sample, definitionSha256: createHash('sha256').update(definitionBytes).digest('hex'), source: SOURCE, executorCodeHash: keccak256(code), quote: q, quoteWallMs, executions, standalone, signing: false, broadcast: false, ready: 'not-run', performance: 'not-accepted', runtimeBuiltBeforeExact: true }));
}
finally {
    await sim.closeAndDrain();
}
