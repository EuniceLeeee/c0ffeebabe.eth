import { ethers } from "ethers";
import { discoverErc20BalanceStorageSlot } from "../../protocol-discovery-erc20-state.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type {
  AttestedProtocolInstance,
  ProtocolCandidate,
  ProtocolDiscoveryCapability,
  ProtocolDiscoveryContext,
  ProtocolDiscoveryLog,
} from "../route-leg-adapter.js";
import type { OnchainIdentityResolver } from "../identity.js";
import type { TokenEdge } from "../../planner/token-graph.js";

const SILO = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
  "function redeem(address token,uint256 shares,address receiver,address owner) returns (uint256 amountOut)",
  "function withdraw(address token,uint256 assets,address receiver,address owner) returns (uint256 shares)",
  "event Withdraw(address indexed sender,address indexed receiver,address indexed owner,uint256 assets,uint256 shares)",
]);
const PAYOUT = new ethers.Interface([
  "function asset() view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function previewWithdraw(uint256 assets) view returns (uint256 shares)",
]);
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)").toLowerCase();
const WITHDRAW_TOPIC = SILO.getEvent("Withdraw")!.topicHash.toLowerCase();
const REDEEM_SELECTOR = SILO.getFunction("redeem")!.selector.toLowerCase();
const WITHDRAW_SELECTOR = SILO.getFunction("withdraw")!.selector.toLowerCase();
const IMPLEMENTATION_SLOT = BigInt(
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
);
const DEFAULT_SAMPLE_SHARES = 10n ** 18n;
const PAYOUT_SCAN_CONCURRENCY = 24;
const payoutAssetIndexByContext = new WeakMap<
  object,
  Promise<ReadonlyMap<string, readonly string[]>>
>();

export const ERC4626_SILO_REDEEM_CANDIDATE_ADDRESS_HINTS = Object.freeze([
  // Provenance only. No payout token, quote, route, or identity is encoded
  // here; all executable semantics are derived and proven at current block N.
  "0x3d7d6fdf07EE548B939A80edbc9B2256d0cdc003",
] as const);

export const ERC4626_SILO_PROBE_HOLDER = ethers.getAddress(
  `0x${"00".repeat(18)}51a0`,
);
export const ERC4626_SILO_PROBE_RECEIVER = ethers.getAddress(
  `0x${"00".repeat(18)}51a1`,
);

interface SiloCandidateEvidence {
  readonly kind: "erc4626-silo-payout-candidate";
  readonly underlyingAsset: string;
  readonly payoutTokens: readonly string[];
  readonly sampleShares: bigint;
  readonly sampleAssets: bigint;
  readonly codeHash: string;
  readonly implementationWord: string;
  readonly source: "address-behavior" | "observed-call";
}

interface TargetSurface {
  readonly underlyingAsset: string;
  readonly totalSupply: bigint;
  readonly sampleShares: bigint;
  readonly sampleAssets: bigint;
  readonly codeHash: string;
  readonly implementationWord: string;
}

export const erc4626SiloRedeemIdentityResolver: OnchainIdentityResolver = async ({
  backend,
  pool,
  poolAdapter,
}) => {
  if (poolAdapter !== "erc4626-silo-redeem") {
    throw new Error(
      `erc4626 silo identity resolver: unsupported pool adapter ${poolAdapter}`,
    );
  }
  if (!backend.getCode) return { ok: false, reason: "identity_call_failed" };
  try {
    const code = await backend.getCode(pool);
    if (code === "0x") return { ok: false, reason: "behavior_mismatch" };
    const asset = await callAddressBackend(backend, pool, SILO, "asset");
    if (asset === ethers.ZeroAddress || asset.toLowerCase() === pool.toLowerCase()) {
      return { ok: false, reason: "behavior_mismatch" };
    }
    if (await backend.getCode(asset) === "0x") {
      return { ok: false, reason: "behavior_mismatch" };
    }
    const totalSupply = await callUintBackend(backend, pool, SILO, "totalSupply", []);
    if (totalSupply <= 1n) return { ok: false, reason: "behavior_mismatch" };
    const sampleShares = totalSupply / 2n < DEFAULT_SAMPLE_SHARES
      ? totalSupply / 2n
      : DEFAULT_SAMPLE_SHARES;
    if (sampleShares <= 0n) return { ok: false, reason: "behavior_mismatch" };
    const assets = await callUintBackend(
      backend,
      pool,
      SILO,
      "previewRedeem",
      [sampleShares],
    );
    if (assets <= 0n) return { ok: false, reason: "behavior_mismatch" };
    return {
      ok: true,
      adapter: "erc4626-silo-redeem",
      venueId: "erc4626-silo-redeem",
      identitySource: "erc4626-silo-redeem-behavior",
    };
  } catch (error) {
    return {
      ok: false,
      reason: isPermanentCallFailure(error)
        ? "behavior_mismatch"
        : "identity_call_failed",
    };
  }
};

export const erc4626SiloRedeemDiscovery: ProtocolDiscoveryCapability = Object.freeze({
  candidateSources: Object.freeze([
    "dex-token-domain",
    "observed-interaction",
  ] as const),
  candidateAddressHints: ERC4626_SILO_REDEEM_CANDIDATE_ADDRESS_HINTS,
  eventTopics: Object.freeze([WITHDRAW_TOPIC]),
  callSelectors: Object.freeze([REDEEM_SELECTOR, WITHDRAW_SELECTOR]),
  addressMatcherVersion: "erc4626-silo-redeem-address-v2-payout-index",
  observedMatcherVersion: "erc4626-silo-redeem-observed-v1",

  async candidateFromAddress(candidate, ctx) {
    const target = ethers.getAddress(candidate.target);
    try {
      const surface = await readTargetSurface(
        ctx,
        target,
        candidate.codeHash,
        candidate.implementationWord,
      );
      const payoutTokens = await derivePayoutCandidates(
        ctx,
        target,
        surface.underlyingAsset,
        surface.sampleAssets,
      );
      // An address hint without a behavior-derived payout token is not a
      // positive candidate. This family does not opt into cross-block matcher
      // reuse, so current-N address behavior is checked again next pass;
      // observed traffic can nominate a token immediately.
      if (payoutTokens.length === 0) return null;
      return candidateFor(target, {
        kind: "erc4626-silo-payout-candidate",
        underlyingAsset: surface.underlyingAsset,
        payoutTokens,
        sampleShares: surface.sampleShares,
        sampleAssets: surface.sampleAssets,
        codeHash: surface.codeHash,
        implementationWord: surface.implementationWord,
        source: "address-behavior",
      }, "dex-universe-address");
    } catch (error) {
      if (isRetryableSourceFailure(error)) throw error;
      return null;
    }
  },

  async candidateFromObservedCall(call, ctx) {
    if (call.receipt.status !== 1) return null;
    const target = ethers.getAddress(call.target);
    let decoded: ethers.Result;
    let payoutToken: string;
    let receiver: string;
    try {
      const fn = call.selector === REDEEM_SELECTOR ? "redeem" : "withdraw";
      decoded = SILO.decodeFunctionData(fn, call.input);
      payoutToken = ethers.getAddress(String(decoded[0]));
      receiver = ethers.getAddress(String(decoded[2]));
    } catch {
      return null;
    }
    if (
      payoutToken === ethers.ZeroAddress ||
      payoutToken.toLowerCase() === target.toLowerCase() ||
      !receiptShowsObservedSiloExit(call.receipt.logs, target, payoutToken, receiver)
    ) return null;
    try {
      const code = await ctx.backend.getCode(target);
      if (code === "0x") return null;
      const implementationWord = (
        await ctx.backend.getStorageAt(target, IMPLEMENTATION_SLOT)
      ).toLowerCase();
      const surface = await readTargetSurface(
        ctx,
        target,
        ethers.keccak256(code),
        implementationWord,
      );
      const payoutAsset = await callAddress(ctx, payoutToken, PAYOUT, "asset");
      if (payoutAsset.toLowerCase() !== surface.underlyingAsset.toLowerCase()) {
        return null;
      }
      const expectedOut = await callUint(
        ctx,
        payoutToken,
        PAYOUT,
        "previewWithdraw",
        [surface.sampleAssets],
      );
      if (expectedOut <= 0n) return null;
      return candidateFor(target, {
        kind: "erc4626-silo-payout-candidate",
        underlyingAsset: surface.underlyingAsset,
        payoutTokens: [payoutToken],
        sampleShares: surface.sampleShares,
        sampleAssets: surface.sampleAssets,
        codeHash: surface.codeHash,
        implementationWord: surface.implementationWord,
        source: "observed-call",
      }, "observed-calltrace", call.selector);
    } catch (error) {
      if (isRetryableSourceFailure(error)) throw error;
      return null;
    }
  },

  async probeCandidate(instance, ctx) {
    return probeErc4626SiloRedeemCandidate(instance, ctx);
  },
} satisfies ProtocolDiscoveryCapability);

export async function probeErc4626SiloRedeemCandidate(
  instance: AttestedProtocolInstance,
  ctx: ProtocolDiscoveryContext,
): Promise<readonly TokenEdge[]> {
  if (instance.pool.adapter !== "erc4626-silo-redeem") {
    throw new Error("erc4626 silo probe received a foreign pool adapter");
  }
  if (!ctx.backend.simulateCalls) {
    throw new Error("erc4626 silo redeem requires nonzero state-override simulation");
  }
  const target = ethers.getAddress(instance.pool.address);
  const currentCode = await ctx.backend.getCode(target);
  if (currentCode === "0x") throw new Error("erc4626 silo target has no code");
  const currentCodeHash = ethers.keccak256(currentCode).toLowerCase();
  const currentImplementationWord = (
    await ctx.backend.getStorageAt(target, IMPLEMENTATION_SLOT)
  ).toLowerCase();
  const surface = await readTargetSurface(
    ctx,
    target,
    currentCodeHash,
    currentImplementationWord,
  );
  const graphTokens = new Set(ctx.graphTokens.map((token) => token.toLowerCase()));
  if (!graphTokens.has(target.toLowerCase())) {
    throw new Error("erc4626 silo share token is not loop-closable from the current graph");
  }

  const currentEvidence = instance.evidence.filter(
    (value): value is SiloCandidateEvidence =>
      isSiloCandidateEvidence(value) &&
      value.underlyingAsset.toLowerCase() === surface.underlyingAsset.toLowerCase() &&
      value.codeHash.toLowerCase() === currentCodeHash &&
      value.implementationWord.toLowerCase() === currentImplementationWord,
  );
  let candidates = uniqueAddresses(
    currentEvidence.flatMap((evidence) => evidence.payoutTokens),
  ).filter((token) => graphTokens.has(token.toLowerCase()));
  if (candidates.length === 0) {
    candidates = await derivePayoutCandidates(
      ctx,
      target,
      surface.underlyingAsset,
      surface.sampleAssets,
    );
  }
  if (candidates.length === 0) {
    throw new Error("erc4626 silo probe derived no graph-connected payout token");
  }

  const sampleShares = currentEvidence.reduce(
    (value, evidence) =>
      evidence.sampleShares > 0n && evidence.sampleShares < value
        ? evidence.sampleShares
        : value,
    surface.sampleShares,
  );
  const shareBalanceSlot = await discoverErc20BalanceStorageSlot({
    context: ctx,
    token: target,
    holder: ERC4626_SILO_PROBE_HOLDER,
    codeHash: currentCodeHash,
    probeValue: sampleShares,
  });
  if (!shareBalanceSlot) {
    throw new Error("erc4626 silo probe could not derive the share balance slot");
  }

  const proven: Array<{ readonly token: string; readonly amountOut: bigint }> = [];
  for (const payoutToken of candidates) {
    const result = await proveExactInPayout({
      ctx,
      target,
      underlyingAsset: surface.underlyingAsset,
      payoutToken,
      sampleShares,
      shareBalanceSlot,
      totalSupply: surface.totalSupply,
    });
    if (result !== null) proven.push({ token: payoutToken, amountOut: result });
  }
  if (proven.length !== 1) {
    throw new Error(
      `erc4626 silo payout proof must be unique; proven=${proven.length}`,
    );
  }
  const tokenOut = proven[0].token;
  return [{
    adapterId: "erc4626-redeem-silo",
    target,
    tokenIn: target,
    tokenOut,
    slotKind: "protocol",
    protocolAction: "redeem",
    score: instance.pool.score,
    ...deriveEdgeTaxonomy("protocol", "redeem"),
  }];
}

async function proveExactInPayout(input: {
  readonly ctx: ProtocolDiscoveryContext;
  readonly target: string;
  readonly underlyingAsset: string;
  readonly payoutToken: string;
  readonly sampleShares: bigint;
  readonly shareBalanceSlot: string;
  readonly totalSupply: bigint;
}): Promise<bigint | null> {
  try {
    const payoutAsset = await callAddress(
      input.ctx,
      input.payoutToken,
      PAYOUT,
      "asset",
    );
    if (payoutAsset.toLowerCase() !== input.underlyingAsset.toLowerCase()) return null;
    const simulate = input.ctx.backend.simulateCalls!;
    const [preview] = await simulate({
      calls: [{
        from: ERC4626_SILO_PROBE_HOLDER,
        to: input.target,
        data: SILO.encodeFunctionData("previewRedeem", [input.sampleShares]),
      }],
    });
    if (!preview || preview.status !== 1) return null;
    const simulatedAssets = decodeUint(
      SILO,
      "previewRedeem",
      preview.returnData,
    );
    if (simulatedAssets <= 0n) return null;
    const redeemData = SILO.encodeFunctionData("redeem", [
      input.payoutToken,
      input.sampleShares,
      ERC4626_SILO_PROBE_RECEIVER,
      ERC4626_SILO_PROBE_HOLDER,
    ]);

    const results = await simulate({
      calls: [
        {
          from: ERC4626_SILO_PROBE_HOLDER,
          to: input.target,
          data: SILO.encodeFunctionData("balanceOf", [ERC4626_SILO_PROBE_HOLDER]),
        },
        {
          from: ERC4626_SILO_PROBE_HOLDER,
          to: input.target,
          data: SILO.encodeFunctionData("totalSupply"),
        },
        {
          from: ERC4626_SILO_PROBE_HOLDER,
          to: input.payoutToken,
          data: PAYOUT.encodeFunctionData("balanceOf", [ERC4626_SILO_PROBE_RECEIVER]),
        },
        {
          from: ERC4626_SILO_PROBE_HOLDER,
          to: input.target,
          data: SILO.encodeFunctionData("previewRedeem", [input.sampleShares]),
        },
        {
          from: ERC4626_SILO_PROBE_HOLDER,
          to: input.payoutToken,
          data: PAYOUT.encodeFunctionData("previewWithdraw", [simulatedAssets]),
        },
        {
          from: ERC4626_SILO_PROBE_HOLDER,
          to: input.target,
          data: SILO.encodeFunctionData("balanceOf", [ERC4626_SILO_PROBE_HOLDER]),
        },
        {
          from: ERC4626_SILO_PROBE_HOLDER,
          to: input.target,
          data: SILO.encodeFunctionData("totalSupply"),
        },
        {
          from: ERC4626_SILO_PROBE_HOLDER,
          to: input.payoutToken,
          data: PAYOUT.encodeFunctionData("balanceOf", [ERC4626_SILO_PROBE_RECEIVER]),
        },
        {
          from: ERC4626_SILO_PROBE_HOLDER,
          to: input.target,
          data: redeemData,
        },
        {
          from: ERC4626_SILO_PROBE_HOLDER,
          to: input.target,
          data: SILO.encodeFunctionData("balanceOf", [ERC4626_SILO_PROBE_HOLDER]),
        },
        {
          from: ERC4626_SILO_PROBE_HOLDER,
          to: input.target,
          data: SILO.encodeFunctionData("totalSupply"),
        },
        {
          from: ERC4626_SILO_PROBE_HOLDER,
          to: input.payoutToken,
          data: PAYOUT.encodeFunctionData("balanceOf", [ERC4626_SILO_PROBE_RECEIVER]),
        },
      ],
      stateOverrides: {
        [input.target]: {
          stateDiff: {
            [input.shareBalanceSlot]: ethers.toBeHex(input.sampleShares, 32),
          },
        },
      },
    });
    if (results.length !== 12 || results.some((result) => result.status !== 1)) return null;
    const shareBefore = decodeUint(SILO, "balanceOf", results[0].returnData);
    const supplyBefore = decodeUint(SILO, "totalSupply", results[1].returnData);
    const payoutBefore = decodeUint(PAYOUT, "balanceOf", results[2].returnData);
    const assets = decodeUint(SILO, "previewRedeem", results[3].returnData);
    const expectedOut = decodeUint(PAYOUT, "previewWithdraw", results[4].returnData);
    const shareMid = decodeUint(SILO, "balanceOf", results[5].returnData);
    const supplyMid = decodeUint(SILO, "totalSupply", results[6].returnData);
    const payoutMid = decodeUint(PAYOUT, "balanceOf", results[7].returnData);
    const returnedOut = decodeUint(SILO, "redeem", results[8].returnData);
    const shareAfter = decodeUint(SILO, "balanceOf", results[9].returnData);
    const supplyAfter = decodeUint(SILO, "totalSupply", results[10].returnData);
    const payoutAfter = decodeUint(PAYOUT, "balanceOf", results[11].returnData);
    if (
      assets !== simulatedAssets ||
      expectedOut <= 0n ||
      results[3].logs.length !== 0 ||
      results[4].logs.length !== 0 ||
      shareBefore !== input.sampleShares ||
      shareMid !== shareBefore ||
      supplyMid !== supplyBefore ||
      payoutMid !== payoutBefore ||
      shareAfter !== 0n ||
      supplyBefore < input.sampleShares ||
      supplyAfter + input.sampleShares !== supplyBefore ||
      returnedOut !== expectedOut ||
      payoutAfter - payoutBefore !== expectedOut
    ) return null;
    if (!exactBurnTransfer(
      results[8].logs,
      input.target,
      ERC4626_SILO_PROBE_HOLDER,
      input.sampleShares,
    )) return null;
    if (!exactReceiverTransfer(
      results[8].logs,
      input.payoutToken,
      ERC4626_SILO_PROBE_RECEIVER,
      expectedOut,
    )) return null;
    if (hasForeignReceiverPayout(
      results[8].logs,
      input.payoutToken,
      ERC4626_SILO_PROBE_RECEIVER,
    )) return null;
    if (!exactWithdrawEvent(
      results[8].logs,
      input.target,
      ERC4626_SILO_PROBE_HOLDER,
      ERC4626_SILO_PROBE_RECEIVER,
      assets,
      input.sampleShares,
    )) return null;

    const directResults = await simulate({
      calls: [
        {
          from: ERC4626_SILO_PROBE_HOLDER,
          to: input.target,
          data: redeemData,
        },
        {
          from: ERC4626_SILO_PROBE_HOLDER,
          to: input.target,
          data: SILO.encodeFunctionData("balanceOf", [
            ERC4626_SILO_PROBE_HOLDER,
          ]),
        },
        {
          from: ERC4626_SILO_PROBE_HOLDER,
          to: input.target,
          data: SILO.encodeFunctionData("totalSupply"),
        },
        {
          from: ERC4626_SILO_PROBE_HOLDER,
          to: input.payoutToken,
          data: PAYOUT.encodeFunctionData("balanceOf", [
            ERC4626_SILO_PROBE_RECEIVER,
          ]),
        },
      ],
      stateOverrides: {
        [input.target]: {
          stateDiff: {
            [input.shareBalanceSlot]: ethers.toBeHex(input.sampleShares, 32),
          },
        },
      },
    });
    const direct = directResults[0];
    if (
      directResults.length !== 4 ||
      directResults.some((result) => result.status !== 1) ||
      !direct ||
      direct.returnData.toLowerCase() !== results[8].returnData.toLowerCase() ||
      normalizedSimulationLogs(direct.logs) !==
        normalizedSimulationLogs(results[8].logs) ||
      decodeUint(SILO, "balanceOf", directResults[1].returnData) !==
        shareAfter ||
      decodeUint(SILO, "totalSupply", directResults[2].returnData) !==
        supplyAfter ||
      decodeUint(PAYOUT, "balanceOf", directResults[3].returnData) !==
        payoutAfter
    ) return null;
    return expectedOut;
  } catch (error) {
    if (isRetryableSourceFailure(error)) throw error;
    return null;
  }
}

function normalizedSimulationLogs(logs: readonly ProtocolDiscoveryLog[]): string {
  return JSON.stringify(logs.map((log) => ({
    address: log.address.toLowerCase(),
    topics: log.topics.map((topic) => topic.toLowerCase()),
    data: log.data.toLowerCase(),
  })));
}

async function readTargetSurface(
  ctx: ProtocolDiscoveryContext,
  target: string,
  codeHash: string,
  implementationWord: string,
): Promise<TargetSurface> {
  const underlyingAsset = await callAddress(ctx, target, SILO, "asset");
  if (
    underlyingAsset === ethers.ZeroAddress ||
    underlyingAsset.toLowerCase() === target.toLowerCase() ||
    await ctx.backend.getCode(underlyingAsset) === "0x"
  ) throw new Error("erc4626 silo target reported an invalid underlying asset");
  const totalSupply = await callUint(ctx, target, SILO, "totalSupply", []);
  if (totalSupply <= 1n) throw new Error("erc4626 silo target has no provable supply");
  const sampleShares = totalSupply / 2n < DEFAULT_SAMPLE_SHARES
    ? totalSupply / 2n
    : DEFAULT_SAMPLE_SHARES;
  const sampleAssets = await callUint(
    ctx,
    target,
    SILO,
    "previewRedeem",
    [sampleShares],
  );
  if (sampleAssets <= 0n) {
    throw new Error("erc4626 silo target returned a zero preview");
  }
  return {
    underlyingAsset,
    totalSupply,
    sampleShares,
    sampleAssets,
    codeHash: codeHash.toLowerCase(),
    implementationWord: implementationWord.toLowerCase(),
  };
}

async function derivePayoutCandidates(
  ctx: ProtocolDiscoveryContext,
  target: string,
  underlyingAsset: string,
  assets: bigint,
): Promise<string[]> {
  const domain = [
    ...((await payoutAssetIndex(ctx)).get(underlyingAsset.toLowerCase()) ?? []),
  ].filter((token) =>
    token.toLowerCase() !== target.toLowerCase() &&
    token.toLowerCase() !== underlyingAsset.toLowerCase()
  );
  const matches = await mapLimit(domain, PAYOUT_SCAN_CONCURRENCY, async (token) => {
    try {
      const out = await callUint(ctx, token, PAYOUT, "previewWithdraw", [assets]);
      return out > 0n ? token : null;
    } catch (error) {
      if (isRetryableSourceFailure(error)) throw error;
      return null;
    }
  });
  return matches.flatMap((token) => token === null ? [] : [token]);
}

/**
 * Silo payout wrappers expose asset(), but the Silo target does not enumerate
 * them. Build that inverse relation once per pinned discovery context and
 * reuse it across every candidate target. This preserves permissionless
 * DEX-token-domain discovery without the old candidates × graphTokens RPC
 * cross-product.
 */
function payoutAssetIndex(
  ctx: ProtocolDiscoveryContext,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const scope = ctx.runCacheScope ?? ctx;
  const cached = payoutAssetIndexByContext.get(scope);
  if (cached) return cached;
  const pending = buildPayoutAssetIndex(ctx);
  payoutAssetIndexByContext.set(scope, pending);
  return pending;
}

async function buildPayoutAssetIndex(
  ctx: ProtocolDiscoveryContext,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const relations = await mapLimit(
    uniqueAddresses(ctx.graphTokens),
    PAYOUT_SCAN_CONCURRENCY,
    async (token) => {
      try {
        if (await ctx.backend.getCode(token) === "0x") return null;
        const asset = await callAddress(ctx, token, PAYOUT, "asset");
        if (
          asset === ethers.ZeroAddress ||
          asset.toLowerCase() === token.toLowerCase()
        ) return null;
        return { token, asset: asset.toLowerCase() };
      } catch (error) {
        if (isRetryableSourceFailure(error)) throw error;
        return null;
      }
    },
  );
  const byAsset = new Map<string, string[]>();
  for (const relation of relations) {
    if (!relation) continue;
    const tokens = byAsset.get(relation.asset) ?? [];
    tokens.push(relation.token);
    byAsset.set(relation.asset, tokens);
  }
  return new Map(
    [...byAsset.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([asset, tokens]) => [
        asset,
        Object.freeze([...tokens].sort((left, right) =>
          left.toLowerCase().localeCompare(right.toLowerCase())
        )),
      ]),
  );
}

function candidateFor(
  target: string,
  evidence: SiloCandidateEvidence,
  source: string,
  selector?: string,
): ProtocolCandidate {
  return {
    pool: { address: target, adapter: "erc4626-silo-redeem" },
    source,
    ...(selector === undefined ? {} : { selector }),
    evidence: [evidence],
  };
}

function receiptShowsObservedSiloExit(
  logs: readonly ProtocolDiscoveryLog[],
  target: string,
  payoutToken: string,
  receiver: string,
): boolean {
  const hasWithdraw = logs.some((log) =>
    log.address.toLowerCase() === target.toLowerCase() &&
    log.topics[0]?.toLowerCase() === WITHDRAW_TOPIC
  );
  const hasPayout = logs.some((log) => {
    const transfer = decodeTransfer(log);
    return transfer !== null &&
      log.address.toLowerCase() === payoutToken.toLowerCase() &&
      transfer.to.toLowerCase() === receiver.toLowerCase() &&
      transfer.amount > 0n;
  });
  const hasBurn = logs.some((log) => {
    const transfer = decodeTransfer(log);
    return transfer !== null &&
      log.address.toLowerCase() === target.toLowerCase() &&
      transfer.to === ethers.ZeroAddress &&
      transfer.amount > 0n;
  });
  return hasWithdraw && hasPayout && hasBurn;
}

function exactBurnTransfer(
  logs: readonly ProtocolDiscoveryLog[],
  token: string,
  holder: string,
  amount: bigint,
): boolean {
  return logs.some((log) => {
    const transfer = decodeTransfer(log);
    return transfer !== null &&
      log.address.toLowerCase() === token.toLowerCase() &&
      transfer.from.toLowerCase() === holder.toLowerCase() &&
      transfer.to === ethers.ZeroAddress &&
      transfer.amount === amount;
  });
}

function exactReceiverTransfer(
  logs: readonly ProtocolDiscoveryLog[],
  token: string,
  receiver: string,
  amount: bigint,
): boolean {
  return logs.some((log) => {
    const transfer = decodeTransfer(log);
    return transfer !== null &&
      log.address.toLowerCase() === token.toLowerCase() &&
      transfer.to.toLowerCase() === receiver.toLowerCase() &&
      transfer.amount === amount;
  });
}

function hasForeignReceiverPayout(
  logs: readonly ProtocolDiscoveryLog[],
  payoutToken: string,
  receiver: string,
): boolean {
  return logs.some((log) => {
    const transfer = decodeTransfer(log);
    return transfer !== null &&
      log.address.toLowerCase() !== payoutToken.toLowerCase() &&
      transfer.to.toLowerCase() === receiver.toLowerCase() &&
      transfer.amount > 0n;
  });
}

function exactWithdrawEvent(
  logs: readonly ProtocolDiscoveryLog[],
  target: string,
  holder: string,
  receiver: string,
  assets: bigint,
  shares: bigint,
): boolean {
  return logs.some((log) => {
    if (
      log.address.toLowerCase() !== target.toLowerCase() ||
      log.topics[0]?.toLowerCase() !== WITHDRAW_TOPIC
    ) return false;
    try {
      const parsed = SILO.parseLog({ topics: [...log.topics], data: log.data });
      return parsed !== null &&
        ethers.getAddress(String(parsed.args.sender)).toLowerCase() ===
          holder.toLowerCase() &&
        ethers.getAddress(String(parsed.args.receiver)).toLowerCase() ===
          receiver.toLowerCase() &&
        ethers.getAddress(String(parsed.args.owner)).toLowerCase() ===
          holder.toLowerCase() &&
        BigInt(parsed.args.assets) === assets &&
        BigInt(parsed.args.shares) === shares;
    } catch {
      return false;
    }
  });
}

function decodeTransfer(log: ProtocolDiscoveryLog): {
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
} | null {
  if (
    log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC ||
    log.topics.length < 3
  ) return null;
  try {
    return {
      from: ethers.getAddress(`0x${log.topics[1].slice(-40)}`),
      to: ethers.getAddress(`0x${log.topics[2].slice(-40)}`),
      amount: BigInt(log.data),
    };
  } catch {
    return null;
  }
}

function isSiloCandidateEvidence(value: unknown): value is SiloCandidateEvidence {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SiloCandidateEvidence>;
  return item.kind === "erc4626-silo-payout-candidate" &&
    typeof item.underlyingAsset === "string" &&
    Array.isArray(item.payoutTokens) &&
    item.payoutTokens.every((token) => typeof token === "string") &&
    typeof item.sampleShares === "bigint" &&
    typeof item.sampleAssets === "bigint" &&
    typeof item.codeHash === "string" &&
    typeof item.implementationWord === "string";
}

async function callAddress(
  ctx: ProtocolDiscoveryContext,
  target: string,
  iface: ethers.Interface,
  fn: string,
): Promise<string> {
  return callAddressBackend(ctx.backend, target, iface, fn);
}

async function callAddressBackend(
  backend: { call(req: { to: string; data: string }): Promise<string> },
  target: string,
  iface: ethers.Interface,
  fn: string,
): Promise<string> {
  const raw = await backend.call({ to: target, data: iface.encodeFunctionData(fn) });
  return ethers.getAddress(String(iface.decodeFunctionResult(fn, raw)[0]));
}

async function callUint(
  ctx: ProtocolDiscoveryContext,
  target: string,
  iface: ethers.Interface,
  fn: string,
  args: readonly unknown[],
): Promise<bigint> {
  return callUintBackend(ctx.backend, target, iface, fn, args);
}

async function callUintBackend(
  backend: { call(req: { to: string; data: string }): Promise<string> },
  target: string,
  iface: ethers.Interface,
  fn: string,
  args: readonly unknown[],
): Promise<bigint> {
  const raw = await backend.call({
    to: target,
    data: iface.encodeFunctionData(fn, args),
  });
  return decodeUint(iface, fn, raw);
}

function decodeUint(
  iface: ethers.Interface,
  fn: string,
  raw: string,
): bigint {
  return BigInt(iface.decodeFunctionResult(fn, raw)[0]);
}

function uniqueAddresses(values: readonly string[]): string[] {
  const addresses = new Map<string, string>();
  for (const raw of values) {
    try {
      const address = ethers.getAddress(raw);
      if (address !== ethers.ZeroAddress) {
        addresses.set(address.toLowerCase(), address);
      }
    } catch {
      // Invalid graph metadata cannot nominate a behavior candidate.
    }
  }
  return [...addresses.values()].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );
}

async function mapLimit<T, U>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T) => Promise<U>,
): Promise<U[]> {
  const output = new Array<U>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, values.length)) },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= values.length) return;
        output[index] = await fn(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

function isPermanentCallFailure(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code).toUpperCase()
    : "";
  if (new Set(["CALL_EXCEPTION", "BAD_DATA", "INVALID_ARGUMENT", "NUMERIC_FAULT"]).has(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /execution reverted|could not decode|invalid (?:result|data|address)|unsupported/i
    .test(message);
}

function isRetryableSourceFailure(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code).toUpperCase()
    : "";
  if (
    new Set([
      "TIMEOUT",
      "NETWORK_ERROR",
      "SERVER_ERROR",
      "ETIMEDOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "EAI_AGAIN",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "ENOTFOUND",
    ]).has(code) ||
    code.startsWith("ECONN") ||
    code.startsWith("UND_ERR_")
  ) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|rate.?limit|too many requests|fetch failed|socket|network|connection (?:closed|reset|refused)|temporar(?:y|ily) unavailable|\b(?:429|502|503|504)\b/i
    .test(message);
}
