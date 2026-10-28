import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { CanonicalSource } from "../../../adapter-request-program.js";
import type { AdapterFamilyExactQuoteCache } from "../../../../adapter-family-exact-quote-cache.js";
import { createRevmStrictSimulationTransport } from "../../../../revm-strict-simulation-transport.js";
import type { DaemonResponse, StrictSimulateRequest } from "../../../../revm-sim-client.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { COMPTROLLER_INTERFACE, CTOKEN_INTERFACE } from "../abi.js";
import { CASH, COMPTROLLER, EXCHANGE_RATE, EXECUTOR, MARKET, MARKET_DECIMALS, SHARE_SUPPLY, UNDERLYING } from "./fixtures.js";

// Synthetic transport only. The production identity/work/session/coordinator
// own orchestration. No RPC, daemon, historical storage or claimed chain proof.
export const ORIGIN = "0x1000000000000000000000000000000000000090";
export const source = (n = 100): CanonicalSource => ({ number: n, hash: ethers.toBeHex(n, 32), generation: n });
export const lower = (a: string) => a.toLowerCase();
export const state = () => ({ current: EXCHANGE_RATE, stored: EXCHANGE_RATE, cash: CASH, failCurrent: false });
export type FixtureState = ReturnType<typeof state>;
export type Mutation = (response: DaemonResponse) => void;

export function fixture(at = source(), s = state(), mutate?: Mutation, cache?: AdapterFamilyExactQuoteCache) {
  const reads: { to: string; method: string; block: number }[] = [];
  const wires: StrictSimulateRequest[] = [];
  const pin = { chainId: 1, blockHash: at.hash, stateRoot: ethers.toBeHex(at.number + 1, 32) };
  let leases = 0;
  const simulator = createRevmStrictSimulationTransport({ rpcUrl: "http://offline.invalid", executionGasLimit: 0x1000000,
    leaseFor: async requested => {
      leases++; assert.deepEqual(requested, at);
      return { source: at, sourcePin: pin, closeAndDrain: async () => assert.fail("not transport-owned"),
        strictSimulate: async wire => {
          wires.push(wire);
          const shares = BigInt(CTOKEN_INTERFACE.decodeFunctionData("redeem", wire.data)[0]);
          const out = shares * s.current / 10n ** 18n;
          const output = CTOKEN_INTERFACE.encodeFunctionResult("redeem", [0n]);
          const result: DaemonResponse = { ok: true, success: true, output, gasUsed: "21000", latencyMs: 0,
            sourceAttestation: { kind: "node-attested", ...pin, blockNumber: at.number, parentHash: ethers.toBeHex(at.number - 1, 32) },
            strict: { outcome: { kind: "Success", phase: "main", output }, executionGasUsed: "21000", nativeDeltas: [],
              tokenDeltas: (wire.observeTokenBalances ?? []).map(pair => ({ ...pair,
                delta: String(pair.token === lower(MARKET) ? -shares : pair.account === lower(MARKET) ? -out : out) })),
              totalSupplyDeltas: (wire.observeTotalSupply ?? []).map(token => ({ token, delta: String(-shares) })),
              logs: wire.observeLogs ? [{ address: MARKET, ...CTOKEN_INTERFACE.encodeEventLog(CTOKEN_INTERFACE.getEvent("Redeem")!, [EXECUTOR, out, shares]) }] : [],
            } };
          mutate?.(result); return result;
        } };
    }, onFatal() {} });
  const provider = {
    async getCode(to: string, block?: number) { assert.equal(block, at.number); reads.push({ to, method: "code", block: block! }); return "0x6000"; },
    async getStorage(): Promise<string> { return assert.fail("unexpected storage read"); },
    async call(tx: { to: string; data: string }, block?: number) {
      assert.equal(block, at.number);
      const abi = lower(tx.to) === lower(COMPTROLLER) ? COMPTROLLER_INTERFACE : CTOKEN_INTERFACE;
      assert([lower(MARKET), lower(COMPTROLLER)].includes(lower(tx.to)));
      const parsed = abi.parseTransaction({ data: tx.data }); assert(parsed);
      reads.push({ to: tx.to, method: parsed.name, block: block! });
      let values: unknown[];
      switch (parsed.name) {
        case "comptroller": values = [COMPTROLLER]; break;
        case "underlying": values = [UNDERLYING]; break;
        case "exchangeRateStored": values = [s.stored]; break;
        case "exchangeRateCurrent": if (s.failCurrent) throw new Error("synthetic current transport failure"); values = [s.current]; break;
        case "getCash": values = [s.cash]; break;
        case "totalSupply": values = [SHARE_SUPPLY]; break;
        case "decimals": values = [MARKET_DECIMALS]; break;
        case "markets": assert.equal(lower(parsed.args[0]), lower(MARKET)); values = [true, 0n, 0n]; break;
        case "getAllMarkets": values = [[MARKET]]; break;
        default: return assert.fail(`unexpected getter ${parsed.name}`);
      }
      return abi.encodeFunctionResult(parsed.name, values);
    },
  };
  return { reads, wires, simulator, pin, get leases() { return leases; },
    runtime: createStrictCentralAdapterRuntime({ executor: EXECUTOR, transactionOrigin: ORIGIN, provider, simulator,
      exactQuoteCache: cache, generationFence: { assertCurrent(g, current) { assert.equal(g, at.generation); assert.deepEqual(current, at); } } }) };
}
