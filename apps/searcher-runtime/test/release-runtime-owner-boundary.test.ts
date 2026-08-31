import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runtimeOwnerSource = readFileSync(
  new URL("../src/release-runtime-owner.ts", import.meta.url),
  "utf8",
);
const releaseOwnerFacadeSource = readFileSync(
  new URL("../../../packages/runtime-release-authority/src/production-runtime-owner.ts", import.meta.url),
  "utf8",
);

test("production runtime consumes one release-owned facade and no acceptance collector implementation", () => {
  assert.match(runtimeOwnerSource, /runtime-release-authority\/src\/production-runtime-owner\.ts/);
  assert.doesNotMatch(runtimeOwnerSource, /acceptance\/collectors\/src/);
  assert.doesNotMatch(runtimeOwnerSource, /packages\/attestation\/src\/internal\//);
  assert.doesNotMatch(runtimeOwnerSource, /runtime-release-authority\/src\/internal\/(?:bootstrap|deployment-runtime-owner|discovery-source-authority-owner|economic-safety-owner|http-family-physical-owner|performance-policy-owner|revm-worker-owner)\.ts/);
  assert.doesNotMatch(runtimeOwnerSource, /verifyAndIssueRuntimeReleaseAuthorityV1|RuntimeReleaseAuthorityV1/);
});

test("release-owned facade does not expose raw authority and rejects structural receiver clones", () => {
  assert.doesNotMatch(releaseOwnerFacadeSource, /readonly authority\s*:/);
  assert.match(releaseOwnerFacadeSource, /if \(receiver !== port\)/);
  assert.match(releaseOwnerFacadeSource, /assertExactKeys\(input, RUNTIME_RELEASE_COMPOSITION_FACADE_KEYS/);
  assert.match(releaseOwnerFacadeSource, /readOwnEnumerableDataProperty\(input, key, "runtimeReleaseCompositionFacade"\)/);
  assert.doesNotMatch(releaseOwnerFacadeSource, /readonly attestation\s*:/);
  assert.match(releaseOwnerFacadeSource, /verifyRuntimeReleaseBindingAuthenticityV1/);
  assert.doesNotMatch(releaseOwnerFacadeSource, /\bsign\s*\(|privateKey|broadcast|promote/);
});
