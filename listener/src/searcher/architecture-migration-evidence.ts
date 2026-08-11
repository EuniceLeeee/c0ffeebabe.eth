import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export interface ParityEvidenceBundleManifest {
  readonly schemaVersion: 1;
  readonly createdAtUtc: string;
  readonly baseline: {
    readonly fileName: string;
    readonly sha256: string;
    readonly commit: string;
  };
  readonly challenger: {
    readonly fileName: string;
    readonly sha256: string;
    readonly commit: string;
  };
  readonly receipt: {
    readonly fileName: string;
    readonly sha256: string;
  };
  readonly acceptance: {
    readonly eligible: boolean;
    readonly verdict: string;
  };
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readSideCommit(
  path: string,
): Promise<string> {
  const side = JSON.parse(await readFile(path, "utf8")) as {
    readonly closure?: { readonly commit?: string };
  };
  const commit = side.closure?.commit;
  if (typeof commit !== "string" || commit.length === 0) {
    throw new Error(`side capture ${path} has no closure.commit`);
  }
  return commit;
}

export async function writeParityEvidenceBundle(input: {
  readonly baselinePath: string;
  readonly challengerPath: string;
  readonly receiptPath: string;
  readonly outDir: string;
}): Promise<ParityEvidenceBundleManifest> {
  const [baselineRaw, challengerRaw, receiptRaw] = await Promise.all([
    readFile(input.baselinePath),
    readFile(input.challengerPath),
    readFile(input.receiptPath),
  ]);
  const receipt = JSON.parse(receiptRaw.toString("utf8")) as {
    readonly acceptance?: { readonly eligible?: boolean; readonly verdict?: string };
  };
  const acceptance = receipt.acceptance;
  if (
    acceptance === undefined ||
    typeof acceptance.eligible !== "boolean" ||
    typeof acceptance.verdict !== "string"
  ) {
    throw new Error("parity receipt has no acceptance verdict");
  }
  const manifest: ParityEvidenceBundleManifest = {
    schemaVersion: 1,
    createdAtUtc: new Date().toISOString(),
    baseline: {
      fileName: "baseline.json",
      sha256: sha256(baselineRaw),
      commit: await readSideCommit(input.baselinePath),
    },
    challenger: {
      fileName: "challenger.json",
      sha256: sha256(challengerRaw),
      commit: await readSideCommit(input.challengerPath),
    },
    receipt: {
      fileName: "receipt.json",
      sha256: sha256(receiptRaw),
    },
    acceptance: {
      eligible: acceptance.eligible,
      verdict: acceptance.verdict,
    },
  };
  await mkdir(input.outDir, { recursive: true });
  await Promise.all([
    copyFile(input.baselinePath, join(input.outDir, "baseline.json")),
    copyFile(input.challengerPath, join(input.outDir, "challenger.json")),
    copyFile(input.receiptPath, join(input.outDir, "receipt.json")),
  ]);
  await writeFile(
    join(input.outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

export async function assertParityEvidenceBundle(
  bundleDir: string,
): Promise<ParityEvidenceBundleManifest> {
  const manifest = JSON.parse(
    await readFile(join(bundleDir, "manifest.json"), "utf8"),
  ) as ParityEvidenceBundleManifest;
  const expectedFiles = [
    manifest.baseline.fileName,
    manifest.challenger.fileName,
    manifest.receipt.fileName,
  ] as const;
  for (const file of expectedFiles) {
    const content = await readFile(join(bundleDir, file));
    const actual = sha256(content);
    const expected = file === manifest.baseline.fileName
      ? manifest.baseline.sha256
      : file === manifest.challenger.fileName
        ? manifest.challenger.sha256
        : manifest.receipt.sha256;
    if (actual !== expected) {
      throw new Error(
        `parity evidence bundle tampered: ${file} sha256 mismatch`,
      );
    }
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error("parity evidence bundle schema mismatch");
  }
  return manifest;
}
