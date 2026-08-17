import assert from "node:assert/strict";
import {
  strictExecutionProjectionForHop,
  strictFundingPrewarmAddresses,
  strictRoutePrewarmAddresses,
} from "../strict-execution-projection.js";
import type { FamilyId } from
  "../venues/adapter-family-identifiers.js";
import type { ExecutionRuntimeProjection } from
  "../venues/adapter-family-plugin.js";
import type { FamilyCapabilityCatalog } from
  "../venues/family-capability-catalog.js";

const ROUTE_FAMILY = "protocol:synthetic-route" as FamilyId;
const FUNDING_FAMILY = "funding:synthetic-source" as FamilyId;
const ACTION_ID = "synthetic-action";
const TARGET = `0x${"11".repeat(20)}`;
const TOKEN_IN = `0x${"22".repeat(20)}`;
const TOKEN_OUT = `0x${"33".repeat(20)}`;
const LIQUIDITY_HOLDER = `0x${"44".repeat(20)}`;
const HOP = Object.freeze({
  adapterId: ACTION_ID,
  target: TARGET,
  tokenIn: TOKEN_IN,
  tokenOut: TOKEN_OUT,
});

function syntheticCatalog(
  projection: (input: { readonly hop: typeof HOP }) =>
    ExecutionRuntimeProjection = ({ hop }) => Object.freeze({
      allowanceSpender: hop.target,
      prewarmQuoteCalls: Object.freeze([Object.freeze({
        from: hop.tokenIn,
        to: "",
        calldata: "0x1234",
        gasLimit: 123_456,
      })]),
    }),
): FamilyCapabilityCatalog {
  return Object.freeze({
    listAll() {
      return Object.freeze([
        Object.freeze({
          plugin: Object.freeze({
            manifest: Object.freeze({
              domain: "funding" as const,
              familyId: FUNDING_FAMILY,
            }),
            funding: Object.freeze({
              repayment: Object.freeze({
                target: TARGET,
                liquidityHolder: LIQUIDITY_HOLDER,
              }),
            }),
          }),
        }),
      ]);
    },
    ownerOfAction(adapterId: string) {
      if (adapterId !== ACTION_ID) throw new Error("unknown synthetic action");
      return ROUTE_FAMILY;
    },
    forStrictFamily(familyId: FamilyId) {
      if (familyId === ROUTE_FAMILY) {
        return Object.freeze({
          plugin: Object.freeze({
            execution: Object.freeze({ runtimeProjection: projection }),
          }),
        });
      }
      if (familyId === FUNDING_FAMILY) {
        return Object.freeze({
          plugin: Object.freeze({
            funding: Object.freeze({
              repayment: Object.freeze({
                target: TARGET,
                liquidityHolder: LIQUIDITY_HOLDER,
              }),
            }),
          }),
        });
      }
      throw new Error("unknown synthetic Family");
    },
  }) as unknown as FamilyCapabilityCatalog;
}

function main(): void {
  const catalog = syntheticCatalog();
  const projection = strictExecutionProjectionForHop({ catalog, hop: HOP });
  assert.deepEqual(projection, {
    allowanceSpender: TARGET,
    prewarmQuoteCalls: [{
      from: TOKEN_IN,
      to: "",
      calldata: "0x1234",
      gasLimit: 123_456,
    }],
  });
  assert.equal(
    strictExecutionProjectionForHop({
      catalog,
      hop: Object.freeze({ ...HOP, adapterId: "unknown-action" }),
    }),
    null,
  );

  const malformed = [
    null,
    { allowanceSpender: 7, prewarmQuoteCalls: [] },
    { allowanceSpender: null, prewarmQuoteCalls: {} },
    {
      allowanceSpender: null,
      prewarmQuoteCalls: [{
        from: TARGET,
        to: TARGET,
        calldata: "0x",
        gasLimit: 0,
      }],
    },
  ] as const;
  for (const value of malformed) {
    assert.throws(() => strictExecutionProjectionForHop({
      catalog: syntheticCatalog(() => value as never),
      hop: HOP,
    }));
  }

  assert.deepEqual(
    strictRoutePrewarmAddresses({ catalog, hops: Object.freeze([HOP]) }),
    Object.freeze([TARGET, TOKEN_IN, TOKEN_OUT].sort()),
  );
  assert.deepEqual(
    strictRoutePrewarmAddresses({
      catalog,
      hops: Object.freeze([Object.freeze({
        ...HOP,
        adapterId: "unknown-action",
      })]),
    }),
    Object.freeze([]),
  );

  const fundingAddresses = strictFundingPrewarmAddresses({ catalog });
  assert.deepEqual(
    fundingAddresses,
    Object.freeze([TARGET, LIQUIDITY_HOLDER].sort()),
  );

  console.log(
    "strict-execution-projection PASS " +
      "(synthetic catalog + runtime projection + fail-closed validation)",
  );
}

main();
