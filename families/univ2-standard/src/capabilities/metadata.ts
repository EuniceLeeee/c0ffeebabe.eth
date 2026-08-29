import {
  asCapabilityId,
  asSchemaRef,
  type CapabilityId,
  type SchemaRef,
} from "../../../../packages/capability-contracts/src/index.ts";
import { hashDomain, type Hash } from "../../../../packages/canonical-codec/src/index.ts";

export const UNIV2_STANDARD_STATE_CAPABILITY_ID: CapabilityId = asCapabilityId("family.univ2-standard.state");
export const UNIV2_STANDARD_COARSE_CAPABILITY_ID: CapabilityId = asCapabilityId("family.univ2-standard.coarse");
export const UNIV2_STANDARD_EXACT_CAPABILITY_ID: CapabilityId = asCapabilityId("family.univ2-standard.exact");

export const UNIV2_STANDARD_STATE_SCHEMA_HASH: SchemaRef = asSchemaRef(hashDomain(
  "aloha/univ2-standard/capability-schema/v1",
  "state",
));
export const UNIV2_STANDARD_COARSE_SCHEMA_HASH: SchemaRef = asSchemaRef(hashDomain(
  "aloha/univ2-standard/capability-schema/v1",
  "coarse",
));
export const UNIV2_STANDARD_EXACT_SCHEMA_HASH: SchemaRef = asSchemaRef(hashDomain(
  "aloha/univ2-standard/capability-schema/v1",
  "exact",
));

export const UNIV2_STANDARD_STATE_INTERPRETER_HASH: Hash = hashDomain(
  "aloha/univ2-standard/capability-interpreter/v1",
  { capabilityId: UNIV2_STANDARD_STATE_CAPABILITY_ID, modulePath: "families/univ2-standard/src/capabilities/state.ts", exportName: "UNIV2_STANDARD_STATE_PORT" },
);
export const UNIV2_STANDARD_COARSE_INTERPRETER_HASH: Hash = hashDomain(
  "aloha/univ2-standard/capability-interpreter/v1",
  { capabilityId: UNIV2_STANDARD_COARSE_CAPABILITY_ID, modulePath: "families/univ2-standard/src/capabilities/coarse.ts", exportName: "UNIV2_STANDARD_COARSE_PORT" },
);
export const UNIV2_STANDARD_EXACT_INTERPRETER_HASH: Hash = hashDomain(
  "aloha/univ2-standard/capability-interpreter/v1",
  { capabilityId: UNIV2_STANDARD_EXACT_CAPABILITY_ID, modulePath: "families/univ2-standard/src/capabilities/exact.ts", exportName: "UNIV2_STANDARD_EXACT_PORT" },
);

export const UNIV2_STANDARD_SWAP_ACTION_OWNER_ID = "family.univ2-standard.swap-action" as const;
export const UNIV2_STANDARD_SWAP_ACTION_SCHEMA_HASH: SchemaRef = asSchemaRef(hashDomain(
  "aloha/univ2-standard/action-schema/v1",
  UNIV2_STANDARD_SWAP_ACTION_OWNER_ID,
));
export const UNIV2_STANDARD_SWAP_ACTION_IMPLEMENTATION_HASH: Hash = hashDomain(
  "aloha/univ2-standard/action-implementation/v1",
  {
    ownerId: UNIV2_STANDARD_SWAP_ACTION_OWNER_ID,
    modulePath: "families/univ2-standard/src/capabilities/action.ts",
    exportName: "UNIV2_STANDARD_SWAP_ACTION_PORT",
  },
);

/** Release policy, never inferred from an instance address. */
export const UNIV2_STANDARD_SWAP_FEE_BPS = 30n;
export const UNIV2_STANDARD_SWAP_FEE_BPS_DECIMAL = "30" as const;
export const UNIV2_STANDARD_SWAP_GAS_UPPER_BOUND = "200000" as const;

/** Uniswap V2 pair `swap(uint256,uint256,address,bytes)`. */
export const UNIV2_STANDARD_SWAP_SELECTOR = "0x022c0d9f" as const;
