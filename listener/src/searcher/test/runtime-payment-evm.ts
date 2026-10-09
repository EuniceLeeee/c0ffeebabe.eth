import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ethers } from 'ethers';
import { fileURLToPath } from 'node:url';
import { RuntimeAmountProgram, runtimePayment, runtimeProgramScript, runtimeAmountFlowAdapter } from '../../adapters/runtime-amount-program.js';
import { univ4Execution } from '../venues/swaps/univ4-family/execution.js';
import { univ4FeeHookExecution } from '../venues/swaps/univ4-fee-hook-family/execution.js';
import { univ4FeeHookRoutes } from '../venues/swaps/univ4-fee-hook-family/routes.js';
import { UNIV4_FEE_HOOK_FAMILY_ID, UNIV4_FEE_HOOK_LINEAGE_ID, UNIV4_FEE_HOOK_ADDRESS } from '../venues/swaps/univ4-fee-hook-family/manifest.js';
import { hookDataFor } from '../venues/swaps/univ4-fee-hook-family/sat1.js';
import { PRODUCTION_STRICT_SHADOW_ACTION_ADAPTERS } from '../venues/production-family-composition.js';
import { concatBytes } from '../../encoder.js';
import type { ResolvedPlanNode } from '../../types.js';
import { poolKeyFingerprint } from '../venues/swaps/univ4-family/codec.js';
import { loadBotVmRuntimeCode, buildExecuteCalldata } from '../../shared/executor/botvm-executor.js';
import { buildUniV4RuntimeLeg } from '../venues/swaps/univ4-family/runtime-execution.js';
import { univ4Routes } from '../venues/swaps/univ4-family/routes.js';
import { UNIV4_FAMILY_ID, UNIV4_MANAGER_LINEAGE_ID } from '../venues/swaps/univ4-family/manifest.js';
import { applyRuntimeAssetBoundary, applyQuotedAssetBoundary } from '../execution-asset-boundary.js';
import { ADDR } from '../../shared/constants/addresses.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, ''), abi = ethers.AbiCoder.defaultAbiCoder();
const token0 = '0x' + '11'.repeat(20), token1 = '0x' + '22'.repeat(20);
const manager = '0x' + '33'.repeat(20), executor = '0x' + '44'.repeat(20), owner = '0x' + '55'.repeat(20);
const returnLeg = '0x' + '66'.repeat(20), other = '0x' + '77'.repeat(20);
const tokenAbi = new ethers.Interface(['function mint(address,uint256)', 'function balanceOf(address) view returns(uint256)']);
const managerAbi = new ethers.Interface(['function configure(uint128,uint128,int256)', 'function paid() view returns(uint256)', 'function requested() view returns(uint256)',
  'function lastHook() view returns(address)', 'function hookDataHash() view returns(bytes32)']);
const returnAbi = new ethers.Interface(['function swap(address,address,uint256,uint256)']);
const json = (x: unknown) => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
fs.mkdirSync(root + '/logs', { recursive: true });
const out = fs.mkdtempSync(root + '/logs/unified-payment-evm-');
const save = (name: string, x: unknown) => fs.writeFileSync(out + '/' + name, json(x), { flag: 'wx', mode: 0o600 });
const option = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  assert(process.argv[index + 1] && !process.argv[index + 1].startsWith('--'), `${name} requires a path`);
  return process.argv[index + 1];
};
const mockArtifacts = option('--mock-artifacts', root + '/out');
const artifact = (name: string) => {
  const parsed = JSON.parse(fs.readFileSync(mockArtifacts + `/RuntimePaymentMocks.sol/${name}.json`, 'utf8'));
  const metadata = typeof parsed.metadata === 'string' ? JSON.parse(parsed.metadata) : parsed.metadata;
  for (const [path, source] of Object.entries(metadata.sources) as [string, { keccak256: string }][]) {
    assert(!path.startsWith('/') && !path.split('/').includes('..'), 'artifact source path');
    assert.equal(ethers.keccak256(fs.readFileSync(root + '/' + path)), source.keccak256, 'mock artifact must match current source');
  }
  return parsed.deployedBytecode.object;
};
const tokenCode = artifact('RuntimePaymentToken'), managerCode = artifact('RuntimePaymentManager');
const anvil = spawn(option('--anvil-bin', 'anvil'), ['--host', '127.0.0.1', '--port', '0', '--accounts', '0', '--hardfork', 'cancun', '--gas-limit', '60000000', '--base-fee', '0'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', spawnError: Error | undefined;
anvil.stdout.on('data', b => output += b.toString()); anvil.stderr.on('data', b => output += b.toString());
anvil.on('error', e => spawnError = e);
const closed = new Promise<void>(resolve => anvil.once('close', () => resolve()));
try {
  const deadline = Date.now() + 10000;
  while (!/Listening on 127\.0\.0\.1:\d+/.test(output)) {
    if (spawnError) throw spawnError;
    assert(anvil.exitCode === null && Date.now() < deadline, 'Anvil startup'); await delay(20);
  }
  const endpoint = 'http://' + output.match(/Listening on (127\.0\.0\.1:\d+)/)![1];
  let id = 0;
  async function rpc(method: string, params: any[]): Promise<any> {
    assert(endpoint.startsWith('http://127.0.0.1:'), 'local EVM only');
    const response: any = await (await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(10000) })).json();
    assert(!response.error, json(response.error)); return response.result;
  }
  async function tx(to: string, data: string) {
    const hash = await rpc('eth_sendTransaction', [{ from: owner, to, data, gas: '0xf00000', gasPrice: '0x0' }]);
    const deadline = Date.now() + 10000;
    for (;;) {
      const receipt = await rpc('eth_getTransactionReceipt', [hash]);
      if (receipt !== null) return receipt;
      assert(Date.now() < deadline, 'local transaction receipt timeout');
      await delay(20);
    }
  }
  const read = async (to: string, iface: ethers.Interface, method: string, args: any[] = []) =>
    iface.decodeFunctionResult(method, await rpc('eth_call', [{ to, data: iface.encodeFunctionData(method, args) }, 'latest']))[0];
  const balance = (token: string, holder: string) => read(token, tokenAbi, 'balanceOf', [holder]);
  await rpc('anvil_setBalance', [owner, ethers.toQuantity(10n ** 20n)]);
  await rpc('anvil_impersonateAccount', [owner]);
  for (const token of [token0, token1, ADDR.WETH]) {
    await rpc('anvil_setCode', [token, tokenCode]); await rpc('anvil_setBalance', [token, ethers.toQuantity(10n ** 20n)]);
  }
  await rpc('anvil_setCode', [manager, managerCode]); await rpc('anvil_setBalance', [manager, ethers.toQuantity(10n ** 20n)]);
  await rpc('anvil_setCode', [returnLeg, artifact('RuntimePaymentReturnLeg')]);
  await rpc('anvil_setCode', [executor, loadBotVmRuntimeCode(owner).code]);
  const rows: any[] = [];
  const compile = (node: ResolvedPlanNode): Uint8Array => {
    const action = PRODUCTION_STRICT_SHADOW_ACTION_ADAPTERS.find(a => a.id === node.adapterId);
    assert(action, `production action ${node.adapterId}`);
    return action.encode(node, executor, concatBytes(...node.children.map(compile)));
  };
  // Native fee-hook first: this caught the old unframed quoted callback that
  // the original no-hook-only EVM cases could never exercise.
  for (const variant of ['fee-hook', 'no-hook', 'sat1'] as const)
  for (const native of variant === 'sat1' ? [true] : [true, false]) for (const reverse of [false, true]) {
    const feeHook = variant !== 'no-hook';
    const hooks = variant === 'sat1' ? '0x2a0a30dd78af7698e6f40212b8b8324fce2ee888' : feeHook ? UNIV4_FEE_HOOK_ADDRESS : ethers.ZeroAddress;
    const key = { currency0: native ? ethers.ZeroAddress : token0, currency1: token1, fee: 3000, tickSpacing: 60, hooks };
    const poolId = ethers.keccak256(abi.encode(['address', 'address', 'uint24', 'int24', 'address'], Object.values(key)));
    const descriptor: any = { familyId: feeHook ? UNIV4_FEE_HOOK_FAMILY_ID : UNIV4_FAMILY_ID,
      lineageId: feeHook ? UNIV4_FEE_HOOK_LINEAGE_ID : UNIV4_MANAGER_LINEAGE_ID,
      instanceKey: manager + ':' + poolId, provenance: [], runtimeRequirements: [], poolId, poolKey: key,
      graphToken0: native ? ADDR.WETH : token0, graphToken1: token1,
      managerBinding: { manager, stateView: other, quoter: other, managerCodeHash: ethers.keccak256(managerCode) },
      hookPolicy: feeHook ? 'fee-hook' : 'no-hook', ...(feeHook ? { hook: hooks } : {}),
      ...(variant === 'sat1' ? { hookModel: 'sat1' } : {}) };
    const route = (feeHook ? univ4FeeHookRoutes : univ4Routes).project({ descriptor })[reverse ? 1 : 0];
    const hookData = feeHook ? hookDataFor(descriptor, executor, !reverse) : '0x';
    const rawLeg = feeHook ? univ4FeeHookExecution.buildRuntimeLeg({ descriptor, route, executor }) : buildUniV4RuntimeLeg({ descriptor, route, executor });
    assert(rawLeg);
    const leg = applyRuntimeAssetBoundary({ route, executor, leg: rawLeg });
    const name = `${variant}-${native ? 'native' : 'erc20'}-${reverse ? 'reverse' : 'forward'}`;
    const execution: any = { descriptor, route, executor,
      amountIn: 100n, quotedAmountOut: 7n, minAmountOut: 0n, runtimeEvidence: [],
      exactEvidence: { kind: variant === 'sat1' ? 'sat1-local-exact-in' : feeHook ? 'univ4-fee-hook-quoter' : 'univ4-no-hook-quoter',
        source: { number: 20000000, hash: '0x' + 'aa'.repeat(32), generation: 1 },
        poolId, poolKeyFingerprint: poolKeyFingerprint(key), quoter: other,
        tokenIn: route.tokenIn, tokenOut: route.tokenOut, amountIn: 100n, amountOut: 7n,
        gasEstimate: 0n, hookData },
    };
    const fragment = (feeHook ? univ4FeeHookExecution : univ4Execution).buildFragment(execution);
    assert.equal(fragment.nodes.length, 1);
    const rawQuotedScript = compile(fragment.nodes[0]);
    const issuedFragment = applyQuotedAssetBoundary({ route, executor, amountIn: 100n, minimum: 0n, fragment });
    const quotedScript = compile(issuedFragment.nodes[0]);
    for (const [debt, skew, success] of [[100n, 0n, true], [30n, 0n, true], [0n, 0n, true], [101n, 0n, false], [30n, 1n, false], [30n, -1n, false]] as const) {
      const snapshot = await rpc('evm_snapshot', []);
      const received = debt === 0n ? 0n : 7n;
      await tx(route.tokenIn, tokenAbi.encodeFunctionData('mint', [executor, 1100n]));
      await tx(route.tokenOut, tokenAbi.encodeFunctionData('mint', [executor, 777n]));
      await tx(route.tokenOut, tokenAbi.encodeFunctionData('mint', [manager, 1000n]));
      await tx(manager, managerAbi.encodeFunctionData('configure', [debt, received, skew]));
      const receipt = await tx(executor, buildExecuteCalldata(quotedScript));
      if ((receipt.status === '0x1') !== success) {
        save('failure.json', { name, debt, skew, expectedSuccess: success, receipt });
        if (success) await rpc('eth_call', [{ from: owner, to: executor, data: buildExecuteCalldata(quotedScript), gas: '0xf00000' }, 'latest']);
      }
      assert.equal(receipt.status === '0x1', success, `${name} debt=${debt} skew=${skew}`);
      assert.equal(await balance(route.tokenIn, executor), success ? 1100n - debt : 1100n);
      assert.equal(await balance(route.tokenOut, executor), success ? 777n + received : 777n);
      assert.equal(BigInt(await rpc('eth_getBalance', [executor, 'latest'])), 0n, 'no native residue');
      if (success) {
        assert.equal(await read(manager, managerAbi, 'paid'), debt);
        assert.equal(await read(manager, managerAbi, 'requested'), 100n);
        assert.equal((await read(manager, managerAbi, 'lastHook')).toLowerCase(), hooks.toLowerCase());
        assert.equal(await read(manager, managerAbi, 'hookDataHash'), ethers.keccak256(hookData));
      }
      rows.push({ name, debt, skew, success, gasUsed: receipt.gasUsed });
      assert(await rpc('evm_revert', [snapshot]));
    }
    assert.deepEqual(rawQuotedScript, runtimeProgramScript(ethers.getBytes(rawLeg.program), 100n),
      'quoted construction must use the identical framed settlement program');
    if (native) for (const received of [6n, 7n]) {
      const snapshot = await rpc('evm_snapshot', []), success = received === 7n;
      await tx(route.tokenIn, tokenAbi.encodeFunctionData('mint', [executor, 1100n]));
      await tx(route.tokenOut, tokenAbi.encodeFunctionData('mint', [executor, 777n]));
      await tx(route.tokenOut, tokenAbi.encodeFunctionData('mint', [manager, 1000n]));
      await tx(manager, managerAbi.encodeFunctionData('configure', [100n, received, 0n]));
      const guarded = applyQuotedAssetBoundary({ route, executor, amountIn: 100n, minimum: 7n, fragment });
      const receipt = await tx(executor, buildExecuteCalldata(compile(guarded.nodes[0])));
      assert.equal(receipt.status === '0x1', success, `${name} measured minimum received=${received}`);
      assert.equal(await balance(route.tokenIn, executor), success ? 1000n : 1100n);
      assert.equal(await balance(route.tokenOut, executor), success ? 784n : 777n, 'old inventory cannot meet the new output minimum');
      assert.equal(BigInt(await rpc('eth_getBalance', [executor, 'latest'])), 0n);
      rows.push({ name, kind: 'quoted-output-minimum', requested: 100n, minimum: 7n, received, success });
      assert(await rpc('evm_revert', [snapshot]));
    }
    // The raw payment can settle partial debt, but live flow input tolerance is
    // independently bounded to 0/1 unit. Generic non-live fragments above retain
    // their partial-refund behavior; they cannot bypass the enclosing flow.
    for (const [debt, tolerance, success] of [[100n, 0n, true], [99n, 0n, false],
      [99n, 1n, true], [98n, 1n, false], [30n, 0n, false], [0n, 1n, false]] as const) {
    const snapshot = await rpc('evm_snapshot', []);
    await tx(route.tokenIn, tokenAbi.encodeFunctionData('mint', [executor, 1100n]));
    await tx(route.tokenOut, tokenAbi.encodeFunctionData('mint', [executor, 777n]));
    await tx(route.tokenOut, tokenAbi.encodeFunctionData('mint', [manager, 1000n]));
    await tx(manager, managerAbi.encodeFunctionData('configure', [debt, 200n, 0n]));
    const returning = new RuntimeAmountProgram().call(returnLeg, returnAbi.encodeFunctionData('swap', [route.tokenOut, route.tokenIn, 0n, 120n]), { patches: [{ offset: 68, reg: 0 }] });
    const flow = runtimeAmountFlowAdapter.encode({ adapterId: 'runtime-amount-flow', target: executor,
      tokenIn: route.tokenIn, tokenOut: route.tokenIn, amount: 100n, children: [], params: { minimumReturn: 101n, quoteToleranceRawUnits: tolerance, legs: json([
        { tokenIn: route.tokenIn, tokenOut: route.tokenOut, program: leg.program },
        { tokenIn: route.tokenOut, tokenOut: route.tokenIn, program: ethers.hexlify(returning.bytes()) },
      ]) } }, executor, new Uint8Array());
    const receipt = await tx(executor, buildExecuteCalldata(flow));
    assert.equal(receipt.status === '0x1', success, `${name} flow debt=${debt} tolerance=${tolerance}`);
    assert.equal(await balance(route.tokenIn, executor), success ? 1100n - debt + 120n : 1100n);
    assert.equal(await balance(route.tokenOut, executor), 777n);
    assert.equal(BigInt(await rpc('eth_getBalance', [executor, 'latest'])), 0n, 'flow restores native inventory');
    rows.push({ name, kind: 'closed-runtime-flow', requested: 100n, debt, tolerance,
      actualFirstOutput: success ? 200n : 0n, finalWorkingReturn: success ? 220n - debt : 0n, success });
    assert(await rpc('evm_revert', [snapshot]));
    }
  }
  // Register aliasing must not overwrite the debt or turn settlement into a
  // tautology. These are generator errors, rejected before VM execution.
  for (const [debt, scratch] of [[0, 1], [1, 0], [1, 1]]) assert.throws(() => runtimePayment(new RuntimeAmountProgram(), debt, scratch), /payment registers/);
  const payment = runtimePayment(new RuntimeAmountProgram(), 1, 2);
  assert.throws(() => payment.verifySettled(1), /settlement register/);
  assert.throws(() => payment.verifySettled(0), /settlement register/);
  save('summary.json', { scope: 'Production no-hook/fee-hook/Sat1 encoders, common native boundary and real BotVM on local Anvil; stateful mocks check hookData delivery, not actual hook logic, historical liquidity, Ready or opportunity evidence.', rows });
  console.log(json({ out, cases: rows.length, passed: rows.length }));
} finally { anvil.kill('SIGTERM'); await closed; }
