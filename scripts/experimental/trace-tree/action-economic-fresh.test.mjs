import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildTree} from './trace-tree.mjs';
import {extractEdges} from './action-edges.mjs';
const raw=process.env.TRACE_TREE_NORMALIZED_FIXTURE??new URL('../verified-input.ndjson',import.meta.url);
test('fresh SQL alone: nested confirmed, outer provisional; no receipt owner injected', {skip:!fs.existsSync(raw)},()=>{
  const target='0x97e77ec130c4987e438c1e0e47a6eb5abfb290d6a21b868d46afb7c9f48417b3';
  const rows=fs.readFileSync(raw,'utf8').trim().split('\n').map(JSON.parse);assert.equal(rows.length,349);
  const t=buildTree(rows.find(r=>r.tx_hash===target)),opts={enabledSelectors:['0x6e553f65','0x94bf804d','0xb460af94','0xba087652']};
  const r=extractEdges(t,opts);
  assert.equal(t.ownershipSource,'flat');assert.equal(r.edges.length,1);assert.equal(r.edges[0].path,'4,0,4,0,2');
  const o=r.observedActions[0];assert.equal(o.path,'4');assert.equal(o.tier,'provisional');
  assert.deepEqual([o.tokenIn,o.tokenOut,o.amountInRaw,o.amountOutRaw],['0x2260fac5e5542a773aa44fbcfedf7c193bc2c599','0x2c24b57e2ccd1f273045af6a5f632504c432374f','100000','100000']);
  assert.deepEqual(o.evidenceLogIndices,[5041,5030,5040]);const e=o.economicEvidence;
  assert.equal(e.eventPhysicalOwnership,'ambiguous');assert.equal(t.logs.find(l=>l.idx===5041).ownerPath,null);
  assert.deepEqual(e.sides[0].custodyBalance,{proven:true,pre:'4,0,0',post:'4,0,2',before:'0',after:'100000'});
  assert.equal(e.sides[1].accountBalance.postOnly,'5');
  // An observed token→user payment with the wrong amount cannot be repaired by the matching event.
  const changed=structuredClone(t);changed.logs.find(l=>l.idx===5030).data='0x'+(99999n).toString(16).padStart(64,'0');
  const negative=extractEdges(changed,opts);assert(!negative.edges.some(x=>x.path==='4'));assert(!(negative.observedActions??[]).some(x=>x.path==='4'));
});
