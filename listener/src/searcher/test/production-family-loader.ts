import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dodoV2ActionAdapter } from "../../adapters/dodo-v2.js";
import { dodoV2Adapter } from "../venues/swaps/dodo-v2.js";
import { univ2StandardAdapter } from "../venues/swaps/univ2-standard.js";
import {
  defineProductionFamilyModule,
} from "../venues/production-families/contract.js";
import {
  loadProductionFamilyModules,
} from "../venues/production-families/loader.js";

const validModule = defineProductionFamilyModule({
  family: dodoV2Adapter,
  actionAdapters: [Object.freeze({
    ...dodoV2ActionAdapter,
    descriptor: Object.freeze({
      adapterId: dodoV2ActionAdapter.id,
      lineage: "dodo-v2",
      edgeKind: "swap",
      action: "swap",
      canSendValue: false,
      leavesStandingPositionDefault: false,
    }),
  })],
});

const directory = await mkdtemp(join(tmpdir(), "mev-production-families-"));
try {
  for (const name of [
    "a-valid.production.ts",
    "b-invalid.production.ts",
    "c-import-failure.production.ts",
    "d-conflict.production.ts",
    "ignored.ts",
  ]) {
    await writeFile(join(directory, name), "");
  }

  const result = await loadProductionFamilyModules(
    [univ2StandardAdapter],
    {
      sourceDirectory: directory,
      async importEntry(sourceFile) {
        switch (sourceFile) {
          case "a-valid.production.ts":
          case "d-conflict.production.ts":
            return { productionFamilyModule: validModule };
          case "b-invalid.production.ts":
            return { productionFamilyModule: { family: dodoV2Adapter } };
          case "c-import-failure.production.ts":
            throw new Error("synthetic import failure");
          default:
            throw new Error(`unexpected source ${sourceFile}`);
        }
      },
    },
  );

  assert.deepEqual(
    result.modules.map((module) => module.family.id),
    ["custom-swap:dodo-v2"],
  );
  assert.deepEqual(
    result.issues.map((issue) => [issue.sourceFile, issue.code]),
    [
      ["b-invalid.production.ts", "invalid_module_contract"],
      ["c-import-failure.production.ts", "module_import_failed"],
      ["d-conflict.production.ts", "family_registration_conflict"],
    ],
  );
  assert.match(result.scanSha256, /^[a-f0-9]{64}$/);
  console.log("production-family-loader PASS (tracked contract + isolated failures)");
} finally {
  await rm(directory, { recursive: true, force: true });
}
