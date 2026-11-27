import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Interface, ZeroAddress, toBeHex } from "ethers";
import { compileSelectorExecutionSource } from "../build-selector-execution-source.js";
import { readSelectorDiscoveryRuleHash } from "../venues/selector-discovery-rule-hash.js";
import { normalizeSelectorNativeExecutionDefinition as normalize } from "../venues/selector-native-definition.js";
import { selectSingleExecution } from "../venues/selector-program-role.js";
import { compileSqlExecutionParamPlan } from "../venues/selector-native-execution-param-plan.js";
import { compileSqlTrialLegs } from "../venues/selector-native-sql-trial.js";
import { readSelectorSourceIdentity, issueDirectSelectorSourceIdentity, assertSelectorSourceIdentity } from "../venues/selector-source-identity.js";

const H = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const addr = (n: number) => toBeHex(n, 20);
const asset = addr(11), receipt = addr(12), pool = addr(13), executor = addr(14), origin = addr(15);
const source = { number: 26500000, generation: 26500000, hash: toBeHex(26500000, 32) };

const BATCH1 = [
  { tag: "6e553f65", dirId: "deposit", tokenIn: asset, tokenOut: pool, getterSig: "function asset() view returns (address)", getterAns: [asset] },
  { tag: "94bf804d", dirId: "mint", tokenIn: asset, tokenOut: pool, getterSig: "function asset() view returns (address)", getterAns: [asset] },
  { tag: "5dbd6059", dirId: "unwrap-to", tokenIn: pool, tokenOut: asset, getterSig: "function token() view returns (address)", getterAns: [asset] },
  { tag: "de0e9a3e", dirId: "unwrap", tokenIn: pool, tokenOut: asset, getterSig: "function token() view returns (address)", getterAns: [asset] },
  { tag: "ea598cb0", dirId: "wrap", tokenIn: asset, tokenOut: pool, getterSig: "function token() view returns (address)", getterAns: [asset] },
  { tag: "db006a75", dirId: "redeem", tokenIn: pool, tokenOut: asset, getterSig: "function underlying() view returns (address)", getterAns: [asset] },
  { tag: "2ebe07c8", dirId: "deposit-asset", tokenIn: asset, tokenOut: receipt, getterSig: "function getMLRTAmountToMint(address, uint256) view returns (uint256, address)", getterAns: [100n, receipt] },
] as const;

for (const spec of BATCH1) {
  test(`protocol family 0x${spec.tag} compiles to single execution + independent identity and issues 0-RPC & RPC bindings`, async () => {
    const dirUrl = new URL(`../venues/selector-native/selector-${spec.tag}-family/`, import.meta.url);
    const execSrc = JSON.parse(readFileSync(new URL("execution.source.json", dirUrl), "utf8"));
    const idSrc = JSON.parse(readFileSync(new URL("identity.source.json", dirUrl), "utf8"));
    const generated = JSON.parse(readFileSync(new URL(`selector-${spec.tag}.json`, dirUrl), "utf8"));
    const ruleHash = await readSelectorDiscoveryRuleHash(dirUrl, new URL("../../../../scripts/", import.meta.url));
    const compiled = compileSelectorExecutionSource(execSrc, ruleHash, idSrc);
    assert.deepEqual(generated, compiled);

    const def = normalize(compiled);
    const single = selectSingleExecution(def);
    assert.equal(single.program.type, "execution");
    assert.equal(single.program.binding, undefined);
    assert.equal(def.programs.filter(p => p.type === "independentIdentity").length, 1);

    const edge = {
      chainId: 1 as const,
      selector: `0x${spec.tag}`,
      poolAddress: pool,
      tokenIn: spec.tokenIn,
      tokenOut: spec.tokenOut,
    };

    // 1. 0-RPC direct binding
    const direct = issueDirectSelectorSourceIdentity({ definition: def, edge, source });
    assert.equal(direct.matches.length, 1, direct.issues.join("; "));
    assertSelectorSourceIdentity(direct.matches[0]!, { definition: def, edge, source, programKey: single.programKey });

    // 2. Trial leg compilation
    const recipes = compileSqlExecutionParamPlan(def).recipes.map(({ index, requirements }) => ({
      index,
      observed: [],
      missing: requirements.filter(r => !r.sources.some(s => ["runtime", "edge", "fixed"].includes(s.kind))).map(r => r.key),
    }));
    const trial = compileSqlTrialLegs({
      source,
      definition: def,
      executor,
      transactionOrigin: origin,
      edge: {
        ...edge,
        executionParamEvidence: {
          consensus: "uniform",
          definitionSha256: H(def),
          txHash: toBeHex(999, 32),
          callPath: "",
          innerSwapPath: null,
          recipes,
        },
      },
    });
    assert.equal(trial.legs.length, 1, trial.issues.join("; "));
    assert(trial.legs[0]!.leg.program.toLowerCase().includes(spec.tag));

    // 3. Independent RPC identity confirmation + rejection of wrong/zero asset
    const iface = new Interface([spec.getterSig]);
    const fn = iface.fragments[0] as any;
    const okRes = await readSelectorSourceIdentity({
      definition: def,
      edge,
      source,
      readRequests: async requests => {
        assert.equal(requests.length, 1);
        return requests.map(r => ({
          id: r.id,
          ok: true as const,
          source,
          completion: "returned" as const,
          data: iface.encodeFunctionResult(fn, spec.getterAns),
          provenance: { kind: "local-fixture" as const, fingerprint: toBeHex(1, 32) },
        }));
      },
    });
    assert.equal(okRes.matches.length, 1, okRes.issues.join("; "));
    assert.equal(okRes.matches[0]!.direction, spec.dirId);

    const badAns = spec.getterAns.length === 2 ? [100n, ZeroAddress] : [ZeroAddress];
    const badRes = await readSelectorSourceIdentity({
      definition: def,
      edge,
      source,
      readRequests: async requests => requests.map(r => ({
        id: r.id,
        ok: true as const,
        source,
        completion: "returned" as const,
        data: iface.encodeFunctionResult(fn, badAns),
        provenance: { kind: "local-fixture" as const, fingerprint: toBeHex(2, 32) },
      })),
    });
    assert.equal(badRes.matches.length, 0);
  });
}
