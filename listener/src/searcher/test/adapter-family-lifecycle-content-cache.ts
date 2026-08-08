import assert from "node:assert/strict";
import {
  createAdapterFamilyLifecycleContentCache,
  createAdapterStaticEvidenceReuseAuthority,
} from "../adapter-family-lifecycle-content-cache.js";
import { familyId } from "../venues/adapter-family-identifiers.js";
import {
  createBoundedRequestExecutor,
  runRequestProgram,
  type AdapterRequest,
  type CanonicalSource,
  type StaticEvidenceProgram,
} from "../venues/adapter-request-program.js";

const FAMILY = familyId("swap:static-cache-test");
const SUBJECT = "pool:alpha";
const POOL = `0x${"31".repeat(20)}`;
const CAPABILITY = "ab".repeat(32);
const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_111,
  hash: `0x${"41".repeat(32)}`,
  generation: 7,
});

interface ProgramInput {
  readonly label: string;
  readonly pool: string;
}

interface Evidence {
  readonly label: string;
  readonly code: string;
}

function sourceLocalProgram(): StaticEvidenceProgram<ProgramInput, Evidence> {
  return {
    reusePolicy: { kind: "source-local" },
    requirements: () => ({ transports: ["get-code"] }),
    buildRequests: (input) => [{
      id: `code:${input.pool}`,
      kind: "get-code",
      address: input.pool,
    }],
    decode: ({ programInput, results }) => ({
      label: programInput.label,
      code: results[0]!.ok ? results[0]!.data : "failed",
    }),
  };
}

function immutableProgram(): StaticEvidenceProgram<ProgramInput, Evidence> {
  return {
    ...sourceLocalProgram(),
    reusePolicy: { kind: "immutable-code", codeSubjects: [POOL] },
  };
}

function executor(executions: AdapterRequest[][]) {
  return createBoundedRequestExecutor({
    assertSupported() {},
    assertCallerBinding() {},
    assertWithinBudget() {},
    execute: async ({ requests, source }) => {
      executions.push([...requests]);
      return requests.map((request) => ({
        id: request.id,
        ok: true as const,
        source,
        provenance: {
          kind: "cache-test",
          fingerprint: `result:${request.id}`,
        },
        completion: "returned" as const,
        data: "0x6000",
      }));
    },
    sealStaticEvidenceReuseProof: () => ({ proofHash: "cd".repeat(32) }),
  });
}

async function sourceLocalReuseRedecodesCurrentInput(): Promise<void> {
  const executions: AdapterRequest[][] = [];
  const program = sourceLocalProgram();
  const firstInput = Object.freeze({ label: "first", pool: POOL });
  const executed = await runRequestProgram({
    familyId: FAMILY,
    program,
    programInput: firstInput,
    source: SOURCE,
    executor: executor(executions),
  });
  const cache = createAdapterFamilyLifecycleContentCache({ capacity: 2 });
  assert(cache.store({
    familyId: FAMILY,
    stage: "instance-static",
    subjectKey: SUBJECT,
    capabilityHash: CAPABILITY,
    source: SOURCE,
    program,
    programInput: firstInput,
    executed,
  }));

  const nextSource: CanonicalSource = Object.freeze({
    ...SOURCE,
    generation: SOURCE.generation + 1,
  });
  const hit = await cache.lookup({
    familyId: FAMILY,
    stage: "instance-static",
    subjectKey: SUBJECT,
    capabilityHash: CAPABILITY,
    source: nextSource,
    program,
    programInput: { label: "second", pool: POOL },
  });
  assert(hit);
  assert.deepEqual(hit.executed.evidence, {
    label: "second",
    code: "0x6000",
  });
  assert.equal(
    hit.executed.trustedResults[0]!.source.generation,
    nextSource.generation,
  );
  assert.equal(executions.length, 1, "cache replay must not execute transport");

  const differentBlock = await cache.lookup({
    familyId: FAMILY,
    stage: "instance-static",
    subjectKey: SUBJECT,
    capabilityHash: CAPABILITY,
    source: {
      number: SOURCE.number + 1,
      hash: `0x${"42".repeat(32)}`,
      generation: SOURCE.generation + 2,
    },
    program,
    programInput: { label: "third", pool: POOL },
  });
  assert.equal(differentBlock, undefined);
  assert.deepEqual(cache.snapshot(), {
    size: 1,
    capacity: 2,
    hits: 1,
    misses: 1,
    stores: 1,
    evictions: 0,
    rejectedReuse: 1,
    corruptEntries: 0,
  });
}

async function crossSourceReuseRequiresCentralAuthority(): Promise<void> {
  const executions: AdapterRequest[][] = [];
  const program = immutableProgram();
  const programInput = Object.freeze({ label: "immutable", pool: POOL });
  const executed = await runRequestProgram({
    familyId: FAMILY,
    program,
    programInput,
    source: SOURCE,
    executor: executor(executions),
  });
  const proofChecks: string[] = [];
  const authority = createAdapterStaticEvidenceReuseAuthority((input) => {
    proofChecks.push(input.capabilityHash);
    assert.equal(input.reusePolicy.kind, "immutable-code");
    return true;
  });
  const cache = createAdapterFamilyLifecycleContentCache({
    capacity: 1,
    reuseAuthority: authority,
  });
  assert(cache.store({
    familyId: FAMILY,
    stage: "pricing-static",
    subjectKey: SUBJECT,
    capabilityHash: CAPABILITY,
    source: SOURCE,
    program,
    programInput,
    executed,
  }));
  const hit = await cache.lookup({
    familyId: FAMILY,
    stage: "pricing-static",
    subjectKey: SUBJECT,
    capabilityHash: CAPABILITY,
    source: {
      number: SOURCE.number + 10,
      hash: `0x${"43".repeat(32)}`,
      generation: SOURCE.generation + 10,
    },
    program,
    programInput,
  });
  assert(hit);
  assert.deepEqual(proofChecks, [CAPABILITY]);
  assert.equal(cache.snapshot().hits, 1);
}

await sourceLocalReuseRedecodesCurrentInput();
await crossSourceReuseRequiresCentralAuthority();

console.log("adapter Family lifecycle content cache PASS");
