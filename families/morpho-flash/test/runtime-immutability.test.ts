import assert from "node:assert/strict";
import test from "node:test";
import { MORPHO_FLASH_STAGE_DEFINITIONS } from "../src/runtime/definitions.ts";

test("Morpho Flash runtime output codecs are deeply immutable", () => {
  for (const definition of MORPHO_FLASH_STAGE_DEFINITIONS) {
    assert.equal(Object.isFrozen(definition.outputCodec), true, `${definition.stage} output codec must be frozen`);
    const codec = definition.outputCodec as unknown as { decodeExact: (value: unknown) => unknown };
    assert.throws(() => {
      codec.decodeExact = () => null;
    }, TypeError, `${definition.stage} output codec mutation must fail`);
  }
});
