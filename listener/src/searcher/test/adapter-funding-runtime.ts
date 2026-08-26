import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ethers } from "ethers";
import {
  buildFundingBorrowFragment,
  buildFundingRepaymentFragment,
  executeFundingFamilyLiquidity,
  type FundingFamilyPublication,
  type PreparedFundingOffer,
} from "../adapter-funding-runtime.js";
import type {
  CentralAdapterRuntime,
  CentralAdapterScheduler,
} from "../adapter-work-intent.js";
import {
  createBoundedRequestExecutor,
  type AdapterRequest,
  type CanonicalSource,
} from "../venues/adapter-request-program.js";
import {
  capabilityManifestHash,
  FAMILY_CAPABILITY_NAMES,
  FamilyCapabilityCatalog,
  type GeneratedCapabilityIdentity,
  type LoadedFamilyBox,
} from "../venues/family-capability-catalog.js";
import {
  defineFundingFamily,
  definedFamilyPluginContractSummary,
  type AnyDefinedStrictFamilyPlugin,
  type FundingOfferDescriptor,
} from "../venues/adapter-family-plugin.js";
import { balancerFlashPlugin } from
  "../venues/funding/balancer-flash-family-plugin.js";
import {
  morphoFlashFamilyOwnedAction,
  morphoFlashDiscovery,
  morphoFlashFunding,
  morphoFlashManifest,
  morphoFlashPlugin,
} from
  "../venues/funding/morpho-flash-family-plugin.js";
import type { PlanFragment } from "../venues/route-leg-adapter.js";

const TOKEN_A = ethers.getAddress(`0x${"31".repeat(20)}`);
const TOKEN_B = ethers.getAddress(`0x${"32".repeat(20)}`);
const SOURCE = Object.freeze({
  number: 25_700_333,
  hash: `0x${"51".repeat(32)}`,
  generation: 29,
});
const ERC20 = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
]);

await siblingFailureDoesNotSuppressHealthyOffer();
await successfulEmptyGenerationPublishesTombstone();
await failedEmptyGenerationPreservesCurrentPublication();
await omittedRequestedAssetFailsClosed();
await publicationFailureCannotLeakPreparedOffers();
await centralPlanBoundaryAcceptsOnlyOwnedBorrowAndDeclaredRepayment();
await preparedOfferAuthorityRejectsEveryStructuralEscape();
await issuerSnapshotsFamilyInputsAndOnlyUnsealsPrivateOffer();

console.log(
  "adapter Funding runtime PASS " +
    "(central work, source isolation, opaque issuer handles, TOCTOU, plan ownership)",
);

async function siblingFailureDoesNotSuppressHealthyOffer(): Promise<void> {
  const family = loadedFunding(morphoFlashPlugin);
  const harness = runtimeHarness({
    balances: new Map([[TOKEN_B.toLowerCase(), 2_000n]]),
    failedAssets: new Set([TOKEN_A.toLowerCase()]),
  });
  const publications: FundingFamilyPublication[] = [];
  const result = await executeFundingFamilyLiquidity({
    family,
    assets: [TOKEN_B, TOKEN_A],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: harness.runtime,
    publisher: {
      publish(publication) {
        publications.push(publication);
      },
    },
  });

  assert.equal(harness.issues.length, 2);
  assert(harness.issues.every((issue) => issue.schedule.lane === "background"));
  assert(harness.issues.every((issue) => issue.subject.instanceKey !== undefined));
  assert.equal(
    new Set(harness.issues.map((issue) => issue.subject.instanceKey)).size,
    2,
    "each Funding source must have an independent central work subject",
  );
  assert.equal(result.outcomes.length, 2);
  assert.equal(result.outcomes[0]?.asset, TOKEN_A);
  assert.equal(result.outcomes[0]?.status, "unresolved");
  assert.match(result.outcomes[0]?.reasonCode ?? "", /adapter-work:transport:rpc/);
  assert.equal(result.outcomes[1]?.asset, TOKEN_B);
  assert.equal(result.outcomes[1]?.status, "verified");
  assert.deepEqual(result.offers.map((offer) => offer.asset), [TOKEN_B]);
  assert.equal(result.offers[0]?.maxBorrow, 2_000n);
  assert.equal(publications.length, 1);
  assert.strictEqual(result.publication, publications[0]);
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.offers[0]!));
  assert(Object.isFrozen(result.publication!));
}

async function publicationFailureCannotLeakPreparedOffers(): Promise<void> {
  const family = loadedFunding(balancerFlashPlugin);
  const harness = runtimeHarness({
    balances: new Map([[TOKEN_A.toLowerCase(), 3_000n]]),
  });
  const result = await executeFundingFamilyLiquidity({
    family,
    assets: [TOKEN_A],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: harness.runtime,
    publisher: {
      publish() {
        throw new Error("synthetic publication CAS rejection");
      },
    },
  });

  assert.equal(result.publication, null);
  assert.deepEqual(result.offers, []);
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0]?.status, "unresolved");
  assert.match(
    result.outcomes[0]?.reasonCode ?? "",
    /funding-publication:synthetic publication CAS rejection/,
  );
}

async function successfulEmptyGenerationPublishesTombstone(): Promise<void> {
  const emptyPlugin = defineFundingFamily({
    manifest: morphoFlashManifest,
    discovery: morphoFlashDiscovery,
    funding: {
      liquidity: {
        sources: (assets) => morphoFlashFunding.liquidity.sources(assets),
        program: {
          requirements: (input) =>
            morphoFlashFunding.liquidity.program.requirements(input),
          buildRequests: (input) =>
            morphoFlashFunding.liquidity.program.buildRequests(input),
          decode: (input) =>
            morphoFlashFunding.liquidity.program.decode(input),
        },
        deriveOffers: () => [],
      },
      repayment: {
        target: morphoFlashFunding.repayment.target,
        liquidityHolder: morphoFlashFunding.repayment.liquidityHolder,
        mode: morphoFlashFunding.repayment.mode,
        paramShape: morphoFlashFunding.repayment.paramShape,
        buildBorrowFragment: (input) =>
          morphoFlashFunding.repayment.buildBorrowFragment(input),
        buildRepaymentFragment: (input) =>
          morphoFlashFunding.repayment.buildRepaymentFragment(input),
      },
    },
    actionAdapters: [morphoFlashFamilyOwnedAction],
  });
  const family = loadedFunding(emptyPlugin);
  const harness = runtimeHarness({
    balances: new Map([[TOKEN_A.toLowerCase(), 0n]]),
  });
  const publications: FundingFamilyPublication[] = [];
  const result = await executeFundingFamilyLiquidity({
    family,
    assets: [TOKEN_A],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: harness.runtime,
    publisher: {
      publish(publication) {
        publications.push(publication);
      },
    },
  });

  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0]?.status, "verified");
  assert.deepEqual(result.offers, []);
  assert.equal(publications.length, 1);
  assert.strictEqual(result.publication, publications[0]);
  assert.deepEqual(publications[0]?.offers, []);
  assert.equal(publications[0]?.source.hash, SOURCE.hash);
  assert.equal(publications[0]?.generation, SOURCE.generation);
}

async function failedEmptyGenerationPreservesCurrentPublication(): Promise<void> {
  const family = loadedFunding(morphoFlashPlugin);
  const harness = runtimeHarness({
    balances: new Map(),
    failedAssets: new Set([TOKEN_A.toLowerCase()]),
  });
  const current = Object.freeze({ publication: "prior" });
  let observedCurrent: unknown = current;
  let publishCalls = 0;
  const result = await executeFundingFamilyLiquidity({
    family,
    assets: [TOKEN_A],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: harness.runtime,
    publisher: {
      publish(publication) {
        publishCalls++;
        observedCurrent = publication;
      },
    },
  });

  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0]?.status, "unresolved");
  assert.deepEqual(result.offers, []);
  assert.equal(result.publication, null);
  assert.equal(publishCalls, 0);
  assert.strictEqual(observedCurrent, current);
}

async function omittedRequestedAssetFailsClosed(): Promise<void> {
  const incompletePlugin = defineFundingFamily({
    manifest: morphoFlashManifest,
    discovery: morphoFlashDiscovery,
    funding: {
      liquidity: {
        sources: (assets) =>
          morphoFlashFunding.liquidity.sources(assets.slice(0, 1)),
        program: {
          requirements: (input) =>
            morphoFlashFunding.liquidity.program.requirements(input),
          buildRequests: (input) =>
            morphoFlashFunding.liquidity.program.buildRequests(input),
          decode: (input) =>
            morphoFlashFunding.liquidity.program.decode(input),
        },
        deriveOffers: (input) =>
          morphoFlashFunding.liquidity.deriveOffers(input),
      },
      repayment: {
        target: morphoFlashFunding.repayment.target,
        liquidityHolder: morphoFlashFunding.repayment.liquidityHolder,
        mode: morphoFlashFunding.repayment.mode,
        paramShape: morphoFlashFunding.repayment.paramShape,
        buildBorrowFragment: (input) =>
          morphoFlashFunding.repayment.buildBorrowFragment(input),
        buildRepaymentFragment: (input) =>
          morphoFlashFunding.repayment.buildRepaymentFragment(input),
      },
    },
    actionAdapters: [morphoFlashFamilyOwnedAction],
  });
  const result = await executeFundingFamilyLiquidity({
    family: loadedFunding(incompletePlugin),
    assets: [TOKEN_A, TOKEN_B],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: runtimeHarness({ balances: new Map() }).runtime,
    publisher: { publish() {} },
  });
  assert.deepEqual(result.offers, []);
  assert.equal(result.publication, null);
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0]?.status, "failed");
  assert.match(
    result.outcomes[0]?.reasonCode ?? "",
    /Funding sources omitted a requested asset/,
  );
}

async function centralPlanBoundaryAcceptsOnlyOwnedBorrowAndDeclaredRepayment(): Promise<void> {
  for (const [family, repaymentRoot] of [
    [loadedFunding(morphoFlashPlugin), "erc20-approve"],
    [loadedFunding(balancerFlashPlugin), "erc20-transfer"],
  ] as const) {
    const harness = runtimeHarness({
      balances: new Map([[TOKEN_A.toLowerCase(), 5_000n]]),
    });
    const result = await executeFundingFamilyLiquidity({
      family,
      assets: [TOKEN_A],
      source: SOURCE,
      generation: SOURCE.generation,
      runtime: harness.runtime,
      publisher: { publish() {} },
    });
    const offer = result.offers[0];
    assert(offer !== undefined);

    const borrow = buildFundingBorrowFragment({
      family,
      offer,
      source: SOURCE,
      generation: SOURCE.generation,
      amount: 1_000n,
      minProfit: 7n,
      children: [],
    });
    assert.equal(
      borrow.nodes[0]?.adapterId,
      family.plugin.manifest.ownedActionAdapterIds[0],
    );

    const repayment = buildFundingRepaymentFragment({
      family,
      offer,
      source: SOURCE,
      generation: SOURCE.generation,
      amount: 1_000n,
    });
    assert.equal(repayment.nodes[0]?.adapterId, repaymentRoot);
    assert(
      family.plugin.manifest.requiredInfraActionAdapterIds.includes(
        repaymentRoot,
      ),
    );

    const forged = Object.freeze({
      ...offer,
      capabilityHash: "stale-funding-capability",
    }) as PreparedFundingOffer;
    assert.throws(
      () => buildFundingBorrowFragment({
        family,
        offer: forged,
        source: SOURCE,
        generation: SOURCE.generation,
        amount: 1n,
        minProfit: 0n,
        children: [],
      }),
      /must be issued by the central runtime/,
    );
  }
}

async function preparedOfferAuthorityRejectsEveryStructuralEscape(): Promise<void> {
  const family = loadedFunding(morphoFlashPlugin);
  const harness = runtimeHarness({
    balances: new Map([[TOKEN_A.toLowerCase(), 5_000n]]),
  });
  const result = await executeFundingFamilyLiquidity({
    family,
    assets: [TOKEN_A],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: harness.runtime,
    publisher: { publish() {} },
  });
  const offer = result.offers[0];
  assert(offer !== undefined);

  const build = (
    selectedFamily: LoadedFamilyBox,
    selectedOffer: PreparedFundingOffer,
    source: CanonicalSource = SOURCE,
    generation: number = SOURCE.generation,
  ) => buildFundingRepaymentFragment({
    family: selectedFamily,
    offer: selectedOffer,
    source,
    generation,
    amount: 1n,
  });

  for (const forged of [
    Object.freeze({ ...offer }),
    Object.freeze({ ...offer, capabilityHash: "0".repeat(64) }),
    Object.freeze({ ...offer, maxBorrow: offer.maxBorrow + 1n }),
  ]) {
    assert.throws(
      () => build(family, forged as PreparedFundingOffer),
      /must be issued by the central runtime/,
      "spread/clone and forged metadata must not recreate issuer authority",
    );
  }

  const sameHashStructuralFake = Object.freeze({ ...family }) as LoadedFamilyBox;
  assert.equal(
    sameHashStructuralFake.hashes.funding.contentHash,
    family.hashes.funding.contentHash,
  );
  assert.throws(
    () => build(sameHashStructuralFake, offer),
    /must be issued by the central catalog/,
    "matching structural hashes cannot forge a catalog Family box",
  );

  const foreignFamily = loadedFunding(balancerFlashPlugin);
  assert.throws(
    () => build(foreignFamily, offer),
    /escaped its catalog Family box/,
  );

  const hotReloadedFamily = loadedFunding(morphoFlashPlugin);
  assert.strictEqual(hotReloadedFamily.plugin, family.plugin);
  assert.equal(
    hotReloadedFamily.hashes.funding.contentHash,
    family.hashes.funding.contentHash,
  );
  assert.notStrictEqual(hotReloadedFamily, family);
  assert.throws(
    () => build(hotReloadedFamily, offer),
    /escaped its catalog Family box/,
    "a new catalog box for the same plugin/hash is a new authority epoch",
  );

  const wrongSource = Object.freeze({
    ...SOURCE,
    hash: `0x${"52".repeat(32)}`,
  });
  assert.throws(
    () => build(family, offer, wrongSource),
    /escaped its current source\/generation/,
  );
  const nextGenerationSource = Object.freeze({
    ...SOURCE,
    generation: SOURCE.generation + 1,
  });
  assert.throws(
    () => build(
      family,
      offer,
      nextGenerationSource,
      nextGenerationSource.generation,
    ),
    /escaped its current source\/generation/,
  );

  assert.doesNotThrow(() => build(family, offer));
}

async function issuerSnapshotsFamilyInputsAndOnlyUnsealsPrivateOffer():
  Promise<void> {
  let returnedSource: Record<string, unknown> | undefined;
  let decodedEvidence: {
    balances: Array<{ fundingId: string; maxBorrow: bigint }>;
  } | undefined;
  let deriveEvidence: unknown;
  let deriveSource: unknown;
  let returnedOffer: FundingOfferDescriptor | undefined;
  let borrowOffer: FundingOfferDescriptor | undefined;
  let repaymentOffer: FundingOfferDescriptor | undefined;
  let borrowChildren: readonly PlanFragment[] | undefined;
  let borrowCalls = 0;

  const hardenedFixture = defineFundingFamily({
    manifest: morphoFlashManifest,
    discovery: morphoFlashDiscovery,
    funding: {
      liquidity: {
        sources(assets: readonly string[]) {
          const sources = morphoFlashFunding.liquidity.sources(assets).map(
            (source) => ({
              ...source,
              requiredReadKeys: [...source.requiredReadKeys],
            }),
          );
          returnedSource = sources[0] as unknown as Record<string, unknown>;
          return sources;
        },
        program: {
          requirements: morphoFlashFunding.liquidity.program.requirements,
          buildRequests: morphoFlashFunding.liquidity.program.buildRequests,
          decode(input: Parameters<
            typeof morphoFlashFunding.liquidity.program.decode
          >[0]) {
            const evidence = morphoFlashFunding.liquidity.program.decode(input);
            decodedEvidence = {
              balances: evidence.balances.map((balance) => ({ ...balance })),
            };
            return decodedEvidence;
          },
        },
        deriveOffers(input: Parameters<
          typeof morphoFlashFunding.liquidity.deriveOffers
        >[0]) {
          deriveEvidence = input.evidence;
          deriveSource = input.sources[0];
          const derived = morphoFlashFunding.liquidity.deriveOffers(input);
          returnedOffer = { ...derived[0]! };
          return [returnedOffer];
        },
      },
      repayment: {
        target: morphoFlashFunding.repayment.target,
        liquidityHolder: morphoFlashFunding.repayment.liquidityHolder,
        mode: morphoFlashFunding.repayment.mode,
        paramShape: morphoFlashFunding.repayment.paramShape,
        buildBorrowFragment(input: Parameters<
          typeof morphoFlashFunding.repayment.buildBorrowFragment
        >[0]) {
          borrowCalls++;
          borrowOffer = input.offer;
          borrowChildren = input.children;
          return morphoFlashFunding.repayment.buildBorrowFragment(input);
        },
        buildRepaymentFragment(input: Parameters<
          typeof morphoFlashFunding.repayment.buildRepaymentFragment
        >[0]) {
          repaymentOffer = input.offer;
          return morphoFlashFunding.repayment.buildRepaymentFragment(input);
        },
      },
    },
    actionAdapters: [morphoFlashFamilyOwnedAction],
  });
  const family = loadedFunding(hardenedFixture);
  const harness = runtimeHarness({
    balances: new Map([[TOKEN_A.toLowerCase(), 5_000n]]),
  });
  const result = await executeFundingFamilyLiquidity({
    family,
    assets: [TOKEN_A],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: harness.runtime,
    publisher: { publish() {} },
  });
  const handle = result.offers[0];
  assert(handle !== undefined);
  assert(returnedSource !== undefined);
  assert(decodedEvidence !== undefined);
  assert(returnedOffer !== undefined);
  assert.notStrictEqual(deriveSource, returnedSource);
  assert(Object.isFrozen(deriveSource));
  assert.notStrictEqual(deriveEvidence, decodedEvidence);
  assert(Object.isFrozen(deriveEvidence));
  assert(
    typeof deriveEvidence === "object" && deriveEvidence !== null &&
      Object.isFrozen((deriveEvidence as { balances: unknown }).balances),
  );
  assert.notStrictEqual(handle, returnedOffer);

  (returnedSource as { asset: string }).asset = TOKEN_B;
  decodedEvidence.balances[0]!.maxBorrow = 1n;
  (returnedOffer as { maxBorrow: bigint }).maxBorrow = 1n;
  (returnedOffer as { asset: string }).asset = TOKEN_B;

  const mutableChild = {
    requirements: [] as string[],
    nodes: [],
  } as unknown as PlanFragment;
  const borrow = buildFundingBorrowFragment({
    family,
    offer: handle,
    source: SOURCE,
    generation: SOURCE.generation,
    amount: 1_000n,
    minProfit: 7n,
    children: [mutableChild],
  });
  assert.equal(borrow.nodes[0]?.tokenIn, TOKEN_A);
  assert.equal(borrowOffer?.maxBorrow, 5_000n);
  assert.equal(borrowOffer?.asset, TOKEN_A);
  assert.notStrictEqual(borrowOffer, handle);
  assert.notStrictEqual(borrowOffer, returnedOffer);
  assert(Object.isFrozen(borrowOffer));
  assert.notStrictEqual(borrowChildren?.[0], mutableChild);
  assert(Object.isFrozen(borrowChildren));
  assert(Object.isFrozen(borrowChildren?.[0]));

  buildFundingRepaymentFragment({
    family,
    offer: handle,
    source: SOURCE,
    generation: SOURCE.generation,
    amount: 1_000n,
  });
  assert.strictEqual(repaymentOffer, borrowOffer);

  const callsBeforeReject = borrowCalls;
  assert.throws(
    () => buildFundingBorrowFragment({
      family,
      offer: Object.freeze({ ...handle }) as PreparedFundingOffer,
      source: SOURCE,
      generation: SOURCE.generation,
      amount: 1n,
      minProfit: 0n,
      children: [],
    }),
    /must be issued by the central runtime/,
  );
  assert.equal(
    borrowCalls,
    callsBeforeReject,
    "issuer rejection must happen before the Family callback",
  );
}

function loadedFunding(plugin: AnyDefinedStrictFamilyPlugin):
  LoadedFamilyBox {
  const entries: GeneratedCapabilityIdentity[] = FAMILY_CAPABILITY_NAMES.map(
    (capability) => ({
      familyId: plugin.manifest.familyId,
      capability,
      contractVersion: "adapter-family-test-v2",
      contentHash: createHash("sha256")
        .update(`${plugin.manifest.familyId}/${capability}`)
        .digest("hex"),
      semanticDependencies: [`contract:${capability}`],
      provenanceCommit: "a".repeat(40),
    }),
  );
  const catalog = new FamilyCapabilityCatalog({
    modules: [{
      sourceFile: `fixture/${plugin.manifest.familyId}.production.ts`,
      definitionBoundaryHash:
        definedFamilyPluginContractSummary(plugin).definitionBoundaryHash,
      plugin,
    }],
    generatedManifest: {
      format: "adapter-family-capabilities-v1",
      entries,
      manifestHash: capabilityManifestHash(entries),
    },
  });
  return catalog.forStrictFamily(plugin.manifest.familyId);
}

function runtimeHarness(input: {
  readonly balances: ReadonlyMap<string, bigint>;
  readonly failedAssets?: ReadonlySet<string>;
}): {
  readonly runtime: CentralAdapterRuntime;
  readonly issues: Array<Parameters<CentralAdapterScheduler["issueExecutor"]>[0]>;
} {
  const issues: Array<Parameters<CentralAdapterScheduler["issueExecutor"]>[0]> = [];
  let now = 1_000;
  const scheduler: CentralAdapterScheduler = {
    issueExecutor(issue) {
      issues.push(issue);
      return Object.freeze({
        executor: createBoundedRequestExecutor({
          assertSupported(requirements) {
            assert.deepEqual(requirements, issue.requirements);
          },
          assertCallerBinding() {},
          assertWithinBudget(familyId, requests) {
            assert.equal(familyId, issue.subject.familyId);
            assert.deepEqual(requests, issue.requests);
          },
          execute: async ({ requests, source }) => requests.map((request) =>
            fundingResult(request, source, input)
          ),
          sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
        }),
        timing: () => Object.freeze({
          queueWaitMs: 1,
          transportWallMs: 2,
          attempts: 1,
        }),
      });
    },
  };
  const runtime: CentralAdapterRuntime = {
    clock: { nowMs: () => now++ },
    generationFence: {
      assertCurrent(generation, source) {
        assert.equal(generation, SOURCE.generation);
        assert.equal(source.hash.toLowerCase(), SOURCE.hash.toLowerCase());
      },
    },
    callerAuthority: { bind: () => Object.freeze({}) },
    policy: {
      bind(policyInput) {
        assert.equal(policyInput.stage, "pricing-current");
        return Object.freeze({
          lane: "background" as const,
          deadlineAtMs: 10_000,
          maxAttempts: 1,
          transportPool: "state-read" as const,
          fairnessKey: policyInput.subjectKey,
        });
      },
    },
    budgets: { assertAdmitted() {} },
    scheduler,
  };
  return { runtime, issues };
}

function fundingResult(
  request: AdapterRequest,
  source: CanonicalSource,
  input: {
    readonly balances: ReadonlyMap<string, bigint>;
    readonly failedAssets?: ReadonlySet<string>;
  },
) {
  assert.equal(request.kind, "eth-call");
  if (request.kind !== "eth-call") throw new Error("unexpected Funding request");
  const asset = ethers.getAddress(request.to);
  if (input.failedAssets?.has(asset.toLowerCase())) {
    return Object.freeze({
      id: request.id,
      ok: false as const,
      source,
      failure: "rpc" as const,
    });
  }
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source,
    provenance: Object.freeze({
      kind: "funding-runtime-fixture",
      fingerprint: `funding:${asset.toLowerCase()}`,
    }),
    completion: "returned" as const,
    data: ERC20.encodeFunctionResult("balanceOf", [
      input.balances.get(asset.toLowerCase()) ?? 0n,
    ]),
  });
}
