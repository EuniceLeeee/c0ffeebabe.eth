import assert from "node:assert/strict";
import { test } from "node:test";
import { logRevmFault } from "../revm-fault-diagnostics.js";

test("fault diagnostics retain safe correlation and never echo arbitrary metadata", () => {
  const original = console.error, lines: string[] = [];
  console.error = line => { lines.push(String(line)); };
  try {
    const key = "ab".repeat(32), secret = "https://user:secret@invalid.test/key-secret";
    logRevmFault("client-daemon", { kind: "rpc-throttle", category: "http429", httpStatus: 429 },
      { daemonPid: 123, requestId: "7", candidateKey: key, blockNumber: 300 });
    const record = JSON.parse(lines[0]!.slice("[revm-fault] ".length));
    assert.equal(record.stage, "client-daemon"); assert.equal(record.daemonPid, 123);
    assert.equal(record.requestId, "7"); assert.equal(record.candidateKey, key);
    assert.equal(record.httpStatus, 429); assert.equal(record.blockNumber, 300);
    logRevmFault("client-response", { kind: "source-fault", message: secret } as never,
      { daemonPid: NaN, requestId: secret, candidateKey: secret, blockNumber: Infinity });
    assert(!lines.join().includes("secret"));
    const invalid = JSON.parse(lines[1]!.slice("[revm-fault] ".length));
    for (const field of ["daemonPid", "requestId", "candidateKey", "blockNumber", "message"]) assert(!(field in invalid));
    console.error = () => { throw Error("diagnostic sink unavailable"); };
    assert.doesNotThrow(() => logRevmFault("client-daemon", { kind: "source-fault" }));
  } finally { console.error = original; }
});
