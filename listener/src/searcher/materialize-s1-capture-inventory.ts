import { readFile, writeFile } from "node:fs/promises";
import { ethers } from "ethers";
import type { FamilyId } from "./venues/adapter-family-identifiers.js";
import type {
  FamilyCandidate,
  UnifiedObservation,
} from "./venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import type { CanonicalValue } from "./venues/canonical-value.js";
import type {
  FamilyCapabilityCatalog,
  LoadedFamilyBox,
} from "./venues/family-capability-catalog.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "./venues/production-family-composition.js";

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const LOG_PAGE_SPAN = 100_000;
const RPC_URL = process.env.S1_CAPTURE_RPC_URL ?? "http://127.0.0.1:8545";

interface RawArtifacts {
  readonly graph: unknown;
  readonly protocolCache: unknown;
}

export interface CaptureInventoryEntry {
  readonly familyId: FamilyId;
  readonly candidateIdentity: string;
  readonly observation: UnifiedObservation;
}

export interface CaptureInventoryFile {
  readonly format: "s1-catalog-capture-inventory-v1";
  readonly catalogHash: string;
  readonly source: CanonicalSource;
  readonly entries: readonly CaptureInventoryEntry[];
  readonly unresolved: readonly {
    readonly familyId: FamilyId;
    readonly reason: string;
  }[];
}

export interface CaptureInventoryProvider {
  getCode(address: string, blockTag: number): Promise<string>;
  getStorage(address: string, slot: string, blockTag: number): Promise<string>;
  getLogs(filter: {
    readonly address?: string;
    readonly fromBlock: number;
    readonly toBlock: number;
    readonly topics: readonly (string | null)[];
  }): Promise<readonly {
    readonly address: string;
    readonly topics: readonly string[];
    readonly data: string;
    readonly transactionHash?: string;
  }[]>;
  getTransactionReceipt(hash: string): Promise<{
    readonly blockNumber: number;
    readonly logs: readonly {
      readonly index?: number;
      readonly logIndex?: number;
      readonly address: string;
      readonly topics: readonly string[];
      readonly data: string;
      readonly transactionHash?: string;
    }[];
  } | null>;
  traceTransaction(hash: string): Promise<unknown>;
}

/**
 * Turns generic node artifacts into catalog-owned observations. Raw artifact
 * labels are deliberately ignored: an address or transaction enters a Family
 * only when generated catalog matching plus plugin-local decodeCandidate agree.
 */
export async function materializeCaptureInventory(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly source: CanonicalSource;
  readonly rawArtifacts: RawArtifacts;
  readonly provider: CaptureInventoryProvider;
}): Promise<CaptureInventoryFile> {
  const transactionHashes = rawTransactionHashes(input.rawArtifacts);
  const observations = [
    ...await addressObservations(input),
    ...await transactionObservations({ ...input, transactionHashes }),
  ];
  const byFamily = new Map<FamilyId, CaptureInventoryEntry>();
  admitObservations(input.catalog, observations, byFamily);
  const unresolvedFamilies = new Set(input.catalog.listAll().flatMap((family) =>
    "discovery" in family.plugin && !byFamily.has(family.plugin.manifest.familyId)
      ? [family.plugin.manifest.familyId]
      : []
  ));
  if (unresolvedFamilies.size !== 0) {
    admitObservations(
      input.catalog,
      await declaredLogObservations({ ...input, unresolvedFamilies }),
      byFamily,
    );
  }
  const discoveryIds = input.catalog.listAll().flatMap((family) =>
    "discovery" in family.plugin ? [family.plugin.manifest.familyId] : []
  );
  const unresolved = discoveryIds.filter((familyId) => !byFamily.has(familyId))
    .map((familyId) => Object.freeze({
      familyId,
      reason: "no raw nomination produced a plugin-decodable observation",
    }));
  return Object.freeze({
    format: "s1-catalog-capture-inventory-v1" as const,
    catalogHash: input.catalog.catalogHash,
    source: input.source,
    entries: Object.freeze([...byFamily.values()].sort((left, right) =>
      left.familyId.localeCompare(right.familyId)
    )),
    unresolved: Object.freeze(unresolved.sort((left, right) =>
      left.familyId.localeCompare(right.familyId)
    )),
  });
}

function admitObservations(
  catalog: FamilyCapabilityCatalog,
  observations: readonly UnifiedObservation[],
  byFamily: Map<FamilyId, CaptureInventoryEntry>,
): void {
  for (const observation of observations) {
    for (const match of catalog.matches(observation)) {
      if (byFamily.has(match.familyId)) continue;
      const family = catalog.forStrictFamily(match.familyId);
      if (!("discovery" in family.plugin)) continue;
      const candidate = family.plugin.discovery.decodeCandidate({
        observation,
        matchedPatternId: match.patternId,
      });
      if (candidate === null) continue;
      const candidateIdentity = captureCandidateIdentity(
        family,
        candidate,
        observation,
      );
      if (candidateIdentity === null) continue;
      byFamily.set(match.familyId, Object.freeze({
        familyId: match.familyId,
        candidateIdentity,
        observation,
      }));
    }
  }
}

async function addressObservations(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly source: CanonicalSource;
  readonly rawArtifacts: RawArtifacts;
  readonly provider: CaptureInventoryProvider;
}): Promise<readonly UnifiedObservation[]> {
  const observations: UnifiedObservation[] = [];
  for (const nomination of rawAddressNominations(
    input.rawArtifacts,
    input.catalog,
  )) {
    try {
      const [code, implementationWord] = await Promise.all([
        input.provider.getCode(nomination.address, input.source.number),
        input.provider.getStorage(
          nomination.address,
          EIP1967_IMPLEMENTATION_SLOT,
          input.source.number,
        ),
      ]);
      if (!ethers.isHexString(code) || code === "0x") continue;
      const family = input.catalog.forStrictFamily(nomination.familyId);
      const fingerprints = "discovery" in family.plugin
        ? Object.freeze((family.plugin.discovery.addressSurfaces ?? [])
          .filter((pattern) => pattern.kind === "interface")
          .map((pattern) => pattern.fingerprint))
        : Object.freeze([]);
      observations.push(Object.freeze({
        kind: "address-surface" as const,
        source: input.source,
        address: nomination.address,
        codeHash: ethers.keccak256(code),
        implementationWord: ethers.zeroPadValue(implementationWord, 32)
          .toLowerCase(),
        interfaceFingerprints: fingerprints,
      }));
    } catch {
      // A raw nomination is not authority. One unreadable address must not
      // prevent other catalog candidates from being materialized.
    }
  }
  return Object.freeze(observations);
}

async function transactionObservations(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly source: CanonicalSource;
  readonly transactionHashes: readonly string[];
  readonly provider: CaptureInventoryProvider;
}): Promise<readonly UnifiedObservation[]> {
  const observations: UnifiedObservation[] = [];
  for (const hash of input.transactionHashes) {
    try {
      const receipt = await input.provider.getTransactionReceipt(hash);
      if (receipt === null || receipt.blockNumber > input.source.number) continue;
      for (const log of receipt.logs) {
        observations.push(Object.freeze({
          kind: "log" as const,
          source: input.source,
          address: ethers.getAddress(log.address).toLowerCase(),
          topics: Object.freeze(log.topics.map((topic) => topic.toLowerCase())),
          data: log.data.toLowerCase(),
          transactionHash: hash,
        }));
      }
      collectTraceCalls(
        await input.provider.traceTransaction(hash),
        input.source,
        hash,
        observations,
      );
    } catch {
      // The next evidence transaction may still close the same declaration.
    }
  }
  return Object.freeze(observations);
}

async function declaredLogObservations(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly source: CanonicalSource;
  readonly provider: CaptureInventoryProvider;
  readonly unresolvedFamilies: ReadonlySet<FamilyId>;
}): Promise<readonly UnifiedObservation[]> {
  const observations: UnifiedObservation[] = [];
  for (const family of input.catalog.listAll()) {
    if (!("discovery" in family.plugin)) continue;
    if (!input.unresolvedFamilies.has(family.plugin.manifest.familyId)) continue;
    for (const pattern of family.plugin.discovery.logPatterns ?? []) {
      const emitter = pattern.emitter;
      const log = await findLatestDecodableLog({
        family,
        patternId: pattern.id,
        provider: input.provider,
        ...(emitter === undefined || emitter.mode === "address"
          ? {}
          : { address: emitter.address }),
        topic: pattern.topic,
        fromBlock: emitter === undefined || emitter.mode === "address"
          ? Math.max(
              0,
              input.source.number - Number(
                process.env.S1_CAPTURE_LOG_LOOKBACK_BLOCKS ?? 5_000_000,
              ),
            )
          : emitter.fromBlock,
        toBlock: input.source.number,
        source: input.source,
      });
      if (log !== null) {
        observations.push(log);
        break;
      }
    }
  }
  return Object.freeze(observations);
}

async function findLatestDecodableLog(input: {
  readonly family: LoadedFamilyBox;
  readonly patternId: string;
  readonly provider: CaptureInventoryProvider;
  readonly address?: string;
  readonly topic: string;
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly source: CanonicalSource;
}): Promise<UnifiedObservation | null> {
  let toBlock = input.toBlock;
  while (toBlock >= input.fromBlock) {
    const fromBlock = Math.max(input.fromBlock, toBlock - LOG_PAGE_SPAN + 1);
    let logs: Awaited<ReturnType<CaptureInventoryProvider["getLogs"]>>;
    try {
      logs = await input.provider.getLogs({
        ...(input.address === undefined ? {} : { address: input.address }),
        fromBlock,
        toBlock,
        topics: [input.topic],
      });
    } catch {
      if (fromBlock === toBlock) return null;
      toBlock = Math.floor((fromBlock + toBlock) / 2);
      continue;
    }
    for (const raw of [...logs].reverse()) {
      const observation = logObservation(raw, input.source);
      if (!("discovery" in input.family.plugin)) return null;
      const candidate = input.family.plugin.discovery.decodeCandidate({
        observation,
        matchedPatternId: input.patternId,
      });
      if (candidate !== null) return observation;
    }
    toBlock = fromBlock - 1;
  }
  return null;
}

function logObservation(
  log: {
    readonly address: string;
    readonly topics: readonly string[];
    readonly data: string;
    readonly transactionHash?: string;
  },
  source: CanonicalSource,
): UnifiedObservation {
  return Object.freeze({
    kind: "log" as const,
    source,
    address: ethers.getAddress(log.address).toLowerCase(),
    topics: Object.freeze(log.topics.map((topic) => topic.toLowerCase())),
    data: log.data.toLowerCase(),
    ...(log.transactionHash === undefined
      ? {}
      : { transactionHash: log.transactionHash.toLowerCase() }),
  });
}

function collectTraceCalls(
  raw: unknown,
  source: CanonicalSource,
  transactionHash: string,
  output: UnifiedObservation[],
): void {
  if (raw === null || typeof raw !== "object") return;
  const frame = raw as {
    readonly to?: unknown;
    readonly from?: unknown;
    readonly input?: unknown;
    readonly calls?: unknown;
  };
  if (
    typeof frame.to === "string" && typeof frame.input === "string" &&
    ethers.isAddress(frame.to) && ethers.isHexString(frame.input)
  ) {
    output.push(Object.freeze({
      kind: "call" as const,
      source,
      target: ethers.getAddress(frame.to).toLowerCase(),
      ...(typeof frame.from === "string" && ethers.isAddress(frame.from)
        ? { sender: ethers.getAddress(frame.from).toLowerCase() }
        : {}),
      data: frame.input.toLowerCase(),
      transactionHash,
    }));
  }
  if (Array.isArray(frame.calls)) {
    for (const call of frame.calls) {
      collectTraceCalls(call, source, transactionHash, output);
    }
  }
}

function captureCandidateIdentity(
  family: LoadedFamilyBox,
  candidate: FamilyCandidate,
  observation: UnifiedObservation,
): string | null {
  const key = "discovery" in family.plugin
    ? String(family.plugin.discovery.candidateKey(candidate))
    : "";
  if (/^0x[0-9a-fA-F]{40}$/.test(key)) {
    return ethers.getAddress(key).toLowerCase();
  }
  if (/^0x[0-9a-fA-F]{64}$/.test(key)) return String(key).toLowerCase();
  if (observation.kind === "call") return observation.target;
  if (observation.kind === "log") {
    const indexed = observation.topics.find((topic, index) =>
      index > 0 && ethers.isHexString(topic, 32) &&
      /^0x0{24}[0-9a-f]{40}$/i.test(topic)
    );
    if (indexed !== undefined) return `0x${indexed.slice(-40)}`.toLowerCase();
    return observation.address;
  }
  if (observation.kind === "address-surface") return observation.address;
  return observation.factory;
}

function rawAddressNominations(
  raw: RawArtifacts,
  catalog: FamilyCapabilityCatalog,
): readonly { readonly familyId: FamilyId; readonly address: string }[] {
  const values = new Map<string, {
    readonly familyId: FamilyId;
    readonly address: string;
  }>();
  const visit = (value: unknown, inherited: FamilyId | null): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inherited);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Readonly<Record<string, unknown>>;
    const resolved = Object.values(record).reduce<FamilyId | null>(
      (current, item) => current ?? (
        typeof item === "string" ? catalogFamilyForLabel(catalog, item) : null
      ),
      inherited,
    );
    if (resolved !== null) {
      for (const item of Object.values(record)) {
        if (typeof item !== "string" || !ethers.isAddress(item)) continue;
        const address = ethers.getAddress(item).toLowerCase();
        values.set(`${resolved}\0${address}`, { familyId: resolved, address });
      }
    }
    for (const item of Object.values(record)) visit(item, resolved);
  };
  visit(raw, null);
  return Object.freeze([...values.values()].sort((left, right) =>
    left.familyId.localeCompare(right.familyId) ||
    left.address.localeCompare(right.address)
  ));
}

function catalogFamilyForLabel(
  catalog: FamilyCapabilityCatalog,
  label: string,
): FamilyId | null {
  try {
    return catalog.forStrictFamily(label as FamilyId).plugin.manifest.familyId;
  } catch {
    try {
      return catalog.ownerOfAction(label);
    } catch {
      return null;
    }
  }
}

function rawTransactionHashes(raw: RawArtifacts): readonly string[] {
  const values = new Set<string>();
  walk(raw as unknown as CanonicalValue, (key, value) => {
    if (
      (key === "txHash" || key === "transactionHash") &&
      typeof value === "string" && ethers.isHexString(value, 32)
    ) values.add(value.toLowerCase());
  });
  return Object.freeze([...values].sort());
}

function walk(
  value: CanonicalValue,
  visit: (key: string, value: CanonicalValue) => void,
  key = "",
): void {
  visit(key, value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
  } else if (value !== null && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      walk(child, visit, childKey);
    }
  }
}

async function main(): Promise<void> {
  const [graphPath, cachePath, outputPath] = process.argv.slice(2);
  if (graphPath === undefined || cachePath === undefined || outputPath === undefined) {
    throw new Error(
      "usage: materialize-s1-capture-inventory.ts " +
        "<runtime-graph-pools.json> <protocol-cache.json> <output.json>",
    );
  }
  const request = new ethers.FetchRequest(RPC_URL);
  request.timeout = Number(process.env.S1_CAPTURE_RPC_TIMEOUT_MS ?? 60_000);
  const rpc = new ethers.JsonRpcProvider(request);
  try {
    const sourceNumber = await rpc.getBlockNumber();
    const sourceBlock = await rpc.getBlock(sourceNumber);
    if (sourceBlock === null || sourceBlock.hash === null) {
      throw new Error("capture inventory source block is unavailable");
    }
    const source = Object.freeze({
      number: sourceNumber,
      hash: sourceBlock.hash.toLowerCase(),
      generation: sourceNumber,
    });
    const provider: CaptureInventoryProvider = {
      getCode: (address, block) => rpc.getCode(address, block),
      getStorage: (address, slot, block) => rpc.getStorage(address, slot, block),
      getLogs: (filter) => rpc.getLogs({ ...filter, topics: [...filter.topics] }),
      getTransactionReceipt: async (hash) => rpc.getTransactionReceipt(hash),
      traceTransaction: (hash) => rpc.send("debug_traceTransaction", [
        hash,
        { tracer: "callTracer" },
      ]),
    };
    const rawArtifacts = Object.freeze({
      graph: JSON.parse(await readFile(graphPath, "utf8")) as CanonicalValue,
      protocolCache: JSON.parse(await readFile(cachePath, "utf8")) as
        CanonicalValue,
    });
    const inventory = await materializeCaptureInventory({
      catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
      source,
      rawArtifacts,
      provider,
    });
    await writeFile(outputPath, `${JSON.stringify(inventory, null, 2)}\n`);
    process.stdout.write(
      `catalog capture inventory written: entries=${inventory.entries.length} ` +
        `unresolved=${inventory.unresolved.length}\n`,
    );
  } finally {
    rpc.destroy();
  }
}

if (process.argv[1]?.endsWith("materialize-s1-capture-inventory.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
