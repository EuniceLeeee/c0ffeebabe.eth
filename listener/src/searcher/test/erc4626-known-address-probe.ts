/**
 * ERC4626 execution-family known-address probe on pinned mainnet state.
 *
 * The legacy vault corpus is deliberately supplied as the candidate input.
 * The command proves only real-contract matcher -> identity -> route probe
 * behavior, including nonzero redeem simulation where supported. It does NOT
 * prove that production discovery sourced these addresses and is not a
 * Production Replay or acceptance-11 result.
 *
 * Node + RPC required. Point at a mainnet RPC that supports debug/eth_simulateV1
 * (Alchemy works). Safe no-op when no RPC is configured, so the node-free suite
 * is unaffected:
 *
 *   MAINNET_RPC_URL=<archive-url> npm run searcher:erc4626-known-address-probe
 *   # optional: SEARCHER_ERC4626_PROBE_BLOCK=<n> SEARCHER_ERC4626_PROBE_LIMIT=<k>
 */

import { ethers } from "ethers";
import "../../shared/adapters/index.js";
import {
  createCanonicalProtocolIdentityAttester,
  createPinnedProtocolDiscoveryContext,
  EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  prepareProtocolDiscoveryProjection,
  runProtocolDiscovery,
} from "../protocol-instance-discovery.js";
import { scanProtocolDiscoveryRange } from "../observed-protocol-discovery.js";
import { createProtocolDiscoveryEvidenceCache } from "../protocol-discovery-cache.js";
import { buildStrategyViews } from "../strategy-views.js";
import { buildTokenPaths, type PoolEntry } from "../planner/token-graph.js";
import { PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS } from "../venues/production-registry.js";
import { erc4626Adapter } from "../venues/protocols/erc4626.js";
import { ERC4626_LEGACY_RECALL_VAULTS } from "../venues/protocols/erc4626-legacy-recall.js";

const rpcUrl = process.env.MAINNET_RPC_URL || process.env.SEARCHER_LIVE_RPC_URL || "";
if (!rpcUrl) {
  console.log(
    "erc4626-known-address-probe SKIP (no MAINNET_RPC_URL/SEARCHER_LIVE_RPC_URL configured; " +
      "this validation requires a mainnet RPC with eth_simulateV1 support)",
  );
  process.exit(0);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function redactRpc(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/…`;
  } catch {
    return "<rpc>";
  }
}

const provider = new ethers.JsonRpcProvider(rpcUrl);
const chainId = (await provider.getNetwork()).chainId;
assert(chainId === 1n, `expected mainnet (chainId 1), got ${chainId}`);
const blockNumber = process.env.SEARCHER_ERC4626_PROBE_BLOCK
  ? Number(process.env.SEARCHER_ERC4626_PROBE_BLOCK)
  : 25_571_701;
assert(Number.isSafeInteger(blockNumber) && blockNumber > 0, "invalid pinned block");

const limit = process.env.SEARCHER_ERC4626_PROBE_LIMIT
  ? Number(process.env.SEARCHER_ERC4626_PROBE_LIMIT)
  : ERC4626_LEGACY_RECALL_VAULTS.length;
const vaults = ERC4626_LEGACY_RECALL_VAULTS.slice(0, Math.max(1, limit));

// These addresses are an explicit diagnostic corpus, not a production source.
// Identity is still reverse-verified on-chain per vault.
const graphTokens = [...new Set(
  vaults.flatMap((vault) => [vault.address.toLowerCase(), vault.asset.toLowerCase()]),
)];

console.log(
  `[erc4626-known-address-probe] upstream=${redactRpc(rpcUrl)} block=${blockNumber} ` +
    `vaults=${vaults.length}/${ERC4626_LEGACY_RECALL_VAULTS.length}`,
);

const attest = createCanonicalProtocolIdentityAttester({
  identityRegistry: PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
});
const buildViews = (pools: PoolEntry[]) => buildStrategyViews(pools, [], [], {
  blockscanMaxPools: 200,
  poolUniverseGeneratedAt: "erc4626-known-address-probe",
});

interface VaultOutcome {
  address: string;
  status: "recalled" | "no_code" | "not_admitted" | "no_path" | "error";
  edges: number;
  redeemViaFork: boolean;
  detail?: string;
}

const outcomes: VaultOutcome[] = [];

for (const vault of vaults) {
  const target = ethers.getAddress(vault.address);
  try {
    const context = createPinnedProtocolDiscoveryContext({
      provider,
      blockNumber,
      fromBlock: blockNumber,
      chainId,
      graphTokens,
      retainedInstances: [],
    });
    const code = await context.backend.getCode(target);
    if (code === "0x") {
      outcomes.push({ address: target, status: "no_code", edges: 0, redeemViaFork: false,
        detail: "no contract code at pinned block (deprecated vault)" });
      continue;
    }
    // The known address is supplied; the family still has to reverse-probe it.
    const scan = await scanProtocolDiscoveryRange({
      adapters: [erc4626Adapter],
      context,
      candidateAddresses: [target],
      evidenceCache: createProtocolDiscoveryEvidenceCache(chainId),
    });
    const candidates = scan.candidatesByAdapter.get(erc4626Adapter.id) ?? [];
    if (candidates.length === 0) {
      outcomes.push({ address: target, status: "not_admitted", edges: 0, redeemViaFork: false,
        detail: "address matcher produced no candidate (non-standard vault)" });
      continue;
    }
    const result = await runProtocolDiscovery({
      adapters: [erc4626Adapter],
      context,
      protocolEdgesEnabled: true,
      attestIdentity: attest,
      candidatesByAdapter: scan.candidatesByAdapter,
      sourceComplete: scan.sourceComplete,
      sourceErrors: scan.sourceErrors,
    });
    if (result.wouldAdmit.length === 0) {
      outcomes.push({ address: target, status: "not_admitted", edges: 0, redeemViaFork: false,
        detail: "identity/probe rejected on-chain" });
      continue;
    }
    const admission = result.wouldAdmit[0];
    assert(
      admission.instance.pool.identitySource === "erc4626-standard",
      `${target}: admission must carry a reverse-verified identity credential, not a seed`,
    );
    // A redeem edge from an address-only candidate can only exist if the nonzero
    // fork redeem evidence (item 8, eth_simulateV1) passed on real state.
    const redeemViaFork = admission.edges.some((edge) => edge.adapterId === "erc4626-redeem");
    const projection = prepareProtocolDiscoveryProjection({
      currentOwnership: EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
      result,
      currentBackrunPools: [],
      currentBackrunGraph: [],
      currentKnownPoolKeys: new Set(),
      buildStrategyViews: buildViews,
    });
    const asset = ethers.getAddress(admission.instance.pool.fixedTokenIn ?? vault.asset);
    const pathIn = buildTokenPaths(projection.backrunGraph, asset, target, { maxHops: 2 }).length > 0;
    const pathOut = buildTokenPaths(projection.backrunGraph, target, asset, { maxHops: 2 }).length > 0;
    if (!pathIn && !pathOut) {
      outcomes.push({ address: target, status: "no_path", edges: admission.edges.length, redeemViaFork,
        detail: "admitted but no loop-closable path" });
      continue;
    }
    outcomes.push({ address: target, status: "recalled", edges: admission.edges.length, redeemViaFork });
  } catch (error) {
    outcomes.push({ address: target, status: "error", edges: 0, redeemViaFork: false,
      detail: (error instanceof Error ? error.message : String(error)).slice(0, 160) });
  }
}

const recalled = outcomes.filter((outcome) => outcome.status === "recalled");
const forkRedeems = recalled.filter((outcome) => outcome.redeemViaFork);
const withCode = outcomes.filter((outcome) => outcome.status !== "no_code");

for (const outcome of outcomes) {
  console.log(
    `[erc4626-known-address-probe] ${outcome.address} ${outcome.status} ` +
      `edges=${outcome.edges} fork_redeem=${outcome.redeemViaFork ? 1 : 0}` +
      (outcome.detail ? ` (${outcome.detail})` : ""),
  );
}
console.log(
  `[erc4626-known-address-probe] admitted ${recalled.length}/${withCode.length} live supplied vaults; ` +
    `nonzero fork-redeem evidence on ${forkRedeems.length}; ` +
    `${outcomes.length - withCode.length} deprecated (no code)`,
);

assert(recalled.length > 0, "at least one supplied live vault must pass the real-chain family probe");
assert(forkRedeems.length > 0, "at least one vault must prove a nonzero fork-redeem on real state");
console.log(
  `erc4626-known-address-probe PASS (block ${blockNumber}: ${recalled.length} supplied live vaults ` +
    `admitted, ${forkRedeems.length} with on-chain nonzero fork-redeem evidence; ` +
    "production source discovery and final sim remain unproven)",
);
export {};
