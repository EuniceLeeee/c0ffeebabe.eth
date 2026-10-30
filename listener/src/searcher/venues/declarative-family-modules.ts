import { validateDeclarativeValue } from "./declarative-values.js";
import { validateInstanceEvidence, validateExecutionProjection } from "./declarative-instance-evidence.js";
import { validateDeclarativePricingProjection } from "./declarative-pricing-projection.js";
import { createDeclarativeModuleCatalog, type ModuleBlock } from "./declarative-modules.js";
import { declarativeRuntimeMathRegistry } from "./declarative-runtime-math-models.js";
import type { createDeclarativeRuntimeMathRegistry } from "./declarative-runtime-math.js";
import { declarativeMathRegistry } from "./declarative-math-models.js";
import { quoteProofSteps } from "./declarative-quote-proof.js";
import { validateDeclarativeReadFlow } from "./declarative-read-flow.js";
import { validateDeclarativeTrialState } from "./declarative-trial-state.js";
import { validateDeclarativeOracleVictim } from "./declarative-oracle-victim.js";
import { validateDeclarativeQuoteOutput } from "./declarative-execution.js";
import type { createDeclarativeMathRegistry } from "./declarative-math.js";

export const ROOT_ONLY_FAMILY_MODULES = Object.freeze(["oracleVictim", "instanceEvidence", "executionProjection"] as const);

export interface DeclarativeQuoteFlow extends ModuleBlock {
  readonly sourceKind: "view" | "effect-simulation" | "local-math";
  readonly localStateUnsupportedReason?: string;
  readonly chainQuote?: unknown;
}
/** Only optional extensions live here. Existing v2 required core sections keep
 * their validators. Adding a catalogue entry does not add a startup requirement. */
export function familyModuleCatalog(math: ReturnType<typeof createDeclarativeMathRegistry> = declarativeMathRegistry,
  executionMath: ReturnType<typeof createDeclarativeRuntimeMathRegistry> = declarativeRuntimeMathRegistry) {
  const usesModel = (value: unknown): boolean => !!value && typeof value === "object" &&
    ((value as { op?: unknown }).op === "model" || Object.values(value).some(usesModel));
  const flow = (block: ModuleBlock) => {
    const { sourceKind: _source, localStateUnsupportedReason: _reason, chainQuote: _proof, ...steps } = block;
    validateDeclarativeReadFlow(steps);
  };
  return createDeclarativeModuleCatalog([
    { key: "liveStateProjection", versions: { 1: {
      required: ["result"], validate: block => validateDeclarativeValue(block.result), compile: block => block,
    } } },
    { key: "instanceEvidence", versions: { 1: {
      required: ["reuse", "requirements", "requests", "decode", "checks", "finalize"], validate: validateInstanceEvidence, compile: block => block,
      dependencies: block => usesModel(block) ? ["math"] : [],
    } } },
    { key: "executionProjection", versions: { 1: {
      required: ["result"], validate: validateExecutionProjection, compile: block => block,
    } } },
    { key: "pricingProjection", versions: { 1: {
      required: ["checks", "rows"], validate: validateDeclarativePricingProjection, compile: block => block,
      dependencies: block => ["pricingFlow", ...(usesModel(block) ? ["math"] : [])],
    } } },
    { key: "quoteOutput", versions: { 1: {
      required: ["steps", "result"], validate: validateDeclarativeQuoteOutput, compile: block => block,
      dependencies: block => [
        ...(usesModel(block) ? ["math"] : []),
        ...((block.steps as { math?: unknown }[]).some(step => step.math) ? ["executionMath"] : []),
      ],
    } } },
    { key: "oracleVictim", versions: { 1: {
      required: ["callPatterns", "runtimeDetection", "resultChecks"], optional: ["canonicalIntakeTargets"],
      validate: validateDeclarativeOracleVictim, compile: block => block,
    } } },
    { key: "math", versions: { 1: {
      required: ["entries"], validate: block => { math.bind(block); }, compile: block => math.bind(block),
    } } },
    { key: "executionMath", versions: { 1: {
      required: ["entries"], validate: block => { executionMath.bind(block); }, compile: block => executionMath.bind(block),
    } } },
    { key: "quoteFlow", versions: { 1: {
      required: ["steps", "result", "sourceKind"], optional: ["localStateUnsupportedReason", "chainQuote"],
      validate(block) {
        flow(block);
        if (!["view", "effect-simulation", "local-math"].includes(String(block.sourceKind))) throw new Error("invalid quote source kind");
        if (block.sourceKind === "local-math") {
          if (block.localStateUnsupportedReason !== undefined &&
            (typeof block.localStateUnsupportedReason !== "string" || !block.localStateUnsupportedReason.trim()))
            throw new Error("invalid unsupported sequential trial state reason");
          if (block.chainQuote !== undefined) throw new Error("local math cannot claim a chain quote proof");
        } else {
          if (block.localStateUnsupportedReason !== undefined) throw new Error("chain quote cannot claim local trial state");
          const proofs = quoteProofSteps(block.chainQuote, block.sourceKind as "view" | "effect-simulation");
          let previous = -1;
          for (const proof of proofs) {
            const index = (block.steps as { id: string }[]).findIndex(step => step.id === proof.step);
            if (index < 0) throw new Error("chain quote proof refers to an undefined flow step");
            if (index < previous) throw new Error("chain quote proof is not in flow order");
            previous = index;
          }
        }
      },
      dependencies: block => block.sourceKind === "local-math" || usesModel(block) ? ["math"] : [],
      compile: block => block,
    } } },
    { key: "pricingFlow", versions: { 1: {
      required: ["steps", "result"], validate: flow, compile: block => block,
      dependencies: block => usesModel(block) ? ["math"] : [],
    } } },
    { key: "trialState", versions: { 1: {
      required: ["reads", "model", "input", "amountOut", "stateChanges", "stateEffects"],
      validate: validateDeclarativeTrialState, compile: block => block,
      dependencies: () => ["math", "quoteFlow"],
    } } },
  ]);
}
export function readFamilyModules(root: unknown = {}, variant: unknown = {}, math?: ReturnType<typeof createDeclarativeMathRegistry>, executionMath?: ReturnType<typeof createDeclarativeRuntimeMathRegistry>) {
  const catalog = familyModuleCatalog(math, executionMath);
  // Validate both before overlaying: an unknown or invalid inherited definition
  // cannot be hidden by a child. Empty child blocks are explicit undefinition.
  const base = catalog.read(root), child = catalog.read(variant);
  if (ROOT_ONLY_FAMILY_MODULES.some(key => Object.hasOwn(variant as object, key)))
    throw new Error("oracleVictim/instanceEvidence/executionProjection is a root-only module; variants cannot override it");
  const result = catalog.read({ ...base.blocks, ...Object.fromEntries(Object.keys(variant as object).map(key => [key, child.blocks[key]])) });
  if (Object.keys(result.blocks.trialState!).length && Object.keys(result.blocks.quoteFlow!).length && result.blocks.quoteFlow!.sourceKind !== "local-math")
    throw new Error("trial state requires a local-math quote flow");
  return result;
}
