/**
 * No-seed recall + C2 fork-redeem — REAL-CHAIN validation (impl spec §四
 * acceptance 10 + 11 discovery half, on live mainnet state).
 *
 * With every standard ERC4626 static seed physically removed from
 * POOL_REGISTRY, each former hardcoded vault must be re-enumerated purely from
 * its address on the real chain: scanner self-enumerate -> on-chain identity
 * attest -> route probe (deposit zero-amount + NONZERO redeem via
 * eth_simulateV1 state override, item 8) -> loop-closable edge -> path_found.
 * No static seed grants admission at any step.
 *
 * Node + RPC required. Point at a mainnet RPC that supports debug/eth_simulateV1
 * (Alchemy works). Safe no-op when no RPC is configured, so the node-free suite
 * is unaffected:
 *
 *   MAINNET_RPC_URL=<alchemy-url> npm run searcher:protocol-no-seed-onchain
 *   # optional: SEARCHER_NO_SEED_ONCHAIN_BLOCK=<n>  SEARCHER_NO_SEED_ONCHAIN_LIMIT=<k>
 *
 * The remaining acceptance-11 step (BotVM final_sim_success) runs in the
 * blockscan-hunt no-seed mode on the operator node (needs anvil).
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
import { buildTokenPaths, POOL_REGISTRY, type PoolEntry } from "../planner/token-graph.js";
import { PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS } from "../venues/production-registry.js";
import { erc4626Adapter } from "../venues/protocols/erc4626.js";
import { ERC4626_LEGACY_RECALL_VAULTS } from "../venues/protocols/erc4626-legacy-recall.js";

const rpcUrl = process.env.MAINNET_RPC_URL || process.env.SEARCHER_LIVE_RPC_URL || "";
if (!rpcUrl) {
  console.log(
    "protocol-no-seed-onchain SKIP (no MAINNET_RPC_URL/SEARCHER_LIVE_RPC_URL configured; " +
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

// Physical removal is real before any on-chain work.
assert(
  !POOL_REGISTRY.some((pool) => pool.adapter === "erc4626" && !pool.nonStandardRedeem),
  "no-seed precondition: standard ERC4626 seeds must be absent from POOL_REGISTRY",
);

const provider = new ethers.JsonRpcProvider(rpcUrl);
const chainId = (await provider.getNetwork()).chainId;
assert(chainId === 1n, `expected mainnet (chainId 1), got ${chainId}`);
const blockNumber = process.env.SEARCHER_NO_SEED_ONCHAIN_BLOCK
  ? Number(process.env.SEARCHER_NO_SEED_ONCHAIN_BLOCK)
  : (await provider.getBlockNumber()) - 5;
assert(Number.isSafeInteger(blockNumber) && blockNumber > 0, "invalid pinned block");

const limit = process.env.SEARCHER_NO_SEED_ONCHAIN_LIMIT
  ? Number(process.env.SEARCHER_NO_SEED_ONCHAIN_LIMIT)
  : ERC4626_LEGACY_RECALL_VAULTS.length;
const vaults = ERC4626_LEGACY_RECALL_VAULTS.slice(0, Math.max(1, limit));

// The recall vault addresses stand in for DEX-universe tokens: the answer key
// supplies only the address to probe, never an admission credential. Identity
// is reverse-verified on-chain per vault. Loop-closability holds because each
// vault address is in graphTokens.
const graphTokens = [...new Set(
  vaults.flatMap((vault) => [vault.address.toLowerCase(), vault.asset.toLowerCase()]),
)];

console.log(
  `[no-seed-onchain] upstream=${redactRpc(rpcUrl)} block=${blockNumber} ` +
    `vaults=${vaults.length}/${ERC4626_LEGACY_RECALL_VAULTS.length}`,
);

const attest = createCanonicalProtocolIdentityAttester({
  identityRegistry: PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
});
const buildViews = (pools: PoolEntry[]) => buildStrategyViews(pools, [], [], {
  blockscanMaxPools: 200,
  poolUniverseGeneratedAt: "no-seed-onchain",
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
    // Address-source only: no Withdraw event, no seed. The scanner reverse-probes
    // the address as a DEX-universe token candidate.
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
    `[no-seed-onchain] ${outcome.address} ${outcome.status} ` +
      `edges=${outcome.edges} fork_redeem=${outcome.redeemViaFork ? 1 : 0}` +
      (outcome.detail ? ` (${outcome.detail})` : ""),
  );
}
console.log(
  `[no-seed-onchain] recall ${recalled.length}/${withCode.length} live vaults re-enumerated seedless; ` +
    `nonzero fork-redeem evidence on ${forkRedeems.length}; ` +
    `${outcomes.length - withCode.length} deprecated (no code)`,
);

// The recall gate: every vault whose code is still deployed must be
// re-enumerated seedless. A deprecated (no_code) vault is excused; anything
// else is a real recall regression.
const regressions = withCode.filter((outcome) => outcome.status !== "recalled");
if (regressions.length > 0) {
  console.log(
    `protocol-no-seed-onchain FAIL: ${regressions.length} live vault(s) not recalled seedless: ` +
      regressions.map((outcome) => `${outcome.address}=${outcome.status}`).join(", "),
  );
  process.exit(1);
}
assert(forkRedeems.length > 0, "at least one vault must prove a nonzero fork-redeem on real state");
console.log(
  `protocol-no-seed-onchain PASS (block ${blockNumber}: ${recalled.length} live recall vaults ` +
    `re-enumerated seedless, ${forkRedeems.length} with on-chain nonzero fork-redeem evidence; ` +
    "final_sim_success remains the operator-node blockscan-hunt no-seed step)",
);
export {};
