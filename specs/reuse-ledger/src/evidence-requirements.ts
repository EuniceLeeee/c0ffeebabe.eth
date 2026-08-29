/**
 * These exports describe evidence that a reuse review must inspect. They are
 * not executable oracles and never assert that a production predicate passed.
 */
export interface ReuseEvidenceRequirementV2 {
  readonly kind: "aloha.reuse-evidence-requirement";
  readonly requirementId: string;
  readonly testModulePath: string;
  readonly testCaseName: string;
  readonly authority: "requirement-only";
  readonly productionOraclePass: false;
}

const requirement = (requirementId: string, testModulePath: string, testCaseName: string): ReuseEvidenceRequirementV2 => Object.freeze({
  kind: "aloha.reuse-evidence-requirement",
  requirementId,
  testModulePath,
  testCaseName,
  authority: "requirement-only",
  productionOraclePass: false,
});

export const CURVE_MATH_EVIDENCE = requirement("reuse-evidence.curve-math", "families/curve-underlying/test/kernel.test.ts", "balanced invariant equals the independent N*x identity");
export const UNIV2_MATH_EVIDENCE = requirement("reuse-evidence.univ2-math", "families/univ2-standard/test/kernel.test.ts", "constant-product quote matches the independent invariant oracle");
export const UNIV3_MATH_EVIDENCE = requirement("reuse-evidence.univ3-math", "families/univ3-standard/test/kernel.test.ts", "tick and delta arithmetic matches independent boundary identities");
export const ASTRA_CODEC_EVIDENCE = requirement("reuse-evidence.astra-codec", "families/astra-multitoken/test/plugin.test.ts", "Astra exact verification binds deltas to the observed caller and real Change topic");
export const ASTRA_IDENTITY_EVIDENCE = requirement("reuse-evidence.astra-identity", "families/astra-multitoken/test/effects.test.ts", "Astra owns four exact pairs and rejects aggregate or scope mutation");
export const ASTRA_PRICING_EVIDENCE = requirement("reuse-evidence.astra-pricing", "families/astra-multitoken/test/plugin.test.ts", "Astra exact verification binds deltas to the observed caller and real Change topic");
export const EIGENPIE_CODEC_EVIDENCE = requirement("reuse-evidence.eigenpie-codec", "families/eigenpie/test/codec.test.ts", "Eigenpie decodes exact canonical ABI words");
export const EIGENPIE_IDENTITY_EVIDENCE = requirement("reuse-evidence.eigenpie-identity", "families/eigenpie/test/plugin.test.ts", "Eigenpie nomination is bounded and identity reverse binding is fail-closed");
export const ERC4626_TOLERANCE_EVIDENCE = requirement("reuse-evidence.erc4626-tolerance", "families/erc4626/test/tolerance.test.ts", "ERC4626 bound accepts exact edge and rejects one-unit mutation");
export const ERC4626_SILO_EFFECTS_EVIDENCE = requirement("reuse-evidence.erc4626-silo-effects", "families/erc4626-silo-redeem/test/effects.test.ts", "Silo binds returned amount, exact observation scope, share burn and payout");
export const ETHERTOKEN_EFFECTS_EVIDENCE = requirement("reuse-evidence.ethertoken-effects", "families/ethertoken-native-redeem/test/effects.test.ts", "EtherToken requires empty return bytes and exact native redemption scope");
export const GOLDX_QUOTE_EVIDENCE = requirement("reuse-evidence.goldx-quote", "families/goldx/test/quote.test.ts", "GOLDx quote floors multiplication by its positive unit");
export const METRONOME_HGUSDC_EVIDENCE = requirement("reuse-evidence.metronome-hgusdc", "families/metronome-hgusdc/test/projection.test.ts", "hgUSDC projection fixes ordered quote chain");
export const METRONOME_SYNTH_EVIDENCE = requirement("reuse-evidence.metronome-synth", "families/metronome-synth/test/projection.test.ts", "directed projection is canonical and direction-sensitive");
export const PSM_QUOTE_EVIDENCE = requirement("reuse-evidence.psm-quote", "families/psm/test/quote.test.ts", "PSM quote floors fixed-point fee and rejects invalid parameters");
export const SELF_BURN_EFFECTS_EVIDENCE = requirement("reuse-evidence.self-burn-effects", "families/self-burn-native/test/effects.test.ts", "self-burn binds true return, exact effect scope and variable payout");
export const CURVE_CODEC_EVIDENCE = requirement("reuse-evidence.curve-codec", "families/curve-underlying/test/search-codec.test.ts", "Curve search decodes fixed and dynamic ABI arrays without coercing shapes");
export const CURVE_IDENTITY_EVIDENCE = requirement("reuse-evidence.curve-identity", "families/curve-underlying/test/plugin.test.ts", "Curve identity is reverse registry plus complete underlying domain");
export const DODO_MATH_EVIDENCE = requirement("reuse-evidence.dodo-math", "families/dodo-v2/test/kernel.test.ts", "K=0 matches the independent linear oracle and subtracts fees independently");
export const FLUID_CODEC_EVIDENCE = requirement("reuse-evidence.fluid-codec", "families/fluid-dex/test/plugin.test.ts", "Fluid DEX carries identity → materialization → route → exact → action → execution lineage");
export const FLUID_IDENTITY_EVIDENCE = requirement("reuse-evidence.fluid-identity", "families/fluid-dex/test/plugin.test.ts", "Fluid DEX reverse identity binds the instance before route and state");
export const UNIV2_CODEC_EVIDENCE = requirement("reuse-evidence.univ2-codec", "families/univ2-standard/test/kernel.test.ts", "ABI word decoders reject padding and width mutations");
export const UNIV2_IDENTITY_EVIDENCE = requirement("reuse-evidence.univ2-identity", "families/univ2-standard/test/kernel.test.ts", "both factory getPair directions are load-bearing in identity");
export const UNIV3_CODEC_EVIDENCE = requirement("reuse-evidence.univ3-codec", "families/univ3-standard/test/kernel.test.ts", "codec widths and reverse identity fields are load-bearing");
export const UNIV3_IDENTITY_EVIDENCE = requirement("reuse-evidence.univ3-identity", "families/univ3-standard/test/kernel.test.ts", "codec widths and reverse identity fields are load-bearing");
export const UNIV4_POOL_KEY_EVIDENCE = requirement("reuse-evidence.univ4-pool-key", "families/univ4/test/plugin.test.ts", "UniV4 PoolKey hashes to the independent Solidity/cast known vector");
export const UNIV4_CODEC_EVIDENCE = requirement("reuse-evidence.univ4-codec", "families/univ4/test/plugin.test.ts", "UniV4 reverse identity binds the instance before route and state");
