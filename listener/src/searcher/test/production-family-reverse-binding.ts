import assert from "node:assert/strict";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "../venues/production-family-composition.js";

/**
 * Retain-channel declaration contract (F6 Pair B slice): every Family that
 * is non-funding and declares discovery semantics must declare a retain
 * channel — either a real reverse-binding implementation or an explicit
 * unsupported declaration. The validator enforces presence at definition
 * time; this test asserts the projection across the whole production
 * catalog (dynamic enumeration, no family names) so a future family cannot
 * regress the contract.
 */
async function main(): Promise<void> {
  const catalog = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;
  const families = catalog.listAll();
  assert(families.length > 0, "production catalog is empty");
  let discoveryCount = 0;
  let implementationCount = 0;
  let unsupportedCount = 0;
  for (const family of families) {
    const plugin = family.plugin;
    if (!("discovery" in plugin)) continue;
    if (plugin.manifest.domain === "funding") continue;
    discoveryCount += 1;
    const declaration = plugin.discovery.reverseBinding;
    assert(
      declaration !== undefined,
      `${plugin.manifest.familyId} discovery must declare a retain channel`,
    );
    if (declaration.kind === "implementation") {
      implementationCount += 1;
      assert(
        catalog.hasReverseBinding(plugin.manifest.familyId),
        `${plugin.manifest.familyId} catalog projection hasReverseBinding`,
      );
      assert(
        catalog.reverseBindingFor(plugin.manifest.familyId) !== undefined,
        `${plugin.manifest.familyId} catalog projection reverseBindingFor`,
      );
      assert.equal(
        catalog.reverseBindingExplicitlyUnsupported(plugin.manifest.familyId),
        false,
        `${plugin.manifest.familyId} projection must not be unsupported`,
      );
    } else {
      unsupportedCount += 1;
      assert.equal(
        catalog.hasReverseBinding(plugin.manifest.familyId),
        false,
        `${plugin.manifest.familyId} projection hasReverseBinding`,
      );
      assert(
        catalog.reverseBindingExplicitlyUnsupported(plugin.manifest.familyId),
        `${plugin.manifest.familyId} projection reverseBindingExplicitlyUnsupported`,
      );
    }
    // Fresh channel (nominate) must be present alongside the retain
    // declaration for every discovery family.
    assert(
      plugin.discovery.nominate !== undefined,
      `${plugin.manifest.familyId} discovery must declare fresh nomination`,
    );
  }
  // Funding discovery populates a separate lender-asset inventory and does
  // not participate in the venue-instance retain channel. Every non-funding
  // discovery family must have declared one (asserted per-family above).
  assert(discoveryCount > 0, "production catalog has discovery families");

  assert(implementationCount > 0, "at least one family implements reverse binding");
  assert(unsupportedCount > 0, "at least one family declares explicit unsupported");
  console.log(
    `production family reverse-binding contract PASS (${families.length} families, ` +
      `${implementationCount} implementations, ${unsupportedCount} explicit unsupported)`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
