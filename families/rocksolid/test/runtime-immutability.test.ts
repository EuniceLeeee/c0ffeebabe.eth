import assert from "node:assert/strict";
import test from "node:test";
import { ROCKSOLID_STAGE_DEFINITIONS } from "../src/runtime/definitions.ts";

test("RockSolid runtime output codecs are deeply immutable", () => {
  for (const definition of ROCKSOLID_STAGE_DEFINITIONS) {
    assert.equal(Object.isFrozen(definition.outputCodec), true, `${definition.stage} output codec must be frozen`);
    const codec = definition.outputCodec as unknown as { decodeExact: (value: unknown) => unknown };
    assert.throws(() => {
      codec.decodeExact = () => null;
    }, TypeError, `${definition.stage} output codec mutation must fail`);
  }
});
