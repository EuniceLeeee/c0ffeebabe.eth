import { createDeclarativeProtocolRuntime } from "../../declarative-protocol.js";
import definition from "./erc4626.json";
import custodian from "./custodian.json";
import infinifi from "./infinifi.json";
import type { Erc4626Descriptor, Erc4626Route } from "./types.js";
const runtime = createDeclarativeProtocolRuntime(definition, [custodian, infinifi]);
export const erc4626StaticProjection = (descriptor: Erc4626Descriptor) => runtime.projection(descriptor);
export const assertErc4626Invocation = (descriptor: Erc4626Descriptor, route: Erc4626Route) => runtime.assertInvocation(descriptor, route);
