import {
  poolAdapterId,
  venueId,
  venueIdentitySource,
} from "../../registry-ids.js";

export const EKUBO_FAMILY_ID = "custom-swap:ekubo-router-v1" as const;
export const EKUBO_EDGE_ADAPTER_ID = "ekubo-router-swap" as const;
export const EKUBO_POOL_ADAPTER_ID = poolAdapterId("ekubo-core-pool-v1");
export const EKUBO_VENUE_ID = venueId("ekubo");
export const EKUBO_IDENTITY_SOURCE = venueIdentitySource(
  "ekubo-core-pool-initialized-v1",
);
export const EKUBO_SWAP_EVENT_ID = "ekubo-core-anonymous-swap" as const;
