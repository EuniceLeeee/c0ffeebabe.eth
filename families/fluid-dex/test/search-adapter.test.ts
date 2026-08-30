import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeCanonicalJson,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { erc20AssetRefV1 } from "../../../packages/asset-ref/src/index.ts";
import { asOwnerRef } from "../../../packages/capability-contracts/src/index.ts";
import { familyCandidateKey } from "../../../packages/discovery/src/index.ts";
import { decodePackedCallProgram } from "../../../packages/execution-program/src/index.ts";
import type { FamilySearchSourceReadPortV1 } from "../../../packages/family-sdk/search-runtime/index.ts";
import {
  FLUID_DEX_ACTION_PORT,
} from "../src/action.ts";
import {
  encodeFluidDexApproveCall,
  FLUID_DEX_MAX_UINT256,
  FLUID_DEX_QUOTE_RECIPIENT,
  FLUID_DEX_SWAP_RESULT_SELECTOR,
} from "../src/abi.ts";
import { FLUID_DEX_FAMILY_DEFINITION_HASH } from "../src/family-definition.ts";
import { FLUID_DEX_FAMILY_ID } from "../src/manifest.ts";
import { FLUID_DEX_SEARCH_RUNTIME_ADAPTER_FACTORY } from "../src/search-adapter.ts";
import {
  FLUID_DEX_CONTRACT_PATTERN,
  decodeFluidDexCandidate,
  deriveFluidDexRoutes,
  nominateFluidDex,
  verifyFluidDexIdentityStage,
} from "../src/stages.ts";

const address = (digit: string) => `0x${digit.repeat(40)}`;
const h = (value: string): Hash => hashDomain("aloha/fluid-dex/search-adapter-test/v1", value);
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const addressWord = (value: string) => value.slice(2).padStart(64, "0");
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const pool = address("5");
const token0 = address("1");
const token1 = address("2");
const recipient = address("8");
const amountIn = "100";
const amountOut = "97";
const quoteRevertData = `${FLUID_DEX_SWAP_RESULT_SELECTOR}${word(BigInt(amountOut))}`;

const candidate = nominateFluidDex(decodeFluidDexCandidate({
  kind: "log",
  target: pool,
  blockNumber: cutoff.number,
  blockHash: cutoff.hash,
  txHash: h("tx"),
  logIndex: "0",
  topic: "0xdc004dbca4ef9c966218431ee5d9133d337ad018dd5b5c5493722803f75c64f7",
  rawLocatorHash: h("raw"),
  cutoff,
}, FLUID_DEX_CONTRACT_PATTERN)!);
assert.equal(candidate.status, "nominated");
if (candidate.status !== "nominated") throw new Error("Fluid test nomination failed");
const identityResult = verifyFluidDexIdentityStage({
  candidate: candidate.candidate,
  reads: { cutoff, target: pool, reverseTarget: pool, inputAsset: token0, outputAsset: token1 },
});
assert.equal(identityResult.status, "verified");
if (identityResult.status !== "verified") throw new Error("Fluid test identity failed");
const identity = identityResult.identity;
const protocolRoute = deriveFluidDexRoutes(identity)[0]!;

const memo = {
  kind: "fluid-dex-identity-memo" as const,
  version: 1 as const,
  familyId: FLUID_DEX_FAMILY_ID,
  familyDefinitionHash: FLUID_DEX_FAMILY_DEFINITION_HASH,
  familyCandidateKey: familyCandidateKey(FLUID_DEX_FAMILY_DEFINITION_HASH, pool),
  instanceNominationKey: pool,
  candidateSnapshotHash: identity.candidateSnapshotHash,
  candidateEvidenceRoot: h("candidate-evidence"),
  identity,
};
const identityMemo = decodeCanonicalJson(encodeCanonicalJson(memo)) as CanonicalJson;
const route = Object.freeze({
  familyId: FLUID_DEX_FAMILY_ID,
  familyDefinitionHash: FLUID_DEX_FAMILY_DEFINITION_HASH,
  instanceKey: pool,
  identityMemo,
  identityMemoHash: hashDomain("aloha/identity-memo/v1", identityMemo),
  instancePublicationHash: h("publication"),
  staticProjectionMemoHash: h("static-memo"),
  requestedArtifactDependencyRoot: h("dependencies"),
  staticProjectionHash: h("static-projection"),
  projectionHash: h("projection"),
  authoritySessionHash: h("authority"),
});
const amount = Object.freeze({
  inputAssetRef: erc20AssetRefV1("1", protocolRoute.inputAsset),
  outputAssetRef: erc20AssetRefV1("1", protocolRoute.outputAsset),
  amountIn,
  recipient,
});
const execution = Object.freeze({ transactionOrigin: address("7"), executorAddress: amount.recipient });
const objectivePayload = Object.freeze({ kind: "search-objective", numeraire: amount.outputAssetRef });
const objective = Object.freeze({ objectiveRef: hashDomain("aloha/search-objective/v1", objectivePayload), payload: objectivePayload });

const constants = `0x${[
  word(1n),
  ...Array.from({ length: 8 }, () => word(0n)),
  addressWord(token0),
  addressWord(token1),
  ...Array.from({ length: 7 }, () => word(0n)),
].join("")}`;
const read: FamilySearchSourceReadPortV1["read"] = ({ request }) => {
  if (request.data === "0xb7791bf2") return Object.freeze({ kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: constants });
  if (request.data.startsWith("0x2668dfaa")) {
    assert.equal(request.data.slice(-40), FLUID_DEX_QUOTE_RECIPIENT.slice(2));
    assert.deepEqual(request.declaredRevertData, { kind: "declared-revert-data", dataEncoding: "abi-fluid-dex-swap-result-error", selector: FLUID_DEX_SWAP_RESULT_SELECTOR, byteLength: 36 });
    return Object.freeze({ kind: "reverted" as const, reasonCode: "declared-revert-data" as const, requestId: request.requestId, source: request.source, rpcErrorCode: -32000, dataEncoding: "abi-fluid-dex-swap-result-error" as const, dataHex: quoteRevertData });
  }
  throw new Error(`unexpected Fluid read ${request.data.slice(0, 10)}`);
};
const readPort: FamilySearchSourceReadPortV1 = Object.freeze({ read });

function adapterInput() {
  return {
    familyDefinitionHash: FLUID_DEX_FAMILY_DEFINITION_HASH,
    capabilityRefs: {},
    actionOwnerRefs: { action: asOwnerRef(h("action-owner")) },
    composition: { resolveCapability: () => ({}), resolveActionOwner: () => FLUID_DEX_ACTION_PORT },
  };
}

test("Fluid generated action owner binds full program and effects into the action artifact", async () => {
  const adapter = FLUID_DEX_SEARCH_RUNTIME_ADAPTER_FACTORY(adapterInput());
  const result = await adapter.run({ route, currentSource: { source: cutoff, assertCurrent() {} }, objective, amount, execution, readPort });
  assert.equal(result.kind, "verified");
  if (result.kind !== "verified") return;
  const artifact = result.artifact.action;
  const ownerAction = FLUID_DEX_ACTION_PORT.decode(artifact.payload);
  assert.equal(artifact.actionHash, ownerAction.actionHash);
  assert.equal(artifact.opaqueBytes, ownerAction.opaqueBytes);
  assert.deepEqual(artifact.effectTransport, ownerAction.effectTransport);
  assert.equal(artifact.payloadHash, hashDomain("aloha/family-search-payload/v1", { kind: "action", payload: artifact.payload }));
  const statePayload = result.artifact.state.payload as Record<string, unknown>;
  assert.equal(statePayload.quoteCompletion, "reverted-as-declared");
  assert.equal(statePayload.quoteRpcErrorCode, -32000);
  const calls = decodePackedCallProgram(artifact.opaqueBytes);
  assert.deepEqual(calls, [
    { target: token0, value: "0", calldata: encodeFluidDexApproveCall(pool, 0n) },
    { target: token0, value: "0", calldata: encodeFluidDexApproveCall(pool, FLUID_DEX_MAX_UINT256) },
    { target: pool, value: "0", calldata: ownerAction.rawAction.calldata },
  ]);
  assert.deepEqual(artifact.effectTransport?.observeTokenBalances, [
    { token: token0, account: { kind: "observed-sender" } },
    { token: token0, account: recipient },
    { token: token0, account: pool },
    { token: token1, account: pool },
    { token: token1, account: recipient },
    { token: token1, account: { kind: "observed-sender" } },
  ]);
  assert.equal(artifact.effectTransport?.observeLogs, true);
});

test("Fluid quote accepts only its declared revert outcome, never an ordinary return or unknown error", async () => {
  const adapter = FLUID_DEX_SEARCH_RUNTIME_ADAPTER_FACTORY(adapterInput());
  const runWithQuote = (quote: FamilySearchSourceReadPortV1["read"]) => adapter.run({
    route,
    currentSource: { source: cutoff, assertCurrent() {} },
    objective,
    amount,
    execution,
    readPort: Object.freeze({
      read: (input: Parameters<FamilySearchSourceReadPortV1["read"]>[0]) => input.request.data === "0xb7791bf2"
        ? Object.freeze({ kind: "returned" as const, requestId: input.request.requestId, source: input.request.source, dataHex: constants })
        : quote(input),
    }),
  });

  const returned = await runWithQuote(({ request }) => Object.freeze({ kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: `0x${word(BigInt(amountOut))}` }));
  assert.equal(returned.kind, "unavailable");

  const unknown = await runWithQuote(({ request }) => Object.freeze({ kind: "reverted" as const, reasonCode: "declared-revert-data" as const, requestId: request.requestId, source: request.source, rpcErrorCode: 3, dataEncoding: "abi-fluid-dex-swap-result-error" as const, dataHex: `0xdeadbeef${word(BigInt(amountOut))}` }));
  assert.equal(unknown.kind, "invalidProgram");

  const foreign = await runWithQuote(({ request }) => Object.freeze({ kind: "reverted" as const, reasonCode: "declared-revert-data" as const, requestId: h("foreign-request"), source: request.source, rpcErrorCode: 3, dataEncoding: "abi-fluid-dex-swap-result-error" as const, dataHex: quoteRevertData }));
  assert.equal(foreign.kind, "unavailable");
});

test("Fluid adapter rejects a shape-compatible but non-generated action owner", () => {
  assert.throws(() => FLUID_DEX_SEARCH_RUNTIME_ADAPTER_FACTORY({
    ...adapterInput(),
    composition: { resolveCapability: () => ({}), resolveActionOwner: () => ({ ...FLUID_DEX_ACTION_PORT }) },
  }), /identity mismatch/);
});
