import {
  constants as fsConstants,
  closeSync,
  existsSync,
  fchmodSync,
  fchownSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { sha256Hex, type Hash } from "../../../packages/canonical-codec/src/index.ts";

export interface AtomicNoClobberPublicationV1 {
  readonly contentSha256: Hash;
  readonly byteLength: string;
  readonly device: string;
  readonly inode: string;
  readonly uid: string;
  readonly gid: string;
  readonly mode: string;
  readonly mtimeUnixNs: string;
  readonly publishedAtUnixNs: string;
}

/** Generic filesystem mechanism only. It does not select an authority path;
 * the controller owner supplies the fixed root-owned directory and target. */
export function atomicNoClobberPublishV1(input: Readonly<{
  readonly directory: string;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly tempDiscriminator: string;
}>): AtomicNoClobberPublicationV1 {
  if (!input.path.startsWith(`${input.directory}/`) || input.path.slice(input.directory.length + 1).includes("/")) throw new TypeError("atomic publication target is outside its exact directory");
  if (!/^[1-9][0-9]*$/.test(input.tempDiscriminator)) throw new TypeError("atomic publication temp discriminator is invalid");
  const tempPath = `${input.path}.tmp-${input.tempDiscriminator}`;
  if (existsSync(input.path) || existsSync(tempPath)) throw new TypeError("atomic publication target or temp already exists");
  const descriptor = openSync(tempPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, input.mode);
  let closed = false;
  let linked = false;
  try {
    fchownSync(descriptor, input.uid, input.gid);
    fchmodSync(descriptor, input.mode);
    let offset = 0;
    while (offset < input.bytes.byteLength) {
      const written = writeSync(descriptor, input.bytes, offset, input.bytes.byteLength - offset, null);
      if (written <= 0) throw new TypeError("atomic publication short write");
      offset += written;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    closed = true;
    // link(2) has no-clobber semantics: EEXIST cannot overwrite a target
    // created after the earlier observation. The temp and final names refer
    // to the same already-fsynced inode until the temp name is unlinked.
    linkSync(tempPath, input.path);
    linked = true;
    const directoryDescriptor = openSync(input.directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    unlinkSync(tempPath);
    const directoryDescriptorAfter = openSync(input.directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try { fsyncSync(directoryDescriptorAfter); } finally { closeSync(directoryDescriptorAfter); }
    if (realpathSync(input.path) !== input.path || !lstatSync(input.path).isFile()) throw new TypeError("atomic publication is not a canonical regular file");
    const before = statSync(input.path, { bigint: true });
    const observed = new Uint8Array(readFileSync(input.path));
    const after = statSync(input.path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || after.uid !== BigInt(input.uid) || after.gid !== BigInt(input.gid) || (after.mode & 0o777n) !== BigInt(input.mode)
      || observed.byteLength !== input.bytes.byteLength || observed.some((byte, index) => byte !== input.bytes[index])) throw new TypeError("atomic publication changed during read-back");
    return Object.freeze({
      contentSha256: sha256Hex(observed),
      byteLength: String(after.size),
      device: String(after.dev),
      inode: String(after.ino),
      uid: String(after.uid),
      gid: String(after.gid),
      mode: String(after.mode & 0o777n),
      mtimeUnixNs: String(after.mtimeNs),
      publishedAtUnixNs: (BigInt(Date.now()) * 1_000_000n).toString(),
    });
  } catch (error) {
    if (!closed) closeSync(descriptor);
    if (!linked && existsSync(tempPath)) unlinkSync(tempPath);
    throw error;
  }
}
