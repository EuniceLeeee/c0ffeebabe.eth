import type { GateCoreResultV1 } from "../index.ts";
import type { AssembledReleaseInvocationSetCapabilityV1 } from "../material-provider.ts";

const evaluatedResults = new WeakMap<object, readonly GateCoreResultV1[]>();

export function sealAssembledReleaseAcceptanceResultsV1(
  capability: AssembledReleaseInvocationSetCapabilityV1,
  results: readonly GateCoreResultV1[],
): void {
  if (capability === null || typeof capability !== "object") throw new TypeError("assembled release invocation capability is invalid");
  if (results.length === 0) throw new TypeError("assembled release acceptance result set is empty");
  evaluatedResults.set(capability, Object.freeze([...results]));
}
/** Internal downstream consumer for release-acceptance ownership.  The
 * package runtime never exports raw GateCore results/certificates; a packager
 * owner may import this fixed reader and only after all predicates evaluated. */
export function readAssembledReleaseAcceptanceResultsV1(
  capability: AssembledReleaseInvocationSetCapabilityV1,
): readonly GateCoreResultV1[] {
  if (capability === null || typeof capability !== "object") throw new TypeError("assembled release invocation capability is invalid");
  const results = evaluatedResults.get(capability);
  if (results === undefined) throw new TypeError("assembled release acceptance set is incomplete or was not evaluated");
  return results;
}
