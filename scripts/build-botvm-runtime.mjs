import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Equivalent source/compiler settings to foundry.toml. This narrow fallback
// builds the owner-patched runtime artifact when forge is not installed.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(root, "listener/package.json"));
const solc = require(process.env.BOTVM_SOLC_MODULE ?? process.env.OBSERVED_CALL_SOLC_MODULE ?? "solc");
if (!solc.version().startsWith("0.8.24+")) throw new Error("BotVM requires solc 0.8.24 (foundry.toml)");
const files = ["src/BotVM.sol", "src/Constants.sol", "src/RuntimeAmountVM.sol", "src/RuntimeAmountKernel.sol",
  "src/RuntimeCallSequence.sol", "src/interfaces/IERC20.sol"];
const sources = Object.fromEntries(files.map(file => [file, { content: readFileSync(resolve(root, file), "utf8") }]));
const settings = { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun",
  outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"] } } };
const compiled = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources, settings })));
const errors = (compiled.errors ?? []).filter(error => error.severity === "error");
if (errors.length) throw new Error(errors.map(error => error.formattedMessage).join("\n"));
const contract = compiled.contracts["src/BotVM.sol"].BotVM;
const bytecode = value => ({ ...value, object: "0x" + value.object });
const sha = data => createHash("sha256").update(data).digest("hex");
const sourceHashes = Object.fromEntries(files.map(file => [file, sha(sources[file].content)]));
const artifact = { contractName: "BotVM", sourceName: "src/BotVM.sol", abi: contract.abi,
  bytecode: bytecode(contract.evm.bytecode), deployedBytecode: bytecode(contract.evm.deployedBytecode),
  metadata: contract.metadata, buildProvenance: { compiler: solc.version(), settings, sourceHashes } };
const output = resolve(root, "out/BotVM.sol/BotVM.json");
mkdirSync(dirname(output), { recursive: true });
const bytes = JSON.stringify(artifact, null, 2) + "\n";
writeFileSync(output, bytes);
process.stdout.write(JSON.stringify({ artifact: "out/BotVM.sol/BotVM.json", artifactSha256: sha(bytes),
  runtimeBytes: contract.evm.deployedBytecode.object.length / 2, compiler: solc.version(), sourceHashes }, null, 2) + "\n");
