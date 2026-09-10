import assert from "node:assert/strict";
import { ethers } from "ethers";
import { METRONOME_HGUSDC_PATH } from "../../adapters/metronome-hgusdc.js";
import { ADDR } from "../../shared/constants/addresses.js";
import type {
  AdapterRequestResult,
  CanonicalSource,
  CallerRef,
  ObservedEffects,
} from "../venues/adapter-request-program.js";
import { executeAdapterWork } from "../adapter-work-intent.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { createRevmStrictSimulationTransport } from "../revm-strict-simulation-transport.js";
import type { DaemonResponse, StrictSimulateRequest } from "../revm-sim-client.js";
import {
  erc4626SiloRedeemStrictFamilyPlugin,
  type Erc4626SiloRedeemIdentity,
} from "../venues/protocols/erc4626-silo-redeem-family-plugin.js";
import {
  ERC4626_SILO_INTERFACE,
  ERC4626_SILO_PAYOUT_INTERFACE,
  erc4626SiloRedeemSimulation,
} from "../venues/protocols/erc4626-silo-redeem-family/shared.js";
import { erc4626SiloRedeemExact } from "../venues/protocols/erc4626-silo-redeem-family/exact.js";
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
  etherTokenWithdrawalSimulation,
} from "../venues/protocols/ethertoken-native-redeem-family/shared.js";
import { etherTokenNativeRedeemExact } from "../venues/protocols/ethertoken-native-redeem-family/exact.js";
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
  selfBurnNativeSimulation,
} from "../venues/protocols/self-burn-native-family/shared.js";
import { selfBurnNativeExact } from "../venues/protocols/self-burn-native-family/exact.js";
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
await verifySelfBurnNativeEffects();
await verifyEtherTokenNativeEffects();
await verifySiloDependentCurrentAndEffects();
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

async function verifySelfBurnNativeEffects(): Promise<void> {
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
  const method = selfBurnNativeExact.methods().find(m => m.kind === "request-program");
  assert(method && method.kind === "request-program");
  assert("chainAmountQuote" in method && method.chainAmountQuote === true,
    "self-burn's existing effect method must explicitly declare chain amount quoting");
  assert(!("reusePolicy" in method), "chain provenance is not a cross-block carry policy");
  const selfBurnProgram = method.program;
  for (const [amountIn, amountOut] of [[1n, 7n], [137n, 89n],
    [10n ** 18n, 10n ** 17n + 19n], [(1n << 128n) + 37n, 321n]]) {
    const programInput = Object.freeze({ ...input, amountIn });
    const requests = selfBurnProgram.buildRequests(programInput);
    assert.equal(requests.length, 1);
    const [request] = requests;
    assert(request.kind === "effect-delta-simulation");
    assert.equal(request.call.executionMode, "impersonated-call-frame");
    assert.deepEqual(request.call.caller, { kind: "executor" });
    assert.equal(request.call.to, tokenA);
    assert.equal(request.overrideIntent.caller, request.call.caller);
    assert.deepEqual(request.overrideIntent.tokenBalances, [{ token: tokenA, amount: amountIn }]);
    assert.deepEqual(request.observeTokenBalances, [{ token: tokenA, account: request.call.caller }]);
    assert(Object.isFrozen(request.observeTokenBalances) && request.observeTokenBalances?.every(Object.isFrozen));
    assert.deepEqual(request.observe, ["return-data", "token-delta", "native-delta", "total-supply-delta", "logs"]);
    const args = SELF_BURN_NATIVE_TOKEN_INTERFACE.decodeFunctionData(
      "transfer", request.call.data,
    );
    assert.equal(args[0], tokenA);
    assert.equal(BigInt(args[1]), amountIn);
    const effects = nativeEffects(tokenA, actor, amountIn, amountOut);
    const result = ok("exact-self-burn", SELF_BURN_NATIVE_TOKEN_INTERFACE.encodeFunctionResult("transfer", [true]), effects);
    const decode = (item: AdapterRequestResult) => selfBurnProgram.decode({
      programInput, initialResults: [item], dependentEvidence: [],
    });
    const quote = decode(result);
    assert.equal(quote.amountOut, amountOut, "native payout is observed, not 1:1 or a rescaled probe");
    assert.equal(quote.evidence.amountIn, amountIn); assert.equal(quote.evidence.amountOut, amountOut);
    assert.equal(quote.evidence.executor, actor); assert.equal(quote.evidence.token, tokenA);
    assert.deepEqual(quote.evidence.source, source);
    assert.equal(quote.evidence.bindingFingerprint, route.bindingRef.fingerprint);
    const changedPayout = decode({ ...result, effects: nativeEffects(tokenA, actor, amountIn, amountOut + 1n) });
    assert.equal(changedPayout.amountOut, amountOut + 1n, "any positive payout retains the variable-rate semantics");
    assert.notEqual(changedPayout.evidence.effectsHash, quote.evidence.effectsHash);
    const executionInput = { descriptor, route, amountIn, quotedAmountOut: quote.amountOut,
      minAmountOut: quote.amountOut, exactEvidence: quote.evidence, executor: actor, runtimeEvidence: [] };
    const fragment = selfBurnNativeStrictFamilyPlugin.execution.buildFragment(executionInput);
    assert.deepEqual(fragment.nodes.map(node => [node.adapterId, node.target, node.amount]), [
      ["self-burn-native-redeem", tokenA, amountIn], ["weth-deposit-value", ADDR.WETH, amountOut],
    ]);
    for (const exactEvidence of [
      { ...quote.evidence, amountIn: amountIn + 1n }, { ...quote.evidence, amountOut: amountOut + 1n },
      { ...quote.evidence, token: tokenB }, { ...quote.evidence, executor: router },
      { ...quote.evidence, bindingFingerprint: "wrong-binding" },
    ]) assert.throws(() => selfBurnNativeStrictFamilyPlugin.execution.buildFragment({
      ...executionInput, exactEvidence,
    }), /incompatible exact evidence/);
    const wrongEffects: ObservedEffects[] = [
      {}, { ...effects, tokenDeltas: [] },
      { ...effects, tokenDeltas: [{ token: tokenA, account: actor, delta: -amountIn + 1n }] },
      { ...effects, tokenDeltas: [{ token: tokenB, account: actor, delta: -amountIn }] },
      { ...effects, tokenDeltas: [{ token: tokenA, account: router, delta: -amountIn }] },
      { ...effects, totalSupplyDeltas: [] },
      { ...effects, totalSupplyDeltas: [{ token: tokenA, delta: -amountIn + 1n }] },
      { ...effects, totalSupplyDeltas: [{ token: tokenB, delta: -amountIn }] },
      { ...effects, nativeDeltas: [] },
      ...[0n, -amountOut].map(delta => ({ ...effects, nativeDeltas: [{ account: actor, delta }] })),
      { ...effects, nativeDeltas: [{ account: router, delta: amountOut }] },
    ];
    for (const invalid of wrongEffects) assert.throws(() => decode({ ...result, effects: invalid }), /effect invariants/);
    for (const changedSource of [{ ...source, number: source.number - 1 },
      { ...source, hash: `0x${"12".repeat(32)}` }, { ...source, generation: source.generation + 1 }]) {
      assert.throws(() => decode({ ...result, source: changedSource }), /source/);
    }
    assert.throws(() => decode({ ...result, completion: "reverted-as-declared" }), /did not return/);
    assert.throws(() => decode({ ...result, data: SELF_BURN_NATIVE_TOKEN_INTERFACE.encodeFunctionResult("transfer", [false]) }), /returned false/);
    for (const data of ["0x", "0x01", "not-hex"]) assert.throws(() => decode({ ...result, data }));
    assert.throws(() => selfBurnProgram.decode({ programInput, initialResults: [], dependentEvidence: [] }), /missing/);
    for (const failure of ["rpc", "deadline", "aborted", "resource-limited"] as const) {
      assert.throws(() => decode({ id: "exact-self-burn", ok: false, source, failure }), /unresolved/);
    }
  }
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

  // Identity, pricing and Exact share this builder. The observation must keep
  // the supplied symbolic caller rather than materialize a probe's address.
  for (const callerRef of [{ kind: "executor" },
    { kind: "verified-actor", evidenceId: "self-burn-test-probe" }] satisfies CallerRef[]) {
    const request = selfBurnNativeSimulation({ id: "symbolic-self-burn", token: tokenA,
      actor, callerRef, amountIn: 137n });
    assert(request.kind === "effect-delta-simulation");
    assert.equal(request.call.caller, callerRef); assert.equal(request.overrideIntent.caller, callerRef);
    assert.equal(request.observeTokenBalances?.[0].account, callerRef);
  }
  const zero = { ...input, amountIn: 0n };
  assert.deepEqual(selfBurnProgram.requirements(zero), { transports: [] });
  assert.deepEqual(selfBurnProgram.buildRequests(zero), []);
  assert.equal(selfBurnProgram.decode({ programInput: zero, initialResults: [], dependentEvidence: [] }).amountOut, 0n);
  const local = selfBurnNativeExact.methods()[0]; assert(local.kind === "local");
  assert.equal(local.quote(zero).status, "quoted"); assert.equal(local.quote(input).status, "not-applicable");
  assert.throws(() => selfBurnProgram.buildRequests({ ...input, amountIn: -1n }), /negative/);
  assert.throws(() => selfBurnProgram.buildRequests({ ...input, route: { ...route, tokenOut: tokenB } }), /incompatible/);

  // Real central issuance and typed transport, with a local injected lease and
  // no RPC/child. Exact burns 137 of the original token and observes 89 native;
  // executor, transaction origin and identity probe are distinct authorities.
  const pin = { chainId: 1, blockHash: source.hash, stateRoot: `0x${"16".repeat(32)}` };
  const rpcUrl = "http://127.0.0.1:1/not-opened-self-burn-test", origin = router, probe = tokenC;
  const amountIn = 137n, amountOut = 89n;
  for (const mode of ["success", "revert", "source-mismatch", "wrong-account", "missing-effects",
    "false-return", "malformed-return", "zero-payout", "missing-origin", "cancelled", "deadline", "generation-changed"] as const) {
    let dispatched = 0, validatedRequests = 0, decoded = 0, fatal = 0, fallbackReads = 0;
    let currentGeneration = source.generation;
    const controller = new AbortController();
    const now = Date.now;
    let clock = now();
    const deadlineAtMs = clock + 60_000;
    if (mode === "deadline") Date.now = () => clock;
    try {
      const transport = createRevmStrictSimulationTransport({ rpcUrl, executionGasLimit: 1_000_000,
        onFatal() { fatal++; }, leaseFor: async requested => {
          assert.deepEqual(requested, source);
          return { source, sourcePin: pin, closeAndDrain: async () => {},
            strictSimulate: async (request: StrictSimulateRequest, control): Promise<DaemonResponse> => {
              dispatched++;
              assert.equal(control?.signal, controller.signal); assert.equal(control?.deadlineAtMs, deadlineAtMs);
              assert.equal(request.from, actor.toLowerCase()); assert.equal(request.transactionOrigin, origin.toLowerCase());
              assert.equal(request.callerMode, "impersonated-call-frame"); assert.equal(request.rpcUrl, rpcUrl);
              assert.equal(request.to, tokenA.toLowerCase()); assert.equal(request.blockNumber, source.number);
              assert.deepEqual([...SELF_BURN_NATIVE_TOKEN_INTERFACE.decodeFunctionData("transfer", request.data)], [tokenA, amountIn]);
              assert.deepEqual(request.tokenDeals, [{ token: tokenA.toLowerCase(), to: actor.toLowerCase(), amount: amountIn.toString() }]);
              assert.deepEqual(request.sourcePin, pin);
              assert.deepEqual(request.observeTokenBalances, [{ token: tokenA.toLowerCase(), account: actor.toLowerCase() }]);
              assert.deepEqual(request.observeNativeBalances, [actor.toLowerCase()]);
              assert.deepEqual(request.observeTotalSupply, [tokenA.toLowerCase()]);
              validatedRequests++;
              const output = mode === "revert" ? "0x1234" : mode === "malformed-return" ? "0x"
                : SELF_BURN_NATIVE_TOKEN_INTERFACE.encodeFunctionResult("transfer", [mode !== "false-return"]);
              const nativeOut = mode === "zero-payout" ? 0n : amountOut;
              if (mode === "cancelled") controller.abort();
              if (mode === "deadline") clock = deadlineAtMs;
              if (mode === "generation-changed") currentGeneration++;
              return { ok: true, success: mode !== "revert", latencyMs: 0, output, gasUsed: "21000",
                ...(mode === "revert" ? { revertReason: output } : {}),
                sourceAttestation: { kind: "node-attested", ...pin, blockNumber: source.number,
                  stateRoot: mode === "source-mismatch" ? `0x${"17".repeat(32)}` : pin.stateRoot, parentHash: `0x${"18".repeat(32)}` },
                strict: { outcome: { kind: mode === "revert" ? "Revert" : "Success", phase: "main", output }, executionGasUsed: "21000",
                  logs: [], tokenDeltas: mode === "revert" || mode === "missing-effects" ? [] : [{ token: tokenA.toLowerCase(),
                    account: mode === "wrong-account" ? probe.toLowerCase() : actor.toLowerCase(), delta: (-amountIn).toString() }],
                  nativeDeltas: mode === "revert" ? [] : [{ account: actor.toLowerCase(), before: "0", after: nativeOut.toString(), delta: nativeOut.toString() }],
                  totalSupplyDeltas: mode === "revert" ? [] : [{ token: tokenA.toLowerCase(), delta: (-amountIn).toString() }] } };
            } };
        } });
      const runtime = createStrictCentralAdapterRuntime({ executor: actor,
        ...(mode === "missing-origin" ? {} : { transactionOrigin: origin }),
        verifiedActors: { "self-burn-test-probe": probe }, simulator: transport,
        provider: { call: async () => { fallbackReads++; throw new Error("unexpected view fallback"); },
          getCode: async () => { fallbackReads++; throw new Error("unexpected code read"); },
          getStorage: async () => { fallbackReads++; throw new Error("unexpected storage read"); } },
        generationFence: { assertCurrent(g, s) { assert.equal(g, currentGeneration); assert.deepEqual(s, source); } } });
      const work = await executeAdapterWork({ runtime, control: { signal: controller.signal, deadlineAtMs }, intent: {
        stage: "exact-refine", familyId: SELF_BURN_NATIVE_FAMILY_ID, instanceKey: descriptor.instanceKey, routeKey: route.routeKey,
        source, generation: source.generation, programInput: { ...input, amountIn },
        program: { requirements: selfBurnProgram.requirements, buildRequests: selfBurnProgram.buildRequests,
          decode({ programInput, results }) { decoded++; return selfBurnProgram.decode({ programInput, initialResults: results, dependentEvidence: [] }); } },
      } });
      if (mode === "success") {
        assert.equal(work.status, "resolved"); assert(work.status === "resolved");
        const quote = work.executed.evidence;
        assert.equal(quote.amountOut, amountOut); assert.equal(quote.evidence.amountIn, amountIn);
        assert.deepEqual(quote.evidence.source, source);
        const fragment = selfBurnNativeStrictFamilyPlugin.execution.buildFragment({ descriptor, route,
          amountIn, quotedAmountOut: quote.amountOut, minAmountOut: quote.amountOut,
          exactEvidence: quote.evidence, executor: actor, runtimeEvidence: [] });
        assert.deepEqual(fragment.nodes.map(node => node.amount), [amountIn, amountOut]);
        assert.equal(decoded, 1);
      } else {
        assert.equal(work.status, "unresolved", mode);
        assert.equal(decoded, mode === "false-return" || mode === "malformed-return" || mode === "zero-payout" ? 1 : 0, mode);
      }
      assert.equal(dispatched, mode === "missing-origin" ? 0 : 1, mode);
      assert.equal(validatedRequests, dispatched, "fail-closed transport must not hide test assertion failures");
      assert.equal(fallbackReads, 0, mode);
      assert.equal(fatal, mode === "source-mismatch" || mode === "wrong-account" || mode === "missing-effects" ? 1 : 0, mode);
    } finally { Date.now = now; }
  }
}

async function verifyEtherTokenNativeEffects(): Promise<void> {
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
  const method = etherTokenNativeRedeemExact.methods().find(m => m.kind === "request-program");
  assert(method && method.kind === "request-program");
  assert("chainAmountQuote" in method && method.chainAmountQuote === true,
    "EtherToken's existing effect method must explicitly declare chain amount quoting");
  assert(!("reusePolicy" in method), "chain provenance is not a cross-block carry policy");
  const etherTokenProgram = method.program;
  for (const amountIn of [1n, 137n, 10n ** 18n, (1n << 128n) + 37n]) {
    const programInput = Object.freeze({ ...input, amountIn });
    const requests = etherTokenProgram.buildRequests(programInput);
    assert.equal(requests.length, 1);
    const [request] = requests;
    assert(request.kind === "effect-delta-simulation");
    assert.equal(request.call.executionMode, "impersonated-call-frame");
    assert.deepEqual(request.call.caller, { kind: "executor" });
    assert.equal(request.call.to, tokenB);
    assert.equal(request.overrideIntent.caller, request.call.caller);
    assert.deepEqual(request.overrideIntent.tokenBalances, [{ token: tokenB, amount: amountIn }]);
    assert.deepEqual(request.observeTokenBalances, [{ token: tokenB, account: request.call.caller }]);
    assert(Object.isFrozen(request.observeTokenBalances) && request.observeTokenBalances?.every(Object.isFrozen));
    assert.deepEqual(request.observe, ["return-data", "token-delta", "native-delta", "total-supply-delta", "logs"]);
    assert.equal(BigInt(ETHERTOKEN_NATIVE_INTERFACE.decodeFunctionData(
      "withdraw", request.call.data,
    )[0]), amountIn);
    // withdraw has no return values: empty successful bytes are valid, but
    // amountOut still requires all three observed effects at this exact input.
    const effects = nativeEffects(tokenB, actor, amountIn, amountIn);
    const result = ok("exact-withdraw", "0x", effects);
    const decode = (item: AdapterRequestResult) => etherTokenProgram.decode({
      programInput, initialResults: [item], dependentEvidence: [],
    });
    const quote = decode(result);
    assert.equal(quote.amountOut, amountIn);
    assert.equal(quote.evidence.amountIn, amountIn);
    assert.equal(quote.evidence.amountOut, amountIn);
    assert.equal(quote.evidence.executor, actor);
    assert.deepEqual(quote.evidence.source, source);
    const executionInput = { descriptor, route, amountIn, quotedAmountOut: amountIn,
      minAmountOut: amountIn, exactEvidence: quote.evidence, executor: actor, runtimeEvidence: [] };
    const fragment = etherTokenNativeRedeemStrictFamilyPlugin.execution.buildFragment(executionInput);
    assert.deepEqual(fragment.nodes.map(node => [node.adapterId, node.target, node.amount]), [
      ["ethertoken-native-redeem", tokenB, amountIn], ["weth-deposit-value", ADDR.WETH, amountIn],
    ]);
    for (const exactEvidence of [
      { ...quote.evidence, amountIn: amountIn + 1n }, { ...quote.evidence, amountOut: amountIn + 1n },
      { ...quote.evidence, token: tokenC }, { ...quote.evidence, executor: router },
      { ...quote.evidence, bindingFingerprint: "wrong-binding" },
    ]) assert.throws(() => etherTokenNativeRedeemStrictFamilyPlugin.execution.buildFragment({
      ...executionInput, exactEvidence,
    }), /incompatible exact evidence/);
    const wrongEffects: ObservedEffects[] = [
      {}, { ...effects, tokenDeltas: [] },
      { ...effects, tokenDeltas: [{ token: tokenB, account: actor, delta: -amountIn + 1n }] },
      { ...effects, tokenDeltas: [{ token: tokenC, account: actor, delta: -amountIn }] },
      { ...effects, tokenDeltas: [{ token: tokenB, account: router, delta: -amountIn }] },
      { ...effects, totalSupplyDeltas: [] },
      { ...effects, totalSupplyDeltas: [{ token: tokenB, delta: -amountIn + 1n }] },
      { ...effects, totalSupplyDeltas: [{ token: tokenC, delta: -amountIn }] },
      { ...effects, nativeDeltas: [] },
      ...[0n, -amountIn, amountIn + 1n].map(delta => ({ ...effects, nativeDeltas: [{ account: actor, delta }] })),
      { ...effects, nativeDeltas: [{ account: router, delta: amountIn }] },
    ];
    for (const invalid of wrongEffects) assert.throws(() => decode({ ...result, effects: invalid }), /effect invariants/);
    for (const changedSource of [{ ...source, number: source.number - 1 },
      { ...source, hash: `0x${"12".repeat(32)}` }, { ...source, generation: source.generation + 1 }]) {
      assert.throws(() => decode({ ...result, source: changedSource }), /source/);
    }
    assert.throws(() => decode({ ...result, completion: "reverted-as-declared" }), /did not return/);
    assert.throws(() => decode({ ...result, data: "not-hex" }));
    assert.throws(() => etherTokenProgram.decode({ programInput, initialResults: [], dependentEvidence: [] }), /missing/);
    for (const failure of ["rpc", "deadline", "aborted", "resource-limited"] as const) {
      assert.throws(() => decode({ id: "exact-withdraw", ok: false, source, failure }), /unresolved/);
    }
  }
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

  // The same builder is used by identity probing and Exact. Never substitute
  // the historical probe address for the caller supplied by either path.
  for (const callerRef of [{ kind: "executor" },
    { kind: "verified-actor", evidenceId: "ethertoken-test-probe" }] satisfies CallerRef[]) {
    const request = etherTokenWithdrawalSimulation({ id: "symbolic-withdraw", token: tokenB,
      actor, callerRef, amountIn: 137n });
    assert(request.kind === "effect-delta-simulation");
    assert.equal(request.call.caller, callerRef); assert.equal(request.overrideIntent.caller, callerRef);
    assert.equal(request.observeTokenBalances?.[0].account, callerRef);
  }
  const zero = { ...input, amountIn: 0n };
  assert.deepEqual(etherTokenProgram.requirements(zero), { transports: [] });
  assert.deepEqual(etherTokenProgram.buildRequests(zero), []);
  assert.equal(etherTokenProgram.decode({ programInput: zero, initialResults: [], dependentEvidence: [] }).amountOut, 0n);
  const local = etherTokenNativeRedeemExact.methods()[0]; assert(local.kind === "local");
  assert.equal(local.quote(zero).status, "quoted"); assert.equal(local.quote(input).status, "not-applicable");
  assert.throws(() => etherTokenProgram.buildRequests({ ...input, amountIn: -1n }), /negative/);
  assert.throws(() => etherTokenProgram.buildRequests({ ...input, route: { ...route, tokenOut: tokenC } }), /incompatible/);

  // Exercise central issuance and the real typed transport without RPC/child
  // processes. Native/supply scopes derive from the declared effects, while
  // the token/account observation is the Family's explicit sparse pair.
  const pin = { chainId: 1, blockHash: source.hash, stateRoot: `0x${"13".repeat(32)}` };
  const rpcUrl = "http://127.0.0.1:1/not-opened-ethertoken-test", origin = router, probe = tokenC;
  const amountIn = (1n << 100n) + 137n;
  for (const mode of ["success", "revert", "source-mismatch", "wrong-account", "wrong-payout",
    "missing-origin", "cancelled", "deadline"] as const) {
    let dispatched = 0, validatedRequests = 0, decoded = 0, fatal = 0, fallbackReads = 0;
    const controller = new AbortController();
    const now = Date.now;
    let clock = now();
    // Deterministic deadline crossing inside the async response, not a sleep.
    const deadlineAtMs = clock + 60_000;
    if (mode === "deadline") Date.now = () => clock;
    try {
      const transport = createRevmStrictSimulationTransport({ rpcUrl, executionGasLimit: 1_000_000,
        onFatal() { fatal++; }, leaseFor: async requested => {
          assert.deepEqual(requested, source);
          return { source, sourcePin: pin, closeAndDrain: async () => {},
            strictSimulate: async (request: StrictSimulateRequest, control): Promise<DaemonResponse> => {
              dispatched++;
              assert.equal(control?.signal, controller.signal); assert.equal(control?.deadlineAtMs, deadlineAtMs);
              assert.equal(request.from, actor.toLowerCase()); assert.equal(request.transactionOrigin, origin.toLowerCase());
              assert.equal(request.callerMode, "impersonated-call-frame"); assert.equal(request.rpcUrl, rpcUrl);
              assert.equal(request.to, tokenB.toLowerCase()); assert.equal(request.blockNumber, source.number);
              assert.equal(BigInt(ETHERTOKEN_NATIVE_INTERFACE.decodeFunctionData("withdraw", request.data)[0]), amountIn);
              assert.deepEqual(request.tokenDeals, [{ token: tokenB.toLowerCase(), to: actor.toLowerCase(), amount: amountIn.toString() }]);
              assert.deepEqual(request.sourcePin, pin);
              assert.deepEqual(request.observeTokenBalances, [{ token: tokenB.toLowerCase(), account: actor.toLowerCase() }]);
              assert.deepEqual(request.observeNativeBalances, [actor.toLowerCase()]);
              assert.deepEqual(request.observeTotalSupply, [tokenB.toLowerCase()]);
              validatedRequests++;
              const output = mode === "revert" ? "0x1234" : "0x";
              const nativeOut = mode === "wrong-payout" ? amountIn - 1n : amountIn;
              if (mode === "cancelled") controller.abort();
              if (mode === "deadline") clock = deadlineAtMs;
              return { ok: true, success: mode !== "revert", latencyMs: 0, output, gasUsed: "21000",
                ...(mode === "revert" ? { revertReason: output } : {}),
                sourceAttestation: { kind: "node-attested", ...pin, blockNumber: source.number,
                  stateRoot: mode === "source-mismatch" ? `0x${"14".repeat(32)}` : pin.stateRoot, parentHash: `0x${"15".repeat(32)}` },
                strict: { outcome: { kind: mode === "revert" ? "Revert" : "Success", phase: "main", output }, executionGasUsed: "21000",
                  logs: [], tokenDeltas: mode === "revert" ? [] : [{ token: tokenB.toLowerCase(),
                    account: mode === "wrong-account" ? probe.toLowerCase() : actor.toLowerCase(), delta: (-amountIn).toString() }],
                  nativeDeltas: mode === "revert" ? [] : [{ account: actor.toLowerCase(), before: "0", after: nativeOut.toString(), delta: nativeOut.toString() }],
                  totalSupplyDeltas: mode === "revert" ? [] : [{ token: tokenB.toLowerCase(), delta: (-amountIn).toString() }] } };
            } };
        } });
      const runtime = createStrictCentralAdapterRuntime({ executor: actor,
        ...(mode === "missing-origin" ? {} : { transactionOrigin: origin }),
        verifiedActors: { "ethertoken-test-probe": probe }, simulator: transport,
        provider: { call: async () => { fallbackReads++; throw new Error("unexpected view fallback"); },
          getCode: async () => { fallbackReads++; throw new Error("unexpected code read"); },
          getStorage: async () => { fallbackReads++; throw new Error("unexpected storage read"); } },
        generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); } } });
      const work = await executeAdapterWork({ runtime, control: { signal: controller.signal, deadlineAtMs }, intent: {
        stage: "exact-refine", familyId: ETHERTOKEN_NATIVE_FAMILY_ID, instanceKey: descriptor.instanceKey, routeKey: route.routeKey,
        source, generation: source.generation, programInput: { ...input, amountIn },
        program: { requirements: etherTokenProgram.requirements, buildRequests: etherTokenProgram.buildRequests,
          decode({ programInput, results }) { decoded++; return etherTokenProgram.decode({ programInput, initialResults: results, dependentEvidence: [] }); } },
      } });
      if (mode === "success") {
        assert.equal(work.status, "resolved"); assert(work.status === "resolved");
        assert.equal(work.executed.evidence.amountOut, amountIn);
        assert.equal(work.executed.evidence.evidence.amountIn, amountIn);
        assert.deepEqual(work.executed.evidence.evidence.source, source);
        assert.equal(decoded, 1);
      } else {
        assert.equal(work.status, "unresolved", mode);
        assert.equal(decoded, mode === "wrong-payout" ? 1 : 0, mode);
      }
      assert.equal(dispatched, mode === "missing-origin" ? 0 : 1, mode);
      assert.equal(validatedRequests, dispatched, "fail-closed transport must not hide test assertion failures");
      assert.equal(fallbackReads, 0, mode);
      assert.equal(fatal, mode === "source-mismatch" || mode === "wrong-account" ? 1 : 0, mode);
    } finally { Date.now = now; }
  }
}

async function verifySiloDependentCurrentAndEffects(): Promise<void> {
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

  const method = erc4626SiloRedeemExact.methods().find(m => m.kind === "request-program");
  assert(method && method.kind === "request-program");
  assert("chainAmountQuote" in method && method.chainAmountQuote === true,
    "Silo's existing effect method must explicitly declare chain amount quoting");
  assert(!("reusePolicy" in method), "chain provenance is not a cross-block carry policy");
  const program = method.program;
  for (const amountIn of [1n, 137n, (1n << 128n) + 37n]) {
    const input = Object.freeze({ ...exactInput, amountIn });
    const requests = program.buildRequests(input);
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert(request.kind === "effect-delta-simulation");
    assert.equal(request.call.executionMode, "impersonated-call-frame");
    assert.deepEqual(request.call.caller, { kind: "executor" });
    assert.equal(request.call.to, tokenA);
    assert.deepEqual([...ERC4626_SILO_INTERFACE.decodeFunctionData("redeem", request.call.data)],
      [tokenB, amountIn, actor, actor]);
    assert.equal(request.overrideIntent.caller, request.call.caller);
    assert.deepEqual(request.overrideIntent.tokenBalances, [{ token: tokenA, amount: amountIn }]);
    assert.deepEqual(request.observeTokenBalances, [
      { token: tokenA, account: request.call.caller },
      { token: tokenB, account: request.call.caller },
    ]);
    assert(Object.isFrozen(request.observeTokenBalances) && request.observeTokenBalances?.every(Object.isFrozen));
    // Deliberately not the pricing fixture's unit ratio or a rescaled probe.
    const amountOut = amountIn / 3n + 19n;
    const effects: ObservedEffects = {
      tokenDeltas: [{ token: tokenA, account: actor, delta: -amountIn }, { token: tokenB, account: actor, delta: amountOut }],
      totalSupplyDeltas: [{ token: tokenA, delta: -amountIn }],
    };
    const result = ok("exact-active-redeem", ERC4626_SILO_INTERFACE.encodeFunctionResult("redeem", [amountOut]), effects);
    const decode = (item: AdapterRequestResult) => program.decode({ programInput: input, initialResults: [item], dependentEvidence: [] });
    const quote = decode(result);
    assert.equal(quote.amountOut, amountOut);
    assert.equal(quote.evidence.amountIn, amountIn);
    assert.equal(quote.evidence.amountOut, amountOut);
    assert.deepEqual(quote.evidence.source, source);
    const fragment = erc4626SiloRedeemStrictFamilyPlugin.execution.buildFragment({
      descriptor, route, amountIn, quotedAmountOut: amountOut, exactEvidence: quote.evidence, executor: actor,
      minAmountOut: amountOut, runtimeEvidence: [],
    });
    assert.equal(fragment.nodes[0].amount, amountIn, "normal execution retains the gross original input");
    const wrongEffects: ObservedEffects[] = [
      {}, { ...effects, tokenDeltas: effects.tokenDeltas!.slice(0, 1) },
      { ...effects, tokenDeltas: effects.tokenDeltas!.slice(1) },
      { ...effects, tokenDeltas: [{ token: tokenA, account: actor, delta: -amountIn + 1n }, effects.tokenDeltas![1]] },
      { ...effects, tokenDeltas: [effects.tokenDeltas![0], { token: tokenB, account: actor, delta: amountOut + 1n }] },
      { ...effects, tokenDeltas: [effects.tokenDeltas![0], { token: tokenB, account: router, delta: amountOut }] },
      { ...effects, totalSupplyDeltas: [] },
      { ...effects, totalSupplyDeltas: [{ token: tokenA, delta: -amountIn + 1n }] },
      { ...effects, totalSupplyDeltas: [{ token: tokenB, delta: -amountIn }] },
    ];
    for (const invalid of wrongEffects) assert.throws(() => decode({ ...result, effects: invalid }), /effect invariants/);
    for (const changedSource of [{ ...source, number: source.number - 1 }, { ...source, hash: `0x${"12".repeat(32)}` },
      { ...source, generation: source.generation + 1 }]) assert.throws(() => decode({ ...result, source: changedSource }), /source/);
    assert.throws(() => decode({ ...result, completion: "reverted-as-declared" }), /did not return/);
    assert.throws(() => decode({ ...result, data: "0x" }));
    assert.throws(() => decode({ ...result, data: ERC4626_SILO_INTERFACE.encodeFunctionResult("redeem", [0n]) }), /effect invariants/);
    assert.throws(() => program.decode({ programInput: input, initialResults: [], dependentEvidence: [] }), /missing/);
  }
  // Identity and Exact share the builder. Both observations must retain the
  // supplied symbolic authority rather than freeze the probe's address into it.
  for (const callerRef of [{ kind: "executor" }, { kind: "verified-actor", evidenceId: "silo-test-probe" }] satisfies CallerRef[]) {
    const request = erc4626SiloRedeemSimulation({ id: "symbolic-silo", vault: tokenA, payoutToken: tokenB,
      actor, callerRef, amountIn: 137n });
    assert(request.kind === "effect-delta-simulation");
    assert.equal(request.call.caller, callerRef); assert.equal(request.overrideIntent.caller, callerRef);
    assert(request.observeTokenBalances?.every(pair => pair.account === callerRef));
  }
  const zero = { ...exactInput, amountIn: 0n };
  assert.deepEqual(program.buildRequests(zero), []);
  assert.deepEqual(program.requirements(zero), { transports: [] });
  assert.equal(program.decode({ programInput: zero, initialResults: [], dependentEvidence: [] }).amountOut, 0n);
  const local = erc4626SiloRedeemExact.methods()[0]; assert(local.kind === "local");
  assert.equal(local.quote(zero).status, "quoted"); assert.equal(local.quote(exactInput).status, "not-applicable");
  assert.throws(() => program.buildRequests({ ...exactInput, amountIn: -1n }), /negative/);
  assert.throws(() => program.buildRequests({ ...exactInput, route: { ...route, tokenOut: tokenC } }), /incompatible/);

  // Actual central issuance + approved typed transport, with an injected lease:
  // no RPC or child, and no construction-time/per-protocol caller inference.
  const pin = { chainId: 1, blockHash: source.hash, stateRoot: `0x${"13".repeat(32)}` };
  const rpcUrl = "http://127.0.0.1:1/not-opened-silo-test", origin = router;
  const amountIn = (1n << 100n) + 137n, amountOut = 71n;
  for (const mode of ["success", "revert", "source-mismatch", "missing-origin", "cancelled"] as const) {
    let dispatched = 0, decoded = 0, fatal = 0;
    const controller = new AbortController();
    const transport = createRevmStrictSimulationTransport({ rpcUrl, executionGasLimit: 1_000_000,
      onFatal() { fatal++; }, leaseFor: async requested => {
        assert.deepEqual(requested, source);
        return { source, sourcePin: pin, closeAndDrain: async () => {},
          strictSimulate: async (request: StrictSimulateRequest): Promise<DaemonResponse> => {
            dispatched++;
            assert.equal(request.from, actor.toLowerCase()); assert.equal(request.transactionOrigin, origin.toLowerCase());
            assert.equal(request.callerMode, "impersonated-call-frame"); assert.equal(request.rpcUrl, rpcUrl);
            assert.equal(request.tokenDeals![0].amount, amountIn.toString()); assert.deepEqual(request.sourcePin, pin);
            assert.deepEqual(request.observeTokenBalances, [
              { token: tokenA.toLowerCase(), account: actor.toLowerCase() }, { token: tokenB.toLowerCase(), account: actor.toLowerCase() },
            ]);
            const output = mode === "revert" ? "0x1234" : ERC4626_SILO_INTERFACE.encodeFunctionResult("redeem", [amountOut]);
            if (mode === "cancelled") controller.abort();
            return { ok: true, success: mode !== "revert", latencyMs: 0, output, gasUsed: "21000",
              ...(mode === "revert" ? { revertReason: output } : {}),
              sourceAttestation: { kind: "node-attested", ...pin, blockNumber: source.number,
                stateRoot: mode === "source-mismatch" ? `0x${"14".repeat(32)}` : pin.stateRoot, parentHash: `0x${"15".repeat(32)}` },
              strict: { outcome: { kind: mode === "revert" ? "Revert" : "Success", phase: "main", output }, executionGasUsed: "21000",
                nativeDeltas: [], logs: [], tokenDeltas: mode === "revert" ? [] : [
                  { token: tokenA.toLowerCase(), account: actor.toLowerCase(), delta: (-amountIn).toString() },
                  { token: tokenB.toLowerCase(), account: actor.toLowerCase(), delta: amountOut.toString() },
                ], totalSupplyDeltas: mode === "revert" ? [] : [{ token: tokenA.toLowerCase(), delta: (-amountIn).toString() }] } };
          } };
      } });
    const runtime = createStrictCentralAdapterRuntime({ executor: actor,
      ...(mode === "missing-origin" ? {} : { transactionOrigin: origin }), simulator: transport,
      provider: { call: async () => { throw new Error("unexpected view fallback"); },
        getCode: async () => { throw new Error("unexpected code read"); }, getStorage: async () => { throw new Error("unexpected storage read"); } },
      generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); } } });
    const input = { ...exactInput, amountIn };
    const work = await executeAdapterWork({ runtime, control: { signal: controller.signal }, intent: {
      stage: "exact-refine", familyId: ERC4626_SILO_REDEEM_FAMILY_ID, instanceKey: descriptor.instanceKey, routeKey: route.routeKey,
      source, generation: source.generation, programInput: input,
      program: { requirements: program.requirements, buildRequests: program.buildRequests,
        decode({ programInput, results }) { decoded++; return program.decode({ programInput, initialResults: results, dependentEvidence: [] }); } },
    } });
    if (mode === "success") {
      assert.equal(work.status, "resolved"); assert(work.status === "resolved");
      assert.equal(work.executed.evidence.amountOut, amountOut); assert.equal(work.executed.evidence.evidence.amountIn, amountIn);
      assert.equal(dispatched, 1); assert.equal(decoded, 1);
    } else {
      assert.equal(work.status, "unresolved", mode); assert.equal(decoded, 0);
      if (mode === "missing-origin") assert.equal(dispatched, 0);
    }
    assert.equal(fatal > 0, mode === "source-mismatch");
  }
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
