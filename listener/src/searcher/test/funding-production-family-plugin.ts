import assert from "node:assert/strict";
import { ethers } from "ethers";
import { balancerFlashPlugin } from
  "../venues/funding/balancer-flash-family-plugin.js";
import { balancerFlashFamily } from "../venues/funding/balancer-flash.js";
import { morphoFlashPlugin } from
  "../venues/funding/morpho-flash-family-plugin.js";
import { morphoFlashFamily } from "../venues/funding/morpho-flash.js";
import {
  assertDefinedFamilyPlugin,
  type FundingFamilyPlugin,
  type FundingLiquidityProgramInput,
  type FundingOfferDescriptor,
} from "../venues/adapter-family-plugin.js";
import {
  createBoundedRequestExecutor,
  runRequestProgram,
  type AdapterRequest,
  type CanonicalSource,
} from "../venues/adapter-request-program.js";
import type {
  Erc20BalanceFundingEvidence,
  Erc20BalanceFundingSource,
} from "../venues/funding/erc20-balance-family-plugin.js";

const TOKEN_A = ethers.getAddress(`0x${"31".repeat(20)}`);
const TOKEN_B = ethers.getAddress(`0x${"32".repeat(20)}`);
const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_222,
  hash: `0x${"41".repeat(32)}`,
  generation: 23,
});
const ERC20 = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
]);

await verifyFundingFamily({
  strict: morphoFlashPlugin,
  legacy: morphoFlashFamily,
  expectedAction: "morpho-flash",
  expectedMode: "approve-pull",
  balances: [1_000n, 2_000n],
});
await verifyFundingFamily({
  strict: balancerFlashPlugin,
  legacy: balancerFlashFamily,
  expectedAction: "balancer-flash",
  expectedMode: "transfer",
  balances: [3_000n, 4_000n],
});

console.log(
  "funding production Family plugins PASS " +
    "(source-bound balances, offer parity, pure repayment, ownership, isolation)",
);

async function verifyFundingFamily(input: {
  readonly strict: FundingFamilyPlugin<
    Erc20BalanceFundingSource,
    Erc20BalanceFundingEvidence
  >;
  readonly legacy: typeof morphoFlashFamily | typeof balancerFlashFamily;
  readonly expectedAction: "morpho-flash" | "balancer-flash";
  readonly expectedMode: "approve-pull" | "transfer";
  readonly balances: readonly [bigint, bigint];
}): Promise<void> {
  assertDefinedFamilyPlugin(input.strict);
  assert.equal(input.strict.manifest.domain, "funding");
  assert.equal(input.strict.manifest.familyId, input.legacy.id);
  assert.deepEqual(input.strict.manifest.ownedActionAdapterIds, [
    input.expectedAction,
  ]);
  assert.equal(
    input.strict.actionAdapters[0]?.descriptor.adapterId,
    input.expectedAction,
  );
  assert.equal(input.strict.actionAdapters[0]?.descriptor.edgeKind, "flash");
  assert(!("routes" in input.strict));
  assert(!("pricing" in input.strict));
  assert(!("exact" in input.strict));

  const sources = input.strict.funding.liquidity.sources([
    TOKEN_B,
    TOKEN_A,
    TOKEN_A.toLowerCase(),
  ]);
  assert.deepEqual(
    sources.map((source) => source.asset),
    [TOKEN_A, TOKEN_B],
    "Funding sources must canonicalize, de-duplicate and sort assets",
  );
  const legacySources = input.legacy.funding.describeSources([TOKEN_B, TOKEN_A]);
  assert.deepEqual(
    sources.map(projectSource),
    legacySources.map((source) => ({
      fundingId: source.fundingId,
      instanceKey: source.instanceKey,
      provider: source.provider,
      stateKey: source.stateKey,
      asset: source.asset,
      requiredReadKeys: [...source.requiredReadKeys],
    })).sort((left, right) => left.asset.localeCompare(right.asset)),
  );

  const requestsSeen: AdapterRequest[] = [];
  const executed = await runRequestProgram({
    familyId: input.strict.manifest.familyId,
    program: input.strict.funding.liquidity.program,
    programInput: Object.freeze({ assets: [TOKEN_A, TOKEN_B], sources, source: SOURCE }),
    source: SOURCE,
    executor: fundingExecutor(input.balances, requestsSeen),
  });
  assert.equal(requestsSeen.length, 2);
  for (const [index, request] of requestsSeen.entries()) {
    assert.equal(request.kind, "eth-call");
    if (request.kind !== "eth-call") throw new Error("unexpected funding read");
    assert.equal(request.to, sources[index]!.asset);
    assert.equal(request.completion, "return-data");
    const [holder] = ERC20.decodeFunctionData("balanceOf", request.data);
    assert.equal(
      ethers.getAddress(String(holder)),
      input.strict.funding.repayment.liquidityHolder,
    );
  }
  const offers = input.strict.funding.liquidity.deriveOffers({
    evidence: executed.evidence,
    sources,
  });
  assert.deepEqual(
    offers.map((offer) => offer.maxBorrow),
    [...input.balances],
  );
  assert(offers.every((offer) => offer.actionAdapterId === input.expectedAction));
  assert.equal(input.strict.funding.repayment.mode, input.expectedMode);
  assertOfferAndPlanParity(input, offers[0]!);

  const failing = createBoundedRequestExecutor({
    assertSupported() {},
    assertCallerBinding() {},
    assertWithinBudget() {},
    execute: async ({ requests, source }) => requests.map((request) => ({
      id: request.id,
      ok: false as const,
      source,
      failure: "rpc" as const,
    })),
    sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
  });
  await assert.rejects(
    runRequestProgram({
      familyId: input.strict.manifest.familyId,
      program: input.strict.funding.liquidity.program,
      programInput: Object.freeze({
        assets: [TOKEN_A],
        sources: [sources[0]!],
        source: SOURCE,
      }),
      source: SOURCE,
      executor: failing,
    }),
    /required adapter request .* failed: rpc/,
  );
  const healthySibling = await runRequestProgram<
    FundingLiquidityProgramInput<Erc20BalanceFundingSource>,
    Erc20BalanceFundingEvidence
  >({
    familyId: input.strict.manifest.familyId,
    program: input.strict.funding.liquidity.program,
    programInput: Object.freeze({
      assets: [TOKEN_B],
      sources: [sources[1]!],
      source: SOURCE,
    }),
    source: SOURCE,
    executor: fundingExecutor([input.balances[1]!], []),
  });
  assert.equal(healthySibling.evidence.balances[0]?.maxBorrow, input.balances[1]);
}

function assertOfferAndPlanParity(
  input: {
    readonly strict: FundingFamilyPlugin<
      Erc20BalanceFundingSource,
      Erc20BalanceFundingEvidence
    >;
    readonly legacy: typeof morphoFlashFamily | typeof balancerFlashFamily;
    readonly expectedAction: string;
  },
  offer: FundingOfferDescriptor,
): void {
  const amount = offer.maxBorrow / 2n;
  const minProfit = 7n;
  const strict = input.strict.funding.repayment.buildBorrowFragment({
    offer,
    amount,
    minProfit,
    children: [],
  });
  const legacy = input.legacy.funding.buildBorrowFragment({
    offer,
    amount,
    minProfit,
    children: [],
  });
  assert.deepEqual(strict.requirements, []);
  assert.deepEqual(strict.nodes, [legacy]);
  assert.equal(strict.nodes[0]?.adapterId, input.expectedAction);
  assert(Object.isFrozen(strict));
  assert(Object.isFrozen(strict.nodes));
  assert.throws(
    () => input.strict.funding.repayment.buildBorrowFragment({
      offer,
      amount: offer.maxBorrow + 1n,
      minProfit,
      children: [],
    }),
    /exceeds offer/,
  );
}

function fundingExecutor(
  balances: readonly bigint[],
  requestsSeen: AdapterRequest[],
) {
  return createBoundedRequestExecutor({
    assertSupported(requirements) {
      assert.deepEqual(requirements, {
        transports: ["eth-call"],
        completions: ["return-data"],
      });
    },
    assertCallerBinding() {},
    assertWithinBudget() {},
    execute: async ({ requests, source }) => requests.map((request, index) => {
      requestsSeen.push(request);
      return {
        id: request.id,
        ok: true as const,
        source,
        provenance: {
          kind: "funding-fixture",
          fingerprint: `funding:${request.id}`,
        },
        completion: "returned" as const,
        data: ERC20.encodeFunctionResult("balanceOf", [balances[index] ?? 0n]),
      };
    }),
    sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
  });
}

function projectSource(source: Erc20BalanceFundingSource) {
  return {
    fundingId: source.fundingId,
    instanceKey: source.instanceKey,
    provider: source.provider,
    stateKey: source.stateKey,
    asset: source.asset,
    requiredReadKeys: [...source.requiredReadKeys],
  };
}
