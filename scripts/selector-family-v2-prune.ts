/** One-time, source-reviewed migration edits. This module is not a runtime dependency. */
type Data = Record<string, any>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const address = (value: string) => ({ op: "lower", args: [{ op: "address", args: [value] }] });
function keepRequests(step: Data, suffixes: readonly string[]): void {
 step.requests = step.requests.filter((request: Data) => suffixes.some(suffix => request.id.endsWith(`:${suffix}`)));
 step.requirements.transports = [...new Set(step.requests.map((request: Data) => request.kind))];
}
export function pruneOriginalSelectorProvenance(program: Data, notes: string[]): void {
 const label = program.meta?.label ?? program.label, flow = program.binding?.flow;
 if (!flow) return;
 if (label === "protocol:erc4626/morpho-vault-v2") {
  const directions = program.binding.descriptor.verifiedDirections;
  if (directions.op !== "if") return;
  // Both legacy branches yield the same directions; the condition only constructs
  // an otherwise unconsumed identity object (including code hash and decimals).
  const trueValue = directions.args[1].op === "merge" ? Object.assign({}, ...directions.args[1].args) : directions.args[1];
  if (JSON.stringify(trueValue) !== JSON.stringify(directions.args[2])) throw new Error("vault direction branches differ");
  program.binding.descriptor.verifiedDirections = clone(directions.args[2]);
  const vault = flow.steps.find((step: Data) => step.id === "vault");
  keepRequests(vault, ["asset"]); vault.result = { asset: vault.result.asset }; flow.steps = [vault];
  flow.result = { vault: { asset: "$steps.vault.asset" } };
  delete program.values.abi.bindingvaultshareDecimals; delete program.values.abi.bindingassetdecimals;
  notes.push("Removed the unused vault runtime-code hash and share/asset-decimal reads from an identity object whose two direction branches were identical; active execution return/effect guards are unchanged.");
 } else if (label === "protocol:staked-usdat/source-bound-staked-usdat-deposit") {
  const vault = flow.steps.find((step: Data) => step.id === "vault");
  if (!vault.requests.some((request: Data) => request.kind === "get-code")) return;
  keepRequests(vault, ["asset", "oracle", "withdrawalQueue"]);
  vault.result = Object.fromEntries(["asset", "oracle", "withdrawalQueue"].map(key => [key, vault.result[key]])); flow.steps = [vault];
  flow.result = { vault: { asset: "$steps.vault.asset", oracle: "$steps.vault.oracle", withdrawalQueue: "$steps.vault.withdrawalQueue" } };
  program.binding.descriptor.stakedUsdat = { asset: "$binding.vault.asset", oracle: "$binding.vault.oracle", withdrawalQueue: "$binding.vault.withdrawalQueue" };
  notes.push("Removed unused proxy/implementation hashes and the implementation-slot read; kept asset, oracle and withdrawal-queue reads because execution preflight binds those actual dependencies.");
 } else if (label === "ella-exchange/verified-native-base-runtime") {
  const pool = flow.steps.find((step: Data) => step.id === "pool");
  if (pool.requests.length === 1) return;
  keepRequests(pool, ["token"]); pool.result = { token: pool.result.token }; flow.steps = [pool];
  flow.result = { pool: { token: "$steps.pool.token" } };
  program.binding.descriptor = { pool: address("$target"), token: "$binding.pool.token" };
  delete program.values.abi;
  notes.push("Removed unused factory/oracle storage, token-decimal/aggregator calls and pool/factory code hashes; only the storage read that identifies the actual traded token remains. Native execution/effect guards are unchanged.");
 } else if (label === "univ4/singleton-poolkey-active-proof") {
  const key = flow.steps.find((step: Data) => step.id === "key");
  if (!key.requests.some((request: Data) => request.kind === "get-code")) return;
  keepRequests(key, ["words"]);
  const read = key.decode.find((statement: Data) => statement.let === "readValues"); delete read.value.managerCodeHash;
  notes.push("Removed an unused manager-code hash read. The current pool-key read and full ABI-encoded poolId equality remain mandatory; that keccak is a resource identifier, not an identity allowlist.");
 } else if (label === "custom-swap:oneswap/proxy-and-bidirectional-factory-registration") {
  if (!flow.steps.some((step: Data) => step.id === "proxy") && program.math === undefined) return;
  if (program.math && (Object.keys(program.math.entries).join() !== "proxy" ||
      program.math.models.length !== 1 || program.math.models[0].id !== "oneswap:proxy"))
    throw new Error("OneSwap migration contains an unexpected active math model");
  flow.steps = flow.steps.filter((step: Data) => step.id !== "proxy");
  flow.result = { factory: { money: "$steps.factory.money", stock: "$steps.factory.stock" } };
  program.binding.descriptor = { pool: address("$target"), money: "$binding.factory.money", stock: "$binding.factory.stock" };
  delete program.math;
  notes.push("Removed the stale proxy-model/get-code projection and its unused oneswap:proxy math model/entry. Current stock()/money() getters and the execution target fully determine the descriptor; actual asset reads and execution guards remain.");
 } else if (label === "fluid-dex/factory-child-active-quote") {
  if (!flow.steps.some((step: Data) => step.id === "factory")) return;
  flow.steps = flow.steps.filter((step: Data) => step.id !== "factory"); delete flow.result.factory;
  for (const projection of program.binding.descriptor.args) delete projection.factoryBinding;
  delete program.values.abi.bindingfactoryreverseDex;
  notes.push("Removed the unused factory reverse-lookup call and factoryBinding provenance projection. Current constants/asset reads, native mapping, quote and execution effects remain unchanged.");
 }
}
