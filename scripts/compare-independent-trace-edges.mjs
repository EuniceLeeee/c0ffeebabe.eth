// Count a directed edge only with its selector and complete pool/asset identity.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {parseArgs} from 'node:util';
import {edgeCoordinates,coordinateKey} from './selector-edge-difference.mjs';

const {values:v}=parseArgs({options:{manifest:{type:'string'},baseline:{type:'string'},
  'baseline-window':{type:'string'},ready:{type:'string'},v12:{type:'string'},out:{type:'string'}}});
const load=p=>JSON.parse(readFileSync(p));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest=load(v.manifest), graph=load(v.ready), oldWindow=load(v['baseline-window']);
for(const k of ['fromBlock','toBlock','headHash','transactions','firstTime','lastTime']){
  assert.equal(graph.window[k],manifest.window[k],k);
  assert.equal(oldWindow[k],manifest.window[k],k);
}
const bytes=readFileSync(join(dirname(v.manifest),'edges.json'));
assert.equal(sha(bytes),manifest.edgesSha256);
const rows=JSON.parse(bytes),base=load(v.baseline);
const hasSelector=e=>/^0x[0-9a-f]{8}$/i.test(e.selector);
function keys(list){
  return new Set(list.map(e=>{
    assert(hasSelector(e),'Cannot include an edge without a selector');
    const coords=edgeCoordinates({...e,chainId:1,poolAddress:e.poolAddress??e.target});
    return JSON.stringify([e.selector.toLowerCase(),coordinateKey(coords)]);
  }));
}
function compare(left,right){
  const common=[...left].filter(k=>right.has(k)).length;
  return {left:left.size,right:right.size,common,leftOnly:left.size-common,rightOnly:right.size-common};
}
const independent=keys(rows),baseline=keys(base);
assert.equal(independent.size,manifest.total);
assert.equal(independent.size,rows.length);
assert.equal(baseline.size,base.length);
const report={
  key:['selector','poolIdentity','tokenIn','tokenOut'],window:manifest.window,job:manifest.jobId,
  independentOutputSha256:manifest.edgesSha256,baselineSha256:sha(readFileSync(v.baseline)),
  referenceSha256:sha(readFileSync(v.ready)),independent:independent.size,baseline:baseline.size,
  candidateWithSelector:compare(independent,baseline),
};
if(v.v12){
  // V12 has its own pool-identity representation, so report its distinct
  // count without inferring an equivalence between manager and pool ID.
  report.v12=keys(load(v.v12).map(e=>({selector:e.selector,target:e.target,
    poolNamespace:e.pool_namespace,poolId:e.pool_id,tokenIn:e.token_in,tokenOut:e.token_out}))).size;
  report.v12Sha256=sha(readFileSync(v.v12));
}
const explicit=graph.edges.filter(hasSelector);
report.ready=explicit.length?{withExplicitSelector:compare(independent,keys(explicit)),
  complete:explicit.length===graph.edges.length}:{status:'unavailable',reason:'graph-has-no-explicit-selector'};
writeFileSync(v.out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(report));
