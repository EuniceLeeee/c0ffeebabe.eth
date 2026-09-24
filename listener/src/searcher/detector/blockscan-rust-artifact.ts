import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const RUST_ENUMERATOR_ROOT = fileURLToPath(new URL("../../../rust-enumerator/", import.meta.url));
export const RUST_ENUMERATOR_BINARY = join(RUST_ENUMERATOR_ROOT, "blockscan_enumerator.node");
export const RUST_ENUMERATOR_RECEIPT = join(RUST_ENUMERATOR_ROOT, "blockscan_enumerator.build.json");
export const enumerationSha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Bind the native artifact to its complete local source, including the dependency lock. */
export function rustEnumerationSourceHash(): string {
  const files = ["Cargo.toml", "Cargo.lock", "build.rs"];
  const visit = (relative: string): void => {
    for (const entry of readdirSync(join(RUST_ENUMERATOR_ROOT, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) files.push(name);
      else throw new Error("Rust enumeration source must contain regular files only");
    }
  };
  visit("src");
  return enumerationSha256(JSON.stringify(files.sort().map(name =>
    [name, enumerationSha256(readFileSync(join(RUST_ENUMERATOR_ROOT, name)))])));
}

export function verifyRustEnumerationArtifact(): { sourceSha256: string; binarySha256: string } {
  const receipt = JSON.parse(readFileSync(RUST_ENUMERATOR_RECEIPT, "utf8"));
  const sourceSha256 = rustEnumerationSourceHash();
  const binarySha256 = enumerationSha256(readFileSync(RUST_ENUMERATOR_BINARY));
  if (receipt.apiVersion !== 1 || receipt.profile !== "release" ||
      receipt.platform !== process.platform || receipt.arch !== process.arch ||
      receipt.sourceSha256 !== sourceSha256 || receipt.binarySha256 !== binarySha256) {
    throw new Error("Rust enumeration artifact is stale or incompatible");
  }
  return { sourceSha256, binarySha256 };
}
