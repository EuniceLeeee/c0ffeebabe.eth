export type BlockScanPricingSourceMode = "n" | "n-1";

export interface ResolvedBlockScanPricingSourceMode {
  readonly mode: BlockScanPricingSourceMode;
  readonly source: "cli" | "environment" | "default";
}

const FLAG = "--blockscan-pricing-source";

function parseMode(value: string): BlockScanPricingSourceMode {
  if (value === "n" || value === "n-1") return value;
  throw new Error(
    `${FLAG} must be exactly "n" or "n-1", received ${JSON.stringify(value)}`,
  );
}

/**
 * The CLI is an explicit operator override. The legacy deployment environment
 * remains supported so the reversible live marker can select N-1 without
 * changing the systemd unit. Ambiguous CLI declarations fail closed.
 */
export function resolveBlockScanPricingSourceMode(
  argv: readonly string[],
  environmentFallback: string | undefined,
): ResolvedBlockScanPricingSourceMode {
  const cliValues: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === FLAG) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${FLAG} requires "n" or "n-1"`);
      }
      cliValues.push(value);
      index++;
      continue;
    }
    if (argument.startsWith(`${FLAG}=`)) {
      cliValues.push(argument.slice(FLAG.length + 1));
    }
  }
  if (cliValues.length > 1) {
    throw new Error(`${FLAG} may be declared only once`);
  }
  if (cliValues.length === 1) {
    return Object.freeze({
      mode: parseMode(cliValues[0]!),
      source: "cli",
    });
  }
  if (
    environmentFallback !== undefined &&
    environmentFallback !== "0" &&
    environmentFallback !== "1"
  ) {
    throw new Error(
      "SEARCHER_BLOCKSCAN_N_MINUS_ONE_FALLBACK must be 0 or 1",
    );
  }
  if (environmentFallback !== undefined) {
    return Object.freeze({
      mode: environmentFallback === "1" ? "n-1" : "n",
      source: "environment",
    });
  }
  return Object.freeze({ mode: "n", source: "default" });
}
