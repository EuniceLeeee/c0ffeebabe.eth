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
import {
  executeCatalogCaptureNominations,
} from "./venues/capture-materialization.js";

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
  call(
    transaction: { readonly to: string; readonly data: string },
    blockTag: number,
  ): Promise<string>;
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
  const byFamily = new Map<FamilyId, CaptureInventoryEntry>();
  // Phase 1: verified transaction evidence first (admit as we go).
  admitObservations(
    input.catalog,
    await transactionObservations(input),
    byFamily,
  );
  // Phase 2: plugin-owned nomination reverse materialization, one candidate
  // at a time with per-Family early stop; already-admitted Families skip.
  admitObservations(
    input.catalog,
    await executeCatalogCaptureNominations({
      catalog: input.catalog,
      source: input.source,
      nominations: opaquePoolNominations(
        input.rawArtifacts.graph as import("./venues/canonical-value.js").CanonicalValue,
      ),
      provider: nominationProvider(input.provider),
      alreadyAdmitted: new Set(byFamily.keys()),
    }),
    byFamily,
  );
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


async function transactionObservations(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly source: CanonicalSource;
  readonly rawArtifacts: RawArtifacts;
  readonly provider: CaptureInventoryProvider;
}): Promise<readonly UnifiedObservation[]> {
  const observations: UnifiedObservation[] = [];
  const groups = new Map<FamilyId, readonly string[]>();
  for (const nomination of rawTransactionNominations(
    input.rawArtifacts,
    input.catalog,
  )) {
    groups.set(nomination.familyId, Object.freeze([
      ...(groups.get(nomination.familyId) ?? []),
      nomination.transactionHash,
    ]));
  }
  await Promise.all([...groups.entries()].map(async ([familyId, hashes]) => {
    const family = input.catalog.forStrictFamily(familyId);
    if (!("discovery" in family.plugin)) return;
    const discovery = family.plugin.discovery;
    for (const hash of hashes) {
      try {
        const candidates: UnifiedObservation[] = [];
        const receipt = await input.provider.getTransactionReceipt(hash);
        if (receipt === null || receipt.blockNumber > input.source.number) continue;
        for (const log of receipt.logs) {
          candidates.push(Object.freeze({
            kind: "log" as const,
            source: input.source,
            address: ethers.getAddress(log.address).toLowerCase(),
            topics: Object.freeze(log.topics.map((topic) => topic.toLowerCase())),
            data: log.data.toLowerCase(),
            transactionHash: hash,
          }));
        }
        let accepted = candidates.find((observation) =>
          input.catalog.matches(observation).some((match) =>
            match.familyId === familyId &&
            discovery.decodeCandidate({
              observation,
              matchedPatternId: match.patternId,
            }) !== null
          )
        );
        if (accepted === undefined) {
          collectTraceCalls(
            await input.provider.traceTransaction(hash),
            input.source,
            hash,
            candidates,
          );
          accepted = candidates.find((observation) =>
            input.catalog.matches(observation).some((match) =>
              match.familyId === familyId &&
              discovery.decodeCandidate({
                observation,
                matchedPatternId: match.patternId,
              }) !== null
            )
          );
        }
        if (accepted === undefined) continue;
        observations.push(accepted);
        break;
      } catch {
        // The next evidence transaction may still close the same declaration.
      }
    }
  }));
  return Object.freeze(observations);
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

function opaquePoolNominations(
  graph: CanonicalValue,
): readonly import("./venues/adapter-family-plugin.js").CaptureNominationInput[] {
  const values = new Map<string, import("./venues/adapter-family-plugin.js").CaptureNominationInput>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Readonly<Record<string, unknown>>;
    if (
      typeof record.address === "string" &&
      ethers.isAddress(record.address) &&
      Object.keys(record).some((key) =>
        key === "adapter" || key === "venueId" || key === "adapterId"
      )
    ) {
      const address = ethers.getAddress(record.address).toLowerCase();
      values.set(address, Object.freeze({
        address,
        opaque: Object.freeze(record) as unknown as
          import("./venues/canonical-value.js").CanonicalValue,
      }));
    }
    for (const item of Object.values(record)) visit(item);
  };
  visit(graph);
  return Object.freeze([...values.values()].sort((left, right) =>
    left.address.localeCompare(right.address)
  ));
}

function nominationProvider(
  provider: CaptureInventoryProvider,
): import("./venues/adapter-family-plugin.js").CaptureNominationProvider {
  return {
    call: (transaction, blockTag) => provider.call(transaction, blockTag ?? 0),
    getCode: (address, blockTag) => provider.getCode(address, blockTag ?? 0),
    getStorage: (address, slot, blockTag) =>
      provider.getStorage(address, slot, blockTag ?? 0),
    getLogs: (filter) => provider.getLogs({
      ...(filter.address === undefined ? {} : { address: filter.address }),
      fromBlock: filter.fromBlock ?? 0,
      toBlock: filter.toBlock ?? 0,
      topics: filter.topics ?? [],
    }),
  };
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

function rawTransactionNominations(
  raw: RawArtifacts,
  catalog: FamilyCapabilityCatalog,
): readonly {
  readonly familyId: FamilyId;
  readonly transactionHash: string;
}[] {
  const values = new Map<string, {
    readonly familyId: FamilyId;
    readonly transactionHash: string;
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
      for (const [key, item] of Object.entries(record)) {
        if (
          (key !== "txHash" && key !== "transactionHash") ||
          typeof item !== "string" || !ethers.isHexString(item, 32)
        ) continue;
        const transactionHash = item.toLowerCase();
        values.set(`${resolved}\0${transactionHash}`, {
          familyId: resolved,
          transactionHash,
        });
      }
    }
    for (const item of Object.values(record)) visit(item, resolved);
  };
  visit(raw, null);
  return Object.freeze([...values.values()].sort((left, right) =>
    left.familyId.localeCompare(right.familyId) ||
    left.transactionHash.localeCompare(right.transactionHash)
  ));
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
      call: (transaction, block) => rpc.send("eth_call", [transaction, "0x" + block.toString(16)]),
      getCode: (address, block) => rpc.getCode(address, block),
      getStorage: (address, slot, block) => rpc.getStorage(address, slot, block),
      getLogs: (filter) => rpc.getLogs({ ...filter, topics: [...filter.topics] }),
      getTransactionReceipt: async (hash) => rpc.getTransactionReceipt(hash),
      traceTransaction: (hash) => rpc.send("debug_traceTransaction", [
        hash,
        { tracer: "callTracer" },
      ]),
    };
    const counters = {
      call: 0,
      getCode: 0,
      getStorage: 0,
      getLogs: 0,
      getTransactionReceipt: 0,
      traceTransaction: 0,
    };
    const countedProvider: CaptureInventoryProvider = {
      call: async (transaction, block) => {
        counters.call += 1;
        return provider.call(transaction, block);
      },
      getCode: async (address, block) => {
        counters.getCode += 1;
        return provider.getCode(address, block);
      },
      getStorage: async (address, slot, block) => {
        counters.getStorage += 1;
        return provider.getStorage(address, slot, block);
      },
      getLogs: async (filter) => {
        counters.getLogs += 1;
        return provider.getLogs(filter);
      },
      getTransactionReceipt: async (hash) => {
        counters.getTransactionReceipt += 1;
        return provider.getTransactionReceipt(hash);
      },
      traceTransaction: async (hash) => {
        counters.traceTransaction += 1;
        return provider.traceTransaction(hash);
      },
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
      provider: countedProvider,
    });
    await writeFile(outputPath, `${JSON.stringify(inventory, null, 2)}\n`);
    process.stdout.write(
      `catalog capture inventory written: entries=${inventory.entries.length} ` +
        `unresolved=${inventory.unresolved.length}\n`,
    );
    process.stdout.write(
      `rpc counts: ${JSON.stringify(counters)}\n`,
    );
    for (const entry of inventory.entries) {
      process.stdout.write(
        `admitted ${entry.familyId} ${entry.observation.kind} ` +
          `${entry.candidateIdentity}\n`,
      );
    }
    for (const unresolved of inventory.unresolved) {
      process.stdout.write(`unresolved ${unresolved.familyId}\n`);
    }
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
