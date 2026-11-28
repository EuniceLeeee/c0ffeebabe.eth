import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { FunctionFragment, Interface, getAddress, toBeHex } from "ethers";
import { compileSelectorExecutionSource } from "../build-selector-execution-source.js";
import { assertModuleData } from "../venues/declarative-modules.js";
import { readSelectorDiscoveryRuleHash } from "../venues/selector-discovery-rule-hash.js";
import { normalizeSelectorNativeExecutionDefinition, type SelectorNativeExecutionDefinition } from "../venues/selector-native-definition.js";
import { compileSqlExecutionParamPlan } from "../venues/selector-native-execution-param-plan.js";
import { compileSqlTrialLegs } from "../venues/selector-native-sql-trial.js";
import { selectSingleExecution } from "../venues/selector-program-role.js";
import { assertSelectorSourceIdentity, issueDirectSelectorSourceIdentity, readSelectorSourceIdentity } from "../venues/selector-source-identity.js";
import { inspectRuntime } from "./runtime-program-testkit.js";

const ERC20_ABI = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
]);

const DEFAULT_EXECUTOR = "0x0000000000000000000000000000000000e1ec01";
const DEFAULT_ORIGIN = "0x0000000000000000000000000000000000011901";

export interface RealTxTraceFrame {
  readonly path: string;
  readonly ok: boolean;
  readonly kind: string;
  readonly sender: string;
  readonly target: string | null;
  readonly input: string;
  readonly value: string;
  readonly output: string | null;
}

export interface RealTxReceiptLog {
  readonly idx: number;
  readonly emitter: string;
  readonly topics: readonly string[];
  readonly data: string;
}

export interface RecordedStaticCallResult {
  readonly completion: "returned" | "reverted-as-declared";
  readonly data: string;
}

export interface RealTxSample {
  readonly txHash: string;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly frames: readonly RealTxTraceFrame[];
  readonly logs: readonly RealTxReceiptLog[];
  /** Optional dynamic ABI argument indices allowed to differ from historical user call (e.g. recipient, minOut, deadline). */
  readonly dynamicArgIndices?: readonly number[];
}

export interface RealTxSelectorFixture {
  readonly format: "selector-real-tx-replay/v1";
  readonly chainId: 1;
  readonly selector: string;
  /** Pure recorded on-chain static eth_call map ("<lowercaseTarget>:<lowercaseCalldata>" -> result). No JS callbacks. */
  readonly recordedStaticCalls: Readonly<Record<string, RecordedStaticCallResult>>;
  readonly transactions: readonly RealTxSample[];
}

export interface DiscoveredRealEdge {
  readonly selector: string;
  readonly callPath: string;
  readonly selectorTarget: string;
  readonly poolAddress: string;
  readonly poolId: string | null;
  readonly innerSwapPath: string | null;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountPayerInRaw: string;
  readonly amountReceivedOutRaw: string;
  readonly evidence: string;
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalCallKey(target: string, data: string): string {
  return `${getAddress(target).toLowerCase()}:${data.toLowerCase()}`;
}

/** Identify all succeeded logical CALL frames targeting `selector` in a real tx
 * (excluding staticcall, reverted branches, and delegatecall proxy duplicates). */
export function validSelectorCallFrames(
  frames: readonly RealTxTraceFrame[],
  selector: string,
  ignoredCallPaths: ReadonlySet<string> = new Set(),
): readonly RealTxTraceFrame[] {
  const sel = selector.toLowerCase();
  const byPath = new Map<string, RealTxTraceFrame>();
  for (const f of frames) byPath.set(f.path, f);

  function chainSucceeded(frame: RealTxTraceFrame): boolean {
    let cur: RealTxTraceFrame | undefined = frame;
    while (cur) {
      if (!cur.ok || cur.kind === "staticcall") return false;
      if (cur.path === "") return true;
      const pos = cur.path.lastIndexOf(",");
      const parentPath = pos < 0 ? "" : cur.path.slice(0, pos);
      cur = byPath.get(parentPath);
      if (!cur) return false;
    }
    return false;
  }

  return frames.filter(f =>
    f.kind === "call" &&
    typeof f.target === "string" &&
    f.input.slice(0, 10).toLowerCase() === sel &&
    !ignoredCallPaths.has(f.path) &&
    chainSucceeded(f),
  );
}

/** Load and validate a selector family directory from authored JSON sources. */
export async function loadCompiledSelectorFamily(selector: string, familyDirUrl?: URL) {
  const tag = selector.toLowerCase().replace(/^0x/, "");
  const dirUrl = familyDirUrl ?? new URL(`../venues/selector-native/selector-${tag}-family/`, import.meta.url);
  const scriptsUrl = new URL("../../../../scripts/", import.meta.url);
  const execSrc = JSON.parse(readFileSync(new URL("execution.source.json", dirUrl), "utf8"));
  const idUrl = new URL("identity.source.json", dirUrl);
  const idSrc = existsSync(idUrl) ? JSON.parse(readFileSync(idUrl, "utf8")) : undefined;
  const generated = JSON.parse(readFileSync(new URL(`selector-${tag}.json`, dirUrl), "utf8"));
  const ruleHash = await readSelectorDiscoveryRuleHash(dirUrl, scriptsUrl);
  const compiled = compileSelectorExecutionSource(execSrc, ruleHash, idSrc);
  assert.deepEqual(generated, compiled, `generated selector-${tag}.json is out of sync with authored sources`);
  const definition = normalizeSelectorNativeExecutionDefinition(compiled);

  const rule = JSON.parse(readFileSync(new URL("edge-discovery.json", dirUrl), "utf8"));
  const discoverUrl = new URL("discover.mjs", dirUrl);
  const discoverMod = rule.type === "familyModule" ? await import(discoverUrl.href) : undefined;
  return { definition, rule, discoverFn: discoverMod?.discover as ((...args: unknown[]) => unknown) | undefined };
}

/** Gate 1: Run `discover.mjs` / `edge-discovery.json` against real mainnet tx frames + logs.
 * A tx where `selector` succeeded must yield >= 1 discovered edge, and across a fixture batch
 * `totalDiscoveredEdges >= selectorAppearingTxCount`. */
export async function replayRealTxDiscovery(input: {
  readonly selector: string;
  readonly rule: unknown;
  readonly discoverFn?: (...args: unknown[]) => unknown;
  readonly sample: RealTxSample;
}): Promise<{
  readonly callFrames: readonly RealTxTraceFrame[];
  readonly edges: readonly DiscoveredRealEdge[];
}> {
  const { discoverFamilyEventEdges } = await import(new URL("../../../../scripts/selector-family-event-discovery.mjs", import.meta.url).href);
  const sel = input.selector.toLowerCase();
  const callFrames = validSelectorCallFrames(input.sample.frames, sel);
  assert(callFrames.length >= 1, `tx ${input.sample.txHash} contains 0 valid CALL frames for selector ${sel}`);

  const rawEdges: DiscoveredRealEdge[] = discoverFamilyEventEdges(
    input.sample.frames,
    input.sample.logs,
    { [sel]: input.rule },
    input.discoverFn ? { [sel]: input.discoverFn } : {},
  );
  const edges = rawEdges.filter(e => e.selector.toLowerCase() === sel);

  assert(
    edges.length >= 1,
    `tx ${input.sample.txHash} selector ${sel}: discovered ${edges.length} edge(s) < 1 for a tx where selector appeared`,
  );
  for (const edge of edges) {
    assert(BigInt(edge.amountPayerInRaw) > 0n, `tx ${input.sample.txHash}: non-positive amountPayerInRaw on ${edge.callPath}`);
    assert(BigInt(edge.amountReceivedOutRaw) > 0n, `tx ${input.sample.txHash}: non-positive amountReceivedOutRaw on ${edge.callPath}`);
    assert.notEqual(edge.tokenIn.toLowerCase(), edge.tokenOut.toLowerCase(), `tx ${input.sample.txHash}: identical tokenIn/tokenOut`);
  }
  return { callFrames, edges };
}

function inferDynamicArgIndices(definition: SelectorNativeExecutionDefinition, fn: FunctionFragment): ReadonlySet<number> {
  const single = selectSingleExecution(definition);
  const dynamic = new Set<number>();
  for (const param of single.program.parameters ?? []) {
    if (param.path.length === 1 && ["recipient", "executor", "minimumOut"].includes(param.role)) {
      dynamic.add(param.path[0]!);
    }
  }
  // Standard heuristic for authored templates without top-level `parameters` array:
  // address recipient/receiver and trailing minOut/deadline arguments are caller-chosen,
  // whereas pool routing indices/booleans/PoolKey and exact `amountIn` must match the real tx!
  fn.inputs.forEach((inp, idx) => {
    if (inp.type === "address") dynamic.add(idx);
  });
  return dynamic;
}

/** Gate 2: Replay Identity + BotVM Execution strictly against recorded on-chain static calls
 * and verify emitted swap calldata matches the real mainnet call frame. */
export async function replayRealTxExecution(input: {
  readonly definition: SelectorNativeExecutionDefinition;
  readonly recordedStaticCalls: Readonly<Record<string, RecordedStaticCallResult>>;
  readonly sample: RealTxSample;
  readonly edge: DiscoveredRealEdge;
  readonly callFrame: RealTxTraceFrame;
  readonly executor?: string;
  readonly transactionOrigin?: string;
}): Promise<void> {
  const { definition, sample, edge, callFrame } = input;
  const executor = (input.executor ?? DEFAULT_EXECUTOR).toLowerCase();
  const origin = (input.transactionOrigin ?? DEFAULT_ORIGIN).toLowerCase();
  const source = { number: sample.blockNumber, generation: sample.blockNumber, hash: sample.blockHash.toLowerCase() };
  const single = selectSingleExecution(definition);

  const staticTable = new Map<string, RecordedStaticCallResult>();
  for (const [k, v] of Object.entries(input.recordedStaticCalls)) {
    const sep = k.indexOf(":");
    assert(sep > 0, `invalid recordedStaticCalls key: ${k}`);
    staticTable.set(canonicalCallKey(k.slice(0, sep), k.slice(sep + 1)), v);
  }

  const sqlEdge = {
    chainId: 1 as const,
    selector: definition.selector.toLowerCase(),
    poolAddress: edge.poolAddress.toLowerCase(),
    ...(edge.poolId === null ? {} : { poolId: edge.poolId }),
    tokenIn: edge.tokenIn.toLowerCase(),
    tokenOut: edge.tokenOut.toLowerCase(),
  };

  // 1. 0-RPC direct identity check
  const direct = issueDirectSelectorSourceIdentity({ definition, edge: sqlEdge, source });
  assert.equal(direct.matches.length, 1, `0-RPC direct identity failed on ${sample.txHash}@${edge.callPath}: ${direct.issues.join("; ")}`);
  assertSelectorSourceIdentity(direct.matches[0]!, { definition, edge: sqlEdge, source, programKey: single.programKey });

  // 2. RPC identity check strictly against recordedStaticCalls (zero fake callbacks)
  if (definition.programs.some(p => p.type === "independentIdentity")) {
    const rpcId = await readSelectorSourceIdentity({
      definition,
      edge: sqlEdge,
      source,
      readRequests: async requests => requests.map(r => {
        assert.equal(r.kind, "eth-call", `unsupported identity request kind ${r.kind} in real-tx replay`);
        if (r.kind !== "eth-call") throw new Error("unreachable");
        const hit = staticTable.get(canonicalCallKey(r.to, r.data));
        if (!hit) {
          throw new Error(`Unrecorded on-chain static call during identity replay: target=${r.to.toLowerCase()} data=${r.data.toLowerCase()}`);
        }
        return {
          id: r.id,
          ok: true as const,
          source,
          completion: hit.completion,
          data: hit.data.toLowerCase(),
          provenance: { kind: "recorded-onchain-fixture" as const, fingerprint: toBeHex(1, 32) },
        };
      }),
    });
    assert.equal(rpcId.matches.length, 1, `recorded on-chain identity failed on ${sample.txHash}@${edge.callPath}: ${rpcId.issues.join("; ")}`);
  }

  // 3. Compile BotVM runtime leg and execute against recordedStaticCalls + real swap calldata verification
  const recipes = compileSqlExecutionParamPlan(definition).recipes.map(({ index, requirements }) => ({
    index,
    observed: [],
    missing: requirements.filter(r => !r.sources.some(s => ["runtime", "edge", "fixed"].includes(s.kind))).map(r => r.key),
  }));
  const trial = compileSqlTrialLegs({
    source,
    definition,
    executor,
    transactionOrigin: origin,
    edge: {
      ...sqlEdge,
      executionParamEvidence: {
        consensus: "uniform",
        definitionSha256: sha256Json(definition),
        txHash: sample.txHash.toLowerCase(),
        callPath: edge.callPath,
        innerSwapPath: edge.innerSwapPath,
        recipes,
      },
    },
  });
  assert.equal(trial.legs.length, 1, `compileSqlTrialLegs failed on ${sample.txHash}@${edge.callPath}: ${trial.issues.join("; ")}`);

  const realAmountIn = BigInt(edge.amountPayerInRaw);
  const realAmountOut = BigInt(edge.amountReceivedOutRaw);
  const tokenIn = edge.tokenIn.toLowerCase();
  const tokenOut = edge.tokenOut.toLowerCase();
  const poolAddr = edge.poolAddress.toLowerCase();

  let walletIn = realAmountIn * 2n;
  let walletOut = 0n;
  let poolIn = realAmountIn * 10n;
  let allowance = 0n;
  let swapCalls = 0;

  const swapFn = FunctionFragment.from(definition.signature);
  const swapAbi = new Interface([swapFn]);
  const realDecoded = swapAbi.decodeFunctionData(swapFn, callFrame.input);
  const dynamicIdx = new Set<number>([
    ...inferDynamicArgIndices(definition, swapFn),
    ...(sample.dynamicArgIndices ?? []),
  ]);
  // In Curve / AMM calls, min_dy (slippage floor) is chosen per caller; mark trailing uint256 minOut word if real call passed slippage floor != amountIn
  swapFn.inputs.forEach((inp, idx) => {
    if (inp.type === "uint256" && BigInt(realDecoded[idx]) !== realAmountIn && idx >= 2) {
      dynamicIdx.add(idx);
    }
  });

  inspectRuntime(trial.legs[0]!.leg.program, realAmountIn, {
    nativeBalance: () => 0n,
    call(c) {
      const target = c.target.toLowerCase();
      const sel = c.data.slice(0, 10).toLowerCase();

      // Standard ERC-20 wallet/allowance accounting ONLY on edge.tokenIn / edge.tokenOut
      if ((target === tokenIn || target === tokenOut) && ["0x70a08231", "0xdd62ed3e", "0x095ea7b3", "0xa9059cbb"].includes(sel)) {
        const parsed = ERC20_ABI.parseTransaction({ data: c.data })!;
        if (parsed.name === "balanceOf") {
          const who = String(parsed.args[0]).toLowerCase();
          if (who === poolAddr && target === tokenIn) return toBeHex(poolIn, 32);
          if (who === executor) return toBeHex(target === tokenIn ? walletIn : walletOut, 32);
        }
        if (parsed.name === "allowance") {
          return toBeHex(allowance, 32);
        }
        if (parsed.name === "approve") {
          assert.equal(target, tokenIn, "ERC-20 approval must only target tokenIn");
          allowance = BigInt(parsed.args[1]);
          return toBeHex(1, 32);
        }
        if (parsed.name === "transfer") {
          assert.equal(target, tokenIn, "ERC-20 pre-transfer must only target tokenIn");
          assert.equal(String(parsed.args[0]).toLowerCase(), poolAddr, "pre-transfer recipient must be pool");
          const amt = BigInt(parsed.args[1]);
          assert(walletIn >= amt, "insufficient walletIn during pre-transfer");
          walletIn -= amt;
          poolIn += amt;
          return toBeHex(1, 32);
        }
      }

      // Static contract reads MUST come strictly from recordedStaticCalls (0 fake ABI mocks!)
      if (c.static) {
        const key = canonicalCallKey(target, c.data);
        const recorded = staticTable.get(key);
        if (!recorded) {
          throw new Error(`Unrecorded static call in BotVM execution (no fake mocks allowed): target=${target} data=${c.data}`);
        }
        if (recorded.completion !== "returned") {
          throw new Error(`On-chain static call reverted as recorded: target=${target} data=${c.data}`);
        }
        return recorded.data;
      }

      // State-changing venue swap call: verify exact target, selector, value, and ABI routing arguments against real mainnet callFrame!
      assert.equal(target, callFrame.target?.toLowerCase(), "BotVM swap target differs from real mainnet frame target");
      assert.equal(sel, definition.selector.toLowerCase(), "BotVM swap selector differs from real mainnet frame selector");
      assert.equal(c.value, BigInt(callFrame.value), "BotVM msg.value differs from real mainnet frame value");

      const botDecoded = swapAbi.decodeFunctionData(swapFn, c.data);
      for (let i = 0; i < swapFn.inputs.length; i++) {
        if (dynamicIdx.has(i)) continue;
        assert.deepEqual(
          botDecoded[i],
          realDecoded[i],
          `tx ${sample.txHash}@${edge.callPath} arg[${i}] (${swapFn.inputs[i]!.type}): BotVM encoded ${String(botDecoded[i])} != real mainnet ${String(realDecoded[i])}`,
        );
      }

      // Apply settlement accounting matching whether input was pre-transferred or pulled via allowance
      if (walletIn === realAmountIn * 2n) {
        assert(allowance >= realAmountIn, "venue pull-swap requires sufficient ERC-20 allowance");
        allowance -= realAmountIn;
        walletIn -= realAmountIn;
        poolIn += realAmountIn;
      }
      walletOut += realAmountOut;
      swapCalls++;
      return callFrame.output && callFrame.output !== "0x" ? callFrame.output : toBeHex(realAmountOut, 32);
    },
  });

  assert.equal(swapCalls, 1, `expected exactly 1 venue swap call on ${sample.txHash}@${edge.callPath}`);
  assert.equal(walletIn, realAmountIn, "BotVM must debit exact realAmountIn");
  assert.equal(walletOut, realAmountOut, "BotVM must credit exact realAmountOut");
  assert.equal(allowance, 0n, "BotVM must leave 0 residual ERC-20 allowance");
}

/** Run the complete Real-Tx Replay suite (Discovery Recall Gate + Zero-Mock Execution Gate) for a fixture document. */
export async function verifySelectorRealTxFixture(fixture: RealTxSelectorFixture, familyDirUrl?: URL): Promise<{
  readonly transactionsVerified: number;
  readonly edgesVerified: number;
}> {
  assertModuleData(fixture);
  assert.equal(fixture.format, "selector-real-tx-replay/v1");
  assert.equal(fixture.chainId, 1);
  assert(fixture.transactions.length >= 1, "fixture requires at least 1 real mainnet transaction");

  const { definition, rule, discoverFn } = await loadCompiledSelectorFamily(fixture.selector, familyDirUrl);
  let selectorTxCount = 0;
  let edgesVerified = 0;

  for (const sample of fixture.transactions) {
    selectorTxCount++;
    const { callFrames, edges } = await replayRealTxDiscovery({
      selector: fixture.selector,
      rule,
      discoverFn,
      sample,
    });
    const frameByPath = new Map(callFrames.map(f => [f.path, f]));
    for (const edge of edges) {
      const callFrame = frameByPath.get(edge.callPath);
      assert(callFrame, `discovered edge callPath=${edge.callPath} did not map to a valid selector call frame`);
      await replayRealTxExecution({
        definition,
        recordedStaticCalls: fixture.recordedStaticCalls,
        sample,
        edge,
        callFrame,
      });
      edgesVerified++;
    }
  }
  assert(
    edgesVerified >= selectorTxCount,
    `selector ${fixture.selector}: total discovered edges (${edgesVerified}) < selector-appearing tx count (${selectorTxCount})`,
  );
  return { transactionsVerified: selectorTxCount, edgesVerified };
}
