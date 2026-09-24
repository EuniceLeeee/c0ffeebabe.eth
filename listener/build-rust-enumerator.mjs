import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUST_ENUMERATOR_ROOT, RUST_ENUMERATOR_BINARY, RUST_ENUMERATOR_RECEIPT,
  enumerationSha256, rustEnumerationSourceHash } from "./src/searcher/detector/blockscan-rust-artifact.ts";

const sourceSha256 = rustEnumerationSourceHash();
const compiler = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
const host = compiler.match(/^host: (.+)$/m)?.[1];
if (!host) throw new Error("Cannot determine the native enumeration build target");
// The source and lockfile, not a previous locally installed addon, own the build.
const env = { ...process.env, CARGO_TARGET_DIR: join(RUST_ENUMERATOR_ROOT, "target") };
execFileSync("cargo", ["build", "--release", "--locked", "--target", host, "--manifest-path", join(RUST_ENUMERATOR_ROOT, "Cargo.toml")], { env, stdio: "inherit" });
if (rustEnumerationSourceHash() !== sourceSha256) throw new Error("Rust enumeration source changed during build");
const library = process.platform === "darwin" ? "libblockscan_enumerator.dylib"
  : process.platform === "win32" ? "blockscan_enumerator.dll" : "libblockscan_enumerator.so";
copyFileSync(join(RUST_ENUMERATOR_ROOT, "target", host, "release", library), RUST_ENUMERATOR_BINARY);
writeFileSync(RUST_ENUMERATOR_RECEIPT, JSON.stringify({
  apiVersion: 1, profile: "release", platform: process.platform, arch: process.arch, target: host,
  rustc: compiler.trim(),
  sourceSha256, binarySha256: enumerationSha256(readFileSync(RUST_ENUMERATOR_BINARY)),
}, null, 2) + "\n");
console.log("Rust enumeration release artifact built and source-bound.");
