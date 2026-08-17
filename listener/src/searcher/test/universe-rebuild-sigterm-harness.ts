import { UniverseRebuildCheckpointStore, AttestationCheckpointWriter, type DurableVerifiedMemo } from "../universe-rebuild-checkpoint.js";
// Child harness: begin a run, record N outcomes, install the signal flush,
// then wait for SIGTERM and exit after the flush.
const path = process.env.CKPT_PATH;
const count = Number(process.env.OUTCOME_COUNT ?? "10");
const source = Object.freeze({ number: 25_750_000, hash: "0x" + "a1".repeat(32), generation: 1 });
async function main(): Promise<void> {
  if (path === undefined) throw new Error("CKPT_PATH required");
  const store = new UniverseRebuildCheckpointStore({ path });
  await store.beginOrResumeRun({
    expectedRevision: 0,
    runId: "run-sig",
    cutoff: source,
    fromBlock: source.number - 14_399,
    universeHash: "u",
    candidateSetHash: "c",
    candidateCount: count,
    observedThrough: Object.freeze({ number: source.number, hash: source.hash }),
  });
  // batchSize above the outcome count: nothing auto-flushes; the SIGTERM
  // handler must persist every completed outcome in one flush.
  const writer = new AttestationCheckpointWriter({
    store,
    runId: "run-sig",
    batchSize: 1_000,
    maxIntervalMs: 60_000,
  });
  writer.installSignalFlush();
  // SIGTERM: flush the completed outcomes, then exit cleanly. The interval
  // keeps the event loop alive so the async flush can complete.
  process.on("SIGTERM", () => {
    void writer.flush().finally(() => process.exit(0));
  });
  const keepAlive = setInterval(() => undefined, 5_000);
  void keepAlive;
  for (let i = 0; i < count; i++) {
    const key = "sig:" + i;
    const memo = Object.freeze({
      familyCandidateKey: key,
      familyInstanceKey: "inst:" + i,
      familyId: "univ2-standard",
      candidateKey: key,
      instanceKey: "inst:" + i,
      candidateFingerprint: "candidate:" + i,
      familyDefinitionHash: "family-definition",
      validity: Object.freeze({
        policy: "immutable-code",
        authorityFingerprint: "authority",
        proofSource: Object.freeze({ number: source.number, hash: source.hash }),
      }),
      verifiedIdentity: Object.freeze({ key }),
      compiledDescriptor: Object.freeze({ key }),
      staticProjection: Object.freeze({ routes: Object.freeze([]) }),
      evidenceFingerprint: "evidence:" + i,
      memoFingerprint: "memo:" + i,
    }) as DurableVerifiedMemo;
    writer.record(Object.freeze({
      status: "verified",
      familyCandidateKey: key,
      familyInstanceKey: "inst:" + i,
      memoFingerprint: "memo:" + i,
    }), memo);
  }
  // Do not flush explicitly: the SIGTERM handler must do it.
  console.log("READY");
  await new Promise(() => undefined);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
