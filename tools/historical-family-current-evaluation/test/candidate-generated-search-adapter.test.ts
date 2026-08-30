import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  decodeCanonicalJson,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { erc20AssetRefV1 } from "../../../packages/asset-ref/src/index.ts";
import { candidateSubjectHash, familyCandidateKey } from "../../../packages/discovery/src/index.ts";
import {
  createReleaseFamilyRuntimeComposition,
} from "../../../generated/runtime-composition/index.ts";
import {
  readGeneratedFamilyRuntimeAdapterFactories,
  readGeneratedFamilyRuntimeFactoryMetadata,
  type GeneratedFamilyRuntimeFactoryMetadataV1,
} from "../../../packages/family-composition/src/internal/generated-runtime-composition.ts";
import {
  nominateUniV2,
  UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
  UNIV2_STANDARD_FAMILY_ID,
  UNIV2_SYNC_EVENT_TOPIC0,
  verifyUniV2IdentityStage,
} from "../../../families/univ2-standard/src/public.ts";
import { UNIV2_STANDARD_REQUESTED_ARTIFACT_DEPENDENCY_ROOT } from "../../../families/univ2-standard/src/family-definition.ts";
import {
  captureCandidateGeneratedSearchAdapterV1,
  inspectCandidateGeneratedSearchAdapterV1,
  replayCandidateGeneratedSearchAdapterV1,
} from "../src/candidate-generated-search-adapter.ts";
import { verifyCandidateGeneratedSourceBindingV1 } from "../src/candidate-generated-source-binding.ts";

const h = (value: string): Hash => hashDomain("aloha/candidate-generated-search-test/v1", value);
const address = (digit: string) => `0x${digit.repeat(40)}`;
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const addressWord = (value: string) => `0x${"0".repeat(24)}${value.slice(2)}`;
const reserveBytes = `0x${word(1_000_000n)}${word(2_000_000n)}${word(42n)}`;
const source = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const pool = address("1");
const token0 = address("2");
const token1 = address("3");
const factory = address("f");

async function withStore(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "aloha-candidate-generated-search-"));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function withRpc(
  dataHex: string,
  run: (endpoint: string, requests: readonly Record<string, unknown>[]) => Promise<void>,
): Promise<void> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: dataHex }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const selected = server.address();
  if (selected === null || typeof selected === "string") throw new TypeError("local RPC fixture did not bind");
  try {
    await run(`http://127.0.0.1:${selected.port}/rpc`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function routeBinding() {
  const nominated = nominateUniV2({
    pool,
    evidence: {
      cutoff: source,
      blockNumber: "99",
      blockHash: h("evidence-block"),
      txHash: h("evidence-tx"),
      logIndex: "0",
      emitter: pool,
      topic0: UNIV2_SYNC_EVENT_TOPIC0,
      rawLocatorHash: h("evidence-locator"),
    },
  });
  assert.equal(nominated.status, "nominated");
  if (nominated.status !== "nominated") throw new TypeError("nomination fixture failed");
  const verified = verifyUniV2IdentityStage({
    nomination: {
      ...nominated.candidate,
      candidateSnapshotHash: candidateSubjectHash(UNIV2_STANDARD_FAMILY_DEFINITION_HASH, pool),
    },
    reads: {
      cutoff: source,
      pool,
      token0ReturnHex: addressWord(token0),
      token1ReturnHex: addressWord(token1),
      factoryReturnHex: addressWord(factory),
      forwardPairReturnHex: addressWord(pool),
      reversePairReturnHex: addressWord(pool),
    },
  });
  assert.equal(verified.status, "verified");
  if (verified.status !== "verified") throw new TypeError("identity fixture failed");
  const memo = {
    kind: "univ2-identity-memo" as const,
    familyId: UNIV2_STANDARD_FAMILY_ID,
    familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
    familyCandidateKey: familyCandidateKey(UNIV2_STANDARD_FAMILY_DEFINITION_HASH, pool),
    instanceNominationKey: pool,
    candidateSubjectHash: candidateSubjectHash(UNIV2_STANDARD_FAMILY_DEFINITION_HASH, pool),
    candidateEvidenceRoot: h("candidate-evidence"),
    identity: verified.identity,
  };
  return Object.freeze({
    familyId: UNIV2_STANDARD_FAMILY_ID,
    familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
    instanceKey: pool,
    identityMemo: decodeCanonicalJson(encodeCanonicalJson(memo)) as CanonicalJson,
    identityMemoHash: hashDomain("aloha/identity-memo/v1", memo),
    instancePublicationHash: h("publication"),
    staticProjectionMemoHash: h("projection-memo"),
    requestedArtifactDependencyRoot: UNIV2_STANDARD_REQUESTED_ARTIFACT_DEPENDENCY_ROOT,
    staticProjectionHash: h("static-projection"),
    projectionHash: h("projection"),
    authoritySessionHash: h("authority-session"),
  });
}

const amount = Object.freeze({
  inputAssetRef: erc20AssetRefV1("1", token0),
  outputAssetRef: erc20AssetRefV1("1", token1),
  amountIn: "100000",
  recipient: address("4"),
});
const objectivePayload = Object.freeze({ kind: "search-objective", numeraire: amount.outputAssetRef });
const objective = Object.freeze({
  objectiveRef: hashDomain("aloha/search-objective/v1", objectivePayload),
  payload: objectivePayload,
});
const execution = Object.freeze({ transactionOrigin: address("5"), executorAddress: amount.recipient });
const request = Object.freeze({ route: routeBinding(), objective, amount, execution });
const currentSource = Object.freeze({ source, assertCurrent() {} });

test("fixed generated metadata/source binds all four candidate search Adapters without opening release authority", async () => {
  const runtimeBindings = readGeneratedFamilyRuntimeAdapterFactories(createReleaseFamilyRuntimeComposition);
  const univ2 = runtimeBindings.filter((binding) =>
    binding.familyDefinitionHash === UNIV2_STANDARD_FAMILY_DEFINITION_HASH
    && binding.descriptor.role === "search/v1");
  assert.equal(univ2.length, 1);
  assert.equal(univ2[0]!.actualFactory, (await import("../../../families/univ2-standard/src/public.ts")).UNIV2_STANDARD_SEARCH_ADAPTER_FACTORY);
  for (const familyId of ["curve-underlying", "dodo-v2", "fluid-dex", "univ2-standard"]) {
    const binding = await inspectCandidateGeneratedSearchAdapterV1(familyId);
    assert.equal(binding.familyId, familyId);
    assert.equal(binding.adapter.role, "search/v1");
    assert.match(binding.generatedFactoryDescriptorRoot, /^0x[0-9a-f]{64}$/);
    assert.match(binding.generatedStaticImportBindingRoot, /^0x[0-9a-f]{64}$/);
    assert.match(binding.extensionImportRoot, /^0x[0-9a-f]{64}$/);
    assert.match(binding.actionOwnerImportRoot, /^0x[0-9a-f]{64}$/);
  }
});

test("candidate runner captures and exactly frozen-replays the actual generated alias Adapter", async () => {
  await withStore(async (directory) => {
    await withRpc(reserveBytes, async (endpoint, requests) => {
      const captured = await captureCandidateGeneratedSearchAdapterV1({
        rootDirectory: directory,
        familyId: UNIV2_STANDARD_FAMILY_ID,
        endpoint,
        currentSource,
        request,
      });
      assert.equal(captured.kind, "sealed");
      if (captured.kind !== "sealed") return;
      assert.equal(captured.result.kind, "verified");
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0]!.params, [
        { to: pool, data: "0x0902f1ac" },
        { blockHash: source.hash, requireCanonical: true },
      ]);
      const manifest = captured.manifest;
      assert.equal(manifest.advisoryOnly, true);
      assert.equal(manifest.candidateGeneratedAdapterExecuted, true);
      assert.equal(manifest.generatedStaticImportBound, true);
      assert.equal(manifest.implementationClosureQualified, false);
      assert.equal(manifest.chainStateQualified, false);
      assert.equal(manifest.releaseQualified, false);
      assert.equal(manifest.productionAcceptance, false);
      assert.equal(manifest.adapterVerdictQualified, false);
      assert.equal(manifest.runResultClaimLevel, "untrusted-candidate-outcome-diagnostic-only");
      assert.equal(manifest.fenceClaimLevel, "before-after-observation-only-a-b-a-not-excluded");
      assert.equal(manifest.binding.adapter.exportName, "UNIV2_STANDARD_SEARCH_ADAPTER_FACTORY");
      assert.notEqual(manifest.manifestRoot, manifest.currentSourceManifestRoot);

      const replayed = await replayCandidateGeneratedSearchAdapterV1({
        rootDirectory: directory,
        manifestRoot: manifest.manifestRoot,
        currentSource,
        request,
      });
      assert.equal(replayed.kind, "replayed");
      assert.deepEqual(replayed.result, captured.result);
    });
  });
});

test("an Adapter invalidProgram is preserved as unsealed and never upgraded to a diagnostic manifest", async () => {
  await withStore(async (directory) => {
    await withRpc("0x01", async (endpoint) => {
      const captured = await captureCandidateGeneratedSearchAdapterV1({
        rootDirectory: directory,
        familyId: UNIV2_STANDARD_FAMILY_ID,
        endpoint,
        currentSource,
        request,
      });
      assert.equal(captured.kind, "unsealed");
      if (captured.kind !== "unsealed") return;
      assert.equal(captured.result?.kind, "invalidProgram");
      assert.equal(captured.releaseQualified, false);
      assert.equal(captured.productionAcceptance, false);
      assert.match(captured.reasonCode, /did not publish verified artifacts: invalidProgram/);
    });
  });
});

test("frozen candidate rejects a mutated neutral run request before consuming transport facts", async () => {
  await withStore(async (directory) => {
    await withRpc(reserveBytes, async (endpoint) => {
      const captured = await captureCandidateGeneratedSearchAdapterV1({
        rootDirectory: directory,
        familyId: UNIV2_STANDARD_FAMILY_ID,
        endpoint,
        currentSource,
        request,
      });
      assert.equal(captured.kind, "sealed");
      if (captured.kind !== "sealed") return;
      await assert.rejects(
        async () => replayCandidateGeneratedSearchAdapterV1({
          rootDirectory: directory,
          manifestRoot: captured.manifest.manifestRoot,
          currentSource,
          request: { ...request, amount: { ...amount, amountIn: "100001" } },
        }),
        /frozen run request mismatch/,
      );
    });
  });
});

test("runner integration rejects zero-consumption and subset-consumption transcript splices", async () => {
  await withStore(async (directory) => {
    await withRpc(reserveBytes, async (endpoint) => {
      const captured = await captureCandidateGeneratedSearchAdapterV1({
        rootDirectory: directory,
        familyId: UNIV2_STANDARD_FAMILY_ID,
        endpoint,
        currentSource,
        request,
      });
      assert.equal(captured.kind, "sealed");
      if (captured.kind !== "sealed") return;

      const writeCandidate = (value: Record<string, unknown>): Hash => {
        const { manifestRoot: ignored, ...base } = value;
        void ignored;
        const root = hashDomain("aloha/candidate-generated-search-adapter-diagnostic/v1", base);
        const next = { ...base, manifestRoot: root };
        writeFileSync(
          join(directory, "candidate-generated-search-adapter-v1", "manifests", `${root.slice(2)}.json`),
          encodeCanonicalBytes(next as never),
        );
        return root;
      };

      const currentPath = join(
        directory,
        "family-current-source-replay-v1",
        "manifests",
        `${captured.manifest.currentSourceManifestRoot.slice(2)}.json`,
      );
      const current = JSON.parse(readFileSync(currentPath, "utf8")) as Record<string, unknown>;
      const logical = current.logicalTranscript as Array<Record<string, unknown>>;
      const duplicated = [...logical, { ...logical[0]!, sequence: "2" }];
      const { manifestRoot: ignoredCurrent, logicalTranscriptRoot: ignoredTranscript, ...currentBase } = current;
      void ignoredCurrent;
      void ignoredTranscript;
      const nextCurrentBase = {
        ...currentBase,
        logicalTranscript: duplicated,
        logicalTranscriptRoot: hashDomain("aloha/family-current-source-logical-transcript/v1", duplicated),
      };
      const nextCurrentRoot = hashDomain("aloha/family-current-source-replay-manifest/v1", nextCurrentBase);
      writeFileSync(
        join(directory, "family-current-source-replay-v1", "manifests", `${nextCurrentRoot.slice(2)}.json`),
        encodeCanonicalBytes({ ...nextCurrentBase, manifestRoot: nextCurrentRoot } as never),
      );
      const candidateValue = JSON.parse(readFileSync(
        join(
          directory,
          "candidate-generated-search-adapter-v1",
          "manifests",
          `${captured.manifest.manifestRoot.slice(2)}.json`,
        ),
        "utf8",
      )) as Record<string, unknown>;
      const subsetRoot = writeCandidate({ ...candidateValue, currentSourceManifestRoot: nextCurrentRoot });
      const subset = await replayCandidateGeneratedSearchAdapterV1({
        rootDirectory: directory,
        manifestRoot: subsetRoot,
        currentSource,
        request,
      });
      assert.equal(subset.kind, "unsealed");
      if (subset.kind === "unsealed") assert.match(subset.reasonCode, /exact transcript/);

      const wrongBinding = structuredClone(current) as Record<string, unknown>;
      const binding = wrongBinding.canonicalGeneratedBinding as Record<string, unknown>;
      binding.leafDigest = h("wrong-current-source-binding");
      const { manifestRoot: ignoredWrongRoot, canonicalGeneratedBindingRoot: ignoredBindingRoot, ...wrongBindingBase } = wrongBinding;
      void ignoredWrongRoot;
      void ignoredBindingRoot;
      const nextBindingBase = {
        ...wrongBindingBase,
        canonicalGeneratedBinding: binding,
        canonicalGeneratedBindingRoot: hashDomain("aloha/family-current-source-generated-binding/v1", binding),
      };
      const nextBindingRoot = hashDomain("aloha/family-current-source-replay-manifest/v1", nextBindingBase);
      writeFileSync(
        join(directory, "family-current-source-replay-v1", "manifests", `${nextBindingRoot.slice(2)}.json`),
        encodeCanonicalBytes({ ...nextBindingBase, manifestRoot: nextBindingRoot } as never),
      );
      const candidateBindingRoot = writeCandidate({ ...candidateValue, currentSourceManifestRoot: nextBindingRoot });
      await assert.rejects(
        async () => replayCandidateGeneratedSearchAdapterV1({
          rootDirectory: directory,
          manifestRoot: candidateBindingRoot,
          currentSource,
          request,
        }),
        /binding changed|binding mismatch|descriptor key mismatch/,
      );

      const wrongRoute = {
        ...request,
        route: { ...request.route, familyId: "dodo-v2", familyDefinitionHash: h("foreign-family") },
      };
      const zeroRequestHash = hashDomain("aloha/candidate-generated-search-run-request/v1", {
        route: wrongRoute.route,
        source,
        objective,
        amount,
        execution,
      });
      const zeroRoot = writeCandidate({ ...candidateValue, runRequestHash: zeroRequestHash });
      const zero = await replayCandidateGeneratedSearchAdapterV1({
        rootDirectory: directory,
        manifestRoot: zeroRoot,
        currentSource,
        request: wrongRoute,
      });
      assert.equal(zero.kind, "unsealed");
      if (zero.kind === "unsealed") {
        assert.equal(zero.result?.kind, "invalidProgram");
        assert.match(zero.reasonCode, /did not publish verified artifacts/);
      }
    });
  });
});

test("caller cannot inject a factory, Adapter, runner, composition, or read port", async () => {
  await withStore(async (directory) => {
    const base = {
      rootDirectory: directory,
      familyId: UNIV2_STANDARD_FAMILY_ID,
      endpoint: "http://127.0.0.1:1",
      currentSource,
      request,
    };
    for (const key of ["factory", "adapter", "runner", "composition", "readPort"] as const) {
      await assert.rejects(
        async () => captureCandidateGeneratedSearchAdapterV1({ ...base, [key]: {} } as never),
        new RegExp(`unknown field "${key}"`),
      );
    }
  });
});

test("cross-family route executes the candidate Adapter but cannot create a sealed success", async () => {
  await withStore(async (directory) => {
    await withRpc(reserveBytes, async (endpoint, requests) => {
      const crossFamily = {
        ...request,
        route: {
          ...request.route,
          familyId: "dodo-v2",
          familyDefinitionHash: h("foreign-family"),
        },
      };
      const result = await captureCandidateGeneratedSearchAdapterV1({
        rootDirectory: directory,
        familyId: UNIV2_STANDARD_FAMILY_ID,
        endpoint,
        currentSource,
        request: crossFamily,
      });
      assert.equal(result.kind, "unsealed");
      assert.equal(result.result?.kind, "invalidProgram");
      assert.equal(result.candidateGeneratedAdapterExecuted, true);
      assert.equal(result.releaseQualified, false);
      assert.equal(result.productionAcceptance, false);
      assert.equal(requests.length, 0, "cross-family invalidProgram must not manufacture a transport fact");
    });
  });
});

test("strict source binding rejects import/descriptor/assembly and capability/action splices", () => {
  const metadata = readGeneratedFamilyRuntimeFactoryMetadata(createReleaseFamilyRuntimeComposition);
  const sourceText = readFileSync(join(process.cwd(), "../../generated/runtime-composition/index.ts"), "utf8");
  const verify = (source: string, selectedMetadata = metadata) => verifyCandidateGeneratedSourceBindingV1({
    source,
    metadata: selectedMetadata,
    familyId: UNIV2_STANDARD_FAMILY_ID,
  });
  const liveBinding = verify(sourceText);
  const liveFamily = metadata.families.find((family) => family.familyId === UNIV2_STANDARD_FAMILY_ID)!;
  const liveAdapter = liveFamily.runtimeAdapters.find((adapter) => adapter.role === "search/v1")!;
  const foreignFamily = metadata.families.find((family) =>
    family.familyId !== UNIV2_STANDARD_FAMILY_ID
    && family.runtimeAdapters.filter((adapter) => adapter.role === "search/v1").length === 1)!;
  const foreignBinding = verifyCandidateGeneratedSourceBindingV1({
    source: sourceText,
    metadata,
    familyId: foreignFamily.familyId,
  });
  const importLine = (selected: Readonly<{ alias: string; exportName: string; moduleSpecifier: string }>) =>
    `import { ${selected.exportName} as ${selected.alias} } from ${JSON.stringify(selected.moduleSpecifier)};`;
  const adapterImportLine = importLine(liveBinding.adapterImport);
  const foreignAdapterImport = foreignBinding.adapterImport;
  const removedExtensionImport = liveBinding.extensionImports.at(-1)!;
  const removedActionImport = liveBinding.actionOwnerImports.at(-1)!;
  const mutations = [
    sourceText.replace(
      adapterImportLine,
      importLine({ ...liveBinding.adapterImport, moduleSpecifier: foreignAdapterImport.moduleSpecifier }),
    ),
    sourceText.replace(
      `${liveBinding.adapterImport.exportName} as ${liveBinding.adapterImport.alias}`,
      `${foreignAdapterImport.exportName} as ${liveBinding.adapterImport.alias}`,
    ),
    sourceText.replace(
      `exportName: ${JSON.stringify(liveAdapter.exportName)}, closureRoot: ${JSON.stringify(liveAdapter.closureRoot)}`,
      `exportName: "WRONG_EXPORT", closureRoot: "${h("wrong-closure")}"`,
    ),
    sourceText.replace(
      `leafDigest: ${JSON.stringify(liveAdapter.leafDigest)}`,
      `leafDigest: "${h("wrong-leaf")}"`,
    ),
    sourceText.replace(`${importLine(removedExtensionImport)}\n`, ""),
    sourceText.replace(`${importLine(removedActionImport)}\n`, ""),
    sourceText.replace(
      `    FAMILY_RUNTIME_ADAPTERS_${liveBinding.familyOrdinal},`,
      `    FAMILY_RUNTIME_ADAPTERS_${foreignBinding.familyOrdinal},`,
    ),
    `// ${adapterImportLine}\n${sourceText.replace(adapterImportLine, "")}`,
  ];
  for (const mutation of mutations) assert.throws(() => verify(mutation), /generated/);

  const missingCapability = structuredClone(metadata) as GeneratedFamilyRuntimeFactoryMetadataV1;
  const selectedFamily = missingCapability.families.find((family) => family.familyId === UNIV2_STANDARD_FAMILY_ID)!;
  const selectedAdapter = selectedFamily.runtimeAdapters.find((adapter) => adapter.role === "search/v1")!;
  (selectedAdapter as { capabilityRefs: Record<string, unknown> }).capabilityRefs = {
    coarse: selectedAdapter.capabilityRefs.coarse,
    exact: selectedAdapter.capabilityRefs.exact,
  };
  assert.throws(() => verify(sourceText, missingCapability), /capability imports/);

  const missingAction = structuredClone(metadata) as GeneratedFamilyRuntimeFactoryMetadataV1;
  const actionAdapter = missingAction.families.find((family) => family.familyId === UNIV2_STANDARD_FAMILY_ID)!
    .runtimeAdapters.find((adapter) => adapter.role === "search/v1")!;
  (actionAdapter as { actionOwnerRefs: Record<string, unknown> }).actionOwnerRefs = {};
  assert.throws(() => verify(sourceText, missingAction), /action-owner imports/);

  const crossFamily = structuredClone(metadata) as GeneratedFamilyRuntimeFactoryMetadataV1;
  const crossAdapter = crossFamily.families.find((family) => family.familyId === UNIV2_STANDARD_FAMILY_ID)!
    .runtimeAdapters.find((adapter) => adapter.role === "search/v1")!;
  const stateRef = crossAdapter.capabilityRefs.state!;
  (crossAdapter as { capabilityRefs: Record<string, unknown> }).capabilityRefs = {
    ...crossAdapter.capabilityRefs,
    state: { ...stateRef, familyId: foreignFamily.familyId },
  };
  assert.throws(() => verify(sourceText, crossFamily), /cross-family/);

  const duplicateCapability = structuredClone(metadata) as GeneratedFamilyRuntimeFactoryMetadataV1;
  const duplicateAdapter = duplicateCapability.families.find((family) => family.familyId === UNIV2_STANDARD_FAMILY_ID)!
    .runtimeAdapters.find((adapter) => adapter.role === "search/v1")!;
  (duplicateAdapter as { capabilityRefs: Record<string, unknown> }).capabilityRefs = {
    ...duplicateAdapter.capabilityRefs,
    state: duplicateAdapter.capabilityRefs.coarse,
  };
  assert.throws(() => verify(sourceText, duplicateCapability), /capability imports/);
});
