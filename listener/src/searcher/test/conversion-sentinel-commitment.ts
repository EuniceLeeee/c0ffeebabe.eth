import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  BLIND_SCHEMA_VERSION,
  canonicalJson,
  conversionSeedCommitment,
  revealConversionSelection,
  validateConversionEligibilityPlan,
  type ConversionCandidate,
  type ConversionEligibilityPlan,
} from "./adapter-family-blind-contract.js";

interface ConversionPlanInput {
  readonly range: ConversionEligibilityPlan["range"];
  readonly predicateVersion: string;
  readonly predicateSha256: string;
  readonly productionInputsSha256: string;
  readonly minEligibleCardinality: number;
  readonly selectionAlgorithm: ConversionEligibilityPlan["selectionAlgorithm"];
}

interface ConversionSecret {
  readonly seed: string;
  readonly salt: string;
}

export function buildConversionEligibilityPlan(
  input: ConversionPlanInput,
  secret: ConversionSecret,
): ConversionEligibilityPlan {
  const plan: ConversionEligibilityPlan = {
    schemaVersion: BLIND_SCHEMA_VERSION,
    profile: "conversion-freshness-selection-v1",
    ...input,
    seedCommitment: conversionSeedCommitment({
      seed: secret.seed,
      salt: secret.salt,
      rangeHash: input.range.rangeHash,
      predicateSha256: input.predicateSha256,
      productionInputsSha256: input.productionInputsSha256,
    }),
  };
  validateConversionEligibilityPlan(plan);
  return plan;
}

function parseNamedArgs(args: readonly string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value) throw new Error(`${name} requires a value`);
    parsed[name] = value;
  }
  return parsed;
}

function required(args: Record<string, string>, name: string): string {
  const value = args[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readSecret(path: string): ConversionSecret {
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ConversionSecret>;
  if (!value.seed || !value.salt) throw new Error("secret file must contain seed and salt");
  return { seed: value.seed, salt: value.salt };
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseNamedArgs(rest);
  if (command === "commit") {
    const input = JSON.parse(
      readFileSync(required(args, "--plan-input"), "utf8"),
    ) as ConversionPlanInput;
    const plan = buildConversionEligibilityPlan(
      input,
      readSecret(required(args, "--secret-file")),
    );
    writeFileSync(required(args, "--out"), `${canonicalJson(plan)}\n`, { mode: 0o644 });
    console.log(`CONVERSION_SEED_COMMITMENT=${plan.seedCommitment}`);
    return;
  }
  if (command === "reveal") {
    const plan = JSON.parse(
      readFileSync(required(args, "--plan"), "utf8"),
    ) as ConversionEligibilityPlan;
    const candidates = JSON.parse(
      readFileSync(required(args, "--candidates"), "utf8"),
    ) as ConversionCandidate[];
    const secret = readSecret(required(args, "--secret-file"));
    const result = revealConversionSelection({ plan, candidates, ...secret });
    writeFileSync(required(args, "--out"), `${canonicalJson({
      schemaVersion: BLIND_SCHEMA_VERSION,
      profile: "conversion-freshness-selection-reveal-v1",
      plan,
      reveal: secret,
      ...result,
    })}\n`, { mode: 0o600 });
    console.log(
      `CONVERSION_SELECTION=${result.freshnessEvidence}:` +
        `${result.selected?.id ?? "missing"}`,
    );
    if (result.freshnessEvidence === "missing") process.exitCode = 2;
    return;
  }
  throw new Error(
    "usage: commit --plan-input <json> --secret-file <json> --out <plan.json> | " +
      "reveal --plan <json> --candidates <json> --secret-file <json> --out <reveal.json>",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
