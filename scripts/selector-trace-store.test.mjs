import test from 'node:test';
import assert from 'node:assert/strict';
import {HISTORY,planResize,coverageSql,checkTraceCoverage,fixedTraceRead} from './selector-trace-store.mjs';
import {resizeSql} from './selector-trace-store-maintain.mjs';
const interval=(fromBlock,toBlock)=>({fromBlock,toBlock,chainId:1,transactions:'200',headHash:'0x'+'a'.repeat(64),
 firstTime:'2026-11-05T10:00:00.000000Z',lastTime:fromBlock===toBlock?'2026-11-05T10:00:00.000000Z':'2026-11-05T11:00:00.000000Z'});
const old=interval(100,200),at='2026-11-09T12:34:56.123456Z';
test('window difference never re-fetches the overlap',()=>{
 assert.deepEqual(planResize(old,interval(99,203)),{missing:[[99,99],[201,203]],excess:[]});
 assert.deepEqual(planResize(old,interval(105,195)),{missing:[],excess:[[100,104],[196,200]]});
 assert.deepEqual(planResize(old,interval(195,202)),{missing:[[201,202]],excess:[[100,194]]});
 assert.deepEqual(planResize(old,interval(201,204)),{missing:[[201,204]],excess:[[100,200]]});
 assert.deepEqual(planResize(old,old),{missing:[],excess:[]});
});
test('trim does not fetch public traces; mixed changes fetch only missing boundaries',()=>{
 const trimmed=resizeSql(old,interval(105,195),[]);
 assert.doesNotMatch(trimmed,/crypto_ethereum\.(logs|traces|transactions)/);
 assert.match(trimmed,/BEGIN TRANSACTION/);assert.match(trimmed,/BETWEEN 100 AND 104/);assert.match(trimmed,/BETWEEN 196 AND 200/);
 assert.ok(trimmed.indexOf("retained blocks do not match the canonical headers")<trimmed.indexOf('WHERE block_number BETWEEN 100 AND 104;'));
 assert.ok(trimmed.indexOf('duplicate or out-of-window rows')<trimmed.indexOf('COMMIT TRANSACTION'));
 const grew=resizeSql(old,interval(99,203),[interval(99,99),interval(201,203)]);
 assert.equal((grew.match(/crypto_ethereum\.traces/g)??[]).length,2);
 assert.match(grew,/t\.block_number BETWEEN 99 AND 99/);assert.match(grew,/t\.block_number BETWEEN 201 AND 203/);
 assert.equal((grew.match(/DELETE FROM/g)??[]).length,1);assert.match(grew,/WHERE FALSE/);
 assert.match(grew,/parent_hash=prior/);assert.match(grew,/tx_hash,block_hash,block_number,transaction_index,receipt_status,from_address,to_address,input,value,trace_rows_present,traces,logs\) SELECT/);
 assert.doesNotMatch(grew,/ADD COLUMN|CREATE TABLE|NULL tx_hash/);
 assert.throws(()=>resizeSql(old,interval(99,203),[interval(99,203)]),/only missing/);
});
test('coverage includes empty blocks, and any discontinuity or incomplete tx count fails closed',()=>{
 const c={snapshotAt:at,activeHashes:'101',firstBlock:'100',lastBlock:'200',head:old.headHash,firstTime:old.firstTime,
  lastTime:old.lastTime,transactions:'200',distinctTx:'200',missingTraces:'0',invalid:'0',emptyBlocks:'1'};
 assert.deepEqual(checkTraceCoverage(old,c),c);
 for(const bad of [{invalid:'1'},{activeHashes:'100'},{distinctTx:'199'},{missingTraces:'1'},{head:'0xdead'}])assert.throws(()=>checkTraceCoverage(old,{...c,...bad}));
 assert.match(coverageSql(old,at,[{block:old.fromBlock,hash:old.headHash}]),/FULL JOIN empty/);
 const select=fixedTraceRead(old,at);
 assert(select.includes(HISTORY));assert.match(select,/FOR SYSTEM_TIME AS OF/);assert.match(select,/WHERE block_number BETWEEN 100 AND 200/);
 assert.doesNotMatch(select,/bigquery-public-data/);
 assert.throws(()=>fixedTraceRead(old,"x'; DROP TABLE"));
});
