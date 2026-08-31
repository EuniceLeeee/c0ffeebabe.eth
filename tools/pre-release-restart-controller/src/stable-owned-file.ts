import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";

export interface StableOwnedFilePolicyV1 {
  readonly uid: bigint;
  readonly gid: bigint;
  readonly mode: bigint;
  readonly maximumByteLength: bigint | null;
}

function readExactDescriptorBytes(descriptor: number, byteLength: bigint, label: string): Uint8Array {
  if (byteLength < 0n || byteLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`${label} byte length cannot be allocated exactly`);
  }
  const bytes = new Uint8Array(Number(byteLength));
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
    if (count === 0) throw new TypeError(`${label} was truncated during read`);
    offset += count;
  }
  return bytes;
}

/** Descriptor-anchored physical read. The path is checked again only after
 * the already-open descriptor has been read, so a path swap can invalidate
 * the observation but can never redirect the content allocation. */
export function readStableOwnedPhysicalFileV1(
  path: string,
  policy: StableOwnedFilePolicyV1,
  afterPreflightForTest: (() => void) | null = null,
) {
  if (!existsSync(path) || realpathSync(path) !== path || !lstatSync(path).isFile()) {
    throw new TypeError(`pre-release controller durable file is missing: ${path}`);
  }
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.uid !== policy.uid || before.gid !== policy.gid
      || (before.mode & 0o777n) !== policy.mode
      || (policy.maximumByteLength !== null && before.size > policy.maximumByteLength)) {
      throw new TypeError(`pre-release controller durable file owner/mode/size mismatch: ${path}`);
    }
    afterPreflightForTest?.();
    const bytes = readExactDescriptorBytes(descriptor, before.size, "pre-release controller durable file");
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = statSync(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || after.size !== BigInt(bytes.byteLength)
      || after.dev !== pathAfter.dev || after.ino !== pathAfter.ino) {
      throw new TypeError(`pre-release controller durable file changed during read: ${path}`);
    }
    return Object.freeze({ bytes, stat: after });
  } finally {
    closeSync(descriptor);
  }
}
