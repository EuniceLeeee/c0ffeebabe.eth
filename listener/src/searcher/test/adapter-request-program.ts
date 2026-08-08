import assert from "node:assert/strict";
import { familyId } from "../venues/adapter-family-identifiers.js";
import {
  createBoundedRequestExecutor,
  declareRequestProgram,
  isIssuedStaticEvidenceReuseProof,
  physicalRequestSetFingerprint,
  requestSetFingerprint,
  runRequestProgram,
  type AdapterRequest,
  type AdapterRequestResult,
  type BoundedRequestExecutorHandlers,
  type CanonicalSource,
  type InputResolvedStaticEvidenceProgram,
  type RequestRequirements,
  type StaticEvidenceProgram,
  type StaticEvidenceReuseSeal,
} from "../venues/adapter-request-program.js";

const source: CanonicalSource = Object.freeze({
  number: 25_700_001,
  hash: `0x${"ab".repeat(32)}`,
  generation: 7,
});
const id = familyId("swap:test-family");
const requests = Object.freeze([{
  id: "state",
  kind: "eth-call",
  to: `0x${"11".repeat(20)}`,
  data: "0x12345678",
  completion: "return-data",
}] satisfies readonly AdapterRequest[]);

let sealCalls = 0;
let executeCalls = 0;
const executorHandlers: BoundedRequestExecutorHandlers = {
  assertSupported(requirements: RequestRequirements) {
    assert.deepEqual(requirements.transports, ["eth-call"]);
    assert.equal(requirements.effects, undefined);
  },
  assertCallerBinding() {
    assert.fail("caller-free programs must not request a caller binding");
  },
  assertWithinBudget(familyId, actualRequests) {
    assert.equal(familyId, id);
    assert.deepEqual(actualRequests, requests);
  },
  async execute(input): Promise<readonly AdapterRequestResult[]> {
    executeCalls++;
    assert.equal(input.source, source);
    assert.deepEqual(input.requirements.transports, ["eth-call"]);
    return [{
      id: "state",
      ok: true,
      source,
      provenance: {
        kind: "eip1898",
        fingerprint: "trusted-read",
      },
      completion: "returned",
      data: "0x01",
    }];
  },
  sealStaticEvidenceReuseProof(input): StaticEvidenceReuseSeal {
    sealCalls++;
    assert.equal(input.reusePolicy.kind, "immutable-code");
    return Object.freeze({ proofHash: "cd".repeat(32) });
  },
};
const executor = createBoundedRequestExecutor(executorHandlers);

const ordinary = await runRequestProgram({
  familyId: id,
  program: {
    requirements: () => ({ transports: ["eth-call"] }),
    buildRequests: () => requests,
    decode: ({ results }) => {
      assert.equal(results[0]?.ok, true);
      assert(Object.isFrozen(results));
      assert(Object.isFrozen(results[0]));
      assert(Object.isFrozen(results[0]?.source));
      return "decoded";
    },
  },
  programInput: undefined,
  source,
  executor,
});
assert.equal(ordinary.evidence, "decoded");
assert.match(ordinary.trustedResultsFingerprint, /^[a-f0-9]{64}$/);
assert.equal(ordinary.reuseProof, undefined);
assert.equal(sealCalls, 0);

const staticProgram: StaticEvidenceProgram<void, string> = {
  reusePolicy: { kind: "immutable-code", codeSubjects: [requests[0]!.to] },
  requirements: () => ({ transports: ["eth-call"] }),
  buildRequests: () => requests,
  decode: () => "static-decoded",
};
const staticResult = await runRequestProgram({
  familyId: id,
  program: staticProgram,
  programInput: undefined,
  source,
  executor,
});
assert.equal(staticResult.evidence, "static-decoded");
assert.equal(staticResult.reuseProof?.proofHash, "cd".repeat(32));
assert.equal(staticResult.reuseProof?.policyKind, "immutable-code");
assert.equal(
  staticResult.reuseProof?.requestFingerprint,
  requestSetFingerprint(requests),
);
assert(isIssuedStaticEvidenceReuseProof(staticResult.reuseProof));
assert(
  !isIssuedStaticEvidenceReuseProof({ ...staticResult.reuseProof }),
  "a copied proof must lose its central issuance",
);
assert.equal(sealCalls, 1);

const failedStaticExecutor = createBoundedRequestExecutor({
  ...executorHandlers,
  async execute() {
    return [{
      id: "state",
      ok: false,
      source,
      failure: "resource-limited",
    }];
  },
});
let requiredFailureDecodeCalls = 0;
await assert.rejects(
  runRequestProgram({
    familyId: id,
    program: {
      ...staticProgram,
      decode: () => {
        requiredFailureDecodeCalls++;
        return "must-not-decode";
      },
    },
    programInput: undefined,
    source,
    executor: failedStaticExecutor,
  }),
  /required adapter request state failed: resource-limited/,
);
assert.equal(requiredFailureDecodeCalls, 0);

const optionalRequests = Object.freeze(requests.map((request) =>
  Object.freeze({ ...request, required: false as const })
));
assert.notEqual(
  requestSetFingerprint(requests),
  requestSetFingerprint(optionalRequests),
  "requiredness is logical program identity",
);
assert.equal(
  physicalRequestSetFingerprint(requests),
  physicalRequestSetFingerprint(optionalRequests),
  "requiredness must not pollute physical transport identity",
);
const optionalStaticExecutor = createBoundedRequestExecutor({
  ...executorHandlers,
  assertWithinBudget(family, actualRequests) {
    assert.equal(family, id);
    assert.deepEqual(actualRequests, optionalRequests);
  },
  async execute() {
    return [{
      id: "state",
      ok: false,
      source,
      failure: "resource-limited",
    }];
  },
});
const failedStatic = await runRequestProgram({
  familyId: id,
  program: {
    ...staticProgram,
    buildRequests: () => optionalRequests,
    decode: ({ results }) => {
      assert.equal(results[0]?.ok, false);
      return "unresolved";
    },
  },
  programInput: undefined,
  source,
  executor: optionalStaticExecutor,
});
assert.equal(failedStatic.evidence, "unresolved");
assert.equal(failedStatic.reuseProof, undefined);
assert.equal(sealCalls, 1, "failed static evidence must not receive a reuse proof");

await assert.rejects(
  runRequestProgram({
    familyId: id,
    program: {
      requirements: () => ({
        transports: ["eth-call"],
      }),
      buildRequests: () => [requests[0]!, requests[0]!],
      decode: () => "never",
    },
    programInput: undefined,
    source,
    executor,
  }),
  /request id must be unique/,
);

const wrongSourceExecutor = createBoundedRequestExecutor({
  ...executorHandlers,
  async execute() {
    return [{
      id: "state",
      ok: false,
      source: { ...source, generation: source.generation + 1 },
      failure: "aborted",
    }];
  },
});
await assert.rejects(
  runRequestProgram({
    familyId: id,
    program: staticProgram,
    programInput: undefined,
    source,
    executor: wrongSourceExecutor,
  }),
  /result source mismatch/,
);

const asyncBuilder = {
  requirements: () => ({ transports: ["eth-call"] as const }),
  buildRequests: async () => requests,
  decode: () => "never",
};
await assert.rejects(
  runRequestProgram({
    familyId: id,
    program: asyncBuilder as never,
    programInput: undefined,
    source,
    executor,
  }),
  /request construction must be synchronous/,
);

await assert.rejects(
  runRequestProgram({
    familyId: id,
    program: {
      requirements: () => ({ transports: ["get-code"] }),
      buildRequests: () => requests,
      decode: () => "never",
    },
    programInput: undefined,
    source,
    executor,
  }),
  /uses undeclared transport eth-call/,
);

const undeclaredRevertExecutor = createBoundedRequestExecutor({
  ...executorHandlers,
  async execute() {
    return [{
      id: "state",
      ok: true,
      source,
      provenance: { kind: "eip1898", fingerprint: "trusted-read" },
      completion: "reverted-as-declared",
      data: "0x01",
    }];
  },
});
await assert.rejects(
  runRequestProgram({
    familyId: id,
    program: staticProgram,
    programInput: undefined,
    source,
    executor: undeclaredRevertExecutor,
  }),
  /returned undeclared revert data/,
);

await assert.rejects(
  runRequestProgram({
    familyId: id,
    program: staticProgram,
    programInput: undefined,
    source,
    executor: executorHandlers as never,
  }),
  /must be issued by the central runtime/,
);

await assert.rejects(
  runRequestProgram({
    familyId: id,
    program: {
      requirements: () => ({
        transports: ["eth-call"],
        effects: ["logs"],
      }),
      buildRequests: () => requests,
      decode: () => "never",
    },
    programInput: undefined,
    source,
    executor,
  }),
  /declared request effect logs is not observed/,
);

const executorCaller = `0x${"22".repeat(20)}`;
const otherCaller = `0x${"33".repeat(20)}`;
const simulationTarget = `0x${"44".repeat(20)}`;
const token = `0x${"55".repeat(20)}`;
const executorCallerRef = Object.freeze({ kind: "executor" as const });

const callerRequest = Object.freeze({
  id: "caller-read",
  kind: "eth-call",
  to: simulationTarget,
  data: "0x12345678",
  caller: executorCallerRef,
  completion: "return-data",
} satisfies AdapterRequest);
const callerDeclaration = declareRequestProgram({
  requirements: () => ({ transports: ["eth-call"], caller: "executor" }),
  buildRequests: () => [callerRequest],
  decode: () => "unused",
}, undefined);
assert.deepEqual(callerDeclaration.requirements, {
  transports: ["eth-call"],
  caller: "executor",
  completions: ["return-data"],
});
assert.deepEqual(callerDeclaration.requests[0], callerRequest);
const callerExecutor = createBoundedRequestExecutor({
  ...executorHandlers,
  assertSupported() {},
  assertWithinBudget() {},
  assertCallerBinding({ callerRef }) {
    assert.equal(callerRef.kind, "executor");
    throw new Error("central executor caller authority is missing");
  },
  async execute() {
    assert.fail("an unbound caller must fail before execution");
  },
});
await assert.rejects(
  runRequestProgram({
    familyId: id,
    program: {
      requirements: () => ({
        transports: ["eth-call"],
        caller: "executor",
      }),
      buildRequests: () => [callerRequest],
      decode: () => "never",
    },
    programInput: undefined,
    source,
    executor: callerExecutor,
  }),
  /central executor caller authority is missing/,
);

await assert.rejects(
  runRequestProgram({
    familyId: id,
    program: {
      requirements: () => ({ transports: ["eth-call"], caller: "executor" }),
      buildRequests: () => [{
        ...callerRequest,
        from: otherCaller,
      } as never],
      decode: () => "never",
    },
    programInput: undefined,
    source,
    executor: callerExecutor,
  }),
  /unsupported field from/,
);

const simulationRequest = Object.freeze({
  id: "effect-probe",
  kind: "effect-delta-simulation",
  preCalls: Object.freeze([Object.freeze({
    caller: executorCallerRef,
    to: token,
    data: "0x095ea7b3",
  })]),
  call: Object.freeze({
    caller: executorCallerRef,
    to: simulationTarget,
    data: "0x12345678",
  }),
  overrideIntent: Object.freeze({ caller: executorCallerRef }),
  observe: Object.freeze(["revert-data"]),
} satisfies AdapterRequest);
const explicitRevertExecutor = createBoundedRequestExecutor({
  ...executorHandlers,
  assertSupported() {},
  assertWithinBudget() {},
  assertCallerBinding({ callerRef }) {
    assert.equal(callerRef.kind, "executor");
  },
  async execute() {
    return [{
      id: simulationRequest.id,
      ok: true,
      source,
      provenance: { kind: "effect-sim", fingerprint: "trusted-effect-sim" },
      completion: "reverted-as-declared",
      data: "0x08c379a0",
    }];
  },
});
const explicitRevert = await runRequestProgram({
  familyId: id,
  program: {
    requirements: () => ({
      transports: ["effect-delta-simulation"],
      caller: "executor",
      effects: ["revert-data"],
    }),
    buildRequests: () => [simulationRequest],
    decode: ({ results }) =>
      results[0]?.ok ? results[0].completion : "failed",
  },
  programInput: undefined,
  source,
  executor: explicitRevertExecutor,
});
assert.equal(explicitRevert.evidence, "reverted-as-declared");

const mismatchedPreCall = {
  ...simulationRequest,
  preCalls: [{
    ...simulationRequest.preCalls[0],
    caller: { kind: "observed-sender" as const },
  }],
};
await assert.rejects(
  runRequestProgram({
    familyId: id,
    program: {
      requirements: () => ({
        transports: ["effect-delta-simulation"],
        caller: "executor",
        effects: ["revert-data"],
      }),
      buildRequests: () => [mismatchedPreCall],
      decode: () => "never",
    },
    programInput: undefined,
    source,
    executor: explicitRevertExecutor,
  }),
  /caller observed-sender does not match requirement executor/,
);

const mismatchedOverride = {
  ...simulationRequest,
  overrideIntent: { caller: { kind: "observed-sender" as const } },
};
await assert.rejects(
  runRequestProgram({
    familyId: id,
    program: {
      requirements: () => ({
        transports: ["effect-delta-simulation"],
        caller: "executor",
        effects: ["revert-data"],
      }),
      buildRequests: () => [mismatchedOverride],
      decode: () => "never",
    },
    programInput: undefined,
    source,
    executor: explicitRevertExecutor,
  }),
  /caller observed-sender does not match requirement executor/,
);

const negativeOverride = {
  ...simulationRequest,
  overrideIntent: {
    caller: executorCallerRef,
    tokenBalances: [{ token, amount: -1n }],
  },
};
await assert.rejects(
  runRequestProgram({
    familyId: id,
    program: {
      requirements: () => ({
        transports: ["effect-delta-simulation"],
        caller: "executor",
        effects: ["revert-data"],
      }),
      buildRequests: () => [negativeOverride],
      decode: () => "never",
    },
    programInput: undefined,
    source,
    executor: explicitRevertExecutor,
  }),
  /token override must fit uint256/,
);

const tokenDeltaRequest = Object.freeze({
  ...simulationRequest,
  observe: Object.freeze(["token-delta"]),
} satisfies AdapterRequest);
const missingEffectsExecutor = createBoundedRequestExecutor({
  ...executorHandlers,
  assertSupported() {},
  assertWithinBudget() {},
  assertCallerBinding() {},
  async execute() {
    return [{
      id: tokenDeltaRequest.id,
      ok: true,
      source,
      provenance: { kind: "effect-sim", fingerprint: "trusted-effect-sim" },
      completion: "returned",
      data: "0x",
    }];
  },
});
await assert.rejects(
  runRequestProgram({
    familyId: id,
    program: {
      requirements: () => ({
        transports: ["effect-delta-simulation"],
        caller: "executor",
        effects: ["token-delta"],
      }),
      buildRequests: () => [tokenDeltaRequest],
      decode: () => "never",
    },
    programInput: undefined,
    source,
    executor: missingEffectsExecutor,
  }),
  /omitted declared effect observations/,
);

await assert.rejects(
  runRequestProgram({
    familyId: id,
    program: staticProgram,
    programInput: undefined,
    source,
    executor: { ...executor } as never,
  }),
  /must be issued by the central runtime/,
);

const invalidSealExecutor = createBoundedRequestExecutor({
  ...executorHandlers,
  async execute() {
    return [{
      id: "state",
      ok: true,
      source,
      provenance: { kind: "eip1898", fingerprint: "trusted-read" },
      completion: "returned",
      data: "0x01",
    }];
  },
  sealStaticEvidenceReuseProof() {
    return { proofHash: "not-a-sha256" };
  },
});
await assert.rejects(
  runRequestProgram({
    familyId: id,
    program: staticProgram,
    programInput: undefined,
    source,
    executor: invalidSealExecutor,
  }),
  /must contain a SHA-256 proof hash/,
);

const extraResultFieldExecutor = createBoundedRequestExecutor({
  ...executorHandlers,
  async execute() {
    return [{
      id: "state",
      ok: true,
      source,
      provenance: { kind: "eip1898", fingerprint: "trusted-read" },
      completion: "returned",
      data: "0x01",
      injected: "must-not-reach-decoder",
    } as never];
  },
});
await assert.rejects(
  runRequestProgram({
    familyId: id,
    program: staticProgram,
    programInput: undefined,
    source,
    executor: extraResultFieldExecutor,
  }),
  /successful result contains unsupported field injected/,
);

const emptyDependencyProgram: StaticEvidenceProgram<void, string> = {
  ...staticProgram,
  reusePolicy: {
    kind: "dependency-proof",
    dependencyKeys: () => [],
  },
};

const inputResolvedReuseProgram: InputResolvedStaticEvidenceProgram<
  { readonly immutable: boolean },
  string
> = {
  requirements: () => ({ transports: ["eth-call"] }),
  buildRequests: () => requests,
  decode: () => "input-resolved-static",
  reusePolicy: (input) => input.immutable
    ? { kind: "immutable-code", codeSubjects: [requests[0]!.to] }
    : { kind: "source-local" },
};
const inputResolvedReuse = await runRequestProgram({
  familyId: id,
  program: inputResolvedReuseProgram,
  programInput: { immutable: true },
  source,
  executor,
});
assert.equal(inputResolvedReuse.reuseProof?.policyKind, "immutable-code");

await assert.rejects(
  runRequestProgram({
    familyId: id,
    program: {
      requirements: () => ({
        transports: ["eth-call"],
        completions: ["return-data"],
      }),
      buildRequests: () => [{
        ...requests[0]!,
        completion: "return-or-revert-data",
      }],
      decode: () => "never",
    },
    programInput: undefined,
    source,
    executor,
  }),
  /uses undeclared completion return-or-revert-data/,
);
await assert.rejects(
  runRequestProgram({
    familyId: id,
    program: emptyDependencyProgram,
    programInput: undefined,
    source,
    executor,
  }),
  /requires at least one dependency key/,
);

assert.equal(executeCalls, 3);
console.log("adapter-request-program PASS (declarative source-bound execution)");
