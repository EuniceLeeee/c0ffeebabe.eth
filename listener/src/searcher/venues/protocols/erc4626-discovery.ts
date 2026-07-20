import { ethers } from "ethers";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { TokenEdge } from "../../planner/token-graph.js";
import type {
  AttestedProtocolInstance,
  ProtocolCandidate,
  ProtocolDiscoveryCapability,
  ProtocolDiscoveryContext,
  ProtocolDiscoveryLog,
  ProtocolDiscoveryReceipt,
} from "../route-leg-adapter.js";

const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function deposit(uint256 assets,address receiver) returns (uint256 shares)",
  "function redeem(uint256 shares,address receiver,address owner) returns (uint256 assets)",
  "event Withdraw(address indexed sender,address indexed receiver,address indexed owner,uint256 assets,uint256 shares)",
]);
const WITHDRAW_TOPIC = ERC4626.getEvent("Withdraw")!.topicHash.toLowerCase();
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)").toLowerCase();
const TRANSFER_SELECTOR = ethers.id("transfer(address,uint256)").slice(0, 10).toLowerCase();
const REDEEM_SELECTOR = ethers.id("redeem(uint256,address,address)").slice(0, 10).toLowerCase();
const WITHDRAW_SELECTOR = ethers.id("withdraw(uint256,address,address)").slice(0, 10).toLowerCase();
const IMPLEMENTATION_SLOT = BigInt(
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
);
const ADDRESS_PROBE_AMOUNTS = [10n ** 6n, 10n ** 18n] as const;

export interface Erc4626PayoutEvidence {
  readonly kind: "erc4626-withdraw-payout";
  readonly txHash: string;
  readonly blockNumber: number;
  readonly asset: string;
  readonly receiver: string;
  readonly assets: bigint;
  readonly shares: bigint;
  readonly codeHash: string;
  readonly implementationWord: string;
}

export interface Erc4626AddressEvidence {
  readonly kind: "erc4626-address-probe";
  readonly asset: string;
  readonly sampleAssets: bigint;
  readonly sampleShares: bigint;
  readonly codeHash: string;
  readonly implementationWord: string;
}

export const erc4626Discovery: ProtocolDiscoveryCapability = Object.freeze({
  eventTopics: Object.freeze([WITHDRAW_TOPIC]),
  callSelectors: Object.freeze([REDEEM_SELECTOR, WITHDRAW_SELECTOR]),
  addressMatcherVersion: "erc4626-address-v2",

  async candidateFromAddress(candidate, ctx) {
    const target = ethers.getAddress(candidate.target);
    try {
      const asset = await readAsset(ctx, target);
      if (asset === ethers.ZeroAddress || asset.toLowerCase() === target.toLowerCase()) return null;
      const evidence = await buildAddressEvidence(
        ctx,
        target,
        asset,
        candidate.codeHash,
        candidate.implementationWord,
      );
      if (!evidence) return null;
      return {
        pool: { address: target, adapter: "erc4626" as const, fixedTokenIn: asset },
        source: "dex-universe-address",
        evidence: [evidence],
      };
    } catch (error) {
      if (isRetryableSourceFailure(error)) throw error;
      return null;
    }
  },

  async probeCandidate(instance, ctx) {
    return probeErc4626Candidate(instance, ctx);
  },

  async candidateFromObservedCall(call, ctx) {
    const target = ethers.getAddress(call.target);
    let asset: string;
    try {
      asset = await readAsset(ctx, target);
    } catch (error) {
      if (isRetryableSourceFailure(error)) throw error;
      return null;
    }
    let evidence: Erc4626PayoutEvidence | null;
    try {
      evidence = await erc4626EvidenceFromReceipt({
        context: ctx,
        target,
        asset,
        receipt: call.receipt,
        txHash: call.txHash,
        trace: call.trace,
      });
    } catch (error) {
      if (isRetryableSourceFailure(error)) throw error;
      return null;
    }
    if (!evidence) return null;
    return {
      pool: { address: target, adapter: "erc4626" as const, fixedTokenIn: asset },
      source: "observed-calltrace",
      selector: call.selector,
      evidence: [evidence],
    };
  },
} satisfies ProtocolDiscoveryCapability);

export async function probeErc4626Candidate(
  instance: AttestedProtocolInstance,
  ctx: ProtocolDiscoveryContext,
): Promise<readonly TokenEdge[]> {
  const target = ethers.getAddress(instance.pool.address);
  const expectedAsset = ethers.getAddress(instance.pool.fixedTokenIn ?? ethers.ZeroAddress);
  if (expectedAsset === ethers.ZeroAddress) throw new Error("erc4626 candidate missing asset");
  const asset = await readAsset(ctx, target);
  if (asset.toLowerCase() !== expectedAsset.toLowerCase()) {
    throw new Error("erc4626 asset changed after identity attestation");
  }

  const graphTokens = new Set(ctx.graphTokens.map((token) => token.toLowerCase()));
  if (!graphTokens.has(target.toLowerCase()) && !graphTokens.has(asset.toLowerCase())) {
    throw new Error("erc4626 route is not loop-closable from the current graph");
  }

  const currentCodeHash = ethers.keccak256(await ctx.backend.getCode(target));
  const currentImplementationWord = (await ctx.backend.getStorageAt(target, IMPLEMENTATION_SLOT)).toLowerCase();
  const matchesCurrentFingerprint = (item: {
    readonly asset: string;
    readonly codeHash: string;
    readonly implementationWord: string;
  }): boolean =>
    item.asset.toLowerCase() === asset.toLowerCase() &&
    item.codeHash.toLowerCase() === currentCodeHash.toLowerCase() &&
    item.implementationWord.toLowerCase() === currentImplementationWord;
  const payoutEvidences = instance.evidence
    .filter(isPayoutEvidence)
    .filter(matchesCurrentFingerprint);
  const addressEvidence = instance.evidence.find((item): item is Erc4626AddressEvidence =>
    isAddressEvidence(item) && matchesCurrentFingerprint(item)
  );
  if (payoutEvidences.length === 0 && !addressEvidence) {
    throw new Error("erc4626 route lacks current receipt or address-probe evidence");
  }

  // Current-block evidence has priority and is checked in FULL: any same-block
  // payout that disagrees with the pinned previewRedeem rejects the route, so
  // an older matching evidence can never shadow a fresh contradiction.
  const currentBlockPayouts = payoutEvidences.filter(
    (item) => item.blockNumber === ctx.blockNumber,
  );
  for (const evidence of currentBlockPayouts) {
    const evidenceShares = evidence.shares > 0n ? evidence.shares : 1n;
    const previewForEvidence = await callUint(ctx, target, "previewRedeem", [evidenceShares]);
    if (
      absoluteDifference(previewForEvidence, evidence.assets) >
        roundingTolerance(evidence.assets)
    ) {
      throw new Error("erc4626 same-block previewRedeem disagrees with observed asset payout");
    }
  }
  // Without current-block evidence, the NEWEST fingerprint-matching historical
  // payout drives the sample; historical payout amounts are never compared in
  // absolute terms (vault rates legitimately drift across blocks).
  const payoutEvidence = (currentBlockPayouts.length > 0 ? currentBlockPayouts : payoutEvidences)
    .reduce<Erc4626PayoutEvidence | null>(
      (newest, item) => newest === null || item.blockNumber >= newest.blockNumber ? item : newest,
      null,
    );

  const sampleAssets = payoutEvidence
    ? (payoutEvidence.assets > 0n ? payoutEvidence.assets : 1n)
    : addressEvidence!.sampleAssets;
  const sampleShares = payoutEvidence
    ? (payoutEvidence.shares > 0n ? payoutEvidence.shares : 1n)
    : addressEvidence!.sampleShares;
  const previewDeposit = await callUint(ctx, target, "previewDeposit", [sampleAssets]);
  const previewRedeem = await callUint(ctx, target, "previewRedeem", [sampleShares]);
  if (previewDeposit <= 0n || previewRedeem <= 0n) {
    throw new Error("erc4626 preview returned zero for evidence-derived sample");
  }
  const convertedShares = await callUint(ctx, target, "convertToShares", [sampleAssets]);
  const convertedAssets = await callUint(ctx, target, "convertToAssets", [sampleShares]);
  if (
    previewDeposit > convertedShares + roundingTolerance(convertedShares) ||
    previewRedeem > convertedAssets + roundingTolerance(convertedAssets)
  ) {
    throw new Error("erc4626 preview exceeds standard conversion bound");
  }
  // Adapter-owned cross-block drift invariant: deposit-then-redeem previewed at
  // the CURRENT block must not create value. This replaces any comparison
  // against historical payout absolutes.
  const roundTripAssets = await callUint(ctx, target, "previewRedeem", [previewDeposit]);
  if (roundTripAssets > sampleAssets + roundingTolerance(sampleAssets)) {
    throw new Error("erc4626 current-state round-trip preview inflates value");
  }

  const edges: TokenEdge[] = [];
  if (await supportsZeroAmountCall(ctx, target, "deposit", [0n, target])) {
    edges.push(protocolEdge("erc4626-deposit", target, asset, target, "wrap", instance.pool.score));
  }
  if (
    payoutEvidence ||
    await supportsZeroAmountCall(ctx, target, "redeem", [0n, target, target])
  ) {
    edges.push(protocolEdge("erc4626-redeem", target, target, asset, "redeem", instance.pool.score));
  }
  if (edges.length === 0) {
    throw new Error("erc4626 execution surface rejected both deposit and redeem probes");
  }
  return edges;
}

export async function erc4626EvidenceFromReceipt(input: {
  context: ProtocolDiscoveryContext;
  target: string;
  asset?: string;
  receipt: ProtocolDiscoveryReceipt;
  txHash: string;
  trace?: unknown;
}): Promise<Erc4626PayoutEvidence | null> {
  const target = ethers.getAddress(input.target);
  const asset = input.asset
    ? ethers.getAddress(input.asset)
    : await readAsset(input.context, target).catch(() => null);
  if (!asset) return null;
  const withdraw = [...input.receipt.logs].reverse().find((log) =>
    log.address.toLowerCase() === target.toLowerCase() &&
    log.topics[0]?.toLowerCase() === WITHDRAW_TOPIC
  );
  if (!withdraw) return null;
  return verifyWithdrawPayout(
    input.context,
    target,
    asset,
    { ...withdraw, transactionHash: input.txHash },
    input.receipt,
    input.trace,
  );
}

async function buildAddressEvidence(
  ctx: ProtocolDiscoveryContext,
  target: string,
  asset: string,
  codeHash: string,
  implementationWord: string,
): Promise<Erc4626AddressEvidence | null> {
  let sampleAssets = 0n;
  let sampleShares = 0n;
  for (const assets of ADDRESS_PROBE_AMOUNTS) {
    const shares = await callUint(ctx, target, "convertToShares", [assets]);
    if (shares <= 0n) continue;
    sampleAssets = assets;
    sampleShares = shares;
    break;
  }
  if (sampleAssets === 0n || sampleShares === 0n) return null;
  const roundTripAssets = await callUint(ctx, target, "convertToAssets", [sampleShares]);
  const roundTripDrift = absoluteDifference(roundTripAssets, sampleAssets);
  if (roundTripDrift > roundingTolerance(sampleAssets)) return null;
  const previewDeposit = await callUint(ctx, target, "previewDeposit", [sampleAssets]);
  const previewRedeem = await callUint(ctx, target, "previewRedeem", [sampleShares]);
  if (previewDeposit <= 0n || previewRedeem <= 0n) return null;
  if (
    previewDeposit > sampleShares + roundingTolerance(sampleShares) ||
    previewRedeem > roundTripAssets + roundingTolerance(roundTripAssets)
  ) return null;
  return {
    kind: "erc4626-address-probe",
    asset,
    sampleAssets,
    sampleShares,
    codeHash: codeHash.toLowerCase(),
    implementationWord: implementationWord.toLowerCase(),
  };
}

async function verifyWithdrawPayout(
  ctx: ProtocolDiscoveryContext,
  target: string,
  asset: string,
  log: ProtocolDiscoveryLog,
  knownReceipt?: ProtocolDiscoveryReceipt,
  knownTrace?: unknown,
): Promise<Erc4626PayoutEvidence | null> {
  if (log.topics[0]?.toLowerCase() !== WITHDRAW_TOPIC || log.topics.length < 4) return null;
  const txHash = log.transactionHash;
  if (!txHash) return null;
  let receiver: string;
  let owner: string;
  let assets: bigint;
  let shares: bigint;
  try {
    receiver = ethers.getAddress(`0x${log.topics[2].slice(-40)}`);
    owner = ethers.getAddress(`0x${log.topics[3].slice(-40)}`);
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["uint256", "uint256"], log.data);
    assets = BigInt(decoded[0]);
    shares = BigInt(decoded[1]);
  } catch {
    // A contract can emit the same topic with malformed payloads. That is a
    // semantic non-match, not an RPC-source failure that should pin the cursor.
    return null;
  }
  const receipt = knownReceipt ?? await ctx.backend.getTransactionReceipt(txHash);
  if (!receipt || receipt.status !== 1) return null;
  const paid = receipt.logs.some((item) => {
    if (item.address.toLowerCase() !== asset.toLowerCase()) return false;
    if (item.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || item.topics.length < 3) return false;
    const from = `0x${item.topics[1].slice(-40)}`.toLowerCase();
    if (from !== target.toLowerCase()) return false;
    const to = `0x${item.topics[2].slice(-40)}`.toLowerCase();
    if (to !== receiver.toLowerCase()) return false;
    try {
      return BigInt(item.data) >= assets;
    } catch {
      return false;
    }
  });
  if (!paid) return null;
  const burned = receipt.logs.some((item) => {
    if (item.address.toLowerCase() !== target.toLowerCase()) return false;
    if (item.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || item.topics.length < 3) return false;
    const from = `0x${item.topics[1].slice(-40)}`.toLowerCase();
    const to = item.topics[2]?.toLowerCase();
    if (from !== owner.toLowerCase() || to !== `0x${"0".repeat(64)}`) return false;
    try {
      return BigInt(item.data) >= shares;
    } catch {
      return false;
    }
  });
  if (!burned) return null;
  const trace = knownTrace ?? await ctx.backend.traceTransaction(txHash);
  if (!trace || !traceHasCausalExit(trace, target, asset, receiver, assets, shares)) {
    return null;
  }
  const evidenceBlock = log.blockNumber;
  if (!Number.isSafeInteger(evidenceBlock) || evidenceBlock === undefined || evidenceBlock < 0) return null;
  if (shares <= 0n || assets <= 0n) return null;
  // The receipt/trace proves that the interaction happened. Identity evidence
  // is deliberately current-state only so a pruned local reth never needs an
  // archive-state eth_getCode/eth_getStorageAt fallback.
  const code = await ctx.backend.getCode(target);
  if (code === "0x") return null;
  return {
    kind: "erc4626-withdraw-payout",
    txHash,
    blockNumber: evidenceBlock,
    asset,
    receiver,
    assets,
    shares,
    codeHash: ethers.keccak256(code),
    implementationWord: (await ctx.backend.getStorageAt(target, IMPLEMENTATION_SLOT)).toLowerCase(),
  };
}

async function readAsset(ctx: ProtocolDiscoveryContext, target: string): Promise<string> {
  const raw = await ctx.backend.call({ to: target, data: ERC4626.encodeFunctionData("asset") });
  return ethers.getAddress(String(ERC4626.decodeFunctionResult("asset", raw)[0]));
}

async function callUint(
  ctx: ProtocolDiscoveryContext,
  target: string,
  fn: "convertToShares" | "convertToAssets" | "previewDeposit" | "previewRedeem",
  args: readonly bigint[],
): Promise<bigint> {
  const raw = await ctx.backend.call({ to: target, data: ERC4626.encodeFunctionData(fn, args) });
  return BigInt(ERC4626.decodeFunctionResult(fn, raw)[0]);
}

async function supportsZeroAmountCall(
  ctx: ProtocolDiscoveryContext,
  target: string,
  fn: "deposit" | "redeem",
  args: readonly unknown[],
): Promise<boolean> {
  try {
    const raw = await ctx.backend.call({
      from: target,
      to: target,
      data: ERC4626.encodeFunctionData(fn, args),
    });
    ERC4626.decodeFunctionResult(fn, raw);
    return true;
  } catch (error) {
    if (isRetryableSourceFailure(error)) throw error;
    return false;
  }
}

function protocolEdge(
  adapterId: "erc4626-deposit" | "erc4626-redeem",
  target: string,
  tokenIn: string,
  tokenOut: string,
  protocolAction: "wrap" | "redeem",
  score?: number,
): TokenEdge {
  return {
    adapterId,
    target,
    tokenIn,
    tokenOut,
    slotKind: "protocol",
    protocolAction,
    score,
    ...deriveEdgeTaxonomy("protocol", protocolAction),
  };
}

function isPayoutEvidence(value: unknown): value is Erc4626PayoutEvidence {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Erc4626PayoutEvidence>;
  return item.kind === "erc4626-withdraw-payout" &&
    typeof item.asset === "string" &&
    typeof item.codeHash === "string" &&
    typeof item.implementationWord === "string" &&
    typeof item.assets === "bigint" &&
    typeof item.shares === "bigint";
}

function isAddressEvidence(value: unknown): value is Erc4626AddressEvidence {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Erc4626AddressEvidence>;
  return item.kind === "erc4626-address-probe" &&
    typeof item.asset === "string" &&
    typeof item.sampleAssets === "bigint" &&
    typeof item.sampleShares === "bigint" &&
    typeof item.codeHash === "string" &&
    typeof item.implementationWord === "string";
}

function roundingTolerance(value: bigint): bigint {
  return value / 1_000n + 2n;
}

function absoluteDifference(left: bigint, right: bigint): bigint {
  return left > right ? left - right : right - left;
}

function traceHasCausalExit(
  trace: unknown,
  target: string,
  asset: string,
  receiver: string,
  assets: bigint,
  shares: bigint,
): boolean {
  const subtreeTransfersAsset = (node: unknown, ancestorFailed: boolean): boolean => {
    if (!node || typeof node !== "object") return false;
    const call = node as { to?: unknown; input?: unknown; error?: unknown; calls?: unknown };
    const failed = ancestorFailed || Boolean(call.error);
    if (
      !failed &&
      typeof call.to === "string" &&
      call.to.toLowerCase() === asset.toLowerCase() &&
      typeof call.input === "string"
    ) {
      const input = call.input.toLowerCase();
      if (input.startsWith(TRANSFER_SELECTOR) && input.length >= 10 + 64 * 2) {
        try {
          const decodedReceiver = ethers.getAddress(`0x${input.slice(10, 74).slice(-40)}`);
          const amount = BigInt(`0x${input.slice(74, 138)}`);
          if (decodedReceiver.toLowerCase() === receiver.toLowerCase() && amount >= assets) {
            return true;
          }
        } catch {
          // Malformed ERC20 calldata cannot bind the payout to this call tree.
        }
      }
    }
    return Array.isArray(call.calls) &&
      call.calls.some((child) => subtreeTransfersAsset(child, failed));
  };
  const visit = (node: unknown, ancestorFailed: boolean): boolean => {
    if (!node || typeof node !== "object") return false;
    const call = node as { to?: unknown; input?: unknown; error?: unknown; calls?: unknown };
    const failed = ancestorFailed || Boolean(call.error);
    if (!failed && typeof call.to === "string" && typeof call.input === "string") {
      const input = call.input.toLowerCase();
      if (call.to.toLowerCase() === target.toLowerCase() && input.length >= 10 + 64 * 3) {
        try {
          const selector = input.slice(0, 10);
          const amount = BigInt(`0x${input.slice(10, 74)}`);
          const decodedReceiver = ethers.getAddress(`0x${input.slice(74, 138).slice(-40)}`);
          if (
            decodedReceiver.toLowerCase() === receiver.toLowerCase() &&
            ((selector === REDEEM_SELECTOR && amount === shares) ||
              (selector === WITHDRAW_SELECTOR && amount === assets))
          ) return subtreeTransfersAsset(node, failed);
        } catch {
          // Malformed calldata cannot establish a causal ERC4626 exit.
        }
      }
    }
    return Array.isArray(call.calls) && call.calls.some((child) => visit(child, failed));
  };
  return visit(trace, false);
}

function isRetryableSourceFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/prun(?:ed|ing)|historical state.*(?:unavailable|missing)|missing trie node/i.test(message)) {
    // Local reth may legitimately no longer retain an old state snapshot. The
    // evidence is insufficient, but retrying the same event window cannot fix it.
    return false;
  }
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  // Contract-level negatives are ordinary candidate rejection. Transport,
  // timeout and server failures must leave the source cursor retryable.
  if (code === "CALL_EXCEPTION" || code === "BAD_DATA" || code === "INVALID_ARGUMENT") {
    return false;
  }
  return !/execution reverted|could not decode|invalid (?:result|data)/i.test(message);
}
