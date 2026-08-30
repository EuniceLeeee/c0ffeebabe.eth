import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeCanonicalBytes, hashDomain, sha256Hex, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { FAMILY_CATALOG } from "../../../generated/family-catalog/index.ts";
import { CURVE_UNDERLYING_ACTION_IMPLEMENTATION_HASH } from "../../../families/curve-underlying/src/action.ts";
import { CURVE_UNDERLYING_FAMILY_DEFINITION_HASH } from "../../../families/curve-underlying/src/family-definition.ts";
import { CURVE_UNDERLYING_I128_SELECTOR } from "../../../families/curve-underlying/src/manifest.ts";
import { DODO_V2_ACTION_IMPLEMENTATION_HASH } from "../../../families/dodo-v2/src/action.ts";
import { DODO_V2_FAMILY_AUTHORING_HASH } from "../../../families/dodo-v2/src/family-definition.ts";
import { DODO_V2_SELL_QUOTE_SELECTOR } from "../../../families/dodo-v2/src/manifest.ts";
import { FLUID_DEX_ACTION_IMPLEMENTATION_HASH } from "../../../families/fluid-dex/src/action-contract.ts";
import { encodeSwapInCall, FLUID_DEX_SWAP_IN_SELECTOR } from "../../../families/fluid-dex/src/abi.ts";
import { FLUID_DEX_FAMILY_DEFINITION_HASH } from "../../../families/fluid-dex/src/family-definition.ts";
import { UNIV4_ACTION_IMPLEMENTATION_HASH } from "../../../families/univ4/src/action-contract.ts";
import { encodeSwapCall as encodeUniv4Swap, poolIdForKey as univ4PoolId, UNIV4_POOL_MANAGER, UNIV4_SWAP_SELECTOR, type Univ4PoolKey } from "../../../families/univ4/src/abi.ts";
import { UNIV4_FAMILY_DEFINITION_HASH } from "../../../families/univ4/src/family-definition.ts";
import { ANGSTROM_V4_ACTION_IMPLEMENTATION_HASH } from "../../../families/angstrom-v4/src/action-contract.ts";
import { ANGSTROM_MAINNET_HOOK, ANGSTROM_V4_POOL_MANAGER, ANGSTROM_V4_SWAP_SELECTOR, encodeSwapCall as encodeAngstromSwap, poolIdForKey as angstromPoolId, type AngstromV4PoolKey } from "../../../families/angstrom-v4/src/abi.ts";
import { ANGSTROM_V4_FAMILY_DEFINITION_HASH } from "../../../families/angstrom-v4/src/family-definition.ts";
import { currentReleaseFamilyDecisions, type CurrentReleaseFamilyExclusionReasonV1 } from "../../catalog-generator/src/current-release.ts";
import { loadHistoricalFamilyFactBundleV1 } from "../../reference-only/historical-family-facts/src/index.ts";

export type HistoricalSpecimenFamilyV1 = "curve-underlying" | "dodo-v2" | "fluid-dex" | "univ4" | "angstrom-v4";
export type HistoricalSpecimenVariantV1 = "exchange-underlying-int128" | "sell-quote" | "swap-in" | "pool-manager-exact-input" | "official-adapter-hook-aware-exact-input";

export interface HistoricalSpecimenDescriptorV1 {
  readonly family: HistoricalSpecimenFamilyV1;
  readonly variant: HistoricalSpecimenVariantV1;
  readonly manifestRoot: Hash;
  readonly txHash: Hash;
  readonly canonicalBlockHash: Hash;
  readonly framePath: readonly string[];
  readonly frameSelector: string;
  readonly frameTarget: string;
  readonly eventEmitter: string;
  readonly eventTopic0: Hash;
  readonly eventLogIndex: string;
  readonly poolId?: Hash;
  readonly officialAdapter?: string;
  readonly hook?: string;
  readonly innerFramePath?: readonly string[];
  readonly innerFrameSelector?: string;
  readonly innerFrameTarget?: string;
  readonly locatorEventTopic0?: Hash;
  readonly locatorEventLogIndex?: string;
  readonly executionAdapter?: string;
  readonly unlockFramePath?: readonly string[];
  readonly unlockFrameSelector?: string;
  readonly unlockFrameTarget?: string;
  readonly callbackFramePath?: readonly string[];
  readonly callbackFrameSelector?: string;
  readonly callbackFrameTarget?: string;
}

const V4_SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f" as Hash;

/** Exact evidence locators, never production admission allowlists. */
export const HISTORICAL_FAMILY_SPECIMENS_V1: readonly HistoricalSpecimenDescriptorV1[] = Object.freeze([
  Object.freeze({ family: "curve-underlying", variant: "exchange-underlying-int128", manifestRoot: "0x15bcdb923bd656196fb6bf227fc3f47f740d4d8f4e89f7a63327f643129e6c5b", txHash: "0x149df3ec17a6044e0c66c25aa55ce044abe33bf14cedea26295e1b6d4c9fde60", canonicalBlockHash: "0x5a1cbd6b472206d2c695f4960d177e5b78188ac277c441f4a60da71ce7ede3fa", framePath: Object.freeze(["0", "3", "4"]), frameSelector: "0xa6417ed6", frameTarget: "0xfe0a8e9d60131404ffaee95b48ebf908f4d8d808", eventEmitter: "0xfe0a8e9d60131404ffaee95b48ebf908f4d8d808", eventTopic0: "0xd013ca23e77a65003c2c659c5442c00c805371b7fc1ebd4c206c41d1536bd90b", eventLogIndex: "0x1d7" }),
  Object.freeze({ family: "dodo-v2", variant: "sell-quote", manifestRoot: "0x4c05aa01aaf0c63d2becccc367e49442268fb3bf5f5be0c071b8292ae0ca3b99", txHash: "0xdc52761ffb79eaf37df696b3ed0eff0e7befbec224caaecf61a7a68f0e2cdfc4", canonicalBlockHash: "0x90e8b454a84230787647ae09c34238823904c38a53329b9a5e6c55b896c0b84c", framePath: Object.freeze(["0", "3", "10"]), frameSelector: "0xdd93f59a", frameTarget: "0xa057613074e335acbfedb364573f53f3801399be", eventEmitter: "0xa057613074e335acbfedb364573f53f3801399be", eventTopic0: "0xc2c0245e056d5fb095f04cd6373bc770802ebd1e6c918eb78fdef843cdb37b0f", eventLogIndex: "0x25e" }),
  Object.freeze({ family: "fluid-dex", variant: "swap-in", manifestRoot: "0x9bd03723469a26ceb826038783348a5577d31c72f548a864545104f71917f4b3", txHash: "0xbd30e0b400d101183b52154c37b085f8a5a0cd35929ffbbf3d3d5145adb14ab6", canonicalBlockHash: "0x154711a7d062ba8c9f38a7aece109beccc079384b6c7f0d3ab75929c77e0c6a7", framePath: Object.freeze(["0", "5", "1", "2"]), frameSelector: "0x2668dfaa", frameTarget: "0x667701e51b4d1ca244f17c78f7ab8744b4c99f9b", eventEmitter: "0x667701e51b4d1ca244f17c78f7ab8744b4c99f9b", eventTopic0: "0xdc004dbca4ef9c966218431ee5d9133d337ad018dd5b5c5493722803f75c64f7", eventLogIndex: "0x277" }),
  Object.freeze({ family: "univ4", variant: "pool-manager-exact-input", manifestRoot: "0x40ccc7c1024ad205fe5fbdd6fdb851788d03479721aa3b52590b94efc066976c", txHash: "0x3db0570bd5e80759d43344842f655cab0a3954cfc24132276aa0741dd09cf5ca", canonicalBlockHash: "0x6c4964b47c2cf9a1b82cc63f01083c18f30961ed85357a43b83bb9e970b40644", framePath: Object.freeze(["2", "0", "0"]), frameSelector: "0xf3cd914c", frameTarget: "0x000000000004444c5dc75cb358380d2e3de08a90", eventEmitter: "0x000000000004444c5dc75cb358380d2e3de08a90", eventTopic0: V4_SWAP_TOPIC, eventLogIndex: "0x46c", poolId: "0x6b3a2464096ca6decb7832b6dd729626b13b9edaa1fa4c7c1edfc8ecf8d0bf55", executionAdapter: "0x3e8282bd1bfabd23249701e978e9db3df3d7073a", unlockFramePath: Object.freeze(["2"]), unlockFrameSelector: "0x48c89491", unlockFrameTarget: "0x000000000004444c5dc75cb358380d2e3de08a90", callbackFramePath: Object.freeze(["2", "0"]), callbackFrameSelector: "0x91dd7346", callbackFrameTarget: "0x3e8282bd1bfabd23249701e978e9db3df3d7073a" }),
  Object.freeze({ family: "angstrom-v4", variant: "official-adapter-hook-aware-exact-input", manifestRoot: "0xffaef59267211e4839e946e42317f923a0a9ed762f2991ab0737da1ee5d64787", txHash: "0x9c4c0a7d0fb210d02779e0cb5cc2ba637c3d7e68cb30374ed3c5bc83a64db457", canonicalBlockHash: "0x899b1d8a74772c9060405fd37577c08e31063cb4a067ac951604b42f4378d7c8", framePath: Object.freeze(["0", "2", "2", "0", "2", "3"]), frameSelector: "0xa88f90c1", frameTarget: "0xb535aeb27335b91e1b5bccbd64888ba7574efbf8", eventEmitter: "0x000000000004444c5dc75cb358380d2e3de08a90", eventTopic0: V4_SWAP_TOPIC, eventLogIndex: "0xcf", poolId: "0x90078845bceb849b171873cfbc92db8540e9c803ff57d9d21b1215ec158e79b3", officialAdapter: "0xb535aeb27335b91e1b5bccbd64888ba7574efbf8", hook: "0x0000000aa232009084bd71a5797d089aa4edfad4", innerFramePath: Object.freeze(["0", "2", "2", "0", "2", "3", "0", "0", "0"]), innerFrameSelector: "0xf3cd914c", innerFrameTarget: "0x000000000004444c5dc75cb358380d2e3de08a90", locatorEventTopic0: "0x1b3d7edb2e9c0b0e7c525b20aaaef0f5940d2ed71663c7d39266ecafac728859", locatorEventLogIndex: "0xd0", executionAdapter: "0xb535aeb27335b91e1b5bccbd64888ba7574efbf8", unlockFramePath: Object.freeze(["0", "2", "2", "0", "2", "3", "0"]), unlockFrameSelector: "0x48c89491", unlockFrameTarget: "0x000000000004444c5dc75cb358380d2e3de08a90", callbackFramePath: Object.freeze(["0", "2", "2", "0", "2", "3", "0", "0"]), callbackFrameSelector: "0x91dd7346", callbackFrameTarget: "0xb535aeb27335b91e1b5bccbd64888ba7574efbf8" }),
]);

export const HISTORICAL_FAMILY_ADVISORY_MATRIX_SPEC_DIGEST_V1 = hashDomain("aloha/historical-family-variant-advisory-matrix-spec/v1", Object.freeze({ advisoryOnly: true, specimenBinding: "exact-manifest-tx-block-frame-event-and-v4-context", axes: Object.freeze(["selector-shape", "reverse-identity", "variant", "current-action-binding", "effects-fork-replay"]), noInference: "earlier axes never imply effects or qualification" }));

const SOURCES: Readonly<Record<HistoricalSpecimenFamilyV1, readonly string[]>> = Object.freeze({
  "curve-underlying": Object.freeze(["../../../families/curve-underlying/src/action.ts", "../../../families/curve-underlying/src/manifest.ts", "../../../families/curve-underlying/src/search-adapter.ts"]),
  "dodo-v2": Object.freeze(["../../../families/dodo-v2/src/action.ts", "../../../families/dodo-v2/src/manifest.ts", "../../../families/dodo-v2/src/search-adapter.ts"]),
  "fluid-dex": Object.freeze(["../../../families/fluid-dex/src/abi.ts", "../../../families/fluid-dex/src/action-contract.ts", "../../../families/fluid-dex/src/search-adapter.ts"]),
  univ4: Object.freeze(["../../../families/univ4/src/abi.ts", "../../../families/univ4/src/action-contract.ts", "../../../families/univ4/src/search-adapter.ts"]),
  "angstrom-v4": Object.freeze(["../../../families/angstrom-v4/src/abi.ts", "../../../families/angstrom-v4/src/action-contract.ts", "../../../families/angstrom-v4/src/search-adapter.ts"]),
});
const ACTION_HASHES: Readonly<Record<HistoricalSpecimenFamilyV1, Hash>> = Object.freeze({ "curve-underlying": CURVE_UNDERLYING_ACTION_IMPLEMENTATION_HASH, "dodo-v2": DODO_V2_ACTION_IMPLEMENTATION_HASH, "fluid-dex": FLUID_DEX_ACTION_IMPLEMENTATION_HASH, univ4: UNIV4_ACTION_IMPLEMENTATION_HASH, "angstrom-v4": ANGSTROM_V4_ACTION_IMPLEMENTATION_HASH });
const DEFINITION_HASHES: Readonly<Record<HistoricalSpecimenFamilyV1, Hash>> = Object.freeze({ "curve-underlying": CURVE_UNDERLYING_FAMILY_DEFINITION_HASH, "dodo-v2": DODO_V2_FAMILY_AUTHORING_HASH, "fluid-dex": FLUID_DEX_FAMILY_DEFINITION_HASH, univ4: UNIV4_FAMILY_DEFINITION_HASH, "angstrom-v4": ANGSTROM_V4_FAMILY_DEFINITION_HASH });

export interface AdvisoryAxisV1 { readonly status: "observed" | "consistent" | "contradicted" | "unresolved"; readonly reasonCodes: readonly string[]; readonly facts: CanonicalJson | null; readonly evidenceRoot: Hash; }
export interface CurrentFamilyClosureV1 { readonly releaseDecision: "include" | "exclude"; readonly releaseExclusionReasons: readonly CurrentReleaseFamilyExclusionReasonV1[]; readonly familyDefinitionHash: Hash; readonly definitionCatalogLeafDigest: Hash | null; readonly actionOwnerRefs: readonly Hash[]; readonly actionImplementationHash: Hash; readonly implementationSourceDigest: Hash; }
export interface HistoricalFamilyAdvisoryMatrixRowV1 { readonly family: HistoricalSpecimenFamilyV1; readonly variant: HistoricalSpecimenVariantV1; readonly specimenDescriptorRoot: Hash; readonly manifestRoot: Hash; readonly txHash: Hash; readonly canonicalBlockHash: Hash; readonly frameCalldataSha256: Hash; readonly currentClosure: CurrentFamilyClosureV1; readonly selectorShape: AdvisoryAxisV1; readonly reverseIdentity: AdvisoryAxisV1; readonly variantObservation: AdvisoryAxisV1; readonly currentActionBinding: AdvisoryAxisV1; readonly effectsForkReplay: AdvisoryAxisV1; readonly qualificationStatus: "unresolved"; readonly rowRoot: Hash; }
export interface HistoricalFamilyAdvisoryMatrixV1 { readonly schemaVersion: 1; readonly kind: "aloha.historical-family-variant-advisory-matrix"; readonly advisoryOnly: true; readonly specDigest: Hash; readonly implementationDigest: Hash; readonly specimenSetRoot: Hash; readonly rows: readonly HistoricalFamilyAdvisoryMatrixRowV1[]; readonly matrixRoot: Hash; }

function fail(message: string): never { throw new TypeError(message); }
function object(value: unknown, path: string): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`expected object at ${path}`); return value as Record<string, unknown>; }
function address(value: unknown, path: string): string { if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) fail(`expected address at ${path}`); return value.toLowerCase(); }
function nonzeroAddress(value: unknown, path: string): string { const result = address(value, path); if (result === `0x${"0".repeat(40)}`) fail(`zero address at ${path}`); return result; }
function hash(value: unknown, path: string): Hash { if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) fail(`expected hash at ${path}`); return value.toLowerCase() as Hash; }
function hex(value: unknown, path: string): string { if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) fail(`expected hex at ${path}`); return value.toLowerCase(); }
function quantity(value: unknown, path: string): string { if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) fail(`expected quantity at ${path}`); return value.toLowerCase(); }
function word(value: string, index: number, path: string): bigint { const encoded = value.slice(10 + index * 64, 10 + (index + 1) * 64); if (encoded.length !== 64) fail(`truncated word at ${path}`); return BigInt(`0x${encoded}`); }
function signedWord(value: string, index: number, path: string): bigint { const raw = word(value, index, path); return raw < (1n << 255n) ? raw : raw - (1n << 256n); }
function addressWord(value: string, index: number, path: string): string { const encoded = value.slice(10 + index * 64, 10 + (index + 1) * 64); if (!/^0{24}[0-9a-f]{40}$/.test(encoded)) fail(`invalid address word at ${path}`); return `0x${encoded.slice(24)}`; }
function nonzeroAddressWord(value: string, index: number, path: string): string { return nonzeroAddress(addressWord(value, index, path), path); }
function indexedAddress(value: Hash, path: string): string { if (!/^0x0{24}[0-9a-f]{40}$/.test(value)) fail(`invalid indexed address at ${path}`); return nonzeroAddress(`0x${value.slice(26)}`, path); }
function axis(status: AdvisoryAxisV1["status"], reasonCodes: readonly string[], facts: CanonicalJson | null, evidence: unknown): AdvisoryAxisV1 { return Object.freeze({ status, reasonCodes: Object.freeze([...reasonCodes]), facts, evidenceRoot: hashDomain("aloha/historical-family-advisory-axis/v1", evidence) }); }

function frameAt(trace: CanonicalJson, path: readonly string[]): Record<string, unknown> {
  let frame = object(trace, "$.trace");
  for (const [depth, rawIndex] of path.entries()) {
    if (!/^(0|[1-9][0-9]*)$/.test(rawIndex) || !Array.isArray(frame.calls) || frame.calls[Number(rawIndex)] === undefined) fail(`missing exact frame at depth ${depth}`);
    frame = object(frame.calls[Number(rawIndex)], `$.trace.frame[${depth}]`);
    if (frame.error !== undefined || frame.revertReason !== undefined || frame.failed === true || frame.success === false) fail(`unsuccessful exact frame at depth ${depth}`);
  }
  return frame;
}

function exactFrame(trace: CanonicalJson, path: readonly string[], selector: string, target: string) {
  const frame = frameAt(trace, path); const calldata = hex(frame.input, "$.trace.selected.input");
  if (frame.type !== "CALL" || !calldata.startsWith(selector) || address(frame.to, "$.trace.selected.to") !== target) fail("exact frame selector/target mismatch");
  return Object.freeze({ frame, calldata });
}

function assertV4EntrySequence(trace: CanonicalJson, specimen: HistoricalSpecimenDescriptorV1): void {
  if (specimen.executionAdapter === undefined || specimen.unlockFramePath === undefined
    || specimen.unlockFrameSelector === undefined || specimen.unlockFrameTarget === undefined
    || specimen.callbackFramePath === undefined || specimen.callbackFrameSelector === undefined
    || specimen.callbackFrameTarget === undefined) fail("v4 entry-sequence descriptor missing");
  const unlock = exactFrame(trace, specimen.unlockFramePath, specimen.unlockFrameSelector, specimen.unlockFrameTarget);
  const callback = exactFrame(trace, specimen.callbackFramePath, specimen.callbackFrameSelector, specimen.callbackFrameTarget);
  const swapPath = specimen.family === "angstrom-v4" ? specimen.innerFramePath : specimen.framePath;
  const swapSelector = specimen.family === "angstrom-v4" ? specimen.innerFrameSelector : specimen.frameSelector;
  const swapTarget = specimen.family === "angstrom-v4" ? specimen.innerFrameTarget : specimen.frameTarget;
  if (swapPath === undefined || swapSelector === undefined || swapTarget === undefined) fail("v4 swap descriptor missing");
  const swap = exactFrame(trace, swapPath, swapSelector, swapTarget);
  if (address(unlock.frame.from, "v4.unlock.from") !== specimen.executionAdapter
    || address(callback.frame.from, "v4.callback.from") !== specimen.unlockFrameTarget
    || address(callback.frame.to, "v4.callback.to") !== specimen.executionAdapter
    || address(swap.frame.from, "v4.swap.from") !== specimen.executionAdapter) {
    fail("v4 unlock/callback/swap caller sequence mismatch");
  }
}

function exactLog(receipt: CanonicalJson, emitter: string, topic0: Hash, index: string) {
  const raw = object(receipt, "$.receipt").logs; if (!Array.isArray(raw)) fail("receipt logs missing");
  const matches = raw.map((item, i) => object(item, `$.receipt.logs[${i}]`)).filter((item) => address(item.address, "log.address") === emitter && quantity(item.logIndex, "log.logIndex") === index && Array.isArray(item.topics) && hash(item.topics[0], "log.topic0") === topic0);
  if (matches.length !== 1) fail("exact specimen log is not unique"); return matches[0]!;
}

function logTopics(log: Record<string, unknown>): readonly Hash[] { if (!Array.isArray(log.topics)) fail("log topics missing"); return Object.freeze(log.topics.map((item, i) => hash(item, `log.topics[${i}]`))); }
function logWords(log: Record<string, unknown>, count: number): string { const data = hex(log.data, "log.data"); if (data.length !== 2 + count * 64) fail("event data word count mismatch"); return `0x00000000${data.slice(2)}`; }

function assertIdentity(specimen: HistoricalSpecimenDescriptorV1, results: Readonly<Record<"transaction" | "receipt" | "trace" | "header", CanonicalJson>>): void {
  const tx = object(results.transaction, "tx"), receipt = object(results.receipt, "receipt"), header = object(results.header, "header"), trace = object(results.trace, "trace");
  if (hash(tx.hash, "tx.hash") !== specimen.txHash || hash(tx.blockHash, "tx.blockHash") !== specimen.canonicalBlockHash || hash(receipt.transactionHash, "receipt.transactionHash") !== specimen.txHash || hash(receipt.blockHash, "receipt.blockHash") !== specimen.canonicalBlockHash || hash(header.hash, "header.hash") !== specimen.canonicalBlockHash || quantity(receipt.status, "receipt.status") !== "0x1") fail("specimen transaction/block identity mismatch");
  hash(header.stateRoot, "header.stateRoot"); const index = quantity(tx.transactionIndex, "tx.transactionIndex");
  if (quantity(receipt.transactionIndex, "receipt.transactionIndex") !== index || BigInt(index) > BigInt(Number.MAX_SAFE_INTEGER) || !Array.isArray(header.transactions) || hash(header.transactions[Number(BigInt(index))], "header.transactions[index]") !== specimen.txHash) fail("canonical transaction membership mismatch");
  if (trace.type !== "CALL" || address(trace.from, "trace.from") !== address(tx.from, "tx.from") || address(trace.to, "trace.to") !== address(tx.to, "tx.to") || hex(trace.input, "trace.input") !== hex(tx.input, "tx.input") || quantity(trace.value, "trace.value") !== quantity(tx.value, "tx.value")) fail("root trace identity mismatch");
}

function currentClosure(family: HistoricalSpecimenFamilyV1): CurrentFamilyClosureV1 {
  const decisions = currentReleaseFamilyDecisions().filter((item) => item.familyId === family); if (decisions.length !== 1) fail(`release decision unavailable for ${family}`); const decision = decisions[0]!;
  const entries = FAMILY_CATALOG.entries.filter((entry) => entry.familyId === family), expectedCount = decision.decision === "include" ? 1 : 0; if (entries.length !== expectedCount) fail(`catalog binding disagrees with release decision for ${family}`); const entry = entries[0] ?? null, familyDefinitionHash = DEFINITION_HASHES[family]; if (entry !== null && entry.familyDefinitionHash !== familyDefinitionHash) fail(`catalog definition disagrees with current source for ${family}`);
  const files = SOURCES[family].map((path) => Object.freeze({ path, sha256: sha256Hex(readFileSync(fileURLToPath(new URL(path, import.meta.url)))) }));
  return Object.freeze({ releaseDecision: decision.decision, releaseExclusionReasons: Object.freeze([...decision.exclusionReasons]), familyDefinitionHash, definitionCatalogLeafDigest: entry === null ? null : entry.definitionCatalogLeafDigest as Hash, actionOwnerRefs: Object.freeze(entry?.actionOwnerRefs.map((value) => value as Hash) ?? []), actionImplementationHash: ACTION_HASHES[family], implementationSourceDigest: hashDomain("aloha/historical-family-current-action-source-closure/v1", Object.freeze(files)) });
}

interface DecodedFacts { readonly direction: CanonicalJson; readonly amounts: CanonicalJson; readonly logFacts: CanonicalJson; readonly selectorReasons: readonly string[]; readonly actionStatus: "consistent" | "contradicted" | "unresolved"; readonly actionReasons: readonly string[]; readonly actionFacts: CanonicalJson; readonly reverseFacts: CanonicalJson | null; readonly reverseReasons: readonly string[]; }
function fourWords(calldata: string, selector: string): readonly bigint[] { if (!calldata.startsWith(selector) || calldata.length !== 10 + 4 * 64) fail("four-word calldata mismatch"); return Object.freeze([0, 1, 2, 3].map((i) => word(calldata, i, "calldata"))); }

function curve(calldata: string, log: Record<string, unknown>): DecodedFacts {
  const [i, j, amountIn, minOut] = fourWords(calldata, "0xa6417ed6"), data = logWords(log, 4), soldId = word(data, 0, "curve.soldId"), sold = word(data, 1, "curve.sold"), boughtId = word(data, 2, "curve.boughtId"), bought = word(data, 3, "curve.bought"), topics = logTopics(log);
  if (topics.length !== 2) fail("Curve event topic count mismatch"); const buyer = indexedAddress(topics[1]!, "curve.buyer");
  if (i !== soldId || j !== boughtId || i === j || amountIn !== sold || amountIn === 0n || bought === 0n || bought < minOut) fail("Curve calldata/event join mismatch");
  const currentShape = CURVE_UNDERLYING_I128_SELECTOR === "0xa6417ed6";
  return { direction: { indexIn: i.toString(), indexOut: j.toString() }, amounts: { amountIn: amountIn.toString(), minAmountOut: minOut.toString(), observedAmountOut: bought.toString() }, logFacts: { emitter: address(log.address, "curve.log.address"), topic0: topics[0]!, buyer }, selectorReasons: ["exact-i128-selector-and-four-word-shape"], actionStatus: "unresolved", actionReasons: [currentShape ? "current-i128-encoder-shape-match" : "current-i128-selector-differs", "current-search-adapter-uses-quoted-output-as-minimum", "historical-minimum-is-zero"], actionFacts: { selectorShapeRepresentable: currentShape, historicalMinAmountOut: minOut.toString(), currentMinAmountOutPolicy: "quote.amountOut" }, reverseFacts: null, reverseReasons: ["metaregistry-reverse-identity-not-observed-in-this-bundle"] };
}

function dodo(calldata: string, log: Record<string, unknown>): DecodedFacts {
  if (!calldata.startsWith("0xdd93f59a") || calldata.length !== 74) fail("DODO sellQuote calldata mismatch"); const receiver = nonzeroAddressWord(calldata, 0, "dodo.receiver"), data = logWords(log, 6), soldToken = nonzeroAddressWord(data, 0, "dodo.soldToken"), boughtToken = nonzeroAddressWord(data, 1, "dodo.boughtToken"), sold = word(data, 2, "dodo.sold"), bought = word(data, 3, "dodo.bought"), seller = nonzeroAddressWord(data, 4, "dodo.seller"), eventReceiver = nonzeroAddressWord(data, 5, "dodo.eventReceiver"), topics = logTopics(log); if (topics.length !== 1 || soldToken === boughtToken || sold === 0n || bought === 0n || eventReceiver !== receiver) fail("DODO calldata/event join mismatch"); const current = DODO_V2_SELL_QUOTE_SELECTOR === "0xdd93f59a";
  return { direction: { variant: "sell-quote", soldToken, boughtToken }, amounts: { soldAmount: sold.toString(), boughtAmount: bought.toString() }, logFacts: { emitter: address(log.address, "dodo.log.address"), topic0: topics[0]!, seller, receiver: eventReceiver }, selectorReasons: ["exact-sell-quote-selector-and-receiver-shape"], actionStatus: "unresolved", actionReasons: [current ? "current-sell-quote-selector-shape-match" : "current-sell-quote-selector-differs", "current-action-builder-and-target-not-compared"], actionFacts: { receiver, selectorShapeRepresentable: current, exactHistoricalBytesRepresentable: false }, reverseFacts: null, reverseReasons: ["factory-creation-reverse-identity-not-observed-in-this-bundle"] };
}

function fluid(calldata: string, log: Record<string, unknown>): DecodedFacts {
  const [rawDirection, amountIn, minOut] = fourWords(calldata, "0x2668dfaa"); if (rawDirection !== 0n && rawDirection !== 1n) fail("Fluid direction invalid"); const recipient = nonzeroAddressWord(calldata, 3, "fluid.recipient"), data = logWords(log, 4), eventDirection = word(data, 0, "fluid.event.direction"), eventIn = word(data, 1, "fluid.event.amountIn"), eventOut = word(data, 2, "fluid.event.amountOut"), eventRecipient = nonzeroAddressWord(data, 3, "fluid.event.recipient"), topics = logTopics(log); if (topics.length !== 1 || (eventDirection !== 0n && eventDirection !== 1n) || rawDirection !== eventDirection || amountIn === 0n || eventOut === 0n || amountIn !== eventIn || eventOut < minOut || recipient !== eventRecipient) fail("Fluid calldata/event join mismatch"); const exactShape = FLUID_DEX_SWAP_IN_SELECTOR === "0x2668dfaa" && encodeSwapInCall(rawDirection === 1n, amountIn.toString(), minOut.toString(), recipient) === calldata;
  return { direction: { swap0to1: rawDirection === 1n }, amounts: { amountIn: amountIn.toString(), minAmountOut: minOut.toString(), observedAmountOut: eventOut.toString() }, logFacts: { emitter: address(log.address, "fluid.log.address"), topic0: topics[0]! }, selectorReasons: ["exact-swap-in-selector-and-four-word-shape"], actionStatus: "unresolved", actionReasons: [exactShape ? "current-swap-in-encoder-shape-match" : "current-swap-in-encoder-differs", "current-search-adapter-uses-quoted-output-as-minimum", "historical-minimum-is-zero"], actionFacts: { recipient, selectorShapeRepresentable: exactShape, historicalMinAmountOut: minOut.toString(), currentMinAmountOutPolicy: "quote.observedAmountOut" }, reverseFacts: null, reverseReasons: ["factory-reverse-identity-not-observed-in-this-bundle"] };
}

export interface HistoricalPoolManagerSwapShapeV1 { readonly key: Univ4PoolKey; readonly zeroForOne: boolean; readonly amountIn: bigint; readonly hookDataLength: bigint; }
export function decodeHistoricalPoolManagerSwapV1(calldata: string): HistoricalPoolManagerSwapShapeV1 {
  if (!calldata.startsWith("0xf3cd914c") || (calldata.length - 10) % 64 !== 0 || calldata.length < 10 + 10 * 64) fail("PoolManager.swap shape mismatch"); const direction = word(calldata, 5, "v4.direction"), amountSpecified = signedWord(calldata, 6, "v4.amountSpecified"), offset = word(calldata, 8, "v4.hookData.offset"), length = word(calldata, 9, "v4.hookData.length"); if ((direction !== 0n && direction !== 1n) || amountSpecified >= 0n || offset !== 288n || length > BigInt(Number.MAX_SAFE_INTEGER) || calldata.length !== 10 + (10 + Math.ceil(Number(length) / 32)) * 64) fail("PoolManager exact-input/hookData encoding mismatch");
  const dataStart = 10 + 10 * 64, dataEnd = dataStart + Number(length) * 2;
  if (!/^0*$/.test(calldata.slice(dataEnd))) fail("PoolManager hookData padding is non-zero");
  return { key: Object.freeze({ currency0: addressWord(calldata, 0, "v4.currency0"), currency1: addressWord(calldata, 1, "v4.currency1"), fee: word(calldata, 2, "v4.fee").toString(), tickSpacing: signedWord(calldata, 3, "v4.tickSpacing").toString(), hooks: addressWord(calldata, 4, "v4.hooks") }), zeroForOne: direction === 1n, amountIn: -amountSpecified, hookDataLength: length };
}
function v4Event(log: Record<string, unknown>, poolId: Hash) { const topics = logTopics(log); if (topics.length !== 3 || topics[1] !== poolId) fail("v4 Swap poolId mismatch"); const data = logWords(log, 6); return Object.freeze({ amount0: signedWord(data, 0, "v4.event.amount0"), amount1: signedWord(data, 1, "v4.event.amount1"), topics }); }

function univ4(calldata: string, log: Record<string, unknown>, specimen: HistoricalSpecimenDescriptorV1): DecodedFacts {
  if (specimen.poolId === undefined) fail("UniV4 specimen poolId missing"); const decoded = decodeHistoricalPoolManagerSwapV1(calldata), event = v4Event(log, specimen.poolId); if (decoded.key.hooks !== "0x0000000000000000000000000000000000000000" || univ4PoolId(decoded.key) !== specimen.poolId) fail("UniV4 pool identity mismatch"); const encoded = encodeUniv4Swap(decoded.key, decoded.zeroForOne, decoded.amountIn.toString()), exact = encoded === calldata && UNIV4_POOL_MANAGER.toLowerCase() === specimen.frameTarget && UNIV4_SWAP_SELECTOR === specimen.frameSelector;
  return { direction: { zeroForOne: decoded.zeroForOne, variant: "exact-input" }, amounts: { amountIn: decoded.amountIn.toString(), eventAmount0: event.amount0.toString(), eventAmount1: event.amount1.toString() }, logFacts: { emitter: address(log.address, "univ4.log.address"), topic0: event.topics[0]!, poolId: specimen.poolId }, selectorReasons: ["pool-manager-swap-324-byte-shape-observed", "unlock-callback-swap-entry-sequence-observed"], actionStatus: "contradicted", actionReasons: [exact ? "inner-swap-encoder-exact-match" : "current-parameter-policy-not-byte-identical", "historical-entry-sequence-is-unlock-callback-swap", "current-template-emits-direct-manager-swap", "missing-unlock-callback"], actionFacts: { historicalByteLength: String((calldata.length - 2) / 2), currentByteLength: String((encoded.length - 2) / 2), exactHistoricalBytesRepresentable: exact, historicalEntrySequence: ["unlock", "callback", "swap"], currentEntrySequence: ["direct-swap"] }, reverseFacts: { manager: specimen.frameTarget, poolId: specimen.poolId, derivedPoolId: univ4PoolId(decoded.key) }, reverseReasons: ["pool-key-hash-and-manager-event-observed", "initialize-history-not-in-this-bundle"] };
}

function angstrom(outer: ReturnType<typeof exactFrame>, inner: ReturnType<typeof exactFrame>, log: Record<string, unknown>, locator: Record<string, unknown>, specimen: HistoricalSpecimenDescriptorV1): DecodedFacts {
  if (specimen.poolId === undefined || specimen.officialAdapter === undefined || specimen.hook === undefined) fail("Angstrom specimen context missing"); const decoded = decodeHistoricalPoolManagerSwapV1(inner.calldata), event = v4Event(log, specimen.poolId); if (address(outer.frame.to, "angstrom.outer.to") !== specimen.officialAdapter || address(inner.frame.from, "angstrom.inner.from") !== specimen.officialAdapter || decoded.key.hooks !== specimen.hook || decoded.key.hooks !== ANGSTROM_MAINNET_HOOK.toLowerCase() || angstromPoolId(decoded.key) !== specimen.poolId || event.topics[2] !== (`0x${"0".repeat(24)}${specimen.officialAdapter.slice(2)}` as Hash) || logTopics(locator)[0] !== specimen.locatorEventTopic0) fail("Angstrom adapter/hook/pool event binding mismatch"); const current = encodeAngstromSwap(decoded.key as AngstromV4PoolKey, decoded.zeroForOne, decoded.amountIn.toString()); if (ANGSTROM_V4_POOL_MANAGER.toLowerCase() !== specimen.innerFrameTarget || ANGSTROM_V4_SWAP_SELECTOR !== specimen.innerFrameSelector) fail("current Angstrom manager binding differs");
  return { direction: { zeroForOne: decoded.zeroForOne, variant: "hook-aware-exact-input" }, amounts: { amountIn: decoded.amountIn.toString(), eventAmount0: event.amount0.toString(), eventAmount1: event.amount1.toString() }, logFacts: { emitter: address(log.address, "angstrom.log.address"), topic0: event.topics[0]!, poolId: specimen.poolId, locatorTopic0: logTopics(locator)[0]! }, selectorReasons: ["official-adapter-selector-observed", "inner-pool-manager-swap-shape-observed", "unlock-callback-swap-entry-sequence-observed"], actionStatus: "contradicted", actionReasons: ["historical-official-adapter-to-manager-path-is-420-bytes-inner", "current-direct-manager-empty-hook-data-path-is-324-bytes", "historical-entry-sequence-is-unlock-callback-swap", "current-template-emits-direct-manager-swap", "missing-unlock-callback", "execution-context-unproven"], actionFacts: { historicalOuterByteLength: String((outer.calldata.length - 2) / 2), historicalInnerByteLength: String((inner.calldata.length - 2) / 2), currentInnerByteLength: String((current.length - 2) / 2), historicalHookDataLength: decoded.hookDataLength.toString(), currentHookDataLength: "0", exactHistoricalBytesRepresentable: current === inner.calldata, historicalEntrySequence: ["unlock", "callback", "swap"], currentEntrySequence: ["direct-swap"] }, reverseFacts: { manager: specimen.innerFrameTarget, poolId: specimen.poolId, derivedPoolId: angstromPoolId(decoded.key), hook: decoded.key.hooks, officialAdapter: specimen.officialAdapter }, reverseReasons: ["pool-key-hash-hook-and-manager-event-observed", "initialize-history-not-in-this-bundle"] };
}

function row(rootDirectory: string, specimen: HistoricalSpecimenDescriptorV1): HistoricalFamilyAdvisoryMatrixRowV1 {
  const bundle = loadHistoricalFamilyFactBundleV1(rootDirectory, specimen.manifestRoot); if (bundle.manifest.txHash !== specimen.txHash || bundle.manifest.canonicalBlockHash !== specimen.canonicalBlockHash) fail("manifest/specimen descriptor mismatch"); assertIdentity(specimen, bundle.results); if (specimen.family === "univ4" || specimen.family === "angstrom-v4") assertV4EntrySequence(bundle.results.trace, specimen); const selected = exactFrame(bundle.results.trace, specimen.framePath, specimen.frameSelector, specimen.frameTarget), event = exactLog(bundle.results.receipt, specimen.eventEmitter, specimen.eventTopic0, specimen.eventLogIndex); let decoded: DecodedFacts;
  if (specimen.family === "curve-underlying") decoded = curve(selected.calldata, event); else if (specimen.family === "dodo-v2") decoded = dodo(selected.calldata, event); else if (specimen.family === "fluid-dex") decoded = fluid(selected.calldata, event); else if (specimen.family === "univ4") decoded = univ4(selected.calldata, event, specimen); else { if (specimen.innerFramePath === undefined || specimen.innerFrameSelector === undefined || specimen.innerFrameTarget === undefined || specimen.locatorEventTopic0 === undefined || specimen.locatorEventLogIndex === undefined) fail("Angstrom inner descriptor missing"); const inner = exactFrame(bundle.results.trace, specimen.innerFramePath, specimen.innerFrameSelector, specimen.innerFrameTarget), locator = exactLog(bundle.results.receipt, specimen.eventEmitter, specimen.locatorEventTopic0, specimen.locatorEventLogIndex); decoded = angstrom(selected, inner, event, locator, specimen); }
  const descriptorRoot = hashDomain("aloha/historical-family-specimen-descriptor/v1", specimen), frameCalldataSha256 = sha256Hex(Uint8Array.from(Buffer.from(selected.calldata.slice(2), "hex"))), current = currentClosure(specimen.family);
  const body = Object.freeze({ family: specimen.family, variant: specimen.variant, specimenDescriptorRoot: descriptorRoot, manifestRoot: specimen.manifestRoot, txHash: specimen.txHash, canonicalBlockHash: specimen.canonicalBlockHash, frameCalldataSha256, currentClosure: current, selectorShape: axis("observed", decoded.selectorReasons, { framePath: specimen.framePath, selector: specimen.frameSelector, target: specimen.frameTarget, calldataByteLength: String((selected.calldata.length - 2) / 2) }, { descriptorRoot, frameCalldataSha256 }), reverseIdentity: axis("unresolved", decoded.reverseReasons, decoded.reverseFacts, { descriptorRoot, reverseFacts: decoded.reverseFacts }), variantObservation: axis("observed", ["direction-amounts-and-transaction-event-joined"], { direction: decoded.direction, amounts: decoded.amounts, log: decoded.logFacts }, { descriptorRoot, direction: decoded.direction, amounts: decoded.amounts, log: decoded.logFacts }), currentActionBinding: axis(decoded.actionStatus, decoded.actionReasons, decoded.actionFacts, { descriptorRoot, current, actionFacts: decoded.actionFacts }), effectsForkReplay: axis("unresolved", ["callTracer-and-receipt-logs-do-not-prove-token-account-state-effects", "no-pinned-fork-replay-in-this-report"], null, { descriptorRoot, requirement: "independent-state-effects-and-pinned-fork-replay" }), qualificationStatus: "unresolved" as const });
  return Object.freeze({ ...body, rowRoot: hashDomain("aloha/historical-family-variant-advisory-row/v1", body) });
}

export const HISTORICAL_FAMILY_ADVISORY_MATRIX_IMPLEMENTATION_DIGEST_V1 = hashDomain("aloha/historical-family-variant-advisory-matrix-implementation/v1", Object.freeze({ sourceSha256: sha256Hex(readFileSync(fileURLToPath(import.meta.url))), loaderSha256: sha256Hex(readFileSync(fileURLToPath(new URL("../../reference-only/historical-family-facts/src/index.ts", import.meta.url)))) }));

export function buildHistoricalFamilyAdvisoryMatrixV1(rootDirectory: string, specimens: readonly HistoricalSpecimenDescriptorV1[] = HISTORICAL_FAMILY_SPECIMENS_V1): HistoricalFamilyAdvisoryMatrixV1 {
  if (!Array.isArray(specimens) || specimens.length === 0) fail("specimen set is empty"); const descriptorRoots = specimens.map((item) => hashDomain("aloha/historical-family-specimen-descriptor/v1", item)); if (new Set(descriptorRoots).size !== descriptorRoots.length) fail("duplicate specimen descriptor"); const rows = Object.freeze(specimens.map((item) => row(rootDirectory, item))), specimenSetRoot = hashDomain("aloha/historical-family-specimen-set/v1", Object.freeze(descriptorRoots)); const body = Object.freeze({ specDigest: HISTORICAL_FAMILY_ADVISORY_MATRIX_SPEC_DIGEST_V1, implementationDigest: HISTORICAL_FAMILY_ADVISORY_MATRIX_IMPLEMENTATION_DIGEST_V1, specimenSetRoot, rowRoots: Object.freeze(rows.map((item) => item.rowRoot)) });
  return Object.freeze({ schemaVersion: 1, kind: "aloha.historical-family-variant-advisory-matrix", advisoryOnly: true, specDigest: HISTORICAL_FAMILY_ADVISORY_MATRIX_SPEC_DIGEST_V1, implementationDigest: HISTORICAL_FAMILY_ADVISORY_MATRIX_IMPLEMENTATION_DIGEST_V1, specimenSetRoot, rows, matrixRoot: hashDomain("aloha/historical-family-variant-advisory-matrix/v1", body) });
}

export function materializeHistoricalFamilyAdvisoryMatrixV1(rootDirectory: string, matrix: HistoricalFamilyAdvisoryMatrixV1): string {
  const expected = buildHistoricalFamilyAdvisoryMatrixV1(rootDirectory); if (!Buffer.from(encodeCanonicalBytes(matrix)).equals(Buffer.from(encodeCanonicalBytes(expected)))) fail("advisory matrix does not exactly match a rebuild from immutable raw specimens");
  const directory = resolve(rootDirectory, "reports"); mkdirSync(directory, { recursive: true, mode: 0o700 }); const directoryStat = lstatSync(directory); if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail("report directory is unsafe"); const path = join(directory, `${expected.matrixRoot.slice(2)}.json`), bytes = encodeCanonicalBytes(expected);
  try { const descriptor = openSync(path, "wx", 0o600); try { writeFileSync(descriptor, bytes); } finally { closeSync(descriptor); } } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || !readFileSync(path).equals(Buffer.from(bytes))) fail("immutable advisory matrix changed"); }
  return path;
}

export function loadHistoricalFamilyAdvisoryMatrixV1(rootDirectory: string, expectedMatrixRoot: Hash): HistoricalFamilyAdvisoryMatrixV1 {
  const matrixRoot = hash(expectedMatrixRoot, "$.expectedMatrixRoot"), expected = buildHistoricalFamilyAdvisoryMatrixV1(rootDirectory); if (expected.matrixRoot !== matrixRoot) fail("requested advisory matrix root is not current for the immutable raw specimens");
  const path = join(resolve(rootDirectory, "reports"), `${matrixRoot.slice(2)}.json`), stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) fail("advisory matrix path is not a regular file"); const bytes = readFileSync(path); let decoded: unknown; try { decoded = JSON.parse(bytes.toString("utf8")); } catch { fail("advisory matrix is not valid JSON"); }
  if (!Buffer.from(encodeCanonicalBytes(decoded as CanonicalJson)).equals(bytes) || !Buffer.from(encodeCanonicalBytes(decoded as CanonicalJson)).equals(Buffer.from(encodeCanonicalBytes(expected)))) fail("advisory matrix bytes do not exactly match a rebuild from immutable raw specimens"); return expected;
}
