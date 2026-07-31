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
  const byId = new Map(
    PRODUCTION_ROUTE_FAMILY_MANIFEST.map((entry) => [
      entry.executionFamilyId,
      entry,
    ]),
  );
  const erc4626 = byId.get("protocol:erc4626");
  const silo = byId.get("protocol:erc4626-silo-redeem");
  const eigenpie = byId.get("protocol:eigenpie");
  const selfBurn = byId.get("protocol:self-burn-native");
  assert(
    erc4626?.dynamicAdmission?.candidateSources.join(",") ===
      "dex-token-domain,observed-interaction",
    "ERC4626 candidate-source derivation",
  );
  assert(
    erc4626?.dynamicAdmission?.requiresProtocolEdgesFlag === true,
    "dynamic admission must stay protocol-edge gated",
  );
  assert(
    silo?.dynamicAdmission?.candidateSources.join(",") ===
        "dex-token-domain,observed-interaction",
    "silo redeem must declare address and observed provenance",
  );
  assert(
    eigenpie?.dynamicAdmission?.candidateSources.join(",") === "observed-interaction",
    "Eigenpie deposit must declare only the shared observed source",
  );
  assert(
    selfBurn?.dynamicAdmission?.candidateSources.join(",") ===
        "dex-token-domain,observed-interaction",
    "self-burn-native must declare address and observed provenance",
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

function testBaselineFieldAndOrderFloor(): void {
  const expected = [
    "univ2-standard|swap|univ2|univ2-swap|univ2-swap|erc20-transfer|0|false|-|-",
    "univ3-standard|swap|univ3|univ3-swap|univ3-swap|erc20-transfer|0|false|-|-",
    "curve-plain|swap|curve,curve-nr|curve-exchange,curve-exchange-nr,curve-exchange-plain,curve-exchange-received-uint|curve-exchange-plain|erc20-approve|0|false|-|-",
    "curve-underlying|swap|curve-underlying|curve-exchange-underlying|curve-exchange-underlying|erc20-approve|0|false|-|-",
    "balancer-v3|swap|balancer-v3|balancer-v3-unlock|balancer-v3-unlock,balancer-v3-settle,balancer-v3-swap,balancer-v3-send-to|erc20-transfer|0|false|-|-",
    "univ4|swap|univ4|univ4-unlock|univ4-unlock,univ4-swap,univ4-take,univ4-sync,univ4-settle,univ4-settle-value|erc20-transfer,weth-deposit-value,weth-withdraw-amount|0|false|-|-",
    "custom-swap:angstrom-v4|swap|angstrom-v4|angstrom-v4-swap|angstrom-v4-swap|erc20-approve|0|false|-|-",
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
    "protocol:self-burn-native|protocol-conversion|self-burn-native-token|self-burn-native-redeem|self-burn-native-redeem|weth-deposit-value|0|true|dex-token-domain,observed-interaction|true",
    "credit:fluid|credit|fluid-vault|fluid-vault|fluid-vault,fluid-dex-liquidate|erc20-approve|0|false|-|-",
  ] as const;
  const actual = compactSnapshot();
  const actualById = new Map(
    actual.map((row) => [row.slice(0, row.indexOf("|")), row]),
  );
  let priorIndex = -1;
  for (const protectedRow of expected) {
    const familyId = protectedRow.slice(0, protectedRow.indexOf("|"));
    assert(
      actualById.get(familyId) === protectedRow,
      `protected route row changed: ${familyId}`,
    );
    const index = actual.indexOf(protectedRow);
    assert(index > priorIndex, "protected route relative order changed");
    priorIndex = index;
  }
  console.log("[route-family-compatibility] baseline field/order floor: PASS");
}

function testGenericManifestContract(): void {
  const ids = new Set<string>();
  for (const entry of PRODUCTION_ROUTE_FAMILY_MANIFEST) {
    assert(!ids.has(entry.executionFamilyId), `${entry.executionFamilyId}: duplicate family id`);
    ids.add(entry.executionFamilyId);
    for (const [label, values] of [
      ["pool adapters", entry.poolAdapters],
      ["edge adapters", entry.edgeAdapterIds],
      ["owned actions", entry.ownedActionAdapterIds],
      ["required infra", entry.requiredInfraActionAdapterIds],
    ] as const) {
      assert(
        new Set(values).size === values.length,
        `${entry.executionFamilyId}: duplicate ${label}`,
      );
    }
    const owned = new Set(entry.ownedActionAdapterIds);
    assert(
      entry.requiredInfraActionAdapterIds.every((id) => !owned.has(id)),
      `${entry.executionFamilyId}: owned/infra overlap`,
    );
    assert(
      JSON.stringify(entry.actionAdapterIds) === JSON.stringify([
        ...entry.ownedActionAdapterIds,
        ...entry.requiredInfraActionAdapterIds,
      ]),
      `${entry.executionFamilyId}: action projection`,
    );
    assert(
      Number.isInteger(entry.declaredVenueCount) &&
        entry.declaredVenueCount >= 0,
      `${entry.executionFamilyId}: declared venue count`,
    );
    if (entry.dynamicAdmission) {
      assert(
        entry.familyKind === "protocol-conversion" &&
          entry.staticRequiresProtocolEdgesFlag &&
          entry.dynamicAdmission.requiresProtocolEdgesFlag,
        `${entry.executionFamilyId}: dynamic admission protocol gate`,
      );
      assert(
        entry.dynamicAdmission.candidateSources.length > 0 &&
          new Set(entry.dynamicAdmission.candidateSources).size ===
            entry.dynamicAdmission.candidateSources.length,
        `${entry.executionFamilyId}: dynamic candidate sources`,
      );
    }
  }
  console.log("[route-family-compatibility] generic manifest contract: PASS");
}

function main(): void {
  testOneToOneProjection();
  testDynamicAdmission();
  testPsmCompatibilitySemantics();
  testReceiptDepositFrameworkIsNotARegisteredFamily();
  testBaselineFieldAndOrderFloor();
  testGenericManifestContract();
  console.log("route-family-compatibility PASS (6/6)");
}

main();
