import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { loadSqlPriceEdges, SqlEdgePoolIndex, type SqlPriceEdge } from "../sql-edge-price-index.js";

const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const p = addr(14), q = addr(15), t = addr(16), u = addr(17), native = addr(0), head = "0x"+"ba".repeat(32);
function leg(overrides: Partial<Omit<SqlPriceEdge, "candidateInstanceKey">> = {}): SqlPriceEdge {
  const x = {chainId: 1 as const, selector: "0x01020304", poolAddress: p, tokenIn: native, tokenOut: t,
    poolId: null, poolNamespace: null, tokenInId: null, tokenOutId: null, ...overrides};
  // Independent SQL fixture encoding. Null is significant at every slot.
  const tuple = [String(x.chainId),x.selector,x.poolAddress,x.poolNamespace,x.poolId,x.tokenIn,x.tokenInId,x.tokenOut,x.tokenOutId];
  return {...x, candidateInstanceKey: "candidate-edge:v1:"+sha(JSON.stringify(tuple))};
}
const keys = (legs: SqlPriceEdge[]) => legs.map(x=>x.candidateInstanceKey);
test("pool touch selects all and only the original selector/direction/asset-ID legs for that physical address",()=>{
  const a = leg(), reverse = leg({tokenIn:t,tokenOut:native}), otherSelector = leg({selector:"0x12121212"}), differentPool = leg({poolAddress:q}),
    ercId = leg({tokenIn:t,tokenOut:t,tokenInId:"X",tokenOutId:"Y"});
  const index = new SqlEdgePoolIndex([a, reverse, otherSelector, differentPool, ercId]);
  assert.equal(index.count,5); assert.equal(index.poolCount,2);
  const picked = index.legsForTouched([{poolAddress:p.toUpperCase()}, {poolAddress:p}, {poolAddress:t}]);
  assert.deepEqual(picked, {legIds:keys([a,reverse,otherSelector,ercId]), count:4});
  assert.deepEqual(index.legsForTouched([{poolAddress:q}]), {legIds:keys([differentPool]),count:1});
  assert.deepEqual(index.legsForTouched([]), {legIds:[],count:0});
  assert.throws(()=>new SqlEdgePoolIndex([a,a]),/duplicate indexed SQL leg/);
});
test("manager address never selects siblings; raw ID touch fans out only across that manager and ID, qualified touches are exact",()=>{
  const address = leg(), raw = leg({poolId:"ID"}), named = leg({poolId:"ID", poolNamespace:"named"}),
    sibling = leg({poolId:"id"}), foreignManager = leg({poolAddress:q,poolId:"ID"});
  const index = new SqlEdgePoolIndex([address,raw,named,sibling,foreignManager]);
  assert.equal(index.poolCount,4); assert.equal(index.qualifiedPoolCount,5);
  assert.deepEqual(index.legsForTouched([{poolAddress:p}]).legIds,keys([address]));
  assert.deepEqual(index.legsForTouched([{poolAddress:p,poolId:"ID"}]).legIds,keys([raw,named]));
  assert.deepEqual(index.legsForTouched([{poolAddress:p,poolId:"ID",poolNamespace:null}]).legIds,keys([raw]));
  assert.deepEqual(index.legsForTouched([{poolAddress:p,poolId:"ID",poolNamespace:"named"}]).legIds,keys([named]));
  assert.deepEqual(index.legsForTouched([{poolAddress:p,poolId:"id"},{poolAddress:p,poolId:"absent"}]).legIds,keys([sibling]));
  assert.deepEqual(index.legsForTouched([{poolAddress:p,poolId:"ID"},{poolAddress:p,poolId:"ID",poolNamespace:"named"}]).count,2);
  assert.throws(()=>index.legsForTouched([{poolAddress:p,poolId:""}]), /invalid touched/);
  assert.throws(()=>index.legsForTouched([{poolAddress:native}]), /invalid touched/);
});
test("real activity input intersects known physical pools; incomplete logical coverage is visible and fallback stays in that manager",()=>{
  const a = leg(), logical1=leg({poolId:"1"}), logical2=leg({poolId:"2"}), other=leg({poolAddress:q,poolId:"1"});
  const index=new SqlEdgePoolIndex([a,logical1,logical2,other]);
  const observed={poolAddress:p,poolId:"1"};
  const partial=index.poolTouchesForActivity(new Set([native,p,t,u]), [observed,observed,{poolAddress:q,poolId:"unknown"}]);
  assert.deepEqual(partial.touches,[{poolAddress:p},observed]);assert.deepEqual(partial.unresolvedManagers,[p]);
  assert.deepEqual(index.legsForTouched([...partial.touches,...index.logicalTouchesForManagers([p,p,t])]).legIds,keys([a,logical1,logical2]));
  const full=index.poolTouchesForActivity(new Set([p,q]), [observed], new Set([p]));
  assert.deepEqual(full.unresolvedManagers,[q]);assert.deepEqual(index.legsForTouched(full.touches).legIds,keys([a,logical1]));
  assert.deepEqual(index.poolTouchesForActivity(new Set([t,native]), []).touches,[]);
  assert.deepEqual(index.poolTouchesForActivity(new Set(), [{poolAddress:q,poolId:"1"}]).touches,[{poolAddress:q,poolId:"1"}]);
});
test("SQL input retains original keys and native/opaque scopes; pinned gzip or plain NDJSON, no family/Ready checks",async ctx=>{
  const d=await mkdtemp(join(tmpdir(),"sql-price-input-"));
  ctx.after(()=>rm(d,{force:true,recursive:true}));
  const rows=[leg(),leg({tokenIn:u,poolId:"0xAbCd:Example",poolNamespace:"namespace:A",tokenOutId:"007"})];
  for (const bytes of [Buffer.from(rows.map(x=>JSON.stringify({...x,familyIds:["not-checked"],verified:false})).join("\r\n")),
    gzipSync(Buffer.from(rows.map(x=>JSON.stringify({...x,extra:"do not use for admission"})).join("\n")+"\n"))]) {
    await writeFile(join(d,"rows"),bytes); const edgeSha256=sha(bytes);
    await writeFile(join(d,"pin"),JSON.stringify({format:"ready-fixed-edges/v1",edgeFile:"rows",edgeSha256,rows:2,fromBlock:900,toBlock:950,cutoffHash:head}));
    assert.deepEqual(await loadSqlPriceEdges(join(d,"pin")), {edges:rows,manifest:{edgeSha256,rows:2,fromBlock:900,toBlock:950,cutoffHash:head}});
  }
});
test("bad sha, coordinate forgery, duplicate key, truncated rows and missing manifest pins never produce legs",async ctx=>{
  const d=await mkdtemp(join(tmpdir(),"sql-price-pins-"));ctx.after(()=>rm(d,{force:true,recursive:true}));const x=leg();
  async function read(rows:unknown[],pin:Record<string,unknown>={}){
    const b=Buffer.from(rows.map(r=>JSON.stringify(r)).join("\n")); await writeFile(join(d,"legs"),b);
    await writeFile(join(d,"pin"),JSON.stringify({format:"ready-fixed-edges/v1",edgeFile:"legs",edgeSha256:sha(b),rows:rows.length,
      fromBlock:3,toBlock:4,cutoffHash:head,...pin}));
    return loadSqlPriceEdges(join(d,"pin"));
  }
  await assert.rejects(read([x],{edgeSha256:"11".repeat(32)}),/SHA-256/);
  await assert.rejects(read([{...x,selector:"0x99999999"}]),/key mismatch/);
  await assert.rejects(read([x,x]),/duplicate/); await assert.rejects(read([x],{rows:2}),/count/);
  await assert.rejects(read([x],{rows:0}),/manifest/); await assert.rejects(read([x],{toBlock:2}),/manifest/);
  await assert.rejects(read([x],{cutoffHash:null}),/manifest/);
  await assert.rejects(read([{...x,poolNamespace:"logical",poolId:null}]),/coordinates/);
  await assert.rejects(read([{...x,tokenOut:native}]),/coordinates/);
});
