import { getAddress, isHexString } from "ethers";
import type { StaticEvidenceProgram } from "./adapter-request-program.js";
import { assertSource } from "./protocols/standard-family/common.js";
import { assertDeclarativeExecutionSource } from "./declarative-execution.js";
import { RequiredAdapterRequestError } from "./adapter-request-failure.js";
import type { ExecutionRuntimeProjection } from "./adapter-family-plugin.js";
import { validateDeclarativeValue, validateDeclarativeStatements, type compileDeclarativeValues } from "./declarative-values.js";
type Data = Record<string, any>;
type Values = ReturnType<typeof compileDeclarativeValues>;
export function validateInstanceEvidence(block: Data): void {
  if (!block.reuse || !["source-local", "dependency-proof"].includes(block.reuse.kind) ||
      Object.keys(block.reuse).some(key => !["kind", "dependencies"].includes(key)) ||
      (block.reuse.kind === "source-local" ? block.reuse.dependencies !== undefined : block.reuse.dependencies === undefined))
    throw new Error("invalid instance evidence reuse");
  validateDeclarativeStatements(block.decode); validateDeclarativeStatements(block.checks);
  validateDeclarativeValue(block);
}
export function compileInstanceEvidence(block: Data, values: Values): StaticEvidenceProgram<Data, unknown> {
  validateInstanceEvidence(block);
  const environment = (draft: Data) => ({ draft });
  const requests = (draft: Data) => {
    const rows = values.evaluate(block.requests, environment(draft));
    if (!Array.isArray(rows) || !rows.length || new Set(rows.map(r => r.id)).size !== rows.length) throw new Error("invalid instance evidence requests");
    return rows;
  };
  return {
    reusePolicy: block.reuse.kind === "source-local" ? { kind: "source-local" } : {
      kind: "dependency-proof", dependencyKeys: draft => values.evaluate(block.reuse.dependencies, environment(draft)).map(getAddress),
    },
    requirements: draft => values.evaluate(block.requirements, environment(draft)),
    buildRequests: requests,
    decode({ programInput: draft, results }) {
      const expected = requests(draft);
      if (results.length !== expected.length || new Set(results.map(r => r.id)).size !== results.length ||
          results.some(r => !expected.some(e => e.id === r.id))) throw new Error("instance evidence result coverage mismatch");
      const source = results[0]?.source;
      assertDeclarativeExecutionSource(source);
      for (const result of results) {
        assertSource(result.source, source!);
        if (!result.ok && expected.find(request => request.id === result.id).required !== false) throw new RequiredAdapterRequestError(result);
      }
      return values.run(block.decode, { draft, results, source });
    },
  };
}
export function validateExecutionProjection(block: Data): void { validateDeclarativeValue(block.result); }
export function executionProjection(value: any): ExecutionRuntimeProjection {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, "allowanceSpender") || !Array.isArray(value.prewarmQuoteCalls)) throw new Error("invalid execution projection");
  const allowanceSpender = value.allowanceSpender === null ? null : getAddress(value.allowanceSpender);
  const prewarmQuoteCalls = value.prewarmQuoteCalls.map((call: Data) => {
    if (Object.keys(call).length !== 4 || !["from", "to", "calldata", "gasLimit"].every(k => Object.hasOwn(call, k)) ||
        !isHexString(call.calldata, true) || !Number.isSafeInteger(call.gasLimit) || call.gasLimit <= 0) throw new Error("invalid prewarm declaration");
    return Object.freeze({ from: getAddress(call.from), to: call.to === "" ? "" : getAddress(call.to), calldata: call.calldata, gasLimit: call.gasLimit });
  });
  return Object.freeze({ allowanceSpender, prewarmQuoteCalls: Object.freeze(prewarmQuoteCalls) });
}
