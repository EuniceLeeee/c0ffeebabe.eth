import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  nominateUniV2,
  UNIV2_STANDARD_EXACT_PORT,
  UNIV2_STANDARD_STATE_PORT,
  UNIV2_SYNC_EVENT_TOPIC0,
  verifyUniV2IdentityStage,
  type UniV2SwapActionInputV1,
} from "../../../../families/univ2-standard/src/public.ts";
import {
  deriveUniV3Routes,
  UNIV3_STANDARD_SWAP_ACTION_PORT,
  type UniV3IdentityV1,
  type UniV3QuoteV1,
} from "../../../../families/univ3-standard/src/public.ts";
import {
  compareCurrentAdapterExecutionVariantV1,
  type CurrentAdapterComparisonV1,
} from "./current-adapter-comparator.ts";
import { loadHistoricalFamilyFactBundleV1 } from "./index.ts";
import {
  observeHistoricalExecutionVariantsV1,
  type HistoricalExecutionVariantCaseV1,
  type HistoricalExecutionVariantObservationV1,
} from "./variant-observer.ts";

const REPORT_SPEC = Object.freeze({
  schemaVersion: 1,
  kind: "aloha.historical-family-advisory-report-spec",
  advisoryOnly: true,
  rawEvidence: "immutable-manifest-bound-canonical-rpc-objects",
  historicalCases: "observer-caseId-and-exact-framePath-calldata-join",
  currentRelease: "generated-catalog-bound-real-action-port-shape-probe",
  result: "consistent-contradicted-or-unresolved-never-release-verdict",
});

export const HISTORICAL_FAMILY_ADVISORY_REPORT_SPEC_DIGEST_V1 = hashDomain(
  "aloha/historical-family-advisory-report-spec/v1",
  REPORT_SPEC,
);

export const HISTORICAL_FAMILY_ADVISORY_REPORT_IMPLEMENTATION_DIGEST_V1 = hashDomain(
  "aloha/historical-family-advisory-report-implementation/v1",
  Object.freeze({ sourceSha256: sha256Hex(readFileSync(fileURLToPath(import.meta.url))) }),
);

export interface HistoricalFamilyAdvisoryCaseV1 {
  readonly caseId: Hash;
  readonly selectorCandidate: HistoricalExecutionVariantCaseV1["selectorCandidate"];
  readonly identityStatus: "selector-candidate-only";
  readonly executionVariant: HistoricalExecutionVariantCaseV1["executionVariant"];
  readonly direction: HistoricalExecutionVariantCaseV1["direction"];
  readonly settlementMode: HistoricalExecutionVariantCaseV1["settlementMode"];
  readonly settlementCoverage: HistoricalExecutionVariantCaseV1["settlementCoverage"];
  readonly calldataSha256: Hash;
  readonly currentProbeKind: "synthetic-current-action-shape-probe";
  readonly currentProbeInputRoot: Hash;
  readonly comparisonScope: "encoding-and-settlement-shape-only";
  readonly logCoverage: HistoricalExecutionVariantCaseV1["logCoverage"];
  readonly effectsCoverage: HistoricalExecutionVariantCaseV1["effectsCoverage"];
  readonly comparison: CurrentAdapterComparisonV1;
}

export interface HistoricalFamilyAdvisoryReportV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.historical-family-advisory-report";
  readonly advisoryOnly: true;
  readonly reportSpecDigest: Hash;
  readonly reportImplementationDigest: Hash;
  readonly observation: HistoricalExecutionVariantObservationV1;
  readonly cases: readonly HistoricalFamilyAdvisoryCaseV1[];
  readonly reportRoot: Hash;
}

function fail(message: string): never {
  throw new TypeError(message);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`expected object at ${path}`);
  return value as Record<string, unknown>;
}

function hexData(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) fail(`expected calldata at ${path}`);
  return value.toLowerCase();
}

function address(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) fail(`expected address at ${path}`);
  return value.toLowerCase();
}

function hash(value: unknown, path: string): Hash {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) fail(`expected hash at ${path}`);
  return value as Hash;
}

function decimalBlockNumber(value: unknown): string {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    fail("header number is not a canonical hex quantity");
  }
  return BigInt(value).toString(10);
}

function frameInput(trace: CanonicalJson, item: HistoricalExecutionVariantCaseV1): string {
  let node = object(trace, "$.trace");
  for (const [depth, rawIndex] of item.framePath.entries()) {
    if (!/^(0|[1-9][0-9]*)$/.test(rawIndex)) fail(`invalid framePath index at depth ${depth}`);
    if (!Array.isArray(node.calls)) fail(`missing calls array at framePath depth ${depth}`);
    const index = Number(rawIndex);
    if (!Number.isSafeInteger(index) || node.calls[index] === undefined) fail(`framePath is outside trace at depth ${depth}`);
    node = object(node.calls[index], `$.trace.framePath[${depth}]`);
  }
  if (address(node.to, "$.trace.selected.to") !== item.to) fail("observed case target does not match selected frame");
  const calldata = hexData(node.input, "$.trace.selected.input");
  const bytes = Uint8Array.from(Buffer.from(calldata.slice(2), "hex"));
  if (sha256Hex(bytes) !== item.calldataSha256 || String(bytes.length) !== item.calldataByteLength) {
    fail("observed case calldata commitment does not match selected frame");
  }
  return calldata;
}

function word(calldata: string, index: number): bigint {
  const encoded = calldata.slice(10 + index * 64, 10 + (index + 1) * 64);
  if (encoded.length !== 64) fail("calldata word is truncated");
  return BigInt(`0x${encoded}`);
}

function signedWord(calldata: string, index: number): bigint {
  const unsigned = word(calldata, index);
  return unsigned < (1n << 255n) ? unsigned : unsigned - (1n << 256n);
}

function addressWord(value: string): string {
  return value.slice(2).padStart(64, "0");
}

function uintWord(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function probeAddress(suffix: string): string {
  return `0x${suffix.padStart(40, "0")}`;
}

function currentUniV2ProbeInput(
  item: HistoricalExecutionVariantCaseV1,
  cutoff: Readonly<{ chainId: string; number: string; hash: Hash; stateRoot: Hash }>,
): UniV2SwapActionInputV1 {
  const token0 = probeAddress("11");
  const token1 = probeAddress("12");
  const factory = probeAddress("13");
  const direction = item.direction === "zero-for-one" ? "token0-to-token1" : "token1-to-token0";
  const nomination = nominateUniV2({
    pool: item.to,
    evidence: {
      cutoff,
      blockNumber: cutoff.number,
      blockHash: cutoff.hash,
      txHash: hashDomain("aloha/historical-family-advisory/probe-tx/v1", item.caseId),
      logIndex: item.frameIndex,
      emitter: item.to,
      topic0: UNIV2_SYNC_EVENT_TOPIC0,
      rawLocatorHash: hashDomain("aloha/historical-family-advisory/probe-locator/v1", item.caseId),
    },
  });
  if (nomination.status !== "nominated") fail("current UniV2 shape probe nomination unavailable");
  const identity = verifyUniV2IdentityStage({
    nomination: nomination.candidate,
    reads: {
      cutoff,
      pool: item.to,
      token0ReturnHex: `0x${addressWord(token0)}`,
      token1ReturnHex: `0x${addressWord(token1)}`,
      factoryReturnHex: `0x${addressWord(factory)}`,
      forwardPairReturnHex: `0x${addressWord(item.to)}`,
      reversePairReturnHex: `0x${addressWord(item.to)}`,
    },
  });
  if (identity.status !== "verified") fail("current UniV2 shape probe identity unavailable");
  const program = UNIV2_STANDARD_STATE_PORT.issueReserveReadProgram({ identity: identity.identity, source: cutoff });
  const snapshot = UNIV2_STANDARD_STATE_PORT.decodeReserveReadResponse(program, {
    kind: "univ2-standard.state-read-response",
    programHash: program.programHash,
    source: cutoff,
    pool: item.to,
    dataHex: `0x${uintWord(1_000_000n)}${uintWord(2_000_000n)}${uintWord(1n)}`,
  });
  const exact = UNIV2_STANDARD_EXACT_PORT.propagateAmount({ state: snapshot, direction, amountIn: "100000" });
  if (exact.status !== "verified") fail("current UniV2 shape probe exact unavailable");
  return Object.freeze({
    exact,
    pool: item.to,
    tokenIn: direction === "token0-to-token1" ? token0 : token1,
    tokenOut: direction === "token0-to-token1" ? token1 : token0,
    direction,
    recipient: probeAddress("14"),
    callbackDataHex: "0x",
  });
}

function currentUniV3ProbeInput(
  item: HistoricalExecutionVariantCaseV1,
  calldata: string,
  cutoff: Readonly<{ chainId: string; number: string; hash: Hash; stateRoot: Hash }>,
): Parameters<typeof UNIV3_STANDARD_SWAP_ACTION_PORT.build>[0] {
  const token0 = probeAddress("21");
  const token1 = probeAddress("22");
  const facts = Object.freeze({
    pool: item.to,
    factory: probeAddress("23"),
    token0,
    token1,
    fee: "3000",
    tickSpacing: 60,
    reversePool: item.to,
  });
  const identity: UniV3IdentityV1 = Object.freeze({
    cutoff,
    candidateSnapshotHash: hashDomain("aloha/historical-family-advisory/univ3-candidate/v1", item.caseId),
    facts,
    factsHash: hashDomain("aloha/univ3-standard/identity-facts/v1", facts),
    instanceKey: item.to,
  });
  const route = deriveUniV3Routes(identity).find((candidate) =>
    candidate.zeroForOne === (item.direction === "zero-for-one")
  );
  if (route === undefined) fail("current UniV3 shape probe route unavailable");
  const observedAmount = signedWord(calldata, 2);
  const amountIn = (observedAmount < 0n ? -observedAmount : observedAmount).toString(10);
  const quoteBody = Object.freeze({
    cutoff,
    routeBindingHash: route.routeBindingHash,
    amountIn,
    amountOut: "1",
    stateHash: hashDomain("aloha/historical-family-advisory/univ3-state/v1", item.caseId),
  });
  const quote: UniV3QuoteV1 = Object.freeze({
    ...quoteBody,
    quoteHash: hashDomain("aloha/univ3-standard/quote/v1", quoteBody),
  });
  const recipientEncoded = calldata.slice(10, 74);
  if (!/^0{24}[0-9a-f]{40}$/.test(recipientEncoded)) fail("observed UniV3 recipient word is invalid");
  return Object.freeze({
    identity,
    route,
    quote,
    recipient: `0x${recipientEncoded.slice(24)}`,
    minAmountOut: quote.amountOut,
  });
}

export function buildHistoricalFamilyAdvisoryReportV1(
  rootDirectory: string,
  expectedManifestRoot: Hash,
): HistoricalFamilyAdvisoryReportV1 {
  const observation = observeHistoricalExecutionVariantsV1(rootDirectory, expectedManifestRoot);
  const bundle = loadHistoricalFamilyFactBundleV1(rootDirectory, expectedManifestRoot);
  const header = object(bundle.results.header, "$.header");
  const cutoff = Object.freeze({
    chainId: bundle.manifest.chainId,
    number: decimalBlockNumber(header.number),
    hash: bundle.manifest.canonicalBlockHash,
    stateRoot: hash(header.stateRoot, "$.header.stateRoot"),
  });
  const cases = Object.freeze(observation.cases.map((item): HistoricalFamilyAdvisoryCaseV1 => {
    const calldata = frameInput(bundle.results.trace, item);
    let currentActionInput: UniV2SwapActionInputV1 | Parameters<typeof UNIV3_STANDARD_SWAP_ACTION_PORT.build>[0];
    let comparison: CurrentAdapterComparisonV1;
    if (item.selectorCandidate === "univ2-standard") {
      if (item.executionVariant !== "canonical-swap") fail("UniV2 observer variant mismatch");
      currentActionInput = currentUniV2ProbeInput(item, cutoff);
      comparison = compareCurrentAdapterExecutionVariantV1({
        family: "univ2-standard",
        executionVariant: item.executionVariant,
        direction: item.direction,
        settlementMode: item.settlementMode,
        settlementCoverage: item.settlementCoverage,
        target: item.to,
        calldata,
        currentProbeBinding: "synthetic-shape-only",
        currentActionInput,
      });
    } else {
      if (item.executionVariant === "canonical-swap" || item.settlementMode !== "callback") {
        fail("UniV3 observer variant mismatch");
      }
      currentActionInput = currentUniV3ProbeInput(item, calldata, cutoff);
      comparison = compareCurrentAdapterExecutionVariantV1({
        family: "univ3-standard",
        executionVariant: item.executionVariant,
        direction: item.direction,
        settlementMode: item.settlementMode,
        target: item.to,
        calldata,
        currentProbeBinding: "synthetic-shape-only",
        currentActionInput,
      });
    }
    return Object.freeze({
      caseId: item.caseId,
      selectorCandidate: item.selectorCandidate,
      identityStatus: item.identityStatus,
      executionVariant: item.executionVariant,
      direction: item.direction,
      settlementMode: item.settlementMode,
      settlementCoverage: item.settlementCoverage,
      calldataSha256: item.calldataSha256,
      currentProbeKind: "synthetic-current-action-shape-probe",
      currentProbeInputRoot: hashDomain("aloha/historical-family-advisory/current-probe-input/v1", currentActionInput),
      comparisonScope: "encoding-and-settlement-shape-only",
      logCoverage: item.logCoverage,
      effectsCoverage: item.effectsCoverage,
      comparison,
    });
  }));
  const rootPayload = Object.freeze({
    reportSpecDigest: HISTORICAL_FAMILY_ADVISORY_REPORT_SPEC_DIGEST_V1,
    reportImplementationDigest: HISTORICAL_FAMILY_ADVISORY_REPORT_IMPLEMENTATION_DIGEST_V1,
    observationRoot: observation.caseRoot,
    cases,
  });
  return Object.freeze({
    schemaVersion: 1,
    kind: "aloha.historical-family-advisory-report",
    advisoryOnly: true,
    reportSpecDigest: HISTORICAL_FAMILY_ADVISORY_REPORT_SPEC_DIGEST_V1,
    reportImplementationDigest: HISTORICAL_FAMILY_ADVISORY_REPORT_IMPLEMENTATION_DIGEST_V1,
    observation,
    cases,
    reportRoot: hashDomain("aloha/historical-family-advisory-report/v1", rootPayload),
  });
}

/** Stores the derived advisory log separately from the immutable raw object CAS. */
export function materializeHistoricalFamilyAdvisoryReportV1(
  rootDirectory: string,
  report: HistoricalFamilyAdvisoryReportV1,
): string {
  const expected = rebuildAndValidateHistoricalFamilyAdvisoryReportV1(rootDirectory, report);
  const directory = resolve(rootDirectory, "reports");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail("advisory report path is not a real directory");
  const path = join(directory, `${expected.reportRoot.slice(2)}.json`);
  const bytes = encodeCanonicalBytes(expected);
  try {
    const descriptor = openSync(path, "wx", 0o600);
    try {
      writeFileSync(descriptor, bytes);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existingStat = lstatSync(path);
    if (!existingStat.isFile() || existingStat.isSymbolicLink()) fail("advisory report path is not a regular file");
    if (!readFileSync(path).equals(Buffer.from(bytes))) fail("immutable advisory report bytes changed");
  }
  return path;
}

function rebuildAndValidateHistoricalFamilyAdvisoryReportV1(
  rootDirectory: string,
  candidate: unknown,
): HistoricalFamilyAdvisoryReportV1 {
  const candidateObject = object(candidate, "$.report");
  const observation = object(candidateObject.observation, "$.report.observation");
  const manifestIdentity = object(observation.manifestIdentity, "$.report.observation.manifestIdentity");
  const manifestRoot = hash(
    manifestIdentity.manifestRoot,
    "$.report.observation.manifestIdentity.manifestRoot",
  );
  const expected = buildHistoricalFamilyAdvisoryReportV1(rootDirectory, manifestRoot);
  if (!Buffer.from(encodeCanonicalBytes(candidate as CanonicalJson)).equals(Buffer.from(encodeCanonicalBytes(expected)))) {
    fail("advisory report does not exactly match a rebuild from its immutable raw manifest");
  }
  return expected;
}

/** Loads a derived report only after rebuilding it from the caller-bound immutable raw manifest. */
export function loadHistoricalFamilyAdvisoryReportV1(
  rootDirectory: string,
  expectedManifestRoot: Hash,
  expectedReportRoot: Hash,
): HistoricalFamilyAdvisoryReportV1 {
  const manifestRoot = hash(expectedManifestRoot, "$.expectedManifestRoot");
  const reportRoot = hash(expectedReportRoot, "$.expectedReportRoot");
  const path = join(resolve(rootDirectory, "reports"), `${reportRoot.slice(2)}.json`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("advisory report path is not a regular file");
  const bytes = readFileSync(path);
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("advisory report is not valid JSON");
  }
  if (!Buffer.from(encodeCanonicalBytes(decoded as CanonicalJson)).equals(bytes)) {
    fail("advisory report bytes are not canonical");
  }
  const expected = rebuildAndValidateHistoricalFamilyAdvisoryReportV1(rootDirectory, decoded);
  if (expected.observation.manifestIdentity.manifestRoot !== manifestRoot) {
    fail("advisory report raw manifest does not match the requested manifest");
  }
  if (expected.reportRoot !== reportRoot) fail("advisory report root does not match the requested report");
  return expected;
}
