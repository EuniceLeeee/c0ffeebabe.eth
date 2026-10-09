import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { ALGEBRA_POOL_INTERFACE } from "./abi.js";
import { canonicalAddress, requireSuccessfulResult, sameAddress } from "./codec.js";
import type { AlgebraQuoterBinding } from "./types.js";

// Infrastructure deployment, not a pool/factory admission allowlist. Membership
// still requires factory reverse lookup AND this Quoter's exact CREATE2 target.
export const ALGEBRA_BOUND_QUOTER = "0x02f22D58d161d1C291ABfe88764d84120f20F723";
export const ALGEBRA_QUOTER_CODE_HASH = "0xc5b225dfa1929dac89ad0977a85a38ce262b565c96e170f8cd1f752ee5d9feb1";
export const ALGEBRA_POOL_INIT_CODE_HASH = "0xa18736c3ee97fe3c96c9428c0cc2a9116facec18e84f95f9da30543f8238a782";
export const ALGEBRA_QUOTER_INTERFACE = new ethers.Interface([
  "function factory() view returns(address)",
  "function poolDeployer() view returns(address)",
  "function quoteExactInputSingle(address tokenIn,address tokenOut,address deployer,uint256 amountIn,uint160 limitSqrtPrice) returns(uint256 amountOut,uint16 fee)",
]);

// CypherBasePlugin, verified source compiled with solc 0.8.20, paris, runs=200.
// Only compiler-declared immutable slots are masked. Every copy must agree;
// pool and factory immutables must match this admitted instance. Different code
// is an unsupported semantic variant, not evidence that the pool does not exist.
const PLUGIN_BYTES = 15869;
const PLUGIN_NORMALIZED_HASH = "0x1becc6bddf29409e06acf820708b78c35e9aecb6030a6852163ab2d85d5cc048";
const IMMUTABLES = {
  factory: [2296, 5388],
  pool: [664, 3963, 4333, 5768, 6048, 9289],
  pluginFactory: [2198, 5290],
} as const;

export function bindCypherPluginCode(code: string, pool: string, factory: string): string | null {
  if (!ethers.isHexString(code) || ethers.dataLength(code) !== PLUGIN_BYTES) return null;
  const bytes = ethers.getBytes(code);
  const values: Record<string, string> = {};
  for (const [name, offsets] of Object.entries(IMMUTABLES)) {
    const words = offsets.map(start => ethers.hexlify(bytes.slice(start, start + 32)));
    if (!words.every(word => word === words[0]) || !/^0x0{24}[0-9a-f]{40}$/.test(words[0]!)) return null;
    values[name] = ethers.getAddress(`0x${words[0]!.slice(-40)}`);
    for (const start of offsets) bytes.fill(0, start, start + 32);
  }
  if (ethers.keccak256(bytes) !== PLUGIN_NORMALIZED_HASH ||
      !sameAddress(values.pool!, pool) || !sameAddress(values.factory!, factory) ||
      sameAddress(values.pluginFactory!, ethers.ZeroAddress)) return null;
  return values.pluginFactory!;
}

export function algebraQuoterIdentityRequests(factory: string, plugin: string): readonly AdapterRequest[] {
  return [
    { id: "quoter-code", kind: "get-code", address: ALGEBRA_BOUND_QUOTER },
    { id: "plugin-code", kind: "get-code", address: canonicalAddress(plugin) },
    { id: "quoter-factory", kind: "eth-call", to: ALGEBRA_BOUND_QUOTER,
      data: ALGEBRA_QUOTER_INTERFACE.encodeFunctionData("factory"), completion: "return-or-revert-data" },
    { id: "quoter-pool-deployer", kind: "eth-call", to: ALGEBRA_BOUND_QUOTER,
      data: ALGEBRA_QUOTER_INTERFACE.encodeFunctionData("poolDeployer"), completion: "return-or-revert-data" },
    { id: "factory-pool-deployer", kind: "eth-call", to: canonicalAddress(factory),
      data: ALGEBRA_QUOTER_INTERFACE.encodeFunctionData("poolDeployer"), completion: "return-or-revert-data" },
  ];
}

export function algebraQuoterBinding(input: {
  pool: string; factory: string; token0: string; token1: string;
}, results: readonly AdapterRequestResult[]): AlgebraQuoterBinding | null {
  const code = requireSuccessfulResult(results, "quoter-code").data;
  if (ethers.keccak256(code) !== ALGEBRA_QUOTER_CODE_HASH) return null;
  for (const id of ["quoter-factory", "quoter-pool-deployer", "factory-pool-deployer"]) {
    const result = results.find(r => r.id === id);
    if (!result?.ok) throw new Error(`algebra unresolved ${id}`);
    if (result.completion !== "returned") return null;
  }
  const address = (id: string, fn: string) => canonicalAddress(String(ALGEBRA_QUOTER_INTERFACE
    .decodeFunctionResult(fn, requireSuccessfulResult(results, id).data)[0]));
  const factory = address("quoter-factory", "factory");
  const poolDeployer = address("quoter-pool-deployer", "poolDeployer");
  if (!sameAddress(input.factory, factory) || !sameAddress(poolDeployer, address("factory-pool-deployer", "poolDeployer"))) return null;
  const sorted = [canonicalAddress(input.token0), canonicalAddress(input.token1)].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
  const salt = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], sorted));
  if (!sameAddress(ethers.getCreate2Address(poolDeployer, salt, ALGEBRA_POOL_INIT_CODE_HASH), input.pool)) return null;
  const pluginCode = requireSuccessfulResult(results, "plugin-code").data;
  const pluginFactory = bindCypherPluginCode(pluginCode, input.pool, input.factory);
  if (pluginFactory === null) return null;
  return Object.freeze({ quoter: ALGEBRA_BOUND_QUOTER, quoterCodeHash: ALGEBRA_QUOTER_CODE_HASH,
    poolDeployer, pluginCodeHash: ethers.keccak256(pluginCode), pluginFactory });
}

export function algebraQuoterGuardRequests(pool: string, plugin: string, binding: AlgebraQuoterBinding): readonly AdapterRequest[] {
  return [
    { id: "pool-plugin", kind: "eth-call", to: canonicalAddress(pool),
      data: ALGEBRA_POOL_INTERFACE.encodeFunctionData("plugin"), completion: "return-data" },
    { id: "plugin-code", kind: "get-code", address: canonicalAddress(plugin) },
    { id: "quoter-code", kind: "get-code", address: canonicalAddress(binding.quoter) },
  ];
}

export function assertAlgebraSource(results: readonly AdapterRequestResult[], source: CanonicalSource): void {
  if (results.length === 0) throw new Error("algebra missing source-bound results");
  for (const r of results) {
    if (!r.ok) throw new Error(`algebra unresolved ${r.id}`);
    if (r.source.number !== source.number || r.source.hash.toLowerCase() !== source.hash.toLowerCase() ||
        r.source.generation !== source.generation) throw new Error("algebra foreign source evidence");
  }
}

export function assertAlgebraQuoterGuards(plugin: string, binding: AlgebraQuoterBinding, results: readonly AdapterRequestResult[]): void {
  const currentPlugin = String(ALGEBRA_POOL_INTERFACE.decodeFunctionResult("plugin", requireSuccessfulResult(results, "pool-plugin").data)[0]);
  if (!sameAddress(plugin, currentPlugin) ||
      ethers.keccak256(requireSuccessfulResult(results, "plugin-code").data) !== binding.pluginCodeHash ||
      ethers.keccak256(requireSuccessfulResult(results, "quoter-code").data) !== binding.quoterCodeHash) {
    throw new Error("algebra admitted plugin/Quoter binding changed; revalidation required");
  }
}
