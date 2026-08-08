import assert from "node:assert/strict";
import { ethers } from "ethers";
import { METRONOME_HGUSDC_PATH } from "../../adapters/metronome-hgusdc.js";
import { ADDR } from "../../shared/constants/addresses.js";
import type {
  AdapterRequestResult,
  CanonicalSource,
  ObservedEffects,
} from "../venues/adapter-request-program.js";
import {
  erc4626SiloRedeemStrictFamilyPlugin,
  type Erc4626SiloRedeemIdentity,
} from "../venues/protocols/erc4626-silo-redeem-family-plugin.js";
import {
  ERC4626_SILO_INTERFACE,
  ERC4626_SILO_PAYOUT_INTERFACE,
} from "../venues/protocols/erc4626-silo-redeem-family/shared.js";
import {
  ERC4626_SILO_REDEEM_FAMILY_ID,
  ERC4626_SILO_REDEEM_LINEAGE_ID,
} from "../venues/protocols/erc4626-silo-redeem-family/manifest.js";
import {
  etherTokenNativeRedeemStrictFamilyPlugin,
  type EtherTokenNativeRedeemIdentity,
} from "../venues/protocols/ethertoken-native-redeem-family-plugin.js";
import {
  ETHERTOKEN_NATIVE_INTERFACE,
} from "../venues/protocols/ethertoken-native-redeem-family/shared.js";
import {
  ETHERTOKEN_NATIVE_FAMILY_ID,
  ETHERTOKEN_NATIVE_LINEAGE_ID,
} from "../venues/protocols/ethertoken-native-redeem-family/manifest.js";
import {
  metronomeHgUsdcStrictFamilyPlugin,
  type MetronomeHgUsdcIdentity,
} from "../venues/protocols/metronome-hgusdc-family-plugin.js";
import {
  METRONOME_HGUSDC_CURVE_INTERFACE,
  METRONOME_HGUSDC_ROUTER_INTERFACE,
  METRONOME_HGUSDC_VAULT_INTERFACE,
} from "../venues/protocols/metronome-hgusdc-family/shared.js";
import {
  METRONOME_HGUSDC_FAMILY_ID,
  METRONOME_HGUSDC_LINEAGE_ID,
} from "../venues/protocols/metronome-hgusdc-family/manifest.js";
import {
  metronomeSynthStrictFamilyPlugin,
  type MetronomeSynthIdentity,
} from "../venues/protocols/metronome-synth-family-plugin.js";
import {
  METRONOME_SYNTH_FORWARDER_INTERFACE,
  METRONOME_SYNTH_ORACLE_BINDING,
  METRONOME_SYNTH_POOL_INTERFACE,
} from "../venues/protocols/metronome-synth-family/shared.js";
import {
  METRONOME_SYNTH_FAMILY_ID,
  METRONOME_SYNTH_LINEAGE_ID,
} from "../venues/protocols/metronome-synth-family/manifest.js";
import {
  selfBurnNativeStrictFamilyPlugin,
  type SelfBurnNativeIdentity,
} from "../venues/protocols/self-burn-native-family-plugin.js";
import {
  SELF_BURN_NATIVE_TOKEN_INTERFACE,
} from "../venues/protocols/self-burn-native-family/shared.js";
import {
  SELF_BURN_NATIVE_FAMILY_ID,
  SELF_BURN_NATIVE_LINEAGE_ID,
} from "../venues/protocols/self-burn-native-family/manifest.js";

const source: CanonicalSource = Object.freeze({
  number: 21_000_000,
  hash: `0x${"ab".repeat(32)}`,
  generation: 7,
});
const actor = ethers.getAddress(`0x${"00".repeat(19)}a1`);
const tokenA = ethers.getAddress(`0x${"00".repeat(19)}a2`);
const tokenB = ethers.getAddress(`0x${"00".repeat(19)}a3`);
const tokenC = ethers.getAddress(`0x${"00".repeat(19)}a4`);
const router = ethers.getAddress(`0x${"00".repeat(19)}a5`);

const familyIds = [
  erc4626SiloRedeemStrictFamilyPlugin.manifest.familyId,
  metronomeSynthStrictFamilyPlugin.manifest.familyId,
  metronomeHgUsdcStrictFamilyPlugin.manifest.familyId,
  selfBurnNativeStrictFamilyPlugin.manifest.familyId,
  etherTokenNativeRedeemStrictFamilyPlugin.manifest.familyId,
];
assert.equal(new Set(familyIds).size, familyIds.length);

verifyDiscoveryBoundaries();
verifyMetronomeHgUsdcDependentExact();
verifySelfBurnNativeEffects();
verifyEtherTokenNativeEffects();
verifySiloDependentCurrentAndEffects();
verifyMetronomeSynthOracleAndQuote();

console.log(
  "special-protocol-family-plugins PASS " +
    "(five independent strict Families; dependent exact + effect causality)",
);

function verifyDiscoveryBoundaries(): void {
  const selfTransfer = SELF_BURN_NATIVE_TOKEN_INTERFACE.encodeFunctionData(
    "transfer",
    [tokenA, 100n],
  );
  assert(selfBurnNativeStrictFamilyPlugin.discovery.decodeCandidate({
    observation: {
      kind: "call",
      source,
      target: tokenA,
      sender: actor,
      data: selfTransfer,
    },
    matchedPatternId: "self-burn-transfer-self",
  }));
  assert.equal(
    selfBurnNativeStrictFamilyPlugin.discovery.decodeCandidate({
      observation: {
        kind: "call",
        source,
        target: tokenA,
        sender: actor,
        data: SELF_BURN_NATIVE_TOKEN_INTERFACE.encodeFunctionData(
          "transfer",
          [tokenB, 100n],
        ),
      },
      matchedPatternId: "self-burn-transfer-self",
    }),
    null,
  );

  assert.equal(
    etherTokenNativeRedeemStrictFamilyPlugin.discovery.decodeCandidate({
      observation: {
        kind: "call",
        source,
        target: ADDR.WETH,
        sender: actor,
        data: ETHERTOKEN_NATIVE_INTERFACE.encodeFunctionData(
          "withdraw",
          [100n],
        ),
      },
      matchedPatternId: "ethertoken-withdraw-call",
    }),
    null,
    "canonical WETH must stay outside the EtherToken dynamic family",
  );

  const validHgCall = METRONOME_HGUSDC_ROUTER_INTERFACE.encodeFunctionData(
    "executePath",
    [METRONOME_HGUSDC_PATH, [123n], ethers.ZeroAddress],
  );
  assert(metronomeHgUsdcStrictFamilyPlugin.discovery.decodeCandidate({
    observation: {
      kind: "call",
      source,
      target: router,
      sender: actor,
      data: validHgCall,
    },
    matchedPatternId: "metronome-hgusdc-execute-path",
  }));
  assert.equal(
    metronomeHgUsdcStrictFamilyPlugin.discovery.decodeCandidate({
      observation: {
        kind: "call",
        source,
        target: router,
        sender: actor,
        data: METRONOME_HGUSDC_ROUTER_INTERFACE.encodeFunctionData(
          "executePath",
          ["0x1234", [123n], ethers.ZeroAddress],
        ),
      },
      matchedPatternId: "metronome-hgusdc-execute-path",
    }),
    null,
    "a foreign opaque path cannot inherit the hgUSDC execution binding",
  );
}

function verifyMetronomeHgUsdcDependentExact(): void {
  const identity: MetronomeHgUsdcIdentity = Object.freeze({
    familyId: METRONOME_HGUSDC_FAMILY_ID,
    lineageId: METRONOME_HGUSDC_LINEAGE_ID,
    subject: router,
    provenance: Object.freeze([]),
    router,
  });
  const descriptor = metronomeHgUsdcStrictFamilyPlugin.instance
    .finalizeDescriptor({
      identity,
      draft: metronomeHgUsdcStrictFamilyPlugin.instance.compileDraft(identity),
      staticEvidence: undefined,
      sharedBindings: [],
    });
  const [route] = metronomeHgUsdcStrictFamilyPlugin.routes.project({
    descriptor,
  });
  const programInput = Object.freeze({
    descriptor,
    route,
    amountIn: 1_000n,
    source,
    executor: actor,
    runtimeEvidence: Object.freeze([]),
  });
  const program = exactRequestProgram(
    metronomeHgUsdcStrictFamilyPlugin.exact,
    programInput,
  );
  const initial = program.buildRequests(programInput);
  assert.equal(initial.length, 1);
  assert.equal(initial[0].kind, "eth-call");
  const initialArgs = METRONOME_HGUSDC_CURVE_INTERFACE.decodeFunctionData(
    "get_dy",
    initial[0].kind === "eth-call" ? initial[0].data : "0x",
  );
  assert.deepEqual(
    [BigInt(initialArgs[0]), BigInt(initialArgs[1]), BigInt(initialArgs[2])],
    [1n, 0n, 1_000n],
  );
  const curveOut = 777n;
  const initialResult = ok(
    "exact-curve-quote",
    METRONOME_HGUSDC_CURVE_INTERFACE.encodeFunctionResult(
      "get_dy",
      [curveOut],
    ),
  );
  const dependentProgram = program.buildDependentProgram!({
      programInput,
      completedRound: 0,
      initialResults: [initialResult],
      priorEvidence: [],
    });
  assert(dependentProgram);
  const dependent = dependentProgram.requests;
  assert.equal(dependent.length, 1);
  assert.equal(dependent[0].kind, "eth-call");
  const previewArgs = METRONOME_HGUSDC_VAULT_INTERFACE.decodeFunctionData(
    "previewRedeem",
    dependent[0].kind === "eth-call" ? dependent[0].data : "0x",
  );
  assert.equal(BigInt(previewArgs[0]), curveOut);
  assert.deepEqual(
    program.buildDependentProgram!({
      programInput,
      completedRound: 1,
      initialResults: [initialResult],
      priorEvidence: [],
    }),
    null,
  );
  const amountOut = 765n;
  const dependentResult = ok(
    "exact-vault-preview",
    METRONOME_HGUSDC_VAULT_INTERFACE.encodeFunctionResult(
      "previewRedeem",
      [amountOut],
    ),
  );
  const decoded = program.decode({
    programInput,
    initialResults: [initialResult],
    dependentEvidence: [dependentProgram.decode([dependentResult])],
  });
  assert.equal(decoded.amountOut, amountOut);
  assert.equal(decoded.evidence.curveOut, curveOut);
  const fragment = metronomeHgUsdcStrictFamilyPlugin.execution.buildFragment({
    descriptor,
    route,
    amountIn: programInput.amountIn,
    quotedAmountOut: amountOut,
    minAmountOut: amountOut,
    exactEvidence: decoded.evidence,
    executor: actor,
    runtimeEvidence: [],
  });
  assert.deepEqual(fragment.requirements, [{
    kind: "transfer-to-pool",
    token: ethers.getAddress(ADDR.MSUSD),
    pool: ethers.getAddress(ADDR.CURVE_MSUSD_FRXUSD),
    amount: 1_000n,
  }]);
}

function verifySelfBurnNativeEffects(): void {
  const identity: SelfBurnNativeIdentity = Object.freeze({
    familyId: SELF_BURN_NATIVE_FAMILY_ID,
    lineageId: SELF_BURN_NATIVE_LINEAGE_ID,
    subject: tokenA,
    provenance: Object.freeze([]),
    token: tokenA,
  });
  const descriptor = selfBurnNativeStrictFamilyPlugin.instance
    .finalizeDescriptor({
      identity,
      draft: selfBurnNativeStrictFamilyPlugin.instance.compileDraft(identity),
      staticEvidence: undefined,
      sharedBindings: [],
    });
  const [route] = selfBurnNativeStrictFamilyPlugin.routes.project({ descriptor });
  const input = Object.freeze({
    descriptor,
    route,
    amountIn: 100n,
    source,
    executor: actor,
    runtimeEvidence: Object.freeze([]),
  });
  const result = ok(
    "exact-self-burn",
    SELF_BURN_NATIVE_TOKEN_INTERFACE.encodeFunctionResult("transfer", [true]),
    nativeEffects(tokenA, actor, 100n, 87n),
  );
  const selfBurnProgram = exactRequestProgram(
    selfBurnNativeStrictFamilyPlugin.exact,
    input,
  );
  const decoded = selfBurnProgram.decode({
    programInput: input,
    initialResults: [result],
    dependentEvidence: [],
  });
  assert.equal(decoded.amountOut, 87n, "self-burn payout may be non-1:1");
  const fragment = selfBurnNativeStrictFamilyPlugin.execution.buildFragment({
    descriptor,
    route,
    amountIn: 100n,
    quotedAmountOut: 87n,
    minAmountOut: 87n,
    exactEvidence: decoded.evidence,
    executor: actor,
    runtimeEvidence: [],
  });
  assert.deepEqual(
    fragment.nodes.map((node) => node.adapterId),
    ["self-burn-native-redeem", "weth-deposit-value"],
  );
  assert.throws(() => selfBurnProgram.decode({
    programInput: input,
    initialResults: [ok(
      "exact-self-burn",
      SELF_BURN_NATIVE_TOKEN_INTERFACE.encodeFunctionResult("transfer", [true]),
      {
        ...nativeEffects(tokenA, actor, 100n, 87n),
        totalSupplyDeltas: [{ token: tokenA, delta: -99n }],
      },
    )],
    dependentEvidence: [],
  }), /effect invariants/);
}

function verifyEtherTokenNativeEffects(): void {
  const identity: EtherTokenNativeRedeemIdentity = Object.freeze({
    familyId: ETHERTOKEN_NATIVE_FAMILY_ID,
    lineageId: ETHERTOKEN_NATIVE_LINEAGE_ID,
    subject: tokenB,
    provenance: Object.freeze([]),
    token: tokenB,
  });
  const descriptor = etherTokenNativeRedeemStrictFamilyPlugin.instance
    .finalizeDescriptor({
      identity,
      draft: etherTokenNativeRedeemStrictFamilyPlugin.instance.compileDraft(
        identity,
      ),
      staticEvidence: undefined,
      sharedBindings: [],
    });
  const [route] = etherTokenNativeRedeemStrictFamilyPlugin.routes.project({
    descriptor,
  });
  const input = Object.freeze({
    descriptor,
    route,
    amountIn: 100n,
    source,
    executor: actor,
    runtimeEvidence: Object.freeze([]),
  });
  const etherTokenProgram = exactRequestProgram(
    etherTokenNativeRedeemStrictFamilyPlugin.exact,
    input,
  );
  const decoded = etherTokenProgram.decode({
    programInput: input,
    initialResults: [ok(
      "exact-withdraw",
      ETHERTOKEN_NATIVE_INTERFACE.encodeFunctionResult("withdraw", []),
      nativeEffects(tokenB, actor, 100n, 100n),
    )],
    dependentEvidence: [],
  });
  assert.equal(decoded.amountOut, input.amountIn);
  assert.throws(() => etherTokenProgram.decode({
    programInput: input,
    initialResults: [ok(
      "exact-withdraw",
      ETHERTOKEN_NATIVE_INTERFACE.encodeFunctionResult("withdraw", []),
      nativeEffects(tokenB, actor, 100n, 99n),
    )],
    dependentEvidence: [],
  }), /effect invariants/);
}

function verifySiloDependentCurrentAndEffects(): void {
  const identity: Erc4626SiloRedeemIdentity = Object.freeze({
    familyId: ERC4626_SILO_REDEEM_FAMILY_ID,
    lineageId: ERC4626_SILO_REDEEM_LINEAGE_ID,
    subject: tokenA,
    provenance: Object.freeze([]),
    vault: tokenA,
    payoutToken: tokenB,
    underlyingAsset: tokenC,
  });
  const descriptor = erc4626SiloRedeemStrictFamilyPlugin.instance
    .finalizeDescriptor({
      identity,
      draft: erc4626SiloRedeemStrictFamilyPlugin.instance.compileDraft(identity),
      staticEvidence: undefined,
      sharedBindings: [],
    });
  const [route] = erc4626SiloRedeemStrictFamilyPlugin.routes.project({
    descriptor,
  });
  const pricingDraft = erc4626SiloRedeemStrictFamilyPlugin.pricing.compileDraft({
    descriptor,
    stateKey: route.instanceKey,
    routes: [route],
  });
  const pricing = erc4626SiloRedeemStrictFamilyPlugin.pricing
    .finalizePricingDescriptor({
      draft: pricingDraft,
      staticEvidence: { oneShare: 1_000n },
      sharedBindings: [],
    });
  const currentInput = Object.freeze({
    descriptor: pricing,
    routes: Object.freeze([route]),
    source,
  });
  const previewAssets = 900n;
  const initial = ok(
    "current-preview-redeem",
    ERC4626_SILO_INTERFACE.encodeFunctionResult(
      "previewRedeem",
      [previewAssets],
    ),
  );
  const dependentProgram = erc4626SiloRedeemStrictFamilyPlugin.pricing.current
    .buildDependentProgram!({
      current: currentInput,
      completedRound: 0,
      initialResults: [initial],
      priorEvidence: [],
    });
  assert(dependentProgram);
  const dependent = dependentProgram.requests;
  assert.equal(dependent[0].kind, "eth-call");
  const args = ERC4626_SILO_PAYOUT_INTERFACE.decodeFunctionData(
    "previewWithdraw",
    dependent[0].kind === "eth-call" ? dependent[0].data : "0x",
  );
  assert.equal(BigInt(args[0]), previewAssets);
  const dependentResult = ok(
    "current-preview-withdraw",
    ERC4626_SILO_PAYOUT_INTERFACE.encodeFunctionResult(
      "previewWithdraw",
      [850n],
    ),
  );
  const snapshot = erc4626SiloRedeemStrictFamilyPlugin.pricing.current
    .decodeSnapshot({
      descriptor: pricing,
      initialResults: [initial],
      dependentEvidence: [dependentProgram.decode([dependentResult])],
    });
  assert.equal(
    erc4626SiloRedeemStrictFamilyPlugin.pricing.current.deriveMids({
      descriptor: pricing,
      snapshot,
      routes: [route],
    }).size,
    1,
  );

  const exactInput = Object.freeze({
    descriptor,
    route,
    amountIn: 100n,
    source,
    executor: actor,
    runtimeEvidence: Object.freeze([]),
  });
  const exactProgram = exactRequestProgram(
    erc4626SiloRedeemStrictFamilyPlugin.exact,
    exactInput,
  );
  const exact = exactProgram.decode({
    programInput: exactInput,
    initialResults: [ok(
      "exact-active-redeem",
      ERC4626_SILO_INTERFACE.encodeFunctionResult("redeem", [80n]),
      {
        tokenDeltas: [
          { token: tokenA, account: actor, delta: -100n },
          { token: tokenB, account: actor, delta: 80n },
        ],
        totalSupplyDeltas: [{ token: tokenA, delta: -100n }],
      },
    )],
    dependentEvidence: [],
  });
  assert.equal(exact.amountOut, 80n);
}

function verifyMetronomeSynthOracleAndQuote(): void {
  const identity: MetronomeSynthIdentity = Object.freeze({
    familyId: METRONOME_SYNTH_FAMILY_ID,
    lineageId: METRONOME_SYNTH_LINEAGE_ID,
    subject: router,
    provenance: Object.freeze([]),
    pool: router,
    tokens: Object.freeze([ADDR.MSETH, ADDR.MSBTC]),
    directions: Object.freeze([
      Object.freeze({ tokenIn: ADDR.MSETH, tokenOut: ADDR.MSBTC }),
      Object.freeze({ tokenIn: ADDR.MSBTC, tokenOut: ADDR.MSETH }),
    ]),
  });
  const descriptor = metronomeSynthStrictFamilyPlugin.instance
    .finalizeDescriptor({
      identity,
      draft: metronomeSynthStrictFamilyPlugin.instance.compileDraft(identity),
      staticEvidence: undefined,
      sharedBindings: [],
    });
  const routes = metronomeSynthStrictFamilyPlugin.routes.project({ descriptor });
  assert.equal(routes.length, 2);
  const oracleRequirement = descriptor.runtimeRequirements.find(
    (requirement) => requirement.kind === "oracle-state",
  );
  assert(oracleRequirement && oracleRequirement.maxSourceLagBlocks === 0);
  assert.equal(oracleRequirement.oracleBinding, METRONOME_SYNTH_ORACLE_BINDING);
  const input = Object.freeze({
    descriptor,
    route: routes[0],
    amountIn: 100n,
    source,
    executor: actor,
    runtimeEvidence: Object.freeze([]),
  });
  const exactProgram = exactRequestProgram(
    metronomeSynthStrictFamilyPlugin.exact,
    input,
  );
  const exact = exactProgram.decode({
    programInput: input,
    initialResults: [ok(
      "exact-quote-swap-out",
      METRONOME_SYNTH_POOL_INTERFACE.encodeFunctionResult(
        "quoteSwapOut",
        [91n, 2n],
      ),
    )],
    dependentEvidence: [],
  });
  assert.equal(exact.amountOut, 91n);
  const payload = `0xb1dc65a4${"00".repeat(32)}`;
  const oracleEvidence = metronomeSynthStrictFamilyPlugin.protocol.oracleVictim!
    .decode({
      observation: {
        kind: "call",
        source,
        target: ADDR.METRONOME_ORACLE_FORWARDER,
        sender: actor,
        data: METRONOME_SYNTH_FORWARDER_INTERFACE.encodeFunctionData(
          "forward",
          [ADDR.METRONOME_ORACLE, payload],
        ),
      },
    });
  assert(oracleEvidence);
  assert.equal(typeof oracleEvidence, "object");
  assert.equal(Array.isArray(oracleEvidence), false);
  assert.equal(
    (oracleEvidence as { readonly oracleBinding?: unknown }).oracleBinding,
    METRONOME_SYNTH_ORACLE_BINDING,
  );
}

function ok(
  id: string,
  data: string,
  effects?: ObservedEffects,
): Extract<AdapterRequestResult, { readonly ok: true }> {
  return Object.freeze({
    id,
    ok: true as const,
    source,
    provenance: Object.freeze({ kind: "test", fingerprint: `test:${id}` }),
    completion: "returned" as const,
    data,
    ...(effects === undefined ? {} : { effects: Object.freeze(effects) }),
  });
}

function nativeEffects(
  token: string,
  account: string,
  amountIn: bigint,
  nativeOut: bigint,
): ObservedEffects {
  return Object.freeze({
    tokenDeltas: Object.freeze([{ token, account, delta: -amountIn }]),
    nativeDeltas: Object.freeze([{ account, delta: nativeOut }]),
    totalSupplyDeltas: Object.freeze([{ token, delta: -amountIn }]),
  });
}

function exactRequestProgram(
  exact: { readonly methods: (input: any) => readonly any[] },
  input: any,
): any {
  const method = exact.methods(input).find((candidate) =>
    candidate.kind === "request-program"
  );
  assert(method && method.kind === "request-program");
  return method.program;
}
