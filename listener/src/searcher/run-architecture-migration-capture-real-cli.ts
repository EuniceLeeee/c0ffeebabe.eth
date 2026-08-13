import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { ethers } from "ethers";
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
  captureGoldxFixtureCase,
  captureRocksolidFixtureCase,
  captureMetronomeHgUsdcFixtureCase,
  captureMetronomeSynthFixtureCase,
  captureErc4626SiloRedeemFixtureCase,
  captureErc4626FixtureCase,
  captureEtherTokenNativeRedeemFixtureCase,
  captureSelfBurnNativeFixtureCase,
  captureAstraMultiTokenFixtureCase,
  captureEigenpieFixtureCase,
  captureCurveUnderlyingFixtureCase,
  captureFluidDexFixtureCase,
  captureAngstromV4FixtureCase,
  captureDodoV2FixtureCase,
  captureFluidCreditFixtureCase,
  astraFixtureRuntime,
  captureAngstromV4OnchainCase,
  captureAstraOnchainCase,
  captureCurveUnderlyingOnchainCase,
  captureDodoV2OnchainCase,
  captureEigenpieOnchainCase,
  captureErc4626OnchainCase,
  captureErc4626SiloOnchainCase,
  captureEtherTokenOnchainCase,
  captureFluidCreditOnchainCase,
  captureFluidDexOnchainCase,
  captureFundingOnchainCase,
  captureGoldxOnchainCase,
  captureMetronomeHgUsdcOnchainCase,
  captureMetronomeSynthOnchainCase,
  capturePsmOnchainCase,
  captureRocksolidOnchainCase,
  captureSelfBurnOnchainCase,
  captureUniv2OnchainCase,
  captureUniv3OnchainCase,
  captureUniv4OnchainCase,
  captureWstethOnchainCase,
  ANGSTROM_FIXTURE_FEE,
  ANGSTROM_FIXTURE_TICK_SPACING,
  curveUnderlyingFixtureRuntime,
  dodoV2FixtureRuntime,
  eigenpieFixtureRuntime,
  erc4626FixtureRuntime,
  erc4626SiloFixtureRuntime,
  etherTokenNativeFixtureRuntime,
  goldxFixtureRuntime,
  metronomeHgUsdcFixtureRuntime,
  metronomeSynthFixtureRuntime,
  psmFixtureRuntime,
  rocksolidFixtureRuntime,
  selfBurnNativeFixtureRuntime,
} from
  "./architecture-migration-fixture-replay.js";
import type {
  ArchitectureMigrationStage,
  RawFamilyMigrationCaseCapture,
  RawMigrationStageCapture,
} from "./architecture-migration-parity-runner.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import {
  captureFamilyGenerically,
  deriveFamilyObservationFromNodeData,
  resolveGenericCaptureDriver,
  runGenericCaptureBatch,
  type GenericCaptureProvider,
} from "./generic-family-capture.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "./venues/production-family-composition.js";
import {
  PRODUCTION_STRICT_VERIFIED_ACTORS,
} from "./venues/production-verified-actors.js";
import { familyId } from
  "./venues/adapter-family-identifiers.js";
import { RevmSimClient } from "./revm-sim-client.js";
import { createRevmStrictSimulationTransport } from
  "./revm-strict-simulation-transport.js";
import { createStrictCentralAdapterRuntime } from
  "./strict-central-adapter-runtime.js";
import type { CentralAdapterRuntime } from
  "./adapter-work-intent.js";

interface RealCaptureCase {
  readonly family: string;
  readonly address?: string;
  readonly pool: string;
  readonly tokenA: string;
  readonly tokenB: string;
  readonly vault?: string;
  readonly target?: string;
  readonly token?: string;
  readonly asset?: string;
  readonly gem?: string;
  readonly dai?: string;
  readonly factory?: string;
  readonly controller?: string;
  readonly fundingContract?: string;
  readonly supply?: string;
  readonly borrow?: string;
  readonly stEth?: string;
  readonly receipt?: string;
  readonly tokenIn?: string;
  readonly tokenOut?: string;
  readonly decimals?: number;
  readonly unit?: bigint | string;
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
}

const GENERIC_CAPTURE_CASE_TIMEOUT_MS = positiveTimeout(
  process.env.S1_GENERIC_CAPTURE_CASE_TIMEOUT_MS,
  60_000,
);

function positiveTimeout(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("S1_GENERIC_CAPTURE_CASE_TIMEOUT_MS must be positive");
  }
  return parsed;
}

/**
 * Historical capture-name -> catalog manifest familyId aliases. New
 * descriptors should name the catalog familyId directly; this map only
 * bridges the fixture-era capture names.
 */
const CAPTURE_NAME_TO_CATALOG_FAMILY: Readonly<Record<string, string>> =
  Object.freeze({
    "univ2": "univ2-standard",
    "univ3": "univ3-standard",
    "univ4": "univ4",
    "dodo-v2": "custom-swap:dodo-v2",
    "fluid-dex": "fluid-dex",
    "protocol:erc4626": "protocol:erc4626",
    "protocol:erc4626-silo-redeem": "protocol:erc4626-silo-redeem",
    "protocol:astra-multitoken": "protocol:astra-multitoken",
    "protocol:ethertoken-native-redeem":
      "protocol:ethertoken-native-redeem",
  });

function buildGenericRuntime(provider: GenericCaptureProvider): CentralAdapterRuntime {
  const executablePath = process.env.S1_REVM_SIM_BIN;
  const executor = process.env.S1_CAPTURE_EXECUTOR ??
    `0x${"99".repeat(20)}`;
  if (executablePath === undefined || executablePath.trim() === "") {
    return createStrictCentralAdapterRuntime({
      provider,
      generationFence: Object.freeze({ assertCurrent() {} }),
      verifiedActors: PRODUCTION_STRICT_VERIFIED_ACTORS,
    });
  }
  return createStrictCentralAdapterRuntime({
    provider,
    generationFence: Object.freeze({ assertCurrent() {} }),
    verifiedActors: PRODUCTION_STRICT_VERIFIED_ACTORS,
    simulator: createRevmStrictSimulationTransport({
      client: new RevmSimClient({
        executablePath,
        timeoutMs: Number(process.env.S1_REVM_TIMEOUT_MS ?? "60000"),
      }),
      executor,
      verifiedActors: PRODUCTION_STRICT_VERIFIED_ACTORS,
    }),
  });
}

function currentCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

async function runOnchainCaptureCase(input: {
  readonly familyCase: RealCaptureCase;
  readonly source: CanonicalSource;
  readonly provider: {
    call(
      tx: { readonly to: string; readonly data: string },
      blockTag?: number,
    ): Promise<string>;
  };
}): Promise<RawFamilyMigrationCaseCapture> {
  const item = input.familyCase;
  const { source, provider } = input;
  switch (item.family) {
    case "univ2":
      return captureUniv2OnchainCase({
        source, provider, pool: item.pool,
        tokenA: item.tokenA, tokenB: item.tokenB, reserves: item.reserves,
      });
    case "univ3":
      return captureUniv3OnchainCase({
        source, provider, pool: item.pool,
        tokenA: item.tokenA, tokenB: item.tokenB,
        fee: item.fee, tickSpacing: item.tickSpacing,
        liquidity: item.liquidity, sqrtPriceX96: item.sqrtPriceX96,
      });
    case "univ4":
      if (!item.currency0 || !item.currency1) {
        throw new Error("univ4 onchain case requires currency0/currency1");
      }
      return captureUniv4OnchainCase({
        source, provider,
        currency0: item.currency0, currency1: item.currency1,
        fee: item.fee === undefined ? undefined : Number(item.fee),
        tickSpacing: item.tickSpacing, hooks: item.hooks,
        liquidity: item.liquidity, sqrtPriceX96: item.sqrtPriceX96,
        lpFee: item.lpFee,
      });
    case "flash-loan:balancer-v2":
    case "flash-loan:morpho":
      if (!item.asset || !item.fundingContract) {
        throw new Error(
          `funding onchain case requires asset/fundingContract`,
        );
      }
      return captureFundingOnchainCase({
        familyId: item.family,
        source, provider,
        asset: item.asset, fundingContract: item.fundingContract,
      });
    case "protocol:psm":
      if (!item.target) throw new Error("psm onchain case requires target");
      return capturePsmOnchainCase({
        source, provider, target: item.target,
        gem: item.gem, dai: item.dai, runtime: psmFixtureRuntime(),
      });
    case "protocol:wsteth":
      if (!item.target) throw new Error("wsteth onchain case requires target");
      return captureWstethOnchainCase({
        source, provider, target: item.target, stEth: item.stEth,
      });
    case "protocol:goldx":
      if (!item.target) throw new Error("goldx onchain case requires target");
      return captureGoldxOnchainCase({
        source, provider, target: item.target, unit: item.unit,
        runtime: goldxFixtureRuntime(),
      });
    case "protocol:rocksolid":
      if (!item.target) throw new Error("rocksolid onchain case requires target");
      return captureRocksolidOnchainCase({
        source, provider, target: item.target,
        runtime: rocksolidFixtureRuntime(),
      });
    case "protocol:metronome-hgusdc":
      if (!item.target || !item.vault) {
        throw new Error("metronome-hgusdc onchain case requires target/vault");
      }
      return captureMetronomeHgUsdcOnchainCase({
        source, provider, target: item.target, vault: item.vault,
        tokenOut: item.tokenOut,
        runtime: metronomeHgUsdcFixtureRuntime(),
      });
    case "protocol:metronome-synth":
      if (!item.pool || !item.tokenIn || !item.tokenOut) {
        throw new Error(
          "metronome-synth onchain case requires pool/tokenIn/tokenOut",
        );
      }
      return captureMetronomeSynthOnchainCase({
        source, provider, pool: item.pool,
        tokenIn: item.tokenIn, tokenOut: item.tokenOut,
        runtime: metronomeSynthFixtureRuntime(),
      });
    case "protocol:erc4626-silo-redeem":
      if (!item.vault || !item.target) {
        throw new Error("erc4626-silo onchain case requires vault/payout");
      }
      return captureErc4626SiloOnchainCase({
        source, provider, vault: item.vault, payout: item.target,
        underlying: item.tokenIn,
        runtime: erc4626SiloFixtureRuntime(),
      });
    case "protocol:erc4626":
      if (!item.vault) throw new Error("erc4626 onchain case requires vault");
      return captureErc4626OnchainCase({
        source, provider, vault: item.vault, asset: item.asset,
        runtime: erc4626FixtureRuntime(),
      });
    case "protocol:ethertoken-native-redeem":
      if (!item.token) {
        throw new Error("ethertoken onchain case requires token");
      }
      return captureEtherTokenOnchainCase({
        source, provider, token: item.token, decimals: item.decimals,
        runtime: etherTokenNativeFixtureRuntime(),
      });
    case "protocol:self-burn-native":
      if (!item.token) {
        throw new Error("self-burn onchain case requires token");
      }
      return captureSelfBurnOnchainCase({
        source, provider, token: item.token, decimals: item.decimals,
        runtime: selfBurnNativeFixtureRuntime(),
      });
    case "protocol:astra-multitoken":
      if (!item.target || !item.tokenIn || !item.tokenOut) {
        throw new Error(
          "astra onchain case requires target/tokenIn/tokenOut",
        );
      }
      return captureAstraOnchainCase({
        source, provider, target: item.target,
        tokenIn: item.tokenIn, tokenOut: item.tokenOut,
      });
    case "protocol:eigenpie":
      if (!item.target || !item.asset) {
        throw new Error("eigenpie onchain case requires target/asset");
      }
      return captureEigenpieOnchainCase({
        source, provider, target: item.target, asset: item.asset,
        receipt: item.receipt, runtime: eigenpieFixtureRuntime(),
      });
    case "curve-underlying":
      if (!item.pool) throw new Error("curve-underlying onchain case requires pool");
      return captureCurveUnderlyingOnchainCase({
        source, provider, pool: item.pool,
        tokenIn: item.tokenIn, tokenOut: item.tokenOut,
        runtime: curveUnderlyingFixtureRuntime(),
      });
    case "fluid-dex":
      if (!item.pool || !item.factory) {
        throw new Error("fluid-dex onchain case requires pool/factory");
      }
      return captureFluidDexOnchainCase({
        source, provider, pool: item.pool, factory: item.factory,
      });
    case "custom-swap:angstrom-v4":
      if (!item.controller || !item.currency0 || !item.currency1) {
        throw new Error(
          "angstrom onchain case requires controller/currency0/currency1",
        );
      }
      return captureAngstromV4OnchainCase({
        source, provider, controller: item.controller,
        currency0: item.currency0, currency1: item.currency1,
        fee: Number(item.fee ?? ANGSTROM_FIXTURE_FEE),
        tickSpacing: item.tickSpacing ?? ANGSTROM_FIXTURE_TICK_SPACING,
      });
    case "dodo-v2":
    case "custom-swap:dodo-v2":
      if (!item.pool) throw new Error("dodo-v2 onchain case requires pool");
      return captureDodoV2OnchainCase({
        source, provider, pool: item.pool,
        baseToken: item.tokenA, quoteToken: item.tokenB,
      });
    case "credit:fluid":
      if (!item.vault) throw new Error("fluid-credit onchain case requires vault");
      return captureFluidCreditOnchainCase({
        source, provider, vault: item.vault,
        supply: item.supply, borrow: item.borrow,
      });
    default:
      throw new Error(`unknown onchain capture family ${item.family}`);
  }
}

async function main(): Promise<void> {
  const generic = process.argv[2] === "--generic";
  const onchain = process.argv[2] === "--onchain";
  const flagOffset = (onchain || generic) ? 1 : 0;
  const checkOnly = process.argv[2 + flagOffset] === "--check";
  const descriptorPath = process.argv[2 + flagOffset + (checkOnly ? 1 : 0)];
  const outPath = checkOnly ? undefined
    : process.argv[3 + flagOffset + (checkOnly ? 1 : 0)];
  if (descriptorPath === undefined || (outPath === undefined && !checkOnly)) {
    throw new Error(
      "usage: tsx src/searcher/run-architecture-migration-capture-real-cli.ts " +
        "[--onchain|--generic] [--check] <pool-descriptor.json> [out-side.json]",
    );
  }
  const manifest = JSON.parse(await readFile(descriptorPath, "utf8")) as {
    readonly sourceBlock: number;
    readonly sourceBlockHash: string;
    readonly captureId?: string;
    readonly commit?: string;
    readonly onchain?: boolean;
    readonly cases: readonly RealCaptureCase[];
  };
  const useGeneric = generic || (manifest.onchain === true && !onchain);
  const useOnchain = onchain || (manifest.onchain === true && !generic);
  const provider = useOnchain
    ? new ethers.JsonRpcProvider(
        process.env.S1_CAPTURE_RPC_URL ?? "http://127.0.0.1:8545",
      )
    : null;
  const genericRpcUrl = process.env.S1_CAPTURE_RPC_URL ??
    "http://127.0.0.1:8545";
  const source = Object.freeze({
    number: manifest.sourceBlock,
    hash: manifest.sourceBlockHash,
    generation: manifest.sourceBlock,
  });
  const buildSide = async (): Promise<ReturnType<
    typeof generateArchitectureMigrationSideCapture
  >> => {
    const familyCases: RawFamilyMigrationCaseCapture[] = [];
    if (useGeneric) {
      const tasks = manifest.cases.map((item) => {
        if (item.address === undefined) {
          throw new Error("generic mode requires a case address");
        }
        const address = item.address;
        const fid = familyId(
          CAPTURE_NAME_TO_CATALOG_FAMILY[item.family] ?? item.family,
        );
        const request = new ethers.FetchRequest(genericRpcUrl);
        request.timeout = GENERIC_CAPTURE_CASE_TIMEOUT_MS;
        const caseProvider = new ethers.JsonRpcProvider(request);
        return Object.freeze({
          id: item.family,
          timeoutMs: GENERIC_CAPTURE_CASE_TIMEOUT_MS,
          cancel: () => caseProvider.destroy(),
          run: async () => {
            try {
              const observation = await deriveFamilyObservationFromNodeData({
                catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
                familyId: fid,
                source,
                address,
                provider: caseProvider,
              });
              return await captureFamilyGenerically({
                catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
                familyId: fid,
                source,
                observation,
                runtime: buildGenericRuntime(caseProvider),
                driver: resolveGenericCaptureDriver(fid),
              });
            } finally {
              caseProvider.destroy();
            }
          },
        });
      });
      familyCases.push(...await runGenericCaptureBatch({
        items: tasks,
        onFailure: (id, error) => console.warn(
          `[generic-capture] skipped ${id}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        ),
      }));
    }
    for (const item of manifest.cases) {
      if (useGeneric) continue;
      if (useOnchain) {
        if (provider === null) throw new Error("onchain provider missing");
        try {
          familyCases.push(await runOnchainCaptureCase({
            familyCase: item,
            source,
            provider,
          }));
        } catch (error) {
          throw new Error(
            `onchain capture failed for ${item.family}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
        continue;
      }
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
      } else if (item.family === "protocol:goldx") {
        familyCases.push(await captureGoldxFixtureCase({
          source,
          caseId: `goldx:${source.number}`,
        }));
      } else if (item.family === "protocol:rocksolid") {
        familyCases.push(await captureRocksolidFixtureCase({
          source,
          caseId: `rocksolid:${source.number}`,
        }));
      } else if (item.family === "protocol:metronome-hgusdc") {
        familyCases.push(await captureMetronomeHgUsdcFixtureCase({
          source,
          caseId: `metronome-hgusdc:${source.number}`,
        }));
      } else if (item.family === "protocol:metronome-synth") {
        familyCases.push(await captureMetronomeSynthFixtureCase({
          source,
          caseId: `metronome-synth:${source.number}`,
        }));
      } else if (item.family === "protocol:erc4626-silo-redeem") {
        familyCases.push(await captureErc4626SiloRedeemFixtureCase({
          source,
          caseId: `erc4626-silo-redeem:${source.number}`,
        }));
      } else if (item.family === "protocol:erc4626") {
        familyCases.push(await captureErc4626FixtureCase({
          source,
          caseId: `erc4626:${source.number}`,
        }));
      } else if (item.family === "protocol:ethertoken-native-redeem") {
        familyCases.push(await captureEtherTokenNativeRedeemFixtureCase({
          source,
          caseId: `ethertoken-native-redeem:${source.number}`,
        }));
      } else if (item.family === "protocol:self-burn-native") {
        familyCases.push(await captureSelfBurnNativeFixtureCase({
          source,
          caseId: `self-burn-native:${source.number}`,
        }));
      } else if (item.family === "protocol:astra-multitoken") {
        familyCases.push(await captureAstraMultiTokenFixtureCase({
          source,
          caseId: `astra-multitoken:${source.number}`,
        }));
      } else if (item.family === "protocol:eigenpie") {
        familyCases.push(await captureEigenpieFixtureCase({
          source,
          caseId: `eigenpie:${source.number}`,
        }));
      } else if (item.family === "curve-underlying") {
        familyCases.push(await captureCurveUnderlyingFixtureCase({
          source,
          caseId: `curve-underlying:${source.number}`,
        }));
      } else if (item.family === "fluid-dex") {
        familyCases.push(await captureFluidDexFixtureCase({
          source,
          caseId: `fluid-dex:${source.number}`,
        }));
      } else if (item.family === "custom-swap:angstrom-v4") {
        familyCases.push(await captureAngstromV4FixtureCase({
          source,
          caseId: `angstrom-v4:${source.number}`,
        }));
      } else if (item.family === "custom-swap:dodo-v2") {
        familyCases.push(await captureDodoV2FixtureCase({
          source,
          caseId: `dodo-v2:${source.number}`,
        }));
      } else if (item.family === "credit:fluid") {
        familyCases.push(await captureFluidCreditFixtureCase({
          source,
          caseId: `credit:fluid:${source.number}`,
        }));
      } else {
        throw new Error(`unknown capture family ${item.family}`);
      }
    }
    if (familyCases.length === 0) {
      throw new Error("no family produced a capture");
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
