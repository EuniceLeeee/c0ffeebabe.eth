import assert from "node:assert/strict";
import { plugin } from
  "../../../production-families/algebra-integral.production.js";
import {
  ALGEBRA_DYNAMIC_FEE_UNSUPPORTED,
  ALGEBRA_REVERSE_BINDING_FAILED,
  ALGEBRA_STATIC_BINDING_MISMATCH,
  ALGEBRA_STATIC_FEE_BINDING_FAILED,
} from "../identity.js";
import {
  answerFor,
  candidateFor,
  decisionWith,
  EXECUTOR,
  MEASURED_INSTANCES,
  SOURCE,
  STATIC_FEE_FACTS,
} from "./fixtures.js";

/**
 * Family-local runtime audit over the six measured instances.
 *
 * The supported variant is refused for all six (each sets the plugin
 * `DYNAMIC_FEE` bit, and the executed `overrideFee` was measured to differ from
 * the pool's `fee()` view), so every row must end as an EXPLICIT identity-time
 * refusal with a documented reason code. The audit exits 1 if any row is
 * admitted and then fails downstream, or if a refusal carries an undocumented
 * code, or if a row ends in an undefined state. Admission never depends on a
 * hardcoded instance list: the variant decision is made from the chain reads.
 */
const DOCUMENTED_REFUSALS = new Set([
  ALGEBRA_DYNAMIC_FEE_UNSUPPORTED,
  ALGEBRA_STATIC_FEE_BINDING_FAILED,
  ALGEBRA_REVERSE_BINDING_FAILED,
  ALGEBRA_STATIC_BINDING_MISMATCH,
]);

interface Row {
  readonly pool: string;
  readonly outcome: string;
  readonly detail: string;
  readonly failed: boolean;
}

const rows: Row[] = [];

for (const instance of MEASURED_INSTANCES) {
  const facts = { ...STATIC_FEE_FACTS, ...instance, unlocked: true };
  let row: Row;
  try {
    const decision = decisionWith(answerFor({ facts }), candidateFor(facts));
    if (decision.status === "verified") {
      const descriptor = plugin.instance.finalizeDescriptor({
        identity: decision.identity,
        draft: plugin.instance.compileDraft(decision.identity),
        sharedBindings: [],
      });
      const routes = plugin.routes.project({ descriptor });
      let quoted = 0n;
      let program = 0;
      for (const route of routes) {
        const input = {
          descriptor,
          route,
          amountIn: 1_000n,
          source: SOURCE,
          executor: EXECUTOR,
          runtimeEvidence: [],
        };
        const method = plugin.exact.methods(input as never)[1]!;
        assert.equal(method.kind, "request-program");
        if (method.kind !== "request-program") throw new Error("missing exact program");
        const requested = method.program.buildRequests(input as never);
        const reply = answerFor({ facts });
        const result = method.program.decode({
          programInput: input as never,
          initialResults: requested.map(reply),
          dependentEvidence: [],
        } as never);
        if (result.amountOut <= 0n) {
          throw new Error(`route ${route.direction} produced no quote`);
        }
        quoted += result.amountOut;
        assert(plugin.execution.buildRuntimeLeg, "runtime execution must be implemented");
        const leg = plugin.execution.buildRuntimeLeg(input as never);
        if (leg === null || leg.program.length <= 2) {
          throw new Error(`route ${route.direction} produced no runtime leg`);
        }
        program += 1;
      }
      row = {
        pool: instance.pool,
        outcome: "admitted",
        detail: `routes=${routes.length} quoted=${quoted} legs=${program}`,
        failed: false,
      };
    } else if (decision.status === "chain-proven-rejected") {
      const code = (decision as { reasonCode: string }).reasonCode;
      row = {
        pool: instance.pool,
        outcome: `refused:${code}`,
        detail: `pluginConfig=${instance.pluginConfig} feeView=${instance.feeView} lastFee=${instance.lastFee}`,
        failed: !DOCUMENTED_REFUSALS.has(code),
      };
    } else {
      row = {
        pool: instance.pool,
        outcome: decision.status,
        detail: JSON.stringify(decision),
        failed: true,
      };
    }
  } catch (error) {
    row = {
      pool: instance.pool,
      outcome: "error",
      detail: error instanceof Error ? error.message : String(error),
      failed: true,
    };
  }
  rows.push(row);
}

for (const row of rows) {
  console.log(`${row.failed ? "FAIL" : "ok  "} ${row.pool} ${row.outcome} ${row.detail}`);
}

const admitted = rows.filter((row) => row.outcome === "admitted").length;
const refused = rows.filter((row) => row.outcome.startsWith("refused:")).length;
console.log(
  `algebra-integral runtime audit: ${rows.length} measured instances, ${admitted} admitted, ${refused} refused at identity, ${rows.filter((row) => row.failed).length} failed`,
);

if (rows.some((row) => row.failed)) {
  process.exitCode = 1;
}
