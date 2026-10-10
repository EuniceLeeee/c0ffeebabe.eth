import assert from "node:assert/strict";
import { ethers } from "ethers";
import { POOL, same } from "../codec.js";
import { resolve } from "node:path";

export function assertAcceptanceBinding(input: {
  saved: any; readyPath: string; readySha256: string; source: { number: number; hash: string };
  executor: string; owner: string;
}): void {
  const { saved, source } = input;
  assert.equal(resolve(saved.readyPath), input.readyPath); assert.equal(saved.readySha256, input.readySha256);
  assert.equal(saved.stateSource.number, source.number); assert.equal(saved.stateSource.hash, source.hash);
  assert.equal(saved.topologySource.number, source.number); assert.equal(saved.topologySource.hash, source.hash);
  assert(same(saved.executor, input.executor)); assert(same(saved.owner, input.owner));
  assert.equal(saved.broadcast, false); assert.equal(saved.policy.dryRun, true);
}

export function requireProductionReference(row: { status: string; amountIn: bigint }): void {
  assert(row.amountIn > 0n && ["quoted", "no-output"].includes(row.status),
    "missing/failed production reference is incomplete acceptance, not success");
}

// A generic outer VM revert cannot establish protocol inventory rejection.
// Bind the actual failed inner call, its amount and return data, and reject OOG.
export function assertInventoryRejection(trace: any, pool: string, executor: string, amount: bigint): void {
  assert(trace && /revert/i.test(trace.error ?? ""), "execution must revert atomically");
  assert(BigInt(trace.gasUsed) < BigInt(trace.gas), "gas exhaustion is not inventory evidence");
  const matches: any[] = [];
  const visit = (call: any) => {
    if (call.to && same(call.to, pool) && call.input === POOL.encodeFunctionData("swapBase1")) matches.push(call);
    for (const child of call.calls ?? []) visit(child);
  };
  visit(trace); assert.equal(matches.length, 1, "one real swapBase1 call required");
  const call = matches[0];
  assert.equal(call.type, "CALL"); assert(same(call.from, executor));
  assert.equal(BigInt(call.value), amount); assert(/revert/i.test(call.error ?? ""));
  assert(BigInt(call.gasUsed) < BigInt(call.gas), "inner gas exhaustion is not inventory evidence");
  assert.equal(call.output?.slice(0, 10), "0x08c379a0", "typed Solidity Error required");
  const [reason] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + call.output.slice(10));
  assert.equal(reason, "No fund to execute the trade");
}
