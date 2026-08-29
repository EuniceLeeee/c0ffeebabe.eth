import { createPublicKey, verify as verifySignature } from "node:crypto";
import {
  decodeRuntimeReleaseBindingV1,
  decodeRuntimeReleaseSignerPinV1,
  runtimeReleaseBindingSigningBytes,
  type RuntimeReleaseBindingV1,
  type RuntimeReleaseSignerPinV1,
} from "../../../../specs/release-authority/src/index.ts";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Narrow verifier shared by the qualified runner and package writer. */
export function verifyRuntimeReleaseBindingSignatureV1(
  bindingValue: RuntimeReleaseBindingV1,
  pinValue: RuntimeReleaseSignerPinV1,
): RuntimeReleaseBindingV1 {
  const binding = decodeRuntimeReleaseBindingV1(bindingValue);
  const pin = decodeRuntimeReleaseSignerPinV1(pinValue);
  if (binding.signerKeyId !== pin.signerKeyId) throw new TypeError("runtime release signer pin mismatch");
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pin.publicKeyHex.slice(2), "hex")]),
    format: "der",
    type: "spki",
  });
  const valid = verifySignature(
    null,
    Buffer.from(runtimeReleaseBindingSigningBytes(binding)),
    publicKey,
    Buffer.from(binding.signatureHex.slice(2), "hex"),
  );
  if (!valid) throw new TypeError("runtime release binding signature invalid");
  return binding;
}
