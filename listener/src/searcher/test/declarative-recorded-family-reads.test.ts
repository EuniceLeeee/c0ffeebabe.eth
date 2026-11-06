import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256 } from "ethers";
import { createRecordedFamilyReadReplay, type RecordedFamilyReadWitness } from "./recorded-family-read-witness.js";
import type { AdapterRequest } from "../venues/adapter-request-program.js";
import "../venues/protocols/token-conversion-family/test/cached-xwin-request-issuer.js";

const token = "0x0000000000000000000000000000000000000010";
const owner = "0x0000000000000000000000000000000000000011";
const source = { number: 10, hash: "0x" + "ab".repeat(32), generation: 1 };
const hash = keccak256("0x01"), calldata = "0x1234567800", slot = "0x" + "00".repeat(32);
const fixture: RecordedFamilyReadWitness = {version: 1, source, executor: owner, chainId: 1,
  rounds: [{name: "surface", reads: [
    { id: "slot", kind: "get-storage", target: token, slot, resultHash: hash },
    { id: "view", kind: "eth-call", target: token, selector: "0x12345678", calldata, from: owner, resultHash: hash },
  ]}], responses: { [hash]: "0x01" } };
const read = (f: RecordedFamilyReadWitness=fixture) => createRecordedFamilyReadReplay(f, { source, chainId: 1, resolveCaller: () => owner });
const a: AdapterRequest = { kind: "get-storage", id: "slot", address: token, slot };
const b: AdapterRequest = { kind: "eth-call", id: "view", to: token, data: calldata, caller: { kind: "executor" } };

test("physical read witnesses reject reordered, unused and missing rows, altered slots, targets, calldata, caller, source and response bytes", () => {
  const good = read(); assert.equal(good.readRound([a,b]).length, 2); good.finish();
  assert.throws(() => good.readRound([a,b]));
  for (const requests of [[b,a],[b],[a,a,b],[{ ...a, slot: "0x"+"11".repeat(32) }, b],[a, { ...b, to: owner }],
    [a,{ ...b, data:"0x1234567801" }],[a,{...b, caller:undefined}],[a,{...b, id:"slot"}]]) {
    assert.throws(() => read().readRound(requests));
  }
  assert.throws(() => read().finish());
  assert.throws(() => read({ ...fixture, source:{ ...source, hash:"0x"+"cd".repeat(32) } }));
  assert.throws(() => read({ ...fixture, responses:{ [hash]:"0x02" } }));
  const extra = read({ ...fixture, responses:{ ...fixture.responses, [keccak256("0x02")]:"0x02" } });
  extra.readRound([a,b]); assert.throws(() => extra.finish());
});
