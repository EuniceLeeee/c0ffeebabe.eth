import assert from "node:assert/strict";
import {
  prepareStartupDexIdentityRetryStage,
  type SourcePinnedIdentityBackend,
  type StartupDexIdentityRetryState,
} from "../startup-dex-identity-retry.js";
import {
  IdentityResolverRegistry,
  isRetryablePoolIdentityFailure,
  type IdentityPoolEntry,
  type PoolIdentityFailureReason,
} from "../venues/identity.js";

const RETRY = "0x0000000000000000000000000000000000000011";
const PERMANENT = "0x0000000000000000000000000000000000000022";
const HEALTHY = "0x0000000000000000000000000000000000000033";
const probeCalls: Array<{ sourceBlock: number; address: string }> = [];

const identityRegistry = new IdentityResolverRegistry(
  [{
    poolAdapter: "univ3",
    policy: "onchain-resolver",
    resolve: async ({ backend, pool }) => {
      try {
        const result = await backend.call({ to: pool, data: "0x12345678" });
        if (result === "0x02") {
          return { ok: false, reason: "behavior_mismatch" };
        }
      } catch {
        return { ok: false, reason: "identity_call_failed" };
      }
      return {
        ok: true,
        adapter: "univ3",
        venueId: "univ3",
        identitySource: "factory-call",
      };
    },
  }],
  (poolAdapter) => poolAdapter === "univ3",
);

const initialRemaining: readonly IdentityPoolEntry[] = Object.freeze([
  Object.freeze({ address: RETRY, adapter: "univ3" }),
  Object.freeze({ address: PERMANENT, adapter: "univ3" }),
  Object.freeze({ address: HEALTHY, adapter: "univ3" }),
]);
const initial: StartupDexIdentityRetryState<IdentityPoolEntry> = Object.freeze({
  accepted: Object.freeze([]),
  remaining: initialRemaining,
});

const first = await prepareStartupDexIdentityRetryStage({
  currentN: 100,
  backend: backendAt(100),
  state: initial,
  identityRegistry,
  concurrency: 2,
});
assert.deepEqual(
  first.accepted.map((pool) => pool.address),
  [HEALTHY],
  "healthy candidates must be staged for admission",
);
assert.deepEqual(
  first.remaining.map((pool) => pool.address),
  [RETRY],
  "transport failures must remain retryable",
);
assert.deepEqual(
  first.permanentlyRejected.map((item) => [
    item.candidate.address,
    item.rejection.reason,
  ]),
  [[PERMANENT, "behavior_mismatch"]],
  "completed negative identity proofs must leave the retry state",
);
assert.equal(initial.accepted.length, 0, "stage preparation must not mutate accepted state");
assert.equal(initial.remaining.length, 3, "stage preparation must not mutate remaining state");

const second = await prepareStartupDexIdentityRetryStage({
  currentN: 101,
  backend: backendAt(101),
  state: {
    accepted: first.accepted,
    remaining: first.remaining,
  },
  identityRegistry,
});
assert.deepEqual(
  second.accepted.map((pool) => pool.address),
  [HEALTHY, RETRY],
  "a current-N retry must atomically preserve prior admissions and add the healed candidate",
);
assert.equal(second.remaining.length, 0, "healed candidates must leave the retry set");
assert.equal(second.permanentlyRejected.length, 0);
assert.deepEqual(
  probeCalls,
  [
    { sourceBlock: 100, address: RETRY.toLowerCase() },
    { sourceBlock: 100, address: PERMANENT.toLowerCase() },
    { sourceBlock: 100, address: HEALTHY.toLowerCase() },
    { sourceBlock: 101, address: RETRY.toLowerCase() },
  ],
  "only retryable candidates may be re-read at current N",
);

await assert.rejects(
  prepareStartupDexIdentityRetryStage({
    currentN: 102,
    backend: backendAt(101),
    state: second,
    identityRegistry,
  }),
  /pinned to 101, expected 102/,
  "a stale identity backend must not masquerade as a current-N retry",
);

const allReasons: readonly PoolIdentityFailureReason[] = [
  "identity_call_failed",
  "unknown_factory",
  "unsupported_venue",
  "adapter_mismatch",
  "curve_unregistered",
  "balancer_v3_unregistered",
  "dodo_unregistered",
  "erc4626_nonstandard",
  "behavior_mismatch",
  "untrusted_seed",
];
assert.deepEqual(
  allReasons.filter(isRetryablePoolIdentityFailure),
  ["identity_call_failed"],
  "only failures without a negative identity proof may retry",
);

console.log("startup-dex-identity-retry PASS (4/4)");

function backendAt(sourceBlock: number): SourcePinnedIdentityBackend {
  return {
    sourceBlock,
    async call(req) {
      const address = req.to.toLowerCase();
      probeCalls.push({ sourceBlock, address });
      if (sourceBlock === 100 && address === RETRY.toLowerCase()) {
        throw new Error("transient RPC failure");
      }
      if (address === PERMANENT.toLowerCase()) return "0x02";
      return "0x01";
    },
  };
}
