import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fluidLocalModelForCode } from "../model.js";
import { FLUID_RESOLVER_FACTORY, FLUID_RESOLVER_LIQUIDITY } from "../capacity.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/local-models.json", import.meta.url), "utf8")) as {
  runtimeCode: string;
  immutableReferences: readonly { name: string; offsets: readonly number[] }[];
  templates: readonly { name: string; runtimeCode?: string; byteLength: number; executableByteLength: number;
    normalizedExecutableSha256: string; matchingDeploymentArtifacts: readonly string[] }[];
};

let covered = 0;
for (const template of fixture.templates) {
  const code = template.runtimeCode ?? fixture.runtimeCode;
  const original = Buffer.from(code.slice(2), "hex");
  const length = original.length - original.readUInt16BE(original.length - 2) - 2;
  assert.equal(original.length, template.byteLength);
  assert.equal(length, template.executableByteLength);
  assert.equal(createHash("sha256").update(original.subarray(0, length)).digest("hex"),
    template.normalizedExecutableSha256, "fixture compiler template has zero immutable words");
  assert.equal(fluidLocalModelForCode(code), null, "an uninstantiated zero-Liquidity template is not a supported runtime");
  covered += template.matchingDeploymentArtifacts.length;

  const instantiated = Buffer.from(original);
  const immutableBytes = new Set<number>();
  for (let i = 0; i < fixture.immutableReferences.length; i++) {
    const group = fixture.immutableReferences[i];
    for (const offset of group.offsets) {
      const word = (group.name === "LIQUIDITY" ? BigInt(FLUID_RESOLVER_LIQUIDITY)
        : group.name === "VAULT_FACTORY" ? BigInt(FLUID_RESOLVER_FACTORY) : BigInt(i + 1))
        .toString(16).padStart(64, "0");
      Buffer.from(word, "hex").copy(instantiated, offset);
      for (let byte = offset; byte < offset + 32; byte++) immutableBytes.add(byte);
      assert.equal(original[offset - 1], 0x7f, "each compiler immutable occupies a PUSH32 operand");
    }
  }
  assert.equal(fluidLocalModelForCode("0x" + instantiated.toString("hex")), "t1-view-v1",
    "model recognizes a new consistent instance without an address allowlist");
  assert.equal(fluidLocalModelForCode("0x" + instantiated.toString("hex").toUpperCase()), "t1-view-v1");
  for (const group of fixture.immutableReferences) {
    if (group.offsets.length > 1) {
      const inconsistent = Buffer.from(instantiated);
      inconsistent[group.offsets[0] + 31] ^= 1;
      assert.equal(fluidLocalModelForCode("0x" + inconsistent.toString("hex")), null,
        `repeated immutable copies must agree: ${group.name}`);
    }
    if (group.name === "LIQUIDITY" || group.name === "VAULT_FACTORY") {
      const foreignLiquidity = Buffer.from(instantiated);
      for (const offset of group.offsets) foreignLiquidity[offset + 31] ^= 1;
      assert.equal(fluidLocalModelForCode("0x" + foreignLiquidity.toString("hex")), null,
        "a consistently bound foreign resolver infrastructure must fall back to simulation");
    }
  }

  // Opcode bytes and non-immutable constants are always part of the fingerprint.
  for (const offset of [0, 100, 257, 639, 20000, length - 1]) {
    assert(!immutableBytes.has(offset));
    const changed = Buffer.from(instantiated);
    changed[offset] ^= 1;
    assert.equal(fluidLocalModelForCode("0x" + changed.toString("hex")), null,
      `executable mutation must fail closed at ${offset}`);
  }
  const metadataChanged = Buffer.from(instantiated);
  metadataChanged[length + 1] ^= 1;
  assert.equal(fluidLocalModelForCode("0x" + metadataChanged.toString("hex")), "t1-view-v1",
    "CBOR metadata provenance differences do not alter the exact executable model");
  const invalidLength = Buffer.from(instantiated);
  invalidLength.writeUInt16BE(0xffff, invalidLength.length - 2);
  assert.equal(fluidLocalModelForCode("0x" + invalidLength.toString("hex")), null);
  assert.equal(fluidLocalModelForCode("0x" + instantiated.toString("hex").slice(0, -2)), null);
  assert.equal(fluidLocalModelForCode("0x" + instantiated.toString("hex") + "00"), null);
}
assert.equal(covered, 13, "all current official deployment artifacts are covered, not admission-listed");
for (const invalid of ["", "0x", "0x0", "0x00", "0x0000", "0xgg", "6000", "0X0000"]) {
  assert.equal(fluidLocalModelForCode(invalid), null);
}
console.log(`PASS Fluid T1 local runtime model: ${fixture.templates.length} compiler models / ${covered} official artifacts`);
