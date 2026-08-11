import assert from "node:assert/strict";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "../venues/production-family-composition.js";
import { METRONOME_HGUSDC_FAMILY_ID } from
  "../venues/protocols/metronome-hgusdc-family/manifest.js";
import { METRONOME_HGUSDC_PATH } from
  "../../adapters/metronome-hgusdc.js";
import {
  METRONOME_HGUSDC_BINDINGS,
  METRONOME_HGUSDC_CURVE_INTERFACE,
  METRONOME_HGUSDC_ERC20_INTERFACE,
  METRONOME_HGUSDC_ROUTER_INTERFACE,
  METRONOME_HGUSDC_VAULT_INTERFACE,
} from "../venues/protocols/metronome-hgusdc-family/shared.js";
import { executeAdapterFamilyLifecycleBatch } from
  "../venues/adapter-family-runtime.js";
import { createBoundedRequestExecutor } from
  "../venues/adapter-request-program.js";
import type {
  AdapterRequest,
  AdapterRequestResult,
  CanonicalSource,
} from "../venues/adapter-request-program.js";
import type {
  CentralAdapterRuntime,
  CentralAdapterScheduler,
} from "../adapter-work-intent.js";

const ROUTER = `0x${"99".repeat(20)}`;
const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_500,
  hash: `0x${"51".repeat(32)}`,
  generation: 50,
});

function successResult(
  request: AdapterRequest,
  source: CanonicalSource,
): AdapterRequestResult {
  const data = request.kind === "get-code"
    ? "0x00"
    : request.id === "identity-curve-coin-0"
    ? METRONOME_HGUSDC_CURVE_INTERFACE.encodeFunctionResult("coins", [
        METRONOME_HGUSDC_BINDINGS.curveIntermediate,
      ])
    : request.id === "identity-curve-coin-1"
    ? METRONOME_HGUSDC_CURVE_INTERFACE.encodeFunctionResult("coins", [
        METRONOME_HGUSDC_BINDINGS.tokenIn,
      ])
    : request.id === "identity-vault-asset"
    ? METRONOME_HGUSDC_VAULT_INTERFACE.encodeFunctionResult("asset", [
        METRONOME_HGUSDC_BINDINGS.tokenOut,
      ])
    : request.id === "identity-token-in-decimals" ||
        request.id === "static-token-in-decimals"
    ? METRONOME_HGUSDC_ERC20_INTERFACE.encodeFunctionResult("decimals", [6])
    : request.id.endsWith("curve-quote")
    ? (() => {
        const dx = BigInt(METRONOME_HGUSDC_CURVE_INTERFACE.decodeFunctionData(
          "get_dy",
          (request as { readonly data: string }).data,
        )[2]);
        return METRONOME_HGUSDC_CURVE_INTERFACE.encodeFunctionResult(
          "get_dy",
          [dx],
        );
      })()
    : request.id.endsWith("vault-preview")
    ? (() => {
        const shares = BigInt(METRONOME_HGUSDC_VAULT_INTERFACE.decodeFunctionData(
          "previewRedeem",
          (request as { readonly data: string }).data,
        )[0]);
        return METRONOME_HGUSDC_VAULT_INTERFACE.encodeFunctionResult(
          "previewRedeem",
          [shares],
        );
      })()
    : (() => {
        throw new Error(`unexpected metronome-hgusdc fixture request ${request.id}`);
      })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

const scheduler: CentralAdapterScheduler = {
  issueExecutor(input) {
    const executor = createBoundedRequestExecutor({
      assertSupported(requirements) {
        assert.deepEqual(requirements, input.requirements);
      },
      assertCallerBinding() {},
      assertWithinBudget() {},
      execute: async (execution) => execution.requests.map(
        (request) => successResult(request, execution.source),
      ),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 1, transportWallMs: 2, attempts: 1 }),
    });
  },
};

const runtime: CentralAdapterRuntime = {
  clock: { nowMs: () => 1_000 },
  generationFence: { assertCurrent() {} },
  callerAuthority: { bind: () => ({}) },
  policy: {
    bind: (input) => ({
      lane: "background" as const,
      deadlineAtMs: 100_000,
      maxAttempts: 1,
      transportPool: "state-read" as const,
      fairnessKey: input.subjectKey,
    }),
  },
  budgets: { assertAdmitted() {} },
  scheduler,
};

async function main(): Promise<void> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    METRONOME_HGUSDC_FAMILY_ID,
  );
  const calldata = METRONOME_HGUSDC_ROUTER_INTERFACE.encodeFunctionData(
    "executePath",
    [METRONOME_HGUSDC_PATH, [1_000_000n], `0x${"ee".repeat(20)}`],
  );
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [Object.freeze({
      matchedPatternId: "metronome-hgusdc-execute-path",
      observation: Object.freeze({
        kind: "call" as const,
        source: SOURCE,
        target: ROUTER,
        data: calldata,
      }),
    })],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime,
    publisher: { publish() {} },
  });
  assert(result.publication !== null, "metronome-hgusdc lifecycle must publish");
  assert(result.outcomes.some((outcome) =>
    outcome.stage === "identity" && outcome.status === "verified"
  ));
  console.log("metronome-hgusdc lifecycle smoke PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
