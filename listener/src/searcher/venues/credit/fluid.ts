import { ethers } from "ethers";
import { ADDR } from "../../../shared/constants/addresses.js";
import { discoverErc20BalanceStorageSlot } from "../../protocol-discovery-erc20-state.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type {
  CreditAdapterFamily,
  AttestedProtocolInstance,
  ExactQuoteContext,
  PlanBuildContext,
  PlanFragment,
  ProtocolDiscoveryCapability,
  ProtocolDiscoveryContext,
} from "../route-leg-adapter.js";
import type { OnchainIdentityResolver } from "../identity.js";

const MAX_UINT = (1n << 256n) - 1n;
const IMPLEMENTATION_SLOT = BigInt(
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
);
const FLUID_VAULT_PROBE_HOLDER = ethers.getAddress(`0x${"00".repeat(18)}f1d2`);
const fluidVaultIface = new ethers.Interface([
  "function constantsView() view returns ((address liquidity,address factory,address adminImplementation,address secondaryImplementation,address supplyToken,address borrowToken,uint8 supplyDecimals,uint8 borrowDecimals,uint256 vaultId,bytes32 liquiditySupplyExchangePriceSlot,bytes32 liquidityBorrowExchangePriceSlot,bytes32 liquidityUserSupplySlot,bytes32 liquidityUserBorrowSlot) constantsView_)",
  "function operate(uint256 nftId,int256 newCol,int256 newDebt,address to) payable returns (uint256,int256,int256)",
]);
const fluidVaultFactoryIface = new ethers.Interface([
  "function getVaultAddress(uint256 vaultId) view returns (address)",
]);
const erc20ProbeIface = new ethers.Interface([
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);

interface FluidVaultConstants {
  readonly factory: string;
  readonly supplyToken: string;
  readonly borrowToken: string;
  readonly supplyDecimals: number;
  readonly borrowDecimals: number;
  readonly vaultId: bigint;
}

export const fluidVaultDiscovery: ProtocolDiscoveryCapability = Object.freeze({
  candidateSources: Object.freeze(["dex-token-domain"] as const),
  candidateAddressHints: Object.freeze([ADDR.FLUID_VAULT_WSTUSR_USDC]),
  eventTopics: Object.freeze([]),
  callSelectors: Object.freeze([]),
  addressMatcherVersion: "fluid-vault-constants-factory-v1",
  async candidateFromAddress(candidate, context) {
    try {
      const constants = await readFluidVaultConstants(context.backend, candidate.target);
      if (!fluidVaultConstantsAreSane(constants)) return null;
      return {
        pool: {
          address: ethers.getAddress(candidate.target),
          adapter: "fluid-vault",
          fixedTokenIn: constants.supplyToken,
          fixedTokenOut: constants.borrowToken,
          fixedSlotKind: "lend",
        },
        source: "fluid-vault-address-hint",
        evidence: [{
          kind: "fluid-vault-constants",
          vaultId: constants.vaultId,
          factory: constants.factory,
          supplyToken: constants.supplyToken,
          borrowToken: constants.borrowToken,
        }],
      };
    } catch (error) {
      if (isPermanentFluidSurfaceFailure(error)) return null;
      throw error;
    }
  },
  async probeCandidate(instance, context) {
    return probeFluidVaultCandidate(instance, context);
  },
} satisfies ProtocolDiscoveryCapability);

export const fluidVaultIdentityResolver: OnchainIdentityResolver = async ({
  backend,
  pool,
  poolAdapter,
  candidate,
}) => {
  if (poolAdapter !== "fluid-vault") {
    throw new Error(`fluid-vault identity: unsupported pool adapter ${poolAdapter}`);
  }
  try {
    const constants = await readFluidVaultConstants(backend, pool);
    if (
      !fluidVaultConstantsAreSane(constants) ||
      candidate.fixedTokenIn?.toLowerCase() !== constants.supplyToken.toLowerCase() ||
      candidate.fixedTokenOut?.toLowerCase() !== constants.borrowToken.toLowerCase()
    ) {
      return { ok: false, reason: "behavior_mismatch" };
    }
    const registered = await backend.call({
      to: constants.factory,
      data: fluidVaultFactoryIface.encodeFunctionData("getVaultAddress", [constants.vaultId]),
    });
    const registeredAddress = ethers.getAddress(String(
      fluidVaultFactoryIface.decodeFunctionResult("getVaultAddress", registered)[0],
    ));
    if (registeredAddress.toLowerCase() !== ethers.getAddress(pool).toLowerCase()) {
      return { ok: false, reason: "behavior_mismatch" };
    }
    if (!backend.getCode) return { ok: false, reason: "identity_call_failed" };
    const [supplyCode, borrowCode] = await Promise.all([
      backend.getCode(constants.supplyToken),
      backend.getCode(constants.borrowToken),
    ]);
    if (supplyCode === "0x" || borrowCode === "0x") {
      return { ok: false, reason: "behavior_mismatch" };
    }
    return {
      ok: true,
      adapter: "fluid-vault",
      venueId: "fluid",
      factory: constants.factory,
      identitySource: "fluid-vault-factory-behavior",
    };
  } catch (error) {
    return {
      ok: false,
      reason: isPermanentFluidSurfaceFailure(error)
        ? "behavior_mismatch"
        : "identity_call_failed",
    };
  }
};

/**
 * Legacy credit leg retained for diagnostic/planner equivalence only. Its
 * standing-position taxonomy keeps production submission fail-closed unless
 * the existing explicit credit-live marker authorizes it.
 */
export const fluidCreditAdapter = Object.freeze({
  id: "credit:fluid",
  kind: "credit",
  poolAdapters: ["fluid-vault"],
  identityPolicies: [{ poolAdapter: "fluid-vault", policy: "trusted-singleton-seed" }],
  edgeAdapterIds: ["fluid-vault"],
  allowedTaxonomy: [{ slotKind: "lend" }],
  requiresProtocolEdgesFlag: false,
  ownedActionAdapterIds: ["fluid-vault", "fluid-dex-liquidate"],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  creditActionAdapterIds: ["fluid-vault", "fluid-dex-liquidate"],
  creditPolicy: {
    debtBpsCandidates: [8500n, 9500n, 10000n, 10400n, 10800n, 11200n],
    quoteOutputByDebtBps: (collateralAmount, debtBps) =>
      (collateralAmount * debtBps) / 10000n / 10n ** 12n,
    blocksPrefixInversion: true,
  },
  discovery: fluidVaultDiscovery,
  discoveryIdentityResolver: fluidVaultIdentityResolver,
  discoveryIdentityAuthority: { class: "canonical-onchain", strength: 300 },
  prepared: {
    quote: null,
    quoteUnsupportedReason: "unsupported exact quote: fluid-vault requires solver debt search",
    encodeQuotePrewarm: async () => [],
    allowanceSpender: () => null,
    prewarmAddresses: (request) => [request.target, request.tokenIn, request.tokenOut],
  },
  async buildEdges(pool: PoolEntry, backend: TokenQueryBackend): Promise<TokenEdge[]> {
    if (!pool.fixedTokenIn || !pool.fixedTokenOut) {
      throw new Error(`fluid-vault pool ${pool.address} missing fixedTokenIn/Out`);
    }
    if (!pool.verifiedRoutes || pool.verifiedRoutes.length !== 1) {
      throw new Error(`fluid-vault pool ${pool.address} lacks exact discovery route`);
    }
    const constants = await readFluidVaultConstants(backend, pool.address);
    if (
      constants.supplyToken.toLowerCase() !== pool.fixedTokenIn.toLowerCase() ||
      constants.borrowToken.toLowerCase() !== pool.fixedTokenOut.toLowerCase()
    ) {
      throw new Error(`fluid-vault pool ${pool.address} token pair changed`);
    }
    const edge = fluidVaultEdge(
      pool.address,
      constants.supplyToken,
      constants.borrowToken,
      pool.score,
    );
    assertExactFluidVaultRoute(pool, edge);
    return [edge];
  },
  async quoteExact(_ctx: ExactQuoteContext): Promise<bigint> {
    throw new Error("unsupported exact quote: fluid-vault requires solver debt search");
  },
  async buildPlanFragment(ctx: PlanBuildContext): Promise<PlanFragment> {
    const { edge, amountIn, amountOut } = ctx;
    return {
      requirements: [{ kind: "approve", token: edge.tokenIn, spender: edge.target, amount: MAX_UINT }],
      nodes: [{
        adapterId: "fluid-vault",
        target: edge.target,
        tokenIn: edge.tokenIn,
        tokenOut: edge.tokenOut,
        amount: amountIn,
        params: { nftId: 0n, collateralDelta: amountIn, debtDelta: amountOut },
        children: [],
      }],
    };
  },
} satisfies CreditAdapterFamily);

function fluidVaultEdge(
  target: string,
  supplyToken: string,
  borrowToken: string,
  score?: number,
): TokenEdge {
  return {
      adapterId: "fluid-vault",
      target: ethers.getAddress(target),
      tokenIn: ethers.getAddress(supplyToken),
      tokenOut: ethers.getAddress(borrowToken),
      slotKind: "lend",
      score,
      ...deriveEdgeTaxonomy("lend"),
  };
}

export async function probeFluidVaultCandidate(
  instance: AttestedProtocolInstance,
  context: ProtocolDiscoveryContext,
): Promise<readonly TokenEdge[]> {
  const target = ethers.getAddress(instance.pool.address);
  const constants = await readFluidVaultConstants(context.backend, target);
  if (
    instance.pool.fixedTokenIn?.toLowerCase() !== constants.supplyToken.toLowerCase() ||
    instance.pool.fixedTokenOut?.toLowerCase() !== constants.borrowToken.toLowerCase()
  ) {
    throw new Error("fluid-vault token pair changed after identity attestation");
  }
  const graphTokens = new Set(context.graphTokens.map((token) => token.toLowerCase()));
  if (
    !graphTokens.has(constants.supplyToken.toLowerCase()) ||
    !graphTokens.has(constants.borrowToken.toLowerCase())
  ) {
    throw new Error("fluid-vault route is not loop-closable from the current DEX token domain");
  }
  if (!context.backend.simulateCalls) {
    throw new Error("fluid-vault active proof requires block-pinned simulation");
  }
  if (!await proveFluidVaultOperate(context, target, constants)) {
    throw new Error("fluid-vault nonzero operate proof failed");
  }
  return [
    fluidVaultEdge(
      target,
      constants.supplyToken,
      constants.borrowToken,
      instance.pool.score,
    ),
  ];
}

async function readFluidVaultConstants(
  backend: { call(req: { to: string; data: string; from?: string }): Promise<string> },
  target: string,
): Promise<FluidVaultConstants> {
  const raw = await backend.call({
    to: ethers.getAddress(target),
    data: fluidVaultIface.encodeFunctionData("constantsView"),
  });
  const decoded = fluidVaultIface.decodeFunctionResult("constantsView", raw)[0] as {
    readonly factory: string;
    readonly supplyToken: string;
    readonly borrowToken: string;
    readonly supplyDecimals: bigint;
    readonly borrowDecimals: bigint;
    readonly vaultId: bigint;
  };
  return {
    factory: ethers.getAddress(decoded.factory),
    supplyToken: ethers.getAddress(decoded.supplyToken),
    borrowToken: ethers.getAddress(decoded.borrowToken),
    supplyDecimals: Number(decoded.supplyDecimals),
    borrowDecimals: Number(decoded.borrowDecimals),
    vaultId: BigInt(decoded.vaultId),
  };
}

function fluidVaultConstantsAreSane(constants: FluidVaultConstants): boolean {
  return constants.factory !== ethers.ZeroAddress &&
    constants.supplyToken !== ethers.ZeroAddress &&
    constants.borrowToken !== ethers.ZeroAddress &&
    constants.supplyToken.toLowerCase() !== constants.borrowToken.toLowerCase() &&
    Number.isSafeInteger(constants.supplyDecimals) &&
    constants.supplyDecimals >= 0 &&
    constants.supplyDecimals <= 36 &&
    Number.isSafeInteger(constants.borrowDecimals) &&
    constants.borrowDecimals >= 0 &&
    constants.borrowDecimals <= 36 &&
    constants.vaultId > 0n;
}

async function proveFluidVaultOperate(
  context: ProtocolDiscoveryContext,
  target: string,
  constants: FluidVaultConstants,
): Promise<boolean> {
  const simulate = context.backend.simulateCalls?.bind(context.backend);
  if (!simulate) return false;
  const collateralAmount = 1_000n * 10n ** BigInt(constants.supplyDecimals);
  const tokenCode = await context.backend.getCode(constants.supplyToken);
  if (tokenCode === "0x") return false;
  const implementationWord = await context.backend.getStorageAt(
    constants.supplyToken,
    IMPLEMENTATION_SLOT,
  );
  const codeHash = ethers.keccak256(ethers.concat([
    ethers.getBytes(ethers.keccak256(tokenCode)),
    ethers.getBytes(implementationWord),
  ]));
  const slotKey = await discoverErc20BalanceStorageSlot({
    context,
    token: constants.supplyToken,
    holder: FLUID_VAULT_PROBE_HOLDER,
    codeHash,
    probeValue: collateralAmount,
  });
  if (!slotKey) return false;

  for (const wholeDebt of [1n, 10n, 100n]) {
    const debtAmount = wholeDebt * 10n ** BigInt(constants.borrowDecimals);
    const calls = [
      {
        from: FLUID_VAULT_PROBE_HOLDER,
        to: constants.supplyToken,
        data: erc20ProbeIface.encodeFunctionData("balanceOf", [FLUID_VAULT_PROBE_HOLDER]),
      },
      {
        from: FLUID_VAULT_PROBE_HOLDER,
        to: constants.borrowToken,
        data: erc20ProbeIface.encodeFunctionData("balanceOf", [FLUID_VAULT_PROBE_HOLDER]),
      },
      {
        from: FLUID_VAULT_PROBE_HOLDER,
        to: constants.supplyToken,
        data: erc20ProbeIface.encodeFunctionData("approve", [target, collateralAmount]),
      },
      {
        from: FLUID_VAULT_PROBE_HOLDER,
        to: target,
        data: fluidVaultIface.encodeFunctionData("operate", [
          0n,
          collateralAmount,
          debtAmount,
          FLUID_VAULT_PROBE_HOLDER,
        ]),
      },
      {
        from: FLUID_VAULT_PROBE_HOLDER,
        to: constants.supplyToken,
        data: erc20ProbeIface.encodeFunctionData("balanceOf", [FLUID_VAULT_PROBE_HOLDER]),
      },
      {
        from: FLUID_VAULT_PROBE_HOLDER,
        to: constants.borrowToken,
        data: erc20ProbeIface.encodeFunctionData("balanceOf", [FLUID_VAULT_PROBE_HOLDER]),
      },
    ] as const;
    const results = await simulate({
      calls,
      stateOverrides: {
        [constants.supplyToken]: {
          stateDiff: { [slotKey]: ethers.toBeHex(collateralAmount, 32) },
        },
      },
    });
    if (results.length !== calls.length || results.some((result) => result.status !== 1)) {
      continue;
    }
    try {
      const collateralBefore = decodeErc20Uint(results[0].returnData);
      const debtBefore = decodeErc20Uint(results[1].returnData);
      const [nftId, finalSupply, finalBorrow] = fluidVaultIface.decodeFunctionResult(
        "operate",
        results[3].returnData,
      );
      const collateralAfter = decodeErc20Uint(results[4].returnData);
      const debtAfter = decodeErc20Uint(results[5].returnData);
      if (
        collateralBefore === collateralAmount &&
        collateralAfter === 0n &&
        BigInt(nftId) > 0n &&
        BigInt(finalSupply) > 0n &&
        BigInt(finalBorrow) > 0n &&
        debtAfter >= debtBefore &&
        debtAfter - debtBefore === debtAmount
      ) return true;
    } catch {
      // Try the next bounded debt amount.
    }
  }
  return false;
}

function decodeErc20Uint(data: string): bigint {
  return BigInt(erc20ProbeIface.decodeFunctionResult("balanceOf", data)[0]);
}

function assertExactFluidVaultRoute(pool: PoolEntry, expected: TokenEdge): void {
  const route = pool.verifiedRoutes?.[0];
  if (
    !route ||
    route.edgeAdapterId !== expected.adapterId ||
    route.tokenIn.toLowerCase() !== expected.tokenIn.toLowerCase() ||
    route.tokenOut.toLowerCase() !== expected.tokenOut.toLowerCase() ||
    route.slotKind !== expected.slotKind ||
    route.protocolAction !== expected.protocolAction
  ) {
    throw new Error(`fluid-vault pool ${pool.address} verified route changed`);
  }
}

function isPermanentFluidSurfaceFailure(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code).toUpperCase()
    : "";
  if (new Set(["CALL_EXCEPTION", "BAD_DATA", "INVALID_ARGUMENT"]).has(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /execution reverted|could not decode|invalid (?:result|data|address)/i.test(message);
}
