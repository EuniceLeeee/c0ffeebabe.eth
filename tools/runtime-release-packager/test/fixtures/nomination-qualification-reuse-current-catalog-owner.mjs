import fs from "node:fs";
import { join } from "node:path";
import {
  issueFixtureCurrentCatalogImpactAnalysisCapabilityV1,
} from "../../../catalog-generator/test/fixtures/current-impact-analysis.ts";

export function observeCurrentCatalogImpactAnalysisV1() {
  const root = process.env.ALOHA_NOMINATION_REUSE_TEST_ROOT;
  if (root === undefined) throw new TypeError("production nomination reuse test root is absent");
  const state = JSON.parse(fs.readFileSync(join(root, "current-catalog-state.json"), "utf8"));
  return issueFixtureCurrentCatalogImpactAnalysisCapabilityV1(state);
}
