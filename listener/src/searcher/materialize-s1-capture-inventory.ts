import { readFile, writeFile } from "node:fs/promises";
import { ethers } from "ethers";
import type { FamilyId } from "./venues/adapter-family-identifiers.js";
import type {
  CaptureNominationInput,
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
  executeCatalogReverseBindings,
} from "./venues/capture-materialization.js";
import { scanRecentCallSeeds } from "./recent-call-seed-scan.js";

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
  // F6 generic call-seed scan: bare tx-bound pool rows (no txHash evidence)
  // get real recent candidate transactions from the node's retained window,
  // traced against the family's own declared callPatterns.
  const poolNominations = opaquePoolNominations({
    graph: input.rawArtifacts.graph as
      import("./venues/canonical-value.js").CanonicalValue,
    protocolCache: input.rawArtifacts.protocolCache as
      import("./venues/canonical-value.js").CanonicalValue,
  });
  const seedNominations = await scanRecentCallSeeds({
    catalog: input.catalog,
    source: input.source,
    provider: input.provider,
    nominations: poolNominations,
  });
  // Capture closure strategy (central, no protocol semantics): a captured
  // route must close with a real funding plan, so the route's input token
  // must be borrowable by the catalog funding families. Filter pool
  // nominations to pools whose on-chain token surface includes a mainstream
  // borrowable asset (universal ERC20 reads; pools that do not expose
  // token0/token1 stay unfiltered).
  const borrowableNominations = await filterBorrowableNominations({
    provider: input.provider,
    source: input.source,
    nominations: poolNominations,
  });
  admitObservations(
    input.catalog,
    await executeCatalogCaptureNominations({
      catalog: input.catalog,
      source: input.source,
      nominations: [...borrowableNominations, ...seedNominations],
      provider: nominationProvider(input.provider, input.source.number),
      alreadyAdmitted: new Set(byFamily.keys()),
    }),
    byFamily,
  );
  // Phase 2a: retain-channel reverse binding (cold-pool chain truth: factory
  // child / registry member / PositionManager) is the fallback after the
  // fresh nomination channel. Central order; the plugin only declares
  // semantics.
  admitObservations(
    input.catalog,
    await executeCatalogReverseBindings({
      catalog: input.catalog,
      source: input.source,
      nominations: [...borrowableNominations, ...seedNominations],
      provider: nominationProvider(input.provider, input.source.number),
      alreadyAdmitted: new Set(byFamily.keys()),
    }),
    byFamily,
  );
  const discoveryIds = input.catalog.listAll().flatMap((family) =>
    "discovery" in family.plugin ? [family.plugin.manifest.familyId] : []
  );
  const unresolved = discoveryIds.filter((familyId) => !byFamily.has(familyId))
    .map((familyId) => {
      const family = input.catalog.forStrictFamily(familyId);
      const plugin = family.plugin;
      const hasNominate = "discovery" in plugin &&
        plugin.discovery.nominate !== undefined;
      const hasTxPatterns = "discovery" in plugin &&
        ((plugin.discovery.callPatterns?.length ?? 0) > 0 ||
          (plugin.discovery.logPatterns?.length ?? 0) > 0);
      const reason = !hasNominate && !hasTxPatterns
        ? "missing nomination capability and no tx-evidence channel"
        : hasNominate
        ? "nomination found no plugin-decodable observation"
        : "tx evidence produced no plugin-decodable observation";
      return Object.freeze({ familyId, reason });
    });
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


/**
 * Central capture-closure strategy (no protocol semantics): a route capture
 * must close with a catalog funding plan, so the route's input token must be
 * borrowable. Pools exposing a mainstream borrowable asset in their token
 * surface (universal ERC20 token0/token1 reads) are kept; pools whose token
 * surface cannot be read stay unfiltered (their family nomination decides).
 */
const CAPTURE_BORROWABLE_ASSETS = Object.freeze([
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
  "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", // wstETH
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
  "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", // WBTC
]);

async function filterBorrowableNominations(input: {
  readonly provider: CaptureInventoryProvider;
  readonly source: CanonicalSource;
  readonly nominations: readonly CaptureNominationInput[];
}): Promise<readonly CaptureNominationInput[]> {
  const borrowable: CaptureNominationInput[] = [];
  const ERC20 = new ethers.Interface([
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function coins(uint256 i) view returns (address)",
    "function _BASE_TOKEN_() view returns (address)",
    "function _QUOTE_TOKEN_() view returns (address)",
  ]);
  const TOKEN_GETTERS = [
    ["token0", ""],
    ["token1", ""],
    ["coins", "0"],
    ["coins", "1"],
    ["_BASE_TOKEN_", ""],
    ["_QUOTE_TOKEN_", ""],
  ] as const;
  const BORROWABLE_CONCURRENCY = 24;
  let next = 0;
  const results: boolean[] = new Array(input.nominations.length).fill(true);
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= input.nominations.length) return;
      const nomination = input.nominations[index]!;
      const pool = nomination.address.toLowerCase();
      const tokens = new Set<string>();
      try {
        for (const [fn, arg] of TOKEN_GETTERS) {
          const raw = await input.provider.call(
            {
              to: pool,
              data: ERC20.encodeFunctionData(fn, arg === "" ? [] : [arg]),
            },
            input.source.number,
          );
          if (ethers.isHexString(raw) && ethers.dataLength(raw) === 32) {
            const decoded = ERC20.decodeFunctionResult(fn, raw) as unknown;
            const token = String(
              (decoded as { readonly [index: number]: unknown })[0] ?? "",
            );
            if (token !== "") {
              tokens.add(ethers.getAddress(token).toLowerCase());
            }
          }
        }
      } catch {
        // Token surface unreadable (non-standard pool): keep the nomination;
        // the family nomination decides.
        continue;
      }
      // Both identified tokens must be mainstream borrowable assets: the
      // route direction is chain-derived and cannot be steered, so a pool
      // with any non-borrowable side can produce an unclosable route.
      const identified = [...tokens];
      if (identified.length === 2 && identified.some((token) =>
        !CAPTURE_BORROWABLE_ASSETS.includes(token)
      )) {
        results[index] = false;
      }
    }
  };
  await Promise.all(
    Array.from({ length: BORROWABLE_CONCURRENCY }, () => worker()),
  );
  for (let i = 0; i < input.nominations.length; i++) {
    if (results[i]) borrowable.push(input.nominations[i]!);
  }
  return Object.freeze(borrowable);
}

function opaquePoolNominations(input: {
  readonly graph: CanonicalValue;
  readonly protocolCache: CanonicalValue;
}): readonly import("./venues/adapter-family-plugin.js").CaptureNominationInput[] {
  const values = new Map<string, import("./venues/adapter-family-plugin.js").CaptureNominationInput>();
  const setNomination = (
    address: string,
    opaque: Readonly<Record<string, unknown>>,
    overrideEvidence = false,
  ): void => {
    // One nomination per address+label: distinct Families may legitimately
    // claim the same on-chain address (e.g. an ERC4626 vault that is also a
    // silo-redeem vault), and the protocol cache may re-list an address
    // under a different matcher (e.g. self-burn proxies). Keying by the
    // label keeps every Family's nomination reachable instead of letting
    // one source steal the address from another.
    const label = String(
      opaque.adapter ?? opaque.adapterId ?? opaque.venueId ?? "",
    ).toLowerCase();
    const key = `${address} ${label}`;
    const existing = values.get(key);
    if (existing === undefined) {
      values.set(key, Object.freeze({
        address,
        opaque: Object.freeze(opaque) as unknown as
          import("./venues/canonical-value.js").CanonicalValue,
      }));
      return;
    }
    // A verified_candidates record carries real evidence (txHash or
    // behavior-probe samples). It must win over a bare graph/cache pool
    // entry for the same label, otherwise the evidence is lost and the
    // Family stays unresolved.
    const existingOpaque = existing.opaque as Readonly<Record<string, unknown>>;
    const incomingEvidence = Array.isArray(opaque.evidence)
      ? opaque.evidence.length > 0
      : false;
    const hasEvidence = Array.isArray(existingOpaque.evidence)
      ? existingOpaque.evidence.length > 0
      : false;
    if (overrideEvidence && incomingEvidence && !hasEvidence) {
      values.set(key, Object.freeze({
        address,
        opaque: Object.freeze(opaque) as unknown as
          import("./venues/canonical-value.js").CanonicalValue,
      }));
    }
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Readonly<Record<string, unknown>>;
    // verified_candidates entries carry the full candidate record (pool +
    // evidence). Keep the whole record as opaque so tx-bound Families can
    // consume their real txHash / behavior-probe evidence.
    const candidate = record.candidate as
      Readonly<Record<string, unknown>> | undefined;
    const candidatePool = candidate?.pool as
      Readonly<Record<string, unknown>> | undefined;
    if (
      candidatePool !== undefined &&
      typeof record.adapterId === "string" &&
      typeof candidatePool.address === "string" &&
      ethers.isAddress(candidatePool.address)
    ) {
      setNomination(
        ethers.getAddress(candidatePool.address).toLowerCase(),
        Object.freeze({
          ...candidatePool,
          adapterId: record.adapterId,
          ...(candidate?.evidence === undefined
            ? {}
            : { evidence: candidate.evidence }),
        }),
        true,
      );
      for (const item of Object.values(record)) visit(item);
      return;
    }
    if (
      typeof record.address === "string" &&
      ethers.isAddress(record.address) &&
      Object.keys(record).some((key) =>
        key === "adapter" || key === "venueId" || key === "adapterId"
      )
    ) {
      setNomination(
        ethers.getAddress(record.address).toLowerCase(),
        record,
      );
    }
    for (const item of Object.values(record)) visit(item);
  };
  visit(input.graph);
  visit(input.protocolCache);
  return Object.freeze([...values.values()].sort((left, right) =>
    left.address.localeCompare(right.address)
  ));
}

function nominationProvider(
  provider: CaptureInventoryProvider,
  sourceBlock: number,
): import("./venues/adapter-family-plugin.js").CaptureNominationProvider {
  return {
    call: (transaction, blockTag) =>
      provider.call(transaction, blockTag ?? sourceBlock),
    getCode: (address, blockTag) =>
      provider.getCode(address, blockTag ?? sourceBlock),
    getStorage: (address, slot, blockTag) =>
      provider.getStorage(address, slot, blockTag ?? sourceBlock),
    getLogs: (filter) => provider.getLogs({
      ...(filter.address === undefined ? {} : { address: filter.address }),
      fromBlock: filter.fromBlock ?? 0,
      toBlock: filter.toBlock ?? 0,
      topics: filter.topics ?? [],
    }),
    getTransactionReceipt: (transactionHash) =>
      provider.getTransactionReceipt(transactionHash),
    traceTransaction: (transactionHash) =>
      provider.traceTransaction(transactionHash),
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
