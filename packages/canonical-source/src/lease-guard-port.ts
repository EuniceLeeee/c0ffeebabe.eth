import type { CanonicalCutoffV1 } from "../../discovery/src/index.ts";

/**
 * Pure type-only boundary used by Graph.  It deliberately carries no source
 * implementation, journal, SQLite driver, constructor, or runtime loader.
 */
export interface CanonicalLeaseGuardPort {
  assertViewAuthorityActive(cutoff: CanonicalCutoffV1): void;
}
