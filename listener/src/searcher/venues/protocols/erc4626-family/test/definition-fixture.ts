// Unit-test fixtures for the public JSON interpreters. Never imported by production.
import { compileDeclarativeValues } from "../../../declarative-values.js";
import { normalizeDeclarativeVariant } from "../../../declarative-variant.js";
import { buildDeclarativeExecutionProgram,
  type DeclarativeConversionExecution } from "../../../declarative-execution.js";

export function definitionValues(raw: Parameters<typeof normalizeDeclarativeVariant>[0]) {
  return compileDeclarativeValues(normalizeDeclarativeVariant(raw));
}

export function definitionProgram(
  raw: Parameters<typeof normalizeDeclarativeVariant>[0],
  input: Record<string, unknown>,
) {
  const definition = normalizeDeclarativeVariant(raw);
  return buildDeclarativeExecutionProgram(
    definition.execution as DeclarativeConversionExecution,
    {
      // Synthetic VM-host fixtures have no RPC state. Keep source validation
      // enabled; this anchor is not historical evidence or an admission proof.
      source: { number: 0, generation: 0, hash: `0x${"00".repeat(32)}` },
      runtimeEvidence: [],
      ...input,
    },
    compileDeclarativeValues(definition),
  );
}
