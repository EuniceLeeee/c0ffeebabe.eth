import assert from "node:assert/strict";
import { test } from "node:test";
import { assertStorageUnchanged, assertInactiveCallback, correlatedRpcResponse } from "./callback-evidence.js";
test("rollback observer accepts empty and identical storage", () => {
  assertStorageUnchanged({pre:{},post:{}});
  assertStorageUnchanged({pre:{a:{storage:{k:"0x01"}}},post:{a:{storage:{k:"0x1"}}}});
});
test("rollback observer rejects pre-only deleted/cleared storage", () => {
  assert.throws(() => assertStorageUnchanged({pre:{a:{storage:{k:"0x01"}}},post:{}}));
  assert.throws(() => assertStorageUnchanged({pre:{a:{storage:{k:"0x01"}}},post:{a:{storage:{k:"0x00"}}}}));
});
test("rollback observer rejects post-only and changed storage", () => {
  assert.throws(() => assertStorageUnchanged({pre:{},post:{a:{storage:{k:"0x01"}}}}));
  assert.throws(() => assertStorageUnchanged({pre:{a:{storage:{k:"0x01"}}},post:{a:{storage:{k:"0x02"}}}}));
});
test("inactive callback accepts inert empty return or inert revert", () => {
  assertInactiveCallback({output:"0x"},{pre:{},post:{}});
  assertInactiveCallback({}, {pre:{},post:{}});
  assertInactiveCallback({error:"execution reverted"},{pre:{},post:{}});
});
test("inactive callback rejects child execution, unexpected output or state changes", () => {
  assert.throws(() => assertInactiveCallback({calls:[{}]},{pre:{},post:{}}));
  assert.throws(() => assertInactiveCallback({output:"0x01"},{pre:{},post:{}}));
  assert.throws(() => assertInactiveCallback({output:"0x"},{pre:{a:{storage:{k:"0x01"}}},post:{}}));
});
test("parallel fork reads retain request ids when replies complete in reverse order", async () => {
  let next=0; const replies=new Map<number,(body:unknown)=>void>();
  const send=(id:number)=>new Promise(resolve=>replies.set(id,resolve));
  const first=correlatedRpcResponse(()=>++next,send), second=correlatedRpcResponse(()=>++next,send);
  replies.get(2)!({jsonrpc:"2.0",id:2,result:"second"});
  replies.get(1)!({jsonrpc:"2.0",id:1,result:"first"});
  assert.deepEqual((await Promise.all([first,second])).map(v=>v.result),["first","second"]);
});
test("fork read correlation still rejects wrong response id or envelope", async () => {
  await assert.rejects(correlatedRpcResponse(()=>7,async()=>({jsonrpc:"2.0",id:9,result:0})));
  await assert.rejects(correlatedRpcResponse(()=>7,async()=>({jsonrpc:"1.0",id:7,result:0})));
});
