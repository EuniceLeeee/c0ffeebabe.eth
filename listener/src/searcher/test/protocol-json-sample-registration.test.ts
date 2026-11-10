import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { registerAcceptanceSample, assertRegisteredAcceptanceSample } from "./protocol-json-sample-registration.js";
import { loadProtocolJsonSamples } from "./protocol-json-samples.js";

function fixture(t: any) {
  const root=mkdtempSync(join(tmpdir(),"sample-registration-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const sample={format:"node-rpc-family-component-case-v1",familyId:"synthetic",source:{number:100,hash:"hash"},amountIn:"17",direction:"0:1"};
  const path=join(root,"case.json");writeFileSync(path,JSON.stringify(sample));
  return {root,path,sample};
}
test("a stored fixture binds the exact executed inputs, not a claimed pass",t=>{
  const f=fixture(t), proof=registerAcceptanceSample(f.sample,f.path,f.root);
  assert.equal(proof.kind,"fixture");assert.match(proof.sha256,/^[0-9a-f]{64}$/);
  assertRegisteredAcceptanceSample(f.sample,proof);
  assert.equal((proof as any).result,undefined);
  assert.throws(()=>assertRegisteredAcceptanceSample(f.sample,{...proof}),/registered sample/);
  for(const change of [{familyId:"other"},{source:{number:101,hash:"hash"}},{direction:"1:0"},{amountIn:"18"}])
    assert.throws(()=>assertRegisteredAcceptanceSample({...f.sample,...change},proof),/differs/);
});
test("adding a sample later permits a new run, not a synthetic registration proof",t=>{
  const f=fixture(t);rmSync(f.path);
  assert.throws(()=>registerAcceptanceSample(f.sample,f.path,f.root));
  assert.throws(()=>assertRegisteredAcceptanceSample(f.sample,undefined),/registered sample/);
  writeFileSync(f.path,JSON.stringify(f.sample));
  const proof=registerAcceptanceSample(f.sample,f.path,f.root);
  assertRegisteredAcceptanceSample(f.sample,proof);
  writeFileSync(f.path,JSON.stringify({...f.sample,amountIn:"18"}));
  assert.throws(()=>assertRegisteredAcceptanceSample(f.sample,proof),/changed during acceptance/);
});
test("outside files, escaping symlinks and unindexed cases cannot use fixture fallback",t=>{
  const f=fixture(t),root=join(f.root,"library");mkdirSync(root);
  assert.throws(()=>registerAcceptanceSample(f.sample,f.path,root),/not registered/);
  const link=join(root,"linked.json");symlinkSync(f.path,link);
  assert.throws(()=>registerAcceptanceSample(f.sample,link,root),/not registered/);
  mkdirSync(join(root,"protocol-json"));const path=join(root,"protocol-json/unindexed.json");writeFileSync(path,JSON.stringify(f.sample));
  assert.throws(()=>registerAcceptanceSample(f.sample,path,root),/absent from its sample index/);
});
test("existing indexed Protocol cases and the Curve node fixture are accepted as input registrations",()=>{
  const c=loadProtocolJsonSamples().cases[0]!;
  const proof=registerAcceptanceSample(c.data,c.path);
  assert.equal(proof.kind,"index");assert.equal(proof.sampleId,c.sampleId);
  assertRegisteredAcceptanceSample(c.data,proof);
  const path=fileURLToPath(new URL('./fixtures/node-rpc/curve-lp-add-remove.json',import.meta.url));
  const data=JSON.parse(readFileSync(path,'utf8'));
  assertRegisteredAcceptanceSample(data,registerAcceptanceSample(data,path));
});
