import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { buildFamilyCapabilityShadowArtifact } from "./build-family-capability-manifest.js";
import { calculateReadyRuleDefinitions } from "./build-ready-rule-bindings.js";
import { issueReadyRuleMigration } from "./ready-rule-bindings.js";
import { UniverseRebuildCheckpointStore } from "./universe-rebuild-checkpoint.js";

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
async function fileSha(path: string) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
async function archivedEntrySha(path: string) {
  // Release manifests bind a symlink's target text (not its mutable contents).
  // Package source and lockfile pins remain independently required below.
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) return sha(await readlink(path));
  if (!entry.isFile()) throw new Error("archived entry is not a file or symlink");
  return fileSha(path);
}

/** One-time, source-verified bridge for a sealed legacy Ready copy. Ordinary
 * generation already uses the new dependency scope; no per-run migration is
 * required. This command does not issue discovery or identity RPC requests. */
export async function migrateReadyRules(input: {
  release: string; checkpoint: string; out: string; apply: boolean;
}) {
  const release = await realpath(input.release);
  const checkpointPath = await realpath(input.checkpoint);
  const reportPath = resolve(input.out);
  if (reportPath === checkpointPath || !relative(release, reportPath).startsWith(".."))
    throw new Error("migration report cannot overwrite an input or archived release");
  if (!relative(release, checkpointPath).startsWith(".."))
    throw new Error("migration destination must be a separate Ready copy outside the archived release");
  const manifestBytes = await readFile(resolve(release, "release.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const pins = new Map<string, string>(manifest.files);
  const archivedRoot = resolve(release, "runtime/listener");
  const currentRoot = fileURLToPath(new URL("../../", import.meta.url));
  const artifactFile = "runtime/listener/src/searcher/generated/family-capability-shadow.generated.json";
  const artifact = JSON.parse(await readFile(resolve(release, artifactFile), "utf8"));
  const required = new Set<string>([artifactFile, "runtime/listener/package-lock.json", "runtime/listener/tsconfig.json"]);
  for (const row of artifact.exact) {
    for (const file of [row.root.entrySourceFile, ...row.root.additionalSourceFiles, ...row.identity.semanticDependencies])
      if (typeof file === "string" && file.startsWith("src/")) required.add("runtime/listener/" + file);
  }
  // Pin every archived runtime file, including generated entries, even if the
  // old artifact omitted that file from its conservative closure receipt.
  for (const file of pins.keys()) if (file.startsWith("runtime/")) required.add(file);
  for (const file of required) {
    const target = resolve(release, file);
    if (relative(release, target).startsWith("..") || !pins.has(file) || await archivedEntrySha(target) !== pins.get(file))
      throw new Error("archived source pin differs: " + file);
  }
  const sourceSha256 = await fileSha(checkpointPath);
  if (sourceSha256 !== manifest.readySha256) throw new Error("Ready copy differs from the archived release");
  if (await fileSha(resolve(release, "ready/checkpoint.json")) !== sourceSha256)
    throw new Error("archived Ready source differs from its release manifest");
  console.log(JSON.stringify({ stage: "archive-verified", files: required.size, sourceSha256 }));

  // Read the original implementation, never replace archived Family files with
  // current files. Reconstruct old IDs before interpreting their narrowed scope.
  const archived = await import(pathToFileURL(resolve(archivedRoot, "src/searcher/universe-rebuild-production.ts")).href);
  const store = new UniverseRebuildCheckpointStore({ path: checkpointPath });
  const checkpoint = await store.load();
  if (!checkpoint?.readyGeneration) throw new Error("migration requires a completed Ready");
  const ids = Object.keys(checkpoint.readyGeneration.familyPartitions ?? {});
  const archivedHashes = Object.fromEntries(ids.map(id => [id, {
    full: archived.familyDefinitionHash(id), memo: archived.familyMemoDefinitionHash(id),
    discovery: archived.familyDiscoveryDefinitionHash(id),
  }]));
  const boundaries = (catalog: any) => Object.fromEntries(catalog.listAll().map((family: any) =>
    [family.plugin.manifest.familyId, family.definitionBoundaryHash]));
  const archivedCatalog = await import(pathToFileURL(resolve(archivedRoot, "src/searcher/venues/production-family-composition.ts")).href);
  const archivedRules = await calculateReadyRuleDefinitions({ rootDirectory: archivedRoot, artifact,
    definitionBoundaryHashes: boundaries(archivedCatalog.PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG) });
  console.log(JSON.stringify({ stage: "archived-rules-calculated", families: Object.keys(archivedRules).length }));
  const currentArtifact = await buildFamilyCapabilityShadowArtifact({ rootDirectory: currentRoot });
  if (!currentArtifact.complete) throw new Error("current Family capability source is incomplete");
  console.log(JSON.stringify({ stage: "current-manifest-verified" }));
  const currentCatalog = await import("./venues/production-family-composition.js");
  const currentRules = await calculateReadyRuleDefinitions({ rootDirectory: currentRoot, artifact: currentArtifact,
    definitionBoundaryHashes: boundaries(currentCatalog.PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG) });
  const migration = issueReadyRuleMigration({ checkpoint, archivedHashes, archivedRules,
    sourceSha256, archiveManifestSha256: sha(manifestBytes) });
  console.log(JSON.stringify({ stage: "sealed-Ready-proof-bindings-verified", families: ids.length }));
  const rows = ids.map(familyId => ({ familyId, archivedHashes: archivedHashes[familyId],
    archivedRules: archivedRules[familyId], currentRules: currentRules[familyId] ?? null,
    equivalent: Object.fromEntries(["full", "memo", "discovery"].map(scope => [scope,
      archivedRules[familyId]?.[scope as "full"] === currentRules[familyId]?.[scope as "full"]])),
    candidates: Object.keys(checkpoint.readyGeneration!.familyPartitions![familyId]!.candidatesByKey).length,
  }));
  const report = { mode: input.apply ? "apply" : "check", sourceGeneration: checkpoint.readyGeneration.generation,
    sourceSha256, archiveManifestSha256: sha(manifestBytes), verifiedSourceFiles: required.size,
    rpcRequests: 0, originalProofsPreserved: true, rows };
  await writeFile(input.out, JSON.stringify(report, null, 2) + "\n");
  if (input.apply) {
    await store.casMigrateReadyRuleBindings({ expectedRevision: checkpoint.revision, migration });
    await writeFile(input.out, JSON.stringify({ ...report, migratedSha256: await fileSha(checkpointPath) }, null, 2) + "\n");
  }
  console.log(JSON.stringify({ stage: input.apply ? "migration-published" : "migration-checked",
    inheritedFamilies: rows.filter(row => row.equivalent.full).length,
    changedFamilies: rows.filter(row => !row.equivalent.full).map(row => row.familyId), report: input.out }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options: Record<string, string> = {};
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === "--apply") { apply = true; continue; }
    if (!["--release", "--checkpoint", "--out"].includes(key) || !args[i + 1] || args[i + 1]!.startsWith("--"))
      throw new Error("usage: --release ARCHIVE --checkpoint COPY --out REPORT [--apply]");
    options[key.slice(2)] = args[++i]!;
  }
  if (!options.release || !options.checkpoint || !options.out) throw new Error("missing migration paths");
  await migrateReadyRules({ release: options.release, checkpoint: options.checkpoint, out: options.out, apply });
}
