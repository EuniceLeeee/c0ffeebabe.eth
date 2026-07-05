import type { EdgeKind, ProtocolAction } from "../../../listener/src/searcher/strategy-taxonomy.js";
import { ADDR } from "../../../listener/src/shared/constants/addresses.js";
import { PUBLIC_ROUTERS } from "../registry/routers.js";
import type { AggregatedVenue } from "./venue-aggregate.js";
import { KNOWN_EXCLUDED_ADDRESSES } from "./venue-evidence.js";

export type VenueStatus = "candidate" | "known" | "routable" | "excluded";

export interface VenueClassification {
  edgeKind: EdgeKind;
  source: "auto" | "manual";
}

export interface VenueRecord {
  address: string;
  name?: string;
  edgeKinds: EdgeKind[];
  protocolActions: ProtocolAction[];
  txCount: number;
  status: VenueStatus;
  classification?: VenueClassification;
  adapterHint?: string;
}

export interface VenueRegistry {
  updatedAt?: string;
  venues: Record<string, VenueRecord>;
}

const KNOWN_VENUE_KEYS = [
  "SKY_PSM_LITE",
  "FLUID_VAULT_WSTUSR_USDC",
  "WSTETH",
  "SUSDS",
  "WSTUSR",
] as const satisfies readonly (keyof typeof ADDR)[];

const OBSERVED_EDGE_KIND_ORDER: readonly EdgeKind[] = ["flash", "swap", "credit", "lp", "protocol"];
const CLASSIFICATION_PRIORITY: readonly EdgeKind[] = ["credit", "protocol", "lp", "swap", "flash"];
const PROTOCOL_ACTION_ORDER: readonly ProtocolAction[] = [
  "mint",
  "redeem",
  "wrap",
  "unwrap",
  "convert",
  "stake",
  "unstake",
];

export function seedRegistry(): VenueRegistry {
  const reg: VenueRegistry = { venues: {} };

  for (const address of [...KNOWN_EXCLUDED_ADDRESSES, ...PUBLIC_ROUTERS]) {
    upsertSeedRecord(reg, address, "excluded");
  }

  for (const key of KNOWN_VENUE_KEYS) {
    upsertSeedRecord(reg, ADDR[key], "known");
  }

  return reg;
}

export function ingestAggregates(reg: VenueRegistry, incoming: AggregatedVenue[]): VenueRegistry {
  const next = cloneRegistry(reg);

  for (const aggregate of incoming) {
    const address = lowerAddress(aggregate.address);
    if (!address) continue;

    const existing = next.venues[address];
    const record: VenueRecord = existing
      ? { ...existing }
      : emptyRecord(address, "candidate");

    record.address = address;
    record.status = existing?.status ?? "candidate";
    record.txCount += aggregate.txCount;
    record.edgeKinds = sortedUniqueByOrder(
      [...record.edgeKinds, ...aggregate.edgeKinds],
      OBSERVED_EDGE_KIND_ORDER,
    );
    record.protocolActions = sortedUniqueByOrder(
      [...record.protocolActions, ...aggregate.protocolActions],
      PROTOCOL_ACTION_ORDER,
    );

    if (record.classification?.source !== "manual") {
      const autoEdgeKind = highestPriorityEdgeKind(record.edgeKinds);
      record.classification = autoEdgeKind ? { edgeKind: autoEdgeKind, source: "auto" } : undefined;
    }

    next.venues[address] = record;
  }

  return next;
}

export function setClassification(
  reg: VenueRegistry,
  address: string,
  edgeKind: EdgeKind,
): VenueRegistry {
  const next = cloneRegistry(reg);
  const normalized = lowerAddress(address);
  if (!normalized) return next;
  const record = next.venues[normalized] ?? emptyRecord(normalized, "candidate");
  next.venues[normalized] = {
    ...record,
    address: normalized,
    classification: { edgeKind, source: "manual" },
  };
  return next;
}

export function setStatus(
  reg: VenueRegistry,
  address: string,
  status: VenueStatus,
): VenueRegistry {
  const next = cloneRegistry(reg);
  const normalized = lowerAddress(address);
  if (!normalized) return next;
  const record = next.venues[normalized] ?? emptyRecord(normalized, "candidate");
  next.venues[normalized] = { ...record, address: normalized, status };
  return next;
}

export function listVenues(
  reg: VenueRegistry,
  opts: { status?: VenueStatus; kind?: EdgeKind } = {},
): VenueRecord[] {
  return Object.values(reg.venues)
    .filter((venue) => opts.status === undefined || venue.status === opts.status)
    .filter((venue) => opts.kind === undefined || venue.classification?.edgeKind === opts.kind)
    .sort((a, b) => b.txCount - a.txCount || a.address.localeCompare(b.address));
}

function upsertSeedRecord(reg: VenueRegistry, address: string, status: VenueStatus): void {
  const normalized = lowerAddress(address);
  if (!normalized) return;
  const existing = reg.venues[normalized] ?? emptyRecord(normalized, status);
  reg.venues[normalized] = {
    ...existing,
    address: normalized,
    name: existing.name ?? nameForAddress(normalized),
    status,
  };
}

function emptyRecord(address: string, status: VenueStatus): VenueRecord {
  return {
    address,
    name: nameForAddress(address),
    edgeKinds: [],
    protocolActions: [],
    txCount: 0,
    status,
  };
}

function cloneRegistry(reg: VenueRegistry): VenueRegistry {
  const venues: Record<string, VenueRecord> = {};
  for (const [address, venue] of Object.entries(reg.venues ?? {})) {
    const normalized = lowerAddress(venue.address || address);
    if (!normalized) continue;
    venues[normalized] = {
      ...venue,
      address: normalized,
      edgeKinds: [...(venue.edgeKinds ?? [])],
      protocolActions: [...(venue.protocolActions ?? [])],
      status: venue.status ?? "candidate",
      classification: venue.classification ? { ...venue.classification } : undefined,
    };
  }
  return { ...reg, venues };
}

function highestPriorityEdgeKind(edgeKinds: EdgeKind[]): EdgeKind | undefined {
  for (const edgeKind of CLASSIFICATION_PRIORITY) {
    if (edgeKinds.includes(edgeKind)) return edgeKind;
  }
  return undefined;
}

function sortedUniqueByOrder<T extends string>(items: T[], order: readonly T[]): T[] {
  const orderIndex = new Map(order.map((item, index) => [item, index]));
  return [...new Set(items)].sort((a, b) =>
    (orderIndex.get(a) ?? Number.MAX_SAFE_INTEGER)
    - (orderIndex.get(b) ?? Number.MAX_SAFE_INTEGER)
    || a.localeCompare(b)
  );
}

function nameForAddress(address: string): string | undefined {
  const entry = Object.entries(ADDR).find(([, value]) => lowerAddress(value) === address);
  return entry?.[0];
}

function lowerAddress(address: string | null | undefined): string {
  return address?.toLowerCase() ?? "";
}
