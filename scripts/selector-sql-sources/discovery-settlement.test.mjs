import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {compileSettlementEvidence} from './compile-settlement-evidence.mjs';
import {matchesActionSettlement} from './action-settlement-evidence.mjs';
import {renderIndependentTraceEdges,ready21Window} from '../independent-trace-edges.mjs';
import {projectIndependentRows} from '../selector-independent-live-export.mjs';
import {poolIdLayouts} from './trace-pool-id.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const addr=c=>'0x'+c.repeat(40),word=c=>'0x'+c.repeat(64);
test('both distinct positive flows must independently reconcile; prevent duplicate witnesses',()=>{
  const a={asset:addr('0'),expected:5n,observed:5n,evidenceKeys:['call:1,2']},
    b={asset:addr('1'),expected:4n,observed:4n,evidenceKeys:['log:3']};
  assert(matchesActionSettlement([a,b]));
  for(const other of [{...b,observed:0n},{...b,evidenceKeys:a.evidenceKeys},{...b,asset:a.asset},
    {...b,evidenceKeys:[]},{...b,expected:0n,observed:0n}])assert.equal(matchesActionSettlement([a,other]),false);
});
test('production SQL retains only the declared extra evidence; it does not expose the callback as an execution entry',async()=>{
  const r=compileSettlementEvidence(root),balance=r.balanceActions['0x128acb08'],settle=r.settlementProofs['0xf3cd914c'];
  assert.deepEqual(balance.deltaWords,[0,1]);assert.equal(balance.topicCount,3);assert.equal(balance.dataWords,5);
  assert.equal(settle.batch.take,'0x0b0d9c09');
  const sql=await renderIndependentTraceEdges(ready21Window,{liveSelectorsOnly:true});
  // The pre-existing receipt decoder may require a longer prefix: do not truncate it.
  assert(Number(sql.match(/WHEN LEFT\(f.input,10\)='0x128acb08' THEN LEFT\(f.input,(\d+)\)/)?.[1])>=74);
  assert(sql.includes("WHEN LEFT(f.input,10)='0x0b0d9c09' THEN LEFT(f.input,202)"));
  const outs=sql.match(/WHEN LEFT\(f.input,10\) IN \(([^)]+)\) THEN LEFT\(f.output,67\)/)[1];
  assert(outs.includes("'0xf3cd914c'")&&outs.includes("'0x70a08231'"));
  assert(outs.includes("'0x23b872dd'")&&outs.includes("'0xa9059cbb'"));
  assert(sql.includes("WHEN LEFT(f.input,10) IN ('0xa9059cbb','0x23b872dd') THEN LEFT(f.input,203)"));
  const getters=sql.match(/CASE WHEN f.input IN \(([^)]+)\) AND f.call_type='staticcall'/)[1];
  assert(getters.includes("'0x0dfe1681'")&&!getters.includes("'0x70a08231'"));
  assert(sql.includes("r'^0x0{24}[0-9a-f]{40}(?:00)*$'"));
  const eligible=sql.match(/WHERE selector IN \(([^)]+)\)\nGROUP BY/)[1];
  assert(eligible.includes("'0x48c89491'")&&!eligible.includes("'0xf3cd914c'")&&!eligible.includes("'0x91dd7346'"));
});
test('settlement and ordinary proofs of the same logical pool preserve the identical public execution ID',()=>{
  const layout=poolIdLayouts.find(x=>x.settlementEvidence);
  const row={selector:layout.entry,poolAddress:layout.emitter,callTarget:layout.emitter,poolId:word('a'),
    tokenIn:addr('0'),tokenOut:addr('b'),observations:'1',verified:false,observedTargetSelector:true};
  const observe=e=>({...row,evidenceTypes:[e],example:{txHash:word('d'),callPath:'1',innerSwapPath:'1,0,0',
    selectorTarget:layout.emitter,observedPoolAddress:layout.emitter,evidence:e}});
  const old=projectIndependentRows([observe(layout.evidence)],[]);assert.equal(old.accepted.length,1);
  const next=projectIndependentRows([observe(layout.settlementEvidence)],old.accepted);
  assert.deepEqual(next.accepted,old.accepted);assert.equal(next.preserved,1);
});
