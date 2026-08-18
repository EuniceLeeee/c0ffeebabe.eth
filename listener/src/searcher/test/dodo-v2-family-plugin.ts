import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { dodoV2ActionAdapter } from "../../adapters/dodo-v2.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { TokenQueryBackend } from "../planner/token-graph.js";
import {
  definedFamilyPluginContractSummary,
  type UnifiedObservation,
} from "../venues/adapter-family-plugin.js";
import type {
  AdapterRequest,
  AdapterRequestResult,
  CanonicalSource,
} from "../venues/adapter-request-program.js";
import type {
  StateRead,
  StateReadResult,
} from "../venues/blockscan-state-capability.js";
import { hashCanonical } from "../venues/canonical-value.js";
import { generateCapabilityClosure } from "../venues/capability-content-hash.js";
import { dodoV2StrictFamilyPlugin } from "../venues/swaps/dodo-v2-family-plugin.js";
import {
  BLOCKSCAN_MULTICALL3,
  blockScanMulticallIface,
} from "../venues/swaps/blockscan-state-shared.js";
import {
  DODO_V2_EVENT_INTERFACE,
  DODO_V2_POOL_INTERFACE,
  DODO_V2_REGISTRY_INTERFACE,
} from "../venues/swaps/dodo-v2-abi.js";
import {
  DODO_V2_SWAP_LOG_PATTERN_ID,
} from "../venues/swaps/dodo-v2-family/discovery.js";
import {
  DODO_V2_QUOTE_ACTOR,
  DODO_V2_QUOTE_ACTOR_EVIDENCE_ID,
} from "../venues/swaps/dodo-v2-family/identity.js";
import type {
  DodoV2Candidate,
  DodoV2Identity,
  DodoV2IdentityEvidence,
} from "../venues/swaps/dodo-v2-family/types.js";
import {
  dodoV2Adapter,
  dodoV2BlockScanState,
} from "../venues/swaps/dodo-v2.js";

const POOL = ethers.getAddress("0x0000000000000000000000000000000000000D02");
const FORGED_POOL = ethers.getAddress(
  "0x0000000000000000000000000000000000000D03",
);
const BASE = ethers.getAddress("0x00000000000000000000000000000000000000B0");
const QUOTE = ethers.getAddress("0x00000000000000000000000000000000000000C0");
const REGISTRY = ethers.getAddress(
  "0x5336edE8F971339F6c0e304c66ba16F1296A2Fbe",
);
const TRADER = ethers.getAddress("0x0000000000000000000000000000000000000a12");
const RECEIVER = ethers.getAddress("0x0000000000000000000000000000000000000a13");
const SOURCE: CanonicalSource = Object.freeze({
  number: 22_000_000,
  hash: `0x${"11".repeat(32)}`,
  generation: 4,
});
const PROVENANCE = Object.freeze({ kind: "fixture", fingerprint: "dodo-v2-v1" });

const swapLog = DODO_V2_EVENT_INTERFACE.encodeEventLog(
  DODO_V2_EVENT_INTERFACE.getEvent("DODOSwap")!,
  [BASE, QUOTE, 200n, 400n, TRADER, RECEIVER],
);
const swapObservation: UnifiedObservation = Object.freeze({
  kind: "log",
  source: SOURCE,
  address: POOL,
  topics: Object.freeze(swapLog.topics),
  data: swapLog.data,
  transactionHash: `0x${"22".repeat(32)}`,
});

const decodedCandidate = dodoV2StrictFamilyPlugin.discovery.decodeCandidate({
  observation: swapObservation,
  matchedPatternId: DODO_V2_SWAP_LOG_PATTERN_ID,
});
assert(decodedCandidate !== null);
const candidate: DodoV2Candidate = decodedCandidate;
assert.equal(candidate.pool, POOL);
assert.equal(candidate.hintedTokenIn, BASE);
assert.equal(candidate.hintedTokenOut, QUOTE);
assert.equal(
  dodoV2StrictFamilyPlugin.discovery.candidateKey(candidate),
  POOL.toLowerCase(),
);

const identityVariant = dodoV2StrictFamilyPlugin.identity.variants.find(
  (variant) => variant.id === "registry-member-1",
)!;

async function main(): Promise<void> {
const backend = new DodoBackend();
const identity = await runIdentity(candidate, backend, POOL);
assert.equal(identity.subject, POOL);
assert.equal(identity.facts.registryBinding.registry, REGISTRY);
assert.equal(identity.facts.baseToken, BASE);
assert.equal(identity.facts.quoteToken, QUOTE);
assert.equal(identity.facts.quoteActorBinding.actor, DODO_V2_QUOTE_ACTOR);
assert.equal(identity.facts.quoteActorBinding.role, "verified-actor");
assert.equal(backend.lastFeeActor, DODO_V2_QUOTE_ACTOR);

const forgedDecision = await runIdentityDecision(candidate, backend, FORGED_POOL);
assert.deepEqual(forgedDecision, {
  status: "chain-proven-rejected",
  reasonCode: "registry_reverse_binding_failed",
  evidenceRequestIds: ["registry-get-dodo-pool"],
});

const descriptorDraft = dodoV2StrictFamilyPlugin.instance.compileDraft(identity);
const descriptor = dodoV2StrictFamilyPlugin.instance.finalizeDescriptor({
  identity,
  draft: descriptorDraft,
  sharedBindings: [],
});
assert(Object.isFrozen(descriptor));
assert.deepEqual(
  descriptor.runtimeRequirements.map((requirement) => requirement.kind),
  ["source-state", "execution-actor", "quote-completion"],
);

const routes = dodoV2StrictFamilyPlugin.routes.project({ descriptor });
assert.deepEqual(
  routes.map((route) => [route.tokenIn, route.tokenOut, route.direction]),
  [
    [BASE, QUOTE, "sell-base"],
    [QUOTE, BASE, "sell-quote"],
  ],
);
assert.equal(routes[0].bindingRef.fingerprint, routes[1].bindingRef.fingerprint);

const legacyEdges = await dodoV2Adapter.buildEdges(
  { address: POOL, adapter: "dodo-v2", score: 9 },
  backend,
);
assert.deepEqual(
  routes.map((route) => ({
    adapterId: "dodo-v2-swap",
    target: route.pool,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    slotKind: route.taxonomy.slotKind,
    poolToken0: descriptor.baseToken,
    poolToken1: descriptor.quoteToken,
  })),
  legacyEdges.map((edge) => ({
    adapterId: edge.adapterId,
    target: edge.target,
    tokenIn: edge.tokenIn,
    tokenOut: edge.tokenOut,
    slotKind: edge.slotKind,
    poolToken0: edge.poolToken0,
    poolToken1: edge.poolToken1,
  })),
  "strict route projection preserves legacy DODO base/quote directions",
);

const pricingDraft = dodoV2StrictFamilyPlugin.pricing.compileDraft({
  descriptor,
  stateKey: dodoV2StrictFamilyPlugin.pricing.stateKey(routes[0]),
  routes,
});
const staticProgram = dodoV2StrictFamilyPlugin.pricing.staticEvidence;
assert(staticProgram !== undefined);
const staticRequests = staticProgram.buildRequests(pricingDraft);
const staticEvidence = staticProgram.decode({
  programInput: pricingDraft,
  results: await adapterResults(staticRequests, backend),
});
const pricingDescriptor =
  dodoV2StrictFamilyPlugin.pricing.finalizePricingDescriptor({
    draft: pricingDraft,
    staticEvidence,
    sharedBindings: [],
  });
assert.equal(pricingDescriptor.baseOneToken, 100n);
assert.equal(pricingDescriptor.quoteOneToken, 100n);

const currentInput = { descriptor: pricingDescriptor, routes, source: SOURCE };
assert.deepEqual(
  dodoV2StrictFamilyPlugin.pricing.current.requirements(currentInput),
  { transports: ["eth-call"], caller: "verified-actor" },
);
const currentRequests =
  dodoV2StrictFamilyPlugin.pricing.current.buildRequests(currentInput);
assert.equal(currentRequests.length, 5);
const feeRequest = currentRequests.find((request) => request.id === "current-actor-fee");
assert(feeRequest?.kind === "eth-call");
assert.deepEqual(feeRequest.caller, {
  kind: "verified-actor",
  evidenceId: DODO_V2_QUOTE_ACTOR_EVIDENCE_ID,
});
const currentResults = await adapterResults(currentRequests, backend);
const dependentProgram =
  dodoV2StrictFamilyPlugin.pricing.current.buildDependentProgram!({
    current: currentInput,
    completedRound: 0,
    initialResults: currentResults,
    priorEvidence: [],
  });
assert.equal(dependentProgram, null, "ordinary PMM math needs no query fallback");
const snapshot = dodoV2StrictFamilyPlugin.pricing.current.decodeSnapshot({
  descriptor: pricingDescriptor,
  initialResults: currentResults,
  dependentEvidence: [],
});
const strictMids = dodoV2StrictFamilyPlugin.pricing.current.deriveMids({
  descriptor: pricingDescriptor,
  snapshot,
  routes,
});

let legacySchema = await dodoV2BlockScanState.compileStaticSchema({
  edges: legacyEdges,
  deadlineAtMs: Date.now() + 10_000,
  signal: new AbortController().signal,
});
const legacyStaticReads = dodoV2BlockScanState.buildStaticSchemaReads({
  schema: legacySchema,
  edges: legacyEdges,
  sourceBlock: SOURCE.number,
  sourceBlockHash: SOURCE.hash,
});
legacySchema = dodoV2BlockScanState.hydrateStaticSchema(
  legacySchema,
  await stateResults(legacyStaticReads, backend),
);
const legacyCurrentReads = dodoV2BlockScanState.buildCurrentBlockReads({
  schema: legacySchema,
  edges: legacyEdges,
  sourceBlock: SOURCE.number,
  sourceBlockHash: SOURCE.hash,
});
const legacyCurrentResults = await stateResults(legacyCurrentReads, backend);
const legacyDependentReads = dodoV2BlockScanState.buildDependentBlockReads({
  schema: legacySchema,
  edges: legacyEdges,
  sourceBlock: SOURCE.number,
  sourceBlockHash: SOURCE.hash,
  completedRound: 0,
  priorResults: legacyCurrentResults,
});
const legacySnapshot = dodoV2BlockScanState.decodeState(
  legacySchema,
  Object.freeze([
    ...legacyCurrentResults,
    ...await stateResults(legacyDependentReads, backend),
  ]),
);
const legacyMids = dodoV2BlockScanState.deriveMids(legacySnapshot, legacyEdges);
assert.deepEqual(
  [...strictMids.values()].map(midSemantics),
  [...legacyMids.values()].map(midSemantics),
  "descriptor-only PMM pricing preserves the legacy production closure",
);

const zeroBackend = new DodoBackend({
  baseBalance: 0n,
  quoteBalance: 0n,
  baseReserve: 0n,
  quoteReserve: 0n,
  pmm: [10n ** 18n, 10n ** 18n, 0n, 0n, 0n, 0n, 0],
});
const zeroResults = await adapterResults(currentRequests, zeroBackend);
const zeroSnapshot = dodoV2StrictFamilyPlugin.pricing.current.decodeSnapshot({
  descriptor: pricingDescriptor,
  initialResults: zeroResults,
  dependentEvidence: [],
});
assert.equal(
  dodoV2StrictFamilyPlugin.pricing.current.deriveMids({
    descriptor: pricingDescriptor,
    snapshot: zeroSnapshot,
    routes,
  }).size,
  0,
);
assert.equal(
  dodoV2StrictFamilyPlugin.pricing.current.classifyUnavailable!({
    descriptor: pricingDescriptor,
    snapshot: zeroSnapshot,
    routes,
  }).size,
  2,
  "only successful double-zero PMM evidence marks behavior unavailable",
);
assert.throws(
  () => dodoV2StrictFamilyPlugin.pricing.current.decodeSnapshot({
    descriptor: pricingDescriptor,
    initialResults: currentResults.map((result, index) => index === 0
      ? Object.freeze({
          id: result.id,
          ok: false as const,
          source: SOURCE,
          failure: "rpc" as const,
        })
      : result),
    dependentEvidence: [],
  }),
  /unresolved: rpc/,
  "RPC failure stays unresolved and cannot become behavior-unavailable",
);

const AMOUNT_IN = 200n;
const exactInput = Object.freeze({
  descriptor,
  route: routes[0],
  amountIn: AMOUNT_IN,
  source: SOURCE,
  executor: DODO_V2_QUOTE_ACTOR,
  runtimeEvidence: Object.freeze([]),
});
const exactRequestMethod = dodoV2StrictFamilyPlugin.exact.methods(exactInput)[1];
assert.equal(exactRequestMethod.kind, "request-program");
if (exactRequestMethod.kind !== "request-program") {
  throw new Error("DODO exact request program missing");
}
assert.deepEqual(
  exactRequestMethod.program.requirements(exactInput),
  { transports: ["eth-call"], caller: "verified-actor" },
);
const exactRequests = exactRequestMethod.program.buildRequests(exactInput);
assert.equal(exactRequests.length, 4);
const queryRequest = exactRequests.find((request) => request.id === "exact-actor-query");
assert(queryRequest?.kind === "eth-call");
assert.deepEqual(queryRequest.caller, {
  kind: "verified-actor",
  evidenceId: DODO_V2_QUOTE_ACTOR_EVIDENCE_ID,
});
const queryArgs = DODO_V2_POOL_INTERFACE.decodeFunctionData(
  "querySellBase",
  queryRequest.data,
);
assert.equal(ethers.getAddress(String(queryArgs[0])), DODO_V2_QUOTE_ACTOR);
assert.equal(BigInt(queryArgs[1]), AMOUNT_IN);
const strictExact = exactRequestMethod.program.decode({
  programInput: exactInput,
  initialResults: await adapterResults(exactRequests, backend),
  dependentEvidence: [],
});

const previousActor = process.env.BOTVM_OWNER;
process.env.BOTVM_OWNER = DODO_V2_QUOTE_ACTOR;
let legacyExact: bigint;
try {
  legacyExact = await dodoV2Adapter.quoteExact({
    state: backend as unknown as StateBackend,
    target: POOL,
    edgeAdapterId: "dodo-v2-swap",
    tokenIn: BASE,
    tokenOut: QUOTE,
    amountIn: AMOUNT_IN,
    edge: legacyEdges[0],
  });
} finally {
  if (previousActor === undefined) delete process.env.BOTVM_OWNER;
  else process.env.BOTVM_OWNER = previousActor;
}
assert.equal(strictExact.amountOut, legacyExact);
assert.equal(strictExact.evidence.actor, DODO_V2_QUOTE_ACTOR);
assert.equal(strictExact.evidence.quotePath, "actor-query");
assert.throws(
  () => exactRequestMethod.program.requirements({
    ...exactInput,
    executor: FORGED_POOL,
  }),
  /does not match the verified quote actor/,
);
assert.notEqual(
  hashCanonical(dodoV2StrictFamilyPlugin.exact.cacheCompatibilityProjection(
    exactInput,
  )),
  hashCanonical(dodoV2StrictFamilyPlugin.exact.cacheCompatibilityProjection({
    ...exactInput,
    executor: FORGED_POOL,
  })),
  "exact cache compatibility includes the concrete actor",
);

const strictFragment = dodoV2StrictFamilyPlugin.execution.buildFragment({
  descriptor,
  route: routes[0],
  amountIn: AMOUNT_IN,
  quotedAmountOut: strictExact.amountOut,
  minAmountOut: strictExact.amountOut,
  exactEvidence: strictExact.evidence,
  executor: DODO_V2_QUOTE_ACTOR,
  runtimeEvidence: [],
});
const legacyFragment = await dodoV2Adapter.buildPlanFragment({
  edge: legacyEdges[0],
  amountIn: AMOUNT_IN,
  amountOut: strictExact.amountOut,
  executor: DODO_V2_QUOTE_ACTOR,
  state: backend as unknown as StateBackend,
});
assert.deepEqual(strictFragment, legacyFragment);
assert.throws(
  () => dodoV2StrictFamilyPlugin.execution.buildFragment({
    descriptor,
    route: routes[0],
    amountIn: AMOUNT_IN,
    quotedAmountOut: strictExact.amountOut + 1n,
    minAmountOut: strictExact.amountOut,
    exactEvidence: strictExact.evidence,
    executor: DODO_V2_QUOTE_ACTOR,
    runtimeEvidence: [],
  }),
  /incompatible exact evidence/,
);

const summary = definedFamilyPluginContractSummary(dodoV2StrictFamilyPlugin);
assert.deepEqual(summary.ownedActionAdapterIds, ["dodo-v2-swap"]);
assert.deepEqual(summary.requiredInfraActionAdapterIds, ["erc20-transfer"]);
const inner = new Uint8Array([1, 2, 3]);
assert.deepEqual(
  dodoV2StrictFamilyPlugin.actionAdapters[0].encode(
    strictFragment.nodes[0],
    DODO_V2_QUOTE_ACTOR,
    inner,
  ),
  dodoV2ActionAdapter.encode(
    strictFragment.nodes[0],
    DODO_V2_QUOTE_ACTOR,
    inner,
  ),
);

assert.equal(
  dodoV2StrictFamilyPlugin.swap.landedEvents.classify({
    observation: swapObservation,
  }),
  "swap",
);
const observed = dodoV2StrictFamilyPlugin.swap.observation.decode({
  observation: swapObservation,
});
assert.equal(observed.length, 1);
assert.equal(observed[0].kind, "swap");
assert.deepEqual(observed[0].canonicalPayload, {
  pool: POOL,
  tokenIn: BASE,
  tokenOut: QUOTE,
  amountIn: 200n,
  amountOut: 400n,
  trader: TRADER,
  receiver: RECEIVER,
});
assert.equal(dodoV2StrictFamilyPlugin.swap.victimSupport, "detect-only");
assert.equal(
  dodoV2StrictFamilyPlugin.swap.victimSupport,
  dodoV2Adapter.victimModel.mode,
  "strict DODO keeps the legacy detect-only victim contract",
);

const listenerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const capabilityDirectory = resolve(
  listenerRoot,
  "src/searcher/venues/swaps/dodo-v2-family",
);
const manifestRoot = resolve(capabilityDirectory, "manifest.ts");
const capabilityRoots = {
  discovery: resolve(capabilityDirectory, "discovery.ts"),
  identity: resolve(capabilityDirectory, "identity.ts"),
  instance: resolve(capabilityDirectory, "instance.ts"),
  routes: resolve(capabilityDirectory, "routes.ts"),
  pricing: resolve(capabilityDirectory, "pricing.ts"),
  exact: resolve(capabilityDirectory, "exact.ts"),
  execution: resolve(capabilityDirectory, "execution.ts"),
} as const;
assert.equal(new Set(Object.values(capabilityRoots)).size, 7);
const generatedCapabilities = await Promise.all(
  Object.entries(capabilityRoots).map(async ([capability, entryFile]) =>
    generateCapabilityClosure({
      familyId: dodoV2StrictFamilyPlugin.manifest.familyId,
      capability: capability as keyof typeof capabilityRoots,
      rootDirectory: listenerRoot,
      entryFile,
      additionalEntryFiles: [
        manifestRoot,
        ...(capability === "execution"
          ? [resolve(capabilityDirectory, "action.ts")]
          : []),
      ],
      provenanceCommit: null,
    })
  ),
);
assert.equal(new Set(generatedCapabilities.map((item) => item.entryLogicalId)).size, 7);
const exactClosure = generatedCapabilities.find(
  (entry) => entry.identity.capability === "exact",
)!;
assert(
  exactClosure.identity.semanticDependencies.some((dependency) =>
    dependency.endsWith("venues/swaps/dodo-pmm-math.ts")
  ),
  "DODO exact hash includes PMM input-adjustment math",
);
for (const capability of generatedCapabilities) {
  assert(
    capability.identity.semanticDependencies.every((dependency) =>
      !dependency.endsWith("venues/swaps/dodo-v2.ts") &&
      !dependency.endsWith("shared/executor/botvm-executor.ts") &&
      dependency !== "runtime:node:fs@node-es2022-v1"
    ),
    `${capability.identity.capability} capability must not inherit legacy/env I/O`,
  );
}
const executionClosure = generatedCapabilities.find(
  (entry) => entry.identity.capability === "execution",
)!;
assert(
  executionClosure.identity.semanticDependencies.some((dependency) =>
    dependency.endsWith("adapters/dodo-v2.ts")
  ),
  "execution hash includes the Family-owned DODO ActionAdapter",
);

console.log(
  "dodo-v2-family-plugin PASS " +
    "(registry behavior proof, descriptor PMM parity, actor-bound exact, ownership, detect-only victim)",
);
}

async function runIdentity(
  candidateInput: DodoV2Candidate,
  state: DodoBackend,
  listedPool: string,
): Promise<DodoV2Identity> {
  const decision = await runIdentityDecision(candidateInput, state, listedPool);
  assert.equal(decision.status, "verified");
  return decision.identity;
}

async function runIdentityDecision(
  candidateInput: DodoV2Candidate,
  state: DodoBackend,
  listedPool: string,
): Promise<ReturnType<typeof identityVariant.decide>> {
  const initial = { candidate: candidateInput, evidence: undefined, step: 0 };
  assert.deepEqual(identityVariant.decide(initial), { status: "continue" });
  assert.deepEqual(identityVariant.requirements(initial), {
    transports: ["eth-call"],
    caller: "verified-actor",
  });
  const behaviorRequests = identityVariant.buildRequests(initial);
  assert.equal(behaviorRequests.length, 4);
  const behaviorEvidence = identityVariant.decode({
    step: initial,
    results: await adapterResults(behaviorRequests, state),
  }) as DodoV2IdentityEvidence;
  assert.equal(behaviorEvidence.phase, "pool-behavior");
  const registryStep = {
    candidate: candidateInput,
    evidence: behaviorEvidence,
    step: 1,
  };
  assert.deepEqual(identityVariant.decide(registryStep), { status: "continue" });
  assert.deepEqual(identityVariant.requirements(registryStep), {
    transports: ["eth-call"],
  });
  const registryRequests = identityVariant.buildRequests(registryStep);
  assert.equal(registryRequests.length, 1);
  assert.equal(registryRequests[0].kind, "eth-call");
  if (registryRequests[0].kind !== "eth-call") {
    throw new Error("DODO registry proof must be an eth-call");
  }
  const args = DODO_V2_REGISTRY_INTERFACE.decodeFunctionData(
    "getDODOPool",
    registryRequests[0].data,
  );
  assert.equal(ethers.getAddress(String(args[0])), BASE);
  assert.equal(ethers.getAddress(String(args[1])), QUOTE);
  const registryEvidence = identityVariant.decode({
    step: registryStep,
    results: [success(
      registryRequests[0].id,
      DODO_V2_REGISTRY_INTERFACE.encodeFunctionResult("getDODOPool", [[
        listedPool,
      ]]),
    )],
  }) as DodoV2IdentityEvidence;
  return identityVariant.decide({
    candidate: candidateInput,
    evidence: registryEvidence,
    step: 2,
  });
}

async function adapterResults(
  requests: readonly AdapterRequest[],
  state: DodoBackend,
): Promise<readonly AdapterRequestResult[]> {
  return Object.freeze(await Promise.all(requests.map(async (request) => {
    if (request.kind !== "eth-call") {
      throw new Error(`unexpected DODO fixture transport ${request.kind}`);
    }
    return success(request.id, await state.call({
      to: request.to,
      data: request.data,
      ...(request.caller?.kind === "verified-actor"
        ? { from: DODO_V2_QUOTE_ACTOR }
        : {}),
    }));
  })));
}

function success(id: string, data: string): AdapterRequestResult {
  return Object.freeze({
    id,
    ok: true as const,
    source: SOURCE,
    provenance: PROVENANCE,
    completion: "returned" as const,
    data,
  });
}

async function stateResults(
  reads: readonly StateRead[],
  state: DodoBackend,
): Promise<readonly StateReadResult[]> {
  return Object.freeze(await Promise.all(reads.map(async (read) =>
    Object.freeze({
      id: read.id,
      ok: true as const,
      sourceBlock: read.sourceBlock,
      sourceBlockHash: read.sourceBlockHash,
      provenance: Object.freeze({
        kind: "eip1898" as const,
        source: SOURCE,
        requireCanonical: true as const,
      }),
      data: await state.call({
        to: read.to,
        data: read.data,
        ...(read.from === undefined ? {} : { from: read.from }),
      }),
    })
  )));
}

function midSemantics(mid: {
  readonly kind: string;
  readonly pool: string;
  readonly mid: number;
  readonly feeBps: number;
  readonly reserveA?: bigint;
  readonly reserveB?: bigint;
}) {
  return {
    kind: mid.kind,
    pool: mid.pool,
    mid: mid.mid,
    feeBps: mid.feeBps,
    reserveA: mid.reserveA,
    reserveB: mid.reserveB,
  };
}

interface BackendOptions {
  readonly baseBalance?: bigint;
  readonly quoteBalance?: bigint;
  readonly baseReserve?: bigint;
  readonly quoteReserve?: bigint;
  readonly baseInput?: bigint;
  readonly quoteInput?: bigint;
  readonly mtFeeTotal?: readonly [bigint, bigint];
  readonly pmm?: readonly [bigint, bigint, bigint, bigint, bigint, bigint, number];
}

class DodoBackend implements TokenQueryBackend {
  lastFeeActor: string | null = null;
  lastQueryActor: string | null = null;

  constructor(private readonly options: BackendOptions = {}) {}

  async call(request: {
    readonly to: string;
    readonly data: string;
    readonly from?: string;
  }): Promise<string> {
    const to = ethers.getAddress(request.to);
    const selector = request.data.slice(0, 10).toLowerCase();
    if (
      to === ethers.getAddress(BLOCKSCAN_MULTICALL3) &&
      selector === blockScanMulticallIface.getFunction("aggregate3")!.selector
    ) {
      const calls = blockScanMulticallIface.decodeFunctionData(
        "aggregate3",
        request.data,
      )[0] as readonly {
        readonly target: string;
        readonly allowFailure: boolean;
        readonly callData: string;
      }[];
      const responses = [];
      for (const call of calls) {
        try {
          responses.push({
            success: true,
            returnData: await this.call({
              to: String(call.target),
              data: String(call.callData),
              ...(request.from === undefined ? {} : { from: request.from }),
            }),
          });
        } catch (error) {
          if (!call.allowFailure) throw error;
          responses.push({ success: false, returnData: "0x" });
        }
      }
      return blockScanMulticallIface.encodeFunctionResult("aggregate3", [
        responses,
      ]);
    }
    if (to === POOL) {
      if (selector === DODO_V2_POOL_INTERFACE.getFunction("_BASE_TOKEN_")!.selector) {
        return DODO_V2_POOL_INTERFACE.encodeFunctionResult("_BASE_TOKEN_", [BASE]);
      }
      if (selector === DODO_V2_POOL_INTERFACE.getFunction("_QUOTE_TOKEN_")!.selector) {
        return DODO_V2_POOL_INTERFACE.encodeFunctionResult("_QUOTE_TOKEN_", [QUOTE]);
      }
      if (selector === DODO_V2_POOL_INTERFACE.getFunction("_BASE_RESERVE_")!.selector) {
        return DODO_V2_POOL_INTERFACE.encodeFunctionResult("_BASE_RESERVE_", [
          this.options.baseReserve ?? 1_000n,
        ]);
      }
      if (selector === DODO_V2_POOL_INTERFACE.getFunction("_QUOTE_RESERVE_")!.selector) {
        return DODO_V2_POOL_INTERFACE.encodeFunctionResult("_QUOTE_RESERVE_", [
          this.options.quoteReserve ?? 2_000n,
        ]);
      }
      if (
        selector ===
          DODO_V2_POOL_INTERFACE.getFunction("getPMMStateForCall")!.selector
      ) {
        return DODO_V2_POOL_INTERFACE.encodeFunctionResult(
          "getPMMStateForCall",
          this.options.pmm ?? [
            2n * 10n ** 18n,
            0n,
            1_000n,
            2_000n,
            1_000n,
            2_000n,
            0,
          ],
        );
      }
      if (selector === DODO_V2_POOL_INTERFACE.getFunction("getUserFeeRate")!.selector) {
        const actor = String(
          DODO_V2_POOL_INTERFACE.decodeFunctionData("getUserFeeRate", request.data)[0],
        );
        this.lastFeeActor = ethers.getAddress(actor);
        return DODO_V2_POOL_INTERFACE.encodeFunctionResult("getUserFeeRate", [0n, 0n]);
      }
      if (selector === DODO_V2_POOL_INTERFACE.getFunction("getBaseInput")!.selector) {
        return DODO_V2_POOL_INTERFACE.encodeFunctionResult("getBaseInput", [
          this.options.baseInput ?? 0n,
        ]);
      }
      if (selector === DODO_V2_POOL_INTERFACE.getFunction("getQuoteInput")!.selector) {
        return DODO_V2_POOL_INTERFACE.encodeFunctionResult("getQuoteInput", [
          this.options.quoteInput ?? 0n,
        ]);
      }
      if (selector === DODO_V2_POOL_INTERFACE.getFunction("getMtFeeTotal")!.selector) {
        if (this.options.mtFeeTotal === undefined) {
          throw new Error("execution reverted: selector not implemented");
        }
        return DODO_V2_POOL_INTERFACE.encodeFunctionResult(
          "getMtFeeTotal",
          this.options.mtFeeTotal,
        );
      }
      if (selector === DODO_V2_POOL_INTERFACE.getFunction("querySellBase")!.selector) {
        const decoded = DODO_V2_POOL_INTERFACE.decodeFunctionData(
          "querySellBase",
          request.data,
        );
        this.lastQueryActor = ethers.getAddress(String(decoded[0]));
        return ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256", "uint256"],
          [BigInt(decoded[1]) * 2n, 0n],
        );
      }
      if (selector === DODO_V2_POOL_INTERFACE.getFunction("querySellQuote")!.selector) {
        const decoded = DODO_V2_POOL_INTERFACE.decodeFunctionData(
          "querySellQuote",
          request.data,
        );
        this.lastQueryActor = ethers.getAddress(String(decoded[0]));
        return ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256", "uint256", "uint256", "uint256"],
          [BigInt(decoded[1]) / 2n, 0n, 0n, 0n],
        );
      }
    }
    if (
      (to === BASE || to === QUOTE) &&
      selector === "0x313ce567"
    ) {
      return ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [2]);
    }
    if (to === BASE && selector === "0x70a08231") {
      return ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256"],
        [this.options.baseBalance ?? 1_000n],
      );
    }
    if (to === QUOTE && selector === "0x70a08231") {
      return ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256"],
        [this.options.quoteBalance ?? 2_000n],
      );
    }
    if (
      to === REGISTRY &&
      selector === DODO_V2_REGISTRY_INTERFACE.getFunction("getDODOPool")!.selector
    ) {
      return DODO_V2_REGISTRY_INTERFACE.encodeFunctionResult("getDODOPool", [[POOL]]);
    }
    throw new Error(`unexpected DODO fixture call ${to} ${selector}`);
  }
}

await main();
