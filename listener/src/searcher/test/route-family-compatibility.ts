import {
  PRODUCTION_ROUTE_FAMILY_MANIFEST,
  deriveRouteFamilyManifest,
} from "../venues/route-family-manifest.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function compactSnapshot(): readonly string[] {
  return PRODUCTION_ROUTE_FAMILY_MANIFEST.map((entry) => [
    entry.executionFamilyId,
    entry.familyKind,
    entry.poolAdapters.join(","),
    entry.edgeAdapterIds.join(","),
    entry.ownedActionAdapterIds.join(","),
    entry.requiredInfraActionAdapterIds.join(","),
    String(entry.declaredVenueCount),
    String(entry.staticRequiresProtocolEdgesFlag),
    entry.dynamicAdmission?.candidateSources.join(",") ?? "-",
    entry.dynamicAdmission ? String(entry.dynamicAdmission.requiresProtocolEdgesFlag) : "-",
  ].join("|"));
}

function testOneToOneProjection(): void {
  const adapters = PRODUCTION_ADAPTER_FAMILIES.routes().list();
  const derived = deriveRouteFamilyManifest(adapters);
  assert(adapters.length === 18, `expected 18 production adapters, got ${adapters.length}`);
  assert(derived.length === adapters.length, "manifest must contain exactly one row per adapter");
  assert(
    new Set(derived.map((entry) => entry.executionFamilyId)).size === adapters.length,
    "manifest execution family ids must be unique",
  );
  for (let index = 0; index < adapters.length; index += 1) {
    assert(
      derived[index]?.executionFamilyId === adapters[index]?.id,
      `manifest order differs from adapter registry at index ${index}`,
    );
  }
  console.log("[route-family-compatibility] one-to-one projection: PASS");
}

function testDynamicAdmission(): void {
  const dynamic = PRODUCTION_ROUTE_FAMILY_MANIFEST.filter(
    (entry) => entry.dynamicAdmission !== null,
  );
  assert(dynamic.length === 3, `expected three dynamic families, got ${dynamic.length}`);
  assert(dynamic[0]?.executionFamilyId === "protocol:erc4626", "ERC4626 dynamic family order");
  assert(
    dynamic[0]?.dynamicAdmission?.candidateSources.join(",") ===
      "dex-token-domain,observed-interaction",
    "ERC4626 candidate-source derivation",
  );
  assert(
    dynamic[0]?.dynamicAdmission?.requiresProtocolEdgesFlag === true,
    "dynamic admission must stay protocol-edge gated",
  );
  assert(
    dynamic[1]?.executionFamilyId === "protocol:erc4626-silo-redeem" &&
      dynamic[1]?.dynamicAdmission?.candidateSources.join(",") ===
        "dex-token-domain,observed-interaction",
    "silo redeem must declare address and observed provenance",
  );
  assert(
    dynamic[2]?.executionFamilyId === "protocol:eigenpie" &&
      dynamic[2]?.dynamicAdmission?.candidateSources.join(",") === "observed-interaction",
    "Eigenpie deposit must declare only the shared observed source",
  );
  console.log("[route-family-compatibility] dynamic admission: PASS");
}

function testPsmCompatibilitySemantics(): void {
  const psm = PRODUCTION_ROUTE_FAMILY_MANIFEST.find(
    (entry) => entry.executionFamilyId === "protocol:psm",
  );
  assert(psm !== undefined, "PSM manifest entry missing");
  assert(psm.declaredVenueCount === 1, "PSM static venue count");
  assert(psm.staticRequiresProtocolEdgesFlag === false, "PSM static route must remain ungated");
  assert(psm.dynamicAdmission === null, "PSM must not gain dynamic admission in Slice 0");
  console.log("[route-family-compatibility] PSM compatibility: PASS");
}

function testReceiptDepositFrameworkIsNotARegisteredFamily(): void {
  const erc4626 = PRODUCTION_ADAPTER_FAMILIES.protocols().find(
    (adapter) => adapter.id === "protocol:erc4626",
  );
  const eigenpie = PRODUCTION_ADAPTER_FAMILIES.protocols().find(
    (adapter) => adapter.id === "protocol:eigenpie",
  );
  assert(erc4626 !== undefined && eigenpie !== undefined, "receipt-deposit users missing");
  assert(
    !PRODUCTION_ADAPTER_FAMILIES.protocols().some(
      (adapter) => adapter.id === "protocol:receipt-deposit",
    ),
    "ReceiptDepositFramework must never become a registry owner",
  );
  assert(
    erc4626.poolAdapters.every((id) => !eigenpie.poolAdapters.includes(id as never)) &&
      erc4626.edgeAdapterIds.every((id) => !eigenpie.edgeAdapterIds.includes(id)),
    "ERC4626 and Eigenpie must retain distinct pool/edge ownership",
  );
  console.log("[route-family-compatibility] receipt-deposit framework boundary: PASS");
}

function testFieldAndOrderSnapshot(): void {
  const expected = [
    "univ2-standard|swap|univ2|univ2-swap|univ2-swap|erc20-transfer|0|false|-|-",
    "univ3-standard|swap|univ3|univ3-swap|univ3-swap|erc20-transfer|0|false|-|-",
    "curve-plain|swap|curve,curve-nr|curve-exchange,curve-exchange-nr,curve-exchange-plain,curve-exchange-received-uint|curve-exchange-plain|erc20-approve|0|false|-|-",
    "curve-underlying|swap|curve-underlying|curve-exchange-underlying|curve-exchange-underlying|erc20-approve|0|false|-|-",
    "balancer-v3|swap|balancer-v3|balancer-v3-unlock|balancer-v3-unlock,balancer-v3-settle,balancer-v3-swap,balancer-v3-send-to|erc20-transfer|0|false|-|-",
    "univ4|swap|univ4|univ4-unlock|univ4-unlock,univ4-swap,univ4-take,univ4-sync,univ4-settle,univ4-settle-value|erc20-transfer,weth-deposit-value,weth-withdraw-amount|0|false|-|-",
    "custom-swap:dodo-v2|swap|dodo-v2|dodo-v2-swap|dodo-v2-swap|erc20-transfer|0|false|-|-",
    "fluid-dex|swap|fluid-dex|fluid-dex-swap|fluid-dex-swap|erc20-approve|0|false|-|-",
    "protocol:erc4626|protocol-conversion|erc4626|erc4626-deposit,erc4626-redeem|erc4626-deposit,erc4626-redeem|erc20-approve|0|true|dex-token-domain,observed-interaction|true",
    "protocol:erc4626-silo-redeem|protocol-conversion|erc4626-silo-redeem|erc4626-redeem-silo|erc4626-redeem-silo||0|true|dex-token-domain,observed-interaction|true",
    "protocol:goldx|protocol-conversion|goldx|goldx-mint|goldx-mint|erc20-approve|1|true|-|-",
    "protocol:metronome-synth|protocol-conversion|metronome-synth|metronome-synth-swap|metronome-synth-swap|erc20-approve|1|true|-|-",
    "protocol:metronome-hgusdc|protocol-conversion|metronome-hgusdc|metronome-hgusdc-exit|metronome-hgusdc-exit|erc20-transfer|1|true|-|-",
    "protocol:psm|protocol-conversion|psm|psm|psm|erc20-approve|1|false|-|-",
    "protocol:eigenpie|protocol-conversion|eigenpie-deposit-router|eigenpie-deposit-asset|eigenpie-deposit-asset|erc20-approve|0|true|observed-interaction|true",
    "protocol:rocksolid|protocol-conversion|rocksolid|rocksolid-sync-deposit|rocksolid-sync-deposit|erc20-approve|1|true|-|-",
    "protocol:wsteth|protocol-conversion|wsteth|wsteth-wrap,wsteth-unwrap|wsteth-wrap,wsteth-unwrap|erc20-approve|1|true|-|-",
    "credit:fluid|credit|fluid-vault|fluid-vault|fluid-vault,fluid-dex-liquidate|erc20-approve|0|false|-|-",
  ] as const;
  const actual = compactSnapshot();
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `field/order snapshot changed:\n${actual.join("\n")}`,
  );
  console.log("[route-family-compatibility] field/order snapshot: PASS");
}

function main(): void {
  testOneToOneProjection();
  testDynamicAdmission();
  testPsmCompatibilitySemantics();
  testReceiptDepositFrameworkIsNotARegisteredFamily();
  testFieldAndOrderSnapshot();
  console.log("route-family-compatibility PASS (5/5)");
}

main();
