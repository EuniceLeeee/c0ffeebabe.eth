import {
  assertExactKeys,
  assertPlainObject,
  decodeCanonicalJson,
  encodeCanonicalBytes,
} from "../../../../packages/canonical-codec/src/index.ts";
import type { PredicateMaterialSourcePortV1 } from "../../../../acceptance/gate-core/src/material-provider.ts";
import {
  readProductionPredicateMaterialSourceStateV1,
  type ProductionPredicateMaterialSourceOwnerInputV1,
} from "../../../../acceptance/collectors/src/internal/predicate-material-source-owner.ts";
import type { ObserverArtifactWriteV1 } from "../../../../acceptance/collectors/src/content-addressed-sink.ts";

export type FreshQualifiedRunnerHostCapabilityV1 = object;
export type FreshQualifiedRunnerSourceSessionCapabilityV1 = object;
export type FreshQualifiedRunnerReaderNameV1 = Exclude<keyof ProductionPredicateMaterialSourceOwnerInputV1, "sink">;

export interface FreshQualifiedRunnerSourceSessionV1 {
  readonly capability: FreshQualifiedRunnerSourceSessionCapabilityV1;
  readonly resolverPolicy: unknown;
  readonly readers: Readonly<Record<FreshQualifiedRunnerReaderNameV1, boolean>>;
}

export type FreshQualifiedRunnerHostRequestV1 = Readonly<{ readonly kind: "open-host" }>;

export type FreshQualifiedRunnerHostPortRequestV1 =
  | Readonly<{ readonly kind: "assert-port"; readonly self: FreshQualifiedRunnerHostPortV1 }>
  | Readonly<{
      readonly kind: "open-source";
      readonly self: FreshQualifiedRunnerHostPortV1;
      readonly source: PredicateMaterialSourcePortV1;
    }>
  | Readonly<{
      readonly kind: "read-source";
      readonly self: FreshQualifiedRunnerHostPortV1;
      readonly session: FreshQualifiedRunnerSourceSessionCapabilityV1;
      readonly reader: FreshQualifiedRunnerReaderNameV1;
    }>
  | Readonly<{
      readonly kind: "write-artifact";
      readonly self: FreshQualifiedRunnerHostPortV1;
      readonly session: FreshQualifiedRunnerSourceSessionCapabilityV1;
      readonly input: ObserverArtifactWriteV1;
    }>;

export type FreshQualifiedRunnerHostPortV1 = (
  request: FreshQualifiedRunnerHostPortRequestV1,
) => FreshQualifiedRunnerSourceSessionV1 | unknown;

interface SourceSessionStateV1 {
  readonly host: FreshQualifiedRunnerHostCapabilityV1;
  readonly source: Readonly<ProductionPredicateMaterialSourceOwnerInputV1>;
}

const hosts = new WeakSet<object>();
const sourceSessions = new WeakMap<object, SourceSessionStateV1>();
const readerNames = Object.freeze([
  "readArtifactLineageStageOne",
  "readArtifactLineageStageTwoAuthority",
  "readArtifactLineageStageTwoGit",
  "readFullFamilyObservation",
  "observePerformance",
  "readDurableTerminalDiscovery",
  "observeTerminalSelection",
  "readRuntimeRestartBoundary",
  "readSourceRepositoryClosureBoundary",
  "readLegacyAuthorityClosureBoundary",
] as const satisfies readonly FreshQualifiedRunnerReaderNameV1[]);

function canonicalClone<T>(value: T): T {
  return decodeCanonicalJson(encodeCanonicalBytes(value)) as T;
}

function requireHost(value: FreshQualifiedRunnerHostCapabilityV1): void {
  if (value === null || typeof value !== "object" || !hosts.has(value)) {
    throw new TypeError("fresh qualified runner host was not packager-owner-issued");
  }
}

function requireSession(
  host: FreshQualifiedRunnerHostCapabilityV1,
  value: FreshQualifiedRunnerSourceSessionCapabilityV1,
): SourceSessionStateV1 {
  if (value === null || typeof value !== "object") {
    throw new TypeError("fresh qualified runner source session is invalid");
  }
  const state = sourceSessions.get(value);
  if (state === undefined || state.host !== host) {
    throw new TypeError("fresh qualified runner source session was not host-issued");
  }
  return state;
}

function invokePort(
  host: FreshQualifiedRunnerHostCapabilityV1,
  port: FreshQualifiedRunnerHostPortV1,
  request: FreshQualifiedRunnerHostPortRequestV1,
): FreshQualifiedRunnerSourceSessionV1 | unknown {
  assertPlainObject(request, "freshQualifiedRunnerHostPortRequest");
  if (request.self !== port) {
    throw new TypeError("fresh qualified runner host port identity mismatch");
  }
  if (request.kind === "assert-port") {
    assertExactKeys(request, ["kind", "self"], "freshQualifiedRunnerHostPortRequest");
    return port;
  }
  if (request.kind === "open-source") {
    assertExactKeys(request, ["kind", "self", "source"], "freshQualifiedRunnerHostPortRequest");
    const source = readProductionPredicateMaterialSourceStateV1(request.source);
    const capability = Object.freeze(Object.create(null)) as object;
    sourceSessions.set(capability, Object.freeze({ host, source }));
    return Object.freeze({
      capability,
      resolverPolicy: canonicalClone(source.sink.resolverPolicy),
      readers: Object.freeze(Object.fromEntries(readerNames.map(name => [name, source[name] !== null]))) as
        Readonly<Record<FreshQualifiedRunnerReaderNameV1, boolean>>,
    });
  }
  if (request.kind === "read-source") {
    assertExactKeys(request, ["kind", "reader", "self", "session"], "freshQualifiedRunnerHostPortRequest");
    if (!readerNames.includes(request.reader)) {
      throw new TypeError("fresh qualified runner source reader is unknown");
    }
    const reader = requireSession(host, request.session).source[request.reader];
    if (reader === null) throw new TypeError("fresh qualified runner source reader is unavailable");
    return reader();
  }
  if (request.kind === "write-artifact") {
    assertExactKeys(request, ["input", "kind", "self", "session"], "freshQualifiedRunnerHostPortRequest");
    return requireSession(host, request.session).source.sink.write(request.input);
  }
  throw new TypeError("fresh qualified runner host port request kind is unknown");
}

export function issueFreshQualifiedRunnerHostV1(): FreshQualifiedRunnerHostCapabilityV1 {
  const capability = Object.freeze(Object.create(null)) as object;
  hosts.add(capability);
  return capability;
}

/** Opens one self-identifying port; forwarding wrappers fail the self check. */
export function invokeFreshQualifiedRunnerHostV1(
  host: FreshQualifiedRunnerHostCapabilityV1,
  request: FreshQualifiedRunnerHostRequestV1,
): FreshQualifiedRunnerHostPortV1 {
  requireHost(host);
  assertPlainObject(request, "freshQualifiedRunnerHostRequest");
  assertExactKeys(request, ["kind"], "freshQualifiedRunnerHostRequest");
  if (request.kind !== "open-host") throw new TypeError("fresh qualified runner host request kind is unknown");
  let port: FreshQualifiedRunnerHostPortV1;
  port = (value: FreshQualifiedRunnerHostPortRequestV1) => invokePort(host, port, value);
  return Object.freeze(port);
}
