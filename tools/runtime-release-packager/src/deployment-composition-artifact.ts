import {
  decodeCanonicalJson,
  encodeCanonicalBytes,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeDeploymentRuntimeInfrastructureRequestV1,
  type DeploymentRuntimeInfrastructureRequestV1,
} from "../../../packages/runtime-release-authority/src/internal/deployment-runtime-owner.ts";

export const PRODUCTION_REVM_WORKER_EXECUTABLE_PATH_V1 = "/opt/aloha/bin/aloha-revm-worker" as const;
export const PRODUCTION_PROOF_SIGNER_EXECUTABLE_PATH_V1 = "/opt/aloha/bin/aloha-proof-signer" as const;

const PREFIX = "const freeze=value=>{if(value!==null&&typeof value===\"object\"){for(const child of Object.values(value))freeze(child);Object.freeze(value)}return value};\nconst data=JSON.parse(";
const SUFFIX = ");\nexport const deploymentComposition=freeze(data);\n";

function exactProductionRequest(value: unknown): DeploymentRuntimeInfrastructureRequestV1 {
  const request = decodeDeploymentRuntimeInfrastructureRequestV1(value);
  if (request.revmWorkerExecutablePath !== PRODUCTION_REVM_WORKER_EXECUTABLE_PATH_V1
    || request.externalProofSigner.executablePath !== PRODUCTION_PROOF_SIGNER_EXECUTABLE_PATH_V1) {
    throw new TypeError("production deployment composition executable path mismatch");
  }
  return request;
}

/** Deterministic, import-free data module. It exports no caller-supplied
 * authority; the bundled runtime owner turns this exact request into ports. */
export function renderProductionDeploymentCompositionV1(
  value: DeploymentRuntimeInfrastructureRequestV1,
): Uint8Array {
  const request = exactProductionRequest(value);
  const canonical = Buffer.from(encodeCanonicalBytes(request)).toString("utf8");
  return new TextEncoder().encode(`${PREFIX}${JSON.stringify(canonical)}${SUFFIX}`);
}

export function decodeProductionDeploymentCompositionV1(
  bytes: Uint8Array,
): DeploymentRuntimeInfrastructureRequestV1 {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("production deployment composition bytes are required");
  const source = Buffer.from(bytes).toString("utf8");
  if (!source.startsWith(PREFIX) || !source.endsWith(SUFFIX)) {
    throw new TypeError("production deployment composition module shape mismatch");
  }
  const literal = source.slice(PREFIX.length, source.length - SUFFIX.length);
  let canonical: unknown;
  try { canonical = JSON.parse(literal); } catch { throw new TypeError("production deployment composition payload literal is invalid"); }
  if (typeof canonical !== "string") throw new TypeError("production deployment composition payload must be canonical JSON text");
  const request = exactProductionRequest(decodeCanonicalJson(canonical));
  if (!Buffer.from(renderProductionDeploymentCompositionV1(request)).equals(Buffer.from(bytes))) {
    throw new TypeError("production deployment composition module is not canonical exact bytes");
  }
  return request;
}
