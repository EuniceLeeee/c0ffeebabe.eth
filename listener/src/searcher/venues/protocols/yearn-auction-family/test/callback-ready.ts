// Thin historical correctness invocation of production rebuild + prices.
import assert from 'node:assert/strict';
import {constants,copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {UniverseRebuildCheckpointStore,activeReadyMemos} from '../../../../universe-rebuild-checkpoint.js';
import {createRebuildWiring} from '../../../../universe-rebuild-production.js';
import {rebuildUniverse} from '../../../../universe-rebuild-runner.js';
import {resolveStrictReadyRuntime} from '../../../../strict-ready-runtime.js';
import {runAtBlock,parseAtBlockJson} from '../../../../blockscan-at-block-cli.js';
import {blockScanEdgeKey} from '../../../../venues/blockscan-state-capability.js';
import {sourcePin} from '../../../../test/family-integration/kyber-yb-compound/historical-dual.js';
const root='/opt/mev-cloud/family-runtime-20261007',family='protocol:yearn-auction',target='0xa00e6b35c23442fa9d5149cba5dd94623ffe6693';
const sold='0xdbdb4d16eda451d0503b854cf79d55697f90c8df',instanceKey=target+':'+sold;
const TX='0x6cc7a620da9e1fc47e894ec69bdbd3b1075c05ebc6c1807a3a6a000035fe136b',N=26152335,HASH='0x62a1a08653dd520793f8526d405430bcaabd5152459fca18e79f843514f3e0b3';
const {ethers}=createRequire(resolve(root,'listener/package.json'))('ethers');
const sha=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
async function main(){
  assert.equal(process.env.SEARCHER_FAMILY_YEARN_AUCTION_ENABLED,'1');
  assert.equal(process.env.SEARCHER_DRY_RUN_BOTVM_CODE_OVERRIDE,'1');
  const out=resolve(process.argv[2]!);assert(out.startsWith(root+'/logs/')&&!existsSync(out));
  const revm=resolve(root,'logs/four-family-coverage-20261012.zHKuWX/strict-nested-target.NWbx5i/debug/revm-sim');
  assert.equal(sha(readFileSync(revm)),'e5cbce3521fd98d7e59d3de80cca4fa0c3ec94c5cdfb1e74bbae4d6d7c7588c6');
  const executor='0x1000000000000000000000000000000000000002',owner='0x1000000000000000000000000000000000000001';
  const rpcUrl=JSON.parse(readFileSync('/tmp/ds-rpc.json','utf8')).MAINNET_RPC_URL;
  const redact=(v:unknown)=>String(v).split(rpcUrl).join('[REDACTED]').replace(/https?:\/\/[^\s"<>]+/g,'[REDACTED_URL]');
  Object.assign(process.env,{SEARCHER_DRY_RUN:'1',SEARCHER_BLOCKSCAN_SUBMIT:'0',MAINNET_RPC_URL:rpcUrl,SEARCHER_REVM_SIM_BIN:revm,BOTVM_ADDRESS:executor,BOTVM_OWNER:owner});
  const provider=new ethers.JsonRpcProvider(rpcUrl,1,{staticNetwork:true,batchMaxCount:1});
  mkdirSync(out,{mode:0o700});const before=sourcePin();
  const save=(n:string,v:unknown)=>writeFileSync(resolve(out,n),JSON.stringify(v,(_k,v)=>typeof v==='bigint'?v.toString():v,2)+'\n',{flag:'wx',mode:0o600});
  save('source-before.json',before);const families=[family];
  save('input-provenance.json',{TX,N,HASH,families,executor,owner,runnerSha256:sha(readFileSync(new URL(import.meta.url))),
    scope:'retained historical Ready selectively revalidated through current production; original historicalNaturalDiscoveryProven=false remains; no new natural discovery or valuation claim; no manual Graph or amounts; performance NOT RUN'});
  let stage='receipt';
  try{
    const receipt=await provider.send('eth_getTransactionReceipt',[TX]);assert.equal(receipt.blockHash,HASH);assert.equal(Number(receipt.blockNumber),N);assert.equal(BigInt(receipt.status),1n);save('receipt.json',receipt);
    stage='natural-single-block-ready';console.log(JSON.stringify({stage,N}));
    const wiring=createRebuildWiring({rpcUrl,familyIds:families,executionIdentity:{executor,transactionOrigin:owner}});assert(families.every(id=>wiring.isFamilyEnabled?.(id)));
    const checkpoint=resolve(out,'ready.json'),store=new UniverseRebuildCheckpointStore({path:checkpoint});
    const prior=resolve(root,'logs/yearn-callback-20261015.vvkur8vw/natural22/ready.json');
    assert.equal(sha(readFileSync(prior)),'157f3501646ce9bfef48c6d34629c4ac69ce6b629aa856ab4d6e86c5ad2f45bb');
    const priorEnvelope=await new UniverseRebuildCheckpointStore({path:prior}).load();
    assert(priorEnvelope&&!priorEnvelope.inProgressRun&&priorEnvelope.readyGeneration);
    assert.equal(priorEnvelope.readyGeneration.cutoff.number,N);assert.equal(priorEnvelope.readyGeneration.cutoff.hash,HASH);
    copyFileSync(prior,checkpoint,constants.COPYFILE_EXCL);
    save('prior-ready.json',{path:prior,sha256:sha(readFileSync(prior)),policy:'copy and revalidate through current production; no fingerprint edits'});
    const ready=await rebuildUniverse({...wiring,store,runId:'yearn-natural-'+N,observationRange:{fromBlock:N,toBlock:N},attestationConcurrency:1,log:m=>console.log(redact(m))});
    assert.equal(ready.cutoff.number,N);assert.equal(ready.cutoff.hash,HASH);assert.equal(ready.observationScope,undefined);
    const {graph}=resolveStrictReadyRuntime(ready),edges=graph.filter(e=>e.adapterId==='yearn-auction'&&e.instanceKey===instanceKey);assert.equal(edges.length,1);
    const envelope=await store.load();assert(envelope&&!envelope.inProgressRun);const memos=activeReadyMemos(envelope).filter(m=>m.familyId===family&&m.instanceKey===instanceKey);assert.equal(memos.length,1);assert(wiring.isReadyMemoDefinitionCurrent?.(memos[0]!));
    save('ready-summary.json',{N,HASH,totalEdges:graph.length,activeInstances:ready.activeInstanceKeys.length,edges,memos});
    save('result.json',{result:'ready-revalidated',N,HASH,edges,performance:'NOT RUN',prices:'NOT RUN',originalPrecallParity:'NOT RUN'});
  }catch(e){const message=redact(e instanceof Error?e.message:e);save('failure.json',{stage,message});console.error(JSON.stringify({stage,message}));process.exitCode=1;}
  finally{assert.equal(sha(readFileSync(resolve(root,'logs/yearn-callback-20261015.vvkur8vw/natural22/ready.json'))),'157f3501646ce9bfef48c6d34629c4ac69ce6b629aa856ab4d6e86c5ad2f45bb');const after=sourcePin();save('source-after.json',after);provider.destroy();assert.deepEqual(after,before,'source changed');}
}
main().catch(()=>{console.error('Yearn natural integration failed; preserve evidence');process.exitCode=1;});
