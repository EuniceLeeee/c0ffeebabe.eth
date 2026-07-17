import { ethers } from "ethers";
import { get as getActionAdapter } from "../adapters/registry.js";
import type {
  ProtocolCandidate,
  ProtocolConversionAdapter,
  ProtocolDiscoveryContext,
  ProtocolDiscoveryLog,
  ProtocolDiscoveryReceipt,
} from "./venues/route-leg-adapter.js";

const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)").toLowerCase();
const ERC4626_TOPICS = new Set([
  ethers.id("Deposit(address,address,uint256,uint256)").toLowerCase(),
  ethers.id("Withdraw(address,address,address,uint256,uint256)").toLowerCase(),
]);
const LP_TOPICS = new Set([
  ethers.id("Mint(address,uint256,uint256)").toLowerCase(),
  ethers.id("Burn(address,uint256,uint256,address)").toLowerCase(),
  ethers.id("Mint(address,address,int24,int24,uint128,uint256,uint256)").toLowerCase(),
  ethers.id("Burn(address,int24,int24,uint128,uint256,uint256)").toLowerCase(),
  ethers.id("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)").toLowerCase(),
]);
const ZERO_TOPIC = `0x${"0".repeat(64)}`;

export interface UnknownProtocolSelectorDiagnostic {
  readonly target: string;
  readonly selector: string;
  readonly reason: "protocol_like_flow_unknown_selector";
  readonly recommendation: "inspect_calltrace";
}

export interface ObservedProtocolDiscoveryResult {
  readonly candidatesByAdapter: ReadonlyMap<string, readonly ProtocolCandidate[]>;
  readonly unknownSelectors: readonly UnknownProtocolSelectorDiagnostic[];
}

/** Receipt-only, cheap gate for deciding whether a call trace can teach us a protocol route. */
export function shouldTraceForProtocolDiscovery(logs: readonly ProtocolDiscoveryLog[]): boolean {
  if (logs.some((log) => ERC4626_TOPICS.has(log.topics[0]?.toLowerCase() ?? ""))) return true;
  const lpEmitters = new Set(
    logs
      .filter((log) => LP_TOPICS.has(log.topics[0]?.toLowerCase() ?? ""))
      .map((log) => log.address.toLowerCase()),
  );
  const minted = new Set<string>();
  const burned = new Set<string>();
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    if (log.topics[1]?.toLowerCase() === ZERO_TOPIC) minted.add(log.address.toLowerCase());
    if (log.topics[2]?.toLowerCase() === ZERO_TOPIC) burned.add(log.address.toLowerCase());
  }
  if (minted.size === 0 || burned.size === 0) return false;
  if (lpEmitters.size === 0) return true;
  // Suppress a pure LP mint/burn, but do not hide a separate protocol burn+mint
  // merely because the same transaction also touched an LP.
  return [...minted].some((address) => !lpEmitters.has(address)) &&
    [...burned].some((address) => !lpEmitters.has(address));
}

/**
 * Selector matching only shortlists address+selector pairs. Each adapter must
 * still construct a candidate and the shared coordinator must attest identity
 * and probe routes before any graph mutation.
 */
export async function scanObservedProtocolTrace(input: {
  adapters: readonly ProtocolConversionAdapter[];
  context: ProtocolDiscoveryContext;
  txHash: string;
  receipt: ProtocolDiscoveryReceipt;
  trace: unknown;
  seenAddressSelectors?: ReadonlySet<string>;
}): Promise<ObservedProtocolDiscoveryResult> {
  const candidatesByAdapter = new Map<string, ProtocolCandidate[]>();
  const unknownSelectors: UnknownProtocolSelectorDiagnostic[] = [];
  const calls = successfulCalls(input.trace);
  const protocolLike = shouldTraceForProtocolDiscovery(input.receipt.logs);
  const seenCandidates = new Set<string>();
  const seenUnknown = new Set<string>();

  for (const call of calls) {
    let callMatched = false;
    for (const adapter of input.adapters) {
      const discovery = adapter.discovery;
      if (!discovery?.candidateFromObservedCall) continue;
      const selectorMatches = adapter.edgeAdapterIds.some((edgeAdapterId) => {
        try {
          return getActionAdapter(edgeAdapterId).matchTrace(call.target, call.selector);
        } catch {
          return false;
        }
      });
      if (!selectorMatches) continue;
      callMatched = true;
      const addressSelectorKey = `${call.target.toLowerCase()}|${call.selector}`;
      if (input.seenAddressSelectors?.has(addressSelectorKey)) continue;
      const key = `${adapter.id}|${call.target.toLowerCase()}|${call.selector}`;
      if (seenCandidates.has(key)) continue;
      seenCandidates.add(key);
      const candidate = await discovery.candidateFromObservedCall({
        ...call,
        txHash: input.txHash,
        receipt: input.receipt,
      }, input.context).catch(() => null);
      if (!candidate) continue;
      const list = candidatesByAdapter.get(adapter.id) ?? [];
      list.push(candidate);
      candidatesByAdapter.set(adapter.id, list);
    }
    if (protocolLike && !callMatched) {
      const key = `${call.target.toLowerCase()}|${call.selector}`;
      if (seenUnknown.has(key) || unknownSelectors.length >= 8) continue;
      seenUnknown.add(key);
      unknownSelectors.push({
        target: call.target,
        selector: call.selector,
        reason: "protocol_like_flow_unknown_selector",
        recommendation: "inspect_calltrace",
      });
    }
  }

  // Diagnostics stay separate from graph admission. A transaction can contain
  // one verified route and a second unregistered protocol-like selector; the
  // verified edge remains clean while the unknown pair is still observable.
  return { candidatesByAdapter, unknownSelectors };
}

interface ObservedCall {
  readonly target: string;
  readonly selector: string;
}

function successfulCalls(trace: unknown): ObservedCall[] {
  const result: ObservedCall[] = [];
  const visit = (node: unknown, ancestorFailed: boolean): void => {
    if (!node || typeof node !== "object") return;
    const call = node as { to?: unknown; input?: unknown; error?: unknown; calls?: unknown };
    const failed = ancestorFailed || Boolean(call.error);
    if (!failed && typeof call.to === "string" && typeof call.input === "string") {
      const selector = call.input.slice(0, 10).toLowerCase();
      if (/^0x[0-9a-f]{8}$/.test(selector)) {
        try {
          result.push({ target: ethers.getAddress(call.to), selector });
        } catch {
          // malformed trace target
        }
      }
    }
    if (Array.isArray(call.calls)) {
      for (const child of call.calls) visit(child, failed);
    }
  };
  visit(trace, false);
  return result;
}
