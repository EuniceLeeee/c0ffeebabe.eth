import { defineSwapFamily } from "../adapter-family-plugin.js";
import { balancerV3RouterAction } from "../swaps/balancer-v3-family/action.js";
import { balancerV3Capture } from "../swaps/balancer-v3-family/capture.js";
import { balancerV3Discovery } from "../swaps/balancer-v3-family/discovery.js";
import { balancerV3Exact } from "../swaps/balancer-v3-family/exact.js";
import { balancerV3Execution } from "../swaps/balancer-v3-family/execution.js";
import { balancerV3Identity } from "../swaps/balancer-v3-family/identity.js";
import { balancerV3Instance } from "../swaps/balancer-v3-family/instance.js";
import { balancerV3Manifest } from "../swaps/balancer-v3-family/manifest.js";
import { balancerV3Pricing } from "../swaps/balancer-v3-family/pricing.js";
import { balancerV3Routes } from "../swaps/balancer-v3-family/routes.js";
import { balancerV3Swap } from "../swaps/balancer-v3-family/swap.js";

export const plugin = defineSwapFamily({ manifest: balancerV3Manifest, discovery: balancerV3Discovery,
  capture: balancerV3Capture, identity: balancerV3Identity, instance: balancerV3Instance, routes: balancerV3Routes,
  pricing: balancerV3Pricing, exact: balancerV3Exact, execution: balancerV3Execution, swap: balancerV3Swap,
  actionAdapters: [balancerV3RouterAction] });
