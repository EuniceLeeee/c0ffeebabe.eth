import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  selfBurnNativeDiscovery,
} from "../venues/protocols/self-burn-native-discovery.js";

async function main(): Promise<void> {
  const candidate = Object.freeze({
    codeHash: `0x${"1".repeat(64)}`,
    implementationWord: `0x${"2".repeat(64)}`,
  });
  const fingerprint = await selfBurnNativeDiscovery
    .addressMatcherCachePolicy?.currentDependencyFingerprint?.(
      candidate as never,
    );
  assert(fingerprint);
  assert(
    ethers.isHexString(fingerprint, 32),
    "dependency fingerprint must be 32-byte hex",
  );
  const second = await selfBurnNativeDiscovery
    .addressMatcherCachePolicy?.currentDependencyFingerprint?.(
      candidate as never,
    );
  assert.equal(second, fingerprint);
  assert.notEqual(
    fingerprint,
    `0x${"1".repeat(64)}:0x${"2".repeat(64)}`,
    "the old colon-joined format must no longer be produced",
  );
  const changed = await selfBurnNativeDiscovery
    .addressMatcherCachePolicy?.currentDependencyFingerprint?.({
      codeHash: `0x${"3".repeat(64)}`,
      implementationWord: `0x${"2".repeat(64)}`,
    } as never);
  assert.notEqual(changed, fingerprint);
  console.log("self-burn-native-dependency-fingerprint PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
