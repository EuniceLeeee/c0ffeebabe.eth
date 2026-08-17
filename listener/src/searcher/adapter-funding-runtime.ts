import { ethers } from "ethers";
import {
  executeAdapterWork,
  type AdapterWorkControl,
  type AdapterWorkReceipt,
  type CentralAdapterRuntime,
} from "./adapter-work-intent.js";
import {
  instanceKey,
  type FamilyId,
} from "./venues/adapter-family-identifiers.js";
import {
  assertDefinedFamilyPlugin,
  type FundingFamilyPlugin,
  type FundingOfferDescriptor,
  type FundingSourceDescriptor,
} from "./venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import {
  assertIssuedLoadedFamilyBox,
  type LoadedFamilyBox,
} from "./venues/family-capability-catalog.js";
import type { PlanFragment } from "./venues/route-leg-adapter.js";

declare const preparedFundingOfferTypeBrand: unique symbol;

/**
 * Opaque, process-local authority for one Funding offer issued from one
 * catalog Family box and one source generation. The public fields are only a
 * planner projection; the raw Family descriptor/evidence remain private.
 */
export interface PreparedFundingOffer {
  readonly [preparedFundingOfferTypeBrand]: "prepared-funding-offer";
  readonly familyId: FamilyId;
  readonly fundingId: string;
  readonly asset: string;
  readonly maxBorrow: bigint;
  readonly fee: bigint;
  readonly actionAdapterId: string;
  readonly planningPriority: number;
  readonly liquidityPriority: number;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly capabilityHash: string;
  readonly evidenceRefs: readonly string[];
}

interface PreparedFundingOfferRecord {
  readonly family: LoadedFamilyBox;
  readonly offer: FundingOfferDescriptor;
  readonly deriveEvidence: unknown;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly capabilityHash: string;
  readonly evidenceRefs: readonly string[];
}

const issuedPreparedFundingOffers = new WeakMap<
  object,
  PreparedFundingOfferRecord
>();

export interface FundingInstanceOutcome {
  readonly familyId: FamilyId;
  readonly fundingId: string;
  readonly instanceKey: string;
  readonly stateKey: string;
  readonly asset: string;
  readonly status: "verified" | "unresolved" | "failed";
  readonly reasonCode: string;
  readonly source: CanonicalSource;
  readonly workReceipt: AdapterWorkReceipt | null;
  readonly evidenceRefs: readonly string[];
}

export interface FundingFamilyPublication {
  readonly familyId: FamilyId;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly offers: readonly PreparedFundingOffer[];
  readonly outcomes: readonly FundingInstanceOutcome[];
}

export interface FundingFamilyPublicationSink {
  publish(publication: FundingFamilyPublication): void;
}

export interface FundingFamilyRuntimeResult {
  readonly familyId: FamilyId;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly offers: readonly PreparedFundingOffer[];
  readonly outcomes: readonly FundingInstanceOutcome[];
  readonly publication: FundingFamilyPublication | null;
}

/**
 * Executes Funding liquidity per source so one token/provider read cannot
 * suppress healthy sibling offers. The Family only declares its Request
 * Program and derives offers; all I/O and generation fences are central.
 */
export async function executeFundingFamilyLiquidity(input: {
  readonly family: LoadedFamilyBox;
  readonly assets: readonly string[];
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly runtime: CentralAdapterRuntime;
  readonly control?: AdapterWorkControl;
  readonly publisher: FundingFamilyPublicationSink;
}): Promise<FundingFamilyRuntimeResult> {
  const family = input.family;
  assertIssuedLoadedFamilyBox(family);
  const source = snapshotCanonicalSource(input.source);
  const generation = input.generation;
  assertSource(source, generation);
  const plugin = requireFundingPlugin(family);
  const assets = canonicalAssets(input.assets);
  let sources: readonly FundingSourceDescriptor[];
  try {
    const declaredSources = plugin.funding.liquidity.sources(assets);
    if (!Array.isArray(declaredSources)) {
      throw new Error("Funding sources() must return an array");
    }
    sources = snapshotFundingSources(declaredSources);
    assertFundingSources(sources, assets);
  } catch (error) {
    const outcome = declarationFailure(
      family.plugin.manifest.familyId,
      source,
      error,
    );
    return sealResult({ family, source, generation }, [], [outcome], null);
  }

  const settled = await Promise.all(sources.map((fundingSource) =>
    executeFundingSource({
      family,
      plugin,
      fundingSource,
      source,
      generation,
      runtime: input.runtime,
      ...(input.control === undefined ? {} : { control: input.control }),
    })
  ));
  const offers = Object.freeze(settled.flatMap((item) => item.offers));
  const outcomes = Object.freeze(settled.map((item) => item.outcome));
  if (
    offers.length === 0 &&
    outcomes.some((outcome) => outcome.status !== "verified")
  ) {
    // An unresolved/failed generation cannot prove that liquidity is empty.
    // Preserve the current publication and expose only the terminal outcomes.
    return sealResult({ family, source, generation }, offers, outcomes, null);
  }

  let publication: FundingFamilyPublication;
  try {
    publication = deepFreeze({
      familyId: family.plugin.manifest.familyId,
      source: { ...source },
      generation,
      offers,
      outcomes,
    });
    input.runtime.generationFence.assertCurrent(
      generation,
      source,
    );
    input.publisher.publish(publication);
  } catch (error) {
    const publicationOutcomes = outcomes.map((outcome) =>
      outcome.status === "verified"
        ? freezeOutcome({
            ...outcome,
            status: "unresolved",
            reasonCode: `funding-publication:${errorMessage(error)}`,
          })
        : outcome
    );
    return sealResult(
      { family, source, generation },
      [],
      publicationOutcomes,
      null,
    );
  }
  return sealResult(
    { family, source, generation },
    offers,
    outcomes,
    publication,
  );
}

export function buildFundingBorrowFragment(input: {
  readonly family: LoadedFamilyBox;
  readonly offer: PreparedFundingOffer;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly amount: bigint;
  readonly minProfit: bigint;
  readonly children: readonly PlanFragment[];
}): PlanFragment {
  assertIssuedLoadedFamilyBox(input.family);
  const record = resolvePreparedFundingOffer({
    family: input.family,
    offer: input.offer,
    source: input.source,
    generation: input.generation,
  });
  const plugin = requireFundingPlugin(input.family);
  const fragment = plugin.funding.repayment.buildBorrowFragment({
    offer: record.offer,
    amount: input.amount,
    minProfit: input.minProfit,
    children: snapshotPlanFragments(input.children),
  });
  return sealFundingBorrowFragment(input.family, fragment);
}

export function buildFundingRepaymentFragment(input: {
  readonly family: LoadedFamilyBox;
  readonly offer: PreparedFundingOffer;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly amount: bigint;
}): PlanFragment {
  assertIssuedLoadedFamilyBox(input.family);
  const record = resolvePreparedFundingOffer({
    family: input.family,
    offer: input.offer,
    source: input.source,
    generation: input.generation,
  });
  const plugin = requireFundingPlugin(input.family);
  const fragment = plugin.funding.repayment.buildRepaymentFragment({
    offer: record.offer,
    amount: input.amount,
  });
  return sealFundingRepaymentFragment(input.family, plugin, fragment);
}

async function executeFundingSource(input: {
  readonly family: LoadedFamilyBox;
  readonly plugin: FundingFamilyPlugin<FundingSourceDescriptor, unknown>;
  readonly fundingSource: FundingSourceDescriptor;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly runtime: CentralAdapterRuntime;
  readonly control?: AdapterWorkControl;
}): Promise<{
  readonly offers: readonly PreparedFundingOffer[];
  readonly outcome: FundingInstanceOutcome;
}> {
  assertIssuedLoadedFamilyBox(input.family);
  const familyId = input.family.plugin.manifest.familyId;
  const programInput = Object.freeze({
    assets: Object.freeze([input.fundingSource.asset]),
    sources: Object.freeze([input.fundingSource]),
    source: Object.freeze({ ...input.source }),
  });
  const work = await executeAdapterWork({
    intent: {
      stage: "pricing-current",
      familyId,
      // A provider can expose one independently failing balance source per
      // asset. Bind central fairness/cancellation to that source state key,
      // not to the provider-wide instance key shared by every asset.
      instanceKey: instanceKey(input.fundingSource.stateKey),
      source: input.source,
      generation: input.generation,
      program: input.plugin.funding.liquidity.program,
      programInput,
    },
    runtime: input.runtime,
    ...(input.control === undefined ? {} : { control: input.control }),
  });
  if (work.status === "unresolved") {
    return Object.freeze({
      offers: Object.freeze([]),
      outcome: freezeOutcome({
        ...sourceOutcomeBase(familyId, input.fundingSource, input.source),
        status: "unresolved",
        reasonCode: `adapter-work:${work.failure.stage}:${work.failure.code}`,
        workReceipt: work.receipt,
        evidenceRefs: Object.freeze([]),
      }),
    });
  }

  const evidenceRef = `funding-transport:${work.executed.trustedResultsFingerprint}`;
  let declared: readonly FundingOfferDescriptor[];
  let deriveEvidence: unknown;
  try {
    deriveEvidence = snapshotAndFreeze(
      work.executed.evidence,
      "Funding derive evidence",
    );
    const derived = input.plugin.funding.liquidity.deriveOffers({
      evidence: deriveEvidence,
      sources: Object.freeze([input.fundingSource]),
    });
    if (!Array.isArray(derived)) {
      throw new Error("Funding deriveOffers() must return an array");
    }
    declared = snapshotFundingOffers(derived);
    assertDerivedOffers(
      declared,
      input.fundingSource,
      input.family.plugin.manifest.ownedActionAdapterIds,
    );
  } catch (error) {
    return Object.freeze({
      offers: Object.freeze([]),
      outcome: freezeOutcome({
        ...sourceOutcomeBase(familyId, input.fundingSource, input.source),
        status: "failed",
        reasonCode: `funding-derive:${errorMessage(error)}`,
        workReceipt: work.receipt,
        evidenceRefs: Object.freeze([evidenceRef]),
      }),
    });
  }
  const offers = Object.freeze(declared.map((offer) =>
    issuePreparedFundingOffer({
      family: input.family,
      offer,
      deriveEvidence,
      source: input.source,
      generation: input.generation,
      evidenceRefs: [evidenceRef],
    })
  ));
  return Object.freeze({
    offers,
    outcome: freezeOutcome({
      ...sourceOutcomeBase(familyId, input.fundingSource, input.source),
      status: "verified",
      reasonCode: offers.length === 0
        ? "funding-no-offer"
        : "funding-offer-derived",
      workReceipt: work.receipt,
      evidenceRefs: Object.freeze([evidenceRef]),
    }),
  });
}

function requireFundingPlugin(
  family: LoadedFamilyBox,
): FundingFamilyPlugin<FundingSourceDescriptor, unknown> {
  assertIssuedLoadedFamilyBox(family);
  assertDefinedFamilyPlugin(family.plugin);
  if (family.plugin.manifest.domain !== "funding") {
    throw new Error(
      `${family.plugin.manifest.familyId} is not a Funding Family`,
    );
  }
  return family.plugin as FundingFamilyPlugin<FundingSourceDescriptor, unknown>;
}

function assertFundingSources(
  sources: readonly FundingSourceDescriptor[],
  assets: readonly string[],
): void {
  const assetSet = new Set(assets.map((asset) => asset.toLowerCase()));
  const fundingIds = new Set<string>();
  const stateKeys = new Set<string>();
  for (const source of sources) {
    for (const [label, value] of [
      ["fundingId", source.fundingId],
      ["instanceKey", source.instanceKey],
      ["stateKey", source.stateKey],
    ] as const) canonicalString(value, `Funding source ${label}`);
    ethers.getAddress(source.provider);
    const asset = ethers.getAddress(source.asset);
    if (!assetSet.has(asset.toLowerCase())) {
      throw new Error(`Funding source ${source.fundingId} invented asset ${asset}`);
    }
    if (!Array.isArray(source.requiredReadKeys) || source.requiredReadKeys.length === 0) {
      throw new Error(`Funding source ${source.fundingId} has no required reads`);
    }
    if (fundingIds.has(source.fundingId)) {
      throw new Error(`Funding sources duplicate ${source.fundingId}`);
    }
    if (stateKeys.has(source.stateKey)) {
      throw new Error(`Funding sources duplicate stateKey ${source.stateKey}`);
    }
    fundingIds.add(source.fundingId);
    stateKeys.add(source.stateKey);
  }
}

function assertDerivedOffers(
  offers: readonly FundingOfferDescriptor[],
  source: FundingSourceDescriptor,
  ownedActionIds: readonly string[],
): void {
  if (offers.length > 1) {
    throw new Error(
      `Funding source ${source.fundingId} may derive at most one offer`,
    );
  }
  if (offers.length === 0) return;
  const offer = offers[0]!;
  if (
    offer.fundingId !== source.fundingId ||
    ethers.getAddress(offer.asset) !== ethers.getAddress(source.asset) ||
    !ownedActionIds.includes(offer.actionAdapterId) ||
    typeof offer.maxBorrow !== "bigint" || offer.maxBorrow < 0n ||
    typeof offer.fee !== "bigint" || offer.fee < 0n ||
    !Number.isFinite(offer.planningPriority) ||
    !Number.isFinite(offer.liquidityPriority)
  ) {
    throw new Error(`Funding source ${source.fundingId} derived an invalid offer`);
  }
}

function issuePreparedFundingOffer(input: {
  readonly family: LoadedFamilyBox;
  readonly offer: FundingOfferDescriptor;
  readonly deriveEvidence: unknown;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly evidenceRefs: readonly string[];
}): PreparedFundingOffer {
  assertIssuedLoadedFamilyBox(input.family);
  assertSource(input.source, input.generation);
  const source = snapshotCanonicalSource(input.source);
  const evidenceRefs = Object.freeze(input.evidenceRefs.map((evidenceRef) =>
    canonicalString(evidenceRef, "Funding evidence ref")
  ));
  const capabilityHash = input.family.hashes.funding.contentHash;
  const handle = Object.freeze({
    familyId: input.family.plugin.manifest.familyId,
    fundingId: input.offer.fundingId,
    asset: input.offer.asset,
    maxBorrow: input.offer.maxBorrow,
    fee: input.offer.fee,
    actionAdapterId: input.offer.actionAdapterId,
    planningPriority: input.offer.planningPriority,
    liquidityPriority: input.offer.liquidityPriority,
    source,
    generation: input.generation,
    capabilityHash,
    evidenceRefs,
  }) as unknown as PreparedFundingOffer;
  issuedPreparedFundingOffers.set(handle, Object.freeze({
    family: input.family,
    offer: input.offer,
    deriveEvidence: input.deriveEvidence,
    source,
    generation: input.generation,
    capabilityHash,
    evidenceRefs,
  }));
  return handle;
}

function resolvePreparedFundingOffer(input: {
  readonly family: LoadedFamilyBox;
  readonly offer: PreparedFundingOffer;
  readonly source: CanonicalSource;
  readonly generation: number;
}): PreparedFundingOfferRecord {
  assertIssuedLoadedFamilyBox(input.family);
  const currentSource = snapshotCanonicalSource(input.source);
  assertSource(currentSource, input.generation);
  if (
    input.offer === null ||
    typeof input.offer !== "object" ||
    !Object.isFrozen(input.offer) ||
    !issuedPreparedFundingOffers.has(input.offer)
  ) {
    throw new Error(
      "prepared Funding offer must be issued by the central runtime",
    );
  }
  const record = issuedPreparedFundingOffers.get(input.offer)!;
  if (record.family !== input.family) {
    throw new Error("prepared Funding offer escaped its catalog Family box");
  }
  if (
    record.generation !== input.generation ||
    !sameCanonicalSource(record.source, currentSource)
  ) {
    throw new Error(
      "prepared Funding offer escaped its current source/generation",
    );
  }
  if (
    record.capabilityHash !== input.family.hashes.funding.contentHash ||
    input.offer.capabilityHash !== record.capabilityHash
  ) {
    throw new Error("prepared Funding offer escaped its funding capability");
  }
  assertPreparedFundingOfferMetadata(input.offer, record);
  return record;
}

function assertPreparedFundingOfferMetadata(
  handle: PreparedFundingOffer,
  record: PreparedFundingOfferRecord,
): void {
  const raw = record.offer;
  if (
    handle.familyId !== record.family.plugin.manifest.familyId ||
    handle.fundingId !== raw.fundingId ||
    handle.asset !== raw.asset ||
    handle.maxBorrow !== raw.maxBorrow ||
    handle.fee !== raw.fee ||
    handle.actionAdapterId !== raw.actionAdapterId ||
    handle.planningPriority !== raw.planningPriority ||
    handle.liquidityPriority !== raw.liquidityPriority ||
    handle.source !== record.source ||
    handle.generation !== record.generation ||
    handle.evidenceRefs !== record.evidenceRefs ||
    handle.generation !== handle.source.generation ||
    !record.family.plugin.manifest.ownedActionAdapterIds.includes(
      raw.actionAdapterId,
    )
  ) {
    throw new Error("prepared Funding offer metadata escaped its issuer record");
  }
}

function snapshotFundingSources(
  sources: readonly FundingSourceDescriptor[],
): readonly FundingSourceDescriptor[] {
  return snapshotAndFreeze(sources, "Funding sources");
}

function snapshotFundingOffers(
  offers: readonly FundingOfferDescriptor[],
): readonly FundingOfferDescriptor[] {
  return Object.freeze(offers.map((offer) => Object.freeze({
    fundingId: canonicalString(offer.fundingId, "Funding offer fundingId"),
    asset: ethers.getAddress(offer.asset),
    maxBorrow: offer.maxBorrow,
    fee: offer.fee,
    actionAdapterId: canonicalString(
      offer.actionAdapterId,
      "Funding offer actionAdapterId",
    ),
    planningPriority: offer.planningPriority,
    liquidityPriority: offer.liquidityPriority,
  })));
}

function snapshotPlanFragments(
  fragments: readonly PlanFragment[],
): readonly PlanFragment[] {
  if (!Array.isArray(fragments)) {
    throw new Error("Funding borrow children must be an array");
  }
  return snapshotAndFreeze(fragments, "Funding borrow children");
}

function snapshotCanonicalSource(source: CanonicalSource): CanonicalSource {
  return Object.freeze({
    number: source.number,
    hash: source.hash,
    generation: source.generation,
  });
}

function sameCanonicalSource(
  left: CanonicalSource,
  right: CanonicalSource,
): boolean {
  return left.number === right.number &&
    left.hash.toLowerCase() === right.hash.toLowerCase() &&
    left.generation === right.generation;
}

/** Copy plain data before crossing a Family callback boundary. */
function snapshotAndFreeze<T>(
  value: T,
  label: string,
  ancestors: Set<object> = new Set<object>(),
): T {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(`${label} must contain only plain data`);
  }
  if (ancestors.has(value)) {
    throw new Error(`${label} must not contain cycles`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((item, index) =>
        snapshotAndFreeze(item, `${label}[${index}]`, ancestors)
      )) as T;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} must contain only plain records and arrays`);
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new Error(`${label} must not contain symbol keys`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        throw new Error(`${label}.${key} must be an enumerable data property`);
      }
      snapshot[key] = snapshotAndFreeze(
        descriptor.value,
        `${label}.${key}`,
        ancestors,
      );
    }
    return Object.freeze(snapshot) as T;
  } finally {
    ancestors.delete(value);
  }
}

function sealFundingBorrowFragment(
  family: LoadedFamilyBox,
  fragment: PlanFragment,
): PlanFragment {
  assertFundingFragmentShape(fragment);
  const owned = new Set(family.plugin.manifest.ownedActionAdapterIds);
  if (fragment.nodes.length !== 1 || !owned.has(fragment.nodes[0]!.adapterId)) {
    throw new Error("Funding borrow fragment root is not Family-owned");
  }
  return freezeFundingFragment(fragment);
}

function sealFundingRepaymentFragment(
  family: LoadedFamilyBox,
  plugin: FundingFamilyPlugin<FundingSourceDescriptor, unknown>,
  fragment: PlanFragment,
): PlanFragment {
  assertFundingFragmentShape(fragment);
  const expectedAdapterId = plugin.funding.repayment.mode === "approve-pull"
    ? "erc20-approve"
    : "erc20-transfer";
  if (
    fragment.nodes.length !== 1 ||
    fragment.nodes[0]!.adapterId !== expectedAdapterId ||
    !family.plugin.manifest.requiredInfraActionAdapterIds.includes(
      expectedAdapterId,
    )
  ) {
    throw new Error(
      `Funding repayment fragment root must be declared infra ${expectedAdapterId}`,
    );
  }
  return freezeFundingFragment(fragment);
}

function assertFundingFragmentShape(fragment: PlanFragment): void {
  if (!Array.isArray(fragment.requirements) || !Array.isArray(fragment.nodes)) {
    throw new Error("Funding plan fragment has an invalid shape");
  }
}

function freezeFundingFragment(fragment: PlanFragment): PlanFragment {
  return deepFreeze({
    requirements: [...fragment.requirements],
    nodes: [...fragment.nodes],
  });
}

function canonicalAssets(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Funding runtime requires at least one asset");
  }
  return Object.freeze([...new Set(values.map((value) => ethers.getAddress(value)))]
    .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase())));
}

function assertSource(source: CanonicalSource, generation: number): void {
  if (
    generation !== source.generation ||
    !Number.isSafeInteger(generation) || generation < 0 ||
    !Number.isSafeInteger(source.number) || source.number < 0 ||
    !/^0x[0-9a-fA-F]{64}$/.test(source.hash)
  ) {
    throw new Error("Funding runtime requires one canonical source/generation");
  }
}

function sourceOutcomeBase(
  familyId: FamilyId,
  source: FundingSourceDescriptor,
  canonicalSource: CanonicalSource,
) {
  return {
    familyId,
    fundingId: source.fundingId,
    instanceKey: source.instanceKey,
    stateKey: source.stateKey,
    asset: source.asset,
    source: Object.freeze({ ...canonicalSource }),
  };
}

function declarationFailure(
  familyId: FamilyId,
  source: CanonicalSource,
  error: unknown,
): FundingInstanceOutcome {
  return freezeOutcome({
    familyId,
    fundingId: "funding-source-declaration",
    instanceKey: familyId,
    stateKey: familyId,
    asset: ethers.ZeroAddress,
    status: "failed",
    reasonCode: `funding-sources:${errorMessage(error)}`,
    source: Object.freeze({ ...source }),
    workReceipt: null,
    evidenceRefs: Object.freeze([]),
  });
}

function freezeOutcome(outcome: FundingInstanceOutcome): FundingInstanceOutcome {
  return deepFreeze(outcome);
}

function sealResult(
  input: {
    readonly family: LoadedFamilyBox;
    readonly source: CanonicalSource;
    readonly generation: number;
  },
  offers: readonly PreparedFundingOffer[],
  outcomes: readonly FundingInstanceOutcome[],
  publication: FundingFamilyPublication | null,
): FundingFamilyRuntimeResult {
  return deepFreeze({
    familyId: input.family.plugin.manifest.familyId,
    source: { ...input.source },
    generation: input.generation,
    offers: [...offers],
    outcomes: [...outcomes],
    publication,
  });
}

function canonicalString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be canonical`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const item of Object.values(value as object)) deepFreeze(item);
  return Object.freeze(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
