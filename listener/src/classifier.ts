/**
 * Trace Classifier — reads debug_traceTransaction(callTracer)
 * and builds a NormalizedCallNode tree of BotVM's direct actions.
 *
 * Key rules:
 * 1. Only CALL type (skip DELEGATECALL, STATICCALL, CREATE)
 * 2. Only BotVM's direct external calls become plan nodes
 * 3. Protocol callbacks (receiveFlashLoan, uniswapV3SwapCallback, etc.)
 *    are transparent — their children become children of the parent wrapper
 * 4. Internal protocol calls (from != BotVM) are excluded
 */

import { ActionKind } from "./types.js";
import type { NormalizedCallNode } from "./types.js";

// ─── Known Selectors ───────────────────────────────────────────

const SELECTOR_MAP: Record<string, { kind: ActionKind; protocol: string }> = {
  "0xe0232b42": { kind: ActionKind.FlashLoan, protocol: "morpho" },
  "0x5c38449e": { kind: ActionKind.FlashLoan, protocol: "balancer" },
  "0x032d2276": { kind: ActionKind.Lend, protocol: "fluid-vault" },
  "0x8433ea22": { kind: ActionKind.Lend, protocol: "fluid-dex-liquidate" },
  "0xbe17c79c": { kind: ActionKind.Lend, protocol: "fluid-dex-swap" },
  "0x128acb08": { kind: ActionKind.Swap, protocol: "univ3" },
  "0x48c89491": { kind: ActionKind.Swap, protocol: "univ4" },
  "0x022c0d9f": { kind: ActionKind.Swap, protocol: "univ2" },
  "0x3df02124": { kind: ActionKind.Swap, protocol: "curve" },
  "0x7e3db030": { kind: ActionKind.Swap, protocol: "curve" },
  "0xafb43012": { kind: ActionKind.Swap, protocol: "curve" },
  "0x767691e7": { kind: ActionKind.Swap, protocol: "curve" },
  "0xcb70e273": { kind: ActionKind.Swap, protocol: "curve-router" },
  "0x95991276": { kind: ActionKind.Swap, protocol: "psm" },
  "0xde0e9a3e": { kind: ActionKind.Wrap, protocol: "wsteth-unwrap" },
  "0xea598cb0": { kind: ActionKind.Wrap, protocol: "wsteth-wrap" },
  "0x095ea7b3": { kind: ActionKind.Approve, protocol: "erc20" },
  "0xa9059cbb": { kind: ActionKind.Transfer, protocol: "erc20" },
  "0x2e1a7d4d": { kind: ActionKind.Transfer, protocol: "weth-withdraw" },
  // V4 internal ops (leaves inside unlock callback)
  "0xf3cd914c": { kind: ActionKind.Swap, protocol: "univ4-swap" },
  "0x0b0d9c09": { kind: ActionKind.Transfer, protocol: "univ4-take" },
  "0xa5841194": { kind: ActionKind.Transfer, protocol: "univ4-sync" },
  "0x11da60b4": { kind: ActionKind.Transfer, protocol: "univ4-settle" },
  // UniV2-style routers (leaf — router handles callback internally)
  "0x38ed1739": { kind: ActionKind.Swap, protocol: "univ2-router" },
  "0x6c08c57e": { kind: ActionKind.Swap, protocol: "univ2-router-alt" },
};

// Callback selectors — these are protocol callbacks TO BotVM.
// We treat them as transparent: extract BotVM's actions from inside.
const CALLBACK_SELECTORS = new Set([
  "0xf04f2707", // Balancer receiveFlashLoan
  "0xfa461e33", // UniV3 uniswapV3SwapCallback
  "0x91dd7346", // UniV4 unlockCallback
  "0x10d1e85c", // UniV2 uniswapV2Call
  "0x9410ae88", // FluidDex dexCallback
  "0x8cbf8566", // BotVM execute (entry point)
]);

// Known read-only calls emitted by the original BotVM during dynamic amount
// calculation or guards. They are not replayable action nodes.
const IGNORED_SELECTORS = new Set([
  "0x70a08231", // balanceOf(address)
]);

// ─── callTracer types ──────────────────────────────────────────

interface CallTrace {
  type: string; // CALL, DELEGATECALL, STATICCALL, CREATE
  from: string;
  to: string;
  input: string;
  output?: string;
  value?: string;
  calls?: CallTrace[];
}

// ─── Main Entry ────────────────────────────────────────────────

export async function classifyTrace(
  txHash: string,
  provider: import("ethers").JsonRpcProvider,
): Promise<NormalizedCallNode> {
  const trace: CallTrace = await provider.send("debug_traceTransaction", [
    txHash,
    { tracer: "callTracer", tracerConfig: { onlyTopCall: false } },
  ]);

  // The top-level call is usually to BotVM.execute()
  // We want to find the BotVM address and then extract its direct calls
  const botVm = trace.to?.toLowerCase() ?? "";

  const counter = { value: 0 };
  const root = extractBotVmActions(trace, botVm, 0, counter);
  return root;
}

/**
 * Recursively extract BotVM's direct actions from the call trace.
 *
 * Logic:
 * - If current call is FROM BotVM TO a protocol: it's a direct action → create node
 * - If current call is a callback TO BotVM: transparent → extract children
 * - DELEGATECALL, STATICCALL: skip entirely
 * - Internal protocol calls (from != BotVM): skip
 */
function extractBotVmActions(
  trace: CallTrace,
  botVm: string,
  depth: number,
  counter: { value: number },
): NormalizedCallNode {
  const selector = trace.input?.slice(0, 10)?.toLowerCase() ?? "";
  const target = trace.to?.toLowerCase() ?? "";
  const from = trace.from?.toLowerCase() ?? "";
  const type = trace.type?.toUpperCase() ?? "CALL";

  const info = SELECTOR_MAP[selector];

  // Create this node
  const node: NormalizedCallNode = {
    kind: info?.kind ?? ActionKind.Transfer,
    protocol: info?.protocol ?? "unknown",
    target: trace.to ?? "",
    selector,
    depth,
    callIndex: counter.value++,
    calldata: trace.input ?? "",
    children: [],
  };

  if (!trace.calls) return node;

  for (const sub of trace.calls) {
    const subType = sub.type?.toUpperCase() ?? "CALL";
    const subFrom = sub.from?.toLowerCase() ?? "";
    const subTo = sub.to?.toLowerCase() ?? "";
    const subSel = sub.input?.slice(0, 10)?.toLowerCase() ?? "";

    // Skip non-CALL types (DELEGATECALL, STATICCALL, CREATE)
    if (subType !== "CALL") continue;
    if (IGNORED_SELECTORS.has(subSel)) continue;

    // Case 1: Any CALL to BotVM = callback entry (BotVM uses fallback for all callbacks)
    // → Transparent: extract BotVM's actions from inside
    if (subTo === botVm) {
      const callbackActions = extractCallbackActions(sub, botVm, depth + 1, counter);
      node.children.push(...callbackActions);
      continue;
    }

    // Case 2: BotVM calling a protocol (direct action)
    if (subFrom === botVm) {
      const childNode = extractBotVmActions(sub, botVm, depth + 1, counter);
      // Only include if it's a recognized action
      if (childNode.protocol !== "unknown") {
        node.children.push(childNode);
      }
      continue;
    }

    // Case 3: Internal protocol call (from != BotVM) — skip
    // But still recurse to find any callbacks TO BotVM deeper down
    findDeepCallbacks(sub, botVm, depth + 1, counter, node);
  }

  return node;
}

/**
 * Extract BotVM's direct actions from inside a callback entry.
 */
function extractCallbackActions(
  callbackTrace: CallTrace,
  botVm: string,
  depth: number,
  counter: { value: number },
): NormalizedCallNode[] {
  const actions: NormalizedCallNode[] = [];

  if (!callbackTrace.calls) return actions;

  for (const sub of callbackTrace.calls) {
    const subType = sub.type?.toUpperCase() ?? "CALL";
    const subFrom = sub.from?.toLowerCase() ?? "";
    const subSel = sub.input?.slice(0, 10)?.toLowerCase() ?? "";

    if (subType !== "CALL") continue;
    if (IGNORED_SELECTORS.has(subSel)) continue;

    // BotVM making a direct call from inside the callback
    // Capture ALL calls from BotVM, not just known selectors
    if (subFrom === botVm) {
      const childNode = extractBotVmActions(sub, botVm, depth, counter);
      actions.push(childNode);
      continue;
    }
  }

  return actions;
}

/**
 * Look for deep callbacks to BotVM inside internal protocol calls.
 * Example: BotVM → V4.unlock → V4 calls BotVM.unlockCallback → BotVM actions
 */
function findDeepCallbacks(
  trace: CallTrace,
  botVm: string,
  depth: number,
  counter: { value: number },
  parentNode: NormalizedCallNode,
): void {
  if (!trace.calls) return;

  for (const sub of trace.calls) {
    const subType = sub.type?.toUpperCase() ?? "CALL";
    const subTo = sub.to?.toLowerCase() ?? "";
    const subSel = sub.input?.slice(0, 10)?.toLowerCase() ?? "";

    if (subType !== "CALL") continue;
    if (IGNORED_SELECTORS.has(subSel)) continue;

    if (subTo === botVm) {
      const callbackActions = extractCallbackActions(sub, botVm, depth, counter);
      parentNode.children.push(...callbackActions);
    } else {
      // Keep looking deeper
      findDeepCallbacks(sub, botVm, depth, counter, parentNode);
    }
  }
}

// ─── Utilities ─────────────────────────────────────────────────

export function collectBotVmDirectCalls(
  node: NormalizedCallNode,
  _botVmAddress: string,
): NormalizedCallNode[] {
  const result: NormalizedCallNode[] = [];
  function walk(n: NormalizedCallNode) {
    if (n.protocol !== "unknown") result.push(n);
    for (const child of n.children) walk(child);
  }
  for (const child of node.children) walk(child);
  return result;
}

export function flattenTree(root: NormalizedCallNode): NormalizedCallNode[] {
  const result: NormalizedCallNode[] = [];
  function walk(n: NormalizedCallNode) {
    result.push(n);
    for (const child of n.children) walk(child);
  }
  walk(root);
  return result;
}
