import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  assertDefinedFamilyPlugin,
  defineCreditFamily,
  defineFundingFamily,
  definedFamilyPluginContractSummary,
  RESERVED_FAMILY_DOMAINS,
  type CompiledInstanceDescriptor,
  type CreditFamilyPlugin,
  type FamilyCandidate,
  type FamilyOwnedActionAdapter,
  type FamilyRouteDescriptor,
  type FundingFamilyPlugin,
  type FundingSourceDescriptor,
  type VerifiedIdentity,
} from "../venues/adapter-family-plugin.js";
import {
  familyId,
  instanceKey,
  lineageId,
  routeKey,
  type FamilyId,
  type InstanceKey,
  type LineageId,
} from "../venues/adapter-family-identifiers.js";
import { generateAbsentCapabilityIdentity } from
  "../venues/capability-content-hash.js";
import {
  capabilityManifestHash,
  FAMILY_CAPABILITY_NAMES,
  FamilyCapabilityCatalog,
  type GeneratedCapabilityIdentity,
  type GeneratedCapabilityManifest,
} from "../venues/family-capability-catalog.js";
import { bindFamilyOwnedAction } from
  "../venues/family-owned-action.js";
import { loadProductionFamilyModules } from
  "../venues/production-families/loader.js";

const ADDRESS = `0x${"11".repeat(20)}`;
const TOKEN0 = `0x${"22".repeat(20)}`;
const TOKEN1 = `0x${"33".repeat(20)}`;

assert.deepEqual(
  RESERVED_FAMILY_DOMAINS,
  ["liquidity"],
  "liquidity remains an explicit unimplemented Domain boundary",
);

interface TestFundingSource extends FundingSourceDescriptor {
  readonly fundingId: "fixture:funding";
}

interface TestCandidate extends FamilyCandidate {
  readonly candidateKind: "credit-vault";
  readonly address: string;
}

interface TestIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
}

interface TestDescriptor extends CompiledInstanceDescriptor {
  readonly vault: string;
}

interface TestCreditRoute extends FamilyRouteDescriptor {
  readonly debtToken: string;
}

interface TestRiskEvidence {
  readonly witness: string;
}

function ownedAction(input: {
  readonly id: string;
  readonly edgeKind: "flash" | "credit";
}): FamilyOwnedActionAdapter {
  return bindFamilyOwnedAction({
    action: {
      id: input.id,
      isWrapper: false,
      field2Offset: null,
      encode: () => new Uint8Array(),
      matchTrace: () => false,
    },
    descriptor: {
      adapterId: input.id,
      lineage: input.edgeKind === "flash" ? "balancer-flash" : "fluid-credit",
      edgeKind: input.edgeKind,
      action: input.edgeKind === "flash" ? "flash" : "borrow",
      canSendValue: false,
      leavesStandingPositionDefault: input.edgeKind === "credit",
    },
  });
}

function fundingDefinition(): FundingFamilyPlugin<
  TestFundingSource,
  { readonly balance: bigint }
> {
  const fundingFamilyId = familyId("flash-loan:fixture");
  const fundingLineage = lineageId("funding:fixture");
  return {
    manifest: {
      familyId: fundingFamilyId,
      domain: "funding",
      ownedActionAdapterIds: ["fixture-flash"],
      requiredInfraActionAdapterIds: [],
      allowedTaxonomy: [{ slotKind: "flash" }],
      supportedLineages: [fundingLineage],
    },
    funding: {
      liquidity: {
        sources: (assets) => assets.map((asset) => ({
          fundingId: "fixture:funding",
          instanceKey: `${ADDRESS}:${asset}`,
          provider: ADDRESS,
          stateKey: `${ADDRESS}:${asset}`,
          asset,
          requiredReadKeys: ["balance"],
        })),
        program: {
          requirements: () => ({ transports: ["eth-call"] }),
          buildRequests: ({ sources }) => sources.map((source, index) => ({
            id: `balance-${index}`,
            kind: "eth-call" as const,
            to: source.provider,
            data: "0x70a08231",
            completion: "return-data" as const,
          })),
          decode: () => ({ balance: 1_000_000n }),
        },
        deriveOffers: ({ evidence, sources }) => sources.map((source) => ({
          fundingId: source.fundingId,
          asset: source.asset,
          maxBorrow: evidence.balance,
          fee: 0n,
          actionAdapterId: "fixture-flash",
          planningPriority: 0,
          liquidityPriority: 0,
        })),
      },
      repayment: {
        target: ADDRESS,
        liquidityHolder: ADDRESS,
        mode: "approve-pull",
        paramShape: "none",
        buildBorrowFragment: () => ({ requirements: [], nodes: [] }),
        buildRepaymentFragment: () => ({ requirements: [], nodes: [] }),
      },
    },
    actionAdapters: [ownedAction({ id: "fixture-flash", edgeKind: "flash" })],
  };
}

function creditDefinition(): CreditFamilyPlugin<
  TestCandidate,
  TestIdentity,
  TestDescriptor,
  TestCreditRoute,
  TestRiskEvidence
> {
  const creditFamilyId = familyId("credit:fixture");
  const creditLineage = lineageId("credit:fixture-vault");
  return {
    manifest: {
      familyId: creditFamilyId,
      domain: "credit",
      ownedActionAdapterIds: ["fixture-credit"],
      requiredInfraActionAdapterIds: [],
      allowedTaxonomy: [{ slotKind: "lend" }],
      supportedLineages: [creditLineage],
    },
    discovery: {
      sources: ["address-surface"],
      addressSurfaces: [{
        id: "credit-vault-interface",
        kind: "interface",
        fingerprint: "fixture-credit-vault",
      }],
      decodeCandidate: ({ observation }) => observation.kind === "address-surface"
        ? { candidateKind: "credit-vault", address: observation.address }
        : null,
      candidateKey: (candidate) => candidate.address,
    },
    identity: {
      variants: [{
        id: "active-credit-vault",
        kind: "standalone-contract",
        lineageId: creditLineage,
        applies: () => true,
        requirements: () => ({ transports: ["get-code"] }),
        buildRequests: ({ candidate }) => [{
          id: "credit-code",
          kind: "get-code",
          address: candidate.address,
        }],
        decode: () => ({ witness: "active" }),
        decide: ({ candidate, evidence, step }) => step === 0
          ? { status: "continue" }
          : evidence === undefined
          ? { status: "rejected", reason: "missing-proof" }
          : {
              status: "verified",
              identity: {
                familyId: creditFamilyId,
                lineageId: creditLineage,
                subject: candidate.address,
                provenance: [{
                  kind: "active-credit-proof",
                  subject: candidate.address,
                }],
              },
            },
      }],
      identityKey: (identity) => identity.subject,
    },
    instance: {
      instanceKey: (identity): InstanceKey => instanceKey(identity.subject),
      compileDraft: (identity) => ({
        familyId: creditFamilyId,
        lineageId: creditLineage,
        instanceKey: instanceKey(identity.subject),
        provenance: identity.provenance,
        runtimeRequirements: [],
        vault: identity.subject,
      }),
      finalizeDescriptor: ({ draft }) => draft,
      staticBindingProjection: (descriptor) => ({ vault: descriptor.vault }),
    },
    routes: {
      project: ({ descriptor }) => [{
        routeKey: routeKey(`${descriptor.vault}:borrow`),
        familyId: descriptor.familyId,
        lineageId: descriptor.lineageId,
        instanceKey: descriptor.instanceKey,
        tokenIn: TOKEN0,
        tokenOut: TOKEN1,
        taxonomy: { slotKind: "lend" },
        bindingRef: {
          bindingKey: descriptor.vault,
          fingerprint: "credit-binding-v1",
        },
        runtimeRequirements: [],
        debtToken: TOKEN1,
      }],
      projectGraph: ({ descriptor, route }) => ({
        routeActionAdapterId: "fixture-credit",
        executionTarget: descriptor.vault,
        venueIdentity: { vault: descriptor.vault.toLowerCase() },
        centralScoreKey: route.routeKey,
      }),
    },
    execution: {
      runtimeProjection: () => ({
        allowanceSpender: null,
        prewarmQuoteCalls: [],
      }),
      buildFragment: () => ({ requirements: [], nodes: [] }),
      expectedEffects: () => [],
    },
    credit: {
      activeBehaviorProof: "required",
      position: {
        lifecycle: "standing-position",
        finalSafety: "position-and-repayment-required",
        positionKey: ({ descriptor }) => descriptor.vault,
      },
      risk: {
        debtBpsCandidates: [8_500n, 9_500n, 10_000n],
        blocksPrefixInversion: true,
        quoteOutputByDebtBps: ({ collateralAmount, debtBps }) =>
          collateralAmount * debtBps / 10_000n,
      },
    },
    actionAdapters: [ownedAction({ id: "fixture-credit", edgeKind: "credit" })],
  };
}

if (false) {
  const funding = fundingDefinition();
  const credit = creditDefinition();
  // @ts-expect-error Funding cannot be coerced into the Credit constructor.
  defineCreditFamily(funding);
  // @ts-expect-error Credit cannot be coerced into the Funding constructor.
  defineFundingFamily(credit);
  // @ts-expect-error Funding cannot expose Protocol semantics.
  defineFundingFamily({ ...funding, protocol: {} });
  // @ts-expect-error Credit cannot expose Funding semantics.
  defineCreditFamily({ ...credit, funding: funding.funding });
}

const rawFunding = fundingDefinition();
assert.throws(
  () => assertDefinedFamilyPlugin(rawFunding),
  /defineFundingFamily/,
);
const funding = defineFundingFamily(rawFunding);
assertDefinedFamilyPlugin(funding);
assert.equal(definedFamilyPluginContractSummary(funding).domain, "funding");
assert.equal(funding.actionAdapters[0]?.descriptor.edgeKind, "flash");
assert(!("pricing" in funding), "Funding must not fake route pricing");
assert(!("exact" in funding), "Funding must not fake route exact quote");

const rawCredit = creditDefinition();
const credit = defineCreditFamily(rawCredit);
assertDefinedFamilyPlugin(credit);
assert.equal(definedFamilyPluginContractSummary(credit).domain, "credit");
assert.equal(credit.actionAdapters[0]?.descriptor.edgeKind, "credit");
assert(!("pricing" in credit), "Credit risk sizing is not route pricing");
assert(!("exact" in credit), "Credit risk evidence is not a fake exact quote");

assert.throws(
  () => assertDefinedFamilyPlugin({ ...funding }),
  /defineFundingFamily/,
  "spreading a Funding plugin must not copy its runtime brand",
);
assert.throws(
  () => defineFundingFamily({
    ...fundingDefinition(),
    funding: {},
  } as never),
  /funding domain semantics.*missing required field liquidity/,
);
assert.throws(
  () => defineCreditFamily({
    ...creditDefinition(),
    credit: {
      activeBehaviorProof: "required",
      position: {},
      risk: {},
    },
  } as never),
  /credit\.position.*missing required field/,
);

const wrongFundingAction = fundingDefinition();
(wrongFundingAction as unknown as {
  actionAdapters: readonly FamilyOwnedActionAdapter[];
}).actionAdapters = [ownedAction({ id: "fixture-flash", edgeKind: "credit" })];
assert.throws(
  () => defineFundingFamily(wrongFundingAction),
  /descriptor edgeKind must be flash/,
);

const wrongCreditAction = creditDefinition();
(wrongCreditAction as unknown as {
  actionAdapters: readonly FamilyOwnedActionAdapter[];
}).actionAdapters = [ownedAction({ id: "fixture-credit", edgeKind: "flash" })];
assert.throws(
  () => defineCreditFamily(wrongCreditAction),
  /descriptor edgeKind must be credit/,
);

const zeroProofCredit = creditDefinition();
(zeroProofCredit.identity.variants[0] as unknown as {
  requirements: () => { readonly transports: readonly [] };
}).requirements = () => ({ transports: [] });
const guardedZeroProofCredit = defineCreditFamily(zeroProofCredit);
assert.throws(
  () => guardedZeroProofCredit.identity.variants[0]?.requirements({
    candidate: { candidateKind: "credit-vault", address: ADDRESS },
    step: 0,
  }),
  /active behavior proof requires a transport/,
);

const manifest = manifestFor([funding, credit]);
const catalog = new FamilyCapabilityCatalog({
  modules: [moduleFor(funding, "funding.production.ts"), moduleFor(
    credit,
    "credit.production.ts",
  )],
  generatedManifest: manifest,
});
assert.deepEqual(
  catalog.listAll().map((family) => family.plugin.manifest.domain).sort(),
  ["credit", "funding"],
);
assert.equal(catalog.ownerOfAction("fixture-flash"), "flash-loan:fixture");
assert.equal(catalog.ownerOfAction("fixture-credit"), "credit:fixture");
assert.match(catalog.catalogHash, /^[0-9a-f]{64}$/);
assert.match(
  catalog.forStrictFamily(familyId("flash-loan:fixture")).hashes.funding
    .contentHash,
  /^[0-9a-f]{64}$/,
);
assert.deepEqual(
  catalog.forStrictFamily(familyId("flash-loan:fixture"))
    .applicableCapabilities,
  ["funding"],
);
assert.deepEqual(
  catalog.forStrictFamily(familyId("credit:fixture")).applicableCapabilities,
  ["discovery", "identity", "instance", "routes", "execution", "credit"],
);
assert.throws(
  () => catalog.forFamily(familyId("flash-loan:fixture")),
  /not a route Family/,
);

const loaderRoot = await mkdtemp(resolve(tmpdir(), "strict-domain-loader-"));
try {
  await Promise.all([
    writeFile(resolve(loaderRoot, "funding.production.ts"), ""),
    writeFile(resolve(loaderRoot, "credit.production.ts"), ""),
  ]);
  const loaded = await loadProductionFamilyModules([], {
    sourceDirectory: loaderRoot,
    importEntry: async (sourceFile) => ({
      plugin: sourceFile.startsWith("funding") ? funding : credit,
    }),
  });
  assert.deepEqual(loaded.issues, []);
  assert.deepEqual(
    loaded.plugins.map((item) => item.familyId),
    ["credit:fixture", "flash-loan:fixture"],
    "automatic loader must recognize both strict non-route Domain brands",
  );
} finally {
  await rm(loaderRoot, { recursive: true, force: true });
}

console.log(
  "funding-credit-family-plugin PASS " +
    "(strict domains + repayment/risk + declared absence + loader/catalog)",
);

function manifestFor(
  plugins: readonly [typeof funding, typeof credit],
): GeneratedCapabilityManifest {
  const realByDomain = {
    funding: new Set(["funding"]),
    credit: new Set([
      "credit",
      "discovery",
      "execution",
      "identity",
      "instance",
      "routes",
    ]),
  } as const;
  const entries: GeneratedCapabilityIdentity[] = plugins.flatMap((plugin) =>
    FAMILY_CAPABILITY_NAMES.map((capability) => {
      const domain = plugin.manifest.domain;
      if (!realByDomain[domain].has(capability)) {
        return generateAbsentCapabilityIdentity({
          familyId: plugin.manifest.familyId,
          capability,
          provenanceCommit: null,
        });
      }
      return {
        familyId: plugin.manifest.familyId,
        capability,
        contractVersion: `fixture-${capability}-v1`,
        contentHash: createHash("sha256")
          .update(`${plugin.manifest.familyId}/${capability}`)
          .digest("hex"),
        semanticDependencies: [`fixture:${capability}`],
        provenanceCommit: null,
      };
    })
  );
  return {
    format: "adapter-family-capabilities-v1",
    entries,
    manifestHash: capabilityManifestHash(entries),
  };
}

function moduleFor(
  plugin: typeof funding | typeof credit,
  sourceFile: string,
) {
  return {
    sourceFile,
    definitionBoundaryHash:
      definedFamilyPluginContractSummary(plugin).definitionBoundaryHash,
    plugin,
  };
}
