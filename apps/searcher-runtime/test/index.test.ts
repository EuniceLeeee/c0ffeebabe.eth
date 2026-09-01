import assert from "node:assert/strict";
import test from "node:test";
import * as runtimeModule from "../src/index.ts";
import { createReleaseSearcherProducer } from "../src/index.ts";
import { issueStartupRuntime } from "../../../packages/startup-runtime/src/internal/runtime-owner.ts";
import {
  createSignedReleaseRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
} from "../../../packages/runtime-authority/src/index.ts";

const fakeReleaseHash = `0x${"0".repeat(64)}` as `0x${string}`;
const fakeBindingHash = `0x${"4".repeat(64)}` as `0x${string}`;
const fakeCommit = "a".repeat(40);
const fakeRuntimeAuthority = projectRuntimeAuthorityDescriptorV1(
  createSignedReleaseRuntimeAuthorityDescriptorV1({
    authorityClass: "signed-release",
    runtimeBindingId: fakeBindingHash,
    releaseProvenanceHash: fakeReleaseHash,
    implementationCommit: fakeCommit,
  }),
);

test("searcher runtime exposes only the app-owned Producer entry", () => {
  assert.equal("runSearcherRuntime" in runtimeModule, false);
  assert.equal("runReleaseSearcherRuntime" in runtimeModule, false);
  assert.equal("ReadyGenerationServiceV1" in runtimeModule, false);
  assert.equal("bindPromotion" in runtimeModule, false);
  assert.equal(typeof createReleaseSearcherProducer, "function");
});

test("Producer rejects a structural or cloned runtime-release Strategy service before work", () => {
  const serving = Object.freeze({
    ready: { releaseProvenanceHash: fakeReleaseHash, definitionCatalogRoot: fakeReleaseHash } as never,
    generationId: "fake",
    graphRoot: fakeReleaseHash,
    readyRecordHash: fakeReleaseHash,
    sourceCoverageRoot: fakeReleaseHash,
    definitionCatalogRoot: fakeReleaseHash,
    releaseProvenanceHash: fakeReleaseHash,
  });
  const startup = issueStartupRuntime({
    ready: serving.ready,
    familyRuntimeComposition: {} as never,
    familySearchRuntime: Object.freeze({}) as never,
    generationId: "fake",
    graphRoot: fakeReleaseHash,
    runtimeAuthority: fakeRuntimeAuthority,
    canonicalSourceAuthority: {} as never,
    readActiveGeneration: () => serving,
    readServingGeneration: () => serving,
    readProducerSessionGeneration: () => serving,
    async withProducerSession() { throw new Error("must not open"); },
    async waitForGenerationIdle() {},
    async close() {},
  });
  assert.throws(
    () => createReleaseSearcherProducer({
      startup,
      strategyRuntime: { readMetadata: () => ({}), issuePlanningProblem: () => ({}) } as never,
      source: {} as never,
      coreInput: {} as never,
      finalSimulationFactory: {} as never,
      economicSafety: {} as never,
      evidence: {} as never,
    }),
    /Strategy runtime service is not owner-issued/,
  );
  assert.throws(
    () => createReleaseSearcherProducer({
      startup,
      strategyRuntime: { ...({ readMetadata: () => ({}), issuePlanningProblem: () => ({}) } as object) } as never,
      source: {} as never,
      coreInput: {} as never,
      finalSimulationFactory: {} as never,
      economicSafety: {} as never,
      evidence: {} as never,
    }),
    /Strategy runtime service is not owner-issued/,
  );
});

test("startup seam rejects a fake release owner result", async () => {
  let started = false;
  await assert.rejects(
    runtimeModule.startReleaseSearcherStartup({
      release: { bindingId: fakeBindingHash, releaseProvenanceHash: fakeReleaseHash, candidateReleaseCommit: "a".repeat(40) },
      async startStartup() {
        started = true;
        return {} as never;
      },
    }),
    /searcher startup service is not owner-issued/,
  );
  assert.equal(started, false);
});
