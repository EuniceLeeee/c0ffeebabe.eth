import { getAddress } from "ethers";
import type { ReadySelectorCensusCall, ReadySelectorCensusTokenFlow, ReadySelectorCensusTransaction } from "../ready-selector-census.js";
import { decodeSelectorAbiArguments, normalizeSelectorExecutionResource, selectorAbiParameterAt,
  selectorFamilyIdentity, selectorImmutableParameters, type SelectorAbiValue, type SelectorImmutableParameter } from "./selector-execution-keys.js";

/** All paths are declared ABI paths. This projection makes no ABI guesses and
 * no identity/protocol admission decision. Mutable execution inputs stay in
 * arguments and never become immutableParameters unless explicitly declared. */
export interface SelectorObservedCallNomination {
  readonly poolIdPath?: readonly number[];
  readonly poolNamespace?: string;
  readonly parameterPaths?: readonly (readonly number[])[];
  readonly tokenInPath?: readonly number[];
  readonly tokenOutPath?: readonly number[];
  readonly tokenInIdPath?: readonly number[];
  readonly tokenOutIdPath?: readonly number[];
  readonly poolIdLogs?: readonly { readonly topic: string; readonly topicIndex: number; readonly emitter: "call-target" }[];
}
export interface SelectorObservedCallScope {
  readonly chainId: number;
  readonly target: string;
  readonly poolId?: string;
  readonly poolNamespace?: string;
  readonly tokenIn?: string;
  readonly tokenOut?: string;
  readonly tokenInId?: string;
  readonly tokenOutId?: string;
}
export interface SelectorObservedCallResources {
  readonly call: ReadySelectorCensusCall;
  readonly arguments: readonly SelectorAbiValue[];
  readonly scope: SelectorObservedCallScope;
  readonly immutableParameters: readonly SelectorImmutableParameter[];
  /** A unique transaction-level payment hint, not an executed call debit. */
  readonly observedAmountIn?: string;
  readonly flowAttribution: "address-correlation-only";
  /** Multiple logs may name pools without attributing one to this call. */
  readonly unassignedPoolIds?: readonly string[];
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const address = (value: string): string => getAddress(value).toLowerCase();
const assetIdentity = (flow: ReadySelectorCensusTokenFlow): string => JSON.stringify([flow.token, flow.tokenId ?? null]);

/** A pure projection shared by SQL-derived candidates and Ready. Token events
 * retain address + tokenId for ERC721/1155. They are optional direction hints:
 * no transfer permutation or callback/receiver guess can manufacture a route. */
export function selectorObservedCallResources(input: {
  readonly signature: string;
  readonly selector?: string;
  readonly census: ReadySelectorCensusTransaction;
  readonly callId: string;
  readonly nomination?: SelectorObservedCallNomination;
}): SelectorObservedCallResources | null {
  try {
    const { census, nomination = {} } = input, identity = selectorFamilyIdentity(input.signature, input.selector);
    if (census.format !== "ready-selector-census/v1" || census.receiptStatus !== 1 ||
        !Number.isSafeInteger(census.chainId) || census.chainId! < 1 ||
        !Number.isSafeInteger(census.blockNumber) || census.blockNumber! < 0 ||
        !/^0x[0-9a-f]{64}$/i.test(census.blockHash ?? "") || !/^0x[0-9a-f]{64}$/i.test(census.transactionHash ?? "")) return null;
    const matches = census.calls.filter(call => call.id === input.callId);
    if (matches.length !== 1) return null;
    const call = matches[0]!;
    if (!call.target || !call.sender || !call.calldata || call.selector !== identity.selector || call.executionStatus !== "success" ||
        call.callType !== null && !["call", "transaction"].includes(call.callType)) return null;
    const target = address(call.target), sender = address(call.sender);
    const arguments_ = decodeSelectorAbiArguments(input.signature, call.calldata);
    const at = (path: readonly number[]) => selectorAbiParameterAt(input.signature, arguments_, path);
    const declaredAddress = (path: readonly number[] | undefined): string | undefined => {
      if (path === undefined) return undefined;
      const parameter = at(path);
      if (parameter.type !== "address" || typeof parameter.value !== "string") throw new Error("asset resource requires an address ABI parameter");
      return address(parameter.value);
    };
    const declaredId = (path: readonly number[] | undefined): string | undefined => {
      if (path === undefined) return undefined;
      const parameter = at(path);
      if (!/^uint[0-9]+$/.test(parameter.type) || typeof parameter.value !== "string") throw new Error("asset resource requires a uint ABI token id");
      return parameter.value;
    };
    let poolId: string | undefined;
    if (nomination.poolIdPath !== undefined) {
      const parameter = at(nomination.poolIdPath);
      if (typeof parameter.value !== "string") throw new Error("pool resource requires a scalar ABI identifier");
      poolId = parameter.value;
    }
    if (poolId !== undefined && call.poolId !== undefined && poolId !== call.poolId) return null;
    const logPools = new Set<string>();
    for (const layout of nomination.poolIdLogs ?? []) {
      if (layout.emitter !== "call-target" || !/^0x[0-9a-f]{64}$/i.test(layout.topic) ||
          !Number.isSafeInteger(layout.topicIndex) || layout.topicIndex < 1 || layout.topicIndex > 3) return null;
      for (const raw of census.logs) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const log = raw as Record<string, unknown>, emitter = log.address ?? log.log_address;
        if (typeof emitter !== "string" || emitter.toLowerCase() !== target || !Array.isArray(log.topics) ||
            typeof log.topics[0] !== "string" || log.topics[0].toLowerCase() !== layout.topic.toLowerCase()) continue;
        const value = log.topics[layout.topicIndex];
        if (typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value)) logPools.add(value.toLowerCase());
      }
    }
    // A transfer/event is not call attribution. Only a unique declared pool
    // log can supply a missing resource; multiple logs stay explicitly unbound.
    poolId ??= call.poolId ?? (logPools.size === 1 ? [...logPools][0] : undefined);
    const poolNamespace = poolId === undefined ? undefined : nomination.poolNamespace ?? call.poolNamespace ?? "contract-pool-id";
    if (poolId !== undefined && nomination.poolNamespace !== undefined && call.poolNamespace !== undefined &&
        nomination.poolNamespace !== call.poolNamespace) return null;
    const physical = normalizeSelectorExecutionResource({ chainId: census.chainId!, target,
      ...(poolId === undefined ? {} : { poolId, poolNamespace }) });
    const declaredIn = declaredAddress(nomination.tokenInPath), declaredOut = declaredAddress(nomination.tokenOutPath);
    const declaredInId = declaredId(nomination.tokenInIdPath), declaredOutId = declaredId(nomination.tokenOutIdPath);
    const flows = census.tokenFlows.filter(flow => /^[1-9][0-9]*$/.test(flow.amount));
    const compatible = (flow: ReadySelectorCensusTokenFlow, token: string | undefined, tokenId: string | undefined) =>
      (token === undefined || flow.token === token) && (tokenId === undefined || flow.tokenId === tokenId);
    const incoming = flows.filter(flow => compatible(flow, declaredIn, declaredInId) &&
      (flow.to === target && flow.from === sender || flow.token === target && flow.from === sender));
    const outgoing = flows.filter(flow => compatible(flow, declaredOut, declaredOutId) &&
      (flow.from === target && flow.to === sender || flow.token === target && flow.to === sender));
    const uniqueAsset = (items: readonly ReadySelectorCensusTokenFlow[]): ReadySelectorCensusTokenFlow | undefined =>
      new Set(items.map(assetIdentity)).size === 1 ? items[0] : undefined;
    const oneIn = uniqueAsset(incoming), oneOut = uniqueAsset(outgoing);
    const tokenIn = declaredIn ?? oneIn?.token, tokenOut = declaredOut ?? oneOut?.token;
    const tokenInId = declaredInId ?? oneIn?.tokenId, tokenOutId = declaredOutId ?? oneOut?.tokenId;
    // A declared ID can nominate current binding even when the token contract
    // is resolved by a later read. It cannot form a route until that address
    // and its ID are bound together by the execution declaration.
    return freeze({ call: { ...call, flowIndices: [...call.flowIndices],
      traceAddress: call.traceAddress === null ? null : [...call.traceAddress] }, arguments: arguments_, scope: { ...physical,
      ...(tokenIn === undefined ? {} : { tokenIn }), ...(tokenOut === undefined ? {} : { tokenOut }),
      ...(tokenInId === undefined ? {} : { tokenInId }), ...(tokenOutId === undefined ? {} : { tokenOutId }) },
      immutableParameters: selectorImmutableParameters(input.signature, arguments_, nomination.parameterPaths ?? []),
      ...(incoming.length === 1 ? { observedAmountIn: incoming[0]!.amount } : {}), flowAttribution: "address-correlation-only",
      ...(poolId === undefined && logPools.size > 1 ? { unassignedPoolIds: [...logPools].sort() } : {}) });
  } catch { return null; }
}
