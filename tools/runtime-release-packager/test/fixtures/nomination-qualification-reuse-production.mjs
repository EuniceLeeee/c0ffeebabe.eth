import fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import {
  registerPublicQualifiedReleaseRunnerV1,
} from "../../src/internal/qualified-release-public-runner-state.ts";
import {
  issuePreReleaseAdvisoryMaterialCapabilityV1,
} from "../../src/internal/pre-release-runtime-receipt-state.ts";

const root = process.env.ALOHA_NOMINATION_REUSE_TEST_ROOT;
if (root === undefined) throw new TypeError("production nomination reuse test root is absent");

const original = Object.freeze({
  lstatSync: fs.lstatSync,
  readFileSync: fs.readFileSync,
  realpathSync: fs.realpathSync,
  statSync: fs.statSync,
});
const installedPaths = new Map([
  ["/etc/aloha/runtime-release-binding.json", join(root, "installed", "runtime-release-binding.json")],
  ["/etc/aloha/nomination-qualification-deployment-fact.json", join(root, "installed", "nomination-qualification-deployment-fact.json")],
  ["/etc/aloha/trust/runtime-release-signer-pin.json", join(root, "installed", "runtime-release-signer-pin.json")],
]);
const mappedPath = path => typeof path === "string" ? installedPaths.get(path) : undefined;

fs.lstatSync = (path, ...args) => original.lstatSync(mappedPath(path) ?? path, ...args);
fs.readFileSync = (path, ...args) => original.readFileSync(mappedPath(path) ?? path, ...args);
fs.realpathSync = (path, ...args) => mappedPath(path) === undefined ? original.realpathSync(path, ...args) : path;
fs.statSync = (path, ...args) => {
  const mapped = mappedPath(path);
  const result = original.statSync(mapped ?? path, ...args);
  if (mapped === undefined) return result;
  return Object.assign(Object.create(Object.getPrototypeOf(result)), result, {
    uid: typeof result.uid === "bigint" ? 0n : 0,
  });
};
syncBuiltinESMExports();
const ownerUrl = new URL("../../src/nomination-qualification-reuse-owner.ts", import.meta.url);
const currentCatalogOwnerSpecifier = "../../catalog-generator/src/current-impact-analysis-owner.ts";
const currentCatalogOwnerTestSeamUrl = new URL("./nomination-qualification-reuse-current-catalog-owner.mjs", import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === ownerUrl.href && specifier === currentCatalogOwnerSpecifier) {
      return { url: currentCatalogOwnerTestSeamUrl.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

function readCase(name) {
  const directory = join(root, name);
  const authorizedWire = JSON.parse(original.readFileSync(join(directory, "qualified-runner-wire.json"), "utf8"));
  const qualifiedReleaseRunner = registerPublicQualifiedReleaseRunnerV1({
    loaded: Promise.resolve(undefined), lineage: {}, authorizedWire,
  });
  return issuePreReleaseAdvisoryMaterialCapabilityV1({}, {
    qualifiedReleaseRunner,
    observerStore: {}, performanceObserver: {}, durableTerminalDiscovery: {},
    terminalSelectionObserver: {}, runtimeRestartObserver: {},
    stagingArtifactBytes: {
      "runtime-release-binding.json": new Uint8Array(original.readFileSync(join(directory, "runtime-release-binding.json"))),
      "runtime-release-signer-pin.json": new Uint8Array(original.readFileSync(join(directory, "runtime-release-signer-pin.json"))),
      "nomination-qualification-deployment-fact.json": new Uint8Array(original.readFileSync(join(directory, "nomination-qualification-deployment-fact.json"))),
    },
  });
}

try {
  const { observeProductionNominationQualificationReuseCompositionV1 } = await import(ownerUrl.href);
  const statuses = ["k1", "k2"].map(name => observeProductionNominationQualificationReuseCompositionV1(readCase(name)).status);
  process.stdout.write(JSON.stringify(statuses));
} finally {
  hooks.deregister();
  fs.lstatSync = original.lstatSync;
  fs.readFileSync = original.readFileSync;
  fs.realpathSync = original.realpathSync;
  fs.statSync = original.statSync;
  syncBuiltinESMExports();
}
