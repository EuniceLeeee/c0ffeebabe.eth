import assert from "node:assert/strict";
import test from "node:test";
import { options } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
const args=(family:string)=>["--family",family,"--ready","ready.json","--prices","prices.json","--port","18961","--out","out.json"];
test("xWin same-N saved amount mode is explicit and never grants cross-block target override",()=>{
 for(const family of ["xwin-mint","xwin-redeem"]){
  assert.equal(options(args(family)).inputOnlyReference,false);
  const parsed=options([...args(family),"--input-only-reference","true"]);
  assert.equal(parsed.inputOnlyReference,true);assert.equal(parsed.erc20InputOnly,false);
  assert.throws(()=>options([...args(family),"--input-only-reference","false"]));
  assert.throws(()=>options([...args(family),"--input-only-reference","true","--target-header","other.json"]));
  assert.throws(()=>options([...args(family),"--v4-settlement-artifact","fixture.json"]));
 }
});
test("unrelated samples do not silently gain amount-only relaxation",()=>{
 assert.throws(()=>options([...args("kyber"),"--input-only-reference","true"]));
});
