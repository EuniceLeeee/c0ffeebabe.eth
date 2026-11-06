import assert from "node:assert/strict";
import { AbiCoder, Interface, getAddress } from "ethers";
import { plugin as astra } from "../venues/production-families/astra-multitoken.production.js";
import { plugin as eigenpie } from "../venues/production-families/eigenpie.production.js";
import { createAmbientIoPoisonHarness } from "../venues/blockscan-state-capability.js";

const target = getAddress("0x00000000000000000000000000000000000000a1");
const asset = getAddress("0x00000000000000000000000000000000000000b1");
const receipt = getAddress("0x00000000000000000000000000000000000000b2");
const source = { number: 25_700_456, generation: 1, hash: "0x" + "11".repeat(32) };
const one = 10n ** 18n;
const coder = AbiCoder.defaultAbiCoder();
function returned(id: string, data: string) {
  return { id, data, source, ok: true as const, completion: "returned" as const,
    provenance: { kind: "fixture", fingerprint: "directed-protocol-price" } };
}

export function checkDirectedProtocolPrices() {
  const checked: string[] = [];
  for (const family of [astra, eigenpie]) {
    const isAstra = family === astra;
    const descriptor = { familyId: family.manifest.familyId, lineageId: family.manifest.supportedLineages[0],
      instanceKey: target, target, asset, receipt, registryBinding: { registryContract: target, tokens: [asset, receipt],
        tokenWeights: [asset, receipt].map(token => ({ token, weight: 1n, codeHash: "0x"+"ab".repeat(32) })) },
      behaviorBinding: { interfaceMode: "erc165", changesEnabled: true, totalPercents: 1000000n,
        changeFee: 123n, inLendingMode: 0n, activeProof: "registry-bound-effect-delta" },
      runtimeRequirements: [], provenance: [] };
    const selected = family.routes.project({ descriptor }).find(r => r.tokenIn === asset && r.tokenOut === receipt);
    assert(selected);
    const routes = [selected], pricing = family.pricing;
    const draft = pricing.compileDraft({ descriptor, routes, stateKey: pricing.stateKey(selected) });
    const stat = pricing.staticEvidence!;
    const sr = stat.buildRequests(draft);
    assert.equal(sr.length, 1);
    assert(sr[0].kind === "eth-call" && sr[0].to === asset && sr[0].data === "0x313ce567");
    const staticEvidence = stat.decode({ programInput: draft, results: [returned(sr[0].id, coder.encode(["uint8"], [18]))] });
    const pd = pricing.finalizePricingDescriptor({ draft, staticEvidence, sharedBindings: [] });
    const current = pricing.current;
    const reads = current.buildRequests({ descriptor: pd, routes, source });
    assert.equal(reads.length, 1);
    const req = reads[0]; assert(req.kind === "eth-call" && req.to === target);
    const signature = isAstra ? "function getReturn(address,address,uint256) view returns (uint256)"
      : "function getMLRTAmountToMint(address,uint256) view returns (uint256,address)";
    const abi = new Interface([signature]), fn = isAstra ? "getReturn" : "getMLRTAmountToMint";
    assert.equal(req.data, abi.encodeFunctionData(fn, isAstra ? [asset,receipt,one] : [asset,one]));
    const amountOut = isAstra ? 1_007_000_000_000_000_000n : 1_010_000_000_000_000_000n;
    const decode = (recipient: string) => current.decodeSnapshot({ descriptor: pd, dependentEvidence: [],
      initialResults: [returned(req.id, abi.encodeFunctionResult(fn, isAstra ? [amountOut] : [amountOut, recipient]))] });
    const snap = decode(receipt), purity = createAmbientIoPoisonHarness();
    const derive = () => current.deriveMids({ descriptor: pd, routes, snapshot: snap });
    const mids = purity.withPoisonedIo(derive);
    assert.deepEqual(purity.withPoisonedIo(derive), mids);
    assert.equal(purity.ioCalls(), 0); assert.equal(mids.size, 1);
    assert.equal(mids.get(selected.routeKey)?.mid, isAstra ? 1.007 : 1.01);
    if (!isAstra) assert.throws(() => decode(target));
    checked.push(family.manifest.familyId);
  }
  return checked;
}
