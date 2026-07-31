import { ethers } from "ethers";
import type { PoolEntry } from "../planner/token-graph.js";

/**
 * Shared landed-event vocabulary. Concrete event lists belong to the swap
 * family which understands them; this module only validates and projects the
 * declarations registered by those families.
 */
export type LandedEventEmitter =
  | { readonly mode: "address" }
  | {
      readonly mode: "singleton-indexed-address";
      readonly address: string;
      readonly topicIndex: number;
    }
  | {
      readonly mode: "singleton-indexed-bytes32";
      readonly address: string;
      readonly topicIndex: number;
    }
  | {
      /**
       * Anonymous singleton log with a bytes32 instance id embedded in data.
       * Exact byte length prevents unrelated anonymous logs at the singleton
       * from becoming swap triggers.
       */
      readonly mode: "singleton-anonymous-data-bytes32";
      readonly address: string;
      readonly dataLengthBytes: number;
      readonly identityOffsetBytes: number;
    };

export interface LandedSwapEventDeclaration {
  readonly id: string;
  /** null only for an explicitly bounded anonymous-data emitter. */
  readonly topic: string | null;
  readonly emitter: LandedEventEmitter;
  /**
   * Generic materialization covers address and singleton-indexed-address
   * emitters. Families that need extra metadata declare `family`; bytes32
   * singleton identities always require a family materializer.
   */
  readonly materialization?: "generic" | "family";
  readonly discovery: {
    readonly poolAdapter: PoolEntry["adapter"];
    readonly label: string;
  };
  readonly invalidatesWarmState: boolean;
}

export interface LandedMutationEventDeclaration {
  readonly id: string;
  readonly topic: string;
  readonly emitter: LandedEventEmitter;
}

export interface SwapLandedEventDeclaration {
  readonly swaps: readonly LandedSwapEventDeclaration[];
  readonly mutations: readonly LandedMutationEventDeclaration[];
}

export interface LandedSwapEventDescriptor extends LandedSwapEventDeclaration {
  readonly executionFamilies: readonly string[];
}

export interface LandedMutationEventDescriptor extends LandedMutationEventDeclaration {
  readonly executionFamilies: readonly string[];
}

export interface LandedEventFamilyRegistration {
  readonly id: string;
  readonly poolAdapters: readonly PoolEntry["adapter"][];
  readonly observation: {
    readonly topics: readonly string[];
    readonly anonymousLogs?: readonly AnonymousLandedLogSelector[];
  };
  readonly landedEvents: SwapLandedEventDeclaration;
}

export const landedEventTopic = (signature: string): string =>
  ethers.id(signature).toLowerCase();

export const ADDRESS_LANDED_EVENT_EMITTER = Object.freeze({
  mode: "address",
} as const);

export interface AnonymousLandedLogSelector {
  readonly address: string;
  readonly dataLengthBytes: number;
  readonly identityOffsetBytes: number;
}

export function singletonIndexedAddressEmitter(
  address: string,
  topicIndex: number,
): LandedEventEmitter {
  return Object.freeze({
    mode: "singleton-indexed-address",
    address: ethers.getAddress(address),
    topicIndex,
  });
}

export function singletonIndexedBytes32Emitter(
  address: string,
  topicIndex: number,
): LandedEventEmitter {
  return Object.freeze({
    mode: "singleton-indexed-bytes32",
    address: ethers.getAddress(address),
    topicIndex,
  });
}

export function singletonAnonymousDataBytes32Emitter(
  address: string,
  dataLengthBytes: number,
  identityOffsetBytes: number,
): LandedEventEmitter {
  return Object.freeze({
    mode: "singleton-anonymous-data-bytes32",
    address: ethers.getAddress(address),
    dataLengthBytes,
    identityOffsetBytes,
  });
}

export function defineSwapLandedEvents(
  declaration: SwapLandedEventDeclaration,
): SwapLandedEventDeclaration {
  return Object.freeze({
    swaps: Object.freeze(declaration.swaps.map((event) => Object.freeze({
      ...event,
      emitter: Object.freeze({ ...event.emitter }),
      discovery: Object.freeze({ ...event.discovery }),
    }))),
    mutations: Object.freeze(declaration.mutations.map((event) => Object.freeze({
      ...event,
      emitter: Object.freeze({ ...event.emitter }),
    }))),
  });
}

export const UNIV2_SWAP_TOPIC = landedEventTopic(
  "Swap(address,uint256,uint256,uint256,uint256,address)",
);
export const UNIV2_SYNC_TOPIC = landedEventTopic("Sync(uint112,uint112)");
export const UNIV3_SWAP_TOPIC = landedEventTopic(
  "Swap(address,address,int256,int256,uint160,uint128,int24)",
);
export const PANCAKE_V3_SWAP_TOPIC = landedEventTopic(
  "Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)",
);
export const UNIV4_INITIALIZE_TOPIC = landedEventTopic(
  "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)",
);
export const UNIV4_SWAP_TOPIC = landedEventTopic(
  "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)",
);
export const UNIV4_MODIFY_LIQUIDITY_TOPIC = landedEventTopic(
  "ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)",
);
export const BALANCER_V3_SWAP_TOPIC = landedEventTopic(
  "Swap(address,address,address,uint256,uint256,uint256,uint256)",
);
export const DODO_V2_SWAP_TOPIC = landedEventTopic(
  "DODOSwap(address,address,uint256,uint256,address,address)",
);
/** Receipt-verified Fluid DEX T1 topic; the public event ABI is unavailable. */
export const FLUID_DEX_SWAP_TOPIC =
  "0xdc004dbca4ef9c966218431ee5d9133d337ad018dd5b5c5493722803f75c64f7";
export const CURVE_TOKEN_EXCHANGE_TOPICS = Object.freeze([
  landedEventTopic("TokenExchange(address,int128,uint256,int128,uint256)"),
  landedEventTopic("TokenExchange(address,uint256,uint256,uint256,uint256)"),
  landedEventTopic("TokenExchangeUnderlying(address,int128,uint256,int128,uint256)"),
  landedEventTopic("TokenExchangeUnderlying(address,uint256,uint256,uint256,uint256)"),
]);

/**
 * Immutable views derived solely from registered swap families. Adding a
 * family never requires editing a central event table.
 */
export class LandedEventRegistry {
  readonly swapEvents: readonly LandedSwapEventDescriptor[];
  readonly mutationEvents: readonly LandedMutationEventDescriptor[];
  readonly swapTopics: readonly string[];
  readonly warmTopics: readonly string[];

  private readonly swapsByTopic: ReadonlyMap<string, readonly LandedSwapEventDescriptor[]>;
  private readonly swapsByFamily: ReadonlyMap<string, readonly LandedSwapEventDescriptor[]>;

  constructor(families: readonly LandedEventFamilyRegistration[]) {
    const swapsById = new Map<string, LandedSwapEventDescriptor>();
    const mutationsById = new Map<string, LandedMutationEventDescriptor>();
    const swapsByFamily = new Map<string, LandedSwapEventDescriptor[]>();

    for (const family of families) {
      validateFamilyDeclaration(family);
      const familySwaps: LandedSwapEventDescriptor[] = [];
      for (const declaration of family.landedEvents.swaps) {
        const existing = swapsById.get(declaration.id);
        if (existing && !sameSwapDeclaration(existing, declaration)) {
          throw new Error(
            `landed-event registry: event ${declaration.id} has conflicting family declarations`,
          );
        }
        const descriptor = existing
          ? Object.freeze({
              ...existing,
              executionFamilies: Object.freeze([
                ...existing.executionFamilies,
                family.id,
              ]),
            })
          : Object.freeze({
              ...declaration,
              topic: declaration.topic?.toLowerCase() ?? null,
              executionFamilies: Object.freeze([family.id]),
            });
        swapsById.set(declaration.id, descriptor);
        familySwaps.push(descriptor);
      }
      swapsByFamily.set(family.id, familySwaps);

      for (const declaration of family.landedEvents.mutations) {
        const existing = mutationsById.get(declaration.id);
        if (existing && !sameMutationDeclaration(existing, declaration)) {
          throw new Error(
            `landed-event registry: mutation ${declaration.id} has conflicting family declarations`,
          );
        }
        mutationsById.set(
          declaration.id,
          existing
            ? Object.freeze({
                ...existing,
                executionFamilies: Object.freeze([
                  ...existing.executionFamilies,
                  family.id,
                ]),
              })
            : Object.freeze({
                ...declaration,
                topic: declaration.topic.toLowerCase(),
                executionFamilies: Object.freeze([family.id]),
              }),
        );
      }
    }

    // Replace family-local references with the final merged descriptors so
    // every projection reports complete ownership for shared event surfaces.
    for (const [familyId, events] of swapsByFamily) {
      swapsByFamily.set(
        familyId,
        events.map((event) => swapsById.get(event.id)!),
      );
    }

    this.swapEvents = Object.freeze([...swapsById.values()]);
    this.mutationEvents = Object.freeze([...mutationsById.values()]);
    this.swapTopics = Object.freeze(uniqueTopics(this.swapEvents));
    this.warmTopics = Object.freeze(uniqueTopics([
      ...this.swapEvents.filter((event) => event.invalidatesWarmState),
      ...this.mutationEvents,
    ]));
    this.swapsByTopic = groupByTopic(this.swapEvents);
    this.swapsByFamily = new Map(
      [...swapsByFamily].map(([familyId, events]) => [
        familyId,
        Object.freeze(events),
      ]),
    );
  }

  eventsForFamily(familyId: string): readonly LandedSwapEventDescriptor[] {
    return this.swapsByFamily.get(familyId) ?? [];
  }

  topicsForFamily(familyId: string): readonly string[] {
    return uniqueTopics(this.eventsForFamily(familyId));
  }

  eventsForTopic(eventTopic: string): readonly LandedSwapEventDescriptor[] {
    return this.swapsByTopic.get(eventTopic.toLowerCase()) ?? [];
  }

  isSwapTopic(eventTopic: string | null | undefined): boolean {
    return typeof eventTopic === "string" &&
      this.swapsByTopic.has(eventTopic.toLowerCase());
  }

  isSwapLog(log: {
    readonly address: string;
    readonly topics: readonly string[];
    readonly data: string;
  }): boolean {
    const topic = log.topics[0];
    if (topic && this.isSwapTopic(topic)) return true;
    return this.swapEvents.some((event) =>
      event.topic === null && landedEventMatches(event, log)
    );
  }
}

export function observedLandedPoolIdentity(
  event: Pick<LandedSwapEventDeclaration | LandedMutationEventDeclaration, "topic" | "emitter">,
  log: { address: string; topics: readonly string[]; data?: string },
): string | null {
  if (event.topic === null) {
    if (event.emitter.mode !== "singleton-anonymous-data-bytes32") return null;
    if (!anonymousEmitterMatches(event.emitter, log)) return null;
    const data = log.data!.slice(2);
    const start = event.emitter.identityOffsetBytes * 2;
    return `0x${data.slice(start, start + 64)}`.toLowerCase();
  }
  if (log.topics[0]?.toLowerCase() !== event.topic.toLowerCase()) return null;
  if (event.emitter.mode === "address") {
    try {
      return ethers.getAddress(log.address).toLowerCase();
    } catch {
      return null;
    }
  }
  if (event.emitter.mode === "singleton-anonymous-data-bytes32") return null;
  if (log.address.toLowerCase() !== event.emitter.address.toLowerCase()) return null;
  const indexed = log.topics[event.emitter.topicIndex];
  if (!indexed) return null;
  if (event.emitter.mode === "singleton-indexed-bytes32") return indexed.toLowerCase();
  try {
    return ethers.getAddress(`0x${indexed.slice(-40)}`).toLowerCase();
  } catch {
    return null;
  }
}

function validateFamilyDeclaration(family: LandedEventFamilyRegistration): void {
  if (!family.id.trim()) {
    throw new Error("landed-event registry: empty family id");
  }
  if (family.landedEvents.swaps.length === 0) {
    throw new Error(`landed-event registry: ${family.id} declares no landed swap event`);
  }
  const localIds = new Set<string>();
  for (const event of family.landedEvents.swaps) {
    validateEvent(event, `${family.id} swap`);
    if (!family.poolAdapters.includes(event.discovery.poolAdapter)) {
      throw new Error(
        `landed-event registry: ${family.id} declares foreign discovery adapter ` +
          event.discovery.poolAdapter,
      );
    }
    if (!event.discovery.label.trim()) {
      throw new Error(`landed-event registry: ${family.id} has empty discovery label`);
    }
    if (localIds.has(event.id)) {
      throw new Error(`landed-event registry: ${family.id} duplicates event ${event.id}`);
    }
    localIds.add(event.id);
  }
  for (const event of family.landedEvents.mutations) {
    validateEvent(event, `${family.id} mutation`);
    if (localIds.has(event.id)) {
      throw new Error(`landed-event registry: ${family.id} duplicates event ${event.id}`);
    }
    localIds.add(event.id);
  }

  const declaredTopics = new Set(
    family.landedEvents.swaps.flatMap((event) =>
      event.topic === null ? [] : [event.topic.toLowerCase()]
    ),
  );
  const observedTopics = new Set(
    family.observation.topics.map((eventTopic) => eventTopic.toLowerCase()),
  );
  if (
    declaredTopics.size !== observedTopics.size ||
    [...declaredTopics].some((eventTopic) => !observedTopics.has(eventTopic))
  ) {
    throw new Error(
      `landed-event registry: ${family.id} observation topics do not match its declaration`,
    );
  }
  const declaredAnonymous = new Set(
    family.landedEvents.swaps.flatMap((event) =>
      event.topic === null
        ? [anonymousSelectorKey(event.emitter)]
        : []
    ),
  );
  const observedAnonymous = new Set(
    (family.observation.anonymousLogs ?? []).map(anonymousSelectorKey),
  );
  if (
    declaredAnonymous.size !== observedAnonymous.size ||
    [...declaredAnonymous].some((selector) => !observedAnonymous.has(selector))
  ) {
    throw new Error(
      `landed-event registry: ${family.id} anonymous observation selectors ` +
        "do not match its declaration",
    );
  }
}

function validateEvent(
  event: Pick<
    LandedSwapEventDeclaration,
    "id" | "topic" | "emitter" | "materialization"
  >,
  owner: string,
): void {
  if (!event.id.trim()) {
    throw new Error(`landed-event registry: ${owner} has empty event id`);
  }
  if (
    event.topic !== null &&
    !/^0x[0-9a-fA-F]{64}$/.test(event.topic)
  ) {
    throw new Error(`landed-event registry: ${owner} ${event.id} has invalid topic`);
  }
  if (
    event.materialization !== undefined &&
    event.materialization !== "generic" &&
    event.materialization !== "family"
  ) {
    throw new Error(
      `landed-event registry: ${owner} ${event.id} has invalid materialization`,
    );
  }
  if (event.topic === null) {
    if (event.emitter.mode !== "singleton-anonymous-data-bytes32") {
      throw new Error(
        `landed-event registry: ${owner} ${event.id} null topic requires ` +
          "an anonymous-data emitter",
      );
    }
    validateAnonymousEmitter(event.emitter, owner, event.id);
    return;
  }
  if (event.emitter.mode === "singleton-anonymous-data-bytes32") {
    throw new Error(
      `landed-event registry: ${owner} ${event.id} anonymous emitter requires null topic`,
    );
  }
  if (event.emitter.mode === "address") return;
  try {
    ethers.getAddress(event.emitter.address);
  } catch {
    throw new Error(`landed-event registry: ${owner} ${event.id} has invalid emitter`);
  }
  if (
    !Number.isSafeInteger(event.emitter.topicIndex) ||
    event.emitter.topicIndex < 1
  ) {
    throw new Error(`landed-event registry: ${owner} ${event.id} has invalid topic index`);
  }
}

function sameSwapDeclaration(
  left: LandedSwapEventDeclaration,
  right: LandedSwapEventDeclaration,
): boolean {
  return left.topic?.toLowerCase() === right.topic?.toLowerCase() &&
    sameEmitter(left.emitter, right.emitter) &&
    left.discovery.poolAdapter === right.discovery.poolAdapter &&
    left.discovery.label === right.discovery.label &&
    (left.materialization ?? "generic") ===
      (right.materialization ?? "generic") &&
    left.invalidatesWarmState === right.invalidatesWarmState;
}

function sameMutationDeclaration(
  left: LandedMutationEventDeclaration,
  right: LandedMutationEventDeclaration,
): boolean {
  return left.topic.toLowerCase() === right.topic.toLowerCase() &&
    sameEmitter(left.emitter, right.emitter);
}

function sameEmitter(left: LandedEventEmitter, right: LandedEventEmitter): boolean {
  if (left.mode !== right.mode) return false;
  if (left.mode === "address" || right.mode === "address") return true;
  if (
    left.mode === "singleton-anonymous-data-bytes32" ||
    right.mode === "singleton-anonymous-data-bytes32"
  ) {
    return left.mode === "singleton-anonymous-data-bytes32" &&
      right.mode === "singleton-anonymous-data-bytes32" &&
      left.address.toLowerCase() === right.address.toLowerCase() &&
      left.dataLengthBytes === right.dataLengthBytes &&
      left.identityOffsetBytes === right.identityOffsetBytes;
  }
  return left.address.toLowerCase() === right.address.toLowerCase() &&
    left.topicIndex === right.topicIndex;
}

function uniqueTopics(
  events: readonly { readonly topic: string | null }[],
): string[] {
  return [...new Set(events.flatMap((event) =>
    event.topic === null ? [] : [event.topic.toLowerCase()]
  ))];
}

function groupByTopic<T extends { topic: string | null }>(
  events: readonly T[],
): ReadonlyMap<string, readonly T[]> {
  const grouped = new Map<string, T[]>();
  for (const event of events) {
    if (event.topic === null) continue;
    const items = grouped.get(event.topic.toLowerCase()) ?? [];
    items.push(event);
    grouped.set(event.topic.toLowerCase(), items);
  }
  return grouped;
}

export function landedEventMatches(
  event: Pick<LandedSwapEventDeclaration, "topic" | "emitter">,
  log: {
    readonly address: string;
    readonly topics: readonly string[];
    readonly data: string;
  },
): boolean {
  if (event.topic === null) {
    return event.emitter.mode === "singleton-anonymous-data-bytes32" &&
      anonymousEmitterMatches(event.emitter, log);
  }
  if (log.topics[0]?.toLowerCase() !== event.topic.toLowerCase()) return false;
  if (event.emitter.mode === "address") return true;
  if (event.emitter.mode === "singleton-anonymous-data-bytes32") return false;
  return log.address.toLowerCase() === event.emitter.address.toLowerCase();
}

function anonymousEmitterMatches(
  selector: Extract<
    LandedEventEmitter,
    { readonly mode: "singleton-anonymous-data-bytes32" }
  >,
  log: {
    readonly address: string;
    readonly topics: readonly string[];
    readonly data?: string;
  },
): boolean {
  if (
    log.address.toLowerCase() !== selector.address.toLowerCase() ||
    log.topics.length !== 0 ||
    typeof log.data !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(log.data) ||
    (log.data.length - 2) / 2 !== selector.dataLengthBytes
  ) {
    return false;
  }
  return selector.identityOffsetBytes + 32 <= selector.dataLengthBytes;
}

function validateAnonymousEmitter(
  emitter: Extract<
    LandedEventEmitter,
    { readonly mode: "singleton-anonymous-data-bytes32" }
  >,
  owner: string,
  eventId: string,
): void {
  try {
    ethers.getAddress(emitter.address);
  } catch {
    throw new Error(
      `landed-event registry: ${owner} ${eventId} has invalid emitter`,
    );
  }
  if (
    !Number.isSafeInteger(emitter.dataLengthBytes) ||
    emitter.dataLengthBytes < 32 ||
    !Number.isSafeInteger(emitter.identityOffsetBytes) ||
    emitter.identityOffsetBytes < 0 ||
    emitter.identityOffsetBytes + 32 > emitter.dataLengthBytes
  ) {
    throw new Error(
      `landed-event registry: ${owner} ${eventId} has invalid anonymous data bounds`,
    );
  }
}

function anonymousSelectorKey(
  selector: LandedEventEmitter | AnonymousLandedLogSelector,
): string {
  if (
    !("dataLengthBytes" in selector) ||
    !("identityOffsetBytes" in selector) ||
    !("address" in selector)
  ) {
    throw new Error("anonymous landed selector is not data-bounded");
  }
  return JSON.stringify([
    ethers.getAddress(selector.address).toLowerCase(),
    selector.dataLengthBytes,
    selector.identityOffsetBytes,
  ]);
}
