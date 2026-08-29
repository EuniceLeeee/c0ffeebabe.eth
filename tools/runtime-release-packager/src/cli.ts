#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeCanonicalJson, encodeCanonicalJson } from "../../../packages/canonical-codec/src/index.ts";
import {
  PRODUCTION_RELEASE_LAYOUT_V1,
  verifyInstalledReleaseV1,
  verifyReleasePackageDirectoryV1,
} from "./deployment-package.ts";
import { decodeRuntimeReleasePackageApprovalV1, decodeRuntimeReleaseSignerPinV1 } from "../../../specs/release-authority/src/index.ts";
import { installApprovedProductionReleaseV1 } from "./production-install-owner.ts";
import {
  materializeExternalApprovedReleasePackageV1,
  prepareExternalReleasePackageApprovalV1,
} from "./external-release-workflow.ts";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}

function parseOptions(values: readonly string[]): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--") || key.length < 3 || key.slice(2) in result) {
      fail("options must be unique --name value pairs");
    }
    result[key.slice(2)] = value;
  }
  return Object.freeze(result);
}

function exactOptions(options: Readonly<Record<string, string>>, expected: readonly string[]): void {
  const actual = Object.keys(options).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((value, index) => value !== wanted[index])) {
    fail(`expected options: ${wanted.map(value => `--${value}`).join(" ")}`);
  }
}

function canonicalObject(pathValue: string): unknown {
  const bytes = new Uint8Array(readFileSync(resolve(pathValue)));
  const value = decodeCanonicalJson(bytes);
  if (Buffer.from(bytes).toString("utf8") !== encodeCanonicalJson(value)) throw new TypeError(`artifact is not canonical JSON: ${pathValue}`);
  return value;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const options = parseOptions(process.argv.slice(3));
  if (command === "check-package") {
    exactOptions(options, ["directory", "signer-pin", "approval"]);
    const signerPin = decodeRuntimeReleaseSignerPinV1(canonicalObject(options["signer-pin"]!) as object);
    const approval = decodeRuntimeReleasePackageApprovalV1(canonicalObject(options.approval!) as object);
    const manifest = verifyReleasePackageDirectoryV1(resolve(options.directory!), signerPin, approval);
    process.stdout.write(`${encodeCanonicalJson({ packageRoot: manifest.packageRoot, verdict: "pass" })}\n`);
    return;
  }
  if (command === "check-installed") {
    exactOptions(options, []);
    const manifest = verifyInstalledReleaseV1({
      packageManifestPath: PRODUCTION_RELEASE_LAYOUT_V1.packageManifestPath,
      nodeExecutablePath: PRODUCTION_RELEASE_LAYOUT_V1.nodeExecutablePath,
      entrypointPath: PRODUCTION_RELEASE_LAYOUT_V1.entrypointPath,
      signerPinPath: PRODUCTION_RELEASE_LAYOUT_V1.runtimeSignerPinPath,
      packageApprovalPath: PRODUCTION_RELEASE_LAYOUT_V1.packageApprovalPath,
    });
    process.stdout.write(`${encodeCanonicalJson({ packageRoot: manifest.packageRoot, verdict: "pass" })}\n`);
    return;
  }
  if (command === "install-approved") {
    exactOptions(options, ["directory"]);
    const manifest = installApprovedProductionReleaseV1(resolve(options.directory!));
    process.stdout.write(`${encodeCanonicalJson({ packageRoot: manifest.packageRoot, verdict: "installed" })}\n`);
    return;
  }
  if (command === "prepare-package-approval") {
    exactOptions(options, ["artifact-base"]);
    const receipt = prepareExternalReleasePackageApprovalV1(resolve(options["artifact-base"]!));
    process.stdout.write(`${encodeCanonicalJson(receipt)}\n`);
    return;
  }
  if (command === "materialize-approved") {
    exactOptions(options, ["prepared"]);
    const receipt = materializeExternalApprovedReleasePackageV1(resolve(options.prepared!));
    process.stdout.write(`${encodeCanonicalJson(receipt)}\n`);
    return;
  }
  fail("command must be check-package, check-installed, install-approved, prepare-package-approval, or materialize-approved");
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
