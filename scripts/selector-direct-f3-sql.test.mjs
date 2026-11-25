import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {renderIndependentTraceEdges,renderExperimentalTraceEdges,ready21Window as w} from './independent-trace-edges.mjs';
import {fixedTraceRead} from './selector-trace-store.mjs';
import {renderSelectorTraceSourceSql} from './selector-trace-source-sql.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
test('production query is the f3f19f42 SQL; fixed storage changes the FROM side only',async()=>{
 const snapshotAt='2026-11-24T10:30:10.408433Z';
 const prefix=renderSelectorTraceSourceSql({window:w,materialize:true})+';\n';
 for(const [legacyCoordinates,unfilteredSha] of [[false,'b66cae97c8be00f49d9985a1798d6280bf265fc1a217af5d042d5cde1d2fd9e1'],[true,'a9011d9a7261d4d9d09fce935fd6a9e073a622bee6cd0b8a13769995d6e5058e']]){
   for(const liveSelectorsOnly of [false,true]){
    const opts={liveSelectorsOnly,legacyCoordinates,executionParams:false}; // byte-for-byte read-only support for sealed archives
    const old=await renderIndependentTraceEdges(w,opts);
    const stripped=liveSelectorsOnly?old.replace(/\nWHERE selector IN \('[^\n]+'\)\nGROUP BY/,'\nGROUP BY'):old;
    assert.equal(hash(stripped),unfilteredSha);assert(old.startsWith(prefix));
    const fixed=await renderIndependentTraceEdges(w,{...opts,fixedSource:{snapshotAt}});
    const expected=old.slice(prefix.length).replace('\nWITH ','\nWITH canonical_trace AS (\n'+fixedTraceRead(w,snapshotAt)+'\n), ');
    assert.equal(hash(fixed),hash(expected));assert(!fixed.includes('bigquery-public-data'));
   }
 }
 assert.notEqual(hash(await renderIndependentTraceEdges(w)),hash(await renderExperimentalTraceEdges(w)));
});
