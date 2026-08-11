import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  architectureMigrationSideJson,
  buildFixtureCaptureCorpus,
  exercisedStage,
  generateArchitectureMigrationSideCapture,
} from "./architecture-migration-capture.js";
import {
  captureUniv2RealCase,
  captureUniv3RealCase,
  captureUniv4RealCase,
  captureFundingFixtureCase,
  capturePsmFixtureCase,
  captureWstethFixtureCase,
} from
  "./architecture-migration-fixture-replay.js";
import type {
  ArchitectureMigrationStage,
  RawFamilyMigrationCaseCapture,
  RawMigrationStageCapture,
} from "./architecture-migration-parity-runner.js";

function currentCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const checkOnly = process.argv[2] === "--check";
  const descriptorPath = checkOnly ? process.argv[3] : process.argv[2];
  const outPath = checkOnly ? undefined : process.argv[3];
  if (descriptorPath === undefined || (outPath === undefined && !checkOnly)) {
    throw new Error(
      "usage: tsx src/searcher/run-architecture-migration-capture-real-cli.ts " +
        "[--check] <pool-descriptor.json> [out-side.json]",
    );
  }
  const manifest = JSON.parse(await readFile(descriptorPath, "utf8")) as {
    readonly sourceBlock: number;
    readonly sourceBlockHash: string;
    readonly captureId?: string;
    readonly commit?: string;
    readonly cases: readonly {
      readonly family: string;
      readonly pool: string;
      readonly tokenA: string;
      readonly tokenB: string;
      readonly reserves?: {
        readonly reserve0: string;
        readonly reserve1: string;
        readonly blockTimestampLast?: number;
      };
      readonly fee?: bigint | string;
      readonly tickSpacing?: number;
      readonly liquidity?: bigint | string;
      readonly sqrtPriceX96?: bigint | string;
      readonly currency0?: string;
      readonly currency1?: string;
      readonly hooks?: string;
      readonly lpFee?: bigint | string;
    }[];
  };
  const source = Object.freeze({
    number: manifest.sourceBlock,
    hash: manifest.sourceBlockHash,
    generation: manifest.sourceBlock,
  });
  const buildSide = async (): Promise<ReturnType<
    typeof generateArchitectureMigrationSideCapture
  >> => {
    const familyCases: RawFamilyMigrationCaseCapture[] = [];
    for (const item of manifest.cases) {
      if (item.family === "univ2") {
        familyCases.push(await captureUniv2RealCase({
          source,
          pool: item.pool,
          tokenA: item.tokenA,
          tokenB: item.tokenB,
          reserves: item.reserves,
        }));
      } else if (item.family === "univ3") {
        familyCases.push(await captureUniv3RealCase({
          source,
          pool: item.pool,
          tokenA: item.tokenA,
          tokenB: item.tokenB,
          fee: item.fee,
          tickSpacing: item.tickSpacing,
          liquidity: item.liquidity,
          sqrtPriceX96: item.sqrtPriceX96,
        }));
      } else if (item.family === "univ4") {
        if (
          typeof item.currency0 !== "string" ||
          typeof item.currency1 !== "string"
        ) {
          throw new Error("univ4 capture case requires currency0/currency1");
        }
        familyCases.push(await captureUniv4RealCase({
          source,
          currency0: item.currency0,
          currency1: item.currency1,
          fee: item.fee === undefined ? undefined : Number(item.fee),
          tickSpacing: item.tickSpacing,
          hooks: item.hooks,
          liquidity: item.liquidity,
          sqrtPriceX96: item.sqrtPriceX96,
          lpFee: item.lpFee,
        }));
      } else if (
        item.family === "flash-loan:balancer-v2" ||
        item.family === "flash-loan:morpho"
      ) {
        familyCases.push(await captureFundingFixtureCase({
          familyId: item.family as
            "flash-loan:balancer-v2" | "flash-loan:morpho",
          source,
          caseId: `${item.family}:${source.number}`,
        }));
      } else if (item.family === "protocol:psm") {
        familyCases.push(await capturePsmFixtureCase({
          source,
          caseId: `psm:${source.number}`,
        }));
      } else if (item.family === "protocol:wsteth") {
        familyCases.push(await captureWstethFixtureCase({
          source,
          caseId: `wsteth:${source.number}`,
        }));
      } else {
        throw new Error(`unknown capture family ${item.family}`);
      }
    }
    const evidenceRefs = [...new Set(familyCases.flatMap((familyCase) =>
      familyCase.stages.instances!.evidenceRefs
    ))].sort();
    const mergeStage = (
      stage: ArchitectureMigrationStage,
    ): RawMigrationStageCapture | undefined => {
      const items = familyCases.flatMap((familyCase) => {
        const captured = familyCase.stages[stage];
        return captured?.status === "exercised" ? captured.items : [];
      });
      if (items.length === 0) return undefined;
      return exercisedStage(items, evidenceRefs);
    };
    const commonGraphStages: Partial<
      Record<ArchitectureMigrationStage, RawMigrationStageCapture>
    > = {};
    for (const stage of [
      "edges",
      "enumeratedRoutes",
      "exactQuotes",
      "executionFragments",
      "finalSimulations",
    ] as const) {
      const merged = mergeStage(stage);
      if (merged !== undefined) commonGraphStages[stage] = merged;
    }
    const commonGraph = {
      inputFingerprint: source.hash.slice(2).padStart(64, "0"),
      stages: Object.freeze(commonGraphStages),
      crossFamilyBindings: Object.freeze([]),
    };
    const corpus = {
      ...buildFixtureCaptureCorpus({
        captureId: manifest.captureId ?? "challenger",
        commit: manifest.commit ?? currentCommit(),
        source,
        familyCases,
        commonGraph,
      }),
      productionClosureHash: "aa".repeat(32),
    };
    return generateArchitectureMigrationSideCapture(corpus);
  };
  if (checkOnly) {
    const first = architectureMigrationSideJson(await buildSide());
    const second = architectureMigrationSideJson(await buildSide());
    if (first !== second) {
      throw new Error("real capture generation is not reproducible");
    }
    process.stdout.write("real capture reproducible\n");
    return;
  }
  if (outPath === undefined) throw new Error("out-side.json is required");
  const side = await buildSide();
  await writeFile(
    outPath,
    architectureMigrationSideJson(side),
    "utf8",
  );
  process.stdout.write(`challenger real capture written: ${outPath}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
