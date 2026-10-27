import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, toBeHex, ZeroAddress } from "ethers";
import { createDeclarativeProtocolRuntime } from "../venues/declarative-protocol.js";
import root from "../venues/protocols/erc4626-family/erc4626.json";
import custodian from "../venues/protocols/erc4626-family/custodian.json";
import infinifi from "../venues/protocols/erc4626-family/infinifi.json";

// Synthetic declarations/descriptors test the common compiler's boundaries.
// These are neither chain identity evidence nor a historical execution claim.
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const address = (n: number) => getAddress(toBeHex(n, 20));
const source = { number: 100, hash: toBeHex(100, 32), generation: 1 };
const executor = address(91), recipient = address(92);
const makeRuntime = (definition: any = clone(root)) =>
  createDeclarativeProtocolRuntime(definition, [clone(custodian), clone(infinifi)]);
type Runtime = ReturnType<typeof makeRuntime>;

function fixture(runtime: Runtime, variant: "standard" | "custodian" | "infinifi" = "standard") {
  const selected = variant === "standard" ? runtime.variants[0]!
    : runtime.variants.find(v => v.document.id === (variant === "custodian" ? custodian.id : infinifi.id))!;
  const vault = address(1), asset = address(2), share = variant === "custodian" ? address(3) : vault;
  const descriptor: any = {
    familyId: root.scope.family, lineageId: selected.document.lineageId,
    instanceKey: vault.toLowerCase(), vault, asset, share,
    verifiedDirections: { deposit: true, redeem: true }, runtimeRequirements: [],
  };
  if (variant === "custodian") descriptor.custodian = {
    proofSource: source, proxyCodeHash: toBeHex(10, 32), proxyAdmin: address(4), implementation: address(5),
    share, asset, shareDecimals: 18, assetDecimals: 6,
    shareCodeHash: toBeHex(11, 32), assetCodeHash: toBeHex(12, 32),
  };
  if (variant === "infinifi") descriptor.infinifi = {
    proofSource: source, vault, asset,
    gateway: selected.values.evaluate("$constants.gateway", {}),
    core: address(6), yieldSharing: address(7), gatewayImplementation: address(8), yieldSharingImplementation: address(9),
    shareDecimals: 18, assetDecimals: 18,
    codeHashes: Object.fromEntries(["vault", "asset", "gateway", "core", "yieldSharing", "gatewayImplementation", "yieldSharingImplementation"]
      .map((name, index) => [name, toBeHex(index + 20, 32)])),
  };
  const family: any = runtime.definition;
  const routes: any[] = family.routes.project({ descriptor });
  const route = routes.find(row => row.direction === "deposit")!;
  runtime.assertInvocation(descriptor, route);
  return { descriptor, route, routes, family };
}

test("ordinary vault mutation triggers stay narrower than dependency proofs in both lookup APIs", () => {
  const runtime = makeRuntime(), { descriptor, routes, family } = fixture(runtime);
  const input = { descriptor, routes };
  const dependencies: string[] = family.pricing.dependencies(input);
  assert(dependencies.includes(descriptor.asset.toLowerCase()), "underlying token remains a proof dependency");
  const compiled = family.pricing.mutation.compile({ entries: [{ ...input, dependencies }] });
  for (const [target, expected] of [[descriptor.vault, [descriptor.instanceKey]], [descriptor.asset, []], [address(99), []]] as const) {
    const observation = { kind: "log", address: target, topics: [], data: "0x", source };
    assert.deepEqual(family.pricing.mutation.affectedStateKeys({ ...input, observation }), expected);
    assert.deepEqual(compiled.affectedStateKeys({ observation }), expected);
  }
  assert.equal(family.pricing.refreshPolicyForInstance(input), "on-touch");
});

test("variant mutation triggers preserve required external addresses without promoting every proof dependency", () => {
  const runtime = makeRuntime(), { descriptor, routes, family } = fixture(runtime, "infinifi");
  const input = { descriptor, routes }, binding = descriptor.infinifi;
  const compiled = family.pricing.mutation.compile({ entries: [{ ...input, dependencies: family.pricing.dependencies(input) }] });
  for (const target of [descriptor.vault, binding.gateway, binding.yieldSharing, binding.core]) {
    const observation = { kind: "log", address: target, topics: [], data: "0x", source };
    assert.deepEqual(family.pricing.mutation.affectedStateKeys({ ...input, observation }), [descriptor.instanceKey]);
    assert.deepEqual(compiled.affectedStateKeys({ observation }), [descriptor.instanceKey]);
  }
  const observation = { kind: "log", address: descriptor.asset, topics: [], data: "0x", source };
  assert.deepEqual(family.pricing.mutation.affectedStateKeys({ ...input, observation }), []);
  assert.deepEqual(compiled.affectedStateKeys({ observation }), []);
  assert.equal(family.pricing.refreshPolicyForInstance(input), "each-block");
});

test("Custodian rejects proxy admin as runtime owner, quoted owner and direct recipient", () => {
  const runtime = makeRuntime(), { descriptor, route, family } = fixture(runtime, "custodian");
  const admin = descriptor.custodian.proxyAdmin;
  const input = { descriptor, route, executor, source, runtimeEvidence: [] };
  assert(family.execution.buildRuntimeLeg(input), "valid owner still compiles");
  assert.throws(() => family.execution.buildRuntimeLeg({ ...input, executor: admin }), /runtime invalid executor/);
  assert.throws(() => family.execution.buildRuntimeLeg({ ...input,
    settlement: { kind: "direct-output", recipient: admin } }), /runtime invalid executor/);
  const exactEvidence = { kind: "frax-custodian-preview", source, vault: descriptor.vault,
    direction: route.direction, amountIn: 1n, amountOut: 1n,
    bindingFingerprint: route.bindingRef.fingerprint, executor: admin };
  assert.throws(() => family.execution.buildFragment({ ...input, executor: admin,
    amountIn: 1n, quotedAmountOut: 1n, minAmountOut: 1n, exactEvidence }), /runtime invalid executor/);
});

test("Exact preserves variant actor preflight before requesting positive input quotes", () => {
  const runtime = makeRuntime();
  for (const variant of ["custodian", "infinifi"] as const) {
    const { descriptor, route, family } = fixture(runtime, variant);
    const program = family.exact.methods().find((method: any) => method.kind === "request-program").program;
    const input = { descriptor, route, executor, source, amountIn: 1n, prefix: [], runtimeEvidence: [] };
    assert(program.buildRequests(input).length > 0, `${variant} legitimate owner retains quote requests`);
    const prohibited = variant === "custodian" ? [descriptor.custodian.proxyAdmin, descriptor.vault, ZeroAddress]
      : [descriptor.vault, descriptor.infinifi.gateway, ZeroAddress];
    for (const actor of prohibited)
      assert.throws(() => program.buildRequests({ ...input, executor: actor }), /runtime invalid executor/, `${variant}:${actor}`);
  }
});

test("runtime settlement capability follows JSON and unsupported callback requests remain rejected", () => {
  for (const enabled of [false, true]) {
    const definition: any = clone(root);
    definition.standard.execution.settlement.directOutput = enabled;
    const runtime = makeRuntime(definition), { descriptor, route, family } = fixture(runtime);
    const input = { descriptor, route, executor, source, runtimeEvidence: [] };
    const ordinary = family.execution.buildRuntimeLeg(input);
    assert(ordinary); assert.equal(ordinary.settlement?.directOutput === true, enabled);
    const direct = family.execution.buildRuntimeLeg({ ...input, settlement: { kind: "direct-output", recipient } });
    assert.equal(direct !== null, enabled);
    assert.equal(family.execution.buildRuntimeLeg({ ...input,
      settlement: { kind: "callback", recipient } }), null);
  }
});

test("root expressions and statements are rejected at registration, before a pricing or instance invocation", () => {
  for (const mutate of [
    (definition: any) => { definition.instance.key = { op: "unknown-admission-operation", args: [] }; },
    (definition: any) => { definition.pricing.static.decode = [{ assert: true, return: 0 }]; },
    (definition: any) => { definition.routes.assertions = [{ evaluate: true, silentlyAllow: true }]; },
  ]) {
    const definition: any = clone(root); mutate(definition);
    assert.throws(() => makeRuntime(definition), /unknown expression|invalid declarative statement|unknown declaration statement field|invalid model check/);
  }
});


test("authored Family JSON declares data and constraints without executable module bindings or workflow statements", () => {
  const forbidden = new Set(["module", "export", "handler", "let", "return", "attempt", "evaluate", "assert", "programs"]);
  const inspect = (value: unknown, path: string): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert(!forbidden.has(key), `executable field at ${path}.${key}`);
      inspect(child, `${path}.${key}`);
    }
  };
  inspect(root, "standard");
  inspect(custodian, "custodian");
  inspect(infinifi, "infinifi");
});
