import { defineFamilyActivation } from "./activation.js";
import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { manifest } from "../protocols/mellow-queue-family/manifest.js";
import { mellowQueueDiscovery as discovery } from "../protocols/mellow-queue-family/discovery.js";
import { mellowQueueIdentity as identity } from "../protocols/mellow-queue-family/identity.js";
import { mellowQueueInstance as instance } from "../protocols/mellow-queue-family/instance.js";
import { mellowQueueRoutes as routes } from "../protocols/mellow-queue-family/routes.js";
import { mellowQueuePricing as pricing } from "../protocols/mellow-queue-family/pricing.js";
import { mellowQueueExact as exact } from "../protocols/mellow-queue-family/exact.js";
import { mellowQueueExecution as execution } from "../protocols/mellow-queue-family/execution.js";
import { mellowQueueProtocol as protocol } from "../protocols/mellow-queue-family/protocol.js";
import { mellowQueueCapture as capture } from "../protocols/mellow-queue-family/capture.js";
import {
  mellowDepositFamilyOwnedAction,
  mellowRedeemFamilyOwnedAction,
} from "../protocols/mellow-queue-family/action.js";

export const plugin = defineProtocolFamily({
  manifest,
  discovery,
  identity,
  instance,
  routes,
  pricing,
  exact,
  execution,
  protocol,
  capture,
  actionAdapters: [mellowDepositFamilyOwnedAction, mellowRedeemFamilyOwnedAction],
});

export const activation = defineFamilyActivation({
  enabled: true,
  envKey: "SEARCHER_FAMILY_MELLOW_QUEUE_ENABLED",
});
