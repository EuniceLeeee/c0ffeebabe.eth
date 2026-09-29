import assert from "node:assert/strict";
import { test } from "node:test";
import { goldxExact } from "../exact.js";
import { goldxInstance } from "../instance.js";
import { goldxRoutes } from "../routes.js";
import { GOLDX_FAMILY_ID, GOLDX_LINEAGE_ID } from "../manifest.js";
import { emptyExactTrialState } from "../../../../exact-trial-state.js";

test("GOLDx declares its unproven transition without manufacturing trial effects or a chain quote", () => {
  const method = goldxExact.methods()[1];
  assert(method.kind === "request-program");
  assert(method.trialState && typeof method.trialState.unsupportedReason === "string");
  assert.match(method.trialState.unsupportedReason, /collateral transfer, mint fee and supply/);
  assert(!("chainAmountQuote" in method), "a unit getter does not produce an amount quote");
  assert(!("quote" in method.trialState), "no false complete-state capability");
  const descriptor = goldxInstance.compileDraft({ familyId: GOLDX_FAMILY_ID, lineageId: GOLDX_LINEAGE_ID,
    subject: "0x2222222222222222222222222222222222222222", provenance: [], unit: 10n ** 18n });
  const route = goldxRoutes.project({ descriptor })[0];
  const input = { descriptor, route, amountIn: 100n, source: { number: 1, hash: `0x${"11".repeat(32)}`, generation: 1 },
    executor: "0x1111111111111111111111111111111111111111", runtimeEvidence: [], trialState: emptyExactTrialState().view };
  assert.throws(() => method.program.buildRequests(input), /unproven/);
  assert.throws(() => method.program.decode({ programInput: input, initialResults: [], dependentEvidence: [] }), /unproven/);
});
