import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { buildSync, type Metafile } from "esbuild";
import {
  gitSha40Schema,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  observeExactPushedGitV1,
  withExactCommitTreeV1,
} from "../../runtime-release-packager/src/git-release-evidence.ts";
import {
  PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1 as LAYOUT,
  PRE_RELEASE_RESTART_CONTROLLER_UNIT_V1,
  PRE_RELEASE_RESTART_TARGET_UNIT_V1,
} from "./spec.ts";

const ENTRYPOINT = "tools/pre-release-restart-controller/src/cli.ts";
const OUTPUT = "pre-release-restart-controller.mjs";
const ALLOWED_EXTERNAL_BUILTINS = new Set(["node:child_process", "node:crypto", "node:fs", "node:sqlite", "node:util"]);
const FORBIDDEN_GRAPH_SEGMENTS = Object.freeze([
  "node_modules/",
  "apps/searcher-runtime/",
  "acceptance/",
  "tools/runtime-release-packager/src/internal/",
  "generated/",
]);

export interface BuiltPreReleaseRestartControllerBundleV1 {
  readonly bytes: Uint8Array;
  readonly sha256: Hash;
  readonly sourceInputRoot: Hash;
  readonly metafileRoot: Hash;
  readonly implementationClosureDigest: Hash;
  readonly sourceInputs: readonly Readonly<{ readonly path: string; readonly contentSha256: Hash; readonly byteLength: string }>[];
  readonly externalBuiltins: readonly string[];
  readonly controllerSystemdUnitBytes: Uint8Array;
  readonly controllerSystemdUnitSha256: Hash;
  readonly targetSystemdUnitSha256: Hash;
  readonly installContract: typeof PRE_RELEASE_RESTART_CONTROLLER_INSTALL_CONTRACT_V1;
}

export interface ExactPreReleaseRestartControllerArtifactV1 extends BuiltPreReleaseRestartControllerBundleV1 {
  readonly candidateReleaseCommit: string;
}

export const PRE_RELEASE_RESTART_CONTROLLER_INSTALL_CONTRACT_V1 = Object.freeze({
  schemaVersion: 1 as const,
  kind: "aloha.pre-release-restart-controller-install-contract" as const,
  buildOwner: "tools/runtime-release-packager/src/exact-runtime-artifacts.ts#buildExactPreReleaseStagingRuntimeArtifactsV1",
  installOwner: "@aloha/runtime-release-packager/final-pre-release-runner",
  buildSource: "exact-pushed-commit-tree" as const,
  controllerEntrypointPath: LAYOUT.controllerEntrypointPath,
  controllerEntrypointUid: "0" as const,
  controllerEntrypointGid: "0" as const,
  controllerEntrypointMode: "384" as const,
  controllerSystemdUnitPath: LAYOUT.controllerSystemdUnitPath,
  controllerSystemdUnitUid: "0" as const,
  controllerSystemdUnitGid: "0" as const,
  controllerSystemdUnitMode: "420" as const,
  targetSystemdUnitPath: LAYOUT.targetSystemdUnitPath,
  controllerDirectory: LAYOUT.controllerDirectory,
  controllerDirectoryUid: "0" as const,
  controllerDirectoryGid: "0" as const,
  controllerDirectoryMode: "448" as const,
  executableDenominator: "one-self-contained-controller-bundle" as const,
  searcherRuntimeBundleMember: false as const,
});

function canonicalSnapshotRoot(value: string): string {
  const root = realpathSync(resolve(value));
  if (root !== resolve(value) || !lstatSync(root).isDirectory()) throw new TypeError("controller build root is not a canonical directory");
  return root;
}

function assertMetafile(metafile: Metafile, root: string): Readonly<{
  readonly inputs: readonly Readonly<{ readonly path: string; readonly contentSha256: Hash; readonly byteLength: string }>[];
  readonly externalBuiltins: readonly string[];
  readonly metafileRoot: Hash;
}> {
  const outputs = Object.entries(metafile.outputs);
  if (outputs.length !== 1 || outputs[0]![0] !== OUTPUT) throw new TypeError("controller builder emitted a non-singleton output");
  const output = outputs[0]![1];
  const externalImports = output.imports.map(item => {
    if (!item.external || !ALLOWED_EXTERNAL_BUILTINS.has(item.path)) throw new TypeError(`controller bundle has an unapproved external import: ${item.path}`);
    return item.path;
  }).sort();
  const externalBuiltins = [...new Set(externalImports)].sort();
  const inputs = Object.keys(metafile.inputs).sort().map(path => {
    if (isAbsolute(path) || path.includes("\\") || path.includes("..") || FORBIDDEN_GRAPH_SEGMENTS.some(segment => path.includes(segment))) throw new TypeError(`controller build graph contains a forbidden path: ${path}`);
    const physical = join(root, path);
    if (realpathSync(physical) !== physical || !lstatSync(physical).isFile()) throw new TypeError(`controller build input is not a canonical file: ${path}`);
    const bytes = new Uint8Array(readFileSync(physical));
    return Object.freeze({ path, contentSha256: sha256Hex(bytes), byteLength: String(bytes.byteLength) });
  });
  if (!inputs.some(input => input.path === ENTRYPOINT)) throw new TypeError("controller build graph omits the fixed CLI entrypoint");
  const metafileProjection = Object.freeze({
    inputs: Object.entries(metafile.inputs).sort(([left], [right]) => left.localeCompare(right)).map(([path, value]) => ({ path, bytesInOutput: value.bytes })),
    output: {
      path: OUTPUT,
      entryPoint: output.entryPoint,
      imports: output.imports.map(item => ({ path: item.path, kind: item.kind, external: item.external })),
      exports: output.exports,
    },
  });
  if (metafileProjection.output.entryPoint !== ENTRYPOINT || metafileProjection.output.exports.length !== 0) throw new TypeError("controller bundle entrypoint/export surface mismatch");
  return Object.freeze({ inputs: Object.freeze(inputs), externalBuiltins: Object.freeze(externalBuiltins), metafileRoot: hashDomain("aloha/pre-release-restart-controller-metafile/v1", metafileProjection) });
}

export function buildPreReleaseRestartControllerBundleV1(repositoryRootValue: string): BuiltPreReleaseRestartControllerBundleV1 {
  const repositoryRoot = canonicalSnapshotRoot(repositoryRootValue);
  const result = buildSync({
    absWorkingDir: repositoryRoot,
    entryPoints: [ENTRYPOINT],
    outfile: OUTPUT,
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "bundle",
    external: ["node:*"],
    legalComments: "none",
    charset: "utf8",
    treeShaking: true,
    sourcemap: false,
    logLevel: "silent",
  });
  if (result.outputFiles.length !== 1 || result.metafile === undefined) throw new TypeError("controller builder did not emit one exact bundle");
  const graph = assertMetafile(result.metafile, repositoryRoot);
  const bytes = new Uint8Array(result.outputFiles[0]!.contents);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (source.includes(repositoryRoot) || source.includes("node_modules") || source.includes("createRequire")
    || source.includes("node:module") || source.includes("apps/searcher-runtime") || source.includes("production-bootstrap")) throw new TypeError("controller bundle leaks a checkout, general loader, or searcher runtime closure");
  const sha256 = sha256Hex(bytes);
  const sourceInputRoot = hashDomain("aloha/pre-release-restart-controller-source-inputs/v1", graph.inputs);
  const controllerSystemdUnitBytes = new TextEncoder().encode(PRE_RELEASE_RESTART_CONTROLLER_UNIT_V1);
  const controllerSystemdUnitSha256 = sha256Hex(controllerSystemdUnitBytes);
  const targetSystemdUnitSha256 = sha256Hex(new TextEncoder().encode(PRE_RELEASE_RESTART_TARGET_UNIT_V1));
  const implementationClosureDigest = hashDomain("aloha/pre-release-restart-controller-build-closure/v1", {
    bundleSha256: sha256,
    sourceInputRoot,
    metafileRoot: graph.metafileRoot,
    externalBuiltins: graph.externalBuiltins,
    controllerSystemdUnitSha256,
    targetSystemdUnitSha256,
    installContract: PRE_RELEASE_RESTART_CONTROLLER_INSTALL_CONTRACT_V1,
  });
  return Object.freeze({
    bytes,
    sha256,
    sourceInputRoot,
    metafileRoot: graph.metafileRoot,
    implementationClosureDigest,
    sourceInputs: graph.inputs,
    externalBuiltins: graph.externalBuiltins,
    controllerSystemdUnitBytes,
    controllerSystemdUnitSha256,
    targetSystemdUnitSha256,
    installContract: PRE_RELEASE_RESTART_CONTROLLER_INSTALL_CONTRACT_V1,
  });
}

/** Build only through a detached exact pushed commit tree. This function does
 * not install or start either unit; the final pre-release runner owns those
 * root filesystem mutations after Boundary consumes this artifact record. */
export function buildExactPreReleaseRestartControllerArtifactV1(
  repositoryRootValue: string,
  expectedCommitValue: string,
): ExactPreReleaseRestartControllerArtifactV1 {
  const repositoryRoot = canonicalSnapshotRoot(repositoryRootValue);
  const expectedCommit = gitSha40Schema.decode(expectedCommitValue);
  const git = observeExactPushedGitV1(repositoryRoot);
  if (git.commit !== expectedCommit) throw new TypeError("controller build checkout does not equal the Boundary candidate commit");
  return withExactCommitTreeV1(repositoryRoot, expectedCommit, snapshotRoot => Object.freeze({
    candidateReleaseCommit: expectedCommit,
    ...buildPreReleaseRestartControllerBundleV1(snapshotRoot),
  }));
}
