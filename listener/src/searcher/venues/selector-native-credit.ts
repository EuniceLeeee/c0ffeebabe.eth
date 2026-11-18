import { FunctionFragment, Interface, MaxUint256, getAddress, hexlify } from "ethers";
import type { FamilyPlugin } from "./adapter-family-plugin.js";
import { createCreditCaptureMaterialization } from "./capture-materialization.js";
import { compileDeclarativeCreditDomain } from "./declarative-credit-domain.js";
import { assertDeclarativeExecutionSource, buildDeclarativeExecutionProgram, createDeclarativeProgramAction } from "./declarative-execution.js";
import { compileDeclarativeReadFlow } from "./declarative-read-flow.js";
import { projectDeclarativePrices, validateDeclarativePricingProjection } from "./declarative-pricing-projection.js";
import { compileSelectorNativeExecutionFamily } from "./selector-native-family.js";
import { createSelectorNativeRuntime, type SelectorNativeBindingProof } from "./selector-native-runtime.js";
import { freezeSelectorNative } from "./selector-native-definition.js";
import { normalizeSelectorNativeCreditDefinition, selectorNativeCreditExecutionDefinition, compileSelectorNativeCreditDiscovery } from "./selector-native-credit-definition.js";
import { assertSource } from "./selector-execution-evidence.js";

type Data = Record<string, any>;
const same = (a: string, b: string) => getAddress(a) === getAddress(b);
const at = (value: any, path: readonly number[]): any => path.reduce((row, index) => row?.[index], value);
const deeplyFrozen = (value: any, seen = new WeakSet<object>()): boolean => {
  if (!value || typeof value !== "object" || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(Object.getOwnPropertyDescriptors(value))
    .every(descriptor => "value" in descriptor && deeplyFrozen(descriptor.value, seen));
};

/** One generic selector compiler for standing-position entries. The declaration
 * owns reads and arithmetic; the existing Credit issuer owns evidence and the
 * final position/repayment gate. No protocol implementation is loaded here. */
export function compileSelectorNativeCreditFamily(raw: unknown): FamilyPlugin<"credit"> {
  const definition = normalizeSelectorNativeCreditDefinition(raw), executionDefinition = selectorNativeCreditExecutionDefinition(definition);
  validateDeclarativePricingProjection(definition.pricing.projection);
  const base = compileSelectorNativeExecutionFamily(executionDefinition) as any;
  const projection = compileSelectorNativeCreditDiscovery(definition), familyId = projection.manifest.familyId;
  const runtime = createSelectorNativeRuntime(executionDefinition, executionDefinition.programs[0]!);
  const policy = definition.credit.risk.proof, fn = FunctionFragment.from(policy.signature), abi = new Interface([fn]);
  if (fn.selector !== definition.selector || fn.format("sighash") !== FunctionFragment.from(definition.signature).format("sighash"))
    throw new Error("Credit position proof must bind the declared entry ABI");
  const checked = new WeakSet<object>();

  function assertActiveBinding(descriptor: Data): void {
    if (checked.has(descriptor)) return;
    const proof = descriptor.proof as SelectorNativeBindingProof;
    const routes = base.routes.project({ descriptor }) as readonly Data[];
    if (routes.length !== 1 || routes[0]!.taxonomy.slotKind !== "lend") throw new Error("Credit requires one standing-position direction");
    const route = routes[0]!, actor = proof.executor;
    let prior: SelectorNativeBindingProof | undefined, active = 0;
    for (const results of proof.rounds) {
      const step = runtime.step({ candidate: descriptor.candidate, source: proof.source, executor: actor,
        transactionOrigin: proof.transactionOrigin, executionRoundingRawUnits: proof.executionRoundingRawUnits, evidence: prior });
      for (const request of step.requests) {
        if ((request.kind !== "effect-delta-simulation" && request.kind !== "state-override-simulation") ||
            request.call.data.slice(0, 10).toLowerCase() !== definition.selector) continue;
        const result = results.find(row => row.id === request.id);
        if (!result?.ok || result.completion !== "returned" || !result.provenance?.fingerprint ||
            request.call.caller.kind !== "executor" || request.overrideIntent.caller.kind !== "executor" ||
            !same(request.call.to, descriptor.target) || !request.observe.includes("return-data") || !request.observe.includes("token-delta"))
          throw new Error("Credit Ready requires an issuer-bound active position result");
        assertSource(result.source, proof.source);
        if (proof.transactionOrigin === undefined ? request.call.executionMode !== undefined && request.call.executionMode !== "top-level"
          : request.call.executionMode !== "impersonated-call-frame") throw new Error("Credit Ready actor mode changed");
        const args = abi.decodeFunctionData(fn, request.call.data), output = abi.decodeFunctionResult(fn, result.data);
        const collateral = at(args, policy.call.collateral), debt = at(args, policy.call.debt), position = at(output, policy.returns.position);
        if (abi.encodeFunctionData(fn, args).toLowerCase() !== request.call.data.toLowerCase() ||
            abi.encodeFunctionResult(fn, output).toLowerCase() !== result.data.toLowerCase() ||
            at(args, policy.call.position) !== 0n || typeof collateral !== "bigint" || collateral <= 0n ||
            typeof debt !== "bigint" || debt <= 0n || typeof position !== "bigint" || position <= 0n ||
            at(output, policy.returns.collateral) !== collateral || at(output, policy.returns.debt) !== debt ||
            !same(at(args, policy.call.recipient), actor)) throw new Error("Credit Ready position/amount/recipient mismatch");
        const balances = request.overrideIntent.tokenBalances;
        if (request.overrideIntent.nativeBalanceWei !== undefined || balances?.length !== 1 ||
            !same(balances[0]!.token, route.tokenIn) || balances[0]!.amount !== collateral)
          throw new Error("Credit Ready collateral preparation mismatch");
        for (const [token, delta] of [[route.tokenIn, -collateral], [route.tokenOut, debt]] as const) {
          const rows = result.effects?.tokenDeltas?.filter(row => same(row.token, token) && same(row.account, actor));
          if (!request.observeTokenBalances?.some(row => same(row.token, token) && typeof row.account !== "string" && row.account.kind === "executor") ||
              rows?.length !== 1 || rows[0]!.delta !== delta) throw new Error("Credit Ready actual collateral/debt effects mismatch");
        }
        active++;
      }
      prior = step.decode(results);
    }
    if (!active || prior?.stage !== "complete") throw new Error("Credit Ready lacks a complete active position proof");
    if (deeplyFrozen(descriptor)) checked.add(descriptor);
  }
  function mapped(input: Data): Data {
    assertActiveBinding(input.descriptor);
    base.routes.projectGraph({ descriptor: input.descriptor, route: input.route });
    const proof = input.descriptor.proof;
    if (input.executor !== undefined && (!same(input.executor, proof.executor) ||
        input.transactionOrigin?.toLowerCase() !== proof.transactionOrigin?.toLowerCase())) throw new Error("Credit execution actor differs from Ready binding");
    const inner = input.descriptor.bound.innerRoutes.find((route: Data) => route.direction === input.route.direction);
    if (!inner) throw new Error("Credit direction binding changed");
    return { ...input, candidate: input.descriptor.candidate, scope: input.descriptor.candidate.scope,
      args: input.descriptor.bound.arguments, arguments: input.descriptor.bound.arguments,
      descriptor: { ...input.descriptor.bound.descriptor, instanceKey: input.descriptor.instanceKey },
      route: { ...inner, ...input.route } };
  }
  const credit = compileDeclarativeCreditDomain(definition.credit, runtime.values, {
    assertInvocation: input => { mapped(input); }, environment: input => runtime.environment(mapped(input)),
  });
  const flow = compileDeclarativeReadFlow(definition.pricing.flow, runtime.values);
  function pricingEnvironment(input: Data): Data {
    const descriptor = input.descriptor.instance, routes = input.routes ?? input.descriptor.routes;
    if (!Array.isArray(routes) || routes.length !== 1) throw new Error("Credit pricing requires one bound direction");
    return runtime.environment({ ...mapped({ ...input, descriptor, route: routes[0] }), routes });
  }
  const current = {
    requirements: (input: Data) => flow.program.requirements(pricingEnvironment(input) as any),
    buildRequests: (input: Data) => flow.program.buildRequests(pricingEnvironment(input) as any),
    buildDependentProgram(input: Data) {
      return flow.program.buildDependentProgram!({ programInput: pricingEnvironment(input.current) as any,
        completedRound: input.completedRound, initialResults: input.initialResults, priorEvidence: input.priorEvidence });
    },
    decodeSnapshot(input: Data) {
      if (!input.initialResults.length) throw new Error("Credit pricing requires issuer source observations");
      const source = input.initialResults[0].source;
      assertDeclarativeExecutionSource(source);
      input.initialResults.forEach((result: Data) => assertSource(result.source, source));
      const env = pricingEnvironment({ ...input, source });
      const snapshot = flow.complete(env as any, input.initialResults, input.dependentEvidence).decode() as Data;
      assertSource(snapshot.source, source);
      runtime.values.run(definition.pricing.projection.checks, { ...env, snapshot });
      return freezeSelectorNative(snapshot);
    },
    deriveMids(input: Data) {
      const env = pricingEnvironment(input);
      runtime.values.run(definition.pricing.projection.checks, env);
      const mids = projectDeclarativePrices({ domain: "protocol", routes: input.routes, unavailable: new Map(),
        rows: runtime.values.evaluate(definition.pricing.projection.rows, env) });
      return new Map([...mids].map(([key, mid]) => [key, { ...mid,
        edges: mid.edges?.map(edge => ({ ...edge, edgeKind: "credit", leavesStandingPosition: true })) }]));
    },
  };
  const actionId = `${familyId}:call`, action = createDeclarativeProgramAction({ adapterId: actionId,
    lineage: `custom-credit:${familyId}`, edgeKind: "credit", action: "borrow", canSendValue: false,
    leavesStandingPositionDefault: true } as any, [{ signature: definition.signature }]);
  const { protocol: _protocol, ...shared } = base;
  return { ...shared, manifest: projection.manifest,
    capture: createCreditCaptureMaterialization({ familyId, discovery: base.discovery }),
    identity: { ...base.identity, variants: base.identity.variants.map((variant: Data) => ({ ...variant,
      decide(input: Data) { const decision = variant.decide(input); if (decision.status === "verified") assertActiveBinding(decision.identity.descriptor); return decision; } })) },
    routes: { ...base.routes, projectGraph(input: Data) {
      assertActiveBinding(input.descriptor);
      const { executionVerification: _verification, ...graph } = base.routes.projectGraph(input);
      return graph;
    } },
    pricing: { ...base.pricing, refreshPolicy: "each-block", current,
      ...(definition.pricing.liveState === undefined ? {} : { liveStateProjection: { project: (input: Data) =>
        freezeSelectorNative(runtime.values.evaluate(definition.pricing.liveState, pricingEnvironment(input))) } }) },
    exact: { methods(input: Data) { mapped(input); return []; },
      cacheCompatibilityProjection(input: Data) { mapped(input); return [input.descriptor.bindingFingerprint, "credit-risk-proof"]; } },
    execution: { runtimeProjection: () => ({ allowanceSpender: null, prewarmQuoteCalls: [] }),
      buildFragment(input: Data) {
        const env = mapped(input), evidence = input.exactEvidence;
        if (!credit.verifyExecutionEvidence(input, evidence)) throw new Error("Credit execution requires issuer-bound risk proof");
        if (input.amountIn <= 0n || input.amountIn > MaxUint256 || input.quotedAmountOut <= 0n || input.quotedAmountOut > MaxUint256 ||
            input.minAmountOut <= 0n || input.minAmountOut > input.quotedAmountOut) throw new Error("Credit execution amount bounds");
        if (input.settlement?.kind === "direct") throw new Error("Credit position execution must settle with its bound executor");
        const program = buildDeclarativeExecutionProgram(runtime.execution(input.descriptor.candidate), runtime.environment({ ...env,
          source: evidence.source, recipient: input.executor, settlementRequested: false, creditQuote: { amountOut: input.quotedAmountOut } }), runtime.values);
        return { requirements: [], nodes: [{ adapterId: actionId, target: input.route.target,
          tokenIn: input.route.tokenIn, tokenOut: input.route.tokenOut, amount: input.amountIn,
          params: { runtimeAmountProgram: hexlify(program.bytes()) }, children: [] }] };
      },
      expectedEffects(input: Data) { mapped(input); return [
        { kind: "token-delta", token: input.route.tokenIn, account: "executor", direction: "decrease" },
        { kind: "token-delta", token: input.route.tokenOut, account: "executor", direction: "increase" },
      ]; } },
    credit: credit.definition, actionAdapters: [action],
  } as FamilyPlugin<"credit">;
}
