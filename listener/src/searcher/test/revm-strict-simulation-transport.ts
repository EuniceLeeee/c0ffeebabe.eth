import assert from "node:assert/strict";
import {
  createRevmStrictSimulationTransport,
} from "../revm-strict-simulation-transport.js";
import type {
  RevmSimClient,
} from "../revm-sim-client.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_444,
  hash: `0x${"51".repeat(32)}`,
  generation: 44,
});
const EXECUTOR = `0x${"11".repeat(20)}`;
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
    overrideIntent: Object.freeze({ caller: Object.freeze({
      kind: "executor" as const,
    }) }),
    observe: Object.freeze([] as const),
    ...overrides,
  });
}

function mockClient(calls: { from: string; to: string; data: string }[]) {
  return Object.freeze({
    quote: async (req: { from?: string; to: string; data: string }) => {
      calls.push(Object.freeze({
        from: req.from ?? "",
        to: req.to,
        data: req.data,
      }));
      if (req.data === "0xrevert") {
        return Object.freeze({
          ok: false,
          success: false,
          revertReason: "fixture-revert",
          latencyMs: 1,
        });
      }
      return Object.freeze({
        ok: true,
        success: true,
        output: "0xbeef",
        latencyMs: 1,
      });
    },
  }) as Pick<RevmSimClient, "quote">;
}

async function main(): Promise<void> {
  const calls: { from: string; to: string; data: string }[] = [];
  const transport = createRevmStrictSimulationTransport({
    client: mockClient(calls),
    executor: EXECUTOR,
  });
  const result = await transport.simulate({
    request: request() as never,
    source: SOURCE,
  });
  assert.equal(result.data, "0xbeef");
  assert.deepEqual(calls, [Object.freeze({
    from: EXECUTOR,
    to: TARGET,
    data: "0xdead",
  })]);

  const preCalls: { from: string; to: string; data: string }[] = [];
  const preTransport = createRevmStrictSimulationTransport({
    client: mockClient(preCalls),
    executor: EXECUTOR,
  });
  await preTransport.simulate({
    request: request({
      preCalls: Object.freeze([Object.freeze({
        caller: Object.freeze({ kind: "none" as const }),
        to: TOKEN,
        data: "0xpre",
      })]),
    }) as never,
    source: SOURCE,
  });
  assert.equal(preCalls.length, 2);
  assert.equal(preCalls[0]!.data, "0xpre");
  assert.equal(preCalls[0]!.from, `0x${"0".repeat(40)}`);

  await assert.rejects(
    () => transport.simulate({
      request: request({ observe: Object.freeze(["token-delta" as const]) }) as never,
      source: SOURCE,
    }),
    /cannot observe effects/,
  );
  await assert.rejects(
    () => transport.simulate({
      request: request({
        overrideIntent: Object.freeze({
          caller: Object.freeze({ kind: "executor" as const }),
          tokenBalances: Object.freeze([{
            token: TOKEN,
            amount: 1n,
          }]),
        }),
      }) as never,
      source: SOURCE,
    }),
    /cannot fund callers/,
  );
  const noSender = createRevmStrictSimulationTransport({
    client: mockClient([]),
    executor: EXECUTOR,
  });
  await assert.rejects(
    () => noSender.simulate({
      request: request({
        call: Object.freeze({
          caller: Object.freeze({ kind: "observed-sender" as const }),
          to: TARGET,
          data: "0xdead",
        }),
      }) as never,
      source: SOURCE,
    }),
    /no observed sender binding/,
  );
  await assert.rejects(
    () => transport.simulate({
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
