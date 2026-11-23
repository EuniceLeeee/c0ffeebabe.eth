import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gzipSync,gunzipSync} from 'node:zlib';
import {Interface,FunctionFragment} from '../listener/node_modules/ethers/lib.esm/index.js';
import {exportIndependentLive,projectIndependentRows} from './selector-independent-live-export.mjs';
import {renderIndependentTraceEdges,ready21Window as window} from './independent-trace-edges.mjs';
import {sqlDirectionId} from '../listener/src/searcher/sql-edge-price-index.ts';
import {loadLiveSqlTables} from '../listener/src/searcher/sql-live-tables.ts';
import {selectorFundingInstanceKey} from '../listener/src/searcher/venues/selector-native-funding-definition.ts';
import {selectorAssetOfferKey} from '../listener/src/searcher/venues/selector-execution-keys.ts';

const H=b=>createHash('sha256').update(b).digest('hex'),a=c=>'0x'+c.repeat(40),w=c=>'0x'+c.repeat(64);
const sel='0x128acb08',pool=a('1'),t0=a('0'),t1=a('b'),weth='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const row=(s={})=>({selector:sel,poolAddress:pool,callTarget:pool,poolId:null,tokenIn:t0,tokenOut:t1,verified:false,observedTargetSelector:true,observations:'1',
  evidenceTypes:['subtree-net-flow'],example:{txHash:w('c'),callPath:'1,0',selectorTarget:pool,evidence:'subtree-net-flow'},...s});
const defs=(programs=[])=>new Map([[sel,{programs}],['0x022c0d9f',{programs:[]}]]);
function old(r,extra={}){const c={chainId:1,selector:r.selector,poolAddress:r.poolAddress,poolId:r.poolId,poolNamespace:null,tokenIn:r.tokenIn,
  tokenInId:null,tokenOut:r.tokenOut,tokenOutId:null,...extra};return {candidateInstanceKey:sqlDirectionId(c),...c};}
const logical=[{binding:{stateBinding:{poolNamespace:'opaque'},nomination:{poolNamespace:'opaque'}}}];
test('one upstream row → one original public ID; native not WETH, no opposite or historical-only additions',()=>{
  const r=row(),prior=[old(row({tokenIn:t1,tokenOut:t0}))],out=projectIndependentRows([r],prior,defs());
  assert.deepEqual(out.accepted,[old(r)]);assert.equal(out.accepted[0].tokenIn,t0);assert.equal(out.preserved,0);
  assert.throws(()=>projectIndependentRows([r,r],[],defs()),/duplicate/);
});
test('full poolId, compatible previously unqualified keys and new namespaces remain distinct',()=>{
  const x=row({poolId:w('1')}),y=row({poolId:w('2')});
  const p=projectIndependentRows([x,y],[old(x)],defs(logical));
  assert.deepEqual(p.accepted,[old(x),old(y,{poolNamespace:'opaque'})]);assert.equal(p.preserved,1);
  assert.deepEqual(projectIndependentRows([x],[old(x),old(x,{poolNamespace:'opaque'})],defs(logical)).rejected[0].priorIds.length,2);
});
test('an exact old ID and the reverse-direction history cannot override the receiving namespace; legacy null stays null',()=>{
  const x=row({poolId:w('a')}),reverse={...x,tokenIn:x.tokenOut,tokenOut:x.tokenIn};
  for(const historic of [x,reverse]){
    const p=projectIndependentRows([x],[old(historic,{poolNamespace:'retired'})],defs(logical));
    assert.equal(p.accepted.length,0);assert.equal(p.rejected[0].reason,'prior-and-declared-pool-namespace-disagree');
  }
  const exactNs=old(x,{poolNamespace:'opaque'}),unqualified=old(x);
  assert.deepEqual(projectIndependentRows([x],[exactNs],defs(logical)).accepted,[exactNs]);
  assert.deepEqual(projectIndependentRows([x],[unqualified],defs(logical)).accepted,[unqualified]);
  assert.equal(projectIndependentRows([x],[exactNs],defs()).rejected[0].reason,'pool-namespace-not-uniquely-evidenced');
  const another={binding:{nomination:{poolNamespace:'alternative'}}};
  assert.equal(projectIndependentRows([x],[exactNs],defs([...logical,another])).rejected[0].reason,'pool-namespace-not-uniquely-evidenced');
});
test('missing pool/asset IDs, conflicting scopes and different execution target are not invented',()=>{
  const x=row({poolId:w('a')});
  assert.equal(projectIndependentRows([x],[],defs()).rejected[0].reason,'pool-namespace-not-uniquely-evidenced');
  assert.equal(projectIndependentRows([row()],[],defs(logical)).rejected[0].reason,'required-logical-pool-id-absent');
  assert.equal(projectIndependentRows([row()],[old(row(),{tokenInId:'17'})],defs()).rejected[0].reason,'upstream-movements-do-not-identify-asset-subtypes');
  const outer=row({observations:'7',example:{...row().example,selectorTarget:a('2')}});
  const [r]=projectIndependentRows([outer],[],defs()).rejected;assert.equal(r.poolAddress,pool);assert.equal(r.example.selectorTarget,a('2'));
  assert.equal(r.reason,'example-call-target-differs-from-physical-pool');assert.equal(r.observations,'7');
  assert.throws(()=>projectIndependentRows([row({verified:true})],[],defs()),/evidence/);
});
test('shared entry, full pool ID and direction survive projection; legacy address is a lookup alias only',()=>{
  const selector='0x52bbbe29', vault='0xba12222222228d8ba445958a75a0704d566bf2c8';
  const definitions=new Map([[selector,{programs:logical}]]),evidence='vault-swap-poolid';
  const shared=row({selector,poolAddress:vault,callTarget:vault,poolId:pool+'0'.repeat(24),
    evidenceTypes:[evidence],example:{...row().example,selectorTarget:vault,observedPoolAddress:pool,evidence}});
  const historical=old({...shared,poolAddress:pool}), canonical=old(shared,{poolNamespace:'opaque'});
  const projected=projectIndependentRows([shared],[historical,canonical],definitions);
  assert.deepEqual(projected.accepted,[canonical]);
  assert.deepEqual(projected.aliases,[{previous:historical.candidateInstanceKey,current:canonical.candidateInstanceKey}]);
  for(const changed of [{callTarget:null},{callTarget:pool},{example:{...shared.example,selectorTarget:pool}},
    {evidenceTypes:['subtree-net-flow'],example:{...shared.example,evidence:'subtree-net-flow'}}]){
    assert.equal(projectIndependentRows([{...shared,...changed}],[],definitions).accepted.length,0);
  }
});
async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'independent-projection-test-')), rows=[row(),row({tokenIn:t1,tokenOut:t0})];
  rows[0].example.note='escaped }" string – '+'x'.repeat(70001); // span an input chunk
  const put=async(name,b)=>{await writeFile(join(dir,name),b);return H(b);};
  const sql=await renderIndependentTraceEdges(window,{liveSelectorsOnly:true});
  const edgesSha256=await put('edges.json',JSON.stringify(rows,null,2)+'\n');
  const manifest={window,total:2,liveSelectorsOnly:true,observations:2,edgesSha256,sqlSha256:H(sql)};
  const upstream=join(dir,'manifest.json'),upstreamSha256=await put('manifest.json',JSON.stringify(manifest));
  const sig='function flashLoan(address,uint256,bytes)',iface=new Interface([sig]),selector=FunctionFragment.from(sig).selector,provider=a('8');
  const fundingRow={offerKey:selectorAssetOfferKey(selectorFundingInstanceKey({chainId:1,provider,asset:weth,selector,signature:sig}),{address:weth}),
    provider,selector,asset:weth,input:iface.encodeFunctionData(selector,[weth,1,'0x']),callback:FunctionFragment.from('function onMorphoFlashLoan(uint256,bytes)').selector,
    block_number:window.toBlock,block_hash:window.headHash,tx_hash:w('b'),transaction_index:0,trace_address:'',callback_path:'0',observations:1};
  const funding=join(dir,'funding.json'),fundingSha256=await put('funding.json',JSON.stringify({format:'sql-live-funding/v1',chainId:1,window,failures:[],rows:[fundingRow],
    sourceCoverage:{firstBlock:String(window.fromBlock),lastBlock:String(window.toBlock),head:window.headHash,transactions:window.transactions,distinctTx:window.transactions,activeHashes:'512',missingTraces:'0'}}));
  return {dir,rows,manifest,put,args:{upstream,upstreamSha256,noPrior:true,funding,fundingSha256,out:join(dir,'out')}};
}
test('filtered JSON + independent funding are sealed/read by the native loader; full source is retained; no overwrite',async()=>{
  const {dir,args}=await fixture(),result=await exportIndependentLive(args);
  assert.equal(result.accepted,2);const loaded=await loadLiveSqlTables(join(args.out,'sql-live-input.json'),result.inputSha256);
  assert.equal(loaded.edges.length,2);assert.equal(loaded.fundingAssets.length,1);
  assert.equal(H(await readFile(join(args.out,'upstream-edges.json'))),H(await readFile(join(dir,'edges.json'))));
  await assert.rejects(exportIndependentLive(args),/EEXIST/);
});
test('full archival JSONL stream requires congruent raw AND filtered hashes; swaps-only cannot produce live input',async()=>{
  const f=await fixture(),rows=[row({selector:'0x00000000'}),...f.rows];
  const tsv=r=>[r.selector,r.poolAddress,r.poolId??'',r.tokenIn,r.tokenOut].join('\t')+'\n';
  const edgesSha256=await f.put('archive.gz',gzipSync(rows.map(r=>JSON.stringify(r)+'\n').join('')));
  const m={format:'independent-discovery-archive/v1',window,mode:'all',edgeFile:'archive.gz',edgesSha256,total:3,
    keySha256:H(rows.map(tsv).join('')),fullSqlSha256:H(await renderIndependentTraceEdges(window)),
    filtered:{rows:2,sqlSha256:f.manifest.sqlSha256,keySha256:H(f.rows.map(tsv).join(''))}};
  const args={upstream:f.args.upstream,noPrior:true,swapsOnly:true,out:f.args.out};
  let upstreamSha256=await f.put('manifest.json',JSON.stringify({...m,filtered:{...m.filtered,keySha256:'0'.repeat(64)}}));
  await assert.rejects(exportIndependentLive({...args,upstreamSha256}),/filtered keys/);
  upstreamSha256=await f.put('manifest.json',JSON.stringify(m));
  const result=await exportIndependentLive({...args,upstreamSha256});assert.equal(result.rawRows,3);assert.equal(result.source,2);
  await assert.rejects(access(join(args.out,'sql-live-input.json')));assert.equal(result.inputSha256,undefined);
  assert.equal(gunzipSync(await readFile(join(args.out,'upstream-edges.jsonl.gz'))).toString().trim().split('\n').length,3);
});
test('mismatched SQL, incorrect mode, replaced edge file or credentialless funding substitution are rejected',async()=>{
  const f=await fixture();
  await assert.rejects(exportIndependentLive({...f.args,fundingSha256:'1'.repeat(64)}),/digest mismatch/);
  for(const [changed,err] of [[{liveSelectorsOnly:false},/filtered/],[{sqlSha256:'1'.repeat(64)},/SQL/],[{edgesSha256:'1'.repeat(64)},/bytes differ/]]){
    const upstreamSha256=await f.put('manifest.json',JSON.stringify({...f.manifest,...changed}));
    await assert.rejects(exportIndependentLive({...f.args,upstreamSha256}),err);
  }
});
test('funding coverage is pinned to the swap transaction census and optional window metadata; original nested evidence stays supported',async()=>{
  const f=await fixture(),orig=JSON.parse(await readFile(f.args.funding));
  const exportFunding=async doc=>exportIndependentLive({...f.args,fundingSha256:await f.put('funding.json',JSON.stringify(doc))});
  await assert.rejects(exportFunding({...orig,sourceCoverage:{...orig.sourceCoverage,transactions:'2',distinctTx:'2'}}));
  for(const mismatch of [{transactions:'1'},{lastTime:'2026-11-09T15:59:58.000000Z'},{firstTime:'2026-11-09T14:17:24.000000Z'},{chainId:2}]){
    await assert.rejects(exportFunding({...orig,window:{...orig.window,...mismatch}}));
  }
  const {sourceCoverage,...nested}=orig;
  nested.window={fromBlock:window.fromBlock,toBlock:window.toBlock,headHash:window.headHash};
  nested.provenance={trace:{coverage:sourceCoverage}};
  assert.equal((await exportFunding(nested)).fundingOffers,1);
});
