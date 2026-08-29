import { constants, type BigIntStats } from "node:fs";
import {
  link,
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { types as nodeTypes } from "node:util";
import {
  assertHash,
  assertNonEmptyString,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  createReadOnlyArtifactRef,
  decodeSchemaRef,
  type ReadOnlyArtifactRefV1,
  type SchemaRef,
} from "../../../specs/core-envelope/src/index.ts";
import {
  ARTIFACT_MIRROR_MAX_DECODED_BYTES,
  createArtifactResolutionClaim,
  createObservedImmutableMirror,
  createRetentionLeaseReceipt,
  decodeResolverPolicy,
  encodeArtifactBytes,
  type ArtifactResolutionClaimV1,
  type ResolverPolicyV1,
  type RetentionLeaseReceiptV1,
} from "../../../specs/artifact-resolution/src/index.ts";

export interface ContentAddressedObserverSinkOptionsV1 {
  readonly directory: string;
  readonly storeIdentityHash: Hash;
  readonly resolverPolicy: ResolverPolicyV1;
  readonly readOnly?: boolean;
  readonly lease: Readonly<{
    readonly validFromStoreEpoch: string;
    readonly validThroughStoreEpoch: string;
    readonly issuerId: string;
    readonly issuerQualificationId: Hash;
    readonly qualificationRegistryRoot: Hash;
  }>;
}

export interface ObserverArtifactWriteV1 {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly schema: SchemaRef;
}

export interface ObservedContentArtifactV1 {
  readonly contentSha256: Hash;
  readonly bytes: Uint8Array;
  readonly ref: ReadOnlyArtifactRefV1;
  readonly claim: ArtifactResolutionClaimV1;
  readonly lease: RetentionLeaseReceiptV1;
}

let observerTemporarySequence = 0;
const STORE_IDENTITY_MARKER = ".aloha-observer-store-identity-v1";
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  "byteLength",
)?.get;

interface PhysicalObjectIdentityV1 {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface PhysicalDirectoryIdentityV1 {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface ConcreteObserverArtifactWriteV1 {
  readonly bytes: unknown;
  readonly mediaType: unknown;
  readonly schema: unknown;
}

function physicalIdentity(stat: BigIntStats): PhysicalObjectIdentityV1 {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  });
}

function samePhysicalIdentity(left: PhysicalObjectIdentityV1, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function physicalDirectoryIdentity(stat: BigIntStats): PhysicalDirectoryIdentityV1 {
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function samePhysicalDirectoryIdentity(left: PhysicalDirectoryIdentityV1, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertCurrentProcessOwner(stat: BigIntStats, label: string): void {
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  if (uid !== null && stat.uid !== uid) {
    throw new TypeError(`${label} is not owned by the observer process user`);
  }
}

function exactObserverArtifactWrite(value: unknown): ConcreteObserverArtifactWriteV1 {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) {
    throw new TypeError("observer artifact write must be an exact data-property object");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 3
    || !keys.every((key) => key === "bytes" || key === "mediaType" || key === "schema")
  ) {
    throw new TypeError("observer artifact write must contain exactly bytes, mediaType and schema");
  }
  const dataValue = (key: "bytes" | "mediaType" | "schema"): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new TypeError(`observer artifact write ${key} must be an enumerable data property`);
    }
    return descriptor.value;
  };
  return Object.freeze({
    bytes: dataValue("bytes"),
    mediaType: dataValue("mediaType"),
    schema: dataValue("schema"),
  });
}

function concreteByteLength(value: unknown): number {
  if (
    value === null
    || typeof value !== "object"
    || nodeTypes.isProxy(value)
    || !ArrayBuffer.isView(value)
    || Object.getPrototypeOf(value) !== Uint8Array.prototype
    || TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined
  ) {
    throw new TypeError("observer artifact bytes must be a concrete Uint8Array");
  }
  return TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value) as number;
}

function copyConcreteBytes(value: unknown, byteLength: number): Uint8Array {
  const source = value as Uint8Array;
  const copy = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) copy[index] = source[index]!;
  return copy;
}

function decimal(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`expected canonical decimal at ${path}`);
  }
  return value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Collector-owned immutable mirror. It stores only concrete bytes supplied by
 * the observer and derives every locator/hash from the bytes. It has no
 * business decoder and does not evaluate acceptance.
 */
export class ContentAddressedObserverSinkV1 {
  readonly #directory: string;
  readonly #storeIdentityHash: Hash;
  readonly #resolverPolicy: ResolverPolicyV1;
  readonly #lease: ContentAddressedObserverSinkOptionsV1["lease"];
  readonly #readOnly: boolean;
  #initializedDirectory: string | null = null;
  #directoryIdentity: PhysicalDirectoryIdentityV1 | null = null;
  #storeIdentityMarkerIdentity: PhysicalObjectIdentityV1 | null = null;
  readonly #objectIdentities = new Map<Hash, PhysicalObjectIdentityV1>();
  readonly #writes = new Map<Hash, Promise<Uint8Array>>();

  constructor(options: ContentAddressedObserverSinkOptionsV1) {
    if (options === null || typeof options !== "object") throw new TypeError("observer sink options are required");
    const directory = assertNonEmptyString(options.directory, "observerSink.directory");
    if (!resolve(directory).startsWith("/")) throw new TypeError("observer sink directory must resolve to an absolute path");
    const resolverPolicy = decodeResolverPolicy(options.resolverPolicy);
    if (resolverPolicy.allowedLocatorKind !== "content-object" || resolverPolicy.digestAlgorithm !== "sha256") {
      throw new TypeError("observer sink requires content-object sha256 policy");
    }
    const validFromStoreEpoch = decimal(options.lease.validFromStoreEpoch, "observerSink.lease.validFromStoreEpoch");
    const validThroughStoreEpoch = decimal(options.lease.validThroughStoreEpoch, "observerSink.lease.validThroughStoreEpoch");
    if (BigInt(validThroughStoreEpoch) < BigInt(validFromStoreEpoch)) throw new TypeError("observer sink lease interval is reversed");
    this.#directory = resolve(directory);
    this.#storeIdentityHash = assertHash(options.storeIdentityHash, "observerSink.storeIdentityHash");
    this.#resolverPolicy = resolverPolicy;
    this.#readOnly = options.readOnly === true;
    this.#lease = Object.freeze({
      validFromStoreEpoch,
      validThroughStoreEpoch,
      issuerId: assertNonEmptyString(options.lease.issuerId, "observerSink.lease.issuerId"),
      issuerQualificationId: assertHash(options.lease.issuerQualificationId, "observerSink.lease.issuerQualificationId"),
      qualificationRegistryRoot: assertHash(options.lease.qualificationRegistryRoot, "observerSink.lease.qualificationRegistryRoot"),
    });
  }

  get resolverPolicy(): ResolverPolicyV1 {
    return this.#resolverPolicy;
  }

  get storeIdentityHash(): Hash {
    return this.#storeIdentityHash;
  }

  get directory(): string {
    return this.#directory;
  }

  async #initialize(): Promise<string> {
    if (this.#initializedDirectory !== null) {
      await this.#assertDirectoryIdentity();
      await this.#assertStoreIdentityMarker(this.#initializedDirectory);
      return this.#initializedDirectory;
    }
    if (!this.#readOnly) await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const physical = await realpath(this.#directory);
    const handle = await open(physical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let metadata: BigIntStats;
    try {
      metadata = await handle.stat({ bigint: true });
    } finally {
      await handle.close();
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new TypeError("observer sink path is not a physical directory");
    assertCurrentProcessOwner(metadata, "observer sink directory");
    if ((metadata.mode & 0o077n) !== 0n) {
      throw new TypeError("observer sink directory permissions are not private");
    }
    this.#initializedDirectory = physical;
    this.#directoryIdentity = physicalDirectoryIdentity(metadata);
    if (this.#readOnly) {
      await this.#assertStoreIdentityMarker(physical);
    } else {
      await this.#installOrAssertStoreIdentityMarker(physical);
    }
    await this.#assertDirectoryIdentity();
    return physical;
  }

  async #installOrAssertStoreIdentityMarker(directory: string): Promise<void> {
    const marker = join(directory, STORE_IDENTITY_MARKER);
    const expected = Uint8Array.from(Buffer.from(`${this.#storeIdentityHash}\n`, "utf8"));
    const temporary = join(
      directory,
      `.${STORE_IDENTITY_MARKER}.${process.pid}.${observerTemporarySequence++}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o400,
      );
      await handle.writeFile(expected);
      await handle.sync();
      await handle.close();
      handle = null;
      try {
        await link(temporary, marker);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      if (handle !== null) await handle.close();
      await unlinkIfPresent(temporary);
    }
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    await this.#assertStoreIdentityMarker(directory);
  }

  async #assertStoreIdentityMarker(directory: string): Promise<void> {
    const marker = join(directory, STORE_IDENTITY_MARKER);
    const expected = Uint8Array.from(Buffer.from(`${this.#storeIdentityHash}\n`, "utf8"));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const handle = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.isSymbolicLink()) {
          throw new TypeError("observer sink store identity marker is not a physical file");
        }
        assertCurrentProcessOwner(before, "observer sink store identity marker");
        if ((before.mode & 0o222n) !== 0n) {
          throw new TypeError("observer sink store identity marker remains writable");
        }
        if (before.nlink !== 1n) {
          if (attempt < 7) {
            await new Promise<void>(resolveDelay => setTimeout(resolveDelay, 1));
            continue;
          }
          throw new TypeError("observer sink store identity marker is not write-once");
        }
        if (this.#storeIdentityMarkerIdentity !== null
          && !samePhysicalIdentity(this.#storeIdentityMarkerIdentity, before)) {
          throw new TypeError("observer sink store identity marker changed");
        }
        const bytes = Uint8Array.from(await handle.readFile());
        const after = await handle.stat({ bigint: true });
        if (!sameStat(before, after) || !sameBytes(bytes, expected)) {
          throw new TypeError("observer sink physical store identity mismatch");
        }
        this.#storeIdentityMarkerIdentity ??= physicalIdentity(after);
        return;
      } finally {
        await handle.close();
      }
    }
  }

  async #assertDirectoryIdentity(): Promise<void> {
    if (this.#initializedDirectory === null || this.#directoryIdentity === null) return;
    const handle = await open(
      this.#initializedDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const observed = await handle.stat({ bigint: true });
      if (!observed.isDirectory() || !samePhysicalDirectoryIdentity(this.#directoryIdentity, observed)) {
        throw new TypeError("observer sink directory identity changed");
      }
    } finally {
      await handle.close();
    }
  }

  async #readPhysicalContent(
    contentSha256: Hash,
    expectedIdentity: PhysicalObjectIdentityV1 | null,
  ): Promise<Readonly<{ readonly bytes: Uint8Array; readonly identity: PhysicalObjectIdentityV1 }>> {
    const directory = await this.#initialize();
    const objectName = contentSha256.slice(2);
    const path = join(directory, objectName);
    if (dirname(path) !== directory || basename(path) !== objectName) {
      throw new TypeError("observer content object escaped its store directory");
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
        throw new TypeError("observer content object is not a write-once physical file");
      }
      assertCurrentProcessOwner(before, "observer content object");
      if ((before.mode & 0o222n) !== 0n) {
        throw new TypeError("observer content object remains writable");
      }
      if (expectedIdentity !== null && !samePhysicalIdentity(expectedIdentity, before)) {
        throw new TypeError("observer content object identity changed");
      }
      const bytes = Uint8Array.from(await handle.readFile());
      const after = await handle.stat({ bigint: true });
      if (!sameStat(before, after) || before.size !== BigInt(bytes.byteLength)) {
        throw new TypeError("observer content object changed during read");
      }
      if (sha256Hex(bytes) !== contentSha256) {
        throw new TypeError("observer content object hash mismatch");
      }
      await this.#assertDirectoryIdentity();
      return Object.freeze({ bytes, identity: physicalIdentity(after) });
    } finally {
      await handle.close();
    }
  }

  async #persist(contentSha256: Hash, bytes: Uint8Array): Promise<Uint8Array> {
    const directory = await this.#initialize();
    const objectName = contentSha256.slice(2);
    const destination = join(directory, objectName);
    if (dirname(destination) !== directory || basename(destination) !== objectName) {
      throw new TypeError("observer content object escaped its store directory");
    }
    const temporary = join(directory, `.${objectName}.${process.pid}.${observerTemporarySequence++}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o400,
      );
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      try {
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await unlinkIfPresent(temporary);
      const directoryHandle = await open(directory, constants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      const expectedIdentity = this.#objectIdentities.get(contentSha256) ?? null;
      const observed = await this.#readPhysicalContent(contentSha256, expectedIdentity);
      if (!sameBytes(observed.bytes, bytes)) {
        throw new TypeError("observer content object does not match observed bytes");
      }
      this.#objectIdentities.set(contentSha256, observed.identity);
      return observed.bytes;
    } finally {
      if (handle !== null) await handle.close();
      await unlinkIfPresent(temporary);
    }
  }

  async #persistSingleFlight(contentSha256: Hash, bytes: Uint8Array): Promise<Uint8Array> {
    let write = this.#writes.get(contentSha256);
    if (write === undefined) {
      write = this.#persist(contentSha256, bytes);
      this.#writes.set(contentSha256, write);
    }
    try {
      const observed = await write;
      if (!sameBytes(observed, bytes)) {
        throw new TypeError("observer content hash resolved to different bytes");
      }
      return Uint8Array.from(observed);
    } finally {
      if (this.#writes.get(contentSha256) === write) {
        this.#writes.delete(contentSha256);
      }
    }
  }

  async write(input: ObserverArtifactWriteV1): Promise<ObservedContentArtifactV1> {
    if (this.#readOnly) throw new TypeError("observer snapshot sink is read-only");
    const exactInput = exactObserverArtifactWrite(input);
    const byteLength = concreteByteLength(exactInput.bytes);
    if (byteLength > ARTIFACT_MIRROR_MAX_DECODED_BYTES) {
      throw new TypeError("observer artifact exceeds inline mirror byte limit");
    }
    if (BigInt(byteLength) > BigInt(this.#resolverPolicy.maxByteLength)) {
      throw new TypeError("observer artifact exceeds resolver policy byte limit");
    }
    const bytes = copyConcreteBytes(exactInput.bytes, byteLength);
    const mediaType = assertNonEmptyString(exactInput.mediaType, "observerArtifact.mediaType");
    const schema = decodeSchemaRef(exactInput.schema as SchemaRef);
    const contentSha256 = sha256Hex(bytes);
    const observedBytes = await this.#persistSingleFlight(contentSha256, bytes);
    const lease = createRetentionLeaseReceipt({
      storeIdentityHash: this.#storeIdentityHash,
      objectKey: contentSha256,
      contentSha256,
      ...this.#lease,
    });
    const locator = Object.freeze({
      kind: "content-object" as const,
      storeIdentityHash: this.#storeIdentityHash,
      objectKey: contentSha256,
    });
    const ref = createReadOnlyArtifactRef({
      locator,
      immutableMirrorLocator: locator,
      contentSha256,
      byteLength: String(observedBytes.byteLength),
      mediaType,
      schema,
      resolverPolicyHash: this.#resolverPolicy.policyHash,
      retentionLeaseReceiptId: lease.receiptId,
    });
    const mirror = createObservedImmutableMirror({
      storeIdentityHash: this.#storeIdentityHash,
      objectKey: contentSha256,
      bytes: encodeArtifactBytes(observedBytes),
      mediaType,
      schema,
    });
    const claim = createArtifactResolutionClaim({
      artifactRefId: ref.artifactRefId,
      resolverPolicyHash: this.#resolverPolicy.policyHash,
      observedMirror: mirror,
      outcome: "content-observed",
    });
    return Object.freeze({
      contentSha256,
      bytes: Uint8Array.from(observedBytes),
      ref,
      claim,
      lease,
    });
  }

  /** Acceptance-only durable replay seam. The caller supplies the expected
   * content identity; no mutable path or producer locator is accepted. */
  async readContent(contentSha256: Hash): Promise<Uint8Array> {
    const expected = assertHash(contentSha256, "observerSink.contentSha256");
    const observed = await this.#readPhysicalContent(
      expected,
      this.#objectIdentities.get(expected) ?? null,
    );
    this.#objectIdentities.set(expected, observed.identity);
    return Uint8Array.from(observed.bytes);
  }
}
