import type {
  CaptureMaterializationSemantics,
  CaptureNominationInput,
  CaptureNominationProvider,
  CaptureObservationIntent,
  CreditCaptureVector,
  DiscoverySemantics,
  FamilyCandidate,
  FamilyCaptureDescriptor,
  FundingCaptureVector,
  RouteCaptureVector,
  RuntimeEvidence,
  UnifiedObservation,
} from "./adapter-family-plugin.js";
import type { FamilyId } from "./adapter-family-identifiers.js";
import type { CanonicalSource } from "./adapter-request-program.js";
import type { CanonicalValue } from "./canonical-value.js";
import type { FamilyCapabilityCatalog } from "./family-capability-catalog.js";

interface RouteCaptureBinding {
  readonly observation: CanonicalValue;
  readonly amountIn: CanonicalValue;
  readonly minAmountOut: CanonicalValue;
  readonly executor: CanonicalValue;
  readonly runtimeEvidence: CanonicalValue;
}

interface CreditCaptureBinding extends RouteCaptureBinding {
  readonly collateralAmount: CanonicalValue;
  readonly debtBps: CanonicalValue;
}

/**
 * Shared parser for the framework-level capture envelope. It knows no Family
 * ids, protocol names, selectors, topics or infrastructure addresses. The
 * owning plugin supplies the discovery declaration and the descriptor keeps
 * protocol-owned values opaque until this boundary.
 */
/**
 * Executes the catalog-issued nomination capability for every Family plugin
 * that declares one. The framework feeds opaque pool nominations to each
 * plugin one candidate at a time: the plugin either re-materializes a real
 * observation for that candidate or returns nothing, and the first candidate
 * whose observation passes `catalog.matches` + `decodeCandidate` stops the
 * Family (per-Family early stop). Cost is therefore per-Family constant RPC,
 * not nominations x pools. A nomination that matches a Family but fails
 * decodeCandidate is a fail-closed rejection, not a silent drop. Families
 * already admitted elsewhere (e.g. verified tx evidence) can be skipped with
 * `alreadyAdmitted`.
 */
export async function executeCatalogCaptureNominations(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly source: CanonicalSource;
  readonly nominations: readonly CaptureNominationInput[];
  readonly provider: CaptureNominationProvider;
  readonly alreadyAdmitted?: ReadonlySet<FamilyId>;
}): Promise<readonly UnifiedObservation[]> {
  const observations: UnifiedObservation[] = [];
  const admitted = new Set(input.alreadyAdmitted ?? []);
  for (const family of input.catalog.listAll()) {
    const plugin = family.plugin;
    if (!("discovery" in plugin)) continue;
    const nominate = plugin.discovery.nominate;
    if (nominate === undefined) continue;
    if (admitted.has(plugin.manifest.familyId)) continue;
    for (const nomination of input.nominations) {
      const derived = await nominate.nominate({
        nominations: Object.freeze([nomination]),
        source: input.source,
        provider: input.provider,
      });
      if (plugin.manifest.familyId === "protocol:erc4626-silo-redeem" &&
          derived.length > 0) {
        console.log("SILO_DEBUG derived", derived.length, "from", JSON.stringify(nomination.opaque).slice(0, 120));
      }
      if (derived.length === 0) continue;
      const observation = derived[0];
      const matches = input.catalog.matches(observation);
      const accepted = matches.some((match) =>
        match.familyId === plugin.manifest.familyId &&
        plugin.discovery.decodeCandidate({
          observation,
          matchedPatternId: match.patternId,
        }) !== null
      );
      if (!accepted) {
        // Fail-closed rejection of this candidate: the observation does not
        // admit through matches + decodeCandidate (e.g. a proxy gate or
        // behavior mismatch). This is a per-candidate rejection, not an
        // executor defect - record it and try the next nomination.
        continue;
      }
      observations.push(observation);
      admitted.add(plugin.manifest.familyId);
      break;
    }
  }
  return Object.freeze(observations);
}

export function createRouteCaptureMaterialization<
  Candidate extends FamilyCandidate,
>(input: {
  readonly familyId: FamilyId;
  readonly discovery: DiscoverySemantics<Candidate>;
}): CaptureMaterializationSemantics {
  return {
    materialize(descriptor: FamilyCaptureDescriptor): RouteCaptureVector {
      assertDescriptorFamily(descriptor, input.familyId);
      const binding = routeBinding(descriptor.opaqueBinding);
      return Object.freeze({
        kind: "route" as const,
        observations: Object.freeze([
          observationIntent(input.discovery, descriptor, binding.observation),
        ]),
        amountIn: decimalBigint(binding.amountIn, "capture amountIn"),
        minAmountOut: decimalBigint(
          binding.minAmountOut,
          "capture minAmountOut",
        ),
        executor: text(binding.executor, "capture executor"),
        runtimeEvidence: runtimeEvidence(binding.runtimeEvidence),
      });
    },
  };
}

export function createCreditCaptureMaterialization<
  Candidate extends FamilyCandidate,
>(input: {
  readonly familyId: FamilyId;
  readonly discovery: DiscoverySemantics<Candidate>;
}): CaptureMaterializationSemantics {
  return {
    materialize(descriptor: FamilyCaptureDescriptor): CreditCaptureVector {
      assertDescriptorFamily(descriptor, input.familyId);
      const binding = creditBinding(descriptor.opaqueBinding);
      return Object.freeze({
        kind: "credit" as const,
        observations: Object.freeze([
          observationIntent(input.discovery, descriptor, binding.observation),
        ]),
        collateralAmount: decimalBigint(
          binding.collateralAmount,
          "capture collateralAmount",
        ),
        debtBps: decimalBigint(binding.debtBps, "capture debtBps"),
        minAmountOut: decimalBigint(
          binding.minAmountOut,
          "capture minAmountOut",
        ),
        executor: text(binding.executor, "capture executor"),
        runtimeEvidence: runtimeEvidence(binding.runtimeEvidence),
      });
    },
  };
}

export function createFundingCaptureMaterialization(input: {
  readonly familyId: FamilyId;
}): CaptureMaterializationSemantics {
  return {
    materialize(descriptor: FamilyCaptureDescriptor): FundingCaptureVector {
      assertDescriptorFamily(descriptor, input.familyId);
      const binding = record(descriptor.opaqueBinding, "funding capture binding");
      exactKeys(binding, ["amount", "assets", "minProfit"],
        "funding capture binding");
      if (!Array.isArray(binding.assets)) {
        throw new Error("funding capture assets must be an array");
      }
      return Object.freeze({
        kind: "funding" as const,
        assets: Object.freeze(binding.assets.map((asset) =>
          text(asset, "funding capture asset")
        )),
        amount: decimalBigint(binding.amount, "funding capture amount"),
        minProfit: decimalBigint(
          binding.minProfit,
          "funding capture minProfit",
        ),
      });
    },
  };
}

function routeBinding(value: CanonicalValue): RouteCaptureBinding {
  const binding = record(value, "route capture binding");
  exactKeys(
    binding,
    ["amountIn", "executor", "minAmountOut", "observation", "runtimeEvidence"],
    "route capture binding",
  );
  return binding as unknown as RouteCaptureBinding;
}

function creditBinding(value: CanonicalValue): CreditCaptureBinding {
  const binding = record(value, "credit capture binding");
  exactKeys(
    binding,
    [
      "collateralAmount",
      "debtBps",
      "executor",
      "minAmountOut",
      "observation",
      "runtimeEvidence",
    ],
    "credit capture binding",
  );
  return binding as unknown as CreditCaptureBinding;
}

function observationIntent<Candidate extends FamilyCandidate>(
  discovery: DiscoverySemantics<Candidate>,
  descriptor: FamilyCaptureDescriptor,
  value: CanonicalValue,
): CaptureObservationIntent {
  const observation = record(value, "capture observation binding");
  const kind = text(observation.kind, "capture observation kind");
  if (isUnifiedObservationBinding(observation)) {
    const restored = restoreUnifiedObservation(observation, descriptor);
    const patternId = declaredPatternId(discovery, restored);
    return Object.freeze({
      kind: "provided-observation" as const,
      patternId,
      observation: restored,
    });
  }
  const patternId = text(observation.patternId, "capture observation patternId");
  switch (kind) {
    case "address-surface": {
      exactKeys(
        observation,
        ["interfaceFingerprints", "kind", "patternId"],
        "address-surface capture binding",
      );
      if (!Array.isArray(observation.interfaceFingerprints)) {
        throw new Error("capture interfaceFingerprints must be an array");
      }
      assertDeclared(
        discovery.addressSurfaces?.map((pattern) => pattern.id),
        patternId,
      );
      return Object.freeze({
        kind: "address-surface" as const,
        patternId,
        address: descriptor.candidateIdentity,
        interfaceFingerprints: Object.freeze(
          observation.interfaceFingerprints.map((fingerprint) =>
            text(fingerprint, "capture interface fingerprint")
          ),
        ),
      });
    }
    case "declared-log":
      exactKeys(
        observation,
        ["kind", "patternId"],
        "declared-log capture binding",
      );
      {
        const pattern = discovery.logPatterns?.find((candidate) =>
          candidate.id === patternId
        );
        if (pattern?.emitter === undefined || pattern.emitter.mode === "address") {
          throw new Error(
            `capture pattern ${patternId} has no declared singleton emitter`,
          );
        }
      }
      return Object.freeze({
        kind: "declared-log" as const,
        patternId,
        candidateIdentity: descriptor.candidateIdentity,
      });
    case "observed-call":
      exactKeys(
        observation,
        ["kind", "patternId", "traceAddress", "transactionHash"],
        "observed-call capture binding",
      );
      assertDeclared(
        discovery.callPatterns?.map((pattern) => pattern.id),
        patternId,
      );
      return Object.freeze({
        kind: "observed-call" as const,
        patternId,
        transactionHash: text(
          observation.transactionHash,
          "capture transactionHash",
        ),
        traceAddress: Object.freeze(integerArray(
          observation.traceAddress,
          "capture traceAddress",
        )),
      });
    case "observed-log":
      exactKeys(
        observation,
        ["kind", "logIndex", "patternId", "transactionHash"],
        "observed-log capture binding",
      );
      assertDeclared(
        discovery.logPatterns?.map((pattern) => pattern.id),
        patternId,
      );
      return Object.freeze({
        kind: "observed-log" as const,
        patternId,
        transactionHash: text(
          observation.transactionHash,
          "capture transactionHash",
        ),
        logIndex: integer(observation.logIndex, "capture logIndex"),
      });
    default:
      throw new Error(`unknown capture observation kind ${kind}`);
  }
}

function isUnifiedObservationBinding(
  value: Readonly<Record<string, CanonicalValue>>,
): boolean {
  return "source" in value && ["call", "log", "address-surface", "factory-log"]
    .includes(String(value.kind));
}

function restoreUnifiedObservation(
  value: Readonly<Record<string, CanonicalValue>>,
  descriptor: FamilyCaptureDescriptor,
): import("./adapter-family-plugin.js").UnifiedObservation {
  const sourceValue = record(value.source, "capture observation source");
  const source = Object.freeze({
    number: integer(sourceValue.number, "capture observation source number"),
    hash: text(sourceValue.hash, "capture observation source hash"),
    generation: integer(
      sourceValue.generation,
      "capture observation source generation",
    ),
  });
  if (
    source.number !== descriptor.source.number ||
    source.generation !== descriptor.source.generation ||
    source.hash.toLowerCase() !== descriptor.source.hash.toLowerCase()
  ) {
    throw new Error("capture observation source differs from descriptor");
  }
  const kind = text(value.kind, "capture observation kind");
  if (kind === "call") {
    return Object.freeze({
      kind,
      source,
      target: text(value.target, "capture call target"),
      data: text(value.data, "capture call data"),
      ...(value.sender === undefined
        ? {}
        : { sender: text(value.sender, "capture call sender") }),
      ...(value.transactionHash === undefined
        ? {}
        : { transactionHash: text(value.transactionHash,
            "capture call transactionHash") }),
    });
  }
  if (kind === "log") {
    return Object.freeze({
      kind,
      source,
      address: text(value.address, "capture log address"),
      topics: stringArray(value.topics, "capture log topics"),
      data: text(value.data, "capture log data"),
      ...(value.transactionHash === undefined
        ? {}
        : { transactionHash: text(value.transactionHash,
            "capture log transactionHash") }),
    });
  }
  if (kind === "address-surface") {
    return Object.freeze({
      kind,
      source,
      address: text(value.address, "capture surface address"),
      codeHash: text(value.codeHash, "capture surface codeHash"),
      implementationWord: text(
        value.implementationWord,
        "capture surface implementationWord",
      ),
      ...(value.interfaceFingerprints === undefined
        ? {}
        : { interfaceFingerprints: stringArray(
            value.interfaceFingerprints,
            "capture surface interfaceFingerprints",
          ) }),
    });
  }
  if (kind === "factory-log") {
    return Object.freeze({
      kind,
      source,
      factory: text(value.factory, "capture factory"),
      poolKeyProjection: text(
        value.poolKeyProjection,
        "capture poolKeyProjection",
      ),
      lastFactoryLogBlock: integer(
        value.lastFactoryLogBlock,
        "capture lastFactoryLogBlock",
      ),
      topic: text(value.topic, "capture factory topic") as `0x${string}`,
      topics: stringArray(value.topics, "capture factory topics"),
      data: text(value.data, "capture factory data"),
    });
  }
  throw new Error(`unsupported provided observation ${kind}`);
}

function declaredPatternId<Candidate extends FamilyCandidate>(
  discovery: DiscoverySemantics<Candidate>,
  observation: import("./adapter-family-plugin.js").UnifiedObservation,
): string {
  if (observation.kind === "call") {
    const selector = observation.data.slice(0, 10).toLowerCase();
    const pattern = discovery.callPatterns?.find((candidate) =>
      candidate.selector.toLowerCase() === selector
    );
    if (pattern !== undefined) return pattern.id;
  } else if (observation.kind === "log") {
    const topic = observation.topics[0]?.toLowerCase();
    const pattern = discovery.logPatterns?.find((candidate) =>
      candidate.topic.toLowerCase() === topic
    );
    if (pattern !== undefined) return pattern.id;
  } else if (observation.kind === "factory-log") {
    const pattern = discovery.logPatterns?.find((candidate) =>
      candidate.topic.toLowerCase() === observation.topic.toLowerCase()
    );
    if (pattern !== undefined) return pattern.id;
  } else {
    const pattern = discovery.addressSurfaces?.find((candidate) => {
      if (candidate.kind === "code-hash") {
        return candidate.fingerprint.toLowerCase() ===
          observation.codeHash.toLowerCase();
      }
      if (candidate.kind === "proxy-implementation") {
        return !/^0x0{64}$/i.test(observation.implementationWord);
      }
      return observation.interfaceFingerprints?.includes(
        candidate.fingerprint,
      ) === true;
    });
    if (pattern !== undefined) return pattern.id;
  }
  throw new Error("provided capture observation matches no plugin declaration");
}

function stringArray(
  value: CanonicalValue | undefined,
  label: string,
): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return Object.freeze(value.map((item) => text(item, label)));
}

function runtimeEvidence(value: CanonicalValue): readonly RuntimeEvidence[] {
  if (!Array.isArray(value)) {
    throw new Error("capture runtimeEvidence must be an array");
  }
  return Object.freeze(value.map((item) =>
    record(item, "capture runtimeEvidence") as unknown as RuntimeEvidence
  ));
}

function assertDescriptorFamily(
  descriptor: FamilyCaptureDescriptor,
  familyId: FamilyId,
): void {
  if (descriptor.familyId !== familyId) {
    throw new Error("capture descriptor does not belong to this plugin");
  }
}

function assertDeclared(
  declared: readonly string[] | undefined,
  patternId: string,
): void {
  if (!declared?.includes(patternId)) {
    throw new Error(`capture pattern ${patternId} is not plugin-declared`);
  }
}

function record(
  value: CanonicalValue,
  label: string,
): Readonly<Record<string, CanonicalValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a record`);
  }
  return value as Readonly<Record<string, CanonicalValue>>;
}

function exactKeys(
  value: Readonly<Record<string, CanonicalValue>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some(
    (key, index) => key !== sortedExpected[index],
  )) {
    throw new Error(`${label} keys must be exactly ${sortedExpected.join(",")}`);
  }
}

function text(value: CanonicalValue | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be non-empty text`);
  }
  return value;
}

function decimalBigint(
  value: CanonicalValue | undefined,
  label: string,
): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be an unsigned decimal string`);
  }
  return BigInt(value);
}

function integer(value: CanonicalValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

function integerArray(
  value: CanonicalValue | undefined,
  label: string,
): readonly number[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item) => integer(item, label));
}
