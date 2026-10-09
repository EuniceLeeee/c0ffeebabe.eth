import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult } from "../../../adapter-request-program.js";
import { ALGEBRA_QUOTER_INTERFACE } from "../quoter-model.js";
import { answerFor, candidateFor, FACTORY, identityWith, MEASURED_INSTANCES, result, SOURCE, STATIC_FEE_FACTS } from "./fixtures.js";
import { plugin } from "../../../production-families/algebra-integral.production.js";

export const COMPILED = JSON.parse(readFileSync(new URL("./fixtures/cypher-compiled-runtime.json", import.meta.url), "utf8"));
export const POOL_DEPLOYER = "0x42ac1bEf3f25C29bbE5e06eF5DF3D00eAd7cf20F";
export const PLUGIN_FACTORY = "0xb6e39ac5476feff07933b5424204de95c95068a2";
export const DYNAMIC_FACTS = { ...STATIC_FEE_FACTS, ...MEASURED_INSTANCES[0]!, factory: FACTORY };

// Compiler immutable substitutions, not live chain evidence for arbitrary pools.
export function pluginCode(pool: string, factory = FACTORY): string {
  const bytes = ethers.getBytes(COMPILED.normalizedPluginRuntime);
  for (const [value, offsets] of [
    [pool, [664, 3963, 4333, 5768, 6048, 9289]],
    [factory, [2296, 5388]], [PLUGIN_FACTORY, [2198, 5290]],
  ] as const) for (const offset of offsets) bytes.set(ethers.getBytes(ethers.zeroPadValue(value, 32)), offset);
  return ethers.hexlify(bytes);
}

export function dynamicAnswer(facts = DYNAMIC_FACTS): (request: AdapterRequest) => AdapterRequestResult {
  const prior = answerFor({ facts });
  return request => {
    const values: Record<string, string> = {
      "quoter-code": COMPILED.quoterRuntime,
      "plugin-code": pluginCode(facts.pool, facts.factory),
      "quoter-factory": ALGEBRA_QUOTER_INTERFACE.encodeFunctionResult("factory", [facts.factory]),
      "quoter-pool-deployer": ALGEBRA_QUOTER_INTERFACE.encodeFunctionResult("poolDeployer", [POOL_DEPLOYER]),
      "factory-pool-deployer": ALGEBRA_QUOTER_INTERFACE.encodeFunctionResult("poolDeployer", [POOL_DEPLOYER]),
    };
    if (request.id === "exact-quoter" && request.kind === "eth-call") {
      const args = ALGEBRA_QUOTER_INTERFACE.decodeFunctionData("quoteExactInputSingle", request.data);
      return result(request.id, ALGEBRA_QUOTER_INTERFACE.encodeFunctionResult("quoteExactInputSingle", [BigInt(args.amountIn) * 2n, 500n]), SOURCE);
    }
    return request.id in values ? result(request.id, values[request.id]!, SOURCE) : prior(request);
  };
}

export function dynamicDescriptor() {
  const identity = identityWith(dynamicAnswer(), candidateFor(DYNAMIC_FACTS));
  return plugin.instance.finalizeDescriptor({ identity, draft: plugin.instance.compileDraft(identity), sharedBindings: [] });
}
