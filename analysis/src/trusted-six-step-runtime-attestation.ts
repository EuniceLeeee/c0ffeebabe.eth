import { createHash } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import {
  HISTORICAL_PRODUCTION_INSTANCE_ID,
  trustedSsmTunnelReady,
} from "./historical-gap.js";

const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const HASH32 = /^0x[a-f0-9]{64}$/;
const COMMAND_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SENSITIVE =
  /(?:^|_)(?:URL|URI|WS|RPC|KEY|SECRET|TOKEN|SIGNER|PASSWORD|AUTH|CREDENTIAL|MNEMONIC|SEED|ENDPOINT|WEBHOOK|DSN)(?:_|$)/i;

export const TRUSTED_SIX_STEP_AWS_REGION = "us-east-1";
export const TRUSTED_SIX_STEP_PRODUCTION_INSTANCE_ID =
  HISTORICAL_PRODUCTION_INSTANCE_ID;

export interface TrustedSixStepRuntimePayload {
  schema_version: 1; kind: "trusted-six-step-runtime-attestation";
  instance_id: string; runtime_commit: string;
  process: { pid: number; starttime_ticks: string; n_restarts: number };
  universe: { path: string; sha256: string };
  universe_manifest: { path: string; sha256: string };
  runtime_json_inputs: Record<string, { path: string; sha256: string }>;
  pool_universe_top_n: number; searcher_config: Record<string, string>;
  sample_receipt: {
    tx_hash: string;
    receipt_sha256: string;
    block_hash: string;
    block_number: number;
    transaction_index: number;
    status: 0 | 1;
  };
  parent_block: { number: number; hash: string; state_root: string };
  observed_at: string;
}

export interface TrustedSixStepRuntimeAttestation
  extends TrustedSixStepRuntimePayload {
  payload_sha256: string;
  command_id: string;
}

export interface TrustedSixStepInputSnapshotPayload {
  schema_version: 1; kind: "trusted-six-step-input-snapshot";
  sample_tx_hash: string; lane: "block_scan_standing";
  source_runtime_commit: string;
  local_universe: { path: string; sha256: string };
  local_universe_manifest: { path: string; sha256: string };
  runtime_attestation: TrustedSixStepRuntimeAttestation;
  state_anchor: {
    lane: "block_scan_standing"; opportunity_block: number; base_block: number;
    base_block_hash: string; base_state_root: string;
    applied_prefix_tx_hashes: readonly [];
    trigger_tx_hash: null; target_tx_index: null; effective_state_hash: string;
  };
  created_at: string;
}

export interface TrustedSixStepInputSnapshot
  extends TrustedSixStepInputSnapshotPayload {
  payload_sha256: string;
}

export interface TrustedSixStepRpcTransport {
  rpcUrl: string; close: () => Promise<void>;
}

export function canonicalTrustedSixStepRuntimePayload(
  value: TrustedSixStepRuntimePayload,
): string {
  const { payload_sha256: _digest, command_id: _command, ...payload } =
    value as TrustedSixStepRuntimeAttestation;
  return `${canonicalJson(payload)}\n`;
}

export function canonicalTrustedSixStepRuntimePayloadSha256(
  value: TrustedSixStepRuntimePayload,
): string {
  return sha256(canonicalTrustedSixStepRuntimePayload(value));
}

export function canonicalTrustedSixStepInputSnapshotPayloadSha256(
  value: TrustedSixStepInputSnapshotPayload,
): string {
  const { payload_sha256: _digest, ...payload } =
    value as TrustedSixStepInputSnapshot;
  return sha256(`${canonicalJson(payload)}\n`);
}

export function validateTrustedSixStepRuntimeAttestation(
  value: unknown,
  expectedSampleTx: string,
): string[] {
  if (!record(value)) return ["runtime attestation must be an object"];
  const errors: string[] = [];
  const expectedKeys = [
    "schema_version", "kind", "instance_id", "runtime_commit", "process",
    "universe", "universe_manifest", "runtime_json_inputs",
    "pool_universe_top_n",
    "searcher_config", "sample_receipt", "parent_block", "observed_at",
    "payload_sha256", "command_id",
  ];
  if (!exactKeys(value, expectedKeys)) errors.push("runtime attestation has unknown top-level fields");
  if (value.schema_version !== 1 ||
      value.kind !== "trusted-six-step-runtime-attestation") {
    errors.push("runtime attestation schema/kind is invalid");
  }
  if (value.instance_id !== TRUSTED_SIX_STEP_PRODUCTION_INSTANCE_ID) {
    errors.push("runtime attestation uses the wrong production instance");
  }
  if (typeof value.runtime_commit !== "string" || !SHA40.test(value.runtime_commit)) {
    errors.push("runtime_commit must be a full git SHA");
  }
  if (!COMMAND_ID.test(String(value.command_id ?? ""))) {
    errors.push("command_id must be an AWS SSM command id");
  }
  validateProcess(value.process, errors);
  const universe = pathHash(value.universe);
  const manifest = pathHash(value.universe_manifest);
  if (!universe ||
      universe.path !== `/opt/MEV-runtime/universe/active-pools-${universe.sha256}.json`) {
    errors.push("production universe is not content-addressed");
  }
  if (!manifest || !universe || manifest.path !== `${universe.path}.manifest.json`) {
    errors.push("manifest path does not match the frozen universe");
  }
  if (!Number.isSafeInteger(value.pool_universe_top_n) ||
      Number(value.pool_universe_top_n) <= 0) {
    errors.push("pool_universe_top_n must be positive");
  }
  validateConfig(value, errors);
  validateRuntimeJsonInputs(value, errors);
  validateReceiptAndParent(value, expectedSampleTx.toLowerCase(), errors);
  if (typeof value.observed_at !== "string" ||
      !Number.isFinite(Date.parse(value.observed_at))) {
    errors.push("observed_at must be an ISO timestamp");
  }
  if (typeof value.payload_sha256 !== "string" ||
      value.payload_sha256 !==
        canonicalTrustedSixStepRuntimePayloadSha256(
          value as unknown as TrustedSixStepRuntimeAttestation,
        )) {
    errors.push("payload_sha256 does not match the canonical payload");
  }
  return errors;
}

export function validateTrustedSixStepInputSnapshot(
  value: unknown,
  expectedSampleTx: string,
): string[] {
  if (!record(value)) return ["input snapshot must be an object"];
  const errors: string[] = [];
  if (!exactKeys(value, [
    "schema_version", "kind", "sample_tx_hash", "lane",
    "source_runtime_commit", "local_universe", "local_universe_manifest",
    "runtime_attestation", "state_anchor", "created_at", "payload_sha256",
  ])) errors.push("input snapshot has unknown fields");
  if (value.schema_version !== 1 ||
      value.kind !== "trusted-six-step-input-snapshot" ||
      value.lane !== "block_scan_standing") {
    errors.push("input snapshot schema/kind/lane is invalid");
  }
  const sample = expectedSampleTx.toLowerCase();
  if (value.sample_tx_hash !== sample || !HASH32.test(sample)) {
    errors.push("input snapshot sample does not match request");
  }
  errors.push(...validateTrustedSixStepRuntimeAttestation(
    value.runtime_attestation,
    sample,
  ));
  const runtime = record(value.runtime_attestation)
    ? value.runtime_attestation as unknown as TrustedSixStepRuntimeAttestation
    : null;
  const localUniverse = pathHash(value.local_universe, false);
  const localManifest = pathHash(value.local_universe_manifest, false);
  if (!runtime ||
      value.source_runtime_commit !== runtime.runtime_commit ||
      localUniverse?.sha256 !== runtime.universe.sha256 ||
      localManifest?.sha256 !== runtime.universe_manifest.sha256) {
    errors.push("local universe does not match runtime attestation");
  }
  validateSnapshotAnchor(value.state_anchor, runtime, errors);
  if (typeof value.created_at !== "string" ||
      !Number.isFinite(Date.parse(value.created_at))) {
    errors.push("input snapshot created_at is invalid");
  }
  if (typeof value.payload_sha256 !== "string" ||
      value.payload_sha256 !== canonicalTrustedSixStepInputSnapshotPayloadSha256(
        value as unknown as TrustedSixStepInputSnapshot,
      )) {
    errors.push("input snapshot payload_sha256 does not bind its payload");
  }
  return errors;
}

export async function fetchTrustedSixStepRuntimeAttestation(
  sampleTx: string,
): Promise<TrustedSixStepRuntimeAttestation> {
  const tx = sampleTx.toLowerCase();
  if (!HASH32.test(tx)) throw new Error("sample transaction hash is invalid");
  const commandId = sendSsm(runtimeAttestationScript(tx));
  const payload = await readSsmJson(commandId);
  const candidate = record(payload) ? { ...payload, command_id: commandId } : payload;
  const errors = validateTrustedSixStepRuntimeAttestation(candidate, tx);
  if (errors.length) throw new Error(`trusted runtime attestation failed: ${errors.join("; ")}`);
  return candidate as unknown as TrustedSixStepRuntimeAttestation;
}

export async function fetchTrustedSixStepRuntimeJsonInputs(
  attestation: TrustedSixStepRuntimeAttestation,
): Promise<Record<string, Buffer>> {
  const commandId = sendSsm(runtimeJsonInputScript(
    attestation.runtime_json_inputs,
  ));
  return decodeTrustedSixStepRuntimeJsonInputs(
    await readSsmJson(commandId),
    attestation,
  );
}

export function decodeTrustedSixStepRuntimeJsonInputs(
  value: unknown,
  attestation: TrustedSixStepRuntimeAttestation,
): Record<string, Buffer> {
  if (!record(value)) throw new Error("runtime JSON input bundle must be an object");
  const expected = Object.keys(attestation.runtime_json_inputs).sort();
  if (Object.keys(value).sort().join("\n") !== expected.join("\n")) {
    throw new Error("runtime JSON input bundle keys do not match attestation");
  }
  const decoded: Record<string, Buffer> = {};
  for (const key of expected) {
    const item = value[key];
    const attested = attestation.runtime_json_inputs[key];
    if (!record(item) || !attested ||
        item.path !== attested.path ||
        item.sha256 !== attested.sha256 ||
        typeof item.base64 !== "string") {
      throw new Error(`runtime JSON input bundle metadata mismatch: ${key}`);
    }
    const bytes = Buffer.from(item.base64, "base64");
    if (bytes.length === 0 || sha256(bytes) !== attested.sha256) {
      throw new Error(`runtime JSON input bundle hash mismatch: ${key}`);
    }
    decoded[key] = bytes;
  }
  return decoded;
}

export async function openTrustedSixStepRpcTransport():
Promise<TrustedSixStepRpcTransport> {
  const localPort = await availablePort();
  const child = startTunnel(localPort);
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await stopChild(child);
  };
  try {
    await waitForTunnel(child, localPort);
    const rpcUrl = `http://127.0.0.1:${localPort}`;
    const chainId = await rpc<string>(rpcUrl, "eth_chainId", []);
    if (chainId.toLowerCase() !== "0x1") throw new Error("trusted RPC is not mainnet");
    return { rpcUrl, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function validateProcess(value: unknown, errors: string[]): void {
  if (!record(value) ||
      !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 ||
      typeof value.starttime_ticks !== "string" ||
      !/^[0-9]+$/.test(value.starttime_ticks) ||
      !Number.isSafeInteger(value.n_restarts) || Number(value.n_restarts) < 0) {
    errors.push("process identity is invalid");
  }
}

function validateConfig(value: Record<string, unknown>, errors: string[]): void {
  if (!record(value.searcher_config)) {
    errors.push("searcher_config must be an object");
    return;
  }
  for (const [key, entry] of Object.entries(value.searcher_config)) {
    if (!/^SEARCHER_[A-Z0-9_]+$/.test(key) || SENSITIVE.test(key) ||
        typeof entry !== "string" || /[a-z][a-z0-9+.-]*:\/\//i.test(entry)) {
      errors.push(`searcher_config contains sensitive key or unsafe value: ${key}`);
    }
  }
  const config = value.searcher_config as Record<string, string>;
  if (config.SEARCHER_RUNTIME_COMMIT !== value.runtime_commit) {
    errors.push("runtime commit does not match searcher config");
  }
  if (config.SEARCHER_POOL_UNIVERSE_PATH !==
      (value.universe as { path?: string })?.path ||
      config.SEARCHER_POOL_UNIVERSE_MANIFEST_PATH !==
        (value.universe_manifest as { path?: string })?.path ||
      config.SEARCHER_POOL_UNIVERSE_TOP_N !==
        String(value.pool_universe_top_n)) {
    errors.push("runtime universe/top-N does not match searcher config");
  }
}

function validateRuntimeJsonInputs(
  value: Record<string, unknown>,
  errors: string[],
): void {
  if (!record(value.searcher_config) || !record(value.runtime_json_inputs)) {
    errors.push("runtime_json_inputs must be an object");
    return;
  }
  const config = value.searcher_config as Record<string, string>;
  const expected = Object.entries(config)
    .filter(([, path]) =>
      path.startsWith("/opt/MEV-runtime/") &&
      path.endsWith(".json") &&
      path !== (value.universe as { path?: string })?.path &&
      path !== (value.universe_manifest as { path?: string })?.path)
    .map(([key]) => key)
    .sort();
  const actual = Object.keys(value.runtime_json_inputs).sort();
  if (actual.join("\n") !== expected.join("\n")) {
    errors.push("runtime_json_inputs do not cover exact production JSON paths");
    return;
  }
  for (const key of expected) {
    const input = pathHash(value.runtime_json_inputs[key], true, false);
    if (!input ||
        input.path !== config[key] ||
        !input.path.endsWith(`-${input.sha256}.json`)) {
      errors.push(`runtime JSON input is not content-addressed: ${key}`);
    }
  }
}

function validateReceiptAndParent(
  value: Record<string, unknown>,
  expectedTx: string,
  errors: string[],
): void {
  const receipt = record(value.sample_receipt) ? value.sample_receipt : null;
  const parent = record(value.parent_block) ? value.parent_block : null;
  if (!receipt ||
      receipt.tx_hash !== expectedTx ||
      !SHA64.test(String(receipt.receipt_sha256 ?? "")) ||
      !HASH32.test(String(receipt.block_hash ?? "")) ||
      !Number.isSafeInteger(receipt.block_number) ||
      !Number.isSafeInteger(receipt.transaction_index) ||
      (receipt.status !== 0 && receipt.status !== 1)) {
    errors.push("sample receipt does not match requested sample");
  }
  if (!parent || !Number.isSafeInteger(parent.number) ||
      !HASH32.test(String(parent.hash ?? "")) ||
      !HASH32.test(String(parent.state_root ?? ""))) {
    errors.push("parent block is invalid");
  } else if (receipt &&
      Number(parent.number) !== Number(receipt.block_number) - 1) {
    errors.push("parent block is not sample block_number - 1");
  }
}

function validateSnapshotAnchor(
  value: unknown,
  runtime: TrustedSixStepRuntimeAttestation | null,
  errors: string[],
): void {
  if (!record(value) || value.lane !== "block_scan_standing" ||
      !Number.isSafeInteger(value.opportunity_block) ||
      Number(value.base_block) !== Number(value.opportunity_block) - 1 ||
      !HASH32.test(String(value.base_block_hash ?? "")) ||
      !HASH32.test(String(value.base_state_root ?? "")) ||
      !Array.isArray(value.applied_prefix_tx_hashes) ||
      value.applied_prefix_tx_hashes.length !== 0 ||
      value.trigger_tx_hash !== null || value.target_tx_index !== null ||
      !SHA64.test(String(value.effective_state_hash ?? ""))) {
    errors.push("input snapshot state anchor is not canonical standing state");
    return;
  }
  const effective = sha256(canonicalJson({
    applied_prefix_tx_hashes: [],
    base_block_hash: value.base_block_hash,
    base_state_root: value.base_state_root,
  }));
  if (value.effective_state_hash !== effective) {
    errors.push("input snapshot effective_state_hash does not bind parent state");
  }
  if (runtime && (value.opportunity_block !== runtime.sample_receipt.block_number ||
      value.base_block !== runtime.parent_block.number ||
      value.base_block_hash !== runtime.parent_block.hash ||
      value.base_state_root !== runtime.parent_block.state_root)) {
    errors.push("input snapshot state anchor does not bind runtime receipt/parent");
  }
}

function runtimeAttestationScript(sampleTx: string): string {
  return String.raw`set -eu
test "$(systemctl is-active mev-searcher)" = active
pid=$(systemctl show -p MainPID --value mev-searcher)
restarts=$(systemctl show -p NRestarts --value mev-searcher)
start=$(python3 - "$pid" <<'PY'
import pathlib,sys
s=pathlib.Path(f"/proc/{sys.argv[1]}/stat").read_text(); print(s[s.rfind(")")+2:].split()[19])
PY
)
python3 - "$pid" "$start" "$restarts" "${sampleTx}" <<'PY'
import datetime,hashlib,json,pathlib,re,sys,urllib.parse,urllib.request
pid,start,restarts,tx=int(sys.argv[1]),sys.argv[2],int(sys.argv[3]),sys.argv[4]
env={}
for item in pathlib.Path(f"/proc/{pid}/environ").read_bytes().split(b"\0"):
  if b"=" in item:
    k,v=item.split(b"=",1); env[k.decode()]=v.decode()
required=["SEARCHER_RUNTIME_COMMIT","SEARCHER_POOL_UNIVERSE_PATH",
          "SEARCHER_POOL_UNIVERSE_MANIFEST_PATH","SEARCHER_POOL_UNIVERSE_TOP_N"]
if any(not env.get(k) for k in required): raise SystemExit("missing runtime config")
commit=env[required[0]].lower(); universe=env[required[1]]; manifest=env[required[2]]
top_n=int(env[required[3]])
digest=lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
ush,msh=digest(universe),digest(manifest)
if universe != f"/opt/MEV-runtime/universe/active-pools-{ush}.json": raise SystemExit("universe not content addressed")
if manifest != universe+".manifest.json": raise SystemExit("manifest mismatch")
forbidden=re.compile(r"(?:^|_)(?:URL|URI|WS|RPC|KEY|SECRET|TOKEN|SIGNER|PASSWORD|AUTH|CREDENTIAL|MNEMONIC|SEED|ENDPOINT|WEBHOOK|DSN)(?:_|$)",re.I)
config={k:v for k,v in env.items() if re.fullmatch(r"SEARCHER_[A-Z0-9_]+",k)
        and not forbidden.search(k) and "://" not in v and "\n" not in v}
runtime_json_inputs={
 k:{"path":v,"sha256":digest(v)}
 for k,v in sorted(config.items())
 if v.startswith("/opt/MEV-runtime/") and v.endswith(".json")
 and v not in (universe,manifest)
}
url=env.get("SEARCHER_LIVE_RPC_URL") or env.get("MAINNET_RPC_URL")
parsed=urllib.parse.urlparse(url or "")
if parsed.scheme!="http" or parsed.hostname not in ("localhost","127.0.0.1","::1") or not parsed.port:
  raise SystemExit("searcher RPC is not local reth")
counter=0
def rpc(method,params):
  global counter; counter+=1
  body=json.dumps({"jsonrpc":"2.0","id":counter,"method":method,"params":params}).encode()
  req=urllib.request.Request(url,data=body,headers={"content-type":"application/json"})
  with urllib.request.urlopen(req,timeout=30) as response: answer=json.load(response)
  if answer.get("error") or "result" not in answer: raise SystemExit(f"RPC {method} failed")
  return answer["result"]
receipt=rpc("eth_getTransactionReceipt",[tx])
if not receipt or receipt["transactionHash"].lower()!=tx: raise SystemExit("sample receipt missing")
block=int(receipt["blockNumber"],16); parent=rpc("eth_getBlockByNumber",[hex(block-1),False])
receipt_bytes=(json.dumps(receipt,sort_keys=True,separators=(",",":"))+"\n").encode()
payload={
 "schema_version":1,"kind":"trusted-six-step-runtime-attestation",
 "instance_id":"${TRUSTED_SIX_STEP_PRODUCTION_INSTANCE_ID}","runtime_commit":commit,
 "process":{"pid":pid,"starttime_ticks":start,"n_restarts":restarts},
 "universe":{"path":universe,"sha256":ush},
 "universe_manifest":{"path":manifest,"sha256":msh},
 "runtime_json_inputs":runtime_json_inputs,
 "pool_universe_top_n":top_n,"searcher_config":config,
 "sample_receipt":{"tx_hash":tx,"receipt_sha256":hashlib.sha256(receipt_bytes).hexdigest(),
   "block_hash":receipt["blockHash"].lower(),"block_number":block,
   "transaction_index":int(receipt["transactionIndex"],16),"status":int(receipt["status"],16)},
 "parent_block":{"number":block-1,"hash":parent["hash"].lower(),
   "state_root":parent["stateRoot"].lower()},
 "observed_at":datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z")}
canonical=(json.dumps(payload,sort_keys=True,separators=(",",":"))+"\n").encode()
payload["payload_sha256"]=hashlib.sha256(canonical).hexdigest()
print(json.dumps(payload,sort_keys=True,separators=(",",":")))
PY
test "$(systemctl show -p MainPID --value mev-searcher)" = "$pid"
test "$(systemctl show -p NRestarts --value mev-searcher)" = "$restarts"`;
}

function runtimeJsonInputScript(
  inputs: Record<string, { path: string; sha256: string }>,
): string {
  const encoded = Buffer.from(JSON.stringify(inputs)).toString("base64");
  return String.raw`set -eu
python3 - "${encoded}" <<'PY'
import base64,hashlib,json,pathlib,sys
inputs=json.loads(base64.b64decode(sys.argv[1]))
result={}
total=0
for key,item in sorted(inputs.items()):
  data=pathlib.Path(item["path"]).read_bytes()
  digest=hashlib.sha256(data).hexdigest()
  if digest != item["sha256"]: raise SystemExit("runtime JSON input hash drift")
  total += len(data)
  if total > 12288: raise SystemExit("runtime JSON inputs exceed SSM transfer bound")
  result[key]={"path":item["path"],"sha256":digest,
               "base64":base64.b64encode(data).decode()}
print(json.dumps(result,sort_keys=True,separators=(",",":")))
PY`;
}

function sendSsm(script: string): string {
  const id = execFileSync("aws", [
    "ssm", "send-command", "--region", TRUSTED_SIX_STEP_AWS_REGION,
    "--instance-ids", TRUSTED_SIX_STEP_PRODUCTION_INSTANCE_ID,
    "--document-name", "AWS-RunShellScript",
    "--parameters", JSON.stringify({ commands: [script] }),
    "--query", "Command.CommandId", "--output", "text",
  ], { encoding: "utf8", env: commandEnv(), timeout: 30_000 }).trim();
  if (!COMMAND_ID.test(id)) throw new Error("AWS SSM did not return a command id");
  return id;
}

async function readSsmJson(commandId: string): Promise<unknown> {
  for (let attempt = 0; attempt < 60; attempt++) {
    let output: Record<string, unknown>;
    try {
      output = JSON.parse(execFileSync("aws", [
        "ssm", "get-command-invocation", "--region", TRUSTED_SIX_STEP_AWS_REGION,
        "--command-id", commandId, "--instance-id",
        TRUSTED_SIX_STEP_PRODUCTION_INSTANCE_ID, "--output", "json",
      ], { encoding: "utf8", env: commandEnv(), timeout: 30_000 })) as
        Record<string, unknown>;
    } catch {
      if (attempt === 59) throw new Error("cannot read SSM command result");
      await sleep(2_000);
      continue;
    }
    const status = String(output.Status ?? "");
    if (status === "Success") {
      return JSON.parse(String(output.StandardOutputContent ?? "").trim());
    }
    if (!["Pending", "InProgress", "Delayed"].includes(status)) {
      throw new Error(`runtime attestation SSM command failed: ${status}`);
    }
    await sleep(2_000);
  }
  throw new Error("runtime attestation SSM command timed out");
}

function startTunnel(localPort: number): ChildProcess {
  const child = spawn("aws", [
    "ssm", "start-session", "--region", TRUSTED_SIX_STEP_AWS_REGION,
    "--target", TRUSTED_SIX_STEP_PRODUCTION_INSTANCE_ID,
    "--document-name", "AWS-StartPortForwardingSession",
    "--parameters", JSON.stringify({
      portNumber: ["8545"], localPortNumber: [String(localPort)],
    }),
  ], { env: commandEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const append = (chunk: Buffer | string): void => {
    output = `${output}${chunk.toString()}`.slice(-4_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  Object.assign(child, { tunnelOutput: () => output });
  return child;
}

async function waitForTunnel(child: ChildProcess, port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const output = (child as ChildProcess & { tunnelOutput?: () => string })
      .tunnelOutput?.() ?? "";
    if (child.exitCode !== null) throw new Error(`SSM tunnel exited: ${output}`);
    if (trustedSsmTunnelReady(output, port) && await canConnect(port)) return;
    await sleep(250);
  }
  throw new Error("SSM tunnel did not become ready");
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function canConnect(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(500).once("connect", () => done(true))
      .once("timeout", () => done(false)).once("error", () => done(false));
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    sleep(5_000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5_000),
  });
  const payload = await response.json() as { result?: T; error?: unknown };
  if (!response.ok || payload.error || payload.result === undefined) {
    throw new Error(`trusted RPC ${method} failed`);
  }
  return payload.result;
}

function pathHash(
  value: unknown,
  production = true,
  universeOnly = true,
): { path: string; sha256: string } | null {
  if (!record(value) || typeof value.path !== "string" ||
      typeof value.sha256 !== "string" || !SHA64.test(value.sha256) ||
      (production && universeOnly &&
        !value.path.startsWith("/opt/MEV-runtime/universe/")) ||
      (production && !universeOnly &&
        !value.path.startsWith("/opt/MEV-runtime/")) ||
      (!production && !value.path.startsWith("/"))) return null;
  return value as { path: string; sha256: string };
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function commandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  for (const key of ["HOME", "LANG", "PATH", "TERM", "TMPDIR", "USER"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
