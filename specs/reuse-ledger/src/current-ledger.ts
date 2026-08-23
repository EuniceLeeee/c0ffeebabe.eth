import {
  entryIdFor,
  REFERENCE_COMMIT,
  REFERENCE_REPOSITORY_ID,
  sealReferenceLock,
  sealReuseLedger,
  type AdoptionMode,
  type DependencyV1,
  type FactOracleV1,
  type ReferenceLockV1,
  type ReuseLedgerEntryV1,
  type ReuseLedgerV1,
} from "./index.ts";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";

/**
 * This is the current audited source set, not a production Family catalog.
 * Every item is a symbol-level reuse decision.  Adding a new Family or
 * domain requires a new audited row; it cannot be inferred from a glob.
 */
interface AuditedSource {
  readonly path: string;
  readonly blob: string;
  readonly symbol: string;
  readonly lineCount: number;
  readonly mode: AdoptionMode;
  readonly destination: string;
  readonly oracle: FactOracleV1;
  readonly oldDependencies: readonly DependencyV1[];
  readonly newDependencies: readonly DependencyV1[];
}

const oldSource = (path: string, blob: string, relation: string): DependencyV1 => ({
  kind: "source",
  path,
  blob,
  relation,
});

const future = (contract: string, relation: string): DependencyV1 => ({
  kind: "future",
  contract,
  status: "pending",
  relation,
});

const mathOracle = (oracleId: string, claim: string): FactOracleV1 => ({
  kind: "mathematical-oracle",
  oracleId,
  source: `acceptance/oracles/${oracleId}`,
  claim,
});

const chainOracle = (oracleId: string, claim: string): FactOracleV1 => ({
  kind: "chain-oracle",
  oracleId,
  source: `acceptance/observers/${oracleId}`,
  claim,
});

const oldAdapterRequest = oldSource(
  "listener/src/searcher/venues/adapter-request-program.ts",
  "aae4eca201f28627f8973a14c1a69b832a38e409",
  "old request DTO is evidence only and must be rebound to the Aloha contract",
);
const oldCanonicalValue = oldSource(
  "listener/src/searcher/venues/canonical-value.ts",
  "fbabcd86e32975710412b315a0bad38b6aba70b4",
  "old canonical value helper is evidence only and is not a runtime dependency",
);
const oldUniv2Abi = oldSource(
  "listener/src/searcher/venues/swaps/univ2-abi.ts",
  "96cfda745366251d03d615e9f0e287c4ad021a16",
  "old ABI declaration is re-bound to a new Family-owned contract",
);

function audited(
  source: AuditedSource,
  reviewOrdinal: number,
): ReuseLedgerEntryV1 {
  const entryId = entryIdFor(source.path, source.symbol);
  const affectedCapabilityRoot: Hash = hashDomain("aloha/reuse-ledger/capability-root/v1", {
    entryId,
    destination: source.destination,
  });
  return {
    entryId,
    sourceRepo: REFERENCE_REPOSITORY_ID,
    sourceCommit: REFERENCE_COMMIT,
    sourcePath: source.path,
    sourceBlob: source.blob,
    symbol: source.symbol,
    sourceRange: { startLine: 1, endLine: source.lineCount - 1 },
    adoptionMode: source.mode,
    destination: source.destination,
    oldDependencyClosure: source.oldDependencies,
    newDependencyClosure: source.newDependencies,
    factOracle: source.oracle,
    affectedCapabilityRoot,
    reviewMetadata: {
      reviewId: `reuse-audit-${String(reviewOrdinal).padStart(2, "0")}`,
      reviewMode: "adversarial",
      reviewer: "aloha-clean-room-review",
      reviewedCommit: REFERENCE_COMMIT,
      notes: "symbol-level evidence only; old lifecycle, authority, fallback, and catalog shells are excluded",
    },
    productionImportAllowed: false,
  };
}

const SOURCES: readonly AuditedSource[] = [
  {
    path: "listener/src/searcher/solver/v2-constant-product-math.ts",
    blob: "61e49626a24f9809cee4ef5b08aacba76c5cc2f3",
    symbol: "quoteV2ExactInput",
    lineCount: 15,
    mode: "isolated-pure-kernel",
    destination: "families/univ2-standard/kernel/math",
    oracle: mathOracle("v2-constant-product", "exact-input output and fee arithmetic match an independent integer oracle"),
    oldDependencies: [],
    newDependencies: [],
  },
  {
    path: "listener/src/searcher/solver/v3-math.ts",
    blob: "8389fc16cc573e598c14a96bbd5df588dcc86640",
    symbol: "mulDiv;mulDivRoundingUp;getAmount0Delta;getAmount1Delta;getNextSqrtPriceFromInput;getNextSqrtPriceFromOutput;computeSwapStep;getSqrtRatioAtTick;nextInitializedTickWithinOneWord;v3SwapToState;v3SwapExactInput",
    lineCount: 383,
    mode: "isolated-pure-kernel",
    destination: "families/univ3-standard/kernel/math",
    oracle: mathOracle("v3-integer-math", "tick, liquidity, sqrt-price and swap-step outputs match an independent integer oracle"),
    oldDependencies: [],
    newDependencies: [],
  },
  {
    path: "listener/src/searcher/solver/curve-math.ts",
    blob: "27cf1109ad546e23b33db33342d73f292064f343",
    symbol: "getD;curvePlainGetDy;curveNgGetDy",
    lineCount: 198,
    mode: "isolated-pure-kernel",
    destination: "families/curve-underlying/kernel/math",
    oracle: mathOracle("curve-invariant", "Newton convergence, invariant and dy outputs match an independent high-precision oracle"),
    oldDependencies: [],
    newDependencies: [],
  },
  {
    path: "listener/src/searcher/venues/swaps/dodo-pmm-math.ts",
    blob: "e7bfd107bf9bfc14ac7f41a2d77b71dca86beecd",
    symbol: "quoteDodoPmmExactInput",
    lineCount: 441,
    mode: "isolated-pure-kernel",
    destination: "families/dodo-v2/kernel/math",
    oracle: mathOracle("dodo-pmm", "PMM quote and boundary arithmetic match an independent integer oracle"),
    oldDependencies: [],
    newDependencies: [],
  },
  {
    path: "listener/src/searcher/venues/swaps/univ2-family/codec.ts",
    blob: "69c86a7e5dc79c149bf1d0e612b2e93d9b2e8622",
    symbol: "canonicalAddress;sameAddress;requireSuccessfulResult;decodeAddressResult;decodeReservesResult;lowerAddress",
    lineCount: 93,
    mode: "invariant-only-rewrite",
    destination: "families/univ2-standard/kernel/codec",
    oracle: chainOracle("univ2-codec", "raw ABI bytes decode to the independently observed pair/factory facts"),
    oldDependencies: [oldAdapterRequest, oldUniv2Abi],
    newDependencies: [future("families/univ2-standard/contract", "new codec contract is not implemented in this ledger slice")],
  },
  {
    path: "listener/src/searcher/venues/swaps/univ2-family/identity.ts",
    blob: "6d88c8be0e4c4d2c5f3b80618b075ad6b08a96c9",
    symbol: "univ2Identity",
    lineCount: 234,
    mode: "invariant-only-rewrite",
    destination: "families/univ2-standard/kernel/identity",
    oracle: chainOracle("univ2-identity", "factory reverse binding and token ordering are independently verified on chain"),
    oldDependencies: [oldAdapterRequest, oldCanonicalValue, oldUniv2Abi],
    newDependencies: [future("families/univ2-standard/contract", "new identity contract is not implemented in this ledger slice")],
  },
  {
    path: "listener/src/searcher/venues/swaps/univ3-family/codec.ts",
    blob: "8c98dd1e5edeb674febefc426092448c7dca9d81",
    symbol: "canonicalAddress;lowerAddress;sameAddress;requireSuccessfulResult;decodeAddressResult;decodeUint24Result;decodePositiveInt24Result",
    lineCount: 81,
    mode: "invariant-only-rewrite",
    destination: "families/univ3-standard/kernel/codec",
    oracle: chainOracle("univ3-codec", "pool slot and token observations decode from exact ABI bytes"),
    oldDependencies: [oldAdapterRequest],
    newDependencies: [future("families/univ3-standard/contract", "new codec contract is not implemented in this ledger slice")],
  },
  {
    path: "listener/src/searcher/venues/swaps/univ3-family/identity.ts",
    blob: "3a0ff50064fdf87f106ba4b9a14866ab4687131e",
    symbol: "univ3Identity",
    lineCount: 286,
    mode: "invariant-only-rewrite",
    destination: "families/univ3-standard/kernel/identity",
    oracle: chainOracle("univ3-identity", "factory, fee, tick-spacing and token ordering are reverse-verified"),
    oldDependencies: [oldAdapterRequest, oldCanonicalValue],
    newDependencies: [future("families/univ3-standard/contract", "new identity contract is not implemented in this ledger slice")],
  },
  {
    path: "listener/src/searcher/venues/swaps/univ4-common.ts",
    blob: "ec2892f4d38220bf56d49b97d1f679cffa465e3e",
    symbol: "v4PoolId;v4HooksAffectSwap;normalizeV4PoolKey;normalizeV4Currency;realV4Currency;validateV4CurrencyPair;rejectNativeWethV4Pool",
    lineCount: 105,
    mode: "invariant-only-rewrite",
    destination: "families/univ4/kernel/pool-key",
    oracle: chainOracle("univ4-pool-key", "PoolKey canonicalization and pool id match independently encoded on-chain identity"),
    oldDependencies: [],
    newDependencies: [future("families/univ4/contract", "new pool-key contract is not implemented in this ledger slice")],
  },
  {
    path: "listener/src/searcher/venues/swaps/univ4-family/codec.ts",
    blob: "4d5d1603bc5ec34c210f0748d2b69e174de61113",
    symbol: "canonicalAddress;lowerAddress;sameAddress;canonicalPoolId;canonicalPoolKey;assertPoolKeyIdentity;graphCurrency;poolKeyProjection;poolKeyFingerprint;requireSuccessfulResult;assertSameSource;requireCodeHash",
    lineCount: 116,
    mode: "invariant-only-rewrite",
    destination: "families/univ4/kernel/codec",
    oracle: chainOracle("univ4-codec", "PoolManager state and hook facts decode from exact bytes"),
    oldDependencies: [],
    newDependencies: [future("families/univ4/contract", "new codec contract is not implemented in this ledger slice")],
  },
  {
    path: "listener/src/searcher/venues/swaps/fluid-dex-family/codec.ts",
    blob: "d8ce06cbe0b3be4eab25d64d7e4ec3a7f210b973",
    symbol: "canonicalAddress;lowerAddress;sameAddress;requireSuccessfulResult;decodeFluidDexConstants;decodeAddressResult;decodeDecimals;decodeDeclaredFluidDexQuote;assertSource",
    lineCount: 141,
    mode: "invariant-only-rewrite",
    destination: "families/fluid-dex/kernel/codec",
    oracle: chainOracle("fluid-dex-codec", "vault constants, decimals and quote bytes match independent chain reads"),
    oldDependencies: [oldAdapterRequest],
    newDependencies: [future("families/fluid-dex/contract", "new codec contract is not implemented in this ledger slice")],
  },
  {
    path: "listener/src/searcher/venues/swaps/fluid-dex-family/identity.ts",
    blob: "6f6bf16604a8f89e67d06a77a80f7e49edcd938b",
    symbol: "fluidDexIdentity",
    lineCount: 351,
    mode: "invariant-only-rewrite",
    destination: "families/fluid-dex/kernel/identity",
    oracle: chainOracle("fluid-dex-identity", "vault, asset and source binding are independently reverse-verified"),
    oldDependencies: [oldAdapterRequest, oldCanonicalValue],
    newDependencies: [future("families/fluid-dex/contract", "new identity contract is not implemented in this ledger slice")],
  },
  {
    path: "listener/src/searcher/venues/swaps/curve-underlying-family/codec.ts",
    blob: "f012dd6315695d74c3385369e9e8b342f8207cbd",
    symbol: "canonicalAddress;lowerAddress;sameAddress;requireSuccessfulResult;normalizeAddressArray;decodeHandlers;decodeUnderlyingCoins;decodeUnderlyingDecimals;decodeUnderlyingBalances;decodeTokenDecimals;decodeGetDy;decodeUnderlyingIndicesFromCall;assertSameSource",
    lineCount: 183,
    mode: "invariant-only-rewrite",
    destination: "families/curve-underlying/kernel/codec",
    oracle: chainOracle("curve-underlying-codec", "underlying coin, index, decimals and balances match independent registry calls"),
    oldDependencies: [oldAdapterRequest],
    newDependencies: [future("families/curve-underlying/contract", "new codec contract is not implemented in this ledger slice")],
  },
  {
    path: "listener/src/searcher/venues/swaps/curve-underlying-family/identity.ts",
    blob: "61a8477aeb695fbe8e823f98c4dfa9867b7035f6",
    symbol: "curveUnderlyingIdentity",
    lineCount: 331,
    mode: "invariant-only-rewrite",
    destination: "families/curve-underlying/kernel/identity",
    oracle: chainOracle("curve-underlying-identity", "metapool and underlying coin identity are reverse-verified from registry facts"),
    oldDependencies: [oldAdapterRequest, oldCanonicalValue],
    newDependencies: [future("families/curve-underlying/contract", "new identity contract is not implemented in this ledger slice")],
  },
  {
    path: "listener/src/searcher/venues/protocols/astra-multitoken-family/codec.ts",
    blob: "7caf60f751561b7e5f13426f5e8e095e0570b46e",
    symbol: "canonicalAddress;lowerAddress;sameAddress;successfulResult;returnedResult;decodeOptionalBoolean;decodeOptionalUint;decodeUint;decodeToken;assertSameSource;assertSource;assertTokenSet;tokenPairKey",
    lineCount: 176,
    mode: "invariant-only-rewrite",
    destination: "families/astra-multitoken/kernel/codec",
    oracle: chainOracle("astra-codec", "Astra registry and token facts decode from exact chain bytes"),
    oldDependencies: [oldAdapterRequest],
    newDependencies: [future("families/astra-multitoken/contract", "new codec contract is not implemented in this ledger slice")],
  },
  {
    path: "listener/src/searcher/venues/protocols/astra-multitoken-family/identity.ts",
    blob: "0ff3cd86b13748d41d2435707c19225e6ba4e061",
    symbol: "astraMultiTokenIdentity",
    lineCount: 610,
    mode: "invariant-only-rewrite",
    destination: "families/astra-multitoken/kernel/identity",
    oracle: chainOracle("astra-effects", "caller, target, tokenIn, tokenOut deltas and logs match an independent simulation observer"),
    oldDependencies: [oldAdapterRequest, oldCanonicalValue],
    newDependencies: [future("families/astra-multitoken/contract", "new effect contract is not implemented in this ledger slice")],
  },
  {
    path: "listener/src/searcher/venues/protocols/astra-multitoken-family/pricing.ts",
    blob: "8854df4cc677e2eed1a5dfa7ff250ac5c9218470",
    symbol: "astraMultiTokenPricing",
    lineCount: 287,
    mode: "invariant-only-rewrite",
    destination: "families/astra-multitoken/kernel/pricing",
    oracle: mathOracle("astra-pricing", "pricing projection matches independent fixed-point calculation; no admission authority is copied"),
    oldDependencies: [],
    newDependencies: [future("families/astra-multitoken/contract", "new pricing contract is not implemented in this ledger slice")],
  },
  {
    path: "listener/src/searcher/venues/protocols/eigenpie-family/codec.ts",
    blob: "360ddc59e6706cacdd340b17c36baf5156b1ae02",
    symbol: "decodeEigenpieQuote",
    lineCount: 32,
    mode: "invariant-only-rewrite",
    destination: "families/eigenpie/kernel/codec",
    oracle: chainOracle("eigenpie-codec", "quote bytes and asset identity match independent chain observations"),
    oldDependencies: [oldAdapterRequest],
    newDependencies: [future("families/eigenpie/contract", "new codec contract is not implemented in this ledger slice")],
  },
  {
    path: "listener/src/searcher/venues/protocols/eigenpie-family/identity.ts",
    blob: "9172f0dd0407108a7581f83b2b67cd2374b1b917",
    symbol: "eigenpieIdentity",
    lineCount: 271,
    mode: "invariant-only-rewrite",
    destination: "families/eigenpie/kernel/identity",
    oracle: chainOracle("eigenpie-identity", "identity and emitted log facts match independent receipt/log observations"),
    oldDependencies: [oldAdapterRequest, oldCanonicalValue],
    newDependencies: [future("families/eigenpie/contract", "new identity contract is not implemented in this ledger slice")],
  },
  {
    path: "listener/src/searcher/venues/protocols/erc4626-family/identity.ts",
    blob: "32c2165f10b9308aa9b29705e708951b056cea27",
    symbol: "erc4626Identity;tolerance",
    lineCount: 728,
    mode: "isolated-pure-kernel",
    destination: "families/erc4626/kernel/tolerance",
    oracle: mathOracle("erc4626-tolerance", "tolerance arithmetic matches the independent rounding-bound oracle"),
    oldDependencies: [],
    newDependencies: [],
  },
  {
    path: "listener/src/searcher/venues/protocols/erc4626-silo-redeem-family/shared.ts",
    blob: "01bcb23c3b87a669ed948824918eb99f5d99ef5e",
    symbol: "erc4626SiloStaticProjection;erc4626SiloRedeemSimulation;validateErc4626SiloRedeemEffects",
    lineCount: 146,
    mode: "invariant-only-rewrite",
    destination: "families/erc4626-silo-redeem/kernel/effects",
    oracle: chainOracle("erc4626-silo-effects", "redeem asset deltas and conservation facts match independent receipt observations"),
    oldDependencies: [oldAdapterRequest],
    newDependencies: [future("families/erc4626-silo-redeem/contract", "new effect contract is not implemented in this ledger slice")],
  },
  {
    path: "listener/src/searcher/venues/protocols/psm-family/codec.ts",
    blob: "d25d78d9b2de49cd09d369e8afb21b95ba80eefb",
    symbol: "psmSellQuote",
    lineCount: 28,
    mode: "isolated-pure-kernel",
    destination: "families/psm/kernel/quote",
    oracle: mathOracle("psm-quote", "PSM fee and quote projection match independent fixed-point arithmetic"),
    oldDependencies: [],
    newDependencies: [],
  },
  {
    path: "listener/src/searcher/venues/protocols/goldx-family/codec.ts",
    blob: "8a83a1ff60ba425b7e588c89defc4db89da6c73b",
    symbol: "goldxQuote",
    lineCount: 16,
    mode: "isolated-pure-kernel",
    destination: "families/goldx/kernel/quote",
    oracle: mathOracle("goldx-quote", "GOLDx quote projection matches independent fixed-point arithmetic"),
    oldDependencies: [],
    newDependencies: [],
  },
  {
    path: "listener/src/searcher/venues/protocols/metronome-synth-family/shared.ts",
    blob: "fff8db5ba84426cd0feaca357e71ea5ad656f8a7",
    symbol: "metronomeSynthDirectionsProjection;metronomeSynthStaticProjection;assertMetronomeSynthInvocation;metronomeSynthUniqueAddresses;metronomeSynthDirectedPairs;metronomeSynthActiveQuoteId;metronomeSynthCurrentRequestId",
    lineCount: 120,
    mode: "invariant-only-rewrite",
    destination: "families/metronome-synth/kernel/projection",
    oracle: chainOracle("metronome-synth", "synth identity/projection facts match independent chain observations"),
    oldDependencies: [oldCanonicalValue],
    newDependencies: [future("families/metronome-synth/contract", "new projection contract is not implemented in this ledger slice")],
  },
  {
    path: "listener/src/searcher/venues/protocols/metronome-hgusdc-family/shared.ts",
    blob: "43fcd6d0c1f88d5841a1d5ded129ed9116551888",
    symbol: "metronomeHgUsdcStaticProjection;assertMetronomeHgUsdcInvocation",
    lineCount: 80,
    mode: "invariant-only-rewrite",
    destination: "families/metronome-hgusdc/kernel/projection",
    oracle: chainOracle("metronome-hgusdc", "hgUSDC projection facts match independent chain observations"),
    oldDependencies: [oldCanonicalValue],
    newDependencies: [future("families/metronome-hgusdc/contract", "new projection contract is not implemented in this ledger slice")],
  },
  {
    path: "listener/src/searcher/venues/protocols/ethertoken-native-redeem-family/shared.ts",
    blob: "818eb8c6198554f6f4061eb8fa3f6ebfec522915",
    symbol: "etherTokenNativeStaticProjection;assertEtherTokenNativeInvocation;etherTokenWithdrawalSimulation;validateEtherTokenWithdrawal",
    lineCount: 136,
    mode: "invariant-only-rewrite",
    destination: "families/ethertoken-native-redeem/kernel/effects",
    oracle: chainOracle("ethertoken-effects", "native redemption deltas and conservation facts match independent receipt observations"),
    oldDependencies: [oldAdapterRequest],
    newDependencies: [future("families/ethertoken-native-redeem/contract", "new effect contract is not implemented in this ledger slice")],
  },
  {
    path: "listener/src/searcher/venues/protocols/self-burn-native-family/shared.ts",
    blob: "5ba6f02757cbd57a5c9ac750960380ad0d01e862",
    symbol: "selfBurnNativeStaticProjection;assertSelfBurnNativeInvocation;selfBurnNativeProbeAmounts;selfBurnNativeSimulation;validateSelfBurnNativeEffects",
    lineCount: 152,
    mode: "invariant-only-rewrite",
    destination: "families/self-burn-native/kernel/effects",
    oracle: chainOracle("self-burn-effects", "burn probe and native effect facts match independent receipt observations"),
    oldDependencies: [oldAdapterRequest],
    newDependencies: [future("families/self-burn-native/contract", "new effect contract is not implemented in this ledger slice")],
  },
] as const;

export const CURRENT_REUSE_LEDGER: ReuseLedgerV1 = sealReuseLedger(
  SOURCES.map((source, index) => audited(source, index + 1)),
);

export const CURRENT_REFERENCE_LOCK: ReferenceLockV1 = sealReferenceLock(
  CURRENT_REUSE_LEDGER.entries.map(entry => ({
    entryId: entry.entryId,
    sourceRepo: entry.sourceRepo,
    sourceCommit: entry.sourceCommit,
    sourcePath: entry.sourcePath,
    sourceBlob: entry.sourceBlob,
    license: "not-copied-until-reviewed",
    allowedDisposition: entry.adoptionMode,
  })),
);

/** Required set is intentionally independent from the ledger object. */
export const REQUIRED_AUDIT_ENTRY_IDS: readonly string[] = Object.freeze(
  SOURCES.map(source => entryIdFor(source.path, source.symbol)).sort(),
);

export const CURRENT_AUDIT_ENTRY_COUNT = CURRENT_REUSE_LEDGER.entries.length;
