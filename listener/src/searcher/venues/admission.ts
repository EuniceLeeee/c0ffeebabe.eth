export interface IdentityAdmissionPolicy {
  unknownFactory: "reject" | "probe";
  unregisteredCurveUnderlying: "reject" | "probe";
}

export const PRODUCTION_IDENTITY_ADMISSION: IdentityAdmissionPolicy = Object.freeze({
  unknownFactory: "probe",
  unregisteredCurveUnderlying: "probe",
});

export const STRICT_IDENTITY_ADMISSION: IdentityAdmissionPolicy = Object.freeze({
  unknownFactory: "reject",
  unregisteredCurveUnderlying: "reject",
});

export function allowProvisionalFactories(policy: IdentityAdmissionPolicy): boolean {
  return policy.unknownFactory === "probe";
}

export function allowProvisionalCurveUnderlying(policy: IdentityAdmissionPolicy): boolean {
  return policy.unregisteredCurveUnderlying === "probe";
}
