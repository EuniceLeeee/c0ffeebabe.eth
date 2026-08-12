import assert from "node:assert/strict";
import {
  createRevmStrictSimulationTransport,
} from "../revm-strict-simulation-transport.js";
import type {
  RevmSimClient,
  StrictSimulateRequest,
} from "../revm-sim-client.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_444,
  hash: `0x${"51".repeat(32)}`,
  generation: 44,
});
const EXECUTOR = `0x${"11".repeat(20)}`;
const ACTOR = `0x${"12".repeat(20)}`;
const TARGET = `0x${"22".repeat(20)}`;
const TOKEN = `0x${"33".repeat(20)}`;

function request(overrides: Record<string, unknown> = {}) {
  return Object.freeze({
    id: "sim",
    kind: "effect-delta-simulation" as const,
    call: Object.freeze({
      caller: Object.freeze({ kind: "executor" as const }),
      to: TARGET,
      data: "0xdead",
    }),
    overrideIntent: Object.freeze({
      caller: Object.freeze({ kind: "executor" as const }),
    }),
    observe: Object.freeze([] as const),
    ...overrides,
  });
}

function mockClient(calls: StrictSimulateRequest[]) {
  return Object.freeze({
    strictSimulate: async (req: StrictSimulateRequest) => {
      calls.push(Object.freeze({ ...req }));
      if (req.data === "0xrevert") {
        return Object.freeze({
          ok: true,
          success: false,
          output: "0x",
          revertReason: "fixture-revert",
          latencyMs: 1,
        });
      }
      return Object.freeze({
        ok: true,
        success: true,
        output: "0xbeef",
        gasUsed: "21000",
        latencyMs: 1,
        strict: Object.freeze({
          tokenDeltas: Object.freeze([Object.freeze({
            token: TOKEN,
            account: ACTOR,
            delta: "-1000",
          })]),
          totalSupplyDeltas: Object.freeze([Object.freeze({
            token: TARGET,
            delta: "950",
          })]),
          logs: Object.freeze([Object.freeze({
            address: TARGET,
            topics: Object.freeze([`0x${"aa".repeat(32)}`]),
            data: "0x00",
          })]),
        }),
      });
    },
  }) as Pick<RevmSimClient, "strictSimulate">;
}

async function main(): Promise<void> {
  const calls: StrictSimulateRequest[] = [];
  const transport = createRevmStrictSimulationTransport({
    client: mockClient(calls),
    executor: EXECUTOR,
    verifiedActors: Object.freeze({ "erc4626-probe-actor": ACTOR }),
  });
  const result = await transport.simulate({
    request: request({
      call: Object.freeze({
        caller: Object.freeze({
          kind: "verified-actor" as const,
          evidenceId: "erc4626-probe-actor",
        }),
        to: TARGET,
        data: "0xdead",
      }),
      preCalls: Object.freeze([Object.freeze({
        caller: Object.freeze({
          kind: "verified-actor" as const,
          evidenceId: "erc4626-probe-actor",
        }),
        to: TOKEN,
        data: "0xpre",
      })]),
      overrideIntent: Object.freeze({
        caller: Object.freeze({
          kind: "verified-actor" as const,
          evidenceId: "erc4626-probe-actor",
        }),
        tokenBalances: Object.freeze([Object.freeze({
          token: TOKEN,
          amount: 1_000n,
        })]),
      }),
      observe: Object.freeze([
        "return-data" as const,
        "token-delta" as const,
        "total-supply-delta" as const,
        "logs" as const,
      ]),
    }) as never,
    source: SOURCE,
  });
  assert.equal(result.data, "0xbeef");
  assert.equal(calls.length, 1);
  const sent = calls[0]!;
  assert.equal(sent.from, ACTOR);
  assert.equal(sent.blockNumber, SOURCE.number);
  assert.equal(sent.preCalls?.[0]?.from, ACTOR);
  assert.equal(sent.tokenDeals?.[0]?.amount, "1000");
  assert.deepEqual(sent.observeTokens, [TOKEN.toLowerCase(), TARGET.toLowerCase()]);
  assert.deepEqual(sent.observeTotalSupply, [TARGET.toLowerCase()]);
  assert.equal(sent.observeLogs, true);
  assert.equal(result.effects?.tokenDeltas?.[0]?.delta, -1_000n);
  assert.equal(result.effects?.totalSupplyDeltas?.[0]?.delta, 950n);
  assert.equal(result.effects?.logs?.[0]?.address, TARGET);

  const bare = createRevmStrictSimulationTransport({
    client: mockClient([]),
    executor: EXECUTOR,
  });
  await assert.rejects(
    () => bare.simulate({
      request: request({
        call: Object.freeze({
          caller: Object.freeze({
            kind: "verified-actor" as const,
            evidenceId: "erc4626-probe-actor",
          }),
          to: TARGET,
          data: "0xdead",
        }),
      }) as never,
      source: SOURCE,
    }),
    /verified actor evidence erc4626-probe-actor is absent/,
  );
  await assert.rejects(
    () => bare.simulate({
      request: request({
        overrideIntent: Object.freeze({
          caller: Object.freeze({ kind: "executor" as const }),
          nativeBalanceWei: 1n,
        }),
      }) as never,
      source: SOURCE,
    }),
    /cannot fund native balances/,
  );
  const revertCalls: StrictSimulateRequest[] = [];
  const revertTransport = createRevmStrictSimulationTransport({
    client: mockClient(revertCalls),
    executor: EXECUTOR,
  });
  await assert.rejects(
    () => revertTransport.simulate({
      request: request({
        call: Object.freeze({
          caller: Object.freeze({ kind: "executor" as const }),
          to: TARGET,
          data: "0xrevert",
        }),
      }) as never,
      source: SOURCE,
    }),
    /fixture-revert/,
  );
  console.log("revm-strict-simulation-transport PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
