import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { Interface, FunctionFragment, toBeHex } from '../listener/node_modules/ethers/lib.esm/index.js';
import { buildDiscoveryUdf, declarativeBinding } from './ready-discovery-udf-build.mjs';
import { renderDeclarativeProductionEntry } from '../listener/src/searcher/build-declarative-production.ts';
import { compileSelectorNativeDiscovery } from '../listener/src/searcher/venues/selector-native-discovery.ts';
import { normalizeSelectorNativeExecutionDefinition, selectorNativeFamilyId } from '../listener/src/searcher/venues/selector-native-definition.ts';
import { readySelectorCensusFromTransaction } from '../listener/src/searcher/ready-selector-census.ts';
import { observationsFromTx, emptyCounts } from './bigquery-table.mjs';
import { readySelectorEdgesFromCensus, readySelectorEdgeKey } from '../listener/src/searcher/ready-selector-edges.ts';
import { createFamilyCapabilityShadowArtifact } from '../listener/src/searcher/venues/family-capability-shadow.ts';
import { FAMILY_CAPABILITY_NAMES } from '../listener/src/searcher/venues/family-capability-catalog.ts';
import { generateAbsentCapabilityIdentity } from '../listener/src/searcher/venues/capability-content-hash.ts';

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
const clone = value => JSON.parse(JSON.stringify(value));
const address = number => toBeHex(number, 20), word = number => toBeHex(number, 32);

test('native SQL and Ready produce identical selector/program/pool/token-id candidates in a pure browser realm', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'udf-native-selector-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourceRoot = join(directory, 'listener'); mkdirSync(sourceRoot);
  cpSync(join(repository, 'listener/src'), join(sourceRoot, 'src'), { recursive: true });
  const target = address(301), other = address(302), input = address(303), output = address(304), actor = address(305), recipient = address(306);
  const tokenId = (1n << 200n) + 17n;
  const signature = 'function censusConvert(string pool,uint256 tokenId,address tokenIn,address tokenOut,uint256 amount,address recipient) returns(uint256)';
  const selector = FunctionFragment.from(signature).selector, abi = new Interface([signature]);
  const parameters = [{ path: [0], role: 'poolId' }, { path: [1], role: 'tokenInId' }, { path: [2], role: 'tokenIn' },
    { path: [3], role: 'tokenOut' }, { path: [4], role: 'amountIn' }, { path: [5], role: 'recipient' }];
  const program = { parameters, payment: { kind: 'none' }, binding: {
    nomination: { poolIdPath: [0], poolNamespace: 'VaultScope', tokenInIdPath: [1] }, facts: {}, descriptor: { target: '$target' } } };
  const document = { format: 'selector-family/v2', selector, signature, domain: 'protocol', programs: [program,
    { ...program, payment: { kind: 'approval', address: '$target' } }] };
  const normalized = normalizeSelectorNativeExecutionDefinition(document), familyId = selectorNativeFamilyId(normalized);
  const { discovery } = compileSelectorNativeDiscovery(normalized);
  const stem = `selector-${selector.slice(2)}`;
  const definitionPath = `src/searcher/venues/selector-native/${stem}-family/${stem}.json`, definitionFile = join(sourceRoot, definitionPath);
  mkdirSync(dirname(definitionFile), { recursive: true }); writeFileSync(definitionFile, JSON.stringify(document));
  const production = renderDeclarativeProductionEntry({ rootDirectory: sourceRoot, definitionFile, document });
  writeFileSync(production.entryFile, production.source);
  const compiler = 'src/searcher/venues/selector-family-module.ts';
  const root = { familyId, entryExport: 'defineSelectorFamilyModule', entrySourceFile: join(sourceRoot, compiler),
    additionalSourceFiles: [definitionFile] };
  const catalog = join(directory, 'capability-fixture.json');
  writeFileSync(catalog, JSON.stringify(createFamilyCapabilityShadowArtifact({ legacy: [], exact: FAMILY_CAPABILITY_NAMES.map(capability=>({
    precision: 'capability-exact', identity: generateAbsentCapabilityIdentity({familyId,capability,provenanceCommit:null}),
    root: capability==='discovery'? { capability, entrySourceFile: compiler, entryExport: root.entryExport, additionalSourceFiles: [definitionPath], absence: null,
      authoringIntegrity:[{sourceFile:definitionPath,sha256:createHash('sha256').update(readFileSync(definitionFile)).digest('hex')}] }
      :{capability,entrySourceFile:null,entryExport:null,additionalSourceFiles:[],absence:'declared-absent'},
  })) })));
  const options = { catalog, sourceRoot, reader: join(repository, 'scripts/bigquery-table.mjs'), out: join(directory, 'kernel') };
  const report = await buildDiscoveryUdf(options), context = vm.createContext({});
  assert.equal(vm.runInContext('typeof Buffer+":"+typeof TextEncoder+":"+typeof process+":"+typeof require', context), 'undefined:undefined:undefined:undefined');
  for (const resource of report.resources) vm.runInContext(readFileSync(join(options.out, resource.file), 'utf8'), context, { timeout: 30000 });
  const kernel = context.DiscoveryKernel;
  assert.deepEqual(clone(kernel.rules()), [{ familyId, callPatterns: clone(discovery.callPatterns), logPatterns: [] }]);
  for (const name of ['selector-native-discovery.ts', 'selector-execution-keys.ts', 'selector-execution-observation.ts', 'ready-selector-census.ts'])
    assert(report.inputs.some(row => row.path.endsWith('/' + name)), name + ' must own query nominations');
  for (const name of ['selector-native-family.ts', 'selector-native-runtime.ts', 'selector-native-funding.ts', 'declarative-simulation.ts',
    'declarative-execution.ts', 'adapter-family-runtime.ts', 'strict-central-adapter-runtime.ts'])
    assert(!report.inputs.some(row => row.path.endsWith('/' + name)), name + ' must not enter SQL code');
  assert(!report.inputs.some(row => /\/venues\/(protocols|swaps|funding|execution-shapes)\//.test(row.path)));
  const transfer1155 = new Interface(['event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)']);
  const transfer20 = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  let transactionNumber = 700, cases = 0;
  function transaction({ pool = 'PoolA', id = tokenId, to = target, amount = 17n, receiver = actor, block = 100, swapped = false } = {}) {
    const tokenIn = swapped ? output : input, tokenOut = swapped ? input : output;
    const incoming = transfer1155.encodeEventLog(transfer1155.getEvent('TransferSingle'), [actor, actor, to, id, amount]);
    const outgoing = transfer20.encodeEventLog(transfer20.getEvent('Transfer'), [to, actor, 23n]);
    return { chain_id: 1, tx_hash: word(transactionNumber++), block_number: String(block), block_hash: word(block), transaction_index: '0', receipt_status: '1',
      from_address: actor, to_address: to, input: abi.encodeFunctionData(selector, [pool, id, tokenIn, tokenOut, amount, receiver]),
      logs: [{ log_address: tokenIn, log_index: '0', ...incoming }, { log_address: tokenOut, log_index: '1', ...outgoing }], traces: [] };
  }
  function compare(tx, expectedCount = 2) {
    const census = readySelectorCensusFromTransaction(tx, { chainId: 1 });
    const observations = observationsFromTx(tx, emptyCounts(), census).filter(row => row.kind === 'call');
    const expected = observations.flatMap(observation => discovery.callPatterns.flatMap(pattern => {
      const decoded = discovery.decodeCandidate({ observation: { ...observation, source: { number: Number(tx.block_number), hash: tx.block_hash,
        generation: Number(tx.block_number) } }, matchedPatternId: pattern.id });
      return decoded === null ? [] : [decoded];
    }));
    const all = JSON.parse(kernel.compactTransactionJson(JSON.stringify(tx))), records = all.filter(row => row.kind === 'candidate');
    assert.equal(records.length, expectedCount); assert.equal(records.length, expected.length);
    assert.deepEqual(all.find(row => row.kind === 'selector-census').snapshot, clone(census));
    const expectedEdges=readySelectorEdgesFromCensus(census,expected.map(candidate=>({familyId,signature,candidate})));
    const edgeRecords=all.filter(row=>row.kind==='selector-edge');
    assert.deepEqual(edgeRecords.map(row=>row.snapshot),clone(expectedEdges));
    assert.deepEqual(edgeRecords.map(row=>row.key),expectedEdges.map(readySelectorEdgeKey));
    assert(edgeRecords.length>=census.calls.length,'every supplied call keeps its pre-admission edge observation');
    for (const candidate of expected) {
      const record = records.find(row => row.snapshot.programKey === candidate.programKey && row.snapshot.callId === candidate.callId);
      assert(record, 'each program/call retains its independent candidate');
      for (const [key, value] of Object.entries(candidate)) assert.deepEqual(record.snapshot[key], clone(value), key);
      assert.equal(record.snapshot.pluginCandidateKey, discovery.candidateKey(candidate));
      assert.equal(record.snapshot.familyId, familyId);
      assert.equal(record.snapshot.scope.poolNamespace, 'VaultScope');
      assert(!Object.hasOwn(record.snapshot, 'identity')); assert(!Object.hasOwn(record.snapshot, 'routeHandles'));
      assert.deepEqual(record.snapshot.readyObservation.traceAddress, observations.find(row => row.opaque.callId === candidate.callId).traceAddress);
    }
    cases++; return records;
  }
  const first = compare(transaction());
  assert.equal(new Set(first.map(row => row.key)).size, 2, 'different recipes survive dedupe within one selector family');
  assert.equal(first[0].snapshot.scope.tokenInId, String(tokenId));
  assert.equal(first[0].snapshot.scope.tokenIn, input);
  const keys = rows => rows.map(row => row.key).sort();
  assert.deepEqual(keys(compare(transaction({ amount: 999n, receiver: recipient, block: 101 }))), keys(first), 'mutable amount, recipient and source do not enter nomination identity');
  for (const change of [{ pool: 'PoolB' }, { pool: 'poola' }, { id: tokenId + 1n }, { to: other }, { swapped: true }])
    assert.notDeepEqual(keys(compare(transaction(change))), keys(first), 'resource, token id, target and direction must survive SQL compaction');
  const unknown = transaction(); unknown.input = '0xdeadbeef' + unknown.input.slice(10); compare(unknown, 0);
  const reverted = transaction(); reverted.receipt_status = '0'; compare(reverted, 0);
  const malformed = transaction(); malformed.input += '00'; compare(malformed, 0);
  const absent = transaction(); delete absent.input; compare(absent, 0);
  const internal = transaction();
  internal.traces = [{ trace_address: '', to_address: target, from_address: actor, call_type: 'call', status: '1', input: internal.input },
    { trace_address: '0', to_address: other, from_address: actor, call_type: 'call', status: '1', input: internal.input }];
  const inner = compare(internal, 4);
  assert(inner.some(row => row.snapshot.callId.startsWith('trace:1:0')));
  assert.equal(new Set(inner.map(row => row.key)).size, 4, 'root alias is deduped and an internal different target is retained');
  assert.equal(declarativeBinding(root, sourceRoot).selectorNative, true);
  assert.deepEqual(declarativeBinding(root, sourceRoot).children, []);
  assert.throws(() => declarativeBinding({ ...root, familyId: 'execution:0x00000000:static-words-3' }, sourceRoot), /family key mismatch/);
  writeFileSync(production.entryFile, production.source.replace('(definition)', '(definition, [])'));
  assert.throws(() => declarativeBinding(root, sourceRoot), /one independent JSON/);
  t.diagnostic(JSON.stringify({ family: familyId, programs: 2, cases, kernelBytes: report.kernelBytes,
    tokenId: String(tokenId), realm: 'no Buffer/TextEncoder/process/require', authority: 'SQL candidates only; no admission, RPC, VM or execution compiler' }));
});
