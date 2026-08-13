import assert from "node:assert/strict";
import {
  executeCaptureObservationIntents,
  runGenericCaptureBatch,
  runGenericCaptureWorkItem,
  type GenericCaptureProvider,
} from "../generic-family-capture.js";
import type { LoadedFamilyBox } from
  "../venues/family-capability-catalog.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 300_000,
  hash: `0x${"c1".repeat(32)}`,
  generation: 300_000,
});
const ADDRESS = `0x${"11".repeat(20)}`;
const TOPIC = `0x${"22".repeat(32)}` as `0x${string}`;

async function main(): Promise<void> {
  let cancelled = false;
  await assert.rejects(runGenericCaptureWorkItem({
    id: "stuck",
    timeoutMs: 10,
    run: () => new Promise<never>(() => undefined),
    cancel: () => { cancelled = true; },
  }), /stuck exceeded 10ms/);
  assert.equal(cancelled, true);

  const failures: string[] = [];
  const continued = await runGenericCaptureBatch({
    items: [{
      id: "stuck",
      timeoutMs: 10,
      run: () => new Promise<never>(() => undefined),
      cancel: () => undefined,
    }, {
      id: "next",
      timeoutMs: 10,
      run: async () => "continued",
      cancel: () => undefined,
    }],
    onFailure: (id) => failures.push(id),
  });
  assert.deepEqual(failures, ["stuck"]);
  assert.deepEqual(continued, ["continued"]);

  const pages: [number, number][] = [];
  const provider: GenericCaptureProvider = {
    call: async () => "0x",
    getCode: async () => "0x01",
    getStorage: async () => `0x${"00".repeat(32)}`,
    getTransactionReceipt: async () => null,
    send: async () => ({}),
    getLogs: async (filter) => {
      pages.push([filter.fromBlock!, filter.toBlock!]);
      if (pages.length === 1) return [];
      return [{
        address: ADDRESS,
        topics: [TOPIC, addressWord(ADDRESS)],
        data: "0x",
        transactionHash: `0x${"33".repeat(32)}`,
      }];
    },
  };
  const syntheticFamily = Object.freeze({
    plugin: Object.freeze({
      manifest: Object.freeze({ familyId: "synthetic:capture" }),
      discovery: Object.freeze({
        logPatterns: Object.freeze([Object.freeze({
          id: "singleton-log",
          topic: TOPIC,
          emitter: Object.freeze({
            mode: "singleton-indexed-address" as const,
            address: ADDRESS,
            topicIndex: 1,
            fromBlock: 1,
          }),
        })]),
      }),
    }),
  }) as unknown as LoadedFamilyBox;
  const observations = await executeCaptureObservationIntents({
    family: syntheticFamily,
    source: SOURCE,
    intents: [{
      kind: "declared-log",
      patternId: "singleton-log",
      candidateIdentity: ADDRESS,
    }],
    provider,
  });
  assert.equal(observations[0]?.kind, "log");
  assert.deepEqual(pages, [[200_001, 300_000], [100_001, 200_000]]);
  console.log("generic family capture PASS");
}

function addressWord(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
