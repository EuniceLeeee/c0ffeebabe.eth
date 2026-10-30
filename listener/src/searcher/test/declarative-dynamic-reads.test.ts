import assert from "node:assert/strict";
import test from "node:test";
import { toBeHex } from "ethers";
import { compileDeclarativeReadFlow } from "../venues/declarative-read-flow.js";
import { compileDeclarativeValues } from "../venues/declarative-values.js";

const op = (op: string, ...args: any[]) => ({ op, args });
const source = { number: 100, hash: toBeHex(100, 32), generation: 1 };
const values = compileDeclarativeValues({ abi: {}, constants: {}, expressions: {} });
const request = (id: any, to: any, required = true) => ({ id, kind: "eth-call", to, data: "0x12345678", completion: "return-data", required });
const definition = { version: 1, steps: [
  { id: "access", requirements: { transports: ["eth-call"] }, requests: op("if", "$descriptor.guarded", [request("access", "$descriptor.pool")], []),
    result: op("if", "$descriptor.guarded", op("bool", op("get", op("returned", "access"), "data")), true) },
  { id: "reader", requirements: { transports: ["eth-call"] }, requests: op("if", op("and", "$steps.access", op("defined", "$descriptor.reader")),
    [request("reader", "$descriptor.reader", false)], []),
    result: op("if", op("eq", op("shape", "reader"), "returned"), op("get", op("returned", "reader"), "data"), null) },
  { id: "words", requirements: { transports: ["eth-call"] }, requests: op("if", op("and", "$steps.access", op("not", op("defined", "$steps.reader"))),
    op("map", "$wordIndexes", "word", request(op("join", ["word", op("string", "$word")], ":"), "$descriptor.pool")), []),
    result: op("map", "$results", "row", op("word", "$row.data")) },
], result: { allowed: "$steps.access", aggregate: "$steps.reader", words: "$steps.words" } };

function run(guarded: boolean, allowed: boolean, reader: "absent" | "returned" | "failed") {
  const input = { source, descriptor: { pool: toBeHex(1, 20), guarded, reader: reader === "absent" ? null : toBeHex(2, 20) },
    wordIndexes: Array.from({ length: 49 }, (_, i) => i - 24) };
  const { program } = compileDeclarativeReadFlow(definition, values);
  const groups: string[][] = [];
  const answer = (requests: readonly any[]): any[] => {
    groups.push(requests.map(request => request.id));
    return requests.map(request => ({ id: request.id, source, provenance: { kind: "fixture", fingerprint: "fixture" },
      ...(request.id === "reader" && reader === "failed" ? { ok: false, failure: "rpc" } : {
        ok: true, completion: "returned", data: toBeHex(request.id === "access" ? Number(allowed) : 7, 32),
      }) }));
  };
  const initialResults = answer(program.buildRequests(input)), dependentEvidence: any[] = [];
  for (;;) {
    const round = program.buildDependentProgram!({ programInput: input, initialResults,
      completedRound: dependentEvidence.length, priorEvidence: dependentEvidence });
    if (!round) break;
    dependentEvidence.push(round.decode(answer(round.requests)));
  }
  return { groups, result: program.decode({ programInput: input, initialResults, dependentEvidence }) as any };
}

test("existing read flow selects aggregate reader or 49 dependent requests from JSON", () => {
  const aggregate = run(false, true, "returned");
  assert.deepEqual(aggregate.groups, [[], ["reader"], []]);
  for (const mode of ["absent", "failed"] as const) {
    const fallback = run(false, true, mode);
    assert.equal(fallback.groups[2]!.length, 49);
    assert.equal(fallback.groups[2]![0], "word:-24");
    assert.equal(fallback.groups[2]![48], "word:24");
    assert.deepEqual(fallback.result.words, Array(49).fill(7n));
  }
});

test("descriptor access gate precedes state reads and cannot reuse an allowed sibling invocation", () => {
  assert.equal(run(true, true, "absent").groups[2]!.length, 49);
  const denied = run(true, false, "returned");
  assert.deepEqual(denied.groups, [["access"], [], []]);
  assert.equal(denied.result.allowed, false);
  assert.deepEqual(denied.result.words, []);
});
