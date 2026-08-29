import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { decodeCanonicalJson, encodeCanonicalBytes } from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeNominationQualificationDeploymentFactV1,
  decodeRuntimeReleaseBindingV1,
  decodeRuntimeReleaseSignerPinV1,
  type NominationQualificationDeploymentFactV1,
  type RuntimeReleaseBindingV1,
} from "../../../specs/release-authority/src/index.ts";
import { observeCurrentCatalogImpactAnalysisV1 } from "../../catalog-generator/src/current-impact-analysis-owner.ts";
import type { PreReleaseAdvisoryMaterialCapabilityV1 } from "./pre-release-staging-contract.ts";
import { readPreReleaseAdvisoryMaterialV1 } from "./internal/pre-release-runtime-receipt-state.ts";
import { readAuthorizedQualifiedReleaseRunnerWireV1 } from "./internal/qualified-release-public-runner-state.ts";
import type { NominationQualificationReuseOwnerCompositionV1 } from "./nomination-qualification-reuse.ts";
import {
  readNominationQualificationReuseOwnerCompositionV1,
  registerNominationQualificationReuseOwnerCompositionV1,
} from "./internal/nomination-qualification-reuse-owner-state.ts";

const INSTALLED_RUNTIME_BINDING_PATH = "/etc/aloha/runtime-release-binding.json";
const INSTALLED_DEPLOYMENT_FACT_PATH = "/etc/aloha/nomination-qualification-deployment-fact.json";
const INSTALLED_RUNTIME_SIGNER_PIN_PATH = "/etc/aloha/trust/runtime-release-signer-pin.json";

export interface NominationQualificationReuseCompositionUnavailableV1 {
  readonly status: "unavailable";
  readonly code: "verified-release-authority-composition-unavailable";
  readonly advisoryOnly: true;
}

export interface NominationQualificationReuseCompositionAvailableV1 {
  readonly status: "available";
  readonly advisoryOnly: true;
  readonly composition: NominationQualificationReuseOwnerCompositionV1;
}

export type ProductionNominationQualificationReuseCompositionObservationV1 =
  | NominationQualificationReuseCompositionUnavailableV1
  | NominationQualificationReuseCompositionAvailableV1;

function readStableRootOwnedBytes(path: string, label: string): Uint8Array {
  if (realpathSync(path) !== path || !lstatSync(path).isFile()) {
    throw new TypeError(`${label} is not a fixed regular file`);
  }
  const before = statSync(path, { bigint: true });
  if (before.uid !== 0n || (before.mode & 0o022n) !== 0n) {
    throw new TypeError(`${label} is not root-owned and immutable to the runtime user`);
  }
  const bytes = new Uint8Array(readFileSync(path));
  const after = statSync(path, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
    || after.size !== BigInt(bytes.byteLength)) {
    throw new TypeError(`${label} changed while observed`);
  }
  return bytes;
}

function exactCanonicalObject(bytes: Uint8Array, label: string): unknown {
  const value = decodeCanonicalJson(bytes);
  if (!Buffer.from(bytes).equals(Buffer.from(encodeCanonicalBytes(value)))) {
    throw new TypeError(`${label} is not canonical exact bytes`);
  }
  return value;
}

export function readProductionNominationQualificationReusePostSignInputV1(
  composition: NominationQualificationReuseOwnerCompositionV1,
): Readonly<{
  readonly currentRuntimeBinding: RuntimeReleaseBindingV1;
  readonly currentDeploymentFact: NominationQualificationDeploymentFactV1;
}> {
  const state = readNominationQualificationReuseOwnerCompositionV1(composition);
  return Object.freeze({
    currentRuntimeBinding: state.currentRuntimeBinding,
    currentDeploymentFact: state.currentDeploymentFact,
  });
}

/** Production owner observation accepts one staging-owner-issued opaque
 * capability and no caller paths, facts, keys, pins or factory. Prior facts
 * come only from stable root-owned installed artifacts; current signed facts
 * come only from the exact frozen staging denominator. */
export function observeProductionNominationQualificationReuseCompositionV1(
  capability: PreReleaseAdvisoryMaterialCapabilityV1,
): ProductionNominationQualificationReuseCompositionObservationV1 {
  try {
    if (arguments.length !== 1) throw new TypeError("production nomination reuse owner requires one advisory material capability");
    const priorBinding = decodeRuntimeReleaseBindingV1(exactCanonicalObject(
      readStableRootOwnedBytes(INSTALLED_RUNTIME_BINDING_PATH, "installed runtime binding"),
      "installed runtime binding",
    ) as object);
    const priorDeploymentFact = decodeNominationQualificationDeploymentFactV1(exactCanonicalObject(
      readStableRootOwnedBytes(INSTALLED_DEPLOYMENT_FACT_PATH, "installed nomination qualification deployment fact"),
      "installed nomination qualification deployment fact",
    ) as object);
    const priorSignerPinBytes = readStableRootOwnedBytes(
      INSTALLED_RUNTIME_SIGNER_PIN_PATH,
      "installed runtime signer pin",
    );
    const priorSignerPin = decodeRuntimeReleaseSignerPinV1(exactCanonicalObject(
      priorSignerPinBytes,
      "installed runtime signer pin",
    ) as object);
    const material = readPreReleaseAdvisoryMaterialV1(capability);
    const currentWire = readAuthorizedQualifiedReleaseRunnerWireV1(material.qualifiedReleaseRunner);
    const currentBindingBytes = material.stagingArtifactBytes["runtime-release-binding.json"];
    const currentSignerPinBytes = material.stagingArtifactBytes["runtime-release-signer-pin.json"];
    const currentDeploymentFactBytes = material.stagingArtifactBytes["nomination-qualification-deployment-fact.json"];
    if (!(currentBindingBytes instanceof Uint8Array) || !(currentSignerPinBytes instanceof Uint8Array)
      || !(currentDeploymentFactBytes instanceof Uint8Array)) {
      throw new TypeError("current nomination qualification release material is absent from frozen staging");
    }
    const currentBinding = decodeRuntimeReleaseBindingV1(
      exactCanonicalObject(currentBindingBytes, "current runtime binding") as object,
    );
    const currentSignerPin = decodeRuntimeReleaseSignerPinV1(
      exactCanonicalObject(currentSignerPinBytes, "current runtime signer pin") as object,
    );
    const currentDeploymentFact = decodeNominationQualificationDeploymentFactV1(
      exactCanonicalObject(currentDeploymentFactBytes, "current nomination qualification deployment fact") as object,
    );
    if (!Buffer.from(currentBindingBytes).equals(Buffer.from(encodeCanonicalBytes(currentWire.runtimeBinding)))
      || !Buffer.from(currentSignerPinBytes).equals(Buffer.from(encodeCanonicalBytes(currentWire.runtimeSignerPin)))) {
      throw new TypeError("current staged release material does not equal the verified qualified-runner owner");
    }
    if (!Buffer.from(priorSignerPinBytes).equals(Buffer.from(currentSignerPinBytes))) {
      throw new TypeError("installed and current runtime signer pin continuity mismatch");
    }
    const composition = registerNominationQualificationReuseOwnerCompositionV1({
      currentCatalogImpact: observeCurrentCatalogImpactAnalysisV1(),
      priorRuntimeBinding: priorBinding,
      priorDeploymentFact,
      currentRuntimeBinding: currentBinding,
      currentDeploymentFact,
      priorRuntimeSignerPin: priorSignerPin,
      currentRuntimeSignerPin: currentSignerPin,
      priorDeploymentFactSignerPin: priorSignerPin,
      currentDeploymentFactSignerPin: currentSignerPin,
    });
    return Object.freeze({ status: "available" as const, advisoryOnly: true as const, composition });
  } catch {
    return Object.freeze({
      status: "unavailable" as const,
      code: "verified-release-authority-composition-unavailable" as const,
      advisoryOnly: true as const,
    });
  }
}
