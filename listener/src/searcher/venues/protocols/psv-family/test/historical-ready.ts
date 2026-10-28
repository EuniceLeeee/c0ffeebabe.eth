// Thin historical correctness invocation of production rebuild + prices.
import assert from 'node:assert/strict';
import {constants,copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {UniverseRebuildCheckpointStore,activeReadyMemos} from '../../../../universe-rebuild-checkpoint.ts';
import {createRebuildWiring} from '../../../../universe-rebuild-production.ts';
import {rebuildUniverse} from '../../../../universe-rebuild-runner.ts';
import {resolveStrictReadyRuntime} from '../../../../strict-ready-runtime.ts';
import {runAtBlock,parseAtBlockJson} from '../../../../blockscan-at-block-cli.ts';
import {blockScanEdgeKey} from '../../../../venues/blockscan-state-capability.ts';
import {sourcePin} from '../../../../test/family-integration/kyber-yb-compound/historical-dual.ts';
const root=resolve(fileURLToPath(new URL('../../../../../../../',import.meta.url))),family='protocol:psv',target='0xc72178d412256a6dc5f04d749859b4cd95076d61';
const TX='0xd62e67ae40e3479b6e6612ab49ba0d2aea3c0cd09d8921b31e7bfd29a9a4a2b8',N=26152596,HASH='0x107b98060d965fb8a7323495a1c4fdbc06acd4315ad3f9ba1967918985f6fbeb';
const {ethers}=createRequire(resolve(root,'listener/package.json'))('ethers');
const sha=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
async function main(){
  assert.equal(process.env.SEARCHER_FAMILY_PSV_ENABLED,'1');
  assert.equal(process.argv.length,6,'expected out prior-ready revm-bin rpc-file');
  const out=resolve(process.argv[2]!);assert(out.startsWith(root+'/logs/')&&!existsSync(out));
  const prior=resolve(process.argv[3]!);assert(prior.startsWith(root+'/logs/'));
  const priorSha=sha(readFileSync(prior));
  const revm=resolve(process.argv[4]!);
  assert.equal(sha(readFileSync(revm)),'e5cbce3521fd98d7e59d3de80cca4fa0c3ec94c5cdfb1e74bbae4d6d7c7588c6');
  const executor='0x1000000000000000000000000000000000000002',owner='0x1000000000000000000000000000000000000001';
  const rpcUrl=JSON.parse(readFileSync(process.argv[5]!,'utf8')).MAINNET_RPC_URL;
  const redact=(v:unknown)=>String(v).split(rpcUrl).join('[REDACTED]').replace(/https?:\/\/[^\s"<>]+/g,'[REDACTED_URL]');
  Object.assign(process.env,{SEARCHER_DRY_RUN:'1',SEARCHER_BLOCKSCAN_SUBMIT:'0',MAINNET_RPC_URL:rpcUrl,SEARCHER_REVM_SIM_BIN:revm,BOTVM_ADDRESS:executor,BOTVM_OWNER:owner});
  const provider=new ethers.JsonRpcProvider(rpcUrl,1,{staticNetwork:true,batchMaxCount:1});
  mkdirSync(out,{mode:0o700});const before=sourcePin();
  const save=(n:string,v:unknown)=>writeFileSync(resolve(out,n),JSON.stringify(v,(_k,v)=>typeof v==='bigint'?v.toString():v,2)+'\n',{flag:'wx',mode:0o600});
  save('source-before.json',before);const families=[family,'univ2-standard','univ3-standard'];
  save('input-provenance.json',{TX,N,HASH,families,executor,owner,runnerSha256:sha(readFileSync(new URL(import.meta.url))),
    scope:'reuse saved natural N Ready; current production selective revalidation and prices; target only asserts outputs; no target seed, edited identity/hash or manual price inputs; performance NOT RUN'});
  let stage='receipt';
  try{
    const receipt=await provider.send('eth_getTransactionReceipt',[TX]);assert.equal(receipt.blockHash,HASH);assert.equal(Number(receipt.blockNumber),N);assert.equal(BigInt(receipt.status),1n);save('receipt.json',receipt);
    stage='natural-single-block-ready';console.log(JSON.stringify({stage,N}));
    const wiring=createRebuildWiring({rpcUrl,familyIds:families,executionIdentity:{executor,transactionOrigin:owner}});assert(families.every(id=>wiring.isFamilyEnabled?.(id)));
    const checkpoint=resolve(out,'ready.json');copyFileSync(prior,checkpoint,constants.COPYFILE_EXCL);
    save('prior-ready.json',{path:prior,sha256:priorSha,policy:'copy only; production rebuild revalidates changed Family; no fingerprint edits'});
    const store=new UniverseRebuildCheckpointStore({path:checkpoint});
    const ready=await rebuildUniverse({...wiring,store,runId:'psv-natural-'+N,observationRange:{fromBlock:N,toBlock:N},attestationConcurrency:1,log:m=>console.log(redact(m))});
    assert.equal(ready.cutoff.number,N);assert.equal(ready.cutoff.hash,HASH);assert.equal(ready.observationScope,undefined);
    const {graph}=resolveStrictReadyRuntime(ready),edges=graph.filter(e=>e.adapterId==='psv'&&e.target.toLowerCase()===target);assert.equal(edges.length,2);
    const envelope=await store.load();assert(envelope&&!envelope.inProgressRun);const memos=activeReadyMemos(envelope).filter(m=>m.familyId===family&&m.instanceKey===target);assert.equal(memos.length,1);
    save('ready-summary.json',{N,HASH,totalEdges:graph.length,activeInstances:ready.activeInstanceKeys.length,edges,memos});
    stage='production-prices';console.log(JSON.stringify({stage,N}));
    await runAtBlock(['--ready',checkpoint,'--block',String(N),'--through','prices','--execution-mode','source-block','--out',resolve(out,'prices'),'--executor',executor,'--owner',owner,'--revm-bin',revm]);
    const prices=parseAtBlockJson(readFileSync(resolve(out,'prices/prices.json'),'utf8'));
    const rows=edges.map(e=>{const key=blockScanEdgeKey(e),row=prices.runtime.pricing.effectiveMids.rows.get(key),mid=prices.runtime.pricing.mids.get(key);assert(row&&mid);return {key,row,mid};});
    save('result.json',{result:'reused-natural-ready-revalidated-prices-complete',N,HASH,rows,performance:'NOT RUN',originalPrecallParity:'NOT RUN'});
    console.log(JSON.stringify({result:'reused-natural-ready-revalidated-prices-complete',rows:rows.map(({row})=>({status:row.status,amountIn:row.amountIn?.toString(),amountOut:row.amountOut?.toString()}))}));
  }catch(e){const message=redact(e instanceof Error?e.message:e);save('failure.json',{stage,message});console.error(JSON.stringify({stage,message}));process.exitCode=1;}
  finally{const after=sourcePin();save('source-after.json',after);provider.destroy();assert.deepEqual(after,before,'source changed');assert.equal(sha(readFileSync(prior)),priorSha);}
}
main().catch(()=>{console.error('PSV natural integration failed; preserve evidence');process.exitCode=1;});
