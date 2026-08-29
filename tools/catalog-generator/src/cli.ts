import { resolve } from "node:path";
import { encodeCanonicalJson } from "../../../packages/canonical-codec/src/index.ts";
import { checkGeneratedCatalogWithImpact, generateCatalogWithImpact, writeGeneratedCatalog } from "./index.ts";
import {
  currentCatalogInput,
  initializeCurrentCatalogImpactGenesis,
  readCurrentCatalogInput,
  writeCatalogCompilerInput,
} from "./current-release.ts";
import {
  observeCurrentCatalogCompilerAuthority,
} from "./compiler-authority.ts";
import { verifyCurrentCatalogGeneration } from "./verification-owner.ts";

const args = process.argv.slice(2);
if (args.some(arg => !["--check", "--project-compiler-facts", "--initialize-impact-genesis"].includes(arg))) {
  throw new Error("usage: generate-catalog [--check|--project-compiler-facts|--initialize-impact-genesis]");
}
const modes = args.filter(arg => ["--check", "--project-compiler-facts", "--initialize-impact-genesis"].includes(arg));
if (modes.length > 1) throw new Error("usage: choose exactly one catalog-generator mode");

const repositoryRoot = resolve(new URL("../../..", import.meta.url).pathname);
if (args.includes("--initialize-impact-genesis")) {
  const prior = initializeCurrentCatalogImpactGenesis(repositoryRoot);
  process.stdout.write(`catalog-impact-genesis:${prior.priorIdentityRoot}\n`);
} else if (args.includes("--project-compiler-facts")) {
  const observed = observeCurrentCatalogCompilerAuthority(repositoryRoot);
  writeCatalogCompilerInput(repositoryRoot, observed.compilerClosures, observed.proposedCapabilitySet);
  const freshInput = currentCatalogInput(repositoryRoot);
  const prior = readCurrentCatalogInput(repositoryRoot).priorCatalogImpact;
  const freshArtifacts = generateCatalogWithImpact(freshInput, prior);
  writeGeneratedCatalog(repositoryRoot, freshArtifacts);
  const errors = checkGeneratedCatalogWithImpact(freshInput, prior);
  if (errors.length > 0) throw new Error(`catalog-generator fresh check failed: ${errors.join(",")}`);
  process.stdout.write(`${observed.compilerClosures.length}:${freshArtifacts.outputRoot}\n`);
} else {
  if (args.includes("--check")) {
    // Stdout is transport only.  The architecture boundary exact-decodes and
    // independently recomputes every load-bearing receipt field; this string
    // is never accepted as a success marker or verdict.
    process.stdout.write(`${encodeCanonicalJson(verifyCurrentCatalogGeneration(repositoryRoot))}\n`);
  } else {
    const input = currentCatalogInput(repositoryRoot);
    const prior = readCurrentCatalogInput(repositoryRoot).priorCatalogImpact;
    const artifacts = generateCatalogWithImpact(input, prior);
    writeGeneratedCatalog(repositoryRoot, artifacts);
    process.stdout.write(`${artifacts.outputRoot}\n`);
  }
}
