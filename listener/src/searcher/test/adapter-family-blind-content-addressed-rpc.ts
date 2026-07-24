import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, isAbsolute, resolve } from "node:path";
import { canonicalJson } from "./adapter-family-blind-contract.js";

export const BLIND_HISTORICAL_RPC_PROFILE =
  "adapter-family-blind-historical-rpc-cache-v1" as const;
export const BLIND_HISTORICAL_PREWARM_PROFILE =
  "adapter-family-blind-historical-prewarm-v1" as const;

export type BlindHistoricalForkLane = "base" | "source" | "shared";
export type BlindHistoricalDescriptorDomain =
  | "graphState"
  | "funding"
  | "executionDependencies"
  | "finalSimulation";

export interface BlindHistoricalAnchor {
  readonly number: number;
  readonly hash: string;
  readonly stateRoot: string;
}

export interface BlindHistoricalRpcCall {
  readonly lane: BlindHistoricalForkLane;
  readonly method: string;
  readonly params: readonly unknown[];
}

export interface BlindHistoricalDescriptorDomainProof {
  readonly expectedCount: number;
  readonly coveredCount: number;
  readonly expectedSetSha256: string;
  readonly coveredSetSha256: string;
}

export interface BlindHistoricalDescriptorCoverageProof {
  readonly graphState: BlindHistoricalDescriptorDomainProof;
  readonly funding: BlindHistoricalDescriptorDomainProof;
  readonly executionDependencies: BlindHistoricalDescriptorDomainProof;
  readonly finalSimulation: BlindHistoricalDescriptorDomainProof;
}

export interface BlindHistoricalDescriptorBinding {
  readonly id: string;
  readonly domain: BlindHistoricalDescriptorDomain;
  /**
   * Exact content-addressed RPC keys needed by this production-derived
   * descriptor. A descriptor without a key is unsupported, not "covered".
   */
  readonly rpcKeys: readonly string[];
}

export interface BlindHistoricalPrewarmPlan {
  readonly schemaVersion: 1;
  readonly profile: typeof BLIND_HISTORICAL_PREWARM_PROFILE;
  readonly scope: "full-production-graph";
  readonly base: BlindHistoricalAnchor;
  readonly source: BlindHistoricalAnchor;
  readonly inputs: {
    readonly resolvedConfigSha256: string;
    readonly universeSha256: string;
    readonly activeFamilyManifestSha256: string;
    readonly baseGraphViewSha256: string;
  };
  readonly exporter: {
    /** Frozen production-derived exporter entry. */
    readonly implementationSha256: string;
    /** Frozen transitive local-module closure rooted at that entry. */
    readonly sourceClosureSha256: string;
    /** Full GraphView/registry-derived semantic requirement set. */
    readonly requirementSetSha256: string;
  };
  /**
   * Hash of the registry/GraphView-derived read descriptor export. This is
   * deliberately not a target route, pool list or transaction fixture.
   */
  readonly descriptorSetSha256: string;
  readonly descriptorCoverage: BlindHistoricalDescriptorCoverageProof;
  readonly descriptors: readonly BlindHistoricalDescriptorBinding[];
  readonly calls: readonly BlindHistoricalRpcCall[];
  readonly planSha256: string;
}

export interface BlindHistoricalRpcManifest {
  readonly schemaVersion: 1;
  readonly profile: typeof BLIND_HISTORICAL_RPC_PROFILE;
  readonly scope: "full-production-graph";
  readonly base: BlindHistoricalAnchor;
  readonly source: BlindHistoricalAnchor;
  readonly planSha256: string;
  readonly planFileSha256: string;
  readonly descriptorSetSha256: string;
  readonly exporterImplementationSha256: string;
  readonly exporterSourceClosureSha256: string;
  readonly exporterRequirementSetSha256: string;
  readonly archiveProviderIdentitySha256: string;
  readonly entries: readonly {
    readonly key: string;
    readonly objectSha256: string;
  }[];
  readonly contentSha256: string;
}

interface CachedJsonRpcResponse {
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export interface LoadedBlindHistoricalRpcCache {
  readonly manifest: BlindHistoricalRpcManifest;
  readonly manifestSha256: string;
  readonly plan: BlindHistoricalPrewarmPlan;
  readonly responses: ReadonlyMap<string, CachedJsonRpcResponse>;
}

export function buildBlindHistoricalPrewarmPlan(input: {
  readonly base: BlindHistoricalAnchor;
  readonly source: BlindHistoricalAnchor;
  readonly inputs: BlindHistoricalPrewarmPlan["inputs"];
  readonly exporter: BlindHistoricalPrewarmPlan["exporter"];
  readonly descriptors: readonly BlindHistoricalDescriptorBinding[];
  readonly calls: readonly BlindHistoricalRpcCall[];
}): BlindHistoricalPrewarmPlan {
  validateAnchor(input.base, "prewarm base");
  validateAnchor(input.source, "prewarm source");
  assert(
    input.base.number + 1 === input.source.number,
    "prewarm anchors must be adjacent",
  );
  for (const [name, hash] of Object.entries(input.inputs)) {
    assertHash(hash, `prewarm ${name}`);
  }
  assertHash(
    input.exporter.implementationSha256,
    "prewarm exporter implementation",
  );
  assertHash(
    input.exporter.sourceClosureSha256,
    "prewarm exporter source closure",
  );
  assertHash(
    input.exporter.requirementSetSha256,
    "prewarm exporter requirement set",
  );
  const calls = [...input.calls]
    .map((call) => normalizeCall(call))
    .sort((a, b) => rpcCacheKey(a).localeCompare(rpcCacheKey(b)));
  assert(calls.length > 0, "prewarm plan must contain production reads");
  const keys = calls.map(rpcCacheKey);
  assert(
    new Set(keys).size === keys.length,
    "prewarm plan contains duplicate RPC descriptors",
  );
  const descriptors = normalizeDescriptorBindings(input.descriptors, keys);
  const descriptorSetSha256 = sha256Canonical(descriptors);
  const descriptorCoverage = descriptorCoverageFromBindings(descriptors);
  const body = {
    schemaVersion: 1 as const,
    profile: BLIND_HISTORICAL_PREWARM_PROFILE,
    scope: "full-production-graph" as const,
    base: input.base,
    source: input.source,
    inputs: input.inputs,
    exporter: Object.freeze({ ...input.exporter }),
    descriptorSetSha256,
    descriptorCoverage,
    descriptors,
    calls,
  };
  assertTargetIndependent(body);
  return Object.freeze({
    ...body,
    planSha256: sha256Canonical(body),
  });
}

export function buildBlindHistoricalDescriptorCoverageProof(
  input: Readonly<Record<
    keyof BlindHistoricalDescriptorCoverageProof,
    {
      readonly expectedIds: readonly string[];
      readonly coveredIds: readonly string[];
    }
  >>,
): BlindHistoricalDescriptorCoverageProof {
  return Object.freeze({
    graphState: descriptorDomainProof(input.graphState),
    funding: descriptorDomainProof(input.funding),
    executionDependencies:
      descriptorDomainProof(input.executionDependencies),
    finalSimulation: descriptorDomainProof(input.finalSimulation),
  });
}

export async function materializeBlindHistoricalRpcCache(input: {
  readonly plan: BlindHistoricalPrewarmPlan;
  readonly archiveRpcUrl: string;
  readonly outDir: string;
  readonly timeoutMs?: number;
}): Promise<BlindHistoricalRpcManifest> {
  validateBlindHistoricalPrewarmPlan(input.plan);
  assert(isAbsolute(input.outDir), "historical cache output must be absolute");
  const archive = new URL(input.archiveRpcUrl);
  assert(
    archive.protocol === "http:" || archive.protocol === "https:",
    "archive RPC protocol",
  );
  const timeoutMs = input.timeoutMs ?? 30_000;
  assert(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
    "archive timeout",
  );
  assert(
    !existsSync(input.outDir) || readdirSync(input.outDir).length === 0,
    "historical cache output directory must be new or empty",
  );
  mkdirSync(input.outDir, { recursive: true, mode: 0o700 });
  chmodSync(input.outDir, 0o700);
  const objectsDir = resolve(input.outDir, "objects");
  mkdirSync(objectsDir, { recursive: true, mode: 0o700 });
  chmodSync(objectsDir, 0o700);
  const planContents = `${canonicalJson(input.plan)}\n`;
  const planFileSha256 = sha256(planContents);
  writeOwnerOnly(resolve(input.outDir, "prewarm-plan.json"), planContents);

  const entries: Array<{ key: string; objectSha256: string }> = [];
  for (let index = 0; index < input.plan.calls.length; index += 1) {
    const call = input.plan.calls[index]!;
    const response = await fetch(input.archiveRpcUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-blind-fork-lane": call.lane,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: index + 1,
        method: call.method,
        params: call.params,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`archive RPC HTTP ${response.status} for ${call.method}`);
    }
    const payload = await response.json() as {
      readonly result?: unknown;
      readonly error?: {
        readonly code?: unknown;
        readonly message?: unknown;
        readonly data?: unknown;
      };
    };
    const cached: CachedJsonRpcResponse = payload.error
      ? {
          error: {
            code: Number(payload.error.code ?? -32000),
            message: String(payload.error.message ?? "archive RPC error"),
            ...(payload.error.data === undefined
              ? {}
              : { data: payload.error.data }),
          },
        }
      : { result: payload.result ?? null };
    const objectContents = `${canonicalJson(cached)}\n`;
    const objectSha256 = sha256(objectContents);
    writeOwnerOnly(
      resolve(objectsDir, `${objectSha256}.json`),
      objectContents,
    );
    entries.push({ key: rpcCacheKey(call), objectSha256 });
  }
  entries.sort((a, b) => a.key.localeCompare(b.key));
  const body = {
    schemaVersion: 1 as const,
    profile: BLIND_HISTORICAL_RPC_PROFILE,
    scope: "full-production-graph" as const,
    base: input.plan.base,
    source: input.plan.source,
    planSha256: input.plan.planSha256,
    planFileSha256,
    descriptorSetSha256: input.plan.descriptorSetSha256,
    exporterImplementationSha256:
      input.plan.exporter.implementationSha256,
    exporterSourceClosureSha256:
      input.plan.exporter.sourceClosureSha256,
    exporterRequirementSetSha256:
      input.plan.exporter.requirementSetSha256,
    archiveProviderIdentitySha256: sha256(archiveProviderIdentity(archive)),
    entries,
  };
  const manifest: BlindHistoricalRpcManifest = Object.freeze({
    ...body,
    contentSha256: sha256Canonical(body),
  });
  writeOwnerOnly(
    resolve(input.outDir, "manifest.json"),
    `${canonicalJson(manifest)}\n`,
  );
  // Reload from disk before returning: a successful materialization means the
  // exact frozen representation, not only its in-memory precursor, validates.
  loadBlindHistoricalRpcCache(resolve(input.outDir, "manifest.json"));
  return manifest;
}

export function loadBlindHistoricalRpcCache(
  manifestPath: string,
): LoadedBlindHistoricalRpcCache {
  assertOwnerOnlyFile(manifestPath, "historical cache manifest");
  const rootDir = dirname(manifestPath);
  assertOwnerOnlyDirectory(rootDir, "historical cache root");
  assert(
    readdirSync(rootDir).sort().join("\n") ===
      ["manifest.json", "objects", "prewarm-plan.json"].join("\n"),
    "historical cache root contains unexpected or missing entries",
  );
  const raw = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as BlindHistoricalRpcManifest;
  validateBlindHistoricalRpcManifest(manifest);
  assert(
    raw === `${canonicalJson(manifest)}\n`,
    "historical cache manifest is not canonical",
  );
  const planPath = resolve(rootDir, "prewarm-plan.json");
  assertOwnerOnlyFile(planPath, "historical cache prewarm plan");
  const planRaw = readFileSync(planPath, "utf8");
  assert(
    sha256(planRaw) === manifest.planFileSha256,
    "historical cache prewarm plan file hash mismatch",
  );
  const plan = JSON.parse(planRaw) as BlindHistoricalPrewarmPlan;
  validateBlindHistoricalPrewarmPlan(plan);
  assert(
    planRaw === `${canonicalJson(plan)}\n`,
    "historical cache prewarm plan is not canonical",
  );
  assert(
    plan.planSha256 === manifest.planSha256 &&
      plan.descriptorSetSha256 === manifest.descriptorSetSha256 &&
      plan.exporter.implementationSha256 ===
        manifest.exporterImplementationSha256 &&
      plan.exporter.sourceClosureSha256 ===
        manifest.exporterSourceClosureSha256 &&
      plan.exporter.requirementSetSha256 ===
        manifest.exporterRequirementSetSha256 &&
      canonicalJson(plan.base) === canonicalJson(manifest.base) &&
      canonicalJson(plan.source) === canonicalJson(manifest.source),
    "historical cache prewarm plan does not bind manifest",
  );
  const responses = new Map<string, CachedJsonRpcResponse>();
  const objectsDir = resolve(rootDir, "objects");
  assertOwnerOnlyDirectory(objectsDir, "historical cache objects");
  const expectedObjectFiles = [...new Set(
    manifest.entries.map((entry) => `${entry.objectSha256}.json`),
  )].sort();
  assert(
    readdirSync(objectsDir).sort().join("\n") ===
      expectedObjectFiles.join("\n"),
    "historical cache objects contain unexpected or missing entries",
  );
  for (const entry of manifest.entries) {
    const objectPath = resolve(objectsDir, `${entry.objectSha256}.json`);
    assertOwnerOnlyFile(objectPath, "historical cache object");
    const contents = readFileSync(objectPath, "utf8");
    assert(
      sha256(contents) === entry.objectSha256,
      `historical cache object hash mismatch ${entry.objectSha256}`,
    );
    const response = JSON.parse(contents) as CachedJsonRpcResponse;
    assert(
      contents === `${canonicalJson(response)}\n`,
      `historical cache object is not canonical ${entry.objectSha256}`,
    );
    responses.set(entry.key, Object.freeze(response));
  }
  assert(
    plan.calls.length === manifest.entries.length &&
      plan.calls.every((call) => responses.has(rpcCacheKey(call))),
    "historical cache entries do not exactly cover the frozen prewarm plan",
  );
  return Object.freeze({
    manifest,
    manifestSha256: sha256(raw),
    plan,
    responses,
  });
}

export function loadBlindHistoricalPrewarmPlan(
  planPath: string,
): BlindHistoricalPrewarmPlan {
  assertOwnerOnlyFile(planPath, "historical prewarm plan");
  const raw = readFileSync(planPath, "utf8");
  const plan = JSON.parse(raw) as BlindHistoricalPrewarmPlan;
  validateBlindHistoricalPrewarmPlan(plan);
  assert(
    raw === `${canonicalJson(plan)}\n`,
    "historical prewarm plan is not canonical",
  );
  return plan;
}

export class FrozenBlindHistoricalRpcServer {
  private readonly server: Server;
  private origin = "";
  private requests = 0;
  private misses = 0;
  private readonly missedCalls: BlindHistoricalRpcCall[] = [];

  constructor(
    private readonly cache: LoadedBlindHistoricalRpcCache,
    private readonly host = "127.0.0.1",
    private readonly port = 0,
  ) {
    assert(
      host === "127.0.0.1" || host === "::1" || host === "localhost",
      "historical cache server must be loopback",
    );
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        replyJson(response, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolveListen, rejectListen) => {
      this.server.once("error", rejectListen);
      this.server.listen(this.port, this.host, () => resolveListen());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("historical cache server did not bind TCP");
    }
    this.origin = `http://${this.host.includes(":") ? `[${this.host}]` : this.host}:${address.port}`;
    return this.origin;
  }

  stats(): {
    readonly requests: number;
    readonly misses: number;
    readonly missedCalls: readonly BlindHistoricalRpcCall[];
  } {
    return {
      requests: this.requests,
      misses: this.misses,
      missedCalls: Object.freeze([...this.missedCalls]),
    };
  }

  async close(): Promise<void> {
    await new Promise<void>((resolveClose) => {
      if (!this.server.listening) resolveClose();
      else this.server.close(() => resolveClose());
    });
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method === "GET" && request.url === "/manifest") {
      replyJson(response, 200, {
        manifest: this.cache.manifest,
        manifestSha256: this.cache.manifestSha256,
      });
      return;
    }
    if (request.method === "GET" && request.url === "/stats") {
      replyJson(response, 200, {
        manifestSha256: this.cache.manifestSha256,
        requests: this.requests,
        misses: this.misses,
        missedCalls: this.missedCalls,
      });
      return;
    }
    if (request.method !== "POST" || request.url !== "/") {
      replyJson(response, 404, { error: "unknown frozen RPC path" });
      return;
    }
    const lane = parseLane(request.headers["x-blind-fork-lane"]);
    const raw = await readBody(request);
    const payload = JSON.parse(raw) as JsonRpcRequest | JsonRpcRequest[];
    const calls = Array.isArray(payload) ? payload : [payload];
    const replies = calls.map((call) => this.replyFor(lane, call));
    replyJson(response, 200, Array.isArray(payload) ? replies : replies[0]!);
  }

  private replyFor(
    lane: BlindHistoricalForkLane,
    request: JsonRpcRequest,
  ): object {
    this.requests++;
    const primary = rpcCacheKey({
      lane,
      method: request.method,
      params: request.params ?? [],
    });
    const shared = rpcCacheKey({
      lane: "shared",
      method: request.method,
      params: request.params ?? [],
    });
    const cached =
      this.cache.responses.get(primary) ??
      this.cache.responses.get(shared);
    if (!cached) {
      this.misses++;
      if (this.missedCalls.length < 100) {
        this.missedCalls.push(Object.freeze({
          lane,
          method: request.method,
          params: Object.freeze([...(request.params ?? [])]),
        }));
      }
      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: {
          code: -32099,
          message:
            `frozen historical cache miss ${lane}:${request.method}`,
        },
      };
    }
    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      ...cached,
    };
  }
}

export function validateBlindHistoricalPrewarmPlan(
  plan: BlindHistoricalPrewarmPlan,
): void {
  const rebuilt = buildBlindHistoricalPrewarmPlan({
    base: plan.base,
    source: plan.source,
    inputs: plan.inputs,
    exporter: plan.exporter,
    descriptors: plan.descriptors,
    calls: plan.calls,
  });
  assert(
    canonicalJson(rebuilt) === canonicalJson(plan),
    "historical prewarm plan hash/schema mismatch",
  );
}

export function validateBlindHistoricalRpcManifest(
  manifest: BlindHistoricalRpcManifest,
): void {
  assert(manifest.schemaVersion === 1, "historical cache manifest schema");
  assert(
    manifest.profile === BLIND_HISTORICAL_RPC_PROFILE,
    "historical cache manifest profile",
  );
  assert(
    manifest.scope === "full-production-graph",
    "historical cache manifest scope",
  );
  validateAnchor(manifest.base, "historical cache base");
  validateAnchor(manifest.source, "historical cache source");
  assert(
    manifest.base.number + 1 === manifest.source.number,
    "historical cache anchors must be adjacent",
  );
  assertHash(manifest.planSha256, "historical cache plan");
  assertHash(manifest.planFileSha256, "historical cache plan file");
  assertHash(manifest.descriptorSetSha256, "historical cache descriptors");
  assertHash(
    manifest.exporterImplementationSha256,
    "historical cache exporter implementation",
  );
  assertHash(
    manifest.exporterSourceClosureSha256,
    "historical cache exporter source closure",
  );
  assertHash(
    manifest.exporterRequirementSetSha256,
    "historical cache exporter requirement set",
  );
  assertHash(
    manifest.archiveProviderIdentitySha256,
    "historical cache archive provider identity",
  );
  const seen = new Set<string>();
  let previousKey = "";
  for (const entry of manifest.entries) {
    assert(entry.key.length > 0, "historical cache entry key");
    assertHash(entry.objectSha256, "historical cache object");
    assert(!seen.has(entry.key), "historical cache duplicate entry");
    assert(
      previousKey.length === 0 || previousKey < entry.key,
      "historical cache entries are not canonical sorted",
    );
    seen.add(entry.key);
    previousKey = entry.key;
  }
  const { contentSha256: _hash, ...body } = manifest;
  assert(
    manifest.contentSha256 === sha256Canonical(body),
    "historical cache manifest content hash mismatch",
  );
}

function normalizeCall(
  call: BlindHistoricalRpcCall,
): BlindHistoricalRpcCall {
  assert(
    call.lane === "base" ||
      call.lane === "source" ||
      call.lane === "shared",
    "historical prewarm lane",
  );
  assert(
    typeof call.method === "string" &&
      /^([a-z]+)_([A-Za-z0-9]+)$/.test(call.method),
    "historical prewarm method",
  );
  assert(
    !/^(?:anvil|hardhat|evm)_/i.test(call.method),
    "historical prewarm mutation method",
  );
  assert(Array.isArray(call.params), "historical prewarm params");
  const serializedParams = canonicalJson(call.params).toLowerCase();
  for (const mutableTag of [
    "\"latest\"",
    "\"pending\"",
    "\"safe\"",
    "\"finalized\"",
  ]) {
    assert(
      !serializedParams.includes(mutableTag),
      `historical prewarm call ${call.method} uses mutable block tag ${mutableTag}`,
    );
  }
  return Object.freeze({
    lane: call.lane,
    method: call.method,
    params: JSON.parse(canonicalJson(call.params)) as readonly unknown[],
  });
}

function validateDescriptorCoverage(
  coverage: BlindHistoricalPrewarmPlan["descriptorCoverage"],
): void {
  assert(
    coverage && Object.keys(coverage).length === 4,
    "historical prewarm descriptor coverage contains unexpected fields",
  );
  for (const [name, proof] of Object.entries(coverage)) {
    assert(
      proof && Object.keys(proof).length === 4,
      `historical prewarm ${name} coverage contains unexpected fields`,
    );
    assert(
      Number.isSafeInteger(proof.expectedCount) &&
        proof.expectedCount > 0 &&
        Number.isSafeInteger(proof.coveredCount) &&
        proof.coveredCount === proof.expectedCount,
      `historical prewarm ${name} coverage count mismatch`,
    );
    assertHash(
      proof.expectedSetSha256,
      `historical prewarm ${name} expected set`,
    );
    assertHash(
      proof.coveredSetSha256,
      `historical prewarm ${name} covered set`,
    );
    assert(
      proof.expectedSetSha256 === proof.coveredSetSha256,
      `historical prewarm ${name} descriptor set mismatch`,
    );
  }
}

function normalizeDescriptorBindings(
  input: readonly BlindHistoricalDescriptorBinding[],
  callKeys: readonly string[],
): readonly BlindHistoricalDescriptorBinding[] {
  assert(Array.isArray(input) && input.length > 0, "descriptor export is empty");
  const available = new Set(callKeys);
  const referenced = new Set<string>();
  const seenIds = new Set<string>();
  const domains = new Set<BlindHistoricalDescriptorDomain>();
  const descriptors = input.map((descriptor) => {
    assert(
      descriptor && typeof descriptor === "object",
      "descriptor binding must be an object",
    );
    assert(
      typeof descriptor.id === "string" &&
        descriptor.id.length > 0 &&
        descriptor.id === descriptor.id.trim() &&
        !seenIds.has(descriptor.id),
      "descriptor binding has duplicate/empty id",
    );
    assert(
      isDescriptorDomain(descriptor.domain),
      `descriptor ${descriptor.id} has invalid domain`,
    );
    assert(
      Array.isArray(descriptor.rpcKeys) && descriptor.rpcKeys.length > 0,
      `descriptor ${descriptor.id} has no exact RPC keys`,
    );
    const rpcKeys = [...descriptor.rpcKeys].sort();
    assert(
      new Set(rpcKeys).size === rpcKeys.length,
      `descriptor ${descriptor.id} has duplicate RPC keys`,
    );
    for (const key of rpcKeys) {
      assertHash(key, `descriptor ${descriptor.id} RPC key`);
      assert(
        available.has(key),
        `descriptor ${descriptor.id} references unrelated RPC key ${key}`,
      );
      referenced.add(key);
    }
    seenIds.add(descriptor.id);
    domains.add(descriptor.domain);
    return Object.freeze({
      id: descriptor.id,
      domain: descriptor.domain,
      rpcKeys: Object.freeze(rpcKeys),
    });
  }).sort((a, b) =>
    a.domain.localeCompare(b.domain) || a.id.localeCompare(b.id)
  );
  for (const domain of DESCRIPTOR_DOMAINS) {
    assert(domains.has(domain), `descriptor export omits domain ${domain}`);
  }
  assert(
    referenced.size === available.size &&
      callKeys.every((key) => referenced.has(key)),
    "prewarm RPC plan contains a call unrelated to every production descriptor",
  );
  return Object.freeze(descriptors);
}

function descriptorCoverageFromBindings(
  descriptors: readonly BlindHistoricalDescriptorBinding[],
): BlindHistoricalDescriptorCoverageProof {
  const byDomain = new Map<
    BlindHistoricalDescriptorDomain,
    BlindHistoricalDescriptorBinding[]
  >();
  for (const descriptor of descriptors) {
    const current = byDomain.get(descriptor.domain) ?? [];
    current.push(descriptor);
    byDomain.set(descriptor.domain, current);
  }
  const proofFor = (domain: BlindHistoricalDescriptorDomain) => {
    const ids = (byDomain.get(domain) ?? []).map((descriptor) =>
      descriptor.id
    );
    return { expectedIds: ids, coveredIds: ids };
  };
  return buildBlindHistoricalDescriptorCoverageProof(
    {
      graphState: proofFor("graphState"),
      funding: proofFor("funding"),
      executionDependencies: proofFor("executionDependencies"),
      finalSimulation: proofFor("finalSimulation"),
    },
  );
}

const DESCRIPTOR_DOMAINS = Object.freeze([
  "graphState",
  "funding",
  "executionDependencies",
  "finalSimulation",
] as const);

function isDescriptorDomain(
  value: unknown,
): value is BlindHistoricalDescriptorDomain {
  return (DESCRIPTOR_DOMAINS as readonly unknown[]).includes(value);
}

function descriptorDomainProof(input: {
  readonly expectedIds: readonly string[];
  readonly coveredIds: readonly string[];
}): BlindHistoricalDescriptorDomainProof {
  const expected = canonicalDescriptorIds(
    input.expectedIds,
    "expected descriptor",
  );
  const covered = canonicalDescriptorIds(
    input.coveredIds,
    "covered descriptor",
  );
  return Object.freeze({
    expectedCount: expected.length,
    coveredCount: covered.length,
    expectedSetSha256: sha256Canonical(expected),
    coveredSetSha256: sha256Canonical(covered),
  });
}

function canonicalDescriptorIds(
  values: readonly string[],
  label: string,
): readonly string[] {
  assert(Array.isArray(values) && values.length > 0, `${label} set is empty`);
  for (const value of values) {
    assert(
      typeof value === "string" && value.length > 0,
      `${label} id is empty`,
    );
  }
  const sorted = [...values].sort();
  assert(
    new Set(sorted).size === sorted.length,
    `${label} set contains duplicates`,
  );
  return Object.freeze(sorted);
}

export function blindHistoricalRpcCacheKey(
  call: BlindHistoricalRpcCall,
): string {
  return sha256Canonical({
    lane: call.lane,
    method: call.method,
    params: call.params,
  });
}

const rpcCacheKey = blindHistoricalRpcCacheKey;

function assertTargetIndependent(value: unknown): void {
  const serialized = canonicalJson(value).toLowerCase();
  for (const marker of [
    "targettx",
    "target_tx",
    "targetroute",
    "target_route",
    "targetpool",
    "target_pool",
    "expectedroute",
    "expected_route",
    "winnerhash",
    "winner_hash",
    "searchcenter",
    "search_center",
  ]) {
    assert(
      !serialized.includes(marker),
      `historical prewarm plan contains forbidden marker ${marker}`,
    );
  }
}

function parseLane(
  value: string | string[] | undefined,
): BlindHistoricalForkLane {
  const lane = Array.isArray(value) ? value[0] : value;
  if (lane === "base" || lane === "source" || lane === "shared") return lane;
  return "shared";
}

interface JsonRpcRequest {
  readonly id?: unknown;
  readonly method: string;
  readonly params?: readonly unknown[];
}

function validateAnchor(anchor: BlindHistoricalAnchor, label: string): void {
  assert(
    Number.isSafeInteger(anchor.number) && anchor.number >= 0,
    `${label} number`,
  );
  assertHash(anchor.hash, `${label} hash`);
  assertHash(anchor.stateRoot, `${label} state root`);
}

function assertOwnerOnlyFile(path: string, label: string): void {
  assert(isAbsolute(path), `${label} path must be absolute`);
  const stat = statSync(path);
  assert(stat.isFile(), `${label} must be a file`);
  assert((stat.mode & 0o077) === 0, `${label} must be owner-only`);
}

function assertOwnerOnlyDirectory(path: string, label: string): void {
  assert(isAbsolute(path), `${label} path must be absolute`);
  const stat = statSync(path);
  assert(stat.isDirectory(), `${label} must be a directory`);
  assert((stat.mode & 0o077) === 0, `${label} must be owner-only`);
}

function writeOwnerOnly(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () =>
      resolveBody(Buffer.concat(chunks).toString("utf8"))
    );
    request.on("error", rejectBody);
  });
}

function replyJson(
  response: ServerResponse,
  status: number,
  value: object,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(canonicalJson(value));
}

function sha256Canonical(value: unknown): string {
  return sha256(canonicalJson(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function archiveProviderIdentity(url: URL): string {
  return canonicalJson({
    protocol: url.protocol.toLowerCase(),
    hostname: url.hostname.toLowerCase(),
    port: url.port || (url.protocol === "https:" ? "443" : "80"),
  });
}

function assertHash(value: unknown, label: string): void {
  assert(
    typeof value === "string" && /^(?:0x)?[0-9a-f]{64}$/i.test(value),
    `${label} hash`,
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
