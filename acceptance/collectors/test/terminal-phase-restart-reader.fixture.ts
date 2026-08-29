import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { createResolverPolicy } from "../../../specs/artifact-resolution/src/index.ts";
import { ContentAddressedObserverSinkV1 } from "../src/content-addressed-sink.ts";
import { ProductionTerminalPhaseLocatorIndexV1 } from "../src/terminal-phase-locator-index.ts";

const [
  storeDirectory,
  indexDirectory,
  finalDurableWindowId,
  storeIdentityHash,
] = process.argv.slice(2);
if ([storeDirectory, indexDirectory, finalDurableWindowId, storeIdentityHash].some(value => value === undefined)) {
  throw new TypeError("restart reader requires exact snapshot, index, store arguments");
}

const sink = new ContentAddressedObserverSinkV1({
  directory: storeDirectory,
  storeIdentityHash: storeIdentityHash as Hash,
  resolverPolicy: createResolverPolicy({
    schemaVersion: 1,
    kind: "aloha.artifact-resolver-policy",
    allowedLocatorKind: "content-object",
    digestAlgorithm: "sha256",
    maxByteLength: "10000000",
    requireExactLengthMediaAndSchema: true,
    minimumRemainingStoreEpochs: "0",
    failureOutcome: "invalid",
  }),
  lease: {
    validFromStoreEpoch: "1",
    validThroughStoreEpoch: "2",
    issuerId: "terminal-phase-restart-reader",
    issuerQualificationId: hashDomain("test/terminal-phase-restart-reader/v1", "qualification"),
    qualificationRegistryRoot: hashDomain("test/terminal-phase-restart-reader/v1", "registry"),
  },
});
const index = new ProductionTerminalPhaseLocatorIndexV1({ directory: indexDirectory, sink });
let rawWindowRejected = false;
try {
  await index.read(finalDurableWindowId as Hash);
} catch {
  rawWindowRejected = true;
}
if (!rawWindowRejected) throw new TypeError("fresh process recovered authority from a raw window id");
process.stdout.write(JSON.stringify({
  pid: process.pid,
  rawWindowRejected,
}));
