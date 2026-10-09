import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  declareRequestProgram,
  type AdapterRequest,
  type AdapterRequestResult,
} from "../../../adapter-request-program.js";
import { plugin } from
  "../../../production-families/compound-ctoken.production.js";
import { COMPTROLLER_INTERFACE, CTOKEN_INTERFACE } from "../abi.js";
import type { CompoundCTokenCandidate, CompoundCTokenIdentity } from
  "../types.js";

/** Pinned-block source used by every synthetic fixture answer. */
export const SOURCE = {
  number: 25944463,
  hash: "0xa19ca18cb14237fdb759a247bb8e983b2ffa0b8a7685101faaf817234ebca316",
  generation: 1,
};

export const MARKET = "0x39aa39c021dfbae8fac545936693ac917d5e7563";
export const COMPTROLLER = "0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B";
export const UNDERLYING = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const EXECUTOR = "0x1000000000000000000000000000000000000005";
export const FOREIGN = "0x1000000000000000000000000000000000000009";

/** Values observed at block 25944463 (see anchors-20261008.md). */
export const EXCHANGE_RATE = 253233129688757n;
export const CASH = 3167359223290n;
export const SHARE_SUPPLY = 30_468_863_107_181_974n;
export const MARKET_DECIMALS = 8n;

export const CANDIDATE: CompoundCTokenCandidate = {
  candidateKind: "compound-ctoken-market",
  market: MARKET,
};

export const word = (n: bigint | string) => ethers.toBeHex(n, 32);

export function result(
  id: string,
  data: string,
  source = SOURCE,
): AdapterRequestResult {
  return {
    id,
    data,
    source,
    ok: true,
    completion: "returned",
    provenance: { kind: "synthetic-ctoken-contract", fingerprint: "fixture" },
  };
}

export interface AnswerOptions {
  readonly listed?: boolean;
  readonly enumerated?: readonly string[];
  readonly exchangeRate?: bigint;
  readonly cash?: bigint;
  readonly probeReplies?: boolean;
}

export function answerFor(
  options: AnswerOptions = {},
): (request: AdapterRequest) => AdapterRequestResult {
  const listed = options.listed ?? true;
  const enumerated = options.enumerated ?? [MARKET];
  const exchangeRate = options.exchangeRate ?? EXCHANGE_RATE;
  const cash = options.cash ?? CASH;
  const probe = options.probeReplies ?? true;
  return (request: AdapterRequest): AdapterRequestResult => {
    const values: Record<string, string> = {
      "market-code": "0x60016000f3",
      "market-comptroller": word(COMPTROLLER),
      "market-underlying": word(UNDERLYING),
      "market-exchange-rate-stored": word(exchangeRate),
      "market-cash": word(cash),
      "market-share-supply": word(SHARE_SUPPLY),
      "market-decimals": word(MARKET_DECIMALS),
      "registry-markets": COMPTROLLER_INTERFACE.encodeFunctionResult(
        "markets",
        [listed, 845_000_000_000_000_000n, 1n],
      ),
      "registry-all-markets": COMPTROLLER_INTERFACE.encodeFunctionResult(
        "getAllMarkets",
        [[...enumerated]],
      ),
      "active-exchange-rate-stored": word(exchangeRate),
      "active-underlying-balance": word(
        (SAMPLE_SHARES * exchangeRate) / 10n ** 18n,
      ),
      "quote-rate-current": word(exchangeRate),
      "quote-rate-stored": word(exchangeRate),
      "quote-cash": word(cash),
    };
    if (!probe && request.id === "active-underlying-balance") {
      return {
        id: request.id,
        ok: false,
        failure: "rpc",
        source: SOURCE,
      } as unknown as AdapterRequestResult;
    }
    assert(request.id in values, `unexpected fixture request ${request.id}`);
    return result(request.id, values[request.id]!);
  };
}

export const SAMPLE_SHARES = 10n ** 12n;

/** Walks the identity variant to a verified identity using fixture answers. */
export function identityWith(
  reply: (request: AdapterRequest) => AdapterRequestResult = answerFor(),
  candidate: CompoundCTokenCandidate = CANDIDATE,
): CompoundCTokenIdentity {
  const variant = plugin.identity.variants[0]!;
  let evidence: unknown;
  for (let step = 0; step < 6; step++) {
    const input = { candidate, evidence, step };
    const decision = variant.decide(input as never);
    if (decision.status === "verified") {
      return decision.identity as CompoundCTokenIdentity;
    }
    assert.equal(
      decision.status,
      "continue",
      `identity stopped early: ${JSON.stringify(decision)}`,
    );
    const declared = declareRequestProgram({
      requirements: variant.requirements,
      buildRequests: variant.buildRequests,
      decode: () => undefined,
    }, input as never);
    evidence = variant.decode({
      step: input as never,
      results: declared.requests.map(reply),
    } as never);
  }
  throw new Error("compound cToken identity did not converge");
}

export function decisionWith(
  reply: (request: AdapterRequest) => AdapterRequestResult,
) {
  const variant = plugin.identity.variants[0]!;
  let evidence: unknown;
  for (let step = 0; step < 6; step++) {
    const input = { candidate: CANDIDATE, evidence, step };
    const decision = variant.decide(input as never);
    if (decision.status !== "continue") return decision;
    const declared = declareRequestProgram({
      requirements: variant.requirements,
      buildRequests: variant.buildRequests,
      decode: () => undefined,
    }, input as never);
    evidence = variant.decode({
      step: input as never,
      results: declared.requests.map(reply),
    } as never);
  }
  throw new Error("compound cToken identity did not converge");
}

export function descriptor(
  reply: (request: AdapterRequest) => AdapterRequestResult = answerFor(),
) {
  const identity = identityWith(reply);
  return plugin.instance.finalizeDescriptor({
    identity,
    draft: plugin.instance.compileDraft(identity),
    sharedBindings: [],
  });
}
