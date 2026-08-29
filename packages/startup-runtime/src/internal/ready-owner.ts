import { ReadyGenerationServiceV1 } from "../../../ready-generation/src/index.ts";
import type {
  StartupReadyPortV1,
} from "../index.ts";
import type { BoundReadyPromotionPort } from "../../../generation-builder/src/index.ts";
import type { ServingValidationInputV1 } from "../../../ready-generation/src/index.ts";

const issued = new WeakSet<object>();
const promotionPorts = new WeakMap<object, BoundReadyPromotionPort>();

/**
 * Owner-only bridge used by runtime-release bootstrap.  A caller must hand
 * in the actual ReadyGenerationServiceV1 instance; a copied/proxy-shaped
 * object is rejected before it can become a startup authority.
 */
export function issueStartupReadyPort(input: {
  readonly service: ReadyGenerationServiceV1;
  /** The exact caller token captured by the release-owned Ready service. */
  readonly promotionCaller: object;
}): StartupReadyPortV1 {
  if (!(input?.service instanceof ReadyGenerationServiceV1)) {
    throw new TypeError("startup ready owner is not ReadyGenerationServiceV1");
  }
  if (input.promotionCaller === null || typeof input.promotionCaller !== "object") {
    throw new TypeError("startup ready promotion caller is missing");
  }
  const promotion = Object.freeze({
    findLatestReusable: (catalog: Parameters<ReadyGenerationServiceV1["findLatestReusable"]>[0], policy: Parameters<ReadyGenerationServiceV1["findLatestReusable"]>[1]) => {
      input.service.assertOwnerCurrent();
      return input.service.findLatestReusable(catalog, policy);
    },
    promote: (promotionInput: Parameters<ReadyGenerationServiceV1["promote"]>[1]) => {
      input.service.assertOwnerCurrent();
      return input.service.promote(input.promotionCaller, promotionInput);
    },
  }) satisfies BoundReadyPromotionPort;
  const port = Object.freeze({
    validateServing: (value: ServingValidationInputV1) => {
      input.service.assertOwnerCurrent();
      return input.service.validateServing(value);
    },
    assertServingBindingCurrent: (value: Parameters<ReadyGenerationServiceV1["assertServingBindingCurrent"]>[0]) => {
      input.service.assertOwnerCurrent();
      return input.service.assertServingBindingCurrent(value);
    },
    consumeServingAdmission: (value: Parameters<ReadyGenerationServiceV1["consumeServingAdmission"]>[0]) => {
      input.service.assertOwnerCurrent();
      return input.service.consumeServingAdmission(value);
    },
  }) as unknown as StartupReadyPortV1;
  issued.add(port);
  promotionPorts.set(port, promotion);
  return port;
}

export function assertIssuedStartupReadyPort(value: unknown): asserts value is StartupReadyPortV1 {
  if (value === null || typeof value !== "object" || !issued.has(value)) {
    throw new TypeError("startup ready port is not owner-issued");
  }
}

/**
 * Private startup edge for GenerationBuilder.  This is intentionally not a
 * method on StartupReadyPortV1: callers holding the public serving port must
 * not be able to bind arbitrary caller objects or mint a second promotion
 * capability.  The WeakMap also makes cloned/structural ports fail closed.
 */
export function startupReadyPromotionPort(value: unknown): BoundReadyPromotionPort {
  assertIssuedStartupReadyPort(value);
  const promotion = promotionPorts.get(value as object);
  if (promotion === undefined) throw new TypeError("startup ready promotion port is unavailable");
  return promotion;
}
