import assert from "node:assert/strict";
import test from "node:test";
import {
  competitorEoas,
  competitorScanAddresses,
  fullAnalysisEoas,
  loadLiveCompetitorProfile,
} from "../live-competitors.js";

test("live competitor profile binds the four EOAs to their executors", () => {
  const profile = loadLiveCompetitorProfile();

  assert.equal(profile.profile_id, "live-competitors-20260714-v1");
  assert.deepEqual(competitorEoas(profile), [
    "0xc0ffeebabe5d496b2dde509f9fa189c25cf29671",
    "0x3e00d14c2fc4bada34f57fdadb8e2fb2341eae90",
    "0x567ccffad113f74357fc54863e5fcda75e190819",
    "0x7adac85639050c1dea443889e3b4c4adb26ec593",
  ]);
  assert.deepEqual(competitorScanAddresses(profile), [
    "0xc0ffeebabe5d496b2dde509f9fa189c25cf29671",
    "0xe08d97e151473a848c3d9ca3f323cb720472d015",
    "0x3e00d14c2fc4bada34f57fdadb8e2fb2341eae90",
    "0x84cc5f0bc0aa4bf47f3f60628c51cb1ab2745572",
    "0x567ccffad113f74357fc54863e5fcda75e190819",
    "0x92eae2d4f34f17eb32bf390af5019a37d375418e",
    "0x7adac85639050c1dea443889e3b4c4adb26ec593",
    "0xeefe6da5a69365b9fc6d95480122aa075dd3150f",
  ]);
  assert.deepEqual([...fullAnalysisEoas(profile)], [
    "0xc0ffeebabe5d496b2dde509f9fa189c25cf29671",
  ]);
});
